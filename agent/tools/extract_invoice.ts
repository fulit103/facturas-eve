import { defineTool } from "eve/tools";
import { z } from "zod";

import { ATTACHMENTS_DIR, AttachmentError, resolveAttachment } from "#lib/attachments.js";
import { buildIdempotencyKey, sha256Hex } from "#lib/idempotency.js";
import {
  CRITICAL_FIELD_LABELS,
  InvoiceSchema,
  findMissingCriticalFields,
} from "#lib/invoice-schema.js";
import { DocumentParseError, extractInvoiceFromDocument } from "#lib/llamaindex.js";

/**
 * Reads an invoice attachment and returns structured data. It never writes to
 * Airtable — `save_invoice` owns persistence, so a failed save can be retried
 * without paying for extraction again.
 */

const outputSchema = z.object({
  invoice: InvoiceSchema,
  /** Stable key for duplicate detection; pass it straight to `save_invoice`. */
  idempotencyKey: z.string(),
  /** Critical fields the document did not contain. Ask the user for these. */
  missingCriticalFields: z.array(z.string()),
  pageCount: z.number().int(),
});

export default defineTool({
  description: [
    "Extract structured invoice data from an attachment the user sent (PDF, JPG, or PNG).",
    `Attachments are staged under ${ATTACHMENTS_DIR}, often as ${ATTACHMENTS_DIR}/<id>/<filename>.`,
    "Always omit filePath unless you know the exact filename. Never pass the directory path",
    `or a hash folder (${ATTACHMENTS_DIR} or ${ATTACHMENTS_DIR}/<id>); omit filePath to read the latest file.`,
    "Returns the invoice fields, an idempotencyKey to pass to save_invoice, and the list of",
    "critical fields the document did not contain. Does not save anything.",
  ].join(" "),
  inputSchema: z.object({
    filePath: z
      .string()
      .optional()
      .describe(
        `Sandbox path of the attachment, e.g. ${ATTACHMENTS_DIR}/factura.pdf. Omit to use the most recently received file.`,
      ),
  }),
  outputSchema,
  label: {
    start: ({ filePath }) =>
      filePath === undefined ? "Leyendo la factura" : `Leyendo ${filePath.split("/").at(-1)}`,
  },
  async execute({ filePath }, ctx) {
    const sandbox = await ctx.getSandbox();

    let attachment;
    try {
      attachment = await resolveAttachment(sandbox, filePath);
    } catch (error) {
      if (error instanceof AttachmentError) throw new Error(error.userMessage);
      throw error;
    }

    let extraction;
    try {
      extraction = await extractInvoiceFromDocument({
        bytes: attachment.bytes,
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
      });
    } catch (error) {
      if (error instanceof DocumentParseError) throw new Error(error.userMessage);
      throw error;
    }

    const idempotencyKey = buildIdempotencyKey({ contentHash: sha256Hex(attachment.bytes) });
    const missing = findMissingCriticalFields(extraction.invoice).map(
      (field) => CRITICAL_FIELD_LABELS[field],
    );

    return {
      invoice: extraction.invoice,
      idempotencyKey,
      missingCriticalFields: missing,
      pageCount: extraction.pageCount,
    };
  },
});
