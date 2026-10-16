import { configDefaults, defineConfig } from "vitest/config";

// CLI tests use node:test and run separately through test:scripts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "scripts/**"],
  },
});
