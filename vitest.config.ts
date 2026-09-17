import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const agentDir = fileURLToPath(new URL("./agent/", import.meta.url));

export default defineConfig({
  resolve: {
    // Mirrors the "#*" -> "./agent/*" subpath imports declared in package.json,
    // rewriting the ESM ".js" specifier onto the TypeScript source.
    alias: [{ find: /^#(.*)\.js$/u, replacement: `${agentDir}$1.ts` }],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
