import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AirtableReadOnlyGateway,
  type AirtableGatewayConfig,
} from "#lib/codeact/airtable-gateway.js";
import { executeJs, type StoreSnapshot } from "#lib/codeact/js-engine.js";

import { createFakeAirtable, invoicesTable } from "./helpers/fake-airtable.js";

const API_KEY = "patSECRET.never-in-the-interpreter";
const BASE_ID = "appTEST0000000001";

function gatewayConfig(overrides: Partial<AirtableGatewayConfig> = {}): AirtableGatewayConfig {
  return {
    apiKey: API_KEY,
    baseId: BASE_ID,
    allowedTables: [],
    maxRecordsPerRead: 20_000,
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** A session: executions share `store`, like the tool does with defineState. */
function setup(count = 30, config: Partial<AirtableGatewayConfig> = {}, failFirst?: number[]) {
  const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(count)], failFirst });
  let store: StoreSnapshot = {};
  const run = async (code: string, limits?: { timeoutMs?: number; memoryMb?: number }) => {
    const gateway = new AirtableReadOnlyGateway({
      config: gatewayConfig(config),
      fetchImpl: airtable.fetchImpl,
      sleep: async () => {},
    });
    const result = await executeJs({ code, gateway, store, limits });
    store = result.store;
    return result.output;
  };
  return { airtable, run, store: () => store };
}

describe("execute_js (QuickJS + Arquero + read-only gateway)", () => {
  it("discovers the real schema before querying", async () => {
    const { run } = setup();
    const output = await run(`
const tables = await airtable.listTables();
console.log(tables.map(t => t.table).join(", "));
const fields = await airtable.describeTable("Invoices");
return fields.map(f => ({ field: f.field, type: f.type }));
`);

    expect(output.error).toBeNull();
    expect(output.stdout).toBe("Invoices");
    expect(output.result).toMatchObject({ kind: "table", columns: ["field", "type"] });
    expect((output.result as { rows: unknown[][] }).rows).toContainEqual(["Total", "currency"]);
  });

  it("answers 'how many records per category' reading every page", async () => {
    const { run, airtable } = setup(250);
    const output = await run(`
const rows = await airtable.records("Invoices", { fields: ["Supplier Name", "Total"] });
return aq.from(rows)
  .groupby("Supplier Name")
  .rollup({ facturas: op.count(), total: op.sum("Total") })
  .orderby(aq.desc("facturas"));
`);

    expect(output.error).toBeNull();
    expect(output.dataReads).toEqual([
      expect.objectContaining({ table: "Invoices", records: 250, complete: true, pages: 3 }),
    ]);
    const table = output.result as { rows: unknown[][]; columns: string[] };
    expect(table.columns).toEqual(["Supplier Name", "facturas", "total"]);
    expect(table.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(250);
    expect(airtable.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("charts the monthly total, then filters a period reusing store", async () => {
    const { run, airtable } = setup(60);
    const first = await run(`
store.facturas = await airtable.records("Invoices");
const mensual = aq.from(store.facturas)
  .derive({ mes: d => op.substring(d["Issue Date"], 0, 7) })
  .groupby("mes").rollup({ total: op.sum("Total") }).orderby("mes");
chart({
  data: { values: mensual },
  mark: { type: "line", point: true },
  encoding: {
    x: { field: "mes", type: "ordinal", title: "Mes" },
    y: { field: "total", type: "quantitative", title: "Total" },
  },
}, { title: "Total facturado por mes" });
return mensual;
`);
    expect(first.error).toBeNull();
    expect(first.charts).toHaveLength(1);
    expect(first.charts[0]).toMatchObject({ title: "Total facturado por mes" });
    const spec = first.charts[0]!.spec as { data: { values: unknown[] }; title: string };
    expect(spec.data.values).toHaveLength(6);
    expect(spec.title).toBe("Total facturado por mes");
    expect(first.variables).toEqual([
      expect.objectContaining({ name: "facturas", type: "array", length: 60 }),
    ]);

    const readsBefore = airtable.requests.length;
    const second = await run(`
const periodo = store.facturas.filter(f => f["Issue Date"] >= "2026-03-01" && f["Issue Date"] < "2026-05-01");
const porMes = aq.from(periodo)
  .derive({ mes: d => op.substring(d["Issue Date"], 0, 7) })
  .groupby("mes").rollup({ total: op.sum("Total") });
chart({ data: { values: porMes }, mark: "bar",
  encoding: { x: { field: "mes", type: "ordinal" }, y: { field: "total", type: "quantitative" } } },
  { title: "Marzo-abril" });
return { facturas: periodo.length, total: money(periodo.reduce((s, f) => s + f.Total, 0)) };
`);
    expect(second.error).toBeNull();
    expect(airtable.requests.length).toBe(readsBefore);
    expect(second.charts[0]!.title).toBe("Marzo-abril");
    expect(second.result).toMatchObject({ kind: "text" });
    expect((second.result as { text: string }).text).toContain('"facturas": 20');
  });

  it("returns a structured error the model can fix, and keeps store", async () => {
    const { run } = setup();
    await run(`store.n = 3`);
    const broken = await run(`const x = 1;
return store.facturas.length;`);
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatchObject({ type: "TypeError", line: 2 });
    expect(broken.error?.code_line).toBe("return store.facturas.length;");

    const fixed = await run(`return store.n * 2;`);
    expect(fixed.result).toEqual({ kind: "text", text: "6", truncated: false });
  });

  it("reports syntax errors with their line", async () => {
    const { run } = setup();
    const output = await run(`const a = 1;\nconst b = ;`);
    expect(output.error?.type).toBe("SyntaxError");
    expect(output.error?.line).toBe(2);
  });

  it("reports unknown tables and fields with the valid names", async () => {
    const { run } = setup();
    const table = await run(`return await airtable.records("Facturas");`);
    expect(table.error?.type).toBe("AirtableError");
    expect(table.error?.message).toContain("Tablas disponibles: Invoices");

    const fields = await run(`return await airtable.records("Invoices", { fields: ["Monto"] });`);
    expect(fields.error?.message).toContain("Campos inexistentes");
  });

  it("never presents a capped read as complete", async () => {
    const { run } = setup(250, { maxRecordsPerRead: 100 });
    const tooMany = await run(`return (await airtable.records("Invoices")).length;`);
    expect(tooMany.error?.message).toContain("más de 100 registros");

    const sample = await run(`return (await airtable.records("Invoices", { maxRecords: 50 })).length;`);
    expect(sample.result).toEqual({ kind: "text", text: "50", truncated: false });
    expect(sample.dataReads[0]).toMatchObject({ records: 50, complete: false });
    expect(sample.stdout).toContain("lectura parcial");
  });

  it("retries rate limits and server errors", async () => {
    const { run, airtable } = setup(10, {}, [429, 503]);
    const output = await run(`return (await airtable.records("Invoices")).length;`);
    expect(output.result).toEqual({ kind: "text", text: "10", truncated: false });
    expect(airtable.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("has no access to the host: no env, fetch, require, or bridge", async () => {
    const { run, store } = setup();
    const output = await run(`
return {
  process: typeof process,
  fetch: typeof fetch,
  require: typeof require,
  host: typeof __host,
  setTimeout: typeof setTimeout,
};`);
    expect(JSON.parse((output.result as { text: string }).text)).toEqual({
      process: "undefined",
      fetch: "undefined",
      require: "undefined",
      host: "undefined",
      setTimeout: "undefined",
    });
    expect(JSON.stringify(output)).not.toContain("patSECRET");
    expect(JSON.stringify(store())).not.toContain("patSECRET");
  });

  it("stops runaway code at the time limit", async () => {
    const { run } = setup();
    await run(`store.kept = "sí"`);
    const output = await run(`store.kept = "no"; while (true) {}`, { timeoutMs: 500 });
    expect(output.error?.type).toBe("ExecutionTimeout");

    const after = await run(`return store.kept;`);
    expect(after.result).toEqual({ kind: "text", text: "sí", truncated: false });
  });

  it("stops code that awaits a promise that never settles", async () => {
    const { run } = setup();
    const output = await run(`await new Promise(() => {}); return 1;`);
    expect(output.error?.type).toBe("StalledPromise");
  });

  it("enforces the memory limit", async () => {
    const { run } = setup();
    const output = await run(
      `const a = []; while (true) a.push(new Array(100000).fill(a.length));`,
      { memoryMb: 64, timeoutMs: 20_000 },
    );
    expect(output.error?.type).toBe("MemoryLimit");
  }, 30_000);

  it("isolates store between sessions", async () => {
    const first = setup();
    await first.run(`store.secretTotal = 42`);
    const second = setup();
    const output = await second.run(`return "secretTotal" in store;`);
    expect(output.result).toEqual({ kind: "text", text: "false", truncated: false });
  });

  it("round-trips dates and Arquero tables through store", async () => {
    const { run } = setup();
    await run(`
store.cuando = new Date("2026-05-01T00:00:00Z");
store.tabla = aq.from([{ mes: "2026-01", total: 10 }, { mes: "2026-02", total: 20 }]);
store.fn = () => 1;`);
    const output = await run(
      `return [store.cuando instanceof Date, store.tabla.numRows(), store.tabla.array("total"), "fn" in store];`,
    );
    expect(JSON.parse((output.result as { text: string }).text)).toEqual([true, 2, [10, 20], false]);
  });

  it("rejects charts that would load external data", async () => {
    const { run } = setup();
    const output = await run(
      `chart({ data: { url: "https://example.com/x.json" }, mark: "bar" }); return 1;`,
    );
    expect(output.error?.type).toBe("ChartError");
    expect(output.error?.message).toContain("recursos externos");
    expect(output.charts).toHaveLength(0);
  });

  it("explains when Airtable is not configured", async () => {
    const result = await executeJs({ code: `return await airtable.listTables();`, gateway: null, store: {} });
    expect(result.output.error?.message).toContain("Airtable no está configurado");
  });

  it("formats money in es-CO", async () => {
    const { run } = setup();
    const output = await run(`return [money(1234567.8), money(-500), money(1000.5, 2)];`);
    expect(JSON.parse((output.result as { text: string }).text)).toEqual([
      "$1.234.568",
      "-$500",
      "$1.000,50",
    ]);
  });

  it("runs the example from agent/instructions.md", async () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const start = instructions.indexOf("Ejemplo de total por mes con gráfico:");
    const block = instructions
      .slice(start)
      .split("\n")
      .slice(2)
      .filter((line, index, lines) => lines.slice(0, index + 1).every((l) => l.startsWith("    ") || l === ""))
      .map((line) => line.slice(4))
      .join("\n")
      .trim();
    expect(block).toContain("return porMes;");

    const { run } = setup(60);
    const output = await run(block);
    expect(output.error).toBeNull();
    expect(output.charts).toHaveLength(1);
    expect((output.result as { total_rows: number }).total_rows).toBe(6);
  });

  it("times out cleanly while an Airtable read is still in flight", async () => {
    let release: () => void = () => {};
    const slowFetch = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ tables: [] });
    };
    const gateway = new AirtableReadOnlyGateway({
      config: gatewayConfig(),
      fetchImpl: slowFetch,
      sleep: async () => {},
    });
    const result = await executeJs({
      code: `return await airtable.listTables();`,
      gateway,
      store: {},
      limits: { timeoutMs: 300 },
    });
    expect(result.output.error?.type).toBe("ExecutionTimeout");
    // The late response must not touch the disposed interpreter.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const next = await executeJs({ code: `return 1 + 1;`, gateway: null, store: {} });
    expect(next.output.result).toEqual({ kind: "text", text: "2", truncated: false });
  });
});
