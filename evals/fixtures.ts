import { fileURLToPath } from "node:url";

/** Absolute paths to the eval fixture documents. */
export const INVOICE_PDF = fileURLToPath(new URL("./fixtures/factura-demo.pdf", import.meta.url));

/** Same invoice, but the document carries no invoice number. */
export const INVOICE_PDF_WITHOUT_NUMBER = fileURLToPath(
  new URL("./fixtures/factura-sin-numero.pdf", import.meta.url),
);

export const PDF_MEDIA_TYPE = "application/pdf";
