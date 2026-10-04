import { defineEval } from "eve/evals";

/**
 * Needs a real Airtable base (AIRTABLE_BASE_ID + a token with data.records:read
 * and schema.bases:read).
 */
export default defineEval({
  description: "A per-category count discovers the schema and computes the answer with execute_js.",
  async test(t) {
    const turn = await t.send("¿Cuántas facturas hay registradas por proveedor?");

    t.succeeded();
    turn.calledTool("execute_js", {
      input: { code: /listTables|describeTable/u },
      count: (count) => count >= 1,
    });
    turn.calledTool("execute_js", {
      input: { code: /airtable\.records\(/u },
      count: (count) => count >= 1,
    });
    t.notCalledTool("extract_invoice");
    t.notCalledTool("save_invoice");
    t.judge.autoevals.closedQA(
      "The reply, in Spanish, gives a number of invoices for each supplier and does not invent suppliers or totals that were not computed.",
    );
  },
});
