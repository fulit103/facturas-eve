import { resolveTelegramBotToken, telegramChannel } from "eve/channels/telegram";

import { MAX_UPLOAD_BYTES } from "#lib/attachments.js";
import { chartsFromActionResult, sendTelegramCharts } from "#lib/codeact/telegram-charts.js";

/**
 * Telegram surface for the invoice agent.
 *
 * Mounts `POST /eve/v1/telegram` and verifies the
 * `X-Telegram-Bot-Api-Secret-Token` header before trusting any update. Reads
 * `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET_TOKEN` from the environment.
 *
 * `uploadPolicy` is the first of two gates: it stops disallowed media types and
 * oversized files at the webhook, before eve fetches them via `getFile`. The
 * second gate lives in `extract_invoice`, which re-checks the real bytes.
 *
 * Charts produced by `execute_js` are rendered to PNG and sent as photos as
 * soon as the tool finishes, before the agent's text answer.
 */
export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME,
  uploadPolicy: {
    // Telegram often returns application/octet-stream after getFile even for PDFs.
    // Strict validation happens later in attachments.ts via magic bytes.
    allowedMediaTypes: ["application/*", "image/jpeg", "image/png"],
    maxBytes: MAX_UPLOAD_BYTES,
  },
  events: {
    async "action.result"(data, channel) {
      if (data.status === "failed") return;
      const charts = chartsFromActionResult(data.result);
      if (charts.length === 0 || channel.telegram.chatId === "") return;
      try {
        await sendTelegramCharts({
          charts,
          chatId: channel.telegram.chatId,
          messageThreadId: channel.telegram.messageThreadId,
          botToken: await resolveTelegramBotToken(),
        });
      } catch (error) {
        console.error("[telegram] could not deliver execute_js charts", error);
      }
    },
  },
});
