import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const directory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@kachang/canvas-api/worker": resolve(directory, "../api/src/worker-exports.ts"),
    },
  },
});
