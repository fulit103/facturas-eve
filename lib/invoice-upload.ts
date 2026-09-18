const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

export const INVOICE_FILE_ACCEPT =
  ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

export function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index === -1) return "";
  return fileName.slice(index + 1).toLowerCase();
}

export function inferInvoiceMediaType(fileName: string, declaredType = ""): string | null {
  const normalized = declaredType.trim().toLowerCase();
  if (normalized === "application/pdf" || normalized === "image/jpeg" || normalized === "image/png") {
    return normalized;
  }

  const fromExtension = EXTENSION_MEDIA_TYPES[extensionOf(fileName)];
  return fromExtension ?? null;
}

export function isInvoiceUpload(file: File): boolean {
  return inferInvoiceMediaType(file.name, file.type) !== null;
}

/**
 * eve only stages byte-backed file parts (data URLs) or fetchable http(s)
 * URLs. A leftover `blob:` URL is renderer-local and arrives at the model as
 * invalid image data.
 */
export function isSendableAttachmentData(url: string): boolean {
  return url.startsWith("data:") || /^https?:\/\//u.test(url);
}
