/**
 * Conversión de un mensaje entrante de WhatsApp (Chat SDK / Kapso) al
 * `UserContent` que espera eve.
 *
 * eve trae `messageToUserContent` en `eve/channels/chat-sdk`, pero solo incluye
 * los adjuntos que llegan con `url` pública. Kapso expone la media de WhatsApp
 * de dos formas: a veces con una `url` espejada, y siempre (cuando hay
 * `mediaId`) con un `fetchData()` que descarga los bytes autenticado con la
 * `KAPSO_API_KEY`. Como una factura es justamente el adjunto, acá se descargan
 * los bytes dentro del webhook y se mandan como `FilePart`, que es lo que eve
 * stagea en `/workspace/attachments` para las tools.
 *
 * Este módulo es la primera compuerta de validación del canal, equivalente al
 * `uploadPolicy` de Telegram: corta tipos no permitidos y archivos grandes
 * antes de que lleguen al modelo. `extract_invoice` vuelve a verificar los
 * bytes reales más adelante.
 */

import {
  ALLOWED_MEDIA_TYPES,
  MAX_UPLOAD_BYTES,
  type AllowedMediaType,
  sniffMediaType,
} from "#lib/attachments.js";

/** Parte de archivo del `UserContent` de eve (AI SDK). */
export interface FileContentPart {
  type: "file";
  data: Uint8Array;
  mediaType: AllowedMediaType;
  filename: string;
}

export interface TextContentPart {
  type: "text";
  text: string;
}

export type WhatsAppContentPart = TextContentPart | FileContentPart;

/** El subconjunto del `Attachment` de Chat SDK que necesita este módulo. */
export interface IncomingAttachment {
  name?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  data?: { byteLength: number } | Uint8Array | Buffer | Blob;
  fetchData?: () => Promise<Buffer | ArrayBuffer>;
}

/** El subconjunto del `Message` de Chat SDK que necesita este módulo. */
export interface IncomingMessage {
  text?: string;
  attachments?: IncomingAttachment[];
}

const EXTENSIONS: Record<AllowedMediaType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

const MAX_MEGABYTES = MAX_UPLOAD_BYTES / (1024 * 1024);

function describe(attachment: IncomingAttachment): string {
  return attachment.name ?? attachment.mimeType ?? "el archivo";
}

/**
 * Nombre con la extensión que corresponde a los bytes reales. WhatsApp manda
 * las fotos sin nombre, y un nombre con extensión equivocada haría fallar la
 * validación de `extract_invoice`, así que la extensión sale del sniff.
 */
function fileNameFor(attachment: IncomingAttachment, mediaType: AllowedMediaType): string {
  const extension = EXTENSIONS[mediaType];
  const name = attachment.name?.trim();
  if (name !== undefined && name !== "") {
    return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
  }
  return `whatsapp-adjunto.${extension}`;
}

function toBytes(payload: Buffer | ArrayBuffer): Uint8Array {
  return payload instanceof ArrayBuffer ? new Uint8Array(payload) : new Uint8Array(payload);
}

/**
 * Descarga y valida un adjunto. Devuelve la parte de archivo, o un texto para
 * el modelo explicando por qué el archivo no se pudo usar: el agente le
 * transmite ese motivo al usuario en vez de quedarse callado.
 */
async function attachmentToPart(
  attachment: IncomingAttachment,
): Promise<FileContentPart | TextContentPart> {
  if (attachment.size !== undefined && attachment.size > MAX_UPLOAD_BYTES) {
    const megabytes = (attachment.size / (1024 * 1024)).toFixed(1);
    return {
      type: "text",
      text: `[El usuario adjuntó ${describe(attachment)}, que pesa ${megabytes} MB. El máximo permitido es ${MAX_MEGABYTES} MB, así que no pude leerlo.]`,
    };
  }

  if (attachment.fetchData === undefined) {
    return {
      type: "text",
      text: `[El usuario adjuntó ${describe(attachment)}, pero WhatsApp no dejó disponible el contenido del archivo. Pedile que lo reenvíe.]`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = toBytes(await attachment.fetchData());
  } catch {
    return {
      type: "text",
      text: `[El usuario adjuntó ${describe(attachment)}, pero la descarga desde WhatsApp falló. Pedile que lo reenvíe.]`,
    };
  }

  if (bytes.length === 0) {
    return {
      type: "text",
      text: `[El usuario adjuntó ${describe(attachment)}, pero llegó vacío. Pedile que lo reenvíe.]`,
    };
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    const megabytes = (bytes.length / (1024 * 1024)).toFixed(1);
    return {
      type: "text",
      text: `[El usuario adjuntó ${describe(attachment)}, que pesa ${megabytes} MB. El máximo permitido es ${MAX_MEGABYTES} MB, así que no pude leerlo.]`,
    };
  }

  const mediaType = sniffMediaType(bytes);
  if (mediaType === null) {
    return {
      type: "text",
      text: `[El usuario adjuntó ${describe(attachment)}, que no es ${ALLOWED_MEDIA_TYPES.join(", ")}. Pedile la factura en PDF, JPG o PNG.]`,
    };
  }

  return {
    type: "file",
    data: bytes,
    mediaType,
    filename: fileNameFor(attachment, mediaType),
  };
}

/**
 * Convierte el mensaje entrante en el input del turno de eve. Devuelve el texto
 * pelado cuando no hay adjuntos, para no inflar el contexto con un array de una
 * sola parte.
 */
export async function messageToInvoiceContent(
  message: IncomingMessage,
): Promise<string | WhatsAppContentPart[]> {
  const attachments = message.attachments ?? [];
  const text = message.text?.trim() ?? "";

  if (attachments.length === 0) return text;

  const parts: WhatsAppContentPart[] = [];
  if (text !== "") parts.push({ type: "text", text });

  for (const attachment of attachments) {
    parts.push(await attachmentToPart(attachment));
  }

  return parts;
}
