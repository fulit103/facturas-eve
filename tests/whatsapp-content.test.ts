import { describe, expect, it, vi } from "vitest";

import { MAX_UPLOAD_BYTES } from "#lib/attachments.js";
import {
  type IncomingAttachment,
  messageToInvoiceContent,
} from "#lib/whatsapp-content.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n");
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const MP4_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

function attachment(overrides: Partial<IncomingAttachment> = {}): IncomingAttachment {
  return {
    name: "factura.pdf",
    mimeType: "application/pdf",
    fetchData: async () => Buffer.from(PDF_BYTES),
    ...overrides,
  };
}

describe("messageToInvoiceContent", () => {
  it("devuelve el texto pelado cuando no hay adjuntos", async () => {
    expect(await messageToInvoiceContent({ text: "  hola  " })).toBe("hola");
    expect(await messageToInvoiceContent({})).toBe("");
  });

  it("descarga el adjunto y lo manda como parte de archivo", async () => {
    const fetchData = vi.fn(async () => Buffer.from(PDF_BYTES));

    const content = await messageToInvoiceContent({
      text: "guarda esta factura",
      attachments: [attachment({ fetchData })],
    });

    expect(fetchData).toHaveBeenCalledOnce();
    expect(content).toEqual([
      { type: "text", text: "guarda esta factura" },
      {
        type: "file",
        data: PDF_BYTES,
        mediaType: "application/pdf",
        filename: "factura.pdf",
      },
    ]);
  });

  it("omite la parte de texto cuando la factura llega sin mensaje", async () => {
    const content = await messageToInvoiceContent({ attachments: [attachment()] });

    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "file" });
  });

  it("nombra la foto sin nombre con la extensión de sus bytes reales", async () => {
    const content = await messageToInvoiceContent({
      attachments: [
        attachment({
          name: undefined,
          mimeType: "image/jpeg",
          fetchData: async () => Buffer.from(JPEG_BYTES),
        }),
      ],
    });

    expect(content[0]).toMatchObject({
      filename: "whatsapp-adjunto.jpg",
      mediaType: "image/jpeg",
    });
  });

  it("corrige la extensión cuando no coincide con los bytes", async () => {
    const content = await messageToInvoiceContent({
      attachments: [
        attachment({ name: "factura", fetchData: async () => Buffer.from(JPEG_BYTES) }),
      ],
    });

    expect(content[0]).toMatchObject({ filename: "factura.jpg", mediaType: "image/jpeg" });
  });

  it("rechaza un tipo no permitido y le explica al modelo por qué", async () => {
    const content = await messageToInvoiceContent({
      attachments: [
        attachment({
          name: "video.mp4",
          mimeType: "video/mp4",
          fetchData: async () => Buffer.from(MP4_BYTES),
        }),
      ],
    });

    expect(content[0]).toMatchObject({ type: "text" });
    expect((content[0] as { text: string }).text).toContain("video.mp4");
    expect((content[0] as { text: string }).text).toContain("PDF, JPG o PNG");
  });

  it("descarta por tamaño declarado sin llegar a descargar el archivo", async () => {
    const fetchData = vi.fn(async () => Buffer.from(PDF_BYTES));

    const content = await messageToInvoiceContent({
      attachments: [attachment({ size: MAX_UPLOAD_BYTES + 1, fetchData })],
    });

    expect(fetchData).not.toHaveBeenCalled();
    expect((content[0] as { text: string }).text).toContain("máximo permitido");
  });

  it("descarta por tamaño real cuando el declarado mentía", async () => {
    const content = await messageToInvoiceContent({
      attachments: [
        attachment({
          size: 10,
          fetchData: async () => Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x25),
        }),
      ],
    });

    expect((content[0] as { text: string }).text).toContain("máximo permitido");
  });

  it("avisa cuando la descarga falla en vez de perder el adjunto", async () => {
    const content = await messageToInvoiceContent({
      attachments: [
        attachment({
          fetchData: async () => {
            throw new Error("kapso 503");
          },
        }),
      ],
    });

    expect((content[0] as { text: string }).text).toContain("reenvíe");
  });

  it("avisa cuando el adjunto llega sin contenido descargable", async () => {
    const content = await messageToInvoiceContent({
      attachments: [attachment({ fetchData: undefined, url: undefined })],
    });

    expect((content[0] as { text: string }).text).toContain("reenvíe");
  });

  it("avisa cuando el archivo llega vacío", async () => {
    const content = await messageToInvoiceContent({
      attachments: [attachment({ fetchData: async () => Buffer.alloc(0) })],
    });

    expect((content[0] as { text: string }).text).toContain("vacío");
  });
});
