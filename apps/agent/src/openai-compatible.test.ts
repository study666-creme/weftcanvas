import { describe, expect, it } from "vitest";

import { OpenAICompatibleClient } from "./openai-compatible.js";

function clientWithCapture(capture: { body?: Record<string, unknown> }) {
  return new OpenAICompatibleClient({
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "gpt-5.6",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
}

describe("OpenAICompatibleClient reasoning effort", () => {
  it("forwards the selected thinking level as reasoning_effort", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const client = clientWithCapture(capture);

    await client.complete([{ role: "user", content: "hi" }], "gpt-5.6", undefined, "high");

    expect(capture.body).toMatchObject({ model: "gpt-5.6", reasoning_effort: "high" });
  });

  it("omits reasoning_effort when the model has no thinking control", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const client = clientWithCapture(capture);

    await client.complete([{ role: "user", content: "hi" }], "gpt-5.6");

    expect(capture.body).not.toHaveProperty("reasoning_effort");
  });
});
