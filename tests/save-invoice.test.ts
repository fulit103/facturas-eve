import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AIRTABLE_FIELDS, AirtableError, AirtableInvoicesClient } from "#lib/airtable.js";
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

interface FakeRecord {
  id: string;
  fields: Record<string, unknown>;
}

/**
 * Minimal in-memory Airtable. Understands the two `filterByFormula` shapes this
 * project builds: a single `{Field} = "value"`, and `AND(...)` of two of them.
 */
function createFakeAirtable() {
  const records: FakeRecord[] = [];
  let nextId = 1;

  const calls = { list: 0, create: 0 };

  const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    if ((init?.method ?? "GET") === "GET") {
      calls.list += 1;
      const formula = new URL(input).searchParams.get("filterByFormula") ?? "";
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
    recordId: string | null;
    missingCriticalFields?: string[];
    message: string;
  }>;
};

function toolContext(userId?: number, chatId?: number) {
  return {
    session: {
      auth: {
        current:
          userId === undefined
            ? null
            : { attributes: { user_id: userId, chat_id: chatId } },
      },
    },
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
});
