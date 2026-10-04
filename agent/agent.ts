import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.6-luna-fast",
  build: {
    // resvg (chart PNGs for Telegram) is a native addon: keep it out of the
    // bundle so the hosted output traces its platform binary.
    externalDependencies: ["@resvg/resvg-js"],
  },
});
