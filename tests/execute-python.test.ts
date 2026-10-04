import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AirtableReadOnlyGateway,
  type AirtableGatewayConfig,
} from "#lib/codeact/airtable-gateway.js";
import { executePython, type ExecutionOutput } from "#lib/codeact/executor.js";

import { createFakeAirtable, invoicesTable } from "./helpers/fake-airtable.js";
import { createLocalSandbox, hasPythonDataStack } from "./helpers/local-sandbox.js";

const API_KEY = "patSECRET.never-in-the-sandbox";
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

const describeWithPython = hasPythonDataStack() ? describe : describe.skip;

describeWithPython("execute_python (runner + RPC bridge, real python3)", () => {
  let home: string;
  let sandbox: ReturnType<typeof createLocalSandbox>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "codeact-"));
    sandbox = createLocalSandbox();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function setup(count = 30, config: Partial<AirtableGatewayConfig> = {}, failFirst?: number[]) {
    const airtable = createFakeAirtable({ baseId: BASE_ID, tables: [invoicesTable(count)], failFirst });
    const makeGateway = () =>
      new AirtableReadOnlyGateway({
        config: gatewayConfig(config),
        fetchImpl: airtable.fetchImpl,
        sleep: async () => {},
      });
    const run = (code: string, limits?: { timeoutMs?: number }): Promise<ExecutionOutput> =>
      executePython({ sandbox, code, gateway: makeGateway(), home, limits });
    return { airtable, run };
  }

  it("discovers the real schema before querying", async () => {
    const { run } = setup();
    const output = await run(`
tables = airtable.list_tables()
fields = airtable.describe_table("Invoices")
print(tables.to_string())
fields[["field", "type"]]
`);

    expect(output.error).toBeNull();
    expect(output.ok).toBe(true);
    expect(output.stdout).toContain("Invoices");
    expect(output.result).toMatchObject({ kind: "table", columns: ["field", "type"] });
    expect((output.result as { rows: unknown[][] }).rows).toContainEqual(["Total", "currency"]);
  }, 30_000);

  it("answers 'how many records per category' with every page read", async () => {
    const { run, airtable } = setup(250);
    const output = await run(`
df = airtable.records("Invoices", fields=["Supplier Name", "Total", "Issue Date"])
df.groupby("Supplier Name").size().rename("facturas").sort_values(ascending=False)
`);

    expect(output.error).toBeNull();
    expect(output.dataReads).toEqual([
      expect.objectContaining({ table: "Invoices", records: 250, complete: true, pages: 3 }),
    ]);
    const table = output.result as { rows: unknown[][]; columns: string[] };
    expect(table.columns).toEqual(["Supplier Name", "facturas"]);
    const total = table.rows.reduce((sum, row) => sum + Number(row[1]), 0);
    expect(total).toBe(250);
    // Only reads, always with the token added by the host.
    expect(airtable.requests.every((request) => request.method === "GET")).toBe(true);
  }, 30_000);

  it("charts the monthly total, then filters a period reusing the session variable", async () => {
    const { run, airtable } = setup(60);
    const first = await run(`
df = airtable.records("Invoices")
df["Issue Date"] = pd.to_datetime(df["Issue Date"])
monthly = df.groupby(df["Issue Date"].dt.to_period("M"))["Total"].sum()
ax = monthly.plot(kind="line", marker="o", title="Total por mes")
show_chart(title="Total facturado por mes")
monthly
`);
    expect(first.error).toBeNull();
    expect(first.charts).toHaveLength(1);
    expect(first.charts[0]).toMatchObject({ title: "Total facturado por mes", mediaType: "image/png" });
    const png = Buffer.from(first.charts[0]!.dataBase64!, "base64");
    expect(png.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(first.variables.map((variable) => variable.name)).toEqual(
      expect.arrayContaining(["df", "monthly"]),
    );

    const readsBefore = airtable.requests.length;
    const second = await run(`
period = df[(df["Issue Date"] >= "2026-03-01") & (df["Issue Date"] < "2026-05-01")]
fig, ax = plt.subplots()
period.groupby(period["Issue Date"].dt.to_period("M"))["Total"].sum().plot(kind="bar", ax=ax)
ax.set_title("Marzo-abril")
{"facturas": len(period), "total": int(period["Total"].sum())}
`);
    expect(second.error).toBeNull();
    expect(airtable.requests.length).toBe(readsBefore);
    expect(second.charts).toHaveLength(1);
    expect(second.charts[0]!.title).toBe("Marzo-abril");
    expect(second.result).toMatchObject({ kind: "text" });
    expect((second.result as { text: string }).text).toContain("'facturas': 20");
  }, 30_000);

  it("returns a structured error the model can fix, and keeps earlier state", async () => {
    const { run } = setup();
    await run(`df = airtable.records("Invoices")`);
    const broken = await run(`
x = 1
df["Proveedor"].value_counts()
`);
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatchObject({ type: "KeyError", line: 3 });
    expect(broken.error?.code_line).toContain('df["Proveedor"]');

    const fixed = await run(`df["Supplier Name"].nunique()`);
    expect(fixed.ok).toBe(true);
    expect(fixed.result).toEqual({ kind: "text", text: "3", truncated: false });
  }, 30_000);

  it("reports unknown tables and fields with the valid names instead of guessing", async () => {
    const { run } = setup();
    const output = await run(`airtable.records("Facturas")`);
    expect(output.ok).toBe(false);
    expect(output.error?.type).toBe("AirtableError");
    expect(output.error?.message).toContain("Tablas disponibles: Invoices");

    const fields = await run(`airtable.records("Invoices", fields=["Monto"])`);
    expect(fields.error?.message).toContain("Campos inexistentes");
    expect(fields.error?.message).toContain("Total");
  }, 30_000);

  it("never presents a capped read as complete", async () => {
    const { run } = setup(250, { maxRecordsPerRead: 100 });
    const tooMany = await run(`df = airtable.records("Invoices")`);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error?.message).toContain("más de 100 registros");

    const sample = await run(`sample = airtable.records("Invoices", max_records=50)\nlen(sample)`);
    expect(sample.ok).toBe(true);
    expect(sample.dataReads[0]).toMatchObject({ records: 50, complete: false });
    expect(sample.stdout).toContain("lectura parcial");
  }, 30_000);

  it("retries rate limits and server errors", async () => {
    const { run, airtable } = setup(10, {}, [429, 503]);
    const output = await run(`len(airtable.records("Invoices"))`);
    expect(output.error).toBeNull();
    expect(output.result).toEqual({ kind: "text", text: "10", truncated: false });
    expect(airtable.fetchImpl).toHaveBeenCalledTimes(4);
  }, 30_000);

  it("keeps the token out of the sandbox", async () => {
    const { run } = setup();
    const output = await run(`
import os
leaks = [k for k, v in os.environ.items() if ("pat" + "SECRET") in v]
leaks
`);
    expect(output.result).toEqual({ kind: "text", text: "[]", truncated: false });

    const files = await listFiles(home);
    for (const file of files) {
      const content = await readFile(file);
      expect(content.includes(Buffer.from("patSECRET")), file).toBe(false);
    }
    expect(JSON.stringify(output)).not.toContain("patSECRET");
    expect(sandbox.spawned.join("\n")).not.toContain("patSECRET");
  }, 30_000);

  it("stops runaway code at the time limit", async () => {
    const { run } = setup();
    const output = await run(`while True:\n    pass`, { timeoutMs: 1_500 });
    expect(output.ok).toBe(false);
    expect(output.error?.type).toBe("ExecutionTimeout");
  }, 30_000);

  it("isolates variables between sessions", async () => {
    const { run } = setup();
    await run(`secret_total = 42`);

    const otherHome = await mkdtemp(join(tmpdir(), "codeact-other-"));
    try {
      const other = await executePython({
        sandbox,
        code: `"secret_total" in globals()`,
        gateway: null,
        home: otherHome,
      });
      expect(other.result).toEqual({ kind: "text", text: "False", truncated: false });
    } finally {
      await rm(otherHome, { recursive: true, force: true });
    }
  }, 30_000);

  it("explains when Airtable is not configured", async () => {
    const output = await executePython({
      sandbox,
      code: `airtable.list_tables()`,
      gateway: null,
      home,
    });
    expect(output.ok).toBe(false);
    expect(output.error?.message).toContain("Airtable no está configurado");
  }, 30_000);
});

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
