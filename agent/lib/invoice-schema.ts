import { z } from "zod";

/**
 * Canonical invoice shape shared by `extract_invoice`, `save_invoice`, and the
 * Airtable mapping. Every business field is nullable on purpose: the agent must
 * report a missing value rather than invent one.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** ISO 4217-style uppercase code, e.g. COP, USD, EUR. */
const CURRENCY_CODE = /^[A-Z]{3}$/u;

export const InvoiceSchema = z.object({
  /** Kept as a string: identifiers like "FE-001234" are not numbers. */
  invoiceNumber: z.string().min(1).nullable(),
  issueDate: z.string().regex(ISO_DATE).nullable(),
  dueDate: z.string().regex(ISO_DATE).nullable(),

  supplierName: z.string().min(1).nullable(),
  supplierTaxId: z.string().min(1).nullable(),

  customerName: z.string().min(1).nullable(),
  customerTaxId: z.string().min(1).nullable(),

  subtotal: z.number().finite().nullable(),
  tax: z.number().finite().nullable(),
  total: z.number().finite().nullable(),
  currency: z.string().regex(CURRENCY_CODE).nullable(),

  description: z.string().min(1).nullable(),

  /** Colombian electronic invoice unique code, when the document carries one. */
  cufe: z.string().min(1).nullable(),

  sourceFileName: z.string().min(1).nullable(),
});

export type Invoice = z.infer<typeof InvoiceSchema>;

/**
 * Lenient shape the extraction model is asked to produce. Amounts and dates
 * arrive as raw strings exactly as printed on the document, so normalization
 * happens here in code instead of relying on the model to format them.
 */
export const RawInvoiceSchema = z.object({
  invoiceNumber: z.string().nullable(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierTaxId: z.string().nullable(),
  customerName: z.string().nullable(),
  customerTaxId: z.string().nullable(),
  subtotal: z.string().nullable(),
  tax: z.string().nullable(),
  total: z.string().nullable(),
  currency: z.string().nullable(),
  description: z.string().nullable(),
  cufe: z.string().nullable(),
});

export type RawInvoice = z.infer<typeof RawInvoiceSchema>;

/** Fields the agent must have before writing a row to Airtable. */
export const CRITICAL_INVOICE_FIELDS = ["supplierName", "invoiceNumber", "total"] as const;

export type CriticalInvoiceField = (typeof CRITICAL_INVOICE_FIELDS)[number];

/** Human-facing Spanish labels, used when asking the user for a missing value. */
export const CRITICAL_FIELD_LABELS: Record<CriticalInvoiceField, string> = {
  supplierName: "proveedor",
  invoiceNumber: "número de factura",
  total: "total",
};

export function findMissingCriticalFields(invoice: Invoice): CriticalInvoiceField[] {
  return CRITICAL_INVOICE_FIELDS.filter((field) => invoice[field] === null);
}

function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Models sometimes emit these instead of an actual null.
  if (/^(null|n\/?a|none|no aplica|desconocido|unknown|-{1,2})$/iu.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parses a printed monetary amount into a number.
 *
 * Separator rules, applied in order:
 * 1. Both `.` and `,` present -> the last one seen is the decimal separator.
 * 2. One separator repeated -> it is a thousands separator ("1.000.000").
 * 3. One separator once -> exactly three trailing digits means thousands
 *    ("840.336" -> 840336); anything else is a decimal ("12.50" -> 12.5).
 *
 * Rule 3 is ambiguous by nature. It resolves toward the Colombian convention,
 * where three trailing digits after a dot are thousands.
 */
export function normalizeAmount(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = blankToNull(value);
  if (raw === null) return null;

  const negative = /^\(.*\)$/u.test(raw.trim()) || raw.includes("-");
  // Drop currency symbols, codes, and spaces; keep digits and separators.
  const cleaned = raw.replace(/[^\d.,]/gu, "");
  if (cleaned === "") return null;

  const dots = (cleaned.match(/\./gu) ?? []).length;
  const commas = (cleaned.match(/,/gu) ?? []).length;

  let normalized: string;
  if (dots > 0 && commas > 0) {
    const decimalSeparator = cleaned.lastIndexOf(".") > cleaned.lastIndexOf(",") ? "." : ",";
    const thousandsSeparator = decimalSeparator === "." ? "," : ".";
    normalized = cleaned.split(thousandsSeparator).join("").replace(decimalSeparator, ".");
  } else if (dots + commas === 0) {
    normalized = cleaned;
  } else {
    const separator = dots > 0 ? "." : ",";
    const count = dots > 0 ? dots : commas;
    const trailing = cleaned.slice(cleaned.lastIndexOf(separator) + 1);
    if (count > 1 || trailing.length === 3) {
      normalized = cleaned.split(separator).join("");
    } else {
      normalized = cleaned.split(separator).join(".");
    }
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

const SPANISH_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects overflow such as 2026-02-31 silently rolling into March.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Normalizes a printed date to `YYYY-MM-DD`.
 *
 * Numeric `A/B/YYYY` dates are ambiguous. When neither part settles it, the
 * day-first reading wins, matching Colombian and European invoices.
 * Returns `null` when the value cannot be read confidently.
 */
export function normalizeDate(value: string | null | undefined): string | null {
  const raw = blankToNull(value);
  if (raw === null) return null;

  const isoMatch = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u);
  if (isoMatch) {
    return toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const numericMatch = raw.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/u);
  if (numericMatch) {
    const first = Number(numericMatch[1]);
    const second = Number(numericMatch[2]);
    let year = Number(numericMatch[3]);
    if (numericMatch[3].length === 2) year += year < 70 ? 2000 : 1900;

    if (first > 12 && second <= 12) return toIsoDate(year, second, first);
    if (second > 12 && first <= 12) return toIsoDate(year, first, second);
    return toIsoDate(year, second, first);
  }

  const textMatch = raw
    .toLowerCase()
    .match(/(\d{1,2})\s*(?:de\s+)?([a-záéíóú]+)\s*(?:de\s+|del\s+)?(\d{4})/u);
  if (textMatch) {
    const monthName = textMatch[2].normalize("NFD").replace(/[̀-ͯ]/gu, "");
    const month = SPANISH_MONTHS[monthName];
    if (month !== undefined) {
      return toIsoDate(Number(textMatch[3]), month, Number(textMatch[1]));
    }
  }

  return null;
}

const CURRENCY_ALIASES: Record<string, string> = {
  "$": "COP",
  cop: "COP",
  "cop$": "COP",
  peso: "COP",
  pesos: "COP",
  "pesos colombianos": "COP",
  usd: "USD",
  "us$": "USD",
  dolar: "USD",
  dolares: "USD",
  eur: "EUR",
  "€": "EUR",
  euro: "EUR",
  euros: "EUR",
};

/**
 * Maps a currency label to a 3-letter code. A bare `$` resolves to COP, the
 * default currency for this deployment; change the alias table for another market.
 */
export function normalizeCurrency(value: string | null | undefined): string | null {
  const raw = blankToNull(value);
  if (raw === null) return null;

  const upper = raw.toUpperCase();
  if (CURRENCY_CODE.test(upper)) return upper;

  const key = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .trim();
  return CURRENCY_ALIASES[key] ?? null;
}

/** Tax IDs stay strings; only surrounding labels and whitespace are stripped. */
export function normalizeTaxId(value: string | null | undefined): string | null {
  const raw = blankToNull(value);
  if (raw === null) return null;
  const stripped = raw.replace(/^(nit|rut|cc|c\.c\.|tax\s*id|id)[.:\s]*/iu, "").trim();
  return blankToNull(stripped);
}

const INVOICE_NUMBER_LABEL = /^(factura|invoice|no|nro|num(ero)?|n[.°º]|#)[.:\s]*/iu;

/** Invoice numbers stay strings so prefixes like "FE-" survive. */
export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  const raw = blankToNull(value);
  if (raw === null) return null;

  // Labels stack ("Factura No. FE-1234"), so strip them until the value settles.
  let current = raw;
  for (;;) {
    const stripped = current.replace(INVOICE_NUMBER_LABEL, "").trim();
    if (stripped === current || stripped === "") break;
    current = stripped;
  }
  return blankToNull(current) ?? raw;
}

/**
 * Turns a raw model extraction into a validated {@link Invoice}.
 * Throws a `ZodError` when the normalized object still violates the schema.
 */
export function normalizeInvoice(raw: RawInvoice, sourceFileName: string | null): Invoice {
  return InvoiceSchema.parse({
    invoiceNumber: normalizeInvoiceNumber(raw.invoiceNumber),
    issueDate: normalizeDate(raw.issueDate),
    dueDate: normalizeDate(raw.dueDate),
    supplierName: blankToNull(raw.supplierName),
    supplierTaxId: normalizeTaxId(raw.supplierTaxId),
    customerName: blankToNull(raw.customerName),
    customerTaxId: normalizeTaxId(raw.customerTaxId),
    subtotal: normalizeAmount(raw.subtotal),
    tax: normalizeAmount(raw.tax),
    total: normalizeAmount(raw.total),
    currency: normalizeCurrency(raw.currency),
    description: blankToNull(raw.description),
    cufe: blankToNull(raw.cufe),
    sourceFileName: blankToNull(sourceFileName),
  });
}
