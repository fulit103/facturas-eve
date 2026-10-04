import { vi } from "vitest";

import type { AirtableTableSchema } from "#lib/codeact/airtable-gateway.js";

export interface FakeTable {
  schema: AirtableTableSchema;
  records: Array<{ id: string; createdTime: string; fields: Record<string, unknown> }>;
}

/**
 * Minimal read-only Airtable REST double: the meta tables endpoint and paged
 * list-records with `pageSize`, `offset`, `maxRecords`, `fields[]`, and a tiny
 * `filterByFormula` subset (`{Field} = "value"`). Anything else is a 4xx, and
 * any non-GET is recorded so tests can assert that none happened.
 */
export function createFakeAirtable(input: {
  baseId: string;
  tables: FakeTable[];
  /** Responses to return before the real one, e.g. [429, 503]. */
  failFirst?: number[];
}) {
  const failures = [...(input.failFirst ?? [])];
  const requests: Array<{ method: string; url: string; authorization: string | null }> = [];

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({ method, url, authorization: headers.get("authorization") });

    if (method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    const failure = failures.shift();
    if (failure !== undefined) return json({ error: { type: "FAKE", message: "fail" } }, failure);

    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (segments[1] === "meta") {
      if (segments[3] !== input.baseId) return json({ error: "NOT_FOUND" }, 404);
      return json({ tables: input.tables.map((table) => table.schema) });
    }

    if (segments[1] !== input.baseId) return json({ error: "NOT_FOUND" }, 404);
    const table = input.tables.find(
      (candidate) => candidate.schema.id === segments[2] || candidate.schema.name === segments[2],
    );
    if (table === undefined) return json({ error: "TABLE_NOT_FOUND" }, 404);

    if (segments[3] !== undefined) {
      const record = table.records.find((candidate) => candidate.id === segments[3]);
      return record === undefined ? json({ error: "NOT_FOUND" }, 404) : json(record);
    }

    let records = table.records;
    const formula = parsed.searchParams.get("filterByFormula");
    if (formula !== null) {
      const match = /^\{(.+)\} = "(.*)"$/u.exec(formula);
      if (match === null) {
        return json({ error: { type: "INVALID_FILTER_BY_FORMULA", message: "bad formula" } }, 422);
      }
      records = records.filter((record) => String(record.fields[match[1]!]) === match[2]);
    }
    const fields = parsed.searchParams.getAll("fields[]");
    if (fields.length > 0) {
      records = records.map((record) => ({
        ...record,
        fields: Object.fromEntries(Object.entries(record.fields).filter(([key]) => fields.includes(key))),
      }));
    }
    const maxRecords = Number(parsed.searchParams.get("maxRecords") ?? Number.POSITIVE_INFINITY);
    records = records.slice(0, maxRecords);

    const pageSize = Number(parsed.searchParams.get("pageSize") ?? 100);
    const start = Number(parsed.searchParams.get("offset") ?? 0);
    const page = records.slice(start, start + pageSize);
    const next = start + pageSize < records.length ? String(start + pageSize) : undefined;
    return json(next === undefined ? { records: page } : { records: page, offset: next });
  });

  return { fetchImpl, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An `Invoices` table shaped like the one `save_invoice` writes. */
export function invoicesTable(count: number): FakeTable {
  const suppliers = ["ACME SAS", "Papelería Andina", "Servicios Cloud Ltda"];
  const records = Array.from({ length: count }, (_, index) => {
    const month = (index % 6) + 1;
    return {
      id: `rec${String(index).padStart(14, "0")}`,
      createdTime: `2026-0${month}-10T12:00:00.000Z`,
      fields: {
        "Invoice Number": `FE-${1000 + index}`,
        "Supplier Name": suppliers[index % suppliers.length],
        "Issue Date": `2026-0${month}-${String((index % 27) + 1).padStart(2, "0")}`,
        Total: 100_000 * ((index % 5) + 1),
        Currency: "COP",
        ...(index % 4 === 0 ? {} : { Tax: 19_000 * ((index % 5) + 1) }),
      },
    };
  });
  return {
    schema: {
      id: "tblInvoices0000001",
      name: "Invoices",
      primaryFieldId: "fldNumber",
      fields: [
        { id: "fldNumber", name: "Invoice Number", type: "singleLineText" },
        { id: "fldSupplier", name: "Supplier Name", type: "singleLineText" },
        { id: "fldDate", name: "Issue Date", type: "date" },
        { id: "fldTotal", name: "Total", type: "currency", options: { precision: 0 } },
        { id: "fldTax", name: "Tax", type: "currency" },
        { id: "fldCurrency", name: "Currency", type: "singleLineText" },
      ],
    },
    records,
  };
}
