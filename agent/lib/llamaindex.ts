import LlamaCloud from "@llamaindex/llama-cloud";
import { generateObject } from "ai";

import {
  type Invoice,
  type RawInvoice,
  RawInvoiceSchema,
  normalizeInvoice,
} from "#lib/invoice-schema.js";

/**
 * Document understanding for invoices, in two steps:
 *
 * 1. LlamaParse (LlamaIndex's LlamaCloud parsing service) turns the PDF or
 *    image into markdown. It OCRs scanned PDFs and photos, so the same path
 *    covers text PDFs, scans, JPG, and PNG.
 * 2. A structured-extraction pass reads that markdown into {@link RawInvoiceSchema},
 *    which is then normalized and validated against `InvoiceSchema`.
 *
 * Both steps are injectable so tests and evals never call LlamaCloud.
 */

export const DEFAULT_PARSE_TIMEOUT_MS = 120_000;
export const DEFAULT_EXTRACTION_MODEL = "openai/gpt-5.6-luna";

/** Raised when the document cannot be read; carries a message meant for the user. */
export class DocumentParseError extends Error {
  readonly userMessage: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentParseError";
    this.userMessage =
      "❌ No pude interpretar esta factura. Intenta enviarla nuevamente o usa una imagen/PDF con mejor calidad.";
  }
}

export interface DocumentInput {
  bytes: Uint8Array;
  fileName: string;
  mediaType: string;
}

export interface ParsedDocument {
  markdown: string;
  pageCount: number;
}

export type DocumentParser = (input: DocumentInput) => Promise<ParsedDocument>;

export type InvoiceStructurer = (input: {
  markdown: string;
  fileName: string;
}) => Promise<RawInvoice>;

export interface ExtractionDependencies {
  parseDocument: DocumentParser;
  structureInvoice: InvoiceStructurer;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new DocumentParseError(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Step 1: LlamaParse -> markdown. */
export const parseDocumentWithLlamaParse: DocumentParser = async ({
  bytes,
  fileName,
  mediaType,
}) => {
  const client = new LlamaCloud({ apiKey: requireEnv("LLAMA_CLOUD_API_KEY") });

  let result: Awaited<ReturnType<typeof client.parsing.parse>>;
  try {
    result = await client.parsing.parse(
      {
        tier: "cost_effective",
        version: "latest",
        // The SDK accepts a File; the bytes never touch the local filesystem.
        upload_file: new File([bytes as BlobPart], fileName, { type: mediaType }),
        expand: ["markdown"],
        input_options: {
          // Invoices often arrive as phone photos: deskew and flatten them first.
          image: { camera_photo_correction: true },
        },
      },
      // `timeout` here is the polling budget in seconds, not a per-request timeout.
      { timeout: DEFAULT_PARSE_TIMEOUT_MS / 1000 },
    );
  } catch (cause) {
    throw new DocumentParseError(`LlamaParse failed for ${fileName}`, { cause });
  }

  const pages = result.markdown?.pages ?? [];
  const pageMarkdown = pages
    .filter((page): page is Extract<(typeof pages)[number], { success: true }> => page.success)
    .map((page) => page.markdown);

  const markdown = (result.markdown_full ?? pageMarkdown.join("\n\n---\n\n")).trim();

  if (markdown === "") {
    throw new DocumentParseError(`LlamaParse returned no text for ${fileName}`);
  }

  return { markdown, pageCount: Math.max(pageMarkdown.length, 1) };
};

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract structured data from invoice documents.",
  "",
  "Rules:",
  "- Only report values that appear in the document. Never guess, infer, or compute a missing value.",
  "- When a field is absent or unreadable, return null for it.",
  "- Copy monetary amounts and dates exactly as printed, including separators and symbols. Do not reformat them.",
  "- Keep the invoice number as printed, including any prefix such as 'FE-'.",
  "- supplierName is the party issuing the invoice; customerName is the party being billed.",
  "- 'cufe' is the Colombian electronic invoice code (CUFE/CUDE). Return null when absent.",
  "- 'description' is a short summary of what is being billed, in the document's language.",
].join("\n");

/** Step 2: markdown -> raw structured fields, validated by Zod. */
export const structureInvoiceWithModel: InvoiceStructurer = async ({ markdown, fileName }) => {
  try {
    const result = await generateObject({
      model: process.env.INVOICE_EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL,
      schema: RawInvoiceSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: [
        `File name: ${fileName}`,
        "",
        "Invoice document, parsed to markdown:",
        "",
        markdown,
      ].join("\n"),
    });
    return result.object;
  } catch (cause) {
    throw new DocumentParseError(`Structured extraction failed for ${fileName}`, { cause });
  }
};

export const defaultExtractionDependencies: ExtractionDependencies = {
  parseDocument: parseDocumentWithLlamaParse,
  structureInvoice: structureInvoiceWithModel,
};

export interface ExtractionResult {
  invoice: Invoice;
  markdown: string;
  pageCount: number;
}

/**
 * Runs both steps and returns a validated invoice.
 * Throws {@link DocumentParseError} for anything the user should retry.
 */
export async function extractInvoiceFromDocument(
  input: DocumentInput,
  dependencies: ExtractionDependencies = defaultExtractionDependencies,
): Promise<ExtractionResult> {
  const parsed = await dependencies.parseDocument(input);
  const raw = await dependencies.structureInvoice({
    markdown: parsed.markdown,
    fileName: input.fileName,
  });

  let invoice: Invoice;
  try {
    invoice = normalizeInvoice(RawInvoiceSchema.parse(raw), input.fileName);
  } catch (cause) {
    throw new DocumentParseError(`Invoice normalization failed for ${input.fileName}`, { cause });
  }

  return { invoice, markdown: parsed.markdown, pageCount: parsed.pageCount };
}
