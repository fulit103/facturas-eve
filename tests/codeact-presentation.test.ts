import { describe, expect, it, vi } from "vitest";

import {
  ChartSpecError,
  normalizeChartSpec,
  renderChartPng,
  renderChartSvg,
} from "#lib/codeact/chart-render.js";
import {
  ARQUERO_SOURCE_SHA,
  ARQUERO_VERSION,
  GEIST_REGULAR_SHA,
} from "#lib/codeact/generated/assets.js";
import type { ExecutionOutput } from "#lib/codeact/js-engine.js";
import { toModelView } from "#lib/codeact/model-view.js";
import { chartsFromActionResult, sendTelegramCharts } from "#lib/codeact/telegram-charts.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SPEC = normalizeChartSpec(
  {
    data: {
      values: [
        { mes: "2026-01", total: 12_400_000 },
        { mes: "2026-02", total: 15_100_000 },
      ],
    },
    mark: "bar",
    encoding: {
      x: { field: "mes", type: "ordinal" },
      y: { field: "total", type: "quantitative", axis: { format: "$,.0f" } },
    },
  },
  "Total por mes",
);

function output(overrides: Partial<ExecutionOutput> = {}): ExecutionOutput {
  return {
    ok: true,
    executionId: "exec1",
    stdout: "",
    stdoutTruncated: false,
    result: { kind: "text", text: "42", truncated: false },
    error: null,
    charts: [{ id: "exec1-1", title: "Total por mes", spec: SPEC }],
    dataReads: [
      {
        table: "Invoices",
        records: 42,
        complete: true,
        pages: 1,
        formula: null,
        view: null,
        max_records: null,
      },
    ],
    variables: [{ name: "facturas", type: "array", length: 42 }],
    notPersisted: [],
    warnings: [],
    durationMs: 120,
    ...overrides,
  };
}

describe("toModelView", () => {
  it("keeps chart data out of the model context", () => {
    const view = toModelView(output());
    expect(JSON.stringify(view)).not.toContain("15100000");
    expect(view.charts).toEqual([{ id: "exec1-1", title: "Total por mes", shownToUser: true }]);
    expect(view.store).toEqual([{ name: "facturas", type: "array", length: 42 }]);
    expect(view).not.toHaveProperty("stdout");
    expect(view).not.toHaveProperty("error");
  });

  it("adds a correction hint to errors", () => {
    const view = toModelView(
      output({
        ok: false,
        result: null,
        charts: [],
        error: { type: "TypeError", message: "x is undefined", line: 2, code_line: "x.y", stack: "" },
      }),
    );
    expect(view.error).toMatchObject({ type: "TypeError", line: 2 });
    expect((view.error as { hint: string }).hint).toContain("execute_js");
  });
});

describe("chart rendering", () => {
  it("fills defaults and keeps the caller's title", () => {
    expect(SPEC).toMatchObject({ width: 640, height: 320, title: "Total por mes", background: "white" });
    expect((SPEC.config as { font: string }).font).toBe("Geist");
  });

  it("rejects external data and oversized specs", () => {
    expect(() => normalizeChartSpec({ data: { url: "https://evil.test/data.json" }, mark: "bar" })).toThrow(
      ChartSpecError,
    );
    expect(() =>
      normalizeChartSpec({
        layer: [{ mark: "bar", encoding: { href: { field: "u" } } }],
      }),
    ).toThrow(/recursos externos/u);
    const huge = { data: { values: Array.from({ length: 20_000 }, (_, i) => ({ i, label: `row-${i}` })) } };
    expect(() => normalizeChartSpec(huge)).toThrow(/Agregá los datos/u);
  });

  it("renders es-CO numbers to SVG and a PNG", async () => {
    const svg = await renderChartSvg(SPEC);
    expect(svg).toContain("$10.000.000");
    const png = await renderChartPng(SPEC);
    expect(Buffer.from(png.subarray(0, 4)).toString("hex")).toBe("89504e47");
    expect(png.byteLength).toBeGreaterThan(5_000);
  }, 30_000);
});

describe("generated assets", () => {
  it("match the installed arquero and geist packages", () => {
    const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
    const arqueroPackage = JSON.parse(readFileSync("node_modules/arquero/package.json", "utf8")) as {
      version: string;
    };
    expect(ARQUERO_VERSION).toBe(arqueroPackage.version);
    expect(ARQUERO_SOURCE_SHA).toBe(sha(readFileSync("node_modules/arquero/dist/arquero.min.js", "utf8")));
    expect(GEIST_REGULAR_SHA).toBe(
      sha(readFileSync("node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf")),
    );
  });
});

describe("Telegram chart delivery", () => {
  it("extracts charts only from successful execute_js results", () => {
    const result = { kind: "tool-result", toolName: "execute_js", callId: "c1", output: output() };
    expect(chartsFromActionResult(result)).toHaveLength(1);
    expect(chartsFromActionResult({ ...result, toolName: "save_invoice" })).toEqual([]);
    expect(chartsFromActionResult({ ...result, isError: true })).toEqual([]);
    expect(chartsFromActionResult(null)).toEqual([]);
  });

  it("renders each chart and uploads it with sendPhoto as multipart", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await sendTelegramCharts({
      charts: output().charts,
      chatId: "12345",
      messageThreadId: 7,
      botToken: "123:ABC",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      render: async () => png,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendPhoto");
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("12345");
    expect(form.get("message_thread_id")).toBe("7");
    expect(form.get("caption")).toBe("Total por mes");
    const photo = form.get("photo") as File;
    expect(photo.type).toBe("image/png");
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(png);
  });

  it("does not leak the bot token in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("Bad Request", { status: 400 }));
    const error = await sendTelegramCharts({
      charts: output().charts,
      chatId: "1",
      botToken: "123:SECRET",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      render: async () => new Uint8Array([1]),
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("SECRET");
  });
});
