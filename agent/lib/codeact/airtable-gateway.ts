import { AIRTABLE_API_BASE, type FetchLike } from "#lib/airtable.js";

/**
 * Read-only Airtable access for `execute_python`.
 *
 * Runs in the app runtime, never in the sandbox: the Python client inside the
 * sandbox only sends RPC requests (method + params), and this gateway decides
 * what reaches Airtable. That keeps the token out of generated code and lets
 * us enforce, in trusted code, that every request is a GET against the one
 * configured base (and, optionally, an allow-list of tables).
 *
 * Reads are all-or-nothing: `listRecords` follows every page or fails. The only
 * partial read is one the caller asks for explicitly with `maxRecords`, and the
 * result says so (`complete: false`).
 */

export const DEFAULT_MAX_RECORDS_PER_READ = 20_000;
export const DEFAULT_GATEWAY_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
/** Airtable allows 5 requests per second per base. */
const MIN_REQUEST_INTERVAL_MS = 220;
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 8_000;

/** Raised for any failed read. `message` is safe to show to the model and the user. */
export class AirtableReadError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, options: { status?: number | null; code: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AirtableReadError";
    this.status = options.status ?? null;
    this.code = options.code;
  }
}

export interface AirtableGatewayConfig {
  apiKey: string;
  baseId: string;
  /** Table names or ids the agent may read. Empty means every table in the base. */
  allowedTables: readonly string[];
  maxRecordsPerRead: number;
  timeoutMs: number;
}

/**
 * Loads gateway config. Prefers a dedicated read-only token
 * (`AIRTABLE_READ_API_KEY`) and falls back to the invoice token.
 * Returns `null` when Airtable is not configured, so the tool can explain what
 * is missing instead of crashing.
 */
export function loadAirtableGatewayConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AirtableGatewayConfig | null {
  const apiKey = nonEmpty(env.AIRTABLE_READ_API_KEY) ?? nonEmpty(env.AIRTABLE_API_KEY);
  const baseId = nonEmpty(env.AIRTABLE_ANALYTICS_BASE_ID) ?? nonEmpty(env.AIRTABLE_BASE_ID);
  if (apiKey === undefined || baseId === undefined) return null;

  const allowedTables = (env.AIRTABLE_ANALYTICS_TABLES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  return {
    apiKey,
    baseId,
    allowedTables,
    maxRecordsPerRead: positiveInt(env.AIRTABLE_ANALYTICS_MAX_RECORDS, DEFAULT_MAX_RECORDS_PER_READ),
    timeoutMs: positiveInt(env.AIRTABLE_TIMEOUT_MS, DEFAULT_GATEWAY_TIMEOUT_MS),
  };
}

export interface AirtableFieldSchema {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

export interface AirtableTableSchema {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: AirtableFieldSchema[];
}

export interface ListRecordsParams {
  table: string;
  fields?: string[];
  formula?: string;
  view?: string;
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
  maxRecords?: number;
}

export interface ListRecordsResult {
  table: string;
  records: Array<{ id: string; createdTime: string; fields: Record<string, unknown> }>;
  pages: number;
  /** False only when `maxRecords` cut the read short. */
  complete: boolean;
}

interface RawTablesResponse {
  tables?: AirtableTableSchema[];
}

interface RawRecordsResponse {
  records?: Array<{ id: string; createdTime: string; fields: Record<string, unknown> }>;
  offset?: string;
}

export interface AirtableGatewayOptions {
  config: AirtableGatewayConfig;
  fetchImpl?: FetchLike;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Overall deadline (epoch ms) shared with the Python execution. */
  deadline?: number;
}

export class AirtableReadOnlyGateway {
  readonly #config: AirtableGatewayConfig;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #deadline: number | undefined;
  #lastRequestAt = 0;
  #schema: AirtableTableSchema[] | null = null;

  constructor(options: AirtableGatewayOptions) {
    this.#config = options.config;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#deadline = options.deadline;
  }

  get #baseUrl(): string {
    return `${AIRTABLE_API_BASE}/${encodeURIComponent(this.#config.baseId)}`;
  }

  /** Tables (and their fields) the agent is allowed to read. */
  async listTables(): Promise<AirtableTableSchema[]> {
    if (this.#schema !== null) return this.#schema;
    const url = `${AIRTABLE_API_BASE}/meta/bases/${encodeURIComponent(this.#config.baseId)}/tables`;
    const body = (await this.#get(url, "el esquema de la base")) as RawTablesResponse;
    const tables = body.tables ?? [];
    const allowed = this.#config.allowedTables;
    this.#schema =
      allowed.length === 0
        ? tables
        : tables.filter((table) => allowed.includes(table.name) || allowed.includes(table.id));
    return this.#schema;
  }

  /** Resolves a table name or id against the allowed schema, or fails with the valid names. */
  async resolveTable(table: string): Promise<AirtableTableSchema> {
    const tables = await this.listTables();
    const wanted = table.trim();
    const match =
      tables.find((candidate) => candidate.id === wanted || candidate.name === wanted) ??
      tables.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
    if (match === undefined) {
      const names = tables.map((candidate) => candidate.name).join(", ") || "(ninguna)";
      throw new AirtableReadError(
        `La tabla "${table}" no existe o no está autorizada. Tablas disponibles: ${names}.`,
        { code: "TABLE_NOT_FOUND" },
      );
    }
    return match;
  }

  async listRecords(params: ListRecordsParams): Promise<ListRecordsResult> {
    const table = await this.resolveTable(params.table);
    this.#assertFieldsExist(table, [
      ...(params.fields ?? []),
      ...(params.sort ?? []).map((entry) => entry.field),
    ]);

    const hardCap = this.#config.maxRecordsPerRead;
    const requested = params.maxRecords;
    if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
      throw new AirtableReadError("max_records debe ser un entero positivo.", {
        code: "INVALID_ARGUMENT",
      });
    }
    const limit = Math.min(requested ?? hardCap, hardCap);

    const records: ListRecordsResult["records"] = [];
    let offset: string | undefined;
    let pages = 0;

    do {
      const query = new URLSearchParams();
      query.set("pageSize", String(PAGE_SIZE));
      // One record past the limit tells us whether the limit cut the read short.
      query.set("maxRecords", String(limit + 1));
      for (const field of params.fields ?? []) query.append("fields[]", field);
      if (params.formula !== undefined && params.formula.trim() !== "") {
        query.set("filterByFormula", params.formula);
      }
      if (params.view !== undefined && params.view.trim() !== "") query.set("view", params.view);
      (params.sort ?? []).forEach((entry, index) => {
        query.set(`sort[${index}][field]`, entry.field);
        query.set(`sort[${index}][direction]`, entry.direction ?? "asc");
      });
      if (offset !== undefined) query.set("offset", offset);

      const url = `${this.#baseUrl}/${encodeURIComponent(table.id)}?${query.toString()}`;
      const body = (await this.#get(url, `la tabla "${table.name}"`)) as RawRecordsResponse;
      pages += 1;
      records.push(...(body.records ?? []));
      offset = body.offset;
    } while (offset !== undefined && records.length <= limit);

    if (records.length <= limit) {
      return { table: table.name, records, pages, complete: true };
    }
    if (requested !== undefined && requested <= hardCap) {
      // The caller asked for a sample; report it as one.
      return { table: table.name, records: records.slice(0, limit), pages, complete: false };
    }
    throw new AirtableReadError(
      `La consulta sobre "${table.name}" devuelve más de ${hardCap} registros. ` +
        "Filtrá con formula=..., pedí menos campos con fields=[...] o pasá max_records " +
        "para trabajar con una muestra declarada.",
      { code: "TOO_MANY_RECORDS" },
    );
  }

  async getRecord(
    tableName: string,
    recordId: string,
  ): Promise<{ id: string; createdTime: string; fields: Record<string, unknown> }> {
    const table = await this.resolveTable(tableName);
    if (!/^rec[A-Za-z0-9]{14}$/u.test(recordId)) {
      throw new AirtableReadError(`"${recordId}" no es un id de registro válido (recXXXXXXXXXXXXXX).`, {
        code: "INVALID_ARGUMENT",
      });
    }
    const url = `${this.#baseUrl}/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}`;
    return (await this.#get(url, `el registro ${recordId}`)) as {
      id: string;
      createdTime: string;
      fields: Record<string, unknown>;
    };
  }

  #assertFieldsExist(table: AirtableTableSchema, fields: readonly string[]): void {
    const known = new Set(table.fields.flatMap((field) => [field.name, field.id]));
    const missing = fields.filter((field) => !known.has(field));
    if (missing.length > 0) {
      throw new AirtableReadError(
        `Campos inexistentes en "${table.name}": ${missing.join(", ")}. ` +
          `Campos disponibles: ${table.fields.map((field) => field.name).join(", ")}.`,
        { code: "FIELD_NOT_FOUND" },
      );
    }
  }

  /** The only network primitive: GET with throttling, timeout, and bounded retries. */
  async #get(url: string, what: string): Promise<unknown> {
    let lastError: AirtableReadError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.#throttle();
      this.#assertBeforeDeadline(what);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs());
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${this.#config.apiKey}` },
          signal: controller.signal,
        });
      } catch (cause) {
        // Network failure or timeout: retryable. Never echo the URL or token.
        lastError = new AirtableReadError(`No pude conectarme con Airtable para leer ${what}.`, {
          code: "NETWORK",
          cause,
        });
        await this.#backoff(attempt, null);
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) return (await response.json()) as unknown;

      const detail = await readAirtableErrorMessage(response);
      if (response.status === 429 || response.status >= 500) {
        lastError = new AirtableReadError(
          response.status === 429
            ? `Airtable limitó la tasa de lecturas mientras leía ${what}.`
            : `Airtable respondió ${response.status} al leer ${what}.`,
          { status: response.status, code: response.status === 429 ? "RATE_LIMITED" : "UPSTREAM" },
        );
        await this.#backoff(attempt, response.headers.get("retry-after"));
        continue;
      }

      throw new AirtableReadError(describeClientError(response.status, what, detail), {
        status: response.status,
        code: response.status === 422 ? "INVALID_REQUEST" : "FORBIDDEN_OR_NOT_FOUND",
      });
    }

    throw (
      lastError ??
      new AirtableReadError(`No pude leer ${what} en Airtable.`, { code: "UPSTREAM" })
    );
  }

  async #throttle(): Promise<void> {
    const wait = this.#lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await this.#sleep(wait);
    this.#lastRequestAt = Date.now();
  }

  async #backoff(attempt: number, retryAfter: string | null): Promise<void> {
    if (attempt >= MAX_ATTEMPTS) return;
    const fromHeader = retryAfter === null ? Number.NaN : Number(retryAfter) * 1000;
    const delay = Number.isFinite(fromHeader)
      ? Math.min(fromHeader, MAX_BACKOFF_MS)
      : Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    if (this.#deadline !== undefined && Date.now() + delay > this.#deadline) return;
    await this.#sleep(delay);
  }

  #requestTimeoutMs(): number {
    if (this.#deadline === undefined) return this.#config.timeoutMs;
    return Math.max(1_000, Math.min(this.#config.timeoutMs, this.#deadline - Date.now()));
  }

  #assertBeforeDeadline(what: string): void {
    if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
      throw new AirtableReadError(
        `Se agotó el tiempo de ejecución mientras leía ${what}. Pedí menos datos o filtrá la consulta.`,
        { code: "TIMEOUT" },
      );
    }
  }
}

async function readAirtableErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string | { type?: string; message?: string };
    };
    const error = body.error;
    if (typeof error === "string") return error;
    return [error?.type, error?.message].filter(Boolean).join(": ");
  } catch {
    return "";
  }
}

function describeClientError(status: number, what: string, detail: string): string {
  const suffix = detail === "" ? "" : ` (${detail.slice(0, 300)})`;
  switch (status) {
    case 401:
      return `Airtable rechazó la credencial al leer ${what}. Revisá AIRTABLE_READ_API_KEY.${suffix}`;
    case 403:
      return (
        `El token no tiene permiso para leer ${what}. Necesita los scopes ` +
        `data.records:read y schema.bases:read sobre esta base.${suffix}`
      );
    case 404:
      return `Airtable no encontró ${what}.${suffix}`;
    case 422:
      return `Airtable rechazó la consulta sobre ${what}: revisá la fórmula, la vista o los campos.${suffix}`;
    default:
      return `Airtable respondió ${status} al leer ${what}.${suffix}`;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
