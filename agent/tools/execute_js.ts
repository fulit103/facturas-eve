import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  AirtableReadOnlyGateway,
  loadAirtableGatewayConfig,
} from "#lib/codeact/airtable-gateway.js";
import {
  DEFAULT_MEMORY_MB,
  DEFAULT_TIMEOUT_MS,
  executeJs,
  type ExecutionOutput,
} from "#lib/codeact/js-engine.js";
import { toModelView } from "#lib/codeact/model-view.js";
import { codeActStore } from "#lib/codeact/session-store.js";

/**
 * CodeAct entry point: the only tool the model uses to explore, query, and
 * chart the Airtable base. Schema discovery, reads, Arquero, and Vega-Lite
 * charts are a library inside the interpreter, not separate tools.
 */

const MAX_CODE_CHARS = 20_000;

export default defineTool({
  description: [
    "Run JavaScript in an isolated interpreter (QuickJS: no network, no files, no Intl, no timers) to",
    "explore, query, analyze, and chart the authorized Airtable base (read-only). The code is the body",
    "of an async function: use await, and `return` the result you need (arrays of objects and Arquero",
    "tables are shown as tables, max 50 rows). console.log output is returned too.",
    "Library: await airtable.listTables(); await airtable.describeTable(\"Tabla\");",
    "await airtable.records(\"Tabla\", { fields: [...], formula: \"{Campo} > 0\", view, sort:",
    "[{ field, direction: \"desc\" }], maxRecords }) -> array of plain objects with _id, _createdTime and",
    "one key per field (all pages, or an error; maxRecords is a declared sample);",
    "await airtable.getRecord(\"Tabla\", \"recXXX\"). Arquero: aq, op (aq.from(rows).groupby(...).rollup(...)).",
    "Helpers: money(n) -> \"$1.234.567\", month(\"2026-03-15\") -> \"2026-03\".",
    "Charts: chart(vegaLiteSpec, { title }) with inline data (data: { values: rowsOrArqueroTable });",
    "the user sees it right away. Persistence: only what you assign to `store` (store.facturas = rows)",
    "survives to the next call in this conversation; local variables do not.",
    "On error you get type, line, and stack: fix the code and call again.",
    `Limits: ${DEFAULT_TIMEOUT_MS / 1000}s, ${DEFAULT_MEMORY_MB} MB.`,
  ].join(" "),
  inputSchema: z.object({
    code: z
      .string()
      .min(1)
      .max(MAX_CODE_CHARS)
      .describe("JavaScript body of an async function. `return` the result."),
  }),
  label: {
    start: () => "Analizando los datos",
    complete: (_input, output) => {
      const result = output as ExecutionOutput;
      if (!result.ok) return "El análisis falló";
      return result.charts.length > 0
        ? `Análisis listo (${result.charts.length} gráfico${result.charts.length === 1 ? "" : "s"})`
        : "Análisis listo";
    },
  },
  async execute({ code }): Promise<ExecutionOutput> {
    const timeoutMs = Number(process.env.CODEACT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const memoryMb = Number(process.env.CODEACT_MEMORY_MB) || DEFAULT_MEMORY_MB;

    const config = loadAirtableGatewayConfig();
    const gateway =
      config === null
        ? null
        : new AirtableReadOnlyGateway({ config, deadline: Date.now() + timeoutMs });

    const { output, store } = await executeJs({
      code,
      gateway,
      store: codeActStore.get().values,
      limits: { timeoutMs, memoryMb },
    });
    codeActStore.update(() => ({ values: store }));
    return output;
  },
  toModelOutput(output) {
    return { type: "json", value: toModelView(output as ExecutionOutput) };
  },
});
