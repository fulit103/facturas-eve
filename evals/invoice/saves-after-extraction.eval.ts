import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { INVOICE_PDF, PDF_MEDIA_TYPE } from "#evals/fixtures.js";

export default defineEval({
  description: "A valid extraction is followed by save_invoice and a registration confirmation.",
  async test(t) {
    const session = await t.session();
    const turn = await session.sendFile("Guarda esta factura", INVOICE_PDF, PDF_MEDIA_TYPE);

    t.succeeded();
    t.calledTool("extract_invoice", { count: 1 });
    t.calledTool("save_invoice", { count: 1 });
    t.check(turn.message, includes(/Factura registrada/iu));
    t.judge.autoevals.closedQA(
      "The reply confirms the invoice was registered and lists the supplier, invoice number and total.",
    );
  },
});
