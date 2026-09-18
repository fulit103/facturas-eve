import { describe, expect, it } from "vitest";
import { inferInvoiceMediaType, isSendableAttachmentData } from "../lib/invoice-upload";

describe("inferInvoiceMediaType", () => {
  it("infiere PDF por extensión cuando el navegador no envía MIME type", () => {
    expect(inferInvoiceMediaType("factura-demo.pdf", "")).toBe("application/pdf");
  });

  it("respeta el MIME type declarado", () => {
    expect(inferInvoiceMediaType("scan.jpg", "image/jpeg")).toBe("image/jpeg");
  });

  it("rechaza extensiones no permitidas", () => {
    expect(inferInvoiceMediaType("malware.exe", "")).toBeNull();
  });
});

describe("isSendableAttachmentData", () => {
  it("acepta data URLs que eve puede materializar como bytes", () => {
    expect(isSendableAttachmentData("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
  });

  it("acepta URLs http(s) remotas", () => {
    expect(isSendableAttachmentData("https://example.com/factura.png")).toBe(true);
  });

  it("rechaza blob URLs que el servidor no puede resolver", () => {
    expect(isSendableAttachmentData("blob:http://localhost:5173/abc")).toBe(false);
  });
});
