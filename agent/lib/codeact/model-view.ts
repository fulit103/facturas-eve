import type { ExecutionOutput } from "#lib/codeact/executor.js";

/**
 * What the model sees: results, errors, read metadata, and chart references.
 * Chart bytes stay out of the context; the UI and Telegram get them from the
 * full tool result.
 */
export function toModelView(output: ExecutionOutput): Record<string, unknown> {
  const view: Record<string, unknown> = {
    ok: output.ok,
    result: output.result,
    stdout: output.stdout === "" ? undefined : output.stdout,
    error:
      output.error === null
        ? undefined
        : {
            ...output.error,
            hint: "Corregí el código y volvé a llamar execute_python. Las variables previas siguen disponibles.",
          },
    charts: output.charts.map((chart) => ({
      id: chart.id,
      title: chart.title,
      shownToUser: chart.dataBase64 !== null,
    })),
    dataReads: output.dataReads,
    variables: output.variables,
    notPersisted: output.notPersisted.length === 0 ? undefined : output.notPersisted,
    warnings: output.warnings.length === 0 ? undefined : output.warnings,
    durationMs: output.durationMs,
  };
  // Tool outputs must be plain JSON: drop the empty optional keys.
  for (const key of Object.keys(view)) {
    if (view[key] === undefined) delete view[key];
  }
  return view;
}
