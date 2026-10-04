"use client";

import { AlertTriangleIcon, DatabaseIcon } from "lucide-react";
import { CodeBlock } from "@/components/ai-elements/code-block";

/**
 * Web Chat rendering for `execute_python`. The tool result carries the chart
 * PNGs (base64); the model only receives references to them, so the charts
 * shown here never enter the model's context.
 */

type Chart = {
  readonly id: string;
  readonly title: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly dataBase64: string | null;
};

type TableResult = {
  readonly kind: "table";
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly total_rows: number;
  readonly truncated: boolean;
};

type TextResult = { readonly kind: "text"; readonly text: string };

type DataRead = {
  readonly table: string;
  readonly records: number;
  readonly complete: boolean;
};

type ExecutionOutput = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly result: TableResult | TextResult | null;
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly line: number | null;
    readonly traceback: string;
  } | null;
  readonly charts: readonly Chart[];
  readonly dataReads: readonly DataRead[];
};

function asExecutionOutput(output: unknown): ExecutionOutput | null {
  if (typeof output !== "object" || output === null) return null;
  const candidate = output as Partial<ExecutionOutput>;
  return typeof candidate.ok === "boolean" && Array.isArray(candidate.charts)
    ? (candidate as ExecutionOutput)
    : null;
}

const numberFormat = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return numberFormat.format(value);
  return String(value);
}

export function ExecutePythonContent({
  input,
  output,
  errorText,
}: {
  readonly input: unknown;
  readonly output: unknown;
  readonly errorText?: string;
}) {
  const code =
    typeof input === "object" && input !== null && typeof (input as { code?: unknown }).code === "string"
      ? (input as { code: string }).code
      : "";
  const result = asExecutionOutput(output);

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md bg-muted/50">
        <span className="block px-3 pt-3 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
          Python
        </span>
        <CodeBlock className="border-0 bg-transparent text-xs" code={code} language="python" />
      </div>

      {errorText ? (
        <p className="rounded-md bg-destructive/10 p-3 text-destructive text-xs">{errorText}</p>
      ) : null}

      {result?.dataReads.length ? (
        <ul className="space-y-1 text-muted-foreground text-xs">
          {result.dataReads.map((read, index) => (
            <li className="flex items-center gap-1.5" key={`${read.table}-${index}`}>
              <DatabaseIcon className="size-3.5" />
              {read.table}: {numberFormat.format(read.records)} registros
              {read.complete ? "" : " (muestra parcial)"}
            </li>
          ))}
        </ul>
      ) : null}

      {result?.stdout ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          {result.stdout.trimEnd()}
        </pre>
      ) : null}

      {result?.result?.kind === "table" ? <ResultTable table={result.result} /> : null}
      {result?.result?.kind === "text" ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs">
          {result.result.text}
        </pre>
      ) : null}

      {result?.error ? (
        <div className="space-y-1 rounded-md bg-destructive/10 p-3 text-destructive text-xs">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangleIcon className="size-3.5" />
            {result.error.type}
            {result.error.line === null ? "" : ` (línea ${result.error.line})`}: {result.error.message}
          </p>
          {result.error.traceback ? (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono opacity-80">
              {result.error.traceback.trimEnd()}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ResultTable({ table }: { readonly table: TableResult }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            {table.columns.map((column) => (
              <th className="px-2 py-1.5 text-left font-medium" key={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr className="border-t" key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  className={typeof cell === "number" ? "px-2 py-1 text-right tabular-nums" : "px-2 py-1"}
                  key={cellIndex}
                >
                  {formatCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.truncated ? (
        <p className="border-t px-2 py-1.5 text-muted-foreground text-xs">
          Mostrando {table.rows.length} de {numberFormat.format(table.total_rows)} filas.
        </p>
      ) : null}
    </div>
  );
}

/** Charts render outside the collapsible tool card so the user sees them right away. */
export function ExecutePythonCharts({ output }: { readonly output: unknown }) {
  const result = asExecutionOutput(output);
  const charts = result?.charts.filter((chart) => chart.dataBase64) ?? [];
  if (charts.length === 0) return null;

  return (
    <div className="space-y-3">
      {charts.map((chart) => (
        <figure className="overflow-hidden rounded-lg border bg-white" key={chart.id}>
          {/* biome-ignore lint/performance/noImgElement: inline data URL from the tool result */}
          <img
            alt={chart.title}
            className="h-auto w-full"
            height={chart.height}
            src={`data:${chart.mediaType};base64,${chart.dataBase64}`}
            width={chart.width}
          />
          <figcaption className="border-t px-3 py-2 text-muted-foreground text-xs">{chart.title}</figcaption>
        </figure>
      ))}
    </div>
  );
}
