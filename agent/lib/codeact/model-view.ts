import type { ExecutionOutput } from "#lib/codeact/js-engine.js";

/**
 * What the model sees: results, errors, read metadata, and chart references.
 * Chart specs (with their data) stay out of the context; the UI and Telegram
 * render them from the full tool result.
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
            hint: "Corregí el código y volvé a llamar execute_js. Lo guardado en store sigue disponible.",
          },
    charts: output.charts.map((chart) => ({ id: chart.id, title: chart.title, shownToUser: true })),
    dataReads: output.dataReads,
    store: output.variables,
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
