import { describe, expect, it, vi } from "vitest";

import {
  DocumentParseError,
  type ExtractionDependencies,
  extractInvoiceFromDocument,
} from "#lib/llamaindex.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfactura\n");

const MARKDOWN = [
  "# Proveedor SAS",
  "NIT 900123456-7",
  "Factura de venta FE-1234",
  "Fecha: 15/09/2026",
  "Subtotal $840.336",
  "IVA $159.664",
  "Total $1.000.000",
].join("\n");

/** Stand-in for LlamaParse; no LlamaCloud call is made in tests. */
function mockDependencies(overrides: Partial<ExtractionDependencies> = {}): ExtractionDependencies {
  return {
    parseDocument: vi.fn(async () => ({ markdown: MARKDOWN, pageCount: 1 })),
    structureInvoice: vi.fn(async () => ({
      invoiceNumber: "FE-1234",
      issueDate: "15/09/2026",
      dueDate: null,
      supplierName: "Proveedor SAS",
      supplierTaxId: "NIT 900123456-7",
      customerName: null,
      customerTaxId: null,
      subtotal: "$840.336",
      tax: "$159.664",
      total: "$1.000.000",
      currency: "$",
      description: "Servicios",
      cufe: null,
    })),
    ...overrides,
  };
}

const documentInput = {
  bytes: PDF_BYTES,
  fileName: "factura.pdf",
  mediaType: "application/pdf",
};

describe("extractInvoiceFromDocument", () => {
  it("parses the document and returns a normalized invoice", async () => {
    const dependencies = mockDependencies();

    const result = await extractInvoiceFromDocument(documentInput, dependencies);

    expect(dependencies.parseDocument).toHaveBeenCalledWith(documentInput);
    expect(dependencies.structureInvoice).toHaveBeenCalledWith({
      markdown: MARKDOWN,
      fileName: "factura.pdf",
    });
    expect(result.invoice).toEqual({
      invoiceNumber: "FE-1234",
      issueDate: "2026-09-15",
      dueDate: null,
      supplierName: "Proveedor SAS",
      supplierTaxId: "900123456-7",
      customerName: null,
      customerTaxId: null,
      subtotal: 840336,
      tax: 159664,
      total: 1000000,
      currency: "COP",
      description: "Servicios",
      cufe: null,
      sourceFileName: "factura.pdf",
    });
    expect(result.pageCount).toBe(1);
  });

  it("keeps missing fields as null instead of guessing", async () => {
    const dependencies = mockDependencies({
      structureInvoice: vi.fn(async () => ({
        invoiceNumber: null,
        issueDate: null,
        dueDate: null,
        supplierName: "Proveedor SAS",
        supplierTaxId: null,
        customerName: null,
        customerTaxId: null,
        subtotal: null,
        tax: null,
        total: "$1.000.000",
        currency: null,
        description: null,
        cufe: null,
      })),
    });

    const { invoice } = await extractInvoiceFromDocument(documentInput, dependencies);

    expect(invoice.invoiceNumber).toBeNull();
    expect(invoice.issueDate).toBeNull();
    expect(invoice.subtotal).toBeNull();
    expect(invoice.total).toBe(1000000);
  });

  it("raises a user-facing error when parsing fails", async () => {
    const dependencies = mockDependencies({
      parseDocument: vi.fn(async () => {
        throw new DocumentParseError("LlamaParse exploded");
      }),
    });

    await expect(extractInvoiceFromDocument(documentInput, dependencies)).rejects.toBeInstanceOf(
      DocumentParseError,
    );
  });

  it("raises a user-facing error when the model returns an unusable shape", async () => {
    const dependencies = mockDependencies({
      structureInvoice: vi.fn(async () => ({ nonsense: true }) as never),
    });

    const error = await extractInvoiceFromDocument(documentInput, dependencies).catch((e) => e);

    expect(error).toBeInstanceOf(DocumentParseError);
    expect((error as DocumentParseError).userMessage).toMatch(/No pude interpretar esta factura/u);
  });
});
