import { describe, expect, it, vi } from "vitest";

import type { ExecutionOutput } from "#lib/codeact/executor.js";
import { toModelView } from "#lib/codeact/model-view.js";
import { chartsFromActionResult, sendTelegramCharts } from "#lib/codeact/telegram-charts.js";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function output(overrides: Partial<ExecutionOutput> = {}): ExecutionOutput {
  return {
    ok: true,
    executionId: "exec1",
    stdout: "",
    stdoutTruncated: false,
    result: { kind: "text", text: "42", truncated: false },
    error: null,
    charts: [
      {
        id: "exec1-1",
        title: "Total por mes",
        mediaType: "image/png",
        path: "/workspace/.codeact/charts/exec1-1.png",
        width: 700,
        height: 400,
        dataBase64: PNG_BASE64,
      },
    ],
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
    variables: [{ name: "df", type: "DataFrame", shape: [42, 6] }],
    notPersisted: [],
    warnings: [],
    durationMs: 120,
    ...overrides,
  };
}

describe("toModelView", () => {
  it("keeps chart bytes out of the model context", () => {
    const view = toModelView(output());
    expect(JSON.stringify(view)).not.toContain(PNG_BASE64);
    expect(view.charts).toEqual([{ id: "exec1-1", title: "Total por mes", shownToUser: true }]);
    expect(view).not.toHaveProperty("stdout");
    expect(view).not.toHaveProperty("error");
  });

  it("adds a correction hint to errors", () => {
    const view = toModelView(
      output({
        ok: false,
        result: null,
        charts: [],
        error: { type: "KeyError", message: "'Monto'", line: 2, code_line: "df['Monto']", traceback: "" },
      }),
    );
    expect(view.error).toMatchObject({ type: "KeyError", line: 2 });
    expect((view.error as { hint: string }).hint).toContain("execute_python");
  });
});

describe("Telegram chart delivery", () => {
  it("extracts charts only from successful execute_python results", () => {
    const result = { kind: "tool-result", toolName: "execute_python", callId: "c1", output: output() };
    expect(chartsFromActionResult(result)).toHaveLength(1);
    expect(chartsFromActionResult({ ...result, toolName: "save_invoice" })).toEqual([]);
    expect(chartsFromActionResult({ ...result, isError: true })).toEqual([]);
    expect(chartsFromActionResult(null)).toEqual([]);
  });

  it("uploads each chart with sendPhoto as multipart", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await sendTelegramCharts({
      charts: output().charts,
      chatId: "12345",
      messageThreadId: 7,
      botToken: "123:ABC",
      fetchImpl: fetchImpl as unknown as typeof fetch,
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
    expect(Buffer.from(await photo.arrayBuffer()).toString("base64")).toBe(PNG_BASE64);
  });

  it("does not leak the bot token in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("Bad Request", { status: 400 }));
    const error = await sendTelegramCharts({
      charts: output().charts,
      chatId: "1",
      botToken: "123:SECRET",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("SECRET");
  });
});
