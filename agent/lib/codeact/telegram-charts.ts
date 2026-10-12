import { renderChartPng } from "#lib/codeact/chart-render.js";
import type { ChartOutput } from "#lib/codeact/js-engine.js";

/**
 * Delivers `execute_js` charts to Telegram as photos.
 *
 * Telegram cannot show a Vega-Lite spec, so each chart is rendered to PNG in
 * the app runtime and uploaded with `sendPhoto`. eve's Telegram handle only
 * issues JSON Bot API calls, and uploading bytes needs multipart/form-data,
 * so this calls the Bot API directly with the channel's token.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const CAPTION_MAX_LENGTH = 1024;

/** Extracts charts from an `action.result` event payload, if any. */
export function chartsFromActionResult(result: unknown): ChartOutput[] {
  if (typeof result !== "object" || result === null) return [];
  const candidate = result as { kind?: unknown; toolName?: unknown; isError?: unknown; output?: unknown };
  if (candidate.kind !== "tool-result" || candidate.toolName !== "execute_js") return [];
  if (candidate.isError === true) return [];
  const output = candidate.output as { charts?: unknown } | null;
  if (output === null || typeof output !== "object" || !Array.isArray(output.charts)) return [];
  return (output.charts as ChartOutput[]).filter(
    (chart) => typeof chart?.spec === "object" && chart.spec !== null,
  );
}

export async function sendTelegramCharts(input: {
  charts: readonly ChartOutput[];
  chatId: string;
  messageThreadId?: number;
  botToken: string;
  fetchImpl?: typeof fetch;
  render?: (chart: ChartOutput) => Promise<Uint8Array>;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const render = input.render ?? ((chart: ChartOutput) => renderChartPng(chart.spec));

  for (const chart of input.charts) {
    const png = await render(chart);
    const form = new FormData();
    form.set("chat_id", input.chatId);
    if (input.messageThreadId !== undefined) {
      form.set("message_thread_id", String(input.messageThreadId));
    }
    form.set("caption", chart.title.slice(0, CAPTION_MAX_LENGTH));
    form.set("photo", new Blob([Buffer.from(png)], { type: "image/png" }), `${chart.id}.png`);

    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${input.botToken}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      // Never include the URL: it contains the bot token.
      const body = await response.text().catch(() => "");
      throw new Error(`Telegram sendPhoto failed (${response.status}): ${body.slice(0, 200)}`);
    }
  }
}
