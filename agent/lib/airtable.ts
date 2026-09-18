import type { Invoice } from "#lib/invoice-schema.js";
import { buildBusinessKey } from "#lib/idempotency.js";

/**
 * Airtable persistence over the REST API.
 *
 * Uses `fetch` directly rather than the `airtable` SDK so the request timeout,
 * the error surface, and the duplicate lookups stay explicit and easy to stub
 * in tests.
 */

export const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
export const AIRTABLE_CONTENT_API_BASE = "https://content.airtable.com/v0";
export const DEFAULT_AIRTABLE_TIMEOUT_MS = 15_000;
export const DEFAULT_AIRTABLE_UPLOAD_TIMEOUT_MS = 30_000;
/** Airtable's direct-upload limit; larger files need a public URL, which we do not use. */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 5 * 1024 * 1024;

const SAVE_FAILED_USER_MESSAGE =
  "⚠️ Pude leer la factura, pero no pude guardarla en Airtable.";
const ATTACHMENT_FAILED_USER_MESSAGE =
  "⚠️ Registré los datos en Airtable, pero no pude subir el archivo.";

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Column names expected in the Airtable table. */
export const AIRTABLE_FIELDS = {
  invoiceNumber: "Invoice Number",
  issueDate: "Issue Date",
  dueDate: "Due Date",
  supplierName: "Supplier Name",
  supplierTaxId: "Supplier Tax ID",
  customerName: "Customer Name",
  customerTaxId: "Customer Tax ID",
  subtotal: "Subtotal",
  tax: "Tax",
  total: "Total",
  currency: "Currency",
  description: "Description",
  cufe: "CUFE",
  sourceFile: "Source File",
  attachment: "Attachment",
  telegramUserId: "Telegram User ID",
  telegramChatId: "Telegram Chat ID",
  createdAt: "Created At",
  idempotencyKey: "Idempotency Key",
} as const;

/** Raised when Airtable cannot be reached or rejects the request. */
export class AirtableError extends Error {
  readonly userMessage: string;
  readonly status: number | null;

    constructor(
    message: string,
    options?: { status?: number | null; cause?: unknown; userMessage?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AirtableError";
    this.status = options?.status ?? null;
    this.userMessage = options?.userMessage ?? SAVE_FAILED_USER_MESSAGE;
  }
}

export interface AirtableConfig {
  apiKey: string;
  baseId: string;
  tableName: string;
  timeoutMs: number;
  uploadTimeoutMs?: number;
}

export type UploadAttachmentResult =
  | { attached: true; record: AirtableRecord }
  | { attached: false; reason: "too_large" };

/** True when the record already has at least one file in the Attachment cell. */
export function recordHasAttachment(record: AirtableRecord): boolean {
  const value = record.fields[AIRTABLE_FIELDS.attachment];
  return Array.isArray(value) && value.length > 0;
}

export function fileNameForUpload(fileName: string, contentType: string): string {
  if (fileName.includes(".")) return fileName;
  const extension = CONTENT_TYPE_EXTENSION[contentType];
  return extension === undefined ? fileName : `${fileName}.${extension}`;
}

export function loadAirtableConfig(env: NodeJS.ProcessEnv = process.env): AirtableConfig {
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;

  if (apiKey === undefined || apiKey.trim() === "") {
    throw new AirtableError("Missing required environment variable: AIRTABLE_API_KEY");
  }
  if (baseId === undefined || baseId.trim() === "") {
    throw new AirtableError("Missing required environment variable: AIRTABLE_BASE_ID");
  }

  return {
    apiKey,
    baseId,
    tableName: env.AIRTABLE_TABLE_NAME ?? "Invoices",
    timeoutMs: Number(env.AIRTABLE_TIMEOUT_MS ?? DEFAULT_AIRTABLE_TIMEOUT_MS),
  };
}

/** Escapes a value for interpolation into an Airtable `filterByFormula` string literal. */
export function escapeFormulaValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

interface AirtableListResponse {
  records?: AirtableRecord[];
}

/** Injectable for tests; defaults to global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AirtableClientOptions {
  config?: AirtableConfig;
  fetchImpl?: FetchLike;
}

export class AirtableInvoicesClient {
  readonly #config: AirtableConfig;
  readonly #fetch: FetchLike;

  constructor(options: AirtableClientOptions = {}) {
    this.#config = options.config ?? loadAirtableConfig();
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get #tableUrl(): string {
    return `${AIRTABLE_API_BASE}/${encodeURIComponent(this.#config.baseId)}/${encodeURIComponent(
      this.#config.tableName,
    )}`;
  }

  get #uploadTimeoutMs(): number {
    return this.#config.uploadTimeoutMs ?? DEFAULT_AIRTABLE_UPLOAD_TIMEOUT_MS;
  }

  async #request(url: string, init: RequestInit, timeoutMs = this.#config.timeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.#config.apiKey}`,
          "content-type": "application/json",
          ...init.headers,
        },
        signal: controller.signal,
      });
    } catch (cause) {
      // Never let the key or the full URL reach the error message.
      throw new AirtableError("Airtable request failed", { cause });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new AirtableError(`Airtable responded ${response.status}: ${body.slice(0, 300)}`, {
        status: response.status,
      });
    }

    return (await response.json()) as unknown;
  }

  async #findOneByFormula(formula: string): Promise<AirtableRecord | null> {
    const url = `${this.#tableUrl}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;
    const body = (await this.#request(url, { method: "GET" })) as AirtableListResponse;
    return body.records?.[0] ?? null;
  }

  /** Primary duplicate check, on the stable idempotency key. */
  async findByIdempotencyKey(idempotencyKey: string): Promise<AirtableRecord | null> {
    return this.#findOneByFormula(
      `{${AIRTABLE_FIELDS.idempotencyKey}} = "${escapeFormulaValue(idempotencyKey)}"`,
    );
  }

  /** Secondary duplicate check: same supplier tax id plus same invoice number. */
  async findByBusinessKey(
    supplierTaxId: string | null,
    invoiceNumber: string | null,
  ): Promise<AirtableRecord | null> {
    if (buildBusinessKey(supplierTaxId, invoiceNumber) === null) return null;

    const formula = `AND({${AIRTABLE_FIELDS.supplierTaxId}} = "${escapeFormulaValue(
      supplierTaxId as string,
    )}", {${AIRTABLE_FIELDS.invoiceNumber}} = "${escapeFormulaValue(invoiceNumber as string)}")`;
    return this.#findOneByFormula(formula);
  }

  async createInvoiceRecord(input: {
    invoice: Invoice;
    idempotencyKey: string;
    telegramUserId: string | null;
    telegramChatId: string | null;
  }): Promise<AirtableRecord> {
    const { invoice, idempotencyKey, telegramUserId, telegramChatId } = input;

    const fields: Record<string, unknown> = {
      [AIRTABLE_FIELDS.invoiceNumber]: invoice.invoiceNumber,
      [AIRTABLE_FIELDS.issueDate]: invoice.issueDate,
      [AIRTABLE_FIELDS.dueDate]: invoice.dueDate,
      [AIRTABLE_FIELDS.supplierName]: invoice.supplierName,
      [AIRTABLE_FIELDS.supplierTaxId]: invoice.supplierTaxId,
      [AIRTABLE_FIELDS.customerName]: invoice.customerName,
      [AIRTABLE_FIELDS.customerTaxId]: invoice.customerTaxId,
      [AIRTABLE_FIELDS.subtotal]: invoice.subtotal,
      [AIRTABLE_FIELDS.tax]: invoice.tax,
      [AIRTABLE_FIELDS.total]: invoice.total,
      [AIRTABLE_FIELDS.currency]: invoice.currency,
      [AIRTABLE_FIELDS.description]: invoice.description,
      [AIRTABLE_FIELDS.cufe]: invoice.cufe,
      [AIRTABLE_FIELDS.sourceFile]: invoice.sourceFileName,
      [AIRTABLE_FIELDS.telegramUserId]: telegramUserId,
      [AIRTABLE_FIELDS.telegramChatId]: telegramChatId,
      [AIRTABLE_FIELDS.createdAt]: new Date().toISOString(),
      [AIRTABLE_FIELDS.idempotencyKey]: idempotencyKey,
    };

    // Airtable rejects nulls for some column types; omit empty fields instead.
    for (const key of Object.keys(fields)) {
      if (fields[key] === null) delete fields[key];
    }

    const body = (await this.#request(this.#tableUrl, {
      method: "POST",
      body: JSON.stringify({ fields, typecast: true }),
    })) as AirtableRecord;

    return body;
  }

  /**
   * Uploads file bytes into the Attachment cell. Airtable appends; it does not
   * replace existing files. Files over 5 MB are skipped without calling the API.
   */
  async uploadAttachment(input: {
    recordId: string;
    bytes: Uint8Array;
    fileName: string;
    contentType: string;
  }): Promise<UploadAttachmentResult> {
    if (input.bytes.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
      return { attached: false, reason: "too_large" };
    }

    const url = `${AIRTABLE_CONTENT_API_BASE}/${encodeURIComponent(
      this.#config.baseId,
    )}/${encodeURIComponent(input.recordId)}/${encodeURIComponent(
      AIRTABLE_FIELDS.attachment,
    )}/uploadAttachment`;

    try {
      const record = (await this.#request(
        url,
        {
          method: "POST",
          body: JSON.stringify({
            contentType: input.contentType,
            filename: fileNameForUpload(input.fileName, input.contentType),
            file: Buffer.from(input.bytes).toString("base64"),
          }),
        },
        this.#uploadTimeoutMs,
      )) as AirtableRecord;
      return { attached: true, record };
    } catch (error) {
      if (error instanceof AirtableError) {
        throw new AirtableError(error.message, {
          status: error.status,
          cause: error,
          userMessage: ATTACHMENT_FAILED_USER_MESSAGE,
        });
      }
      throw error;
    }
  }
}
