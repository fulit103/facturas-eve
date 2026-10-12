import { defineEval } from "eve/evals";

function hasChart(output: unknown): boolean {
  const charts = (output as { charts?: unknown } | null)?.charts;
  return Array.isArray(charts) && charts.length > 0;
}

/**
 * Needs a real Airtable base (AIRTABLE_BASE_ID + a read token).
 */
export default defineEval({
  description: "A monthly-total chart, then a follow-up that filters a period reusing session data.",
  async test(t) {
    const first = await t.send("¿Cómo cambia el total facturado por mes? Mostrame un gráfico.");
    first.succeeded();
    first.calledTool("execute_js", {
      output: hasChart,
      count: (count) => count >= 1,
    });

    const second = await t.send("Ahora filtrá solo los últimos tres meses y volvé a graficar.");
    second.succeeded();
    second.calledTool("execute_js", {
      output: hasChart,
      count: (count) => count >= 1,
    });
    // The follow-up should reuse the rows kept in store instead of re-reading Airtable.
    second.calledTool("execute_js", { input: { code: /store\./u } });
    t.judge.autoevals.closedQA(
      "The second reply describes the filtered period it used (dates or month names) and comments on the chart without inventing figures.",
    );
  },
});
