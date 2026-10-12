import { expect, test as base } from "@playwright/test";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

export const test = base.extend<{ zeroCostNetworkGuard: void }>({
  zeroCostNetworkGuard: [
    async ({ context }, use, testInfo) => {
      if (process.env.PLAYWRIGHT_PRODUCTION_ZERO_COST !== "1") {
        await use();
        return;
      }

      const escapedMutations: string[] = [];
      const blockedTelemetry: string[] = [];
      const blockedApiReads: string[] = [];
      await context.route("**/*", async (route) => {
        const request = route.request();
        const method = request.method();
        const pathname = new URL(request.url()).pathname;

        if (READ_ONLY_METHODS.has(method) && pathname.startsWith("/api/")) {
          blockedApiReads.push(`${method} ${pathname}`);
          await route.abort("blockedbyclient");
          return;
        }

        if (!MUTATING_METHODS.has(method)) {
          await route.continue();
          return;
        }
        if (pathname === "/cdn-cgi/rum") {
          blockedTelemetry.push(`${method} ${pathname}`);
          await route.abort("blockedbyclient");
          return;
        }
        escapedMutations.push(`${method} ${pathname}`);
        await route.abort("blockedbyclient");
      });

      await use();
      await testInfo.attach("zero-cost-network-guard.json", {
        body: JSON.stringify({ escapedMutations, blockedTelemetry, blockedApiReads }, null, 2),
        contentType: "application/json",
      });
      expect(escapedMutations, "No unmocked mutation may reach production").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
