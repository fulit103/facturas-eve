import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { INVOICE_PDF, PDF_MEDIA_TYPE } from "#evals/fixtures.js";

export default defineEval({
  description: "Sending the same invoice twice reports a duplicate instead of inserting again.",
  async test(t) {
    const session = await t.session();

    await session.sendFile("Guarda esta factura", INVOICE_PDF, PDF_MEDIA_TYPE);
    const second = await session.sendFile("Guarda esta factura", INVOICE_PDF, PDF_MEDIA_TYPE);

    t.succeeded();
    t.check(second.message, includes(/ya estaba registrada/iu));
    t.judge.autoevals.closedQA(
      "The final reply states the invoice was already registered and does not claim a new record was created.",
    );
  },
});
