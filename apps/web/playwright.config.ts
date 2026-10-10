import { defineConfig } from "@playwright/test";
import { resolvePlaywrightPort } from "./playwright-port";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const port = resolvePlaywrightPort(process.env.PLAYWRIGHT_PORT);
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const productionZeroCost = process.env.PLAYWRIGHT_PRODUCTION_ZERO_COST === "1";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "../../test-results/playwright",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    serviceWorkers: productionZeroCost ? "block" : "allow",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: externalBaseUrl ? undefined : {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    // A listener on this port may belong to a different worktree. Failing
    // loudly is safer than validating or releasing a stale Canvas bundle.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
