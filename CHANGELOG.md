# Changelog

## Unreleased

- 中转站接入：模型识别、未知模型标注、选择集与目录变化提示，以及认证、端点、编码、轮询和响应解析配置。
- 修复 MiniMax 文本模型与混元图像模型被归为视频的问题，支持数字任务 ID 与状态码。
- 上游验收探针复用 API 目录归一化，无法读取或不满足执行契约的目录返回失败。
- 修复状态待确认的旧任务误触发专注模式；更新 BYOK 与项目恢复浏览器测试。
- Docker 保留工作区依赖，API 与 worker 共用持久化目录，补齐 worker 配置和后台代理。
- 重整 README、接入文档与贡献规范；CI 增加构建、浏览器 smoke 和 Docker 持久化检查。

## v0.1.0 — 2026-10-12

首个公开版本（**纬线无限画布 / Weftcanvas**）。

### 包含

- **画布核心**：节点、连线、磁性端口、分组、撤销重做、小屏地图、指针反馈、
  两种配色（石墨 / 墨黑）、Three.js 导演台。
- **本地优先的项目库**：项目存 localStorage、媒体存 IndexedDB，断网可编辑。
- **BYOK 直连**：设置里填自己的 OpenAI 兼容 / Gemini 端点，请求浏览器直发，
  Key 只落本机 `localStorage`。
- **Agent**：右侧回复工作区 + 本地连接器（Codex 走 MCP 操作当前画布、
  Blender 走 `weftcanvas_bridge` 插件）。
- **持久化生成 worker**：PostgreSQL 队列、租约与 fencing。
- **一键自托管**：`Dockerfile` + `docker-compose.yml`（`web + api + postgres`）。见
  [`docs/DEPLOYING.md`](docs/DEPLOYING.md)。
- **插件 SDK** + 官方示例插件「批量拆单」（注册表驱动，随包 chunk 懒加载）。
- **演示目录**：无 API 时模型选择器给出官方名占位条目，工作台开箱不空。

### 说明

- 演示 GIF 与独立文档站待补；项目截图见 README。
- **AGPL-3.0**；闭源商用可购商业授权（见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)）。
- 来源为独立实现（clean-origin），发布前已按 PROVENANCE 清单跑相似度扫描取证。
