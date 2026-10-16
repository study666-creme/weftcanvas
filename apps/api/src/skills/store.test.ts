import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSkillLimits } from "@weftcanvas/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileAgentSkillStore, AgentSkillStoreError } from "./store.js";

/**
 * 存储层：磁盘布局、原子写、owner 隔离、路径安全与配额。这些都是"看不见但
 * 安全性/数据完整性全靠它"的部分——真实临时目录上跑，不 mock fs。
 */
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const FIXED_ID = "33333333-3333-4333-8333-333333333333";

const SKILL_A = ["# 场景速写", "", "把一句描述扩成画布构图。", "", "先定主体，再铺环境。"].join(
  "\n",
);
const SKILL_B = [
  "---",
  "name: 分镜脚本",
  'description: "把剧情拆成镜头"',
  "---",
  "",
  "逐镜标注景别与运镜。",
].join("\n");

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "weftcanvas-skills-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function createStore(options: { id?: string; max?: number } = {}) {
  return new FileAgentSkillStore({
    directory,
    now: () => Date.parse("2026-10-16T12:00:00.000Z"),
    ...(options.id ? { createId: () => options.id! } : {}),
    ...(options.max !== undefined ? { maxSkillsPerOwner: options.max } : {}),
  });
}

describe("技能文件存储", () => {
  it("从第一个标题与首段兜底解析，目录布局为 owner/skill/SKILL.md", async () => {
    const store = createStore({ id: FIXED_ID });
    const summary = await store.save(OWNER_A, SKILL_A);
    expect(summary).toMatchObject({
      id: FIXED_ID,
      name: "场景速写",
      description: "把一句描述扩成画布构图。",
      createdAt: "2026-10-16T12:00:00.000Z",
    });
    expect(summary.hash).toMatch(/^[0-9a-f]{64}$/);

    const entries = await readdir(join(directory, OWNER_A, FIXED_ID));
    expect(entries.sort()).toEqual(["SKILL.md", "meta.json"]);
    expect(await readFile(join(directory, OWNER_A, FIXED_ID, "SKILL.md"), "utf8")).toBe(SKILL_A);

    const loaded = await store.read(OWNER_A, FIXED_ID);
    expect(loaded?.body).toBe(SKILL_A);
    expect(loaded?.size).toBe(Buffer.byteLength(SKILL_A, "utf8"));
  });

  it("frontmatter 的 name/description 优先于正文解析", async () => {
    const store = createStore();
    const summary = await store.save(OWNER_A, SKILL_B);
    expect(summary.name).toBe("分镜脚本");
    expect(summary.description).toBe("把剧情拆成镜头");
  });

  it("列表按 updatedAt 倒序，且不带正文", async () => {
    const store = createStore();
    const first = await store.save(OWNER_A, SKILL_A);
    const second = await store.save(OWNER_A, SKILL_B);
    // 文件系统时钟精度未必够区分两次写入，显式把 mtime 拉开。
    await utimes(
      join(directory, OWNER_A, first.id, "SKILL.md"),
      new Date("2026-10-16T10:00:00.000Z"),
      new Date("2026-10-16T10:00:00.000Z"),
    );
    await utimes(
      join(directory, OWNER_A, second.id, "SKILL.md"),
      new Date("2026-10-16T11:00:00.000Z"),
      new Date("2026-10-16T11:00:00.000Z"),
    );

    const list = await store.list(OWNER_A);
    expect(list.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(list[0]).not.toHaveProperty("body");
  });

  it("原子覆盖同一个 id：内容替换，createdAt 保持首次导入时间", async () => {
    const store = createStore({ id: FIXED_ID });
    const first = await store.save(OWNER_A, SKILL_A);
    const second = await store.save(OWNER_A, SKILL_B);
    expect(second.createdAt).toBe(first.createdAt);
    expect((await store.read(OWNER_A, FIXED_ID))?.name).toBe("分镜脚本");
    // 覆盖后不留临时文件。
    const entries = await readdir(join(directory, OWNER_A, FIXED_ID));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("owner 之间互相隔离：列表只含本人，跨 owner 读不到也删不掉", async () => {
    const store = createStore();
    const mine = await store.save(OWNER_A, SKILL_A);
    await store.save(OWNER_B, SKILL_B);

    expect((await store.list(OWNER_A)).map((item) => item.id)).toEqual([mine.id]);
    expect(await store.read(OWNER_B, mine.id)).toBeNull();
    expect(await store.remove(OWNER_B, mine.id)).toBe(false);
    // 越权移除没有破坏所有者的数据。
    expect(await store.read(OWNER_A, mine.id)).not.toBeNull();
  });

  it("拒绝非 UUID 标识与非 UUID 的生成 id，绝不拼进路径", async () => {
    const store = createStore();
    for (const bad of ["../../etc", "..", "a/b", "a\\b", "not-a-uuid"]) {
      expect(await store.read(OWNER_A, bad)).toBeNull();
      expect(await store.remove(OWNER_A, bad)).toBe(false);
    }
    await expect(store.list("../../etc")).rejects.toMatchObject({
      code: "INVALID_OWNER_ID",
    });
    await expect(store.save("..", SKILL_A)).rejects.toBeInstanceOf(AgentSkillStoreError);
    // createId 给出不合规的 id 时同样拒绝，不落任何文件。
    const poisoned = new FileAgentSkillStore({ directory, createId: () => "../escape" });
    await expect(poisoned.save(OWNER_A, SKILL_A)).rejects.toMatchObject({
      code: "INVALID_SKILL_ID",
    });
    expect((await readdir(directory)).filter((name) => name === "escape")).toEqual([]);
  });

  it("达到每 owner 上限时明确拒绝", async () => {
    const store = createStore({ max: 1 });
    await store.save(OWNER_A, SKILL_A);
    await expect(store.save(OWNER_A, SKILL_B)).rejects.toMatchObject({
      code: "SKILL_LIMIT_EXCEEDED",
    });
    // 上限按 owner 计，不串号。
    await expect(store.save(OWNER_B, SKILL_B)).resolves.toMatchObject({ name: "分镜脚本" });
  });

  it("超过正文长度上限时明确拒绝，且不落文件", async () => {
    const store = createStore();
    const tooLong = `# 长文\n\n${"x".repeat(agentSkillLimits.contentChars)}`;
    await expect(store.save(OWNER_A, tooLong)).rejects.toMatchObject({
      code: "SKILL_CONTENT_TOO_LARGE",
    });
    expect(await store.list(OWNER_A)).toEqual([]);
  });

  it("正文为空（只有 frontmatter）时按不合规拒绝", async () => {
    const store = createStore();
    await expect(store.save(OWNER_A, "---\nname: 空技能\n---\n")).rejects.toMatchObject({
      code: "INVALID_SKILL",
    });
  });

  it("删除是递归的，未知 id 返回 false", async () => {
    const store = createStore();
    const saved = await store.save(OWNER_A, SKILL_A);
    expect(await store.remove(OWNER_A, saved.id)).toBe(true);
    await expect(stat(join(directory, OWNER_A, saved.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await store.remove(OWNER_A, saved.id)).toBe(false);
  });

  it("磁盘上的文件被外部改坏时如实报错，不假装空技能", async () => {
    const store = createStore();
    const saved = await store.save(OWNER_A, SKILL_A);
    await writeFile(join(directory, OWNER_A, saved.id, "SKILL.md"), "   \n", "utf8");
    await expect(store.read(OWNER_A, saved.id)).rejects.toThrow();
  });
});
