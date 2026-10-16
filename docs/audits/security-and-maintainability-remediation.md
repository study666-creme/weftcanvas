# 安全与可维护性修复报告（security-and-maintainability remediation）

> 审计执行时间：2026-10-16。书写点：私有仓 `canvas-next`（分支
> `fix/security-remediation`），经 `scripts/oss-split.mjs` 物化到开源仓
> `weftcanvas`（`sync:` 提交）。本报告同时适用于两棵树；品牌串按各自口径。
>
> 方法论：**先证明、后修复**——每项先在代码与测试里证实缺陷真实存在，再实施
> 最小且完整的修复，配针对性回归测试，独立提交。未证实的问题不做无据修改。

## 1. 修复总结

### 已修复（8 项，8 个提交）

| #   | 问题                                                                                                    | 严重度             | 提交      |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------ | --------- |
| 1   | Blender 本机桥接 TCP 端口无认证执行任意 Python，且可绑非回环地址                                        | **P0**（本机 RCE） | `fb9381b` |
| 2   | SSRF 守卫与实际连接目标脱节（DNS rebinding TOCTOU + 5 分钟缓存窗口；IPv6 字面量因方括号进不了地址判定） | **P0**             | `1a4039c` |
| 3   | 限流的客户端标识无条件信任 `CF-Connecting-IP` / `X-Forwarded-For` 首项——伪造头即可无限刷新限流桶        | **P1**             | `0505624` |
| 4   | 项目导入大小限制用 UTF-16 码元数冒充字节（中文文件实际放到 3 倍上限，且超大文件先读后判）               | P2                 | `d95de46` |
| 5   | Docker 自托管 nginx 零安全响应头，与正式托管（Pages `_headers`）不一致                                  | P1                 | `ed7d118` |
| 6   | 项目 JSON 导出不含媒体字节——用户无法凭导出文件复原作品（数据完整性缺口）                                | **P1**             | `c74f6d6` |
| 7   | 上述备份恢复的端到端验收（隔离存储 + 损坏包）                                                           | 验收               | `7cd49bf` |
| 8   | CI 对 25 条 PostgreSQL 集成测试静默跳过；浏览器 smoke 未覆盖备份恢复                                    | P1                 | `4b96c55` |

### 已核实不存在、未做修改（3 项）

- **运营后台 HTML 注入**：`apps/api/src/ops/admin-page.ts` 的用户字符串全部经
  `esc()`；数字类插值的值被 `modelOverridesSchema` 在读写两侧 zod 校验为数字。
  无可利用注入，按"不存在的敌人不改代码"原则未动。
- **浏览器侧 XSS 注入点**：全 web 源码 0 处
  `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function`；公告小标记
  子集的链接与图片全部过 `isSafeAnnouncementUrl`（协议白名单、拒协议相对，
  非法地址原样显示为文本）；`window.open` 均带 `noopener,noreferrer`。
- **BYOK 密钥泄漏路径**：密钥只存 `localStorage`（`custom-api-store` 的 v2 键，
  BYOK 的文档化例外）；项目导出、云项目载荷、备份 ZIP 均不含 BYOK 配置
  （备份模块序列化前专门断言）；`agent-conversation-export` 另有 `sk-`/`token=`
  脱敏（既有测试）。未发现新增泄漏路径。

### 未处理（带理由）

- **巨型模块拆分（P2，`app.ts` 约 4,000 行等）**：按修复计划自身的排序
  （"模块拆分属于低于安全修复的任务……应先完成安全和可靠性修复"），本轮完成
  安全与可靠性项后，剩余预算不足以支撑一次**可验证**的拆分（每次拆分需独立
  提交 + 全量回归）。另外两个最大的 web 目标文件
  （`direct-generation-studio.tsx`、`entry-gate.css`）当前有另一会话的未提交
  改动，此时重构必然制造冲突。首个建议切分见 §5。
- **敏感操作限流的多实例一致性**：`SensitiveActionGuard` 仍是进程内计数（注释
  已写明单实例 systemd 部署有效、多实例需换 `PostgresFixedWindowRateLimiter`）。
  生成 API 的限流已是 Postgres 固定窗口；把登录/注册也迁移过去需要迁移表 +
  热路径加一次库往返，收益只作用于"多实例"这一当前不存在的部署形态。列入
  残余风险 §4。
- **CSP 进一步收紧**：自托管与 Pages 均保持最小 CSP 集合（script-src /
  connect-src 不限）。收紧需要先过一遍 MediaPipe/Three.js/BYOK 的浏览器实测，
  盲改即"无理由破坏正常功能"。列入 §5 第 2 条。

## 2. 详细修复记录

### 2.1 Blender 本机桥接认证（P0）

- **问题**：`apps/agent/blender/weftcanvas_bridge.py`（公开树
  `weftcanvas_bridge.py`）本机 TCP 模式对 `run_python` **零认证**——任何能连上
  端口的本机进程都能在 Blender 主线程执行任意 Python；`weftcanvas_bridge_host`
  又是无校验场景属性，填 `0.0.0.0` 即对外放一个无认证 RCE 端口。
- **根因**：本机模式最初只考虑"同机 Agent 直连"的开发场景，把回环地址当成了
  鉴权替代（审计计划明确禁止的假设）。
- **修复**（`fb9381b`）：
  - 桥接在用户主目录生成 43 字符强随机令牌（`~/.weftcanvas-bridge/token`，POSIX
    0600；`WEFTCANVAS_BRIDGE_TOKEN_FILE` 改路径 / `WEFTCANVAS_BRIDGE_TOKEN` 直配）。
    令牌不进 .blend、不进日志、不进 Git、不进面板显示。
  - 每个请求在**进入执行队列之前**用 `hmac.compare_digest`（常量时间）校验
    顶层 `token` 字段；无令牌/错令牌/非字符串/藏在 `params` 里一律拒绝且不执行。
  - `start_bridge` 拒绝一切非回环地址（127.0.0.1 / ::1 / localhost），校验先于
    "已在运行"判断；跨机场景走远程配对模式（其 Bearer 鉴权原样未动）。
  - 面板显示令牌状态（不显示值）并提供"重新生成令牌"；旧令牌立即失效。
  - Agent 客户端（`blender-bridge.ts`）每次调用解析同一令牌源并随请求携带，
    桥接轮换令牌后无需重启自动跟进；一键装配（provision）流程零改动仍然成立。
  - 安全边界在插件 docstring 里写明：`run_python` 等同于把 Blender 所在机器交给
    通过鉴权的一方，令牌即本机代码执行权限。
- **测试**：agent 侧 10 条 TS 用例（令牌随请求携带、缺失令牌的明确报错、桥接侧
  认证失败文案透传、`resolveBridgeToken` env 优先级/文件缺失）；桥接侧
  `bridge_auth_test.py` 11 项验收（无令牌拒绝且不执行、错令牌拒绝、`params`
  内藏令牌不可绕过、非字符串令牌拒绝、正确令牌 ping/run_python 通过、
  `0.0.0.0`/`192.168.x`/`::` 绑定拒绝、轮换后旧令牌失效新令牌生效、令牌
  不出现在状态文案、POSIX 0600、env 直配不落盘），用 bpy 替身直打 TCP、
  不需要 Blender；已在 `python:3.12-slim` 容器与本机 CI（ubuntu python3）
  实跑通过。**首跑 CI 曾失败**（替身缺 `bpy.types`/`bpy.props`/`bpy.utils`，
  桥接在导入期就定义操作符类）——替身已修为宽容占位类，失败与本修复的经过
  见 §3.2 说明与 §4。
- **影响**：远程模式、一键装配、旧桥接 + 新客户端（头被忽略，照常工作）不受
  影响；新桥接 + 旧客户端会得到"认证失败"的明确提示并指引更新。
- **兼容性**：见 §6.1。

### 2.2 SSRF / DNS rebinding（P0）

- **问题**：`apps/api/src/identity/safe-host.ts` 的 `isBlockedTargetUrl` 先做
  DNS 解析判定"是否内网"，随后 `guardedFetch` 用 `fetch` **再解析一次**——两次
  解析之间就是 rebinding 窗口（校验时答公网、连接时答 169.254.169.254），且
  命中结果以"允许"缓存 5 分钟，窗口被放大。另：WHATWG URL 的 IPv6 主机名带
  方括号（`[::1]`），`net.isIP` 不认，内网 IPv6 字面量靠"域名解析失败"兜底
  而非按地址判定。
- **根因**：校验层与传输层分属两次独立解析，缺一个把守卫装进连接器的机制。
- **修复**（`1a4039c`）：
  - 新增 `apps/api/src/outbound/guarded-transport.ts`：受控 undici 连接器
    （`Agent` + `buildConnector({ lookup })`）把解析结果先过滤
    （`isPrivateIp`），**只有过滤后的地址交给 `net/tls.connect`**——校验目标
    与连接目标必然同源；字面量 IP 不走 DNS，另补一道同等的字面量检查。
    TLS 的 SNI/证书校验按主机名进行，不受影响。
  - `guardedFetch` 真实链路一律带受控 dispatcher（测试可注入复现 rebinding）。
  - `safe-host`：hostname 去方括号后按地址判定；`isPrivateIp` 补十六进制形式
    v4-mapped（`::ffff:a00:1`）、6to4（`2002::/16`）与 NAT64（`64:ff9b::/96`）
    的内嵌 IPv4 判定。
  - `weftcanvas-routes.ts`（私有路由）卡片图片代理收敛到 `guardedFetch`，删掉
    自写的跳转循环。
  - 复查出网面：音乐代拉、音频探测、第三方画布素材代拉本就全部汇聚
    `guardedFetch`（一处修复覆盖全链路）；LibTV/TapNow/UpDream 源读取是常量
    主机 + `redirect:"manual"`（不需要用户 URL 守卫）；目录/提供方/Prompt Hub
    的上游是**运营方配置**的端点（非用户可控 URL），不在 SSRF 面内——见
    §4 残余风险第 3 条。
- **测试**：transport 7 条（rebinding 复现：解析器答回环 → 建连前拒绝、内部
  目标零命中；IPv4 与 v4-mapped IPv6 字面量拒绝；公网正例 `CANVAS_TEST_PUBLIC_NETWORK=1`
  本机实跑通过）+ guarded-fetch 9 条（每跳重校验、302 内网拒绝、v6 内网重定向
  拒绝、合法 CDN 重定向 + Range 透传、按跳主机白名单、缺 Location/非法跳转/
  协议限制/超跳数、dispatcher 接线断言）+ safe-host 10 条（v4 各内网段、v6
  回环/ULA/链路本地/映射/6to4/NAT64、`0x7f000001`/`2130706433`/`127.1` 等
  非常规写法、URL 凭据脱敏）。api 全量 602 通过。
- **依赖**：`undici`（MIT，已登记 THIRD_PARTY.md）——采用成熟受控传输而非
  自实现 HTTP 客户端。
- **影响**：真实网络请求从全局 `fetch` 切到 undici `fetch`（同引擎、语义一致，
  Response 结构等价）；Range/流式读取/超时/大小上限全部保留（调用方原样）。

### 2.3 可信代理边界与限流标识（P1）

- **问题**：`apps/api/src/app.ts` 的 `clientIdentifier` 无条件采信
  `CF-Connecting-IP`、`X-Forwarded-For` 首项与 `X-Real-IP`。直连 API 的攻击者
  每次请求换一个伪造头，即可让注册/登录/兑换/会员领取的每 IP 限流全部失效。
- **修复**（`0505624`）：
  - 新增 `apps/api/src/identity/client-address.ts`：`net.BlockList`（标准库，
    原生 IPv4/IPv6 CIDR）维护可信代理列表；**只有直连对端本身是可信代理时**
    才读转发头；XFF **从右往左取第一个不可信地址**（nginx 追加真实对端与
    Cloudflare 追加真实客户端两种链路都成立，客户端伪造的左侧条目影响不到
    结果）；XFF 全可信时才用 CF 头（Cloudflare 会覆盖该头）；`X-Real-IP`
    永不采信（无"由可信方追加"的结构保证）。头里的值必须是合法 IP 才会成为
    标识——任意字符串既不能冒充客户端，也不会成为限流桶键。v4-mapped 的
    socket 地址归一后比对。
  - `TRUSTED_PROXY_CIDRS` 环变量（IP/CIDR/`loopback`；非法片段忽略且可查）；
    server.ts 透传；缺省只信回环（直跑/同机反代可用）。
  - docker-compose 预置 `172.16.0.0/12`（Compose 默认地址池，前置只有内置
    nginx 容器），改地址池/加前置代理时在 .env 调整（.env.example、
    DEPLOYING.md 均有说明）。
- **测试**：client-address 13 条单测 + `http.test.ts` 3 条端到端：
  未可信对端连发 11 次登录、每次带不同伪造头 → 第 11 次 429（头没造出新桶）；
  可信代理下 XFF 各异 → 各自独立桶；直连按各自真实地址分桶。
- **影响**：直连部署、本地开发、同机反代、Compose 自托管、Cloudflare 前置
  （按其公布网段配置）全部可用；登录用户体验不变（正常浏览器从不带这些头，
  走真实对端地址）。部署侧需检查 `TRUSTED_PROXY_CIDRS`——见 §6.2。

### 2.4 字节级大小校验（P2）

- **问题**：`parseProjectImportText` 用 `text.length`（UTF-16 码元数）当字节数：
  中文项目的真实字节数约 3 倍于它，4MB 上限对中文文件实际放到 12MB；且调用方
  先 `file.text()` 整读再判，超大文件的内存早已吃掉。
- **修复**（`d95de46`）：`project-library.ts` 新增 `utf8ByteLength`（无中间
  Buffer 的精确 UTF-8 计数，代理对 4 字节、落单代理按 WTF-8 计 3 字节，
  与 TextEncoder 输出一致），`parseProjectImportText` 按字节判定；
  `project-sidebar` 导入前先比 `File.size`（真实字节数），超大文件不读。
- **复查同型面**：API `readJsonBody` 本就是流式真字节计数（1MB 上限）；
  媒体上传走 Blob.size；画布导入源读取按流计数。无同型缺陷。
- **测试**：与 TextEncoder 对齐的计数用例（ASCII/CJK/emoji/落单代理）、
  CJK 超限但 UTF-16 长度较小的样本必须拒绝、合法项目仍可导入、自定义预算边界。

### 2.5 自托管安全响应头（P1）

- **问题**：`docker/nginx.conf` 对静态应用零安全响应头；正式托管环境
  （`apps/web/public/_headers`）有 CSP/XFO/nosniff/HSTS/Referrer/Permissions
  等一套——两种部署形态行为不一致。
- **修复**（`ed7d118`）：`location /` 补齐与 Pages **完全相同**的一组头
  （CSP 保持最小集合：script-src/connect-src 不收紧——BYOK 要连用户配置的
  中转端点、MediaPipe/Three.js 与媒体走同源；进一步收紧需先过浏览器实测）。
  `/admin/` 反代不加 X-Frame-Options（运营控制台要嵌同源模型页，API 侧已用
  CSP frame-ancestors 按环境变量钉住允许来源）。
- **验证**：头集与 `_headers` 逐条对照；Docker 栈的运行验证走开源 CI 的
  self-host 作业（构建 + 启动 + 探活）。

### 2.6 完整项目备份与恢复（P1，功能新增）

- **问题**：项目 JSON 导出只带 `media.id` 引用不带字节；清存储/换浏览器后
  素材全部失效——用户无法仅凭导出文件复原作品。
- **修复**（`c74f6d6` + `7cd49bf`）：
  - **格式**（`packages/contracts/src/project-backup.ts`，跨运行时 zod 契约）：
    `project.json`（`canvasProjectSchema` 纯 JSON）+ `manifest.json`（文件清单：
    每媒体字节数 + sha256 + 摘要 + 未含引用清单）+ `media/<id>`（原始字节）。
    写出顺序固定；导入按中央目录清点、按需提取，**不依赖条目顺序**。
  - **云端素材如实标注**：`source:"server"` 或本地无字节的引用进
    `externalMedia`，不写进备份；恢复后报告"部分恢复"。不做虚假的完整备份。
  - **导出**（`apps/web/src/lib/project-backup.ts`）：fflate 流式 Zip（媒体
    512KB 分块泵入，已压缩媒体走存储档）；哈希在分块读取时增量算（自实现
    FIPS 180-4 增量 SHA-256——WebCrypto 不支持分块）；导出总量上限 1GB。
    凭据零写入（localStorage 的任何东西不进备份，测试断言）。
  - **导入**：先只读中央目录清点结构（不解压）：条目名白名单（`../`、子目录、
    未知文件整包拒绝）、条目数上限、重复条目拒绝、清单与包内文件一一对账。
    按需提取时 filter 先核对中央目录声明的解压大小（与清单一致且 ≤512MB 才
    解压，防"声明 1 字节实塞 4GB"的预分配炸弹），提取后重算 sha256 比对，
    再走与用户上传**完全相同**的内容校验（魔数/解码/SVG 拒绝）。恢复永远是
    新项目副本（`duplicateProjectSnapshot`），结构上不存在覆盖路径；媒体按原
    ID 落库——已有且内容一致=幂等复用，内容不同=换新 ID 并改写项目引用；
    校验失败按单文件跳过并计入报告。包体上限 1GB（内存模型见下）。
  - **实现取舍**：fflate 的流式 `Unzip` 在一次 push 携带多个条目时会丢失靠前
    小条目的数据（用最小复现证实），故导入用其文档化 `unzip` API 按需提取，
    内存恒为"压缩包 + 当前媒体"。
  - **UI**：项目侧栏新增"完整备份"按钮；导入框同时收 `.json` 与 `.zip`；
    恢复结果区分完整/部分恢复（损坏跳过数、云端引用数如实提示）。JSON
    导入/导出原样保留。
- **测试**：单测 14 条（往返恢复、幂等复用不覆盖、ID 冲突重映射 + 引用改写、
  篡改哈希/大小/内容跳过、穿越/未登记/重复条目整包拒绝、坏版本清单拒绝、
  非 ZIP 拒绝、条目顺序无关、跨分块大媒体）+ e2e 2 条（§2.7）。web 全量
  947 通过。
- **依赖**：`fflate`（MIT，已登记 THIRD_PARTY.md）。

### 2.7 备份恢复端到端验收（对应修复计划的"必须通过的恢复实验"）

`apps/web/e2e/project-backup.spec.ts`（`7cd49bf`，坏包用例后续在
`7870e02` 重写为确定性路径——CI 首跑曾因随机翻转字节落在 deflate 流上而
对不同树呈现不同失败形态，断言的是运气不是行为）：

1. 造含**文字/图片/视频/音频**节点、3 条连线、1 个分组的画布 → 点「完整备份」
   下载 ZIP → **清空 localStorage / sessionStorage / IndexedDB**（隔离环境）→
   导入 ZIP → 节点数（4）/连线数（3）/分组（1）/媒体引用全部恢复；图片节点
   渲染出 `<img>`（字节来自 IndexedDB）；**刷新页面后一切仍在**。
2. 只破坏媒体字节（PNG 魔数处翻转一位；ZIP 结构与清单完好）→ 恢复继续、
   坏素材**明确报出"跳过 + 部分恢复"**，画布照常恢复。
3. 截断中央目录 → 整包拒绝（明确错误文案），**不清空存储的前提下**既有项目
   原样保留——失败导入不破坏任何已有数据。

本机实测：3 条全过（20.2s）；相邻回归（project-persistence 5 条、custom-api 7 条）
全过。顺带修掉恢复提示里"媒体 N"的计数口径（应为 清单媒体数 − 跳过数，而非
复用+重映射数——跳过的媒体也曾在清单里）。

### 2.8 CI 覆盖（P1）

- **问题**：仓库有 6 个文件 25 条 PostgreSQL 集成测试（identity / generation /
  media / 限流 / 对账 / 工作队列，自带 `runMigrations` 与"库名含 test"保险），
  但 CI 从未设 `CANVAS_TEST_DATABASE_URL` → `describe.skipIf` 静默跳过——
  CI 的绿不代表 SQL 层真的对过 Postgres。
- **修复**（`4b96c55`）：quality 作业起 `postgres:16-alpine` 服务，单独跑
  `pnpm --filter @weftcanvas/canvas-api test:postgres`（单 worker 串行迁移）；
  browser smoke 名单加入 `e2e/project-backup.spec.ts`。分层保持
  unit/typecheck/build（快）→ PG 集成（分钟级）→ 浏览器 smoke →
  self-host 容器栈；全量 e2e 仍走本地/发布前批次（成本与稳定折中维持原判）。
  另：Blender 认证回归（python3）在 quality 作业里跑（§2.1）。
- **本机验证**：Docker `postgres:16-alpine` 上 6 文件 25 用例全过（6.8s）。
- **CI 首跑失败的教训（已修复）**：首版把 `CANVAS_TEST_DATABASE_URL` 放在
  作业级——`pnpm test` 于是以默认并行度跑集成文件，多个文件同时抢迁移锁
  （`Another Canvas migration process already holds the migration lock`），
  quality 作业失败（本机已复现：3 个套件稳定挂同一错误）。修复为把 URL 收敛
  到 `test:postgres` **步骤级**：`pnpm test` 恢复按门控跳过、专用步骤串行跑
  25 条。此事故正是"集成测试串行化"（`--maxWorkers=1`）存在的原因，已在
  ci.yml 注释里写明防止回退。

## 3. 测试报告

全部在私有仓 `fix/security-remediation` 分支（Windows 10，Node 24.21，
pnpm 11.7.0）执行；物化后在开源树复验（见 §3.2）。

### 3.1 私有树

| 命令                                                                                                               | 结果                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`（8 包）                                                                                           | **通过**（apps/api、apps/web、apps/worker 等全部 Done）                                                                                                      |
| `pnpm test`（全仓单测，末次全量回归）                                                                              | **通过**：contracts 77 / split-list 2 / agent 89 / api 602（627 中 25 条 PG 集成按门控跳过，另见下行）/ worker 16 / web 947；另 api `test:scripts` 14 条全过 |
| `CANVAS_TEST_DATABASE_URL=… pnpm --filter @weftcanvas/canvas-api test:postgres`                                    | **25 通过**（Docker postgres:16-alpine，6 文件，6.8s）                                                                                                       |
| `pnpm --filter @weftcanvas/canvas-web exec playwright test e2e/project-backup.spec.ts`                             | **3 通过**（20.2s，重写坏包用例后；首版 2 条 18.3s）                                                                                                         |
| `pnpm --filter @weftcanvas/canvas-web exec playwright test e2e/project-persistence.spec.ts e2e/custom-api.spec.ts` | **12 通过**（56.7s）                                                                                                                                         |
| `CANVAS_TEST_PUBLIC_NETWORK=1`（guarded-transport 公网正例，经受控传输访问 `https://example.com`）                 | **1 通过**（返回 200）                                                                                                                                       |
| `docker run python:3.12-slim python3 apps/agent/blender/bridge_auth_test.py`                                       | **11 通过**（0.36s；公开树同款 0.13s）——桥接认证回归的本地实跑证据，两棵树各跑一次                                                                           |

### 3.2 未运行（如实记录，不得伪称通过）

- **Docker 自托管栈本机未做完整 compose 构建**——本机 Docker 对镜像仓库
  时通时不通（本轮恰好拉到了 postgres 与 python 镜像，但未跑完整栈）。nginx
  安全头与栈级行为由开源 CI 的 self-host 作业验收（build + up --wait + 探活 +
  持久化检查），该作业在已跑的三轮 CI 中均通过。
- **全量 e2e（除上述 4 个 spec 外）未全部重跑**——本轮改动集中在 API 侧
  lib 与项目侧栏/导入路径，已跑 project-persistence（同屏回归）+ custom-api
  （BYOK 回归）+ 备份 3 条；其余 spec 的批量回归按既有惯例走发布前批次。

### 3.3 开源 CI 的迭代记录（完整保留在 Actions 历史）

| 轮次 | 公开提交  | 结果                                              | 根因与处置                                                                                                                                                                                                                                                          |
| ---- | --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `977a1ea` | quality 失败（`pnpm test`）                       | `CANVAS_TEST_DATABASE_URL` 放在作业级 → 集成文件默认并行跑、抢迁移锁（本机复现：3 个套件稳定挂同一错误）。修复：URL 收敛到 `test:postgres` 步骤级（`43dd2aa`）。                                                                                                    |
| 2    | `3690007` | quality 失败（Blender 认证回归步骤）              | bpy 替身只给 `bpy.app`，而桥接在**导入期**就要 `bpy.types/props/utils` 定义操作符类 → 11 条全 `AttributeError`。修复：宽容替身，并用 `python:3.12-slim` 容器在本机实跑 11/11（`540850b`）。教训：**未本地实跑就推送**——此后一切 CI 步骤先在本机（含容器）跑过再推。 |
| 3    | `d80e577` | 备份 e2e 坏包用例失败                             | 随机翻转字节的落点决定失败形态（有时解出坏 JSON、有时解压报错）——断言的是运气不是行为。修复：只破坏媒体字节（必走部分恢复）+ 截断包（必走整包拒绝）（`20ac174`）。                                                                                                  |
| 4    | `6206dbf` | 我的 3 条备份 e2e 全过；**既有** persistence 失败 | config-c 参数向 image-gen 的传播是面板挂载后的**异步**同步，慢机器上晚于测试读取 localStorage（本机连跑 20+ 次不现，CI 一次即现）。修复：读取前轮询等传播落地（断言**不放宽**，精确深比较原样保留）。                                                               |

## 4. 残余风险

1. **内存限流器的多实例一致性（低，当前部署不成立）**：`SensitiveActionGuard`
   与 `AnonymousAgentGuard` 是进程内计数——单实例 systemd 部署有效；多实例
   部署时每实例各自计数（上限放宽 N 倍）。代码注释已写明换
   `PostgresFixedWindowRateLimiter` 的路径。部署成多实例前必须迁移。
2. **CSP 仍是最小集合（低）**：script-src/connect-src 未收紧，XSS 的纵深防御
   依赖 React 转义 + 公告 URL 白名单（当前无注入点，§1）。收紧前需浏览器
   实测 MediaPipe / Three.js / BYOK / 蓝牙类 Worker 的实际需求。
3. **运营方配置上游不在 SSRF 守卫内（低）**：目录适配器 / Prompt Hub /
   生成提供方的上游 URL 来自环境变量（运营方信任边界），被入侵的上游可回执
   指向内网的 URL 由 `result-materializer` 抓取。用户可控 URL 的面已全部收进
   受控传输；把运营侧上游也纳入需先厘清证书与代理拓扑，未在本轮动。
4. **备份导入的内存模型（中，随上限受控）**：导入需把压缩包读成一块连续内存
   （fflate 流式 Unzip 的多条目缺陷所致，见 §2.6），包体上限 1GB、单媒体
   512MB——超出普通个人项目的量级，但对超大备份会在导入瞬间占用同量堆内存。
   未来 fflate 修复流式语义后可回到恒定内存。
5. **新桥接 + 旧 Agent 客户端的过渡**：旧客户端（不带令牌）会被新桥接拒绝并
   得到"认证失败"提示；一键装配重新执行即可对齐（见 §6.1）。
6. **`bridge_auth_test.py` 首跑状态（已消除）**：最初本机无 Python 解释器，
   该测试首跑即 CI 并失败（bpy 替身面不够，§2.1/§3.2）。现已用
   `python:3.12-slim` 容器在本地实跑通过，测试也已随批次修好并重新物化。
   遗留物：CI 的第一次失败记录（run 38934609344）保留在 Actions 历史里，
   作为"未本地验证就推送"的教训案例。
7. **另一会话的未提交改动**：私有仓工作区存在另一会话的未提交内容
   （`direct-generation-studio.tsx`、`entry-gate.css`、`docs/AI-HANDOFF.md`）。
   本轮全部提交均按显式路径 staging，未触碰它们；`docs/AI-HANDOFF.md` 的
   状态更新因此**顺延**，待其落地后由下一轮补记。

## 5. 后续维护建议（按优先级）

1. **首次切分 `apps/api/src/app.ts`（最大收益、风险可控）**：先把音乐代拉块
   （`MusicProxyError` + `normalizeMusicInputUrl` + `detectMusicSource` +
   `musicGuardedFetch` + `probeMusicAudio`，约 250 行、与外部零共享）整体搬
   到 `apps/api/src/media/music-proxy.ts`，公开接口不变，跑全量 api 测试后独立
   提交。此后再按域拆"资产清理 / 运营 / 连接器"三个目录，一次一片。
2. **浏览器实测后收紧 CSP**：用 Playwright 实录 MediaPipe 人脸/分割、Three.js
   导演台、BYOK 直连、Worker 创建（`worker-src 'self' blob:'）四条链路，再给
Pages `_headers`与`docker/nginx.conf`同时加`script-src 'self'`与`worker-src`——两处必须同批改（本报告 §2.5 已把两处钉成同构）。
3. **部署成多实例前迁移敏感限流**：把 `SensitiveActionGuard` 换成
   `PostgresFixedWindowRateLimiter`（表已存在，复用 `api-rate-limit.ts` 的
   固定窗口）。
4. **发布一份 `SECURITY.md` 里的 Blender 边界条款**：把 §2.1 的
   "令牌=本机代码执行权限"写进开源仓 SECURITY.md 的报告/责任边界段。
5. **备份格式的工具伴生**：在 `packages/contracts` 注释外补一份
   `docs/BACKUP-FORMAT.md`（字段表 + 一个用 `unzip -l` 可读的最小样例），
   方便社区写校验/迁移工具——格式本身已版本化，v2 只加不改。
6. **`next` 拆分止于"按域归位"**：`direct-generation-studio.tsx` /
   `canvas-store.ts` 等巨型前端模块的拆分放最后（当前另有会话在改），且先拆
   纯函数 helpers（如 `custom-api.ts` 的请求装配段）再谈组件级。

## 6. 兼容性与迁移说明

### 6.1 Blender 认证机制（影响本机模式用户）

- **新增**：本机模式启动时在 `~/.weftcanvas-bridge/token`（公开树
  `~/.weftcanvas-bridge/token`）生成 43 字符访问令牌（0600）；每个 TCP 请求
  必须带顶层 `"token"` 字段；端口只允许回环地址。远程配对模式**零变化**。
- **一键装配**：不变。Agent 运行时与桥接读同一个令牌文件，用户无需手工配对。
- **手动接法的用户**：若直接手写 TCP 客户端调本机桥接，需读取同一令牌文件
  （或设 `WEFTCANVAS_BRIDGE_TOKEN` 直配）后随请求携带。
- **升级**：装新插件、重启 Blender 即可；面板里的"重新生成令牌"用于怀疑泄露
  的轮换，旧令牌立即失效，同机 Agent 下次调用自动跟进。

### 6.2 部署配置（TRUSTED_PROXY_CIDRS）

| 部署形态                               | 缺省行为                                     | 需要的动作                                                                                          |
| -------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 直跑 `pnpm dev:api` / systemd 单机直连 | 只信回环；直连按 socket 地址识别             | 无                                                                                                  |
| 同机 nginx 反代（host 网络）           | 回环在可信列表                               | 无                                                                                                  |
| docker compose 自托管                  | 已预置 `172.16.0.0/12`（Compose 默认地址池） | 换过 docker 地址池（192.168/16、10/8）就在 .env 改                                                  |
| Cloudflare 前置                        | —                                            | 按 CF 公布网段填 `TRUSTED_PROXY_CIDRS`（`https://www.cloudflare.com/ips/`），保持列表外的一切不可信 |
| 既有 nginx 链                          | —                                            | 无需动 nginx：`$proxy_add_x_forwarded_for` 的追加语义正是新识别算法的前提                           |

**行为差异提醒**：此前"伪造头即可绕限流"是缺陷；修复后直连请求的转发头一律
忽略。若有脚本依赖伪造头区分身份，那正是被修复的对象。

### 6.3 项目备份格式（`.weftcanvas-backup.zip`）

- JSON 导出/导入**原样保留**；备份是新增能力（项目侧栏「完整备份」）。
- 导入端：v1 清单之外（未来 v2）的包会被明确拒绝（"版本或字段不匹配"），
  不会半解析。
- 媒体恢复规则（确定性）：原 ID 已存在且内容一致 → 沿用；内容不同 → 新 ID +
  项目引用改写；不存在 → 按原 ID 写入。项目恢复永远生成新副本，不覆盖现有项目。
- 云端素材（source=server）不在备份里，恢复后按"部分恢复"如实提示，节点上
  的 serverId 引用原样保留（服务端素材仍在则可继续访问）。
