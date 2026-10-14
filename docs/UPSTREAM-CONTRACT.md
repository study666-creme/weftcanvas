# Upstream contract

The canvas does not ship a fixed list of models. It reads **your** model catalog
and follows it: list a model and it appears, rename it and the label changes,
change a price and quotes move. The only thing you publish is one JSON document.

This page is the whole contract. It is deliberately small, and it says what the
canvas **derives for you** so you do not have to match our internal shape.

## Verify first, read later

```bash
pnpm install --frozen-lockfile
pnpm --filter @weftcanvas/contracts build
node apps/api/scripts/upstream-conformance.mjs \
  --catalog-url https://your-relay.example.com/api/model-catalog \
  --api-base     https://your-relay.example.com \
  [--pricing-url https://your-relay.example.com/api/pricing] \
  [--video-inventory-url https://your-relay.example.com/api/video-inventory] \
  [--api-key sk-...]
```

It sends GET requests only and reuses the API's catalog normalizer to validate
routes, parameters, outputs and prices. Exit code `0` means the catalog contains
selectable models; `1` means a fetch or validation failure; `2` means invalid usage.
It reports skipped-row counts, not a per-model execution certification. Browser
CORS, credentials, channel availability and actual generation still need testing.
Explicit auxiliary URLs are checked for JSON reachability only. Credentials can
also be supplied through `CANVAS_UPSTREAM_API_KEY` without putting a key in the command.

## Point the canvas at your upstream

Set these on the `api` service (see [`docs/DEPLOYING.md`](DEPLOYING.md) for the
table): `CANVAS_API_PROVIDER=dev-test` plus
`CANVAS_UPSTREAM_CATALOG_URL` / `CANVAS_UPSTREAM_VIDEO_INVENTORY_URL` /
`CANVAS_UPSTREAM_PRICING_URL` / `CANVAS_UPSTREAM_API_BASE_URL`.

## The document

```jsonc
{
  "models": [
    {
      "id": "your-internal-model-id", // stable id you use upstream
      "modality": "image", // text | image | video | audio
      "operation": "generate",
      // 执行必需三项：端点、输出类型、以及固定住上游真实模型 id 的 model 参数。
      // 缺任一项这一行会被跳过；探针复用画布校验，不能通过的目录返回失败。
      "endpoint": {
        "method": "POST",
        "path": "/v1/images/generations",
        "content_type": "application/json",
      },
      "output": { "type": "image", "count": { "fixed": 1 } },
      "public": {
        // what the user sees
        "id": "your-public-id",
        "label": "显示名称",
        "description": "一句话说明",
      },
      "selectable": true, // false = keep it out of the picker
      "parameters": [
        { "name": "model", "type": "string", "fixed": "your-internal-model-id" },
        // 其余参数驱动选择器上的控件
        { "name": "prompt", "type": "string", "required": true, "label": "提示词" },
        {
          "name": "quality",
          "type": "string",
          "default": "2k",
          "options": ["1k", "2k", "4k"],
          "label": "分辨率",
        },
      ],
      "pricing": {
        "mode": "tiered", // fixed | tiered | token | tiered_token
        "unit": "image", // request | image | second | token
        "currency": "CNY",
        "credits_per_yuan": 100, // your credit unit → CNY
        "tiers": [{ "when": { "quality": "2k" }, "credits": 15 }],
      },
    },
  ],
}
```

`endpoint`, `output`, and the `fixed` `model` parameter are **required for
execution**; a row missing any of them is skipped (the probe lists exactly which
rows and why). The endpoint must be one of the canvas's execution paths for that
modality: `/v1/chat/completions` (text, audio), `/v1/images/generations` or
`/v1/midjourney/generations` (image), `/v1/videos` (video).

The remaining `parameters` are optional and drive the controls the user sees;
without them the canvas still lists the model and sends only the prompt.
`tiers[].when` keys are the parameter names above, so pricing and controls stay
in one place.

## What the canvas derives (you do not have to publish it)

These are the "letterhead" fields. Any of them may be missing, blank, or written
in camelCase instead of snake_case:

| Field                            | If you omit it                                      |
| -------------------------------- | --------------------------------------------------- |
| `success`                        | treated as `true` — a bare object is fine           |
| `fetched_at` / `fetchedAt`       | stamped when the canvas fetched it                  |
| `version` / `capability_version` | derived from the content, so it changes when you do |
| `pricing_version`                | derived from content                                |
| `credits_per_yuan` (top level)   | treated as `1` (display conversion only)            |

The model list itself may also be an OpenAI-style `data[]` array.

## What the canvas refuses to guess

**Per-model prices.** Money is not inferred: a row without a valid `pricing`
object is skipped, and a catalog in which nothing is priced is rejected outright
rather than published as an empty picker. The probe lists exactly which rows were
skipped and why.

If your upstream publishes only `/v1/models` (ids, no prices), the server-side
billing path cannot drive it. That case is covered by the canvas's browser-owned
API mode instead: each user connects their own OpenAI-compatible endpoint with
their own key, and the canvas never prices or charges. See
[`apps/web/README.md`](../apps/web/README.md).

## 给自托管者

如果你跑的是 stock New API（含 sub2api 等同类中转站）又**不想 fork** 它，可以用
`apps/api/scripts/newapi-catalog-export.mjs` 从它**已经发布**的内容生成上面这份目录，
无需改动中转站：

```bash
node apps/api/scripts/newapi-catalog-export.mjs \
  --api-base    https://your-relay.example.com \
  --admin-token sk-admin-... \
  [--admin-user <new-api 用户 id>] \
  [--api-key    sk-...] \
  [--out        ./model-catalog.json]
```

- **只读**：对中转站只发 GET（管理员渠道清单 `/api/channel/` + 用户可见模型
  `/v1/models`），绝不写入、绝不登录。
- **token 只留本地**：`--admin-token` / `--api-key` 只在本机进程内使用，不回显、
  不写进产物。
- **执行字段已就绪**：脚本会按模态确定性地写入画布归一化所需的执行字段
  （`endpoint`、固定到模型 id 的 `model` 路由参数、`output`），路由取自端点白名单；
  你只需要补 `pricing`。
- **不猜价格**：stock New API 不提供每模型的人民币价，所以产出的目录里每个模型都
  缺 `pricing`。脚本会在 stderr 明确提醒你补齐——补齐前本页上面说的"缺价格的行会
  被跳过"依然成立。
- 退出码：`0` 已产出目录；`1` 什么都没产出；`2` 用法错误。

把产出的 JSON 挂到任意静态地址（nginx / CF Worker）后，用**同一个**验收工具检查：

```bash
node apps/api/scripts/upstream-conformance.mjs \
  --catalog-url https://your-static-host.example.com/model-catalog.json
```

## Optional documents

- **Video inventory** (`CANVAS_UPSTREAM_VIDEO_INVENTORY_URL`): which video models
  currently have a working channel. Omit it and video models are published as
  declared in the catalog.
- **Pricing document** (`CANVAS_UPSTREAM_PRICING_URL`): upstream rates used as a
  reference for token-priced models.

## Why this shape

The canvas needs three things a picker cannot fake: **what models exist**, **what
the user can choose** (parameters), and **what a generation costs** (pricing).
Everything else is bookkeeping. Publishing those three is the whole integration
cost — no plugin, no code fork, and no need to match our internal file layout.
