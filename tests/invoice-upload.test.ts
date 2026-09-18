import { describe, expect, it } from "vitest";
import { inferInvoiceMediaType } from "../lib/invoice-upload";

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
