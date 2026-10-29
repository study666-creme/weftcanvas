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

describe("OpenAICompatibleClient listModels", () => {
  function listClient(handler: (url: string) => Response) {
    const requestedUrls: string[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://upstream.test/v1",
      apiKey: "test-key",
      model: "gpt-5.6",
      fetchImpl: (async (url: string | URL | Request) => {
        requestedUrls.push(String(url));
        return handler(String(url));
      }) as typeof fetch,
    });
    return { client, requestedUrls };
  }

  it("reads trimmed unique ids from the upstream /v1/models payload", async () => {
    const { client, requestedUrls } = listClient(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: " glm-5.3 " }, { id: "Kimi-K2.6" }, { id: "glm-5.3" }, { id: "" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(client.listModels()).resolves.toEqual(["glm-5.3", "Kimi-K2.6"]);
    expect(requestedUrls[0]).toBe("https://upstream.test/v1/models");
  });

  it("normalises a /v1-less base url onto /v1/models", async () => {
    const requestedUrls: string[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: "https://upstream.test",
      apiKey: "test-key",
      model: "gpt-5.6",
      fetchImpl: (async (url: string | URL | Request) => {
        requestedUrls.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await client.listModels();
    expect(requestedUrls[0]).toBe("https://upstream.test/v1/models");
  });

  it("fails with a retryable MODEL_UNAVAILABLE when the upstream rejects", async () => {
    const { client } = listClient(
      () => new Response(JSON.stringify({ error: { message: "no" } }), { status: 404 }),
    );

    await expect(client.listModels()).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      retryable: true,
    });
  });
});
