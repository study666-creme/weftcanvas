import assert from "node:assert/strict";
import test from "node:test";

import {
  collectChannelModelIds,
  extractContractPricing,
  inferModality,
  mapChannelsToCatalog,
} from "./newapi-catalog-export.mjs";

// 小夹具：stock New API 渠道对象的形状（省略了密钥等敏感字段）。
// `models` 兼容逗号分隔字符串（常见）与数组（部分版本）。
const CHANNELS = [
  {
    id: 1,
    type: 1,
    name: "openai",
    group: "default",
    status: 1,
    models: "gpt-4o-mini, gpt-image-1",
  },
  { id: 2, type: 26, name: "video", group: "vip", status: 1, models: ["sora-1", "unknown-model"] },
  { id: 3, type: 3, name: "retired", group: "default", status: 2, models: "legacy-only" },
];

test("token 视图是权威模型集合，按 id 排序且默认不带 pricing", () => {
  const { models, stats } = mapChannelsToCatalog({
    channels: CHANNELS,
    usableModelIds: ["sora-1", "gpt-image-1", "gpt-4o-mini"],
  });

  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-4o-mini", "gpt-image-1", "sora-1"],
  );

  // 画布归一化实际要求的执行字段：endpoint / output / 固定 model 路由参数。
  const endpointByModality = {
    text: "/v1/chat/completions",
    image: "/v1/images/generations",
    video: "/v1/videos",
  };
  for (const model of models) {
    assert.equal(model.operation, "generate");
    assert.equal(model.selectable, true);
    assert.deepEqual(model.public, { id: model.id, label: model.id, description: "" });
    assert.deepEqual(model.endpoint, {
      method: "POST",
      path: endpointByModality[model.modality],
      content_type: "application/json",
    });
    assert.deepEqual(model.output, { type: model.modality });
    const modelParameter = model.parameters.find((parameter) => parameter.name === "model");
    assert.equal(modelParameter.fixed, model.id);
    assert.equal("pricing" in model, false, "缺价时不能写 pricing 键（null 会被合同拒收）");
  }

  assert.deepEqual(stats, {
    total: 3,
    priced: 0,
    unpriced: 3,
    byModality: { text: 1, image: 1, video: 1, audio: 0 },
    channelOnly: 0,
  });
});

test("没有 token 视图时回退到渠道并集，并标记 channelOnly", () => {
  const { models, stats } = mapChannelsToCatalog({ channels: CHANNELS });

  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-4o-mini", "gpt-image-1", "legacy-only", "sora-1", "unknown-model"].sort((a, b) =>
      a.localeCompare(b),
    ),
  );
  assert.equal(stats.total, 5);
  assert.equal(stats.channelOnly, 5);
});

test("a successfully read empty token view never falls back to administrator channels", () => {
  const { models, stats } = mapChannelsToCatalog({ channels: CHANNELS, usableModelIds: [] });
  assert.deepEqual(models, []);
  assert.equal(stats.total, 0);
  assert.equal(inferModality("MiniMax-M2.1"), "text");
  assert.equal(inferModality("hunyuan-image-3.0"), "image");
});

test("合同形状的 pricing 原样透传，非法 pricing 被丢弃", () => {
  const { models, stats } = mapChannelsToCatalog({
    channels: CHANNELS,
    usableModelIds: ["gpt-image-1", "gpt-4o-mini", "sora-1"],
    pricingByModel: {
      "gpt-image-1": { mode: "fixed", unit: "image", currency: "CNY", credits: 15 },
      // 非 CNY + 非法 unit：必须被丢弃，绝不“修正”成合法值。
      "gpt-4o-mini": { mode: "fixed", unit: "bogus", currency: "USD", credits: 1 },
    },
  });

  const byId = Object.fromEntries(models.map((model) => [model.id, model]));
  assert.deepEqual(byId["gpt-image-1"].pricing, {
    mode: "fixed",
    unit: "image",
    currency: "CNY",
    credits: 15,
  });
  assert.equal("pricing" in byId["gpt-4o-mini"], false);
  assert.equal("pricing" in byId["sora-1"], false);
  assert.equal(stats.priced, 1);
  assert.equal(stats.unpriced, 2);
});

test("collectChannelModelIds 同时接受字符串与数组，并去重", () => {
  assert.deepEqual(collectChannelModelIds(CHANNELS), [
    "gpt-4o-mini",
    "gpt-image-1",
    "sora-1",
    "unknown-model",
    "legacy-only",
  ]);
});

test("inferModality 保守：明确族才改判，其余（含音频）留 text", () => {
  assert.equal(inferModality("gpt-4o-mini"), "text");
  assert.equal(inferModality("some-mystery-model"), "text");
  assert.equal(inferModality("tts-1"), "text", "音频族刻意不猜，交给运营手动改");
  assert.equal(inferModality("gpt-image-1"), "image");
  assert.equal(inferModality("doubao-seedream-3"), "image");
  assert.equal(inferModality("sora-1"), "video");
  assert.equal(inferModality("grok-imagine-video"), "video");
});

test("extractContractPricing 只认可合同形状", () => {
  assert.ok(extractContractPricing({ mode: "tiered", unit: "request", currency: "CNY" }));
  assert.equal(
    extractContractPricing({ mode: "nope", unit: "request", currency: "CNY" }),
    undefined,
  );
  assert.equal(extractContractPricing({ mode: "fixed", unit: "request" }), undefined);
  assert.equal(extractContractPricing(null), undefined);
  assert.equal(extractContractPricing("CNY"), undefined);
});
