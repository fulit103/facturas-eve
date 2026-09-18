import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AIRTABLE_CONTENT_API_BASE,
  AIRTABLE_FIELDS,
  AirtableError,
  AirtableInvoicesClient,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  fileNameForUpload,
  recordHasAttachment,
} from "#lib/airtable.js";
import { ATTACHMENTS_DIR } from "#lib/attachments.js";
import { sha256Hex } from "#lib/idempotency.js";
import type { Invoice } from "#lib/invoice-schema.js";

const INVOICE: Invoice = {
  invoiceNumber: "FE-1234",
  issueDate: "2026-09-15",
  dueDate: null,
  supplierName: "Proveedor SAS",
  supplierTaxId: "900123456-7",
  customerName: "Cliente SAS",
  customerTaxId: null,
  subtotal: 840336,
  tax: 159664,
  total: 1000000,
  currency: "COP",
  description: "Servicios",
  cufe: null,
  sourceFileName: "factura.pdf",
};

const IDEMPOTENCY_KEY = "sha256:abc123";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n");
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

interface FakeRecord {
  id: string;
  fields: Record<string, unknown>;
}

interface FakeAttachment {
  id: string;
  filename: string;
  type: string;
  size: number;
}

/**
 * Minimal in-memory Airtable. Understands the two `filterByFormula` shapes this
 * project builds, plus the content-API uploadAttachment endpoint.
 */
function createFakeAirtable() {
  const records: FakeRecord[] = [];
  let nextId = 1;

  const calls = { list: 0, create: 0, upload: 0 };

  const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";

    if (url.origin === AIRTABLE_CONTENT_API_BASE.replace("/v0", "")) {
      calls.upload += 1;
      const segments = url.pathname.split("/").filter((segment) => segment !== "");
      const recordId = decodeURIComponent(segments[2] ?? "");
      const field = decodeURIComponent(segments[3] ?? "");
      const body = JSON.parse(String(init?.body)) as {
        filename: string;
        contentType: string;
        file: string;
      };
      const record = records.find((candidate) => candidate.id === recordId);
      if (record === undefined) return jsonResponse({ error: "NOT_FOUND" }, 404);

      const existing = Array.isArray(record.fields[field])
        ? [...(record.fields[field] as FakeAttachment[])]
        : [];
      const attachment: FakeAttachment = {
        id: `att${calls.upload}`,
        filename: body.filename,
        type: body.contentType,
        size: Buffer.from(body.file, "base64").byteLength,
      };
      existing.push(attachment);
      record.fields[field] = existing;
      return jsonResponse({
        id: record.id,
        createdTime: new Date().toISOString(),
        fields: { [field]: existing },
      });
    }

    if (method === "GET") {
      calls.list += 1;
      const formula = url.searchParams.get("filterByFormula") ?? "";
      const pairs = [...formula.matchAll(/\{([^}]+)\}\s*=\s*"((?:[^"\\]|\\.)*)"/gu)].map(
        ([, field, value]) => [field, value.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\")] as const,
      );
      const match =
        pairs.length === 0
          ? undefined
          : records.find((record) =>
              pairs.every(([field, value]) => record.fields[field] === value),
            );
      return jsonResponse({ records: match === undefined ? [] : [match] });
    }

    calls.create += 1;
    const body = JSON.parse(String(init?.body)) as { fields: Record<string, unknown> };
    const record: FakeRecord = { id: `rec${nextId++}`, fields: body.fields };
    records.push(record);
    return jsonResponse(record);
  });

  return { calls, fetchImpl, records };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CONFIG = {
  apiKey: "key_test",
  baseId: "appTest",
  tableName: "Invoices",
  timeoutMs: 5_000,
};

describe("AirtableInvoicesClient", () => {
  it("creates a record with every mapped column", async () => {
    const airtable = createFakeAirtable();
    const client = new AirtableInvoicesClient({ config: CONFIG, fetchImpl: airtable.fetchImpl });

    const record = await client.createInvoiceRecord({
      invoice: INVOICE,
      idempotencyKey: IDEMPOTENCY_KEY,
      telegramUserId: "42",
      telegramChatId: "99",
    });

    const fields = airtable.records[0].fields;
    expect(record.id).toBe("rec1");
    expect(fields[AIRTABLE_FIELDS.invoiceNumber]).toBe("FE-1234");
    expect(fields[AIRTABLE_FIELDS.issueDate]).toBe("2026-09-15");
    expect(fields[AIRTABLE_FIELDS.supplierName]).toBe("Proveedor SAS");
    expect(fields[AIRTABLE_FIELDS.supplierTaxId]).toBe("900123456-7");
    expect(fields[AIRTABLE_FIELDS.subtotal]).toBe(840336);
    expect(fields[AIRTABLE_FIELDS.tax]).toBe(159664);
    expect(fields[AIRTABLE_FIELDS.total]).toBe(1000000);
    expect(fields[AIRTABLE_FIELDS.currency]).toBe("COP");
    expect(fields[AIRTABLE_FIELDS.sourceFile]).toBe("factura.pdf");
    expect(fields[AIRTABLE_FIELDS.telegramUserId]).toBe("42");
    expect(fields[AIRTABLE_FIELDS.telegramChatId]).toBe("99");
    expect(fields[AIRTABLE_FIELDS.idempotencyKey]).toBe(IDEMPOTENCY_KEY);
    expect(typeof fields[AIRTABLE_FIELDS.createdAt]).toBe("string");
  });

  it("omits null fields instead of sending nulls to Airtable", async () => {
    const airtable = createFakeAirtable();
    const client = new AirtableInvoicesClient({ config: CONFIG, fetchImpl: airtable.fetchImpl });

    await client.createInvoiceRecord({
      invoice: { ...INVOICE, dueDate: null, cufe: null },
      idempotencyKey: IDEMPOTENCY_KEY,
      telegramUserId: null,
      telegramChatId: null,
    });

    const fields = airtable.records[0].fields;
    expect(AIRTABLE_FIELDS.dueDate in fields).toBe(false);
    expect(AIRTABLE_FIELDS.cufe in fields).toBe(false);
    expect(AIRTABLE_FIELDS.telegramUserId in fields).toBe(false);
  });

  it("finds an existing record by idempotency key", async () => {
    const airtable = createFakeAirtable();
    const client = new AirtableInvoicesClient({ config: CONFIG, fetchImpl: airtable.fetchImpl });

    expect(await client.findByIdempotencyKey(IDEMPOTENCY_KEY)).toBeNull();

    await client.createInvoiceRecord({
      invoice: INVOICE,
      idempotencyKey: IDEMPOTENCY_KEY,
      telegramUserId: null,
      telegramChatId: null,
    });

    expect((await client.findByIdempotencyKey(IDEMPOTENCY_KEY))?.id).toBe("rec1");
  });

  it("finds an existing record by supplier tax id plus invoice number", async () => {
    const airtable = createFakeAirtable();
    const client = new AirtableInvoicesClient({ config: CONFIG, fetchImpl: airtable.fetchImpl });

    await client.createInvoiceRecord({
      invoice: INVOICE,
      idempotencyKey: IDEMPOTENCY_KEY,
      telegramUserId: null,
      telegramChatId: null,
    });

    expect((await client.findByBusinessKey("900123456-7", "FE-1234"))?.id).toBe("rec1");
    expect(await client.findByBusinessKey("900123456-7", "FE-9999")).toBeNull();
  });

  it("skips the business-key lookup when either half is missing", async () => {
    const airtable = createFakeAirtable();
    const client = new AirtableInvoicesClient({ config: CONFIG, fetchImpl: airtable.fetchImpl });

    expect(await client.findByBusinessKey(null, "FE-1234")).toBeNull();
    expect(await client.findByBusinessKey("900123456-7", null)).toBeNull();
    expect(airtable.calls.list).toBe(0);
  });

  it("raises an AirtableError on a non-ok response", async () => {
    const client = new AirtableInvoicesClient({
      config: CONFIG,
      fetchImpl: async () => jsonResponse({ error: "NOT_FOUND" }, 404),
    });

    await expect(client.findByIdempotencyKey(IDEMPOTENCY_KEY)).rejects.toBeInstanceOf(
      AirtableError,
    );
  });

  it("raises an AirtableError on a network failure without leaking the key", async () => {
    const client = new AirtableInvoicesClient({
      config: CONFIG,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });

    const error = (await client
      .createInvoiceRecord({
        invoice: INVOICE,
        idempotencyKey: IDEMPOTENCY_KEY,
        telegramUserId: null,
        telegramChatId: null,
      })
      .catch((e) => e)) as AirtableError;

    expect(error).toBeInstanceOf(AirtableError);
    expect(error.message).not.toContain(CONFIG.apiKey);
    expect(error.userMessage).toMatch(/no pude guardarla en Airtable/u);
  });

  it("uploads file bytes to the content API", async () => {
    const airtable = createFakeAirtable();
    const client = new AirtableInvoicesClient({ config: CONFIG, fetchImpl: airtable.fetchImpl });
    const created = await client.createInvoiceRecord({
      invoice: INVOICE,
      idempotencyKey: IDEMPOTENCY_KEY,
      telegramUserId: null,
      telegramChatId: null,
    });

    const result = await client.uploadAttachment({
      recordId: created.id,
      bytes: JPEG_BYTES,
      fileName: "factura.jpg",
      contentType: "image/jpeg",
    });

    expect(result.attached).toBe(true);
    expect(airtable.calls.upload).toBe(1);
    expect(airtable.fetchImpl.mock.calls[1]?.[0]).toContain("content.airtable.com");
    expect(airtable.records[0].fields[AIRTABLE_FIELDS.attachment]).toEqual([
      expect.objectContaining({ filename: "factura.jpg", type: "image/jpeg", size: JPEG_BYTES.byteLength }),
    ]);
    const uploadBody = JSON.parse(String(airtable.fetchImpl.mock.calls[1]?.[1]?.body)) as {
      file: string;
      filename: string;
      contentType: string;
    };
    expect(uploadBody.file).toBe(Buffer.from(JPEG_BYTES).toString("base64"));
    expect(uploadBody.filename).toBe("factura.jpg");
    expect(uploadBody.contentType).toBe("image/jpeg");
  });

  it("adds a file extension when the staged name has none", async () => {
    const airtable = createFakeAirtable();
    const client = new AirtableInvoicesClient({ config: CONFIG, fetchImpl: airtable.fetchImpl });
    const created = await client.createInvoiceRecord({
      invoice: INVOICE,
      idempotencyKey: IDEMPOTENCY_KEY,
      telegramUserId: null,
      telegramChatId: null,
    });

    await client.uploadAttachment({
      recordId: created.id,
      bytes: PNG_BYTES,
      fileName: "d181d53bcaaef2a8",
      contentType: "image/png",
    });

    expect(airtable.records[0].fields[AIRTABLE_FIELDS.attachment]).toEqual([
      expect.objectContaining({ filename: "d181d53bcaaef2a8.png" }),
    ]);
  });

  it("skips the content API when the file is over 5 MB", async () => {
    const airtable = createFakeAirtable();
    const client = new AirtableInvoicesClient({ config: CONFIG, fetchImpl: airtable.fetchImpl });
    const created = await client.createInvoiceRecord({
      invoice: INVOICE,
      idempotencyKey: IDEMPOTENCY_KEY,
      telegramUserId: null,
      telegramChatId: null,
    });

    const tooBig = new Uint8Array(MAX_ATTACHMENT_UPLOAD_BYTES + 1);
    tooBig.set(JPEG_BYTES);
    const result = await client.uploadAttachment({
      recordId: created.id,
      bytes: tooBig,
      fileName: "factura.jpg",
      contentType: "image/jpeg",
    });

    expect(result).toEqual({ attached: false, reason: "too_large" });
    expect(airtable.calls.upload).toBe(0);
    expect(AIRTABLE_FIELDS.attachment in airtable.records[0].fields).toBe(false);
  });

  it("raises an attachment-specific AirtableError without leaking the key", async () => {
    const client = new AirtableInvoicesClient({
      config: CONFIG,
      fetchImpl: async () => jsonResponse({ error: "UNPROCESSABLE" }, 422),
    });

    const error = (await client
      .uploadAttachment({
        recordId: "rec1",
        bytes: JPEG_BYTES,
        fileName: "factura.jpg",
        contentType: "image/jpeg",
      })
      .catch((e) => e)) as AirtableError;

    expect(error).toBeInstanceOf(AirtableError);
    expect(error.message).not.toContain(CONFIG.apiKey);
    expect(error.userMessage).toMatch(/no pude subir el archivo/u);
  });
});

describe("attachment helpers", () => {
  it("detects a populated Attachment cell", () => {
    expect(recordHasAttachment({ id: "rec1", fields: {} })).toBe(false);
    expect(recordHasAttachment({ id: "rec1", fields: { [AIRTABLE_FIELDS.attachment]: [] } })).toBe(
      false,
    );
    expect(
      recordHasAttachment({
        id: "rec1",
        fields: { [AIRTABLE_FIELDS.attachment]: [{ filename: "factura.pdf" }] },
      }),
    ).toBe(true);
  });

  it("appends an extension only when the name has none", () => {
    expect(fileNameForUpload("factura.pdf", "application/pdf")).toBe("factura.pdf");
    expect(fileNameForUpload("abc123", "image/jpeg")).toBe("abc123.jpg");
  });
});

/* -------------------------------------------------------------------------- */
/* The save_invoice tool, against the same in-memory Airtable.                 */
/* -------------------------------------------------------------------------- */

const saveInvoiceTool = (await import("#tools/save_invoice.js")).default as unknown as {
  execute(
    input: { invoice: Invoice; idempotencyKey: string },
    ctx: unknown,
  ): Promise<{
    success: boolean;
    created: boolean;
    duplicate: boolean;
    attached: boolean;
    recordId: string | null;
    missingCriticalFields?: string[];
    message: string;
  }>;
};

function fakeSandbox(files: Record<string, Uint8Array>) {
  function childrenOf(dir: string): string[] {
    const prefix = `${dir.replace(/\/+$/u, "")}/`;
    const names = new Set<string>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const first = path.slice(prefix.length).split("/")[0];
      if (first !== undefined && first !== "") names.add(first);
    }
    return [...names];
  }

  return {
    readBinaryFile: async ({ path }: { path: string }) => files[path] ?? null,
    run: async ({ command }: { command: string }) => {
      const match = /ls -1t\s+(.+?)\s+2>/u.exec(command);
      const raw = match?.[1] ?? JSON.stringify(ATTACHMENTS_DIR);
      const dir = JSON.parse(raw) as string;
      return { exitCode: 0, stdout: childrenOf(dir).join("\n"), stderr: "" };
    },
  };
}

function toolContext(userId?: number, chatId?: number, files?: Record<string, Uint8Array>) {
  return {
    session: {
      auth: {
        current:
          userId === undefined
            ? null
            : { attributes: { user_id: userId, chat_id: chatId } },
      },
    },
    ...(files === undefined ? {} : { getSandbox: async () => fakeSandbox(files) }),
  };
}

describe("save_invoice tool", () => {
  let airtable: ReturnType<typeof createFakeAirtable>;

  beforeEach(() => {
    airtable = createFakeAirtable();
    vi.stubEnv("AIRTABLE_API_KEY", CONFIG.apiKey);
    vi.stubEnv("AIRTABLE_BASE_ID", CONFIG.baseId);
    vi.stubEnv("AIRTABLE_TABLE_NAME", CONFIG.tableName);
    vi.stubGlobal("fetch", airtable.fetchImpl);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("creates the row and reports the record id", async () => {
    const result = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey: IDEMPOTENCY_KEY },
      toolContext(42, 99),
    );

    expect(result).toMatchObject({
      success: true,
      created: true,
      duplicate: false,
      attached: false,
      recordId: "rec1",
    });
    expect(airtable.records).toHaveLength(1);
    expect(airtable.records[0].fields[AIRTABLE_FIELDS.telegramUserId]).toBe("42");
    expect(airtable.records[0].fields[AIRTABLE_FIELDS.telegramChatId]).toBe("99");
  });

  it("creates only one record for two attempts with the same idempotencyKey", async () => {
    const first = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey: IDEMPOTENCY_KEY },
      toolContext(42, 99),
    );
    const second = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey: IDEMPOTENCY_KEY },
      toolContext(42, 99),
    );

    expect(first).toMatchObject({ created: true, duplicate: false, recordId: "rec1" });
    expect(second).toMatchObject({
      success: true,
      created: false,
      duplicate: true,
      recordId: "rec1",
    });
    expect(second.message).toBe("⚠️ Esta factura ya estaba registrada.");
    expect(airtable.records).toHaveLength(1);
    expect(airtable.calls.create).toBe(1);
  });

  it("detects a duplicate by supplier and invoice number even with a new idempotencyKey", async () => {
    await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey: "sha256:first-scan" },
      toolContext(42, 99),
    );

    // Same invoice photographed again: different bytes, same business identity.
    const second = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey: "sha256:second-scan" },
      toolContext(42, 99),
    );

    expect(second).toMatchObject({ created: false, duplicate: true, recordId: "rec1" });
    expect(airtable.records).toHaveLength(1);
  });

  it("refuses to save when a critical field is missing", async () => {
    const result = await saveInvoiceTool.execute(
      {
        invoice: { ...INVOICE, invoiceNumber: null, total: null },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      toolContext(42, 99),
    );

    expect(result).toMatchObject({ success: false, created: false, recordId: null });
    expect(result.missingCriticalFields).toEqual(["número de factura", "total"]);
    expect(airtable.calls.create).toBe(0);
  });

  it("raises a retry-friendly error when Airtable fails", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "SERVER_ERROR" }, 500));

    await expect(
      saveInvoiceTool.execute(
        { invoice: INVOICE, idempotencyKey: IDEMPOTENCY_KEY },
        toolContext(42, 99),
      ),
    ).rejects.toThrow(/no pude guardarla en Airtable/u);
  });

  it("saves without Telegram identity when the session is unauthenticated", async () => {
    const result = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey: IDEMPOTENCY_KEY },
      toolContext(),
    );

    expect(result.created).toBe(true);
    expect(AIRTABLE_FIELDS.telegramUserId in airtable.records[0].fields).toBe(false);
  });

  it.each([
    { bytes: JPEG_BYTES, fileName: "factura.jpg", mediaType: "image/jpeg" },
    { bytes: PNG_BYTES, fileName: "factura.png", mediaType: "image/png" },
    { bytes: PDF_BYTES, fileName: "factura.pdf", mediaType: "application/pdf" },
  ])("creates the row and uploads $fileName", async ({ bytes, fileName, mediaType }) => {
    const path = `${ATTACHMENTS_DIR}/${fileName}`;
    const idempotencyKey = `sha256:${sha256Hex(bytes)}`;

    const result = await saveInvoiceTool.execute(
      { invoice: { ...INVOICE, sourceFileName: fileName }, idempotencyKey },
      toolContext(42, 99, { [path]: bytes }),
    );

    expect(result).toMatchObject({
      success: true,
      created: true,
      duplicate: false,
      attached: true,
      recordId: "rec1",
    });
    expect(airtable.calls.upload).toBe(1);
    expect(airtable.records[0].fields[AIRTABLE_FIELDS.attachment]).toEqual([
      expect.objectContaining({ filename: fileName, type: mediaType }),
    ]);
  });

  it("does not re-upload when the duplicate already has an attachment", async () => {
    const path = `${ATTACHMENTS_DIR}/factura.jpg`;
    const idempotencyKey = `sha256:${sha256Hex(JPEG_BYTES)}`;
    const ctx = toolContext(42, 99, { [path]: JPEG_BYTES });

    await saveInvoiceTool.execute({ invoice: INVOICE, idempotencyKey }, ctx);
    const second = await saveInvoiceTool.execute({ invoice: INVOICE, idempotencyKey }, ctx);

    expect(second).toMatchObject({ duplicate: true, attached: true, recordId: "rec1" });
    expect(airtable.calls.create).toBe(1);
    expect(airtable.calls.upload).toBe(1);
    expect(airtable.records[0].fields[AIRTABLE_FIELDS.attachment]).toHaveLength(1);
  });

  it("attaches on a duplicate retry when the existing row has no file", async () => {
    const path = `${ATTACHMENTS_DIR}/factura.jpg`;
    const idempotencyKey = `sha256:${sha256Hex(JPEG_BYTES)}`;

    const first = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey },
      toolContext(42, 99),
    );
    expect(first).toMatchObject({ created: true, attached: false });
    expect(airtable.calls.upload).toBe(0);

    const second = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey },
      toolContext(42, 99, { [path]: JPEG_BYTES }),
    );

    expect(second).toMatchObject({
      created: false,
      duplicate: true,
      attached: true,
      recordId: "rec1",
    });
    expect(airtable.calls.create).toBe(1);
    expect(airtable.calls.upload).toBe(1);
  });

  it("saves the row without attaching when the file is over 5 MB", async () => {
    const tooBig = new Uint8Array(MAX_ATTACHMENT_UPLOAD_BYTES + 1);
    tooBig.set(JPEG_BYTES);
    const path = `${ATTACHMENTS_DIR}/factura.jpg`;
    const idempotencyKey = `sha256:${sha256Hex(tooBig)}`;

    const result = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey },
      toolContext(42, 99, { [path]: tooBig }),
    );

    expect(result).toMatchObject({
      success: true,
      created: true,
      attached: false,
      recordId: "rec1",
    });
    expect(result.message).toMatch(/más de 5 MB/u);
    expect(airtable.calls.create).toBe(1);
    expect(airtable.calls.upload).toBe(0);
  });

  it("does not attach a sandbox file whose hash does not match the idempotency key", async () => {
    const path = `${ATTACHMENTS_DIR}/otra.jpg`;

    const result = await saveInvoiceTool.execute(
      { invoice: INVOICE, idempotencyKey: `sha256:${sha256Hex(PDF_BYTES)}` },
      toolContext(42, 99, { [path]: JPEG_BYTES }),
    );

    expect(result).toMatchObject({ created: true, attached: false, recordId: "rec1" });
    expect(airtable.calls.upload).toBe(0);
  });

  it("raises a retry-friendly error when the attachment upload fails after creating the row", async () => {
    const path = `${ATTACHMENTS_DIR}/factura.jpg`;
    const idempotencyKey = `sha256:${sha256Hex(JPEG_BYTES)}`;
    const failingFetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).includes("content.airtable.com")) {
        return jsonResponse({ error: "UNPROCESSABLE" }, 422);
      }
      return airtable.fetchImpl(input, init);
    });
    vi.stubGlobal("fetch", failingFetch);

    await expect(
      saveInvoiceTool.execute(
        { invoice: INVOICE, idempotencyKey },
        toolContext(42, 99, { [path]: JPEG_BYTES }),
      ),
    ).rejects.toThrow(/no pude subir el archivo/u);

    expect(airtable.records).toHaveLength(1);
  });
});
