# Agent 外部连接：Codex 与 Blender

## 两种形态：先看这一节

这套连接有两种落地形态，**取决于 Agent 运行时跑在哪里**：

| 形态               | 运行时位置     | 适用场景                             | 状态                                  |
| ------------------ | -------------- | ------------------------------------ | ------------------------------------- |
| **本机运行时**     | 用户自己的机器 | 本地开发、自托管（`pnpm dev:agent`） | 已实现（下面的数据流章节）            |
| **用户侧反向连接** | 服务端只做投递 | 托管站点的用户                       | 已上线：Blender 与 Codex 两条通道都通 |

**为什么托管站点必须用反向连接**：托管站点上 `AGENT_RUNTIME_URL` 指向的是**服务器**上的
运行时（`weftcanvas-agent.service`，监听 `127.0.0.1:8790`，不对公网暴露）。服务器上
既没有 Blender 也没有 Codex，也不该有——那是用户机器上的软件。浏览器和服务器都无法在用户
电脑上执行进程，所以必须由**用户机器上的组件主动连出来**。

反向连接的约定：

- 每个用户在画布面板里生成一个**只属于自己、可撤销**的配对令牌（服务端只存 sha256）；
- 用户机器上的 Blender 插件带着令牌主动轮询 `POST /api/external/v1/connectors/poll`
  领取任务，执行完 `POST /api/external/v1/connectors/results` 回传结果；
- 令牌**只能领取/回传该用户自己的任务**，拿不到别人的任务，也不携带任何画布写权限——
  画布写入仍然只走浏览器侧的会话 API。但令牌等同该用户机器上的代码执行权限，不要分享。
- 面板的「测试连接」走会话侧的 `POST /api/v1/agent/connectors/tasks`，在用户机器上跑一条
  `ping` 并等回执；超时/离线都会如实返回 `timeout` / `disconnected`，不伪造成功。

**当前限制**（明确的后续项）：

1. 配对记录放在 API 进程内存里：单实例部署可用，**进程重启后用户需要重新配对**。
   持久化（Postgres 表或状态文件）是下一步。
2. Codex 没有心跳：它按需调用 MCP，所以面板对 Codex 只显示"已配对/未配对"，
   没有"在线/离线"，也没有「测试连接」（那条通道是给会轮询的客户端用的）。
3. 外部连接下发的画布指令由 **浏览器** 执行，所以画布页面必须开着；页面关掉时
   指令会明确超时返回，不会伪造成功。

## 本机运行时形态（开发 / 自托管）

两个连接都在 **本机** 生效，都归 `apps/agent`（私有 Agent 运行时）所有：
浏览器只显示状态与开关，真正的进程/端口探测与执行发生在运行时进程里。

- **Codex 连接**：把当前画布通过 MCP 暴露给本机 Codex，让 Codex 直接建节点、
  改正文、连线、调整视口。方向是 Codex → 画布。
- **Blender 连接**：让画布 Agent 在本机 Blender 里执行 Python，用于建模、材质
  与渲染准备。方向是 Agent → Blender。

## 数据流

### Codex → 画布

```
Codex CLI ──MCP(stdio)──▶ apps/agent/mcp/canvas-mcp.mjs
                              │  HTTP + bearer（运行时的 AGENT_RUNTIME_TOKEN）
                              ▼
                        Agent 运行时 /internal/v1/canvas-commands
                              │  入队并等待回执（CanvasControlQueue）
                              ▼
   API /api/v1/agent/canvas-control/* （会话鉴权代理）
                              ▲
                              │  浏览器轮询 + 上报画布摘要
                     CanvasControlBridge（canvas-workspace 常驻）
                              │  applyAgentActions（与 Agent 同一套执行与去重）
                              ▼
                          画布落盘 → 回执原路返回
```

要点：

- 画布操作由 **浏览器** 执行，运行时与 MCP 进程都不持有画布状态。
- 去重键是 `${projectId}:${commandId}`，所以刷新页面、重复轮询都不会重复执行。
- 画布页面没打开时，指令会等待到超时并返回失败，不会伪造成功。
- 浏览器每次轮询都上报有界画布摘要（存活 90 秒），`canvas_read` 因此能读到真实
  节点 id；页面关掉后摘要会过期，不会把旧状态当成实时状态。
- 模型侧工具只使用 `packages/contracts` 的 `agentActionSchema`，没有新增画布写入口。

### Agent → Blender

```
Agent 对话 → API → apps/agent /internal/v1/runs
                        │  构建本轮工具（仅启用且可达的连接）
                        ▼
                  blender_run_python 工具
                        │  TCP 一行 JSON
                        ▼
         Blender 内的 weftcanvas_bridge.py（127.0.0.1:9876）
```

要点：

- 只有连接被显式打开、且探测可达时，工具才会出现在这一轮的提示词里。
  断开的连接不会变成模型眼里的"可用能力"。
- 工具调用走 `toolCalls` 字段，最多两轮；工具结果回灌给模型后由模型给出最终回复。
  有 `toolCalls` 时不允许同时有画布 `actions`，避免同一轮既有落盘又有本机副作用。
- Blender 桥接本机模式**只允许绑定回环地址**（127.0.0.1 / ::1 / localhost；面板里填
  其它地址会被明确拒绝启动，跨机使用请改用远程模式），且**每个请求都必须带访问令牌**：
  `run_python` 会在 Blender 主线程执行任意 Python，等同于把 Blender 交给能通过鉴权的
  一方控制。没有令牌或令牌不对的请求在进入执行队列之前就被拒绝（常量时间比较）。
  令牌由桥接生成在用户主目录的 `~/.weftcanvas-bridge/token`（0600；可用
  `WEFTCANVAS_BRIDGE_TOKEN_FILE` 改路径，或用 `WEFTCANVAS_BRIDGE_TOKEN` 直接指定），同机的
  Agent 运行时读同一个来源，因此一键连接仍然不需要用户手工配对；面板里的
  「重新生成令牌」让旧令牌立即失效。令牌不进 .blend、不进日志、不进 Git。
  认证回归测试在 `apps/agent/blender/bridge_auth_test.py`（开源 CI 里用 python3 跑）。

## 接入步骤（普通用户只需要点一个按钮）

在画布 Agent 抽屉里打开「外部连接」，点对应连接的 **连接** 按钮即可。运行时会
自己完成本机配置，并把"还需要做什么"直接写在按钮下面：

### Codex

点「连接」后，运行时会把画布 MCP 服务写进 Codex 的配置：

- 配置文件：`$CODEX_HOME/config.toml`，未设置时为 `~/.codex/config.toml`
  （Windows 是 `%USERPROFILE%\.codex\config.toml`）。
- 只替换 `[mcp_servers.weftcanvas]` 这一段，其它配置原样保留；写入前会把原文件
  备份成 `config.toml.weftcanvas-backup`。
- 写的是 `node <repo>/apps/agent/mcp/canvas-mcp.mjs`，并通过 env 传入
  `WEFTCANVAS_AGENT_URL` 与 `WEFTCANVAS_AGENT_TOKEN`。

Codex 只在启动时读取配置，所以面板会提示 **重启 Codex 后生效**。重启后让 Codex
调用 `canvas_read` 确认能读到节点，再做修改。

### Blender

点「连接」后，运行时按顺序做三件事：

1. 找到本机 Blender（`WEFTCANVAS_BLENDER_BIN` → PATH 上的 `blender` → 各平台默认安装路径）。
2. 把 `weftcanvas_bridge.py` 作为插件写进 Blender 的用户插件目录
   （Windows `%APPDATA%\Blender Foundation\Blender\<版本>\scripts\addons`；
   macOS `~/Library/Application Support/Blender/<版本>/scripts/addons`；
   Linux `~/.config/blender/<版本>/scripts/addons`，可用 `WEFTCANVAS_BLENDER_ADDONS_DIR` 覆盖）。
   插件里已经写进面板里配置的 `host:port`，用户不用再去 Blender 面板改。
3. 用一次 `blender --background --python-expr` 启用插件并保存偏好（内容没变时跳过这步），
   然后启动 Blender。插件带"随 Blender 自动启动"开关，之后每次打开 Blender 桥接都会自己起来。

没有找到 Blender 时不会假装成功，面板会直接说明并给出设置 `WEFTCANVAS_BLENDER_BIN` 的办法。

### 手动方式（可选）

不想让运行时改本机配置时，仍然可以手动接入：把上面的 MCP 配置自己写进 Codex，
或在 Blender 的 Preferences → Add-ons 里安装 `apps/agent/blender/weftcanvas_bridge.py`
（也可以在 Scripting 工作区直接 Run Script 临时启动一次）。

## 状态语义

面板上的状态都是真实探测结果，不伪造：

| 状态   | 含义                                                         |
| ------ | ------------------------------------------------------------ |
| 已关闭 | 连接未启用，运行时不会探测，也不会构建对应工具               |
| 已连接 | 探测可达（Codex：命令可执行；Blender：端口可连接）           |
| 未连上 | 已启用但探测失败；按钮下方的说明给出接入结果与可执行的下一步 |
| 异常   | 保留位；当前探测失败统一显示「未连上」                       |

## 边界与非目标

- 一键接入只做两件事：改 Codex 的 `config.toml` 里画布那一段（留备份），以及往
  Blender 用户插件目录写一个插件并启用它。不改系统 PATH、不动注册表、不装额外软件。
- 连接设置存在运行时进程内存里，重启回到环境变量默认值（`CODEX_BIN`、
  `BLENDER_BRIDGE_ADDRESS`、`*_CONNECTOR_ENABLED`）；已写入的 Codex 配置与已安装的
  Blender 插件会保留。
- 外部连接发起的画布写入 **不进入** Agent 的提案/确认流程：打开连接本身就是授权。
  浏览器会为每条指令弹出结果提示，用户可用撤销回退。
- 未做：Codex 侧的图像/视频生成、MCP 的 resources/prompts、Blender 场景回读接入工具
  （`scene_summary` 只在桥接里提供）。
- 生产（Cloudflare/Vercel）上运行时不存在，连接接口返回 `CONNECTORS_UNAVAILABLE`，
  不会假装可用。

## 反向连接协议（给用户机器上的客户端实现者）

鉴权：`Authorization: Bearer <配对令牌>`。

```
POST /api/external/v1/connectors/poll
  body {"connectorId":"blender","client":"blender-4.2"}      # client 仅用于展示
  200  {"ok":true,"data":{"tasks":[{schemaVersion,id,connectorId,method,params,createdAt}],"pollAfterMs":3000}}
  401  令牌无效/已撤销，或与 connectorId 不匹配

POST /api/external/v1/connectors/results
  body {"connectorId":"blender","taskId":"<uuid>","ok":true,"stdout":"...","error":null}
  200  {"ok":true,"data":{"accepted":true}}
  401  令牌无效，或这条任务不属于该令牌
```

- 任务**领取即出队**，不会重复投递；外部客户端崩溃时任务在等待上限后收敛为 `timeout`。
- `method` 目前是 `ping` 与 `run_python`；`run_python` 的 `params.code` 会在 Blender 主线程执行。
- 每个连接最多 8 条未结算任务，超出直接拒绝（面板会显示原因）。

会话侧（浏览器，用登录会话鉴权）：

```
POST   /api/v1/agent/connectors/pairing            {"connectorId"} → 明文令牌（只此一次）
DELETE /api/v1/agent/connectors/pairing/:id        → 撤销
GET    /api/v1/agent/connectors/clients            → 配对/在线状态
POST   /api/v1/agent/connectors/tasks              {"connectorId","method","params","waitMs"} → 跑一条并等结果
```

服务端实现：`apps/api/src/connectors/external-connector-service.ts`（令牌哈希存储、在线窗口
30 秒、任务队列与结算），路由在 `apps/api/src/app.ts`。

### 运行时 → API 的内部派发

```
POST /internal/v1/connectors/blender/run
  Authorization: Bearer <AGENT_RUNTIME_TOKEN>      # 与 API 共享的同一个令牌
  body {"ownerId":"<user id>","code":"..."}
  200  {"ok":true,"data":{"taskId","status":"completed|failed|timeout|disconnected","stdout","error"}}
  401  令牌不匹配（定长比较）
```

Agent 运行时在 `remoteConnectors.blender` 为真时用 `RemoteBlenderRunner` 调它，
把 Python 投递到该用户机器上的 Blender；否则退回本机 TCP 桥接（开发/自托管）。
生产需要在 `agent.env` 里设 `CANVAS_API_URL=http://127.0.0.1:8788`（本机开发默认 8787）。

### Codex（MCP over HTTP）

```
POST /api/external/v1/mcp
  Authorization: Bearer <codex 连接的配对令牌>
  JSON-RPC 2.0：initialize / notifications/initialized / ping / tools/list / tools/call
  工具：canvas_read、canvas_add_node、canvas_update_node、canvas_connect_nodes、
        canvas_select_nodes、canvas_group_nodes、canvas_set_viewport
```

工具调用经 `CanvasCommandBroker` 排队，由**用户浏览器**执行后回执；
`canvas_read` 读的是浏览器轮询时上报的画布摘要（90 秒内有效）。
