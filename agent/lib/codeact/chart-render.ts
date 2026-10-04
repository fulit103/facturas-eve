import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ES_CO_FORMAT_LOCALE, ES_TIME_FORMAT_LOCALE } from "#lib/codeact/chart-locale.js";
import { GEIST_REGULAR_TTF_BASE64 } from "#lib/codeact/generated/assets.js";

/**
 * Vega-Lite charts for `execute_js`.
 *
 * The model builds a Vega-Lite spec with inline data. The Web Chat renders it
 * interactively with vega-embed; Telegram needs a picture, so this module
 * compiles the spec to SVG with vega and rasterizes it with resvg.
 *
 * Specs are untrusted input: they must carry their data inline (no `url`, so
 * the renderer never fetches anything) and stay under a size cap.
 */

export const MAX_CHART_SPEC_BYTES = 400_000;
export const CHART_FONT_FAMILY = "Geist";

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 320;

/** Raised for specs we refuse to render. `message` is shown to the model. */
export class ChartSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartSpecError";
  }
}

export type VegaLiteSpec = Record<string, unknown>;

/**
 * Checks a spec is a plain Vega-Lite object with inline data and fills in the
 * defaults every chart shares (size, font, background). Returns a new object.
 */
export function normalizeChartSpec(spec: unknown, title?: string): VegaLiteSpec {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new ChartSpecError("chart() espera un objeto de especificación Vega-Lite.");
  }
  const size = JSON.stringify(spec).length;
  if (size > MAX_CHART_SPEC_BYTES) {
    throw new ChartSpecError(
      `La especificación del gráfico pesa ${Math.round(size / 1000)} KB (máximo ${MAX_CHART_SPEC_BYTES / 1000} KB). ` +
        "Agregá los datos antes de graficar (por ejemplo, totales por mes) en lugar de pasar registros.",
    );
  }
  assertNoExternalData(spec, "spec");

  const source = spec as VegaLiteSpec;
  const hasLayout = ["hconcat", "vconcat", "concat", "facet", "repeat"].some((key) => key in source);
  const normalized: VegaLiteSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    ...(hasLayout ? {} : { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }),
    ...source,
    background: "white",
    config: {
      font: CHART_FONT_FAMILY,
      title: { fontSize: 15, anchor: "start" },
      axis: { labelFontSize: 11, titleFontSize: 12, grid: true, gridOpacity: 0.4 },
      view: { stroke: null },
      ...(isRecord(source.config) ? source.config : {}),
    },
  };
  if (title !== undefined && title.trim() !== "" && normalized.title === undefined) {
    normalized.title = title;
  }
  return normalized;
}

function assertNoExternalData(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoExternalData(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "url" || key === "href") {
      throw new ChartSpecError(
        `El gráfico no puede cargar recursos externos (${path}.${key}). Usá data: { values: [...] }.`,
      );
    }
    assertNoExternalData(child, `${path}.${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let fontFilePromise: Promise<string> | null = null;

/** resvg only reads fonts from disk, and serverless runtimes ship none. */
async function chartFontFile(): Promise<string> {
  fontFilePromise ??= (async () => {
    const directory = join(tmpdir(), "facturas-codeact-fonts");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "Geist-Regular.ttf");
    await writeFile(path, Buffer.from(GEIST_REGULAR_TTF_BASE64, "base64"));
    return path;
  })().catch((error: unknown) => {
    fontFilePromise = null;
    throw error;
  });
  return fontFilePromise;
}

/** Compiles a normalized Vega-Lite spec to SVG without any network access. */
export async function renderChartSvg(spec: VegaLiteSpec): Promise<string> {
  const [vega, vegaLite] = await Promise.all([import("vega"), import("vega-lite")]);
  vega.formatLocale(ES_CO_FORMAT_LOCALE as never);
  vega.timeFormatLocale(ES_TIME_FORMAT_LOCALE as never);
  let compiled;
  try {
    compiled = vegaLite.compile(spec as never).spec;
  } catch (error) {
    throw new ChartSpecError(`Vega-Lite rechazó la especificación: ${(error as Error).message}`);
  }
  const loader = vega.loader();
  // Specs are inline-only; refuse any load the spec might still trigger.
  loader.load = () => Promise.reject(new Error("external data is disabled"));
  loader.sanitize = () => Promise.reject(new Error("external data is disabled"));

  const view = new vega.View(vega.parse(compiled), { renderer: "none", loader });
  try {
    return await view.toSVG();
  } catch (error) {
    throw new ChartSpecError(`No pude dibujar el gráfico: ${(error as Error).message}`);
  } finally {
    view.finalize();
  }
}

/** SVG -> PNG at 2x for crisp text on phones. */
export async function renderChartPng(spec: VegaLiteSpec): Promise<Uint8Array> {
  const svg = await renderChartSvg(spec);
  const { Resvg } = await import("@resvg/resvg-js");
  const resvg = new Resvg(svg, {
    background: "white",
    fitTo: { mode: "zoom", value: 2 },
    font: {
      loadSystemFonts: false,
      fontFiles: [await chartFontFile()],
      defaultFontFamily: CHART_FONT_FAMILY,
      sansSerifFamily: CHART_FONT_FAMILY,
    },
  });
  return new Uint8Array(resvg.render().asPng());
}
