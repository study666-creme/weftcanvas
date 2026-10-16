import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  agentSkillLimits,
  agentSkillSchema,
  agentSkillSummarySchema,
  assertImportableAgentSkill,
  parseAgentSkillMarkdown,
  type AgentSkill,
  type AgentSkillSummary,
} from "@weftcanvas/contracts";
import { z } from "zod";

/**
 * 用户自导入 Agent 技能的文件存储。
 *
 * 磁盘布局刻意照公开技能格式来：`<directory>/<ownerId>/<skillId>/SKILL.md`。
 * 一个 owner 一个目录、一个技能一个目录，将来补 `references/` 之类的附属文件
 * 不需要任何数据迁移——目录本身就是技能。
 *
 * 导入是**显式动作**：只收单文件 `SKILL.md`（粘贴或选文件），不收压缩包与脚本。
 * 技能正文会直接进模型上下文，来源不明的技能等于把提示注入权交出去。这里不做
 * 内置技能、不做市场、不做跨账号读取，也绝不把 owner/skill 标识拼进路径之前
 * 不校验——两者都必须是 UUID，天然排除了分隔符与 `..`。
 */
export type AgentSkillStore = {
  list(ownerId: string): Promise<AgentSkillSummary[]>;
  read(ownerId: string, id: string): Promise<AgentSkill | null>;
  save(ownerId: string, content: string): Promise<AgentSkillSummary>;
  remove(ownerId: string, id: string): Promise<boolean>;
};

export type FileAgentSkillStoreOptions = {
  directory: string;
  now?: () => number;
  createId?: () => string;
  maxSkillsPerOwner?: number;
};

export type AgentSkillStoreErrorCode =
  | "INVALID_OWNER_ID"
  | "INVALID_SKILL_ID"
  | "INVALID_SKILL"
  | "SKILL_CONTENT_TOO_LARGE"
  | "SKILL_LIMIT_EXCEEDED";

/** 可预期的拒绝（内容不合规 / 数量超限）；存储层自身的 I/O 失败照旧抛原始错误。 */
export class AgentSkillStoreError extends Error {
  constructor(
    readonly code: AgentSkillStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentSkillStoreError";
  }
}

export const AGENT_SKILL_FILE = "SKILL.md";
/**
 * createdAt 单独存一个 meta.json：updatedAt 取文件 mtime 就够（每一次保存都写新
 * 文件），但 mtime 无法表达"这是同一次导入"，覆盖同一个 id 时 created 会被抹掉。
 * 所以只把 createdAt 钉在 meta.json 里，其余字段全部由 SKILL.md 现算。
 */
const SKILL_META_FILE = "meta.json";
const DEFAULT_MAX_SKILLS_PER_OWNER = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const skillMetaSchema = z.object({ createdAt: z.string().datetime({ offset: true }) });

export class FileAgentSkillStore implements AgentSkillStore {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxSkillsPerOwner: number;

  constructor(options: FileAgentSkillStoreOptions) {
    this.directory = options.directory;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.maxSkillsPerOwner = options.maxSkillsPerOwner ?? DEFAULT_MAX_SKILLS_PER_OWNER;
  }

  async list(ownerId: string): Promise<AgentSkillSummary[]> {
    const ownerDirectory = this.ownerDirectory(ownerId);
    let entries: Dirent[];
    try {
      entries = await readdir(ownerDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const summaries: AgentSkillSummary[] = [];
    for (const entry of entries) {
      // 只认 UUID 目录：owner 目录里混进任何别的东西都当不存在，不猜不读。
      if (!entry.isDirectory() || !isSkillId(entry.name)) continue;
      const summary = await this.readSummary(ownerId, entry.name);
      if (summary) summaries.push(summary);
    }
    return summaries.sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id),
    );
  }

  async read(ownerId: string, id: string): Promise<AgentSkill | null> {
    if (!isSkillId(id)) return null;
    const parsed = await this.readParsed(ownerId, id);
    if (!parsed) return null;
    return agentSkillSchema.parse({ ...parsed.summary, body: parsed.parsed.body });
  }

  async save(ownerId: string, content: string): Promise<AgentSkillSummary> {
    // owner 目录先建（并顺带校验 owner id），后面的读取都在这个前缀下。
    const ownerDirectory = this.ownerDirectory(ownerId);
    if (content.length > agentSkillLimits.contentChars) {
      throw new AgentSkillStoreError(
        "SKILL_CONTENT_TOO_LARGE",
        `技能内容超过 ${agentSkillLimits.contentChars} 字符上限`,
      );
    }
    let parsed;
    try {
      parsed = assertImportableAgentSkill(parseAgentSkillMarkdown(content));
    } catch (error) {
      throw new AgentSkillStoreError(
        "INVALID_SKILL",
        error instanceof Error ? error.message : "技能内容无法解析",
      );
    }
    const existing = await this.countSkills(ownerId);
    if (existing >= this.maxSkillsPerOwner) {
      throw new AgentSkillStoreError(
        "SKILL_LIMIT_EXCEEDED",
        `每个账号最多保存 ${this.maxSkillsPerOwner} 个技能，请先删除不再使用的技能`,
      );
    }
    const id = this.createId();
    if (!isSkillId(id)) {
      throw new AgentSkillStoreError("INVALID_SKILL_ID", "生成的技能标识不合法");
    }
    const skillDirectory = join(ownerDirectory, id);
    await mkdir(skillDirectory, { recursive: true });
    // 覆盖同一个 id 时保留原始 createdAt；否则以 now() 落一次。
    const createdAt = (await this.readCreatedAt(ownerDirectory, id)) ?? this.isoNow();
    await writeAtomically(
      join(skillDirectory, SKILL_META_FILE),
      `${JSON.stringify({ createdAt })}\n`,
    );
    const updatedAt = await writeAtomically(join(skillDirectory, AGENT_SKILL_FILE), content);
    return agentSkillSummarySchema.parse({
      id,
      name: parsed.name,
      description: parsed.description,
      size: Buffer.byteLength(content, "utf8"),
      hash: sha256Hex(content),
      createdAt,
      updatedAt,
    });
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    const ownerDirectory = this.ownerDirectory(ownerId);
    if (!isSkillId(id)) return false;
    const skillDirectory = join(ownerDirectory, id);
    try {
      await stat(skillDirectory);
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
    await rm(skillDirectory, { recursive: true, force: true });
    return true;
  }

  private ownerDirectory(ownerId: string) {
    if (!isSkillId(ownerId)) {
      throw new AgentSkillStoreError("INVALID_OWNER_ID", "技能归属标识不合法");
    }
    return join(this.directory, ownerId);
  }

  private async countSkills(ownerId: string) {
    const summaries = await this.list(ownerId);
    return summaries.length;
  }

  private isoNow() {
    return new Date(this.now()).toISOString();
  }

  /** 单个技能的摘要；SKILL.md 缺失时返回 null（并发的删除/DELETE 不该让整表报错）。 */
  private async readSummary(ownerId: string, id: string) {
    const parsed = await this.readParsed(ownerId, id);
    return parsed?.summary ?? null;
  }

  private async readParsed(ownerId: string, id: string) {
    const ownerDirectory = this.ownerDirectory(ownerId);
    const skillDirectory = join(ownerDirectory, id);
    const skillPath = join(skillDirectory, AGENT_SKILL_FILE);
    let content: string;
    let info;
    try {
      content = await readFile(skillPath, "utf8");
      info = await stat(skillPath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    // 磁盘上的正文就是导入原文：解析失败说明文件被外部改坏，如实报错而不是假装空技能。
    const parsed = parseAgentSkillMarkdown(content);
    const updatedAt = info.mtime.toISOString();
    const summary = agentSkillSummarySchema.parse({
      id,
      name: parsed.name,
      description: parsed.description,
      size: Buffer.byteLength(content, "utf8"),
      hash: sha256Hex(content),
      createdAt: (await this.readCreatedAt(ownerDirectory, id)) ?? updatedAt,
      updatedAt,
    });
    return { summary, parsed };
  }

  private async readCreatedAt(ownerDirectory: string, id: string) {
    try {
      const raw = await readFile(join(ownerDirectory, id, SKILL_META_FILE), "utf8");
      return skillMetaSchema.parse(JSON.parse(raw)).createdAt;
    } catch {
      // 元数据缺失或写坏时回落到 mtime：宁可 createdAt 略微失真，也不能读不出技能。
      return null;
    }
  }
}

/** 原子写：同目录临时文件 + rename，崩溃/磁盘满不会留下半个 SKILL.md。 */
async function writeAtomically(targetPath: string, contents: string): Promise<string> {
  const temporary = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, targetPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return (await stat(targetPath)).mtime.toISOString();
}

function isSkillId(value: string) {
  return UUID_PATTERN.test(value);
}

function isMissingFile(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
