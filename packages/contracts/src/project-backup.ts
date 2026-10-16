import { z } from "zod";

/**
 * 完整项目备份（`*.zip`）的 `manifest.json` 契约。
 *
 * ZIP 布局：
 *
 * 1. `project.json` —— `canvasProjectSchema` 的纯 JSON（画布结构 / 节点 / 连线 / 分组 / 视口）；
 * 2. `manifest.json` —— 本契约（文件清单 + 每文件字节数与 sha256 校验信息）；
 * 3. `media/<mediaId>` —— 媒体原始字节，`media[].path` 一一指名。
 *
 * 写出顺序固定为 project → manifest → media（导出方按此写，便于人工排查）；
 * 导入侧按中央目录清点结构、按需提取，**不依赖条目顺序**，也不接受清单之外的
 * 任何条目名。清单登记的文件必须与包内文件一一对应，多一个少一个都拒绝。
 *
 * 云端素材（`source: "server"` 或本地库里没有字节的引用）**不写进备份**——不能保证
 * 未来仍可访问，宁可如实标注为 `externalMedia`，也不制造虚假的完整备份。
 */
export const PROJECT_BACKUP_FORMAT = "weftcanvas-backup";
export const PROJECT_BACKUP_VERSION = 1;
export const PROJECT_BACKUP_MANIFEST_PATH = "manifest.json";
export const PROJECT_BACKUP_PROJECT_PATH = "project.json";
export const PROJECT_BACKUP_MEDIA_PREFIX = "media/";

/** createId 的字符集（randomUUID / base36），路径段据此白名单，杜绝路径穿越。 */
export const projectBackupMediaIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const projectBackupMediaEntrySchema = z.object({
  /** 项目里引用的媒体 ID（恢复时按原 ID 落库）。 */
  id: projectBackupMediaIdSchema,
  /** ZIP 内路径：`media/<id>`。 */
  path: z.string().regex(/^media\/[A-Za-z0-9][A-Za-z0-9_-]*$/),
  /** 解压后的字节数；导入时逐一核对。 */
  size: z.number().int().nonnegative(),
  /** 导出时算好的 sha256（64 位十六进制小写）。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const projectBackupExternalMediaSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  /** source:"server" 的云端 ID；本地引用但库里没有字节时为 null。 */
  serverId: z.string().min(1).max(128).nullable(),
});

export const projectBackupManifestSchema = z.object({
  format: z.literal(PROJECT_BACKUP_FORMAT),
  version: z.literal(PROJECT_BACKUP_VERSION),
  /** 导出时刻（ISO）。 */
  createdAt: z.string().datetime({ offset: true }),
  app: z.object({
    /** 导出方应用名（公开树自动换牌）。 */
    name: z.string().min(1).max(64),
    schemaVersion: z.number().int().nonnegative(),
  }),
  /** 项目元数据摘要：导入前给用户看"即将恢复的是什么"。 */
  summary: z.object({
    name: z.string().min(1).max(255),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
  }),
  /** 已写入 ZIP 的本地媒体清单（文件清单 + 校验信息）。 */
  media: z.array(projectBackupMediaEntrySchema).max(2_000),
  /** 未包含字节的引用：云端素材或本地已缺失，恢复后按"部分恢复"报告。 */
  externalMedia: z.array(projectBackupExternalMediaSchema).max(2_000),
});

export type ProjectBackupManifest = z.infer<typeof projectBackupManifestSchema>;
export type ProjectBackupMediaEntry = z.infer<typeof projectBackupMediaEntrySchema>;
export type ProjectBackupExternalMedia = z.infer<typeof projectBackupExternalMediaSchema>;
