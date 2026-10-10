import { describe, expect, it, vi } from "vitest";

import {
  codexConfigPath,
  findBlender,
  hasCodexCanvasServer,
  mergeCodexCanvasServer,
  provisionBlender,
  provisionCodex,
  resolveBlenderAddonsDir,
  type ProvisionContext,
  type ProvisionFileSystem,
  type ProvisionRunner,
} from "./provision.js";

const ENTRY = {
  command: "/usr/local/bin/node",
  args: ["/repo/apps/agent/mcp/canvas-mcp.mjs"],
  env: { KACHANG_AGENT_URL: "http://127.0.0.1:8790", KACHANG_AGENT_TOKEN: "tok" },
};

function createFakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  // 种入文件时把它沿途的目录也登记下来，listDir 才能看到真正的直接子项。
  for (const key of Object.keys(initial)) {
    const segments = normalize(key).split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const candidate = segments.slice(0, index).join("/");
      if (candidate && candidate !== "/") dirs.add(candidate);
    }
  }
  const childrenOf = (dir: string) => {
    const target = normalize(dir);
    const children = new Set<string>();
    for (const key of [...files.keys(), ...dirs]) {
      const value = normalize(key);
      if (!value.startsWith(`${target}/`)) continue;
      const rest = value.slice(target.length + 1);
      if (!rest || rest.includes("/")) continue;
      children.add(rest);
    }
    return [...children];
  };
  const fs: ProvisionFileSystem & { files: Map<string, string>; dirs: Set<string> } = {
    files,
    dirs,
    async readText(filePath) {
      return files.get(filePath) ?? null;
    },
    async writeText(filePath, content) {
      files.set(filePath, content);
    },
    async ensureDir(dirPath) {
      dirs.add(dirPath);
    },
    async exists(target) {
      if (files.has(target) || dirs.has(target)) return true;
      return childrenOf(target).length > 0;
    },
    async listDir(dirPath) {
      const children = childrenOf(dirPath);
      if (!children.length) throw new Error("ENOENT");
      return children;
    },
  };
  return fs;
}

function createFakeRunner(options: { stdout?: string; code?: number | null; onExec?: (command: string, args: string[]) => { code: number | null; stdout: string } } = {}) {
  const exec = vi.fn(async (command: string, args: string[]) => {
    if (options.onExec) {
      const result = options.onExec(command, args);
      return { ...result, stderr: "" };
    }
    if (args[0] === "--version") {
      return { code: options.code ?? 0, stdout: options.stdout ?? "Blender 4.2.1\n", stderr: "" };
    }
    return { code: options.code ?? 0, stdout: options.stdout ?? "", stderr: "" };
  });
  const launch = vi.fn();
  return { exec, launch } as unknown as ProvisionRunner & { exec: typeof exec; launch: typeof launch };
}

function context(overrides: Partial<ProvisionContext> = {}) {
  return {
    fs: createFakeFs(),
    runner: createFakeRunner(),
    platform: "linux" as NodeJS.Platform,
    homeDir: "/home/u",
    env: {} as Record<string, string | undefined>,
    nodeBinary: "/usr/local/bin/node",
    agentBaseUrl: "http://127.0.0.1:8790",
    agentToken: "tok",
    assets: {
      mcpScript: "/repo/apps/agent/mcp/canvas-mcp.mjs",
      blenderAddon: "/repo/apps/agent/blender/kachang_bridge.py",
    },
    ...overrides,
  } satisfies ProvisionContext;
}

describe("mergeCodexCanvasServer", () => {
  it("adds the canvas MCP server to an empty or new config", () => {
    const merged = mergeCodexCanvasServer("", ENTRY);
    expect(merged).toContain("[mcp_servers.kachang-canvas]");
    expect(merged).toContain(`command = "/usr/local/bin/node"`);
    expect(merged).toContain(`"/repo/apps/agent/mcp/canvas-mcp.mjs"`);
    expect(merged).toContain(`KACHANG_AGENT_TOKEN = "tok"`);
    expect(merged.endsWith("\n")).toBe(true);
  });

  it("keeps unrelated configuration untouched", () => {
    const existing = [
      'model = "gpt-5-codex"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const merged = mergeCodexCanvasServer(existing, ENTRY);
    expect(merged).toContain('model = "gpt-5-codex"');
    expect(merged).toContain("[mcp_servers.other]");
    expect(merged).toContain('command = "other"');
    expect(merged.indexOf("[mcp_servers.other]")).toBeLessThan(merged.indexOf("[mcp_servers.kachang-canvas]"));
  });

  it("replaces a previous canvas section instead of duplicating it", () => {
    const twice = mergeCodexCanvasServer(mergeCodexCanvasServer("", ENTRY), { ...ENTRY, env: { ...ENTRY.env, KACHANG_AGENT_TOKEN: "next" } });
    expect(twice.match(/\[mcp_servers\.kachang-canvas\]/g)).toHaveLength(1);
    expect(twice).toContain('KACHANG_AGENT_TOKEN = "next"');
    expect(twice).not.toContain('KACHANG_AGENT_TOKEN = "tok"');
  });

  it("is idempotent and recognised", () => {
    const once = mergeCodexCanvasServer("", ENTRY);
    expect(mergeCodexCanvasServer(once, ENTRY)).toBe(once);
    expect(hasCodexCanvasServer(once, ENTRY)).toBe(true);
  });
});

describe("codexConfigPath", () => {
  it("honours CODEX_HOME and defaults to ~/.codex", () => {
    expect(codexConfigPath({ platform: "linux", homeDir: "/home/u", env: { CODEX_HOME: "/opt/codex" } }))
      .toBe("/opt/codex/config.toml");
    expect(codexConfigPath({ platform: "linux", homeDir: "/home/u", env: {} }))
      .toBe("/home/u/.codex/config.toml");
    expect(codexConfigPath({ platform: "win32", homeDir: "C:\\Users\\u", env: {} }))
      .toBe("C:\\Users\\u\\.codex\\config.toml");
  });
});

describe("provisionCodex", () => {
  it("creates the config and asks the user to restart Codex", async () => {
    const ctx = context();
    const result = await provisionCodex(ctx, "codex");
    expect(result.ok).toBe(true);
    expect(result.action).toBe("重启 Codex 后生效");
    const written = (ctx.fs as ReturnType<typeof createFakeFs>).files.get("/home/u/.codex/config.toml");
    expect(written).toContain("[mcp_servers.kachang-canvas]");
    expect(result.detail).toContain("已创建");
  });

  it("backs up an existing config before rewriting it", async () => {
    const ctx = context({
      fs: createFakeFs({ "/home/u/.codex/config.toml": 'model = "keep-me"\n' }),
    });
    const result = await provisionCodex(ctx, "codex");
    expect(result.ok).toBe(true);
    const files = (ctx.fs as ReturnType<typeof createFakeFs>).files;
    expect(files.get("/home/u/.codex/config.toml.kachang-backup")).toBe('model = "keep-me"\n');
    expect(files.get("/home/u/.codex/config.toml")).toContain('model = "keep-me"');
    expect(result.detail).toContain("备份");
  });

  it("reports an unwritable config instead of pretending success", async () => {
    const failing = {
      ...createFakeFs(),
      async writeText() { throw new Error("EPERM"); },
    } as ProvisionFileSystem;
    const result = await provisionCodex(context({ fs: failing }), "codex");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("没有权限");
  });
});

describe("Blender provisioning", () => {
  it("resolves the addon directory per platform, with an override", async () => {
    await expect(resolveBlenderAddonsDir(context(), "4.2"))
      .resolves.toBe("/home/u/.config/blender/4.2/scripts/addons");
    await expect(resolveBlenderAddonsDir(context({ platform: "darwin", homeDir: "/Users/u" }), "4.2"))
      .resolves.toBe("/Users/u/Library/Application Support/Blender/4.2/scripts/addons");
    await expect(resolveBlenderAddonsDir(context({ platform: "win32", homeDir: "C:\\Users\\u", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } }), "4.2"))
      .resolves.toBe("C:\\Users\\u\\AppData\\Roaming\\Blender Foundation\\Blender\\4.2\\scripts\\addons");
    await expect(resolveBlenderAddonsDir(context({ env: { KACHANG_BLENDER_ADDONS_DIR: "/custom/addons" } }), "4.2"))
      .resolves.toBe("/custom/addons");
  });

  it("falls back to the highest installed version directory", async () => {
    const ctx = context({
      fs: createFakeFs({ "/home/u/.config/blender/3.6/scripts/addons/.keep": "", "/home/u/.config/blender/4.2/scripts/addons/.keep": "" }),
    });
    await expect(resolveBlenderAddonsDir(ctx, null)).resolves.toBe("/home/u/.config/blender/4.2/scripts/addons");
  });

  it("finds Blender from the environment override or PATH", async () => {
    await expect(findBlender(context({ env: { KACHANG_BLENDER_BIN: "/opt/blender/blender" } })))
      .resolves.toEqual({ executable: "/opt/blender/blender", version: "4.2" });
    await expect(findBlender(context())).resolves.toEqual({ executable: "blender", version: "4.2" });
    const none = context({ runner: createFakeRunner({ code: 1 }) });
    await expect(findBlender(none)).resolves.toBeNull();
  });

  it("installs the addon, applies the configured address and launches Blender", async () => {
    const runner = createFakeRunner();
    const ctx = context({
      runner,
      fs: createFakeFs({ "/repo/apps/agent/blender/kachang_bridge.py": "DEFAULT_HOST = \"127.0.0.1\"\nDEFAULT_PORT = 9876\n" }),
    });
    const result = await provisionBlender(ctx, { launch: true, address: "127.0.0.1:9911" });
    expect(result.ok).toBe(true);
    const addon = (ctx.fs as ReturnType<typeof createFakeFs>).files.get("/home/u/.config/blender/4.2/scripts/addons/kachang_bridge/__init__.py");
    expect(addon).toContain('DEFAULT_HOST = "127.0.0.1"');
    expect(addon).toContain("DEFAULT_PORT = 9911");
    expect(runner.exec).toHaveBeenCalledWith("blender", ["--background", "--python-expr", expect.stringContaining("addon_utils.enable")], expect.anything());
    expect(runner.launch).toHaveBeenCalledWith("blender", []);
    expect(result.detail).toContain("已启动 Blender");
  });

  it("skips the slow background enable when the addon is already installed", async () => {
    const runner = createFakeRunner();
    const host = "DEFAULT_HOST = \"127.0.0.1\"\nDEFAULT_PORT = 9876\n";
    const addonsDir = "/home/u/.config/blender/4.2/scripts/addons/kachang_bridge/__init__.py";
    const ctx = context({
      runner,
      fs: createFakeFs({
        "/repo/apps/agent/blender/kachang_bridge.py": host,
        [addonsDir]: host,
      }),
    });
    const result = await provisionBlender(ctx, { launch: false });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("重启 Blender");
    expect(runner.exec).not.toHaveBeenCalledWith("blender", expect.arrayContaining(["--background"]), expect.anything());
  });

  it("explains what to do when Blender is missing", async () => {
    const ctx = context({ runner: createFakeRunner({ code: 1 }) });
    const result = await provisionBlender(ctx, { launch: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("没有找到本机 Blender");
  });
});
