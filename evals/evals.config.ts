import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: "openai/gpt-5.6-luna" },
  // Document parsing plus structured extraction takes a while per turn.
  timeoutMs: 180_000,
  maxConcurrency: 2,
});
