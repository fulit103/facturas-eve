import { telegramChannel } from "eve/channels/telegram";

import { ALLOWED_MEDIA_TYPES, MAX_UPLOAD_BYTES } from "#lib/attachments.js";

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
    allowedMediaTypes: [...ALLOWED_MEDIA_TYPES],
    maxBytes: MAX_UPLOAD_BYTES,
  },
});
