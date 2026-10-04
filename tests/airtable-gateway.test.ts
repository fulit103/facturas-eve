import { describe, expect, it } from "vitest";

import {
  AirtableReadError,
  AirtableReadOnlyGateway,
  DEFAULT_MAX_RECORDS_PER_READ,
  loadAirtableGatewayConfig,
  type AirtableGatewayConfig,
} from "#lib/codeact/airtable-gateway.js";

import { createFakeAirtable, invoicesTable } from "./helpers/fake-airtable.js";

const BASE_ID = "appTEST0000000001";

function config(overrides: Partial<AirtableGatewayConfig> = {}): AirtableGatewayConfig {
  return {
    apiKey: "patTEST",
    baseId: BASE_ID,
    allowedTables: [],
    maxRecordsPerRead: 20_000,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function gateway(
  airtable: ReturnType<typeof createFakeAirtable>,
  overrides: Partial<AirtableGatewayConfig> = {},
) {
  const sleeps: number[] = [];
  const instance = new AirtableReadOnlyGateway({
    config: config(overrides),
    fetchImpl: airtable.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { instance, sleeps };
}

describe("loadAirtableGatewayConfig", () => {
  it("prefers the read-only token and parses the table allow-list", () => {
    const loaded = loadAirtableGatewayConfig({
      AIRTABLE_API_KEY: "patWRITE",
      AIRTABLE_READ_API_KEY: "patREAD",
      AIRTABLE_BASE_ID: "appX",
      AIRTABLE_ANALYTICS_TABLES: "Invoices, Proveedores ,",
    });
    expect(loaded).toMatchObject({
      apiKey: "patREAD",
      baseId: "appX",
      allowedTables: ["Invoices", "Proveedores"],
      maxRecordsPerRead: DEFAULT_MAX_RECORDS_PER_READ,
    });
  });

  it("returns null when the base or token is missing", () => {
    expect(loadAirtableGatewayConfig({ AIRTABLE_API_KEY: "pat" })).toBeNull();
    expect(loadAirtableGatewayConfig({ AIRTABLE_BASE_ID: "app" })).toBeNull();
  });
});

describe("AirtableReadOnlyGateway", () => {
  it("follows every page and only issues authenticated GETs against the configured base", async () => {
    const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(230)] });
    const { instance } = gateway(airtable);

    const result = await instance.listRecords({ table: "Invoices" });

    expect(result.records).toHaveLength(230);
    expect(result.complete).toBe(true);
    expect(result.pages).toBe(3);
    for (const request of airtable.requests) {
      expect(request.method).toBe("GET");
      expect(request.authorization).toBe("Bearer patTEST");
      expect(request.url).toContain(BASE_ID);
    }
  });

  it("passes fields, formula, and sort through to Airtable", async () => {
    const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(30)] });
    const { instance } = gateway(airtable);

    const result = await instance.listRecords({
      table: "invoices",
      fields: ["Supplier Name", "Total"],
      formula: '{Supplier Name} = "ACME SAS"',
      sort: [{ field: "Total", direction: "desc" }],
    });

    expect(result.records).toHaveLength(10);
    expect(Object.keys(result.records[0]!.fields).sort()).toEqual(["Supplier Name", "Total"]);
    const url = new URL(airtable.requests.at(-1)!.url);
    expect(url.searchParams.get("sort[0][direction]")).toBe("desc");
    expect(url.searchParams.getAll("fields[]")).toEqual(["Supplier Name", "Total"]);
  });

  it("fails instead of returning a silently truncated read", async () => {
    const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(150)] });
    const { instance } = gateway(airtable, { maxRecordsPerRead: 120 });

    await expect(instance.listRecords({ table: "Invoices" })).rejects.toMatchObject({
      code: "TOO_MANY_RECORDS",
    });
    const sample = await instance.listRecords({ table: "Invoices", maxRecords: 40 });
    expect(sample).toMatchObject({ complete: false });
    expect(sample.records).toHaveLength(40);
  });

  it("reports a sample as complete when the table is smaller than max_records", async () => {
    const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(12)] });
    const { instance } = gateway(airtable);

    const result = await instance.listRecords({ table: "Invoices", maxRecords: 12 });
    expect(result).toMatchObject({ complete: true });
    expect(result.records).toHaveLength(12);
  });

  it("retries 429 and 5xx with backoff, honoring Retry-After", async () => {
    const airtable = createFakeAirtable({
      baseId: BASE_ID,
      tables: [invoicesTable(5)],
      failFirst: [429, 502],
    });
    const { instance, sleeps } = gateway(airtable);

    const tables = await instance.listTables();
    expect(tables.map((table) => table.name)).toEqual(["Invoices"]);
    expect(airtable.fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps.filter((ms) => ms >= 500)).toEqual([500, 1000]);
  });

  it("does not retry client errors and explains them", async () => {
    const airtable = createFakeAirtable({
      baseId: BASE_ID,
      tables: [invoicesTable(5)],
      failFirst: [403],
    });
    const { instance } = gateway(airtable);

    const error = await instance.listTables().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AirtableReadError);
    expect((error as AirtableReadError).message).toContain("schema.bases:read");
    expect((error as AirtableReadError).message).not.toContain("patTEST");
    expect(airtable.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown fields with the real field names", async () => {
    const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(5)] });
    const { instance } = gateway(airtable);

    await expect(instance.listRecords({ table: "Invoices", fields: ["Monto"] })).rejects.toThrow(
      /Campos inexistentes en "Invoices": Monto\. Campos disponibles: Invoice Number/u,
    );
  });

  it("hides tables outside the allow-list", async () => {
    const other = invoicesTable(3);
    other.schema = { ...other.schema, id: "tblPrivate00000001", name: "Nómina" };
    const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(5), other] });
    const { instance } = gateway(airtable, { allowedTables: ["Invoices"] });

    expect((await instance.listTables()).map((table) => table.name)).toEqual(["Invoices"]);
    await expect(instance.listRecords({ table: "Nómina" })).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
    });
  });

  it("validates record ids before calling Airtable", async () => {
    const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(5)] });
    const { instance } = gateway(airtable);

    await expect(instance.getRecord("Invoices", "../../meta")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const record = await instance.getRecord("Invoices", "rec00000000000002");
    expect(record.fields["Invoice Number"]).toBe("FE-1002");
  });
});
