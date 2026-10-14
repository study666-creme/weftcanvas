import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";
import { main, validateCatalog } from "./upstream-conformance.mjs";

const { buildNonMjSourceCatalog } = await tsImport(
  "../src/catalog/nonmj-catalog-fixture.ts",
  import.meta.url,
);

test("uses the API normalizer to accept a selectable catalog", () => {
  assert.ok(validateCatalog(buildNonMjSourceCatalog()).length > 0);
});

for (const [name, mutate] of [
  ["missing endpoint", (model) => delete model.endpoint],
  ["unsupported endpoint", (model) => (model.endpoint = "/v1/unsupported")],
  [
    "missing fixed model mapping",
    (model) => (model.parameters = model.parameters.filter((p) => p.name !== "model")),
  ],
  ["missing pricing", (model) => delete model.pricing],
  ["invalid pricing", (model) => (model.pricing.currency = "USD")],
]) {
  test(`rejects a catalog with ${name}`, () => {
    const value = buildNonMjSourceCatalog();
    value.models = [value.models[0]];
    mutate(value.models[0]);
    assert.throws(() => validateCatalog(value));
  });
}

test("CLI fails closed on unreadable and unusable catalogs without generation calls", async () => {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push([request.method, request.url]);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/unavailable") {
      response.writeHead(503).end("{}");
      return;
    }
    const value = buildNonMjSourceCatalog();
    if (request.url === "/invalid") {
      value.models = [value.models[0]];
      delete value.models[0].endpoint;
    }
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await main(["--catalog-url", `${base}/valid`], () => {}), 0);
    assert.equal(await main(["--catalog-url", `${base}/invalid`], () => {}), 1);
    assert.equal(await main(["--catalog-url", `${base}/unavailable`], () => {}), 1);
    assert.equal(
      await main(
        ["--catalog-url", `${base}/valid`, "--pricing-url", `${base}/unavailable`],
        () => {},
      ),
      1,
    );
    assert.ok(calls.every(([method]) => method === "GET"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
