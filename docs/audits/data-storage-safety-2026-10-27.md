# 数据与存储安全审查（2026-10-27）

> 范围：画布用户数据的**持久化、读取、迁移、清理、备份**链路，重点回答
> 「哪些路径会丢失用户数据」。同时对齐 API 站模型目录下的音频/音乐模型，
> 因为「模型不可用」会让已经计价的生成结果无法产出。
>
> 方法：先读代码与契约，再用真实快照跑一遍目录（134 个模型逐条报价 + 构造
> 执行请求体），最后针对发现的缺陷做最小修复并补回归测试。未证实的问题
> 不列、不改。

## 1. 结论摘要

| 类别             | 数量 | 说明                                                                              |
| ---------------- | ---- | --------------------------------------------------------------------------------- |
| 已修复缺陷       | 5    | 1 个音频模型不可用、3 个参数/传输面缺陷、1 个本地库读取失败会被误读为「数据清空」 |
| 已核实安全       | 8    | 原子写、失败关闭、备份校验、冲突副本、引用检查等                                  |
| 残余风险（建议） | 5    | 其中 1 项（状态 JSON/技能/媒体字节不在异地定时备份内）建议尽快处理                |

验证：API 627 passed / 25 skipped，Web 1069 passed，两端 `tsc --noEmit` 干净，
新增 e2e「music and TTS models expose only creative audio controls」通过，
既有音频生成 e2e 通过。

## 2. 已修复

### 2.1 托管 TTS 模型在报价阶段永远无法通过（P1，模型不可用）

- **现象**：目录把 `speechConfig`（Gemini TTS 音色）声明为 `type: "object"` +
  30 个字符串选项。界面按「选项即用户形态」提交裸音色名（如 `Kore`），但
  `apps/api/src/catalog/quote.ts` 的 `validateParameter` 先按 `object` 类型校验，
  直接抛 `INVALID_PARAMETER_TYPE`（“语音配置格式不正确”）。用户选完音色也
  拿不到报价，托管 TTS 实际不可用。
- **证据**：用仓库内的真实目录快照逐条报价，修复前 134 个模型中唯一失败项
  就是 `gemini-3.8-flash-tts`；修复后 130 个快照模型 + 4 个兼容注入模型全部
  报价通过，每个非文本模型的执行请求体也都能构造。
- **修复**：`validateParameter` 对「已发布枚举选项」的参数以选项为唯一判据，
  与 `generation-config.ts` 早就写明的口径一致（选项是用户可见形态，执行侧
  负责包成线上结构）。非法音色仍然被 `INVALID_PARAMETER_OPTION` 拒绝。
- **测试**：`catalog.test.ts` 音频用例新增 TTS 裸音色报价成功 + 非法音色拒绝。

### 2.2 Gemini speechConfig 的对象形态是错的（P1，上游会 400）

- **现象**：托管执行与 BYOK 都把裸音色包成 `{ voiceConfig: { voice: "Kore" } }`。
  Gemini 原生 `generateContent` 要求的字段是
  `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`。
- **修复**：`apps/api/src/generation/weftcanvas-provider.ts` 与
  `apps/web/src/lib/custom-api.ts` 统一改为标准形态；两条既有单测的断言同步
  更新（它们此前只验证了「被包了一层对象」，没有验证字段名）。
- **影响**：托管与浏览器直连两条 TTS 链路。

### 2.3 音乐模型暴露 `stream` 开关，打开即失败（P1，付费任务风险）

- **现象**：Suno 模型目录带 `stream`（默认 false，非固定）。界面把它渲染成
  普通开关；用户打开后，服务端在**创建任务时**才抛
  `STREAMING_UNAVAILABLE`（`service.ts` 与 `weftcanvas-provider.ts` 都有守卫）。
  也就是说，用户可以在界面上把一个注定失败的任务配置出来。
- **修复**：`isModelInternalParameter` 把 `stream`、`responseModalities`
  视为传输层参数，所有参数入口（工作台、节点面板、直连 composer、快慢参数
  分组）都不再展示；固定值仍由 `composeModelParameters` 原样下发。
- **测试**：`generation-config.test.ts` 新增可见性用例；
  `generation-parameter-groups.test.ts` 新增音频快选区用例。

### 2.4 30 个音色被渲染成 30 个芯片（P2，布局与可用性）

- **现象**：工作台把「有选项」的参数一律渲染成芯片组。TTS 的 30 个预置音色
  会平铺成一行几十个按钮，左栏被撑爆。
- **修复**：`parameter-chips.tsx` 新增 `INLINE_CHIP_OPTION_LIMIT = 6` 与
  `supportsInlineOptionChips`；超过 6 项回落成 `GenerationParameterField` 的
  下拉框（节点面板本来就是下拉）。同时把 `speechConfig` / `instrumental`
  提到音频快选区。
- **测试**：`parameter-chips.test.ts`；e2e 断言音色是下拉、默认 `Zephyr`，
  且不存在「语音配置」芯片组。

### 2.5 localStorage 写满时，主页会把项目库读成「空」（P1，看起来像数据全丢）

- **现象**：`loadProjectLibrary()` 每次读取都会重写项目摘要索引与「当前项目」
  两个键。浏览器配额满时 `setItem` 抛 `QuotaExceededError`，整个读取函数抛出；
  `initialProjects()` 捕获后返回 `[]`——主页于是显示「一个项目都没有」。项目
  文档其实还在，但用户看到的是数据清空。
- **修复**（`apps/web/src/lib/project-library.ts`）：
  - 索引与「当前项目」改为 best-effort 写入：失败不影响本次读取返回的项目；
  - 旧版单项目键迁移时，只有写入成功才删除旧键；写不进去也照常返回旧项目，
    绝不因为迁移失败把唯一一份旧数据删掉。
- **测试**：`project-library.test.ts` 新增两条——配额满时仍能列出项目；
  迁移写入失败时保留旧键。

## 3. 已核实安全（证据）

1. **服务端 JSON 存储全部是原子写**：目录快照、模型覆盖、公告、托管任务、
   托管引用、技能、结果暂存、媒体对象都先写同目录临时文件再 `rename`
   （`catalog/store.ts`、`announcements/store.ts`、`catalog/overrides.ts`、
   `generation/prompt-hub-service.ts`、`generation/result-staging.ts`、
   `media/filesystem-object-store.ts`、`skills/store.ts`）。托管任务与引用
   还有串行 `mutationQueue`，不会并发互相覆盖。
2. **损坏时失败关闭，不静默清空**：任务/引用/目录文件解析失败会抛错阻止
   启动，而不是以空内存启动后把文件覆盖成空。
3. **数据库迁移无破坏性 DDL**：`apps/api/migrations/` 中 21 个迁移没有任何
   `DROP TABLE/COLUMN`、`TRUNCATE`；用户→媒体/任务的外键用 `RESTRICT`，
   不会因删用户误删资产。
4. **PostgreSQL 备份是异地加密备份**：小时级 restic 快照、保留策略、
   独立只读备份角色、隔离库恢复演练、恢复口令托管
   （`deploy/linux/postgres-backup.sh`、`README.md`）。
5. **服务端素材删除有防误删**：删除节点后 45 秒宽限、逐项目引用检查
   （含剪辑时间线）、队列持久化、读不到项目库时「宁可当仍被引用」
   （`lib/server-media-deletion.ts`）。
6. **云端覆盖前保留冲突副本**：打开远端项目/收到远端更新时，若本地指纹与
   上次同步不同，先 `duplicateProjectSnapshot` 存一份「冲突副本」再覆盖，
   并清掉冲突前的待同步快照，避免旧内容回灌
   （`state/cloud-project-store.ts`）。
7. **完整备份包可验证、导入不覆盖本机**：ZIP 清单含逐文件 SHA-256、路径
   白名单、大小上限；导入永远生成新项目，媒体同 ID 内容不同就换新 ID，
   绝不覆盖已有素材（`lib/project-backup.ts`）。
8. **BYOK 密钥不进入任何导出/同步**：项目 JSON、云项目文档、完整备份都不含
   `custom-api` 配置；备份模块有专门的断言。密钥只在该浏览器的
   `localStorage`（文档化例外）。

## 4. 残余风险与建议（按严重度）

### 4.1 异地定时备份只覆盖 PostgreSQL；状态 JSON、技能文件与媒体字节在备份之外（建议优先处理）

- **事实**：现有小时级 restic 备份只做 PostgreSQL dump。生产托管链路
  （`CANVAS_API_PROVIDER=weftcanvas`）的任务与引用存在
  `/var/lib/weftcanvas/prompt-hub-generation-jobs.json` 与
  `...-references.json`（`deploy/linux/common.sh` 的 `KC_JOBS_STATE` /
  `KC_REFERENCES_STATE`，`spi/weftcanvas.ts` 的 `JsonPromptHubGenerationStore`）。
  用户技能在 `SKILLS_PATH`（默认 `.data/skills`），模型覆盖/公告也在
  `/var/lib/weftcanvas` 或 `.data` 下。发布升级时会在**同一台机器**上做
  `state-before` 快照，但不是异地、也不是定时备份；磁盘损坏会同时丢掉线上
  文件与本机快照。媒体字节按 `MEDIA_STORAGE_DRIVER=s3` 存在 S3/R2，不在
  restic 里，其可靠性取决于桶本身的版本/复制策略。
- **影响**：已计价任务的恢复/幂等记录、历史列表、用户导入的技能、运营覆盖会
  丢失；媒体字节的丢失取决于对象存储侧是否有版本/复制。
- **建议**：
  1. 给备份用户授予状态文件的只读权限（ACL 或单独以 `canvas` 用户运行），在
     现有 `postgres-backup.sh` 之后追加一次
     `restic backup /var/lib/weftcanvas --tag canvas-state`（至少覆盖
     `prompt-hub-generation-jobs.json`、`prompt-hub-generation-references.json`、
     `model-catalog.json`、`model-overrides.json`、`announcements.json`、
     `skills/`），沿用同一仓库/保留策略；
  2. 把「从快照恢复这些文件」写进恢复演练；
  3. 确认对象存储桶开启版本控制/生命周期保护，避免误删不可恢复。
     未在本次改动中直接实施，因为涉及 systemd 用户权限与线上备份口径，需要按
     发布流程验证。

### 4.2 项目 schema 版本升级没有迁移层

- `canvasProjectSchema` 是 `schemaVersion: z.literal(1)`。一旦升到 2，所有旧
  本地项目都会解析失败：主页只显示可解析的项目（数据仍在 localStorage），
  导出备份与素材引用检查也会漏掉它们。
- **建议**：下次改 schema 前先加 `migrateCanvasProject(value)`（按版本补齐
  默认字段），在 `parseProject` / 导入 / 云端读取三处统一调用；并保留
  「解析失败的项目在库中可见且可导出」的兜底入口。

### 4.3 配额到期清扫会删除「仍被画布引用」的云端素材（产品策略，已告知）

- `enforceQuotaAfterGrace` 先清最旧的未绑定素材，仍超额再按项目更新时间清
  绑定素材；每日 `storage-sweep` 执行。界面在宽限期有明确贴士
  （`storage-tip-banner.tsx`：「越界素材最后才会被清理」），属于有告知的
  产品策略。
- **建议**：若要进一步降低「用户没打开画布就错过通知」的概率，可在宽限期
  内给一次邮件/站内提醒；或对绑定素材只做「禁止新增」而不自动删除。这是
  产品决策，本次未改。

### 4.4 轮换 `S3_KEY_DERIVATION_SECRET` 会让既有媒体全部不可达

- 对象键由派生密钥生成（`deploy/linux/README.md` 已写明「轮换派生密钥而不迁移
  对象会让既有媒体不可达」）。这条只是文档提醒，没有迁移工具：一旦运维轮换，
  数据库里的媒体行仍在、对象也在桶里，但按新键取不到，用户看到的是素材全部
  404。
- **建议**：轮换流程要么固定为「新增密钥版本 + 双读窗口」，要么先跑一次对象
  重命名迁移并核对；不要只改 env。

### 4.5 `pruneUnreferencedLocalMedia` 目前未被调用，但防线偏弱

- 它默认以 `collectProjectMediaIds(readAllProjects())` 作为保留集；若某个
  项目解析失败，其素材可能被当成无引用。当前仓库内没有调用点，风险为潜伏。
- **建议**：真正启用前，加上「存在无法解析的项目就整体放弃清理」的守卫。

## 5. 变更文件

- `apps/api/src/catalog/quote.ts`、`apps/api/src/catalog/catalog.test.ts`
- `apps/api/src/generation/weftcanvas-provider.ts`、`.../weftcanvas-provider.test.ts`
- `apps/web/src/lib/custom-api.ts`、`.../custom-api.test.ts`
- `apps/web/src/lib/generation-config.ts`、`.../generation-config.test.ts`
- `apps/web/src/lib/generation-parameter-groups.ts`、`.../generation-parameter-groups.test.ts`
- `apps/web/src/lib/generation-parameter-hints.ts`
- `apps/web/src/components/parameter-chips.tsx`、`.../parameter-chips.test.ts`
- `apps/web/src/components/direct-generation-studio.tsx`
- `apps/web/src/lib/project-library.ts`、`.../project-library.test.ts`
- `apps/web/e2e/direct-generation.spec.ts`
