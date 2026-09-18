import { describe, expect, it, vi } from "vitest";

import {
  ATTACHMENTS_DIR,
  AttachmentError,
  MAX_UPLOAD_BYTES,
  assertSafeAttachmentPath,
  resolveAttachment,
  sniffMediaType,
  validateAttachment,
} from "#lib/attachments.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n");
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // "MZ" DOS header

function fakeSandbox(files: Record<string, Uint8Array>, listing?: string[]) {
  function childrenOf(dir: string): string[] {
    const prefix = `${dir.replace(/\/+$/u, "")}/`;
    const names = new Set<string>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const first = path.slice(prefix.length).split("/")[0];
      if (first !== undefined && first !== "") names.add(first);
    }
    return [...names];
  }

  return {
    readBinaryFile: vi.fn(async ({ path }: { path: string }) => files[path] ?? null),
    run: vi.fn(async ({ command }: { command: string }) => {
      const match = /ls -1t\s+(.+?)\s+2>/u.exec(command);
      const raw = match?.[1] ?? JSON.stringify(ATTACHMENTS_DIR);
      const dir = JSON.parse(raw) as string;
      const isTopLevel = dir.replace(/\/+$/u, "") === ATTACHMENTS_DIR;
      const stdout = (isTopLevel && listing !== undefined ? listing : childrenOf(dir)).join("\n");
      return { exitCode: 0, stdout, stderr: "" };
    }),
  };
}

describe("sniffMediaType", () => {
  it("identifies the allowed formats by their magic bytes", () => {
    expect(sniffMediaType(PDF_BYTES)).toBe("application/pdf");
    expect(sniffMediaType(PNG_BYTES)).toBe("image/png");
    expect(sniffMediaType(JPEG_BYTES)).toBe("image/jpeg");
  });

  it("returns null for anything else", () => {
    expect(sniffMediaType(EXE_BYTES)).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });
});

describe("validateAttachment", () => {
  it("accepts a real PDF", () => {
    expect(validateAttachment({ bytes: PDF_BYTES, fileName: "factura.pdf" })).toBe(
      "application/pdf",
    );
  });

  it("accepts a valid PDF when transport mislabels content as octet-stream", () => {
    // Telegram may download PDFs with Content-Type application/octet-stream.
    // attachments.ts validates by extension and magic bytes, not declared MIME.
    expect(validateAttachment({ bytes: PDF_BYTES, fileName: "comprobanteTigoUne.pdf" })).toBe(
      "application/pdf",
    );
  });

  it("accepts jpg, jpeg and png", () => {
    expect(validateAttachment({ bytes: JPEG_BYTES, fileName: "factura.jpg" })).toBe("image/jpeg");
    expect(validateAttachment({ bytes: JPEG_BYTES, fileName: "FACTURA.JPEG" })).toBe("image/jpeg");
    expect(validateAttachment({ bytes: PNG_BYTES, fileName: "factura.png" })).toBe("image/png");
  });

  it("rejects an .exe attachment", () => {
    expect(() => validateAttachment({ bytes: EXE_BYTES, fileName: "malware.exe" })).toThrow(
      AttachmentError,
    );
    expect(() => validateAttachment({ bytes: EXE_BYTES, fileName: "malware.exe" })).toThrow(
      /PDF, JPG o PNG/u,
    );
  });

  it("rejects an executable disguised with a .pdf extension", () => {
    expect(() => validateAttachment({ bytes: EXE_BYTES, fileName: "factura.pdf" })).toThrow(
      /no corresponde a un PDF/u,
    );
  });

  it("rejects a PNG renamed to .pdf", () => {
    expect(() => validateAttachment({ bytes: PNG_BYTES, fileName: "factura.pdf" })).toThrow(
      /no coincide con su contenido real/u,
    );
  });

  it("rejects other document formats", () => {
    for (const fileName of ["factura.docx", "factura.zip", "factura.sh"]) {
      expect(() => validateAttachment({ bytes: PDF_BYTES, fileName })).toThrow(AttachmentError);
    }
  });

  it("accepts an extensionless name when the bytes are a real invoice file", () => {
    expect(validateAttachment({ bytes: PNG_BYTES, fileName: "d181d53bcaaef2a8" })).toBe(
      "image/png",
    );
  });

  it("rejects an empty file", () => {
    expect(() => validateAttachment({ bytes: new Uint8Array(), fileName: "factura.pdf" })).toThrow(
      /vacío/u,
    );
  });

  it("rejects a file over the size limit", () => {
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    tooBig.set(PDF_BYTES, 0);
    expect(() => validateAttachment({ bytes: tooBig, fileName: "factura.pdf" })).toThrow(
      /máximo permitido/u,
    );
  });
});

describe("assertSafeAttachmentPath", () => {
  it("accepts paths inside the attachments directory", () => {
    expect(assertSafeAttachmentPath(`${ATTACHMENTS_DIR}/factura.pdf`)).toBe(
      `${ATTACHMENTS_DIR}/factura.pdf`,
    );
    expect(assertSafeAttachmentPath("factura.pdf")).toBe(`${ATTACHMENTS_DIR}/factura.pdf`);
  });

  it("rejects traversal outside the attachments directory", () => {
    for (const path of [
      `${ATTACHMENTS_DIR}/../../etc/passwd`,
      "/etc/passwd",
      "../../../secrets.env",
      "/workspace/other/file.pdf",
    ]) {
      expect(() => assertSafeAttachmentPath(path)).toThrow(AttachmentError);
    }
  });

  it("rejects empty and null-byte paths", () => {
    expect(() => assertSafeAttachmentPath("   ")).toThrow(AttachmentError);
    expect(() => assertSafeAttachmentPath("factura\0.pdf")).toThrow(AttachmentError);
  });
});

describe("resolveAttachment", () => {
  it("reads and validates an explicit path", async () => {
    const path = `${ATTACHMENTS_DIR}/factura.pdf`;
    const sandbox = fakeSandbox({ [path]: PDF_BYTES });

    const attachment = await resolveAttachment(sandbox, path);

    expect(attachment.fileName).toBe("factura.pdf");
    expect(attachment.mediaType).toBe("application/pdf");
    expect(attachment.bytes).toEqual(PDF_BYTES);
  });

  it("falls back to the most recent attachment when no path is given", async () => {
    const newest = `${ATTACHMENTS_DIR}/nueva.png`;
    const sandbox = fakeSandbox({ [newest]: PNG_BYTES }, ["nueva.png", "vieja.pdf"]);

    const attachment = await resolveAttachment(sandbox);

    expect(attachment.fileName).toBe("nueva.png");
    expect(attachment.mediaType).toBe("image/png");
  });

  it("falls back to the most recent attachment when the directory path is given", async () => {
    const newest = `${ATTACHMENTS_DIR}/authenticated user.png`;
    const sandbox = fakeSandbox({ [newest]: PNG_BYTES }, ["authenticated user.png"]);

    const attachment = await resolveAttachment(sandbox, `${ATTACHMENTS_DIR}/`);

    expect(attachment.fileName).toBe("authenticated user.png");
    expect(attachment.mediaType).toBe("image/png");
  });

  it("explains that nothing was attached when the directory is empty", async () => {
    await expect(resolveAttachment(fakeSandbox({}, []))).rejects.toThrow(
      /No encontré ningún archivo adjunto/u,
    );
  });

  it("rejects an .exe staged in the attachments directory", async () => {
    const path = `${ATTACHMENTS_DIR}/malware.exe`;
    const sandbox = fakeSandbox({ [path]: EXE_BYTES }, ["malware.exe"]);

    await expect(resolveAttachment(sandbox, path)).rejects.toThrow(/PDF, JPG o PNG/u);
  });

  it("reports a readable error when the file is missing", async () => {
    const path = `${ATTACHMENTS_DIR}/ausente.pdf`;
    await expect(resolveAttachment(fakeSandbox({}), path)).rejects.toThrow(/No pude leer/u);
  });

  it("never reads outside the attachments directory", async () => {
    const sandbox = fakeSandbox({ "/etc/passwd": PDF_BYTES });

    await expect(resolveAttachment(sandbox, "/etc/passwd")).rejects.toThrow(AttachmentError);
    expect(sandbox.readBinaryFile).not.toHaveBeenCalled();
  });

  it("reads the file inside an eve hash directory when no path is given", async () => {
    const filePath = `${ATTACHMENTS_DIR}/d181d53bcaaef2a8/Screenshot 2026-09-09.png`;
    const sandbox = fakeSandbox({ [filePath]: PNG_BYTES }, ["d181d53bcaaef2a8"]);

    const attachment = await resolveAttachment(sandbox);

    expect(attachment.fileName).toBe("Screenshot 2026-09-09.png");
    expect(attachment.mediaType).toBe("image/png");
    expect(attachment.path).toBe(filePath);
    expect(attachment.bytes).toEqual(PNG_BYTES);
  });

  it("reads inside a hash directory when that path is given", async () => {
    const filePath = `${ATTACHMENTS_DIR}/11616363135d405d/authenticated user.png`;
    const sandbox = fakeSandbox({ [filePath]: PNG_BYTES });

    const attachment = await resolveAttachment(sandbox, `${ATTACHMENTS_DIR}/11616363135d405d`);

    expect(attachment.fileName).toBe("authenticated user.png");
    expect(attachment.mediaType).toBe("image/png");
    expect(attachment.path).toBe(filePath);
  });

  it("reads an extensionless staged file by sniffing the bytes", async () => {
    const path = `${ATTACHMENTS_DIR}/d181d53bcaaef2a8`;
    const sandbox = fakeSandbox({ [path]: PNG_BYTES });

    const attachment = await resolveAttachment(sandbox, path);

    expect(attachment.mediaType).toBe("image/png");
    expect(attachment.bytes).toEqual(PNG_BYTES);
  });
});
