import { defineState } from "eve/context";

import type { StoreSnapshot } from "#lib/codeact/js-engine.js";

/**
 * `store` from `execute_js`, persisted per durable session. Every conversation
 * (a Telegram chat, a Web Chat session) has its own slot, so data never
 * crosses between users. Values are JSON strings capped by the engine.
 */
export const codeActStore = defineState<{ values: StoreSnapshot }>("facturas.codeact.store", () => ({
  values: {},
}));
