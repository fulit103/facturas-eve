import { defineEval } from "eve/evals";

import { INVOICE_PDF_WITHOUT_NUMBER, PDF_MEDIA_TYPE } from "#evals/fixtures.js";

export default defineEval({
  description:
    "When the document carries no invoice number, the agent asks for it instead of saving.",
  async test(t) {
    const session = await t.session();
    const turn = await session.sendFile(
      "Registra esta factura",
      INVOICE_PDF_WITHOUT_NUMBER,
      PDF_MEDIA_TYPE,
    );

    t.succeeded();
    t.calledTool("extract_invoice", { count: 1 });
    // Nothing is written while a critical field is missing.
    t.calledTool("save_invoice", { count: 0 });
    t.judge.autoevals.closedQA(
      "The reply asks the user for the invoice number, and does not claim the invoice was registered.",
    );
  },
});
