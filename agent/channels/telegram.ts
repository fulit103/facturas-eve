import { telegramChannel } from "eve/channels/telegram";

import { MAX_UPLOAD_BYTES } from "#lib/attachments.js";

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
 */
export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME,
  uploadPolicy: {
    // Telegram often returns application/octet-stream after getFile even for PDFs.
    // Strict validation happens later in attachments.ts via magic bytes.
    allowedMediaTypes: ["application/*", "image/jpeg", "image/png"],
    maxBytes: MAX_UPLOAD_BYTES,
  },
});
