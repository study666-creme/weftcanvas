# AI Entry Guide

这是 AI 编码代理在本仓库应首先阅读的文件。做较大改动前请继续读
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`NOTICE.md`](NOTICE.md)。

## 仓库身份

自托管优先的 AI 创作画布：React + XYFlow 桌面画布、Hono API、持久化生成 worker、
私有 Agent 运行时。**桌面 Web 是当前优先项**；移动端有意推迟。

## 产品规则（不可协商）

- 画布手感是第一产品质量：指针、平移、缩放、节点拖动、选择、连线反馈必须即时。
- UI 保持安静、紧凑、石墨化、可读、可操作。不要加营销式构图、装饰性光斑、
  巨型卡片或常驻模糊层。
- 首屏动画不能有可感知延迟；优先使用合成器属性（opacity、transform），
  不要为看不见的动效保留整屏合成层。
- 节点是预览：不要加悬停文本输入、点击上传、缩放手柄或内部标题行。
  节点类型标签保持在节点左上外侧。
- 连线用克制的能量流动段，避免昂贵的辉光/模糊。
- **不得伪造**成功的生成、Agent 回复或已持久化状态：缺失的服务必须给出明确的
  不可用/错误状态。

## 安全与隐私边界

- 浏览器产物里不得包含模型密钥、私有路由、私有提示词、检索索引或服务端凭据。
- BYOK 是唯一例外：用户的 Key 只存在**该浏览器**的 `localStorage`，
  绝不写入源码、fixture、项目 JSON 或本仓库任何文件。
- Agent 只接收经过校验、有界的画布摘要；不读取 React 状态、DOM 状态、浏览器凭据、
  媒体字节或私有 URL。
- 不要向仓库、文档、fixture、截图或 Git 历史加入任何真实凭据、密码或生产令牌。

## 架构规则

跨运行时只通过 `packages/contracts` 里的版本化 schema 通信。浏览器、API、worker、
Agent 之间不得互相 import 内部状态。

## 工作方式

1. 先跑 `git status --short --branch`；工作区可能有用户改动，永不回退它们。
2. 先读实现与测试，再提重构。
3. 跨运行时载荷变化时**先改 contracts**。
4. 浏览器载荷保持公开、有界；鉴权与持久化状态迁移放服务端。
5. 按风险比例补单元 / API / 浏览器测试。
6. 用 Playwright 验证真实桌面 UI（含深色/浅色对比、溢出、几何与交互）。

## 命令

```bash
pnpm install
pnpm dev          # Web 4173 · API 8787
pnpm dev:agent    # Agent 运行时 8790（需配置 AGENT_RUNTIME_URL/TOKEN 与模型环境变量）
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

## 许可

本项目以 AGPL-3.0 发布。提交贡献即接受 [`CLA.md`](CLA.md)。闭源商用见
[`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md)。
