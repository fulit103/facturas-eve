import type { ChartOutput } from "#lib/codeact/executor.js";

/**
 * Delivers `execute_python` charts to Telegram as photos.
 *
 * eve's Telegram handle only issues JSON Bot API calls, and uploading bytes
 * needs `multipart/form-data`, so this calls `sendPhoto` directly with the
 * same bot token the channel uses.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const CAPTION_MAX_LENGTH = 1024;

/** Extracts deliverable charts from an `action.result` event payload, if any. */
export function chartsFromActionResult(result: unknown): ChartOutput[] {
  if (typeof result !== "object" || result === null) return [];
  const candidate = result as { kind?: unknown; toolName?: unknown; isError?: unknown; output?: unknown };
  if (candidate.kind !== "tool-result" || candidate.toolName !== "execute_python") return [];
  if (candidate.isError === true) return [];
  const output = candidate.output as { charts?: unknown } | null;
  if (output === null || typeof output !== "object" || !Array.isArray(output.charts)) return [];
  return (output.charts as ChartOutput[]).filter(
    (chart) => typeof chart?.dataBase64 === "string" && chart.dataBase64 !== "",
  );
}

export async function sendTelegramCharts(input: {
  charts: readonly ChartOutput[];
  chatId: string;
  messageThreadId?: number;
  botToken: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  for (const chart of input.charts) {
    if (chart.dataBase64 === null) continue;
    const form = new FormData();
    form.set("chat_id", input.chatId);
    if (input.messageThreadId !== undefined) {
      form.set("message_thread_id", String(input.messageThreadId));
    }
    form.set("caption", chart.title.slice(0, CAPTION_MAX_LENGTH));
    form.set(
      "photo",
      new Blob([Buffer.from(chart.dataBase64, "base64")], { type: chart.mediaType }),
      `${chart.id}.png`,
    );

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
