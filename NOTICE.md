# NOTICE — 来源与归属

## 实现性质

Weftcanvas 是**独立实现（clean-room re-implementation）**：代码在本仓库独立编写，
不是任何其他画布项目的 fork，也不继承它们的 Git 历史与许可证义务。

## 致谢（灵感来源）

以下项目的公开设计与工程实践对我们在交互取舍与后端形态上有影响。
我们**没有**复制其代码；本仓库的对应实现均为独立编写。它们的许可以下如实标注：

- **infinite-canvas** — https://github.com/basketikun/infinite-canvas
  MIT License（2026-08-07 起）。影响面：无限画布的节点/连线交互形态、
  声明式节点扩展点、模型调用脚本的注入面设计、画布导入导出的信封格式、
  提示词源的标准 JSON 契约。
- **open-ai-canvas（影策）** — https://github.com/ddcat-ai/open-ai-canvas
  MIT License。影响面：数据库即队列的租约与 fencing 模型、密钥卫生管线
  （日志脱敏 / 流式红器 / SSRF 边界）、能力注册表作为唯一合同的思路。

如果你认为本仓库中有内容需要更正归属，请开 issue 或邮件 **2705367723@qq.com**，
我们会核实并更新本文档。

## 第三方依赖

运行时核心依赖均为宽松许可（React、Vite、Hono、three.js、Zod 等）。完整的依赖与
许可证清单见 `docs/DEPENDENCY-LICENSES.md` 及各包的依赖声明。

## 商标

"Weftcanvas / 纬线" 是本项目的名称。上述第三方项目名称与商标归其各自所有者所有，
本文档的致谢不构成任何形式的背书或授权关系。
