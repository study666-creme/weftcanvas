import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { FileAgentSkillStore } from "./store.js";
import {
  IdentityService,
  type ActiveIdentitySession,
  type CreateIdentityAccountResult,
  type IdentityPasswordHasher,
  type IdentitySessionRecord,
  type IdentityStore,
  type IdentityUserRecord,
} from "../identity/service.js";

/**
 * 路由层：鉴权、契约校验、owner 归属，以及"未注入存储时整个面 404"。
 * 这里用的存储是真实文件实现（临时目录），只有身份是内存桩。
 */
const NOW = "2026-10-16T12:00:00.000Z";
const SKILL_MD = ["# 场景速写", "", "把一句描述扩成画布构图。", "", "先定主体，再铺环境。"].join(
  "\n",
);

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "weftcanvas-skill-routes-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function createHarness(
  options: { withSkills?: boolean; maxSkillsPerOwner?: number } = { withSkills: true },
) {
  let sequence = 0;
  const identity = new IdentityService(new MemoryIdentityStore(), {
    now: () => Date.parse(NOW),
    // 每次注册给出不同的合法 UUID / 会话令牌，owner 隔离才有得测。
    createId: () => {
      sequence += 1;
      return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    },
    createToken: () => {
      sequence += 1;
      return "E".repeat(42) + String.fromCharCode(65 + (sequence % 26));
    },
    passwordHasher: new TestPasswordHasher(),
    sessionTtlMs: 60_000,
  });
  const app = createApiApp({
    catalog: {
      getCatalog: async () => {
        throw new Error("catalog should not be called");
      },
    },
    quotes: {
      createQuote: async () => {
        throw new Error("quotes should not be called");
      },
    },
    identity,
    ...(options.withSkills === false
      ? {}
      : {
          agentSkills: new FileAgentSkillStore({
            directory,
            ...(options.maxSkillsPerOwner !== undefined
              ? { maxSkillsPerOwner: options.maxSkillsPerOwner }
              : {}),
          }),
        }),
  });
  return app;
}

async function signIn(app: ReturnType<typeof createHarness>, email: string) {
  const response = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ email, password: "private-password" }),
  });
  expect(response.status).toBe(201);
  return response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
}

async function importSkill(app: ReturnType<typeof createHarness>, cookie: string, content: string) {
  return app.request("/api/v1/agent/skills", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

describe("Agent 技能路由", () => {
  it("未登录时三个端点都要求登录", async () => {
    const app = createHarness();
    expect((await app.request("/api/v1/agent/skills")).status).toBe(401);
    expect(
      (
        await app.request("/api/v1/agent/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: SKILL_MD }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/v1/agent/skills/33333333-3333-4333-8333-333333333333", {
          method: "DELETE",
        })
      ).status,
    ).toBe(401);
  });

  it("未注入存储时整个面 404，而不是 401/503", async () => {
    const app = createHarness({ withSkills: false });
    const cookie = await signIn(app, "nobody@example.com");
    expect(
      (await app.request("/api/v1/agent/skills", { headers: { Cookie: cookie } })).status,
    ).toBe(404);
    expect((await importSkill(app, cookie, SKILL_MD)).status).toBe(404);
    expect(
      (
        await app.request("/api/v1/agent/skills/33333333-3333-4333-8333-333333333333", {
          method: "DELETE",
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(404);
  });

  it("导入返回 201 且列表回读不带正文", async () => {
    const app = createHarness();
    const cookie = await signIn(app, "creator@example.com");
    const response = await importSkill(app, cookie, SKILL_MD);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as {
      data: { id: string; name: string; description: string; hash: string };
    };
    expect(payload.data.name).toBe("场景速写");
    expect(payload.data.description).toBe("把一句描述扩成画布构图。");

    const list = await app.request("/api/v1/agent/skills", { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const body = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: payload.data.id, name: "场景速写" });
    expect(body.data[0]).not.toHaveProperty("body");
  });

  it("内容没有可用正文时报 422", async () => {
    const app = createHarness();
    const cookie = await signIn(app, "creator@example.com");
    const response = await importSkill(app, cookie, "---\nname: 空技能\n---\n");
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_SKILL",
    );
  });

  it("超过每 owner 上限时报 409", async () => {
    const app = createHarness({ maxSkillsPerOwner: 1 });
    const cookie = await signIn(app, "creator@example.com");
    expect((await importSkill(app, cookie, SKILL_MD)).status).toBe(201);
    const response = await importSkill(app, cookie, SKILL_MD);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "SKILL_LIMIT_EXCEEDED",
    );
  });

  it("导入 → 删除 → 再删除报 404", async () => {
    const app = createHarness();
    const cookie = await signIn(app, "creator@example.com");
    const imported = (await (await importSkill(app, cookie, SKILL_MD)).json()) as {
      data: { id: string };
    };
    const deleted = await app.request(`/api/v1/agent/skills/${imported.data.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ data: { id: imported.data.id, deleted: true } });
    expect(
      (await app.request("/api/v1/agent/skills", { headers: { Cookie: cookie } })).status,
    ).toBe(200);
    const gone = await app.request(`/api/v1/agent/skills/${imported.data.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(gone.status).toBe(404);
  });

  it("另一个账号的技能既看不到也删不掉", async () => {
    const app = createHarness();
    const owner = await signIn(app, "owner@example.com");
    const stranger = await signIn(app, "stranger@example.com");
    const imported = (await (await importSkill(app, owner, SKILL_MD)).json()) as {
      data: { id: string };
    };

    const strangerList = await app.request("/api/v1/agent/skills", {
      headers: { Cookie: stranger },
    });
    expect(((await strangerList.json()) as { data: unknown[] }).data).toEqual([]);

    const response = await app.request(`/api/v1/agent/skills/${imported.data.id}`, {
      method: "DELETE",
      headers: { Cookie: stranger },
    });
    expect(response.status).toBe(404);

    // owner 的技能仍在。
    const ownerList = await app.request("/api/v1/agent/skills", { headers: { Cookie: owner } });
    expect(
      ((await ownerList.json()) as { data: Array<{ id: string }> }).data.map((s) => s.id),
    ).toEqual([imported.data.id]);
  });

  it("非 UUID 的 skillId 删除报 404，不触碰文件系统", async () => {
    const app = createHarness();
    const cookie = await signIn(app, "creator@example.com");
    for (const bad of ["..", "../../etc", "not-a-uuid"]) {
      const response = await app.request(`/api/v1/agent/skills/${encodeURIComponent(bad)}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(response.status, bad).toBe(404);
    }
  });
});

class MemoryIdentityStore implements IdentityStore {
  private readonly users: IdentityUserRecord[] = [];
  private readonly sessions: IdentitySessionRecord[] = [];

  async createAccount(
    user: IdentityUserRecord,
    session: IdentitySessionRecord,
  ): Promise<CreateIdentityAccountResult> {
    if (this.users.some((item) => item.normalizedEmail === user.normalizedEmail)) {
      return { kind: "email_taken" };
    }
    this.users.push(structuredClone(user));
    this.sessions.push(structuredClone(session));
    return { kind: "created" };
  }

  async findUserByNormalizedEmail(email: string) {
    const user = this.users.find((item) => item.normalizedEmail === email);
    return user ? structuredClone(user) : null;
  }

  async createSession(session: IdentitySessionRecord) {
    this.sessions.push(structuredClone(session));
    return true;
  }

  async findActiveSession(tokenHash: string, now: string): Promise<ActiveIdentitySession | null> {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    const user = this.users.find((item) => item.id === session.userId);
    if (!user) return null;
    return { user: structuredClone(user), session: structuredClone(session) };
  }

  async revokeSession(tokenHash: string, revokedAt: string) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (session) session.revokedAt = revokedAt;
  }
}

class TestPasswordHasher implements IdentityPasswordHasher {
  async hash(password: string) {
    return `test:${password}`;
  }

  async verify(password: string, encodedHash: string) {
    return encodedHash === `test:${password}`;
  }
}
