import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { INVOICE_PDF, PDF_MEDIA_TYPE } from "#evals/fixtures.js";

export default defineEval({
  description: "A PDF invoice triggers extract_invoice and the reply reports what was found.",
  async test(t) {
    const session = await t.session();
    const turn = await session.sendFile("¿Qué dice esta factura?", INVOICE_PDF, PDF_MEDIA_TYPE);

    t.succeeded();
    t.calledTool("extract_invoice", { count: 1 });
    t.check(turn.message, includes(/FE-10234/u));
    t.check(turn.message, includes(/PROVEEDOR DEMO/iu));
  },
});
