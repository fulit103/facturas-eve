"use client";

import { AlertTriangleIcon, DatabaseIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { VisualizationSpec } from "vega-embed";
import { ES_CO_FORMAT_LOCALE, ES_TIME_FORMAT_LOCALE } from "@/agent/lib/codeact/chart-locale";
import { CodeBlock } from "@/components/ai-elements/code-block";

/**
 * Web Chat rendering for `execute_js`. The tool result carries each chart's
 * Vega-Lite spec (with its data); the model only receives references, so the
 * charts drawn here never enter the model's context.
 */

type Chart = {
  readonly id: string;
  readonly title: string;
  readonly spec: Record<string, unknown>;
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
    readonly stack: string;
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

export function ExecuteJsContent({
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
          JavaScript
        </span>
        <CodeBlock className="border-0 bg-transparent text-xs" code={code} language="javascript" />
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
          {result.error.stack ? (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono opacity-80">
              {result.error.stack.trimEnd()}
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
export function ExecuteJsCharts({ output }: { readonly output: unknown }) {
  const result = asExecutionOutput(output);
  const charts = result?.charts ?? [];
  if (charts.length === 0) return null;

  return (
    <div className="space-y-3">
      {charts.map((chart) => (
        <VegaChart chart={chart} key={chart.id} />
      ))}
    </div>
  );
}

function VegaChart({ chart }: { readonly chart: Chart }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    let finalize: (() => void) | undefined;
    let cancelled = false;

    // Single-view charts stretch to the message width; layouts keep their own sizes.
    const spec = (
      typeof chart.spec.width === "number"
        ? { ...chart.spec, width: "container", autosize: { type: "fit", contains: "padding" } }
        : chart.spec
    ) as VisualizationSpec;

    // vega-embed is browser-only and heavy: load it when a chart appears.
    import("vega-embed")
      .then(({ default: embed }) =>
        embed(element, spec, {
          actions: { export: true, source: false, compiled: false, editor: false },
          renderer: "svg",
          formatLocale: ES_CO_FORMAT_LOCALE as unknown as Record<string, unknown>,
          timeFormatLocale: ES_TIME_FORMAT_LOCALE as unknown as Record<string, unknown>,
          i18n: { PNG_ACTION: "Descargar PNG", SVG_ACTION: "Descargar SVG" },
        }),
      )
      .then((result) => {
        if (cancelled) result.finalize();
        else finalize = result.finalize;
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailed(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [chart]);

  return (
    <figure className="overflow-hidden rounded-lg border bg-white p-3 text-black">
      {failed === null ? (
        <div className="w-full" ref={container} />
      ) : (
        <p className="text-destructive text-xs">No pude dibujar el gráfico: {failed}</p>
      )}
      <figcaption className="sr-only">{chart.title}</figcaption>
    </figure>
  );
}
