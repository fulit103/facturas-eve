import { defineEval } from "eve/evals";

import { INVOICE_PDF } from "#evals/fixtures.js";

export default defineEval({
  description: "A file that is not a PDF or image is refused before any parsing happens.",
  async test(t) {
    const session = await t.session();
    // Correct PDF bytes, but declared and named as an executable.
    const turn = await session.sendFile(
      "Guarda esta factura",
      INVOICE_PDF,
      "application/octet-stream",
    );

    t.succeeded();
    t.calledTool("save_invoice", { count: 0 });
    t.judge.autoevals.closedQA(
      "The reply explains that only PDF, JPG or PNG invoices are accepted, and does not claim anything was registered.",
    );
  },
});
