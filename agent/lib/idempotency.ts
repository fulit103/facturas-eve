import { createHash } from "node:crypto";

/**
 * Idempotency keys for invoice registration.
 *
 * Telegram's own `file_unique_id` is not surfaced to tools by eve's native
 * Telegram channel — attachments reach the agent as staged sandbox files — so
 * the content hash is the primary key here. It is strictly more reliable for
 * this purpose: the same bytes always produce the same key, whether the repeat
 * comes from a duplicated webhook or from the user resending the file.
 */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Builds the stable key stored in Airtable's `Idempotency Key` column.
 * A provider-supplied file id wins when one is available.
 */
export function buildIdempotencyKey(input: {
  providerFileId?: string | null;
  contentHash: string;
}): string {
  const providerFileId = input.providerFileId?.trim();
  if (providerFileId !== undefined && providerFileId !== "") {
    return `telegram-file:${providerFileId}`;
  }
  return `sha256:${input.contentHash}`;
}

/**
 * Secondary duplicate check: the same supplier cannot issue the same invoice
 * number twice. Returns `null` when either half is missing.
 */
export function buildBusinessKey(
  supplierTaxId: string | null,
  invoiceNumber: string | null,
): string | null {
  if (supplierTaxId === null || invoiceNumber === null) return null;
  const supplier = supplierTaxId.replace(/[\s.-]/gu, "").toLowerCase();
  const number = invoiceNumber.replace(/\s/gu, "").toLowerCase();
  if (supplier === "" || number === "") return null;
  return `${supplier}:${number}`;
}
