import { defineTool } from "eve/tools";
import { z } from "zod";

import { AirtableError, AirtableInvoicesClient } from "#lib/airtable.js";
import {
  CRITICAL_FIELD_LABELS,
  InvoiceSchema,
  findMissingCriticalFields,
} from "#lib/invoice-schema.js";

/**
 * Persists an already-extracted invoice as one Airtable row.
 *
 * This tool never re-reads the document: when Airtable fails, the agent can
 * retry this call alone with the same arguments. Registration is idempotent —
 * an existing `idempotencyKey`, or the same supplier tax id plus invoice
 * number, returns the existing record instead of inserting a second row.
 */

const outputSchema = z.object({
  success: z.boolean(),
  created: z.boolean(),
  duplicate: z.boolean(),
  recordId: z.string().nullable(),
  /** Present when the save was refused for missing critical fields. */
  missingCriticalFields: z.array(z.string()).optional(),
  message: z.string(),
});

export default defineTool({
  description: [
    "Save an extracted invoice as a row in Airtable. Call it only after extract_invoice,",
    "with the invoice object and idempotencyKey it returned (apply any corrections the user gave).",
    "Idempotent: a repeated invoice returns the existing record instead of creating a duplicate.",
  ].join(" "),
  inputSchema: z.object({
    invoice: InvoiceSchema,
    idempotencyKey: z
      .string()
      .min(1)
      .describe("The idempotencyKey returned by extract_invoice for this document."),
  }),
  outputSchema,
  label: {
    start: ({ invoice }) =>
      `Registrando factura ${invoice.invoiceNumber ?? "sin número"} en Airtable`,
  },
  async execute({ invoice, idempotencyKey }, ctx) {
    const missing = findMissingCriticalFields(invoice);
    if (missing.length > 0) {
      const labels = missing.map((field) => CRITICAL_FIELD_LABELS[field]);
      return {
        success: false,
        created: false,
        duplicate: false,
        recordId: null,
        missingCriticalFields: labels,
        message: `No guardé la factura: faltan datos críticos (${labels.join(", ")}). Pedile al usuario esos valores y volvé a intentarlo.`,
      };
    }

    // Telegram identity, as projected onto session auth by eve's Telegram channel.
    const attributes = ctx.session.auth.current?.attributes as
      | Record<string, unknown>
      | undefined;
    const telegramUserId = toIdString(attributes?.user_id);
    const telegramChatId = toIdString(attributes?.chat_id);

    let client: AirtableInvoicesClient;
    try {
      client = new AirtableInvoicesClient();
    } catch (error) {
      throw asUserFacing(error);
    }

    try {
      const byKey = await client.findByIdempotencyKey(idempotencyKey);
      if (byKey !== null) {
        return duplicateResult(byKey.id);
      }

      const byBusinessKey = await client.findByBusinessKey(
        invoice.supplierTaxId,
        invoice.invoiceNumber,
      );
      if (byBusinessKey !== null) {
        return duplicateResult(byBusinessKey.id);
      }

      const record = await client.createInvoiceRecord({
        invoice,
        idempotencyKey,
        telegramUserId,
        telegramChatId,
      });

      return {
        success: true,
        created: true,
        duplicate: false,
        recordId: record.id,
        message: "Factura registrada en Airtable.",
      };
    } catch (error) {
      throw asUserFacing(error);
    }
  },
});

function duplicateResult(recordId: string) {
  return {
    success: true,
    created: false,
    duplicate: true,
    recordId,
    message: "⚠️ Esta factura ya estaba registrada.",
  };
}

function toIdString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Converts an Airtable failure into an error the agent can relay verbatim. */
function asUserFacing(error: unknown): Error {
  if (error instanceof AirtableError) {
    return new Error(
      `${error.userMessage} Podés pedirme que reintente el guardado sin volver a enviar el archivo.`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
