#!/usr/bin/env node
/**
 * 本地 mock 上游：给 BYOK 两档接入做离线验证用（无依赖，只有 node:http）。
 *
 * 存在的理由：真机验证「兼容档 / 协议档案」需要**一个能应答的上游**，而我们的开发机、
 * CI 都不该、也不会连真实中转站（要真 key、要花钱、还受风控）。这个脚本提供最小可用的
 * 假上游：模型列表、合同目录、文本/图片/视频提交与轮询，并开放两个开关专门用来压
 * 协议档案的边界：
 *
 *   --video standard  OpenAI 兼容视频：POST /v1/videos → {id,status,progress}
 *                     → GET /v1/videos/{id} → 完成时带 outputs.0.content_url
 *   --video custom    非标准视频：POST /v1/videos → {data:{task:{id},state:0}}
 *                     → GET /v1/tasks/{id} → 数字状态 / 结果在 data.output.video_url
 *                     （用来验证 poll.urlTemplate / statusPaths / successValues /
 *                     resultUrlPaths 这些覆盖项真的生效）
 *   --auth header     要求 x-api-key 而不是 Authorization: Bearer
 *   --auth query      要求 ?key=<key>
 *   --no-catalog      不提供 /api/model-catalog（只有裸 /v1/models，模拟 stock 中转站）
 *
 * 两个特殊模型 id，专门用来演示/验证前端能力：
 *   mock-error   文本提交直接返回 400 `{code:4001, msg:"余额不足"}`——演示「错误点路径」
 *   vendor-mystery-model  知识库不认识的 id——演示「未识别」标注与手动归类
 *
 * 用法：
 *   node apps/web/scripts/mock-upstream.mjs --port 4310 [--video custom] [--auth header]
 * 然后在画布「设置 → API 配置」里填 http://127.0.0.1:4310 与 --auth 对应的 key
 * （默认 accept 任意非空 key；用 --key 固定一个）。
 *
 * 纪律：这是开发工具，只绑定回环地址、只应答、不代理、不记录 key；不要把它接到公网。
 */

import { createServer } from "node:http";

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(readFlag("port", "4310"));
const videoMode = readFlag("video", "standard");
const authStyle = readFlag("auth", "bearer");
const expectedKey = readFlag("key", "");
const provideCatalog = !args.includes("--no-catalog");

/** 视频任务表：submit 记一条，poll 推进状态。 */
const videoTasks = new Map();
const IMAGE_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const MODELS = [
  { id: "mock-text", modality: "text" },
  { id: "mock-image", modality: "image" },
  { id: "doubao-seedance-2.0", modality: "video" },
  { id: "vendor-mystery-model", modality: "text" },
];

function send(response, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...headers,
  });
  response.end(body);
}

function authorized(request, url) {
  if (!expectedKey) return true;
  if (authStyle === "header") return request.headers["x-api-key"] === expectedKey;
  if (authStyle === "query") return url.searchParams.get("key") === expectedKey;
  return request.headers.authorization === `Bearer ${expectedKey}`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}

/** 合同形状的目录（UPSTREAM-CONTRACT.md）：只有当上游愿意发布时才给。 */
function contractCatalog() {
  const now = new Date().toISOString();
  const pricing = {
    mode: "fixed",
    unit: "request",
    currency: "CNY",
    credits_per_yuan: 1,
    base_credits: 15,
  };
  return {
    success: true,
    version: "mock-catalog-v1",
    capability_version: "mock-cap-v1",
    pricing_version: "mock-price-v1",
    fetched_at: now,
    models: MODELS.map((model, index) => ({
      id: model.id,
      modality: model.modality,
      operation: "generate",
      endpoint: {
        method: "POST",
        path:
          model.modality === "image"
            ? "/v1/images/generations"
            : model.modality === "video"
              ? "/v1/videos"
              : "/v1/chat/completions",
        content_type: "application/json",
      },
      output: { type: model.modality, count: { fixed: 1 } },
      public: { id: model.id, label: `Mock ${model.id}`, description: "本地 mock 上游" },
      selectable: true,
      order: index,
      parameters: [
        { name: "model", type: "string", fixed: model.id },
        { name: "prompt", type: "string", required: true, label: "提示词" },
      ],
      pricing,
    })),
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "OPTIONS") return send(response, 204, "");
  const path = url.pathname;

  if (path === "/v1/models" || (path === "/api/model-catalog" && provideCatalog === false)) {
    if (!authorized(request, url))
      return send(response, 401, { error: { message: "Invalid token" } });
    if (path === "/v1/models")
      return send(response, 200, {
        object: "list",
        data: MODELS.map((model) => ({ id: model.id, object: "model" })),
      });
    return send(response, 404, { error: { message: "no catalog" } });
  }

  if (path === "/api/model-catalog") {
    if (!authorized(request, url))
      return send(response, 401, { error: { message: "Invalid token" } });
    if (!provideCatalog) return send(response, 404, { error: { message: "no catalog" } });
    return send(response, 200, contractCatalog());
  }

  if (path === "/v1/chat/completions") {
    if (!authorized(request, url))
      return send(response, 401, { error: { message: "Invalid token" } });
    const body = await readJson(request);
    // 用 id 为 mock-error 的模型专门演示「错误点路径」：中转站常见的 {code, msg} 形状。
    if (body.model === "mock-error")
      return send(response, 400, { code: 4001, msg: "余额不足（mock 上游模拟）" });
    return send(response, 200, {
      choices: [
        { message: { role: "assistant", content: `mock reply to: ${String(body.prompt ?? "")}` } },
      ],
    });
  }

  if (path === "/v1/images/generations") {
    if (!authorized(request, url))
      return send(response, 401, { error: { message: "Invalid token" } });
    await readJson(request);
    return send(response, 200, { data: [{ b64_json: IMAGE_PIXEL }] });
  }

  if (path === "/v1/videos" && request.method === "POST") {
    if (!authorized(request, url))
      return send(response, 401, { error: { message: "Invalid token" } });
    const body = await readJson(request);
    const taskId = `task_${videoTasks.size + 1}`;
    const task = { id: taskId, polls: 0, received: body };
    videoTasks.set(taskId, task);
    if (videoMode === "custom")
      return send(response, 200, { data: { task: { id: taskId }, state: 0, percent: 0 } });
    return send(response, 200, { id: taskId, task_id: taskId, status: "queued", progress: 0 });
  }

  const standardPoll = path.match(/^\/v1\/videos\/([^/]+)$/);
  const customPoll = path.match(/^\/v1\/tasks\/([^/]+)$/);
  if ((standardPoll || customPoll) && request.method === "GET") {
    if (!authorized(request, url))
      return send(response, 401, { error: { message: "Invalid token" } });
    const taskId = decodeURIComponent((standardPoll ?? customPoll)[1]);
    const task = videoTasks.get(taskId);
    if (!task) return send(response, 404, { error: { message: "unknown task" } });
    task.polls += 1;
    const done = task.polls >= 2;
    const resultUrl = `http://127.0.0.1:${port}/mock-result.mp4`;
    if (customPoll)
      return send(response, 200, {
        data: {
          task: { id: taskId },
          state: done ? 2 : 1,
          percent: done ? 100 : 50,
          output: { video_url: resultUrl },
        },
      });
    return send(response, 200, {
      id: taskId,
      status: done ? "completed" : "processing",
      progress: done ? 100 : 50,
      ...(done ? { outputs: [{ content_url: resultUrl }] } : {}),
    });
  }

  if (path === "/v1/videos" && request.method === "GET") {
    if (!authorized(request, url))
      return send(response, 401, { error: { message: "Invalid token" } });
    return send(response, 405, { error: { message: "use POST to submit" } });
  }

  if (path === "/mock-result.mp4") {
    // 一字节级假视频：够验证"结果取回 → 下载 → 落库"链路。
    response.writeHead(200, { "Content-Type": "video/mp4", "Access-Control-Allow-Origin": "*" });
    return response.end(Buffer.from([0, 0, 0, 24]));
  }

  return send(response, 404, { error: { message: `no route for ${request.method} ${path}` } });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `mock upstream on http://127.0.0.1:${port}\n` +
      `  video=${videoMode} auth=${authStyle}${expectedKey ? "" : " (任意非空 key)"} catalog=${provideCatalog ? "yes" : "no"}\n`,
  );
});
