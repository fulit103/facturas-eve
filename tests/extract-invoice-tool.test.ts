import { beforeEach, describe, expect, it, vi } from "vitest";

import { ATTACHMENTS_DIR } from "#lib/attachments.js";
import { sha256Hex } from "#lib/idempotency.js";
import { DocumentParseError } from "#lib/llamaindex.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfactura\n");
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
const MARKDOWN = "# Proveedor SAS\nFactura FE-1234";

/** The tool itself, with the extraction library mocked out. */vi.mock("#lib/llamaindex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/llamaindex.js")>();
  return { ...actual, extractInvoiceFromDocument: vi.fn() };
});

const { extractInvoiceFromDocument: mockedExtract } = await import("#lib/llamaindex.js");
const extractInvoiceTool = (await import("#tools/extract_invoice.js")).default as unknown as {
  execute(
    input: { filePath?: string },
    ctx: unknown,
  ): Promise<{
    invoice: { invoiceNumber: string | null; total: number | null };
    idempotencyKey: string;
    missingCriticalFields: string[];
    pageCount: number;
  }>;
};

function toolContext(files: Record<string, Uint8Array>, listing: string[] = []) {
  return {
    getSandbox: async () => ({
      readBinaryFile: async ({ path }: { path: string }) => files[path] ?? null,
      run: async () => ({ exitCode: 0, stdout: listing.join("\n"), stderr: "" }),
    }),
    session: { auth: { current: null } },
  };
}

describe("extract_invoice tool", () => {
  const path = `${ATTACHMENTS_DIR}/factura.pdf`;

  beforeEach(() => {
    vi.mocked(mockedExtract).mockReset();
  });

  it("returns the invoice plus a content-derived idempotency key", async () => {
    vi.mocked(mockedExtract).mockResolvedValue({
      invoice: {
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
        description: null,
        cufe: null,
        sourceFileName: "factura.pdf",
      },
      markdown: MARKDOWN,
      pageCount: 1,
    });

    const result = await extractInvoiceTool.execute(
      { filePath: path },
      toolContext({ [path]: PDF_BYTES }),
    );

    expect(result.invoice.invoiceNumber).toBe("FE-1234");
    expect(result.idempotencyKey).toBe(`sha256:${sha256Hex(PDF_BYTES)}`);
    expect(result.missingCriticalFields).toEqual([]);
  });

  it("produces the same idempotency key for the same bytes", async () => {
    const invoice = {
      invoiceNumber: "FE-1234",
      issueDate: null,
      dueDate: null,
      supplierName: "Proveedor SAS",
      supplierTaxId: null,
      customerName: null,
      customerTaxId: null,
      subtotal: null,
      tax: null,
      total: 1000000,
      currency: null,
      description: null,
      cufe: null,
      sourceFileName: "factura.pdf",
    };
    vi.mocked(mockedExtract).mockResolvedValue({ invoice, markdown: MARKDOWN, pageCount: 1 });

    const ctx = toolContext({ [path]: PDF_BYTES });
    const first = await extractInvoiceTool.execute({ filePath: path }, ctx);
    const second = await extractInvoiceTool.execute({ filePath: path }, ctx);

    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it("reports which critical fields the document lacked", async () => {
    vi.mocked(mockedExtract).mockResolvedValue({
      invoice: {
        invoiceNumber: null,
        issueDate: null,
        dueDate: null,
        supplierName: "Proveedor SAS",
        supplierTaxId: null,
        customerName: null,
        customerTaxId: null,
        subtotal: null,
        tax: null,
        total: null,
        currency: null,
        description: null,
        cufe: null,
        sourceFileName: "factura.pdf",
      },
      markdown: MARKDOWN,
      pageCount: 1,
    });

    const result = await extractInvoiceTool.execute(
      { filePath: path },
      toolContext({ [path]: PDF_BYTES }),
    );

    expect(result.missingCriticalFields).toEqual(["número de factura", "total"]);
  });

  it("rejects a disallowed file before calling the parser", async () => {
    const exePath = `${ATTACHMENTS_DIR}/malware.exe`;

    await expect(
      extractInvoiceTool.execute({ filePath: exePath }, toolContext({ [exePath]: EXE_BYTES })),
    ).rejects.toThrow(/PDF, JPG o PNG/u);

    expect(mockedExtract).not.toHaveBeenCalled();
  });

  it("surfaces the retry message when the parser fails", async () => {
    vi.mocked(mockedExtract).mockRejectedValue(new DocumentParseError("boom"));

    await expect(
      extractInvoiceTool.execute({ filePath: path }, toolContext({ [path]: PDF_BYTES })),
    ).rejects.toThrow(/No pude interpretar esta factura/u);
  });
});
