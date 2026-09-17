/**
 * Attachment validation and retrieval.
 *
 * eve stages inbound channel attachments into the agent sandbox under
 * `/workspace/attachments` before the first model step (see the "Inbound
 * attachments" section of the eve sandbox docs). Tools therefore read the file
 * back out of the sandbox instead of touching the app runtime filesystem.
 */

/** Media types this agent accepts. Enforced again here, after the channel policy. */
export const ALLOWED_MEDIA_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const ATTACHMENTS_DIR = "/workspace/attachments";

const EXTENSION_MEDIA_TYPES: Record<string, AllowedMediaType> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** Raised when a file fails validation; carries a message meant for the user. */
export class AttachmentError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string) {
    super(userMessage);
    this.name = "AttachmentError";
    this.userMessage = userMessage;
  }
}

export function fileNameFromPath(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? path;
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index === -1) return "";
  return fileName.slice(index + 1).toLowerCase();
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Identifies the media type from the file's magic bytes, ignoring the declared
 * extension. Returns `null` when the content is not one of the allowed types.
 */
export function sniffMediaType(bytes: Uint8Array): AllowedMediaType | null {
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"; // %PDF
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

/**
 * Rejects a path that escapes the sandbox attachments directory. Prevents a
 * model-supplied path from reaching `/etc/passwd` or the agent's own files.
 */
export function assertSafeAttachmentPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") {
    throw new AttachmentError("No recibí una ruta de archivo válida.");
  }
  if (trimmed.includes("\0")) {
    throw new AttachmentError("La ruta del archivo no es válida.");
  }

  const absolute = trimmed.startsWith("/") ? trimmed : `${ATTACHMENTS_DIR}/${trimmed}`;

  // Resolve "." and ".." without touching the host filesystem.
  const resolved: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const normalized = `/${resolved.join("/")}`;

  if (normalized !== ATTACHMENTS_DIR && !normalized.startsWith(`${ATTACHMENTS_DIR}/`)) {
    throw new AttachmentError(
      "Solo puedo leer archivos adjuntos de esta conversación, no otras rutas del sistema.",
    );
  }
  return normalized;
}

/**
 * Validates size, extension, and real content type of a staged attachment.
 * Returns the media type derived from the bytes themselves.
 */
export function validateAttachment(input: {
  bytes: Uint8Array;
  fileName: string;
}): AllowedMediaType {
  const { bytes, fileName } = input;

  if (bytes.length === 0) {
    throw new AttachmentError("El archivo llegó vacío. Volvé a enviarlo, por favor.");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    const megabytes = (bytes.length / (1024 * 1024)).toFixed(1);
    throw new AttachmentError(
      `El archivo pesa ${megabytes} MB y el máximo permitido es ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    );
  }

  const extension = extensionOf(fileName);
  const declared = EXTENSION_MEDIA_TYPES[extension];
  if (declared === undefined) {
    throw new AttachmentError(
      `Solo acepto facturas en PDF, JPG o PNG. El archivo "${fileName}" no tiene un formato permitido.`,
    );
  }

  const actual = sniffMediaType(bytes);
  if (actual === null) {
    throw new AttachmentError(
      `El contenido de "${fileName}" no corresponde a un PDF, JPG o PNG válido.`,
    );
  }
  if (actual !== declared) {
    throw new AttachmentError(
      `La extensión de "${fileName}" no coincide con su contenido real. No voy a procesarlo.`,
    );
  }

  return actual;
}

/** The subset of eve's sandbox handle this module needs. */
export interface AttachmentSandbox {
  readBinaryFile(options: { path: string }): PromiseLike<Uint8Array | null>;
  run(options: { command: string }): PromiseLike<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface ResolvedAttachment {
  bytes: Uint8Array;
  fileName: string;
  mediaType: AllowedMediaType;
  path: string;
}

/**
 * Lists staged attachments newest-first. Used when the model calls the tool
 * without naming a path, which happens when it refers to "this invoice".
 */
export async function listStagedAttachments(sandbox: AttachmentSandbox): Promise<string[]> {
  const result = await sandbox.run({
    command: `ls -1t ${ATTACHMENTS_DIR} 2>/dev/null || true`,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Reads a staged attachment and validates it. When `filePath` is omitted, the
 * most recently staged attachment is used.
 */
export async function resolveAttachment(
  sandbox: AttachmentSandbox,
  filePath?: string,
): Promise<ResolvedAttachment> {
  let path: string;

  if (filePath !== undefined && filePath.trim() !== "") {
    path = assertSafeAttachmentPath(filePath);
  } else {
    const entries = await listStagedAttachments(sandbox);
    const newest = entries[0];
    if (newest === undefined) {
      throw new AttachmentError(
        "No encontré ningún archivo adjunto en esta conversación. Enviame la factura como PDF, JPG o PNG.",
      );
    }
    path = assertSafeAttachmentPath(`${ATTACHMENTS_DIR}/${newest}`);
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await sandbox.readBinaryFile({ path });
  } catch {
    // The underlying error can carry sandbox internals; keep it out of the reply.
    bytes = null;
  }
  if (bytes === null) {
    throw new AttachmentError(
      `No pude leer el archivo adjunto en "${path}". Volvé a enviarlo, por favor.`,
    );
  }

  const fileName = fileNameFromPath(path);
  const mediaType = validateAttachment({ bytes, fileName });

  return { bytes, fileName, mediaType, path };
}
