import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  AirtableReadOnlyGateway,
  loadAirtableGatewayConfig,
} from "#lib/codeact/airtable-gateway.js";
import {
  CodeEnvironmentError,
  DEFAULT_MEMORY_MB,
  DEFAULT_TIMEOUT_MS,
  executePython,
  type ExecutionOutput,
} from "#lib/codeact/executor.js";
import { toModelView } from "#lib/codeact/model-view.js";

/**
 * CodeAct entry point: the only tool the model uses to explore, query, and
 * chart the Airtable base. Everything else (schema discovery, reads, pandas,
 * matplotlib) is a library inside the Python environment, not a tool.
 */

const MAX_CODE_CHARS = 20_000;

export default defineTool({
  description: [
    "Run Python 3 code in this conversation's private sandbox to explore, query, analyze, and chart",
    "the authorized Airtable base (read-only). Preloaded: pd (pandas), np, plt (matplotlib),",
    "airtable, show_chart, money_axis. Discover the schema first: airtable.list_tables(),",
    'airtable.describe_table("Tabla"). Read with airtable.records("Tabla", fields=[...],',
    'formula="{Campo} > 0", view=None, sort=[{"field": "Campo", "direction": "desc"}],',
    "max_records=None) -> DataFrame (all pages, or an error; max_records gives a declared sample),",
    'and airtable.get_record("Tabla", "recXXX"). Compute with pandas and return only the summary:',
    "the value of the last expression is returned (DataFrames truncated to 50 rows), plus print()",
    "output. Charts: draw with matplotlib, format money axes with money_axis(ax), and call",
    "show_chart(title=...); open figures are also saved",
    "and shown to the user automatically. Variables persist between calls in this conversation",
    "(keep loaded DataFrames in variables for follow-up questions). On error you get the exception,",
    `line, and traceback: fix the code and call again. Limits: ${DEFAULT_TIMEOUT_MS / 1000}s,`,
    `${DEFAULT_MEMORY_MB} MB, no network, no credentials.`,
  ].join(" "),
  inputSchema: z.object({
    code: z
      .string()
      .min(1)
      .max(MAX_CODE_CHARS)
      .describe("Python code. The last expression's value is returned as the result."),
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
  async execute({ code }, ctx): Promise<ExecutionOutput> {
    const sandbox = await ctx.getSandbox();
    const timeoutMs = Number(process.env.CODEACT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const memoryMb = Number(process.env.CODEACT_MEMORY_MB) || DEFAULT_MEMORY_MB;

    const config = loadAirtableGatewayConfig();
    const gateway =
      config === null
        ? null
        : new AirtableReadOnlyGateway({ config, deadline: Date.now() + timeoutMs });

    try {
      return await executePython({
        sandbox,
        code,
        gateway,
        limits: { timeoutMs, memoryMb },
        abortSignal: ctx.abortSignal,
      });
    } catch (error) {
      if (error instanceof CodeEnvironmentError) throw new Error(error.message);
      throw error;
    }
  },
  toModelOutput(output) {
    return { type: "json", value: toModelView(output as ExecutionOutput) };
  },
});
