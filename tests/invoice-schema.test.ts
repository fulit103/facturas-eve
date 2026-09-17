import { describe, expect, it } from "vitest";

import {
  CRITICAL_INVOICE_FIELDS,
  InvoiceSchema,
  findMissingCriticalFields,
  normalizeAmount,
  normalizeCurrency,
  normalizeDate,
  normalizeInvoice,
  normalizeInvoiceNumber,
  normalizeTaxId,
} from "#lib/invoice-schema.js";

describe("InvoiceSchema", () => {
  it("accepts a fully populated invoice", () => {
    const invoice = {
      invoiceNumber: "FE-10234",
      issueDate: "2026-09-15",
      dueDate: "2026-10-15",
      supplierName: "ACME SAS",
      supplierTaxId: "900123456-7",
      customerName: "Cliente SAS",
      customerTaxId: "901234567-8",
      subtotal: 840336,
      tax: 159664,
      total: 1000000,
      currency: "COP",
      description: "Servicios de consultoría",
      cufe: "a1b2c3d4e5",
      sourceFileName: "factura.pdf",
    };

    expect(InvoiceSchema.parse(invoice)).toEqual(invoice);
  });

  it("accepts an invoice where every optional field is null", () => {
    const invoice = {
      invoiceNumber: "FE-1",
      issueDate: null,
      dueDate: null,
      supplierName: "ACME SAS",
      supplierTaxId: null,
      customerName: null,
      customerTaxId: null,
      subtotal: null,
      tax: null,
      total: 1000,
      currency: null,
      description: null,
      cufe: null,
      sourceFileName: null,
    };

    expect(() => InvoiceSchema.parse(invoice)).not.toThrow();
  });

  it("rejects a numeric invoice number", () => {
    const result = InvoiceSchema.safeParse({
      invoiceNumber: 10234,
      issueDate: null,
      dueDate: null,
      supplierName: null,
      supplierTaxId: null,
      customerName: null,
      customerTaxId: null,
      subtotal: null,
      tax: null,
      total: null,
      currency: null,
      description: null,
      cufe: null,
      sourceFileName: null,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a non ISO issue date and a non ISO currency", () => {
    const base = {
      invoiceNumber: "FE-1",
      issueDate: "15/09/2026",
      dueDate: null,
      supplierName: null,
      supplierTaxId: null,
      customerName: null,
      customerTaxId: null,
      subtotal: null,
      tax: null,
      total: null,
      currency: "pesos",
      description: null,
      cufe: null,
      sourceFileName: null,
    };

    expect(InvoiceSchema.safeParse(base).success).toBe(false);
  });
});

describe("findMissingCriticalFields", () => {
  const complete = {
    invoiceNumber: "FE-1",
    issueDate: null,
    dueDate: null,
    supplierName: "ACME SAS",
    supplierTaxId: null,
    customerName: null,
    customerTaxId: null,
    subtotal: null,
    tax: null,
    total: 1000,
    currency: null,
    description: null,
    cufe: null,
    sourceFileName: null,
  };

  it("returns nothing when supplier, number and total are present", () => {
    expect(findMissingCriticalFields(complete)).toEqual([]);
  });

  it("reports each missing critical field", () => {
    expect(findMissingCriticalFields({ ...complete, invoiceNumber: null })).toEqual([
      "invoiceNumber",
    ]);
    expect(
      findMissingCriticalFields({
        ...complete,
        supplierName: null,
        invoiceNumber: null,
        total: null,
      }),
    ).toEqual([...CRITICAL_INVOICE_FIELDS]);
  });
});

describe("normalizeAmount", () => {
  it("reads Colombian thousands separators", () => {
    expect(normalizeAmount("$1.000.000")).toBe(1000000);
    expect(normalizeAmount("840.336")).toBe(840336);
    expect(normalizeAmount("159.664")).toBe(159664);
  });

  it("reads US style amounts", () => {
    expect(normalizeAmount("1,234.56")).toBe(1234.56);
    expect(normalizeAmount("$1,000,000")).toBe(1000000);
  });

  it("reads European style amounts", () => {
    expect(normalizeAmount("1.234,56")).toBe(1234.56);
  });

  it("treats a single separator with two decimals as a decimal", () => {
    expect(normalizeAmount("12.50")).toBe(12.5);
    expect(normalizeAmount("12,50")).toBe(12.5);
  });

  it("strips currency labels and whitespace", () => {
    expect(normalizeAmount(" COP 1.000.000 ")).toBe(1000000);
    expect(normalizeAmount("USD 250")).toBe(250);
  });

  it("returns null for empty or unreadable values", () => {
    expect(normalizeAmount(null)).toBeNull();
    expect(normalizeAmount("")).toBeNull();
    expect(normalizeAmount("N/A")).toBeNull();
    expect(normalizeAmount("sin dato")).toBeNull();
  });

  it("passes finite numbers through", () => {
    expect(normalizeAmount(1000)).toBe(1000);
    expect(normalizeAmount(Number.NaN)).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("normalizes day-first numeric dates", () => {
    expect(normalizeDate("15/09/2026")).toBe("2026-09-15");
    expect(normalizeDate("01-02-2026")).toBe("2026-02-01");
  });

  it("keeps ISO dates", () => {
    expect(normalizeDate("2026-09-15")).toBe("2026-09-15");
  });

  it("uses the unambiguous part when one exists", () => {
    expect(normalizeDate("09/15/2026")).toBe("2026-09-15");
  });

  it("reads Spanish month names", () => {
    expect(normalizeDate("15 de septiembre de 2026")).toBe("2026-09-15");
  });

  it("rejects impossible calendar dates", () => {
    expect(normalizeDate("31/02/2026")).toBeNull();
  });

  it("returns null when there is no date", () => {
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate("pendiente")).toBeNull();
  });
});

describe("normalizeCurrency", () => {
  it("maps symbols and words to ISO codes", () => {
    expect(normalizeCurrency("$")).toBe("COP");
    expect(normalizeCurrency("pesos")).toBe("COP");
    expect(normalizeCurrency("dólares")).toBe("USD");
    expect(normalizeCurrency("euros")).toBe("EUR");
  });

  it("keeps existing ISO codes", () => {
    expect(normalizeCurrency("cop")).toBe("COP");
    expect(normalizeCurrency("USD")).toBe("USD");
  });

  it("returns null for unknown labels", () => {
    expect(normalizeCurrency("monedas")).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
  });
});

describe("normalizeTaxId and normalizeInvoiceNumber", () => {
  it("keeps tax ids as strings and strips labels", () => {
    expect(normalizeTaxId("NIT: 900123456-7")).toBe("900123456-7");
    expect(normalizeTaxId("900123456-7")).toBe("900123456-7");
  });

  it("keeps invoice number prefixes intact", () => {
    expect(normalizeInvoiceNumber("FE-001234")).toBe("FE-001234");
    expect(normalizeInvoiceNumber("Factura No. FE-1234")).toBe("FE-1234");
  });
});

describe("normalizeInvoice", () => {
  it("turns a raw extraction into a validated invoice", () => {
    const invoice = normalizeInvoice(
      {
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
      },
      "factura.pdf",
    );

    expect(invoice).toEqual({
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
  });

  it("maps model placeholder strings to null instead of inventing values", () => {
    const invoice = normalizeInvoice(
      {
        invoiceNumber: "FE-1",
        issueDate: "N/A",
        dueDate: "null",
        supplierName: "ACME",
        supplierTaxId: "desconocido",
        customerName: "-",
        customerTaxId: null,
        subtotal: null,
        tax: null,
        total: "1000",
        currency: null,
        description: null,
        cufe: null,
      },
      null,
    );

    expect(invoice.issueDate).toBeNull();
    expect(invoice.dueDate).toBeNull();
    expect(invoice.supplierTaxId).toBeNull();
    expect(invoice.customerName).toBeNull();
    expect(invoice.sourceFileName).toBeNull();
  });
});
