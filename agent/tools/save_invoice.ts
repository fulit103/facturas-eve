import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  AirtableError,
  AirtableInvoicesClient,
  recordHasAttachment,
  type AirtableRecord,
} from "#lib/airtable.js";
import { type AttachmentSandbox, resolveAttachment } from "#lib/attachments.js";
import { sha256Hex } from "#lib/idempotency.js";
import {
  CRITICAL_FIELD_LABELS,
  InvoiceSchema,
  findMissingCriticalFields,
} from "#lib/invoice-schema.js";

/**
 * Persists an already-extracted invoice as one Airtable row, then attaches the
 * original PDF/JPG/PNG from the sandbox. It never re-parses the document: when
 * Airtable fails, the agent can retry this call alone with the same arguments.
 * Registration is idempotent — an existing `idempotencyKey`, or the same
 * supplier tax id plus invoice number, returns the existing record instead of
 * inserting a second row. A duplicate with an empty Attachment cell still
 * receives the file (covers create-then-upload retries).
 */

const outputSchema = z.object({
  success: z.boolean(),
  created: z.boolean(),
  duplicate: z.boolean(),
  attached: z.boolean(),
  recordId: z.string().nullable(),
  /** Present when the save was refused for missing critical fields. */
  missingCriticalFields: z.array(z.string()).optional(),
  message: z.string(),
});

type SaveOutput = z.infer<typeof outputSchema>;

export default defineTool({
  description: [
    "Save an extracted invoice as a row in Airtable and attach the original PDF, JPG, or PNG.",
    "Call it only after extract_invoice, with the invoice object and idempotencyKey it returned",
    "(apply any corrections the user gave). Idempotent: a repeated invoice returns the existing",
    "record instead of creating a duplicate. If the row exists but has no Attachment, this call",
    "uploads the matching sandbox file. attached=false means the row was saved without the file.",
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
        attached: false,
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
        return await attachAndResult({
          client,
          record: byKey,
          created: false,
          ctx,
          idempotencyKey,
        });
      }

      const byBusinessKey = await client.findByBusinessKey(
        invoice.supplierTaxId,
        invoice.invoiceNumber,
      );
      if (byBusinessKey !== null) {
        return await attachAndResult({
          client,
          record: byBusinessKey,
          created: false,
          ctx,
          idempotencyKey,
        });
      }

      const record = await client.createInvoiceRecord({
        invoice,
        idempotencyKey,
        telegramUserId,
        telegramChatId,
      });

      return await attachAndResult({
        client,
        record,
        created: true,
        ctx,
        idempotencyKey,
      });
    } catch (error) {
      throw asUserFacing(error);
    }
  },
});

type AttachOutcome =
  | { attached: true }
  | { attached: false; reason: "too_large" | "no_file" };

async function attachAndResult(input: {
  client: AirtableInvoicesClient;
  record: AirtableRecord;
  created: boolean;
  ctx: { getSandbox?: () => PromiseLike<AttachmentSandbox> };
  idempotencyKey: string;
}): Promise<SaveOutput> {
  const outcome = await attachIfNeeded(input);

  if (!input.created) {
    return duplicateResult(input.record.id, outcome.attached);
  }

  return {
    success: true,
    created: true,
    duplicate: false,
    attached: outcome.attached,
    recordId: input.record.id,
    message: createdMessage(outcome),
  };
}

function createdMessage(outcome: AttachOutcome): string {
  if (outcome.attached) return "Factura registrada en Airtable.";
  if (outcome.reason === "too_large") {
    return "Factura registrada en Airtable. El archivo pesa más de 5 MB y no pude adjuntarlo.";
  }
  return "Factura registrada en Airtable. No pude adjuntar el archivo.";
}

async function attachIfNeeded(input: {
  client: AirtableInvoicesClient;
  record: AirtableRecord;
  ctx: { getSandbox?: () => PromiseLike<AttachmentSandbox> };
  idempotencyKey: string;
}): Promise<AttachOutcome> {
  if (recordHasAttachment(input.record)) return { attached: true };

  const attachment = await resolveMatchingAttachment(input.ctx, input.idempotencyKey);
  if (attachment === null) return { attached: false, reason: "no_file" };

  const result = await input.client.uploadAttachment({
    recordId: input.record.id,
    bytes: attachment.bytes,
    fileName: attachment.fileName,
    contentType: attachment.mediaType,
  });

  if (result.attached) return { attached: true };
  return { attached: false, reason: "too_large" };
}

async function resolveMatchingAttachment(
  ctx: { getSandbox?: () => PromiseLike<AttachmentSandbox> },
  idempotencyKey: string,
) {
  if (typeof ctx.getSandbox !== "function") return null;

  let attachment;
  try {
    attachment = await resolveAttachment(await ctx.getSandbox());
  } catch {
    // Missing sandbox, missing file, or a path error: keep the row anyway.
    return null;
  }

  if (!attachmentMatchesIdempotencyKey(attachment.bytes, idempotencyKey)) {
    return null;
  }

  return attachment;
}

function attachmentMatchesIdempotencyKey(bytes: Uint8Array, idempotencyKey: string): boolean {
  const prefix = "sha256:";
  if (!idempotencyKey.startsWith(prefix)) return false;
  return sha256Hex(bytes) === idempotencyKey.slice(prefix.length);
}

function duplicateResult(recordId: string, attached: boolean): SaveOutput {
  return {
    success: true,
    created: false,
    duplicate: true,
    attached,
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
