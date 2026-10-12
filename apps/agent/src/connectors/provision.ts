import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type ProvisionFileSystem = {
  /** 读取文本；文件不存在返回 null。 */
  readText(filePath: string): Promise<string | null>;
  writeText(filePath: string, content: string): Promise<void>;
  ensureDir(dirPath: string): Promise<void>;
  exists(target: string): Promise<boolean>;
  listDir(dirPath: string): Promise<string[]>;
};

export type ProvisionRunner = {
  /** 前台执行并等待退出。 */
  exec(
    command: string,
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** 后台启动 GUI 程序，不等待退出。 */
  launch(command: string, args: string[]): void;
};

export type ProvisionContext = {
  fs: ProvisionFileSystem;
  runner: ProvisionRunner;
  platform: NodeJS.Platform;
  homeDir: string;
  env: Record<string, string | undefined>;
  nodeBinary: string;
  agentBaseUrl: string;
  agentToken: string;
  /** 仓库内两个接入资产的位置。 */
  assets: {
    /** apps/agent/mcp/canvas-mcp.mjs */
    mcpScript: string;
    /** apps/agent/blender/weftcanvas_bridge.py */
    blenderAddon: string;
  };
};

export type ProvisionResult = {
  ok: boolean;
  /** 直接展示给用户的中文说明。 */
  detail: string;
  /** 用户还需做的最后一步；不需要则为 null。 */
  action: string | null;
};

const CODEX_SERVER_NAME = "weftcanvas";
const CODEX_SERVER_HEADER = `mcp_servers.${CODEX_SERVER_NAME}`;
const BLENDER_ADDON_DIR_NAME = "weftcanvas_bridge";

/* ------------------------------------------------------------------ Codex */

export function codexConfigPath(context: Pick<ProvisionContext, "env" | "homeDir" | "platform">) {
  const codexHome = context.env.CODEX_HOME?.trim();
  if (codexHome) return joinPath(context.platform, codexHome, "config.toml");
  return joinPath(context.platform, context.homeDir, ".codex", "config.toml");
}

export type CodexMcpEntry = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * 把画布 MCP 服务写进 Codex 的 config.toml。
 * 只替换 `mcp_servers.weftcanvas` 这一段，其它内容原样保留。
 */
export function mergeCodexCanvasServer(source: string, entry: CodexMcpEntry): string {
  const remainder = stripSection(source, CODEX_SERVER_HEADER).replace(/[\s\uFEFF]+$/, "");
  const block = renderCodexBlock(entry);
  return remainder ? `${remainder}\n\n${block}\n` : `${block}\n`;
}

export function hasCodexCanvasServer(source: string, entry: CodexMcpEntry) {
  return source.includes(`[${CODEX_SERVER_HEADER}]`) && source.includes(quote(entry.args[0] ?? ""));
}

function renderCodexBlock(entry: CodexMcpEntry) {
  const args = entry.args.map((value) => quote(value)).join(", ");
  const env = Object.entries(entry.env)
    .map(([key, value]) => `${key} = ${quote(value)}`)
    .join(", ");
  return [
    `[${CODEX_SERVER_HEADER}]`,
    `command = ${quote(entry.command)}`,
    `args = [${args}]`,
    `env = { ${env} }`,
  ].join("\n");
}

/** 删除某个 section（含它的子表），保留其余文本与空行结构。 */
function stripSection(source: string, header: string) {
  if (!source) return "";
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      const name = section[1]!.trim();
      skipping = name === header || name.startsWith(`${header}.`);
      if (skipping) continue;
    }
    if (skipping) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function quote(value: string) {
  return JSON.stringify(value);
}

/**
 * 一键把画布接进 Codex：按需创建/合并 config.toml，原文件留一份备份。
 * Codex 只在启动时读配置，所以写完要求用户重启一次 Codex。
 * （`command` 仅为连接器 API 形状保留：MCP 条目以 nodeBinary 启动脚本，不依赖命令名。）
 */
export async function provisionCodex(
  context: ProvisionContext,
  _command: string,
): Promise<ProvisionResult> {
  const configPath = codexConfigPath(context);
  const entry: CodexMcpEntry = {
    command: context.nodeBinary,
    args: [context.assets.mcpScript],
    env: {
      WEFTCANVAS_AGENT_URL: context.agentBaseUrl,
      WEFTCANVAS_AGENT_TOKEN: context.agentToken,
    },
  };

  let source: string | null = null;
  try {
    source = await context.fs.readText(configPath);
  } catch {
    return { ok: false, detail: `读不到 Codex 配置：${configPath}`, action: null };
  }

  const current = source ?? "";
  if (hasCodexCanvasServer(current, entry) && mergeCodexCanvasServer(current, entry) === current) {
    return { ok: true, detail: `Codex 配置已就绪：${configPath}`, action: "重启 Codex 后生效" };
  }

  try {
    await context.fs.ensureDir(pathDir(context.platform, configPath));
    if (source !== null) {
      await context.fs.writeText(`${configPath}.weftcanvas-backup`, source);
    }
    await context.fs.writeText(configPath, mergeCodexCanvasServer(current, entry));
  } catch {
    return { ok: false, detail: `没有权限写入 Codex 配置：${configPath}`, action: null };
  }

  return {
    ok: true,
    detail:
      source === null
        ? `已创建 Codex 配置：${configPath}`
        : `已写入 Codex 配置：${configPath}（原文件备份为 config.toml.weftcanvas-backup）`,
    action: "重启 Codex 后生效",
  };
}

/* ---------------------------------------------------------------- Blender */

export type BlenderInstallation = {
  executable: string;
  /** 主次版本，例如 4.2；未知时为 null。 */
  version: string | null;
};

/** Blender 用户插件目录。版本未知时取已有版本目录里最高的一个。 */
export async function resolveBlenderAddonsDir(
  context: ProvisionContext,
  version: string | null,
): Promise<string> {
  if (context.env.WEFTCANVAS_BLENDER_ADDONS_DIR?.trim()) {
    return context.env.WEFTCANVAS_BLENDER_ADDONS_DIR.trim();
  }
  const base = blenderConfigBase(context);
  const resolved = version ?? (await highestVersionDir(context, base));
  const parts = [base];
  if (resolved) parts.push(resolved);
  parts.push("scripts", "addons");
  return joinPath(context.platform, ...parts);
}

function blenderConfigBase(context: ProvisionContext) {
  if (context.platform === "win32") {
    const appData =
      context.env.APPDATA?.trim() ||
      joinPath(context.platform, context.homeDir, "AppData", "Roaming");
    return joinPath(context.platform, appData, "Blender Foundation", "Blender");
  }
  if (context.platform === "darwin") {
    return joinPath(context.platform, context.homeDir, "Library", "Application Support", "Blender");
  }
  const configHome =
    context.env.XDG_CONFIG_HOME?.trim() || joinPath(context.platform, context.homeDir, ".config");
  return joinPath(context.platform, configHome, "blender");
}

async function highestVersionDir(context: ProvisionContext, base: string): Promise<string | null> {
  try {
    const entries = await context.fs.listDir(base);
    const versions = entries
      .map((entry) => /^(\d+)\.(\d+)/.exec(entry))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => ({ name: match[0], major: Number(match[1]), minor: Number(match[2]) }))
      .sort((left, right) => right.major - left.major || right.minor - left.minor);
    return versions[0]?.name ?? null;
  } catch {
    return null;
  }
}

export async function findBlender(context: ProvisionContext): Promise<BlenderInstallation | null> {
  const explicit = context.env.WEFTCANVAS_BLENDER_BIN?.trim();
  if (explicit) {
    return { executable: explicit, version: await readBlenderVersion(context, explicit) };
  }

  const onPath = await readBlenderVersion(context, "blender");
  if (onPath) {
    return { executable: "blender", version: onPath };
  }

  for (const candidate of await blenderCandidates(context)) {
    if (await context.fs.exists(candidate.executable)) return candidate;
  }
  return null;
}

async function blenderCandidates(context: ProvisionContext): Promise<BlenderInstallation[]> {
  if (context.platform === "darwin") {
    return [{ executable: "/Applications/Blender.app/Contents/MacOS/Blender", version: null }];
  }
  if (context.platform !== "win32") {
    return [
      { executable: "/usr/bin/blender", version: null },
      { executable: "/usr/local/bin/blender", version: null },
      { executable: "/snap/bin/blender", version: null },
      { executable: "/var/lib/flatpak/exports/bin/org.blender.Blender", version: null },
    ];
  }

  const roots = [
    context.env.ProgramFiles?.trim() || "C:\\Program Files",
    context.env["ProgramFiles(x86)"]?.trim() || "C:\\Program Files (x86)",
    context.env.LOCALAPPDATA?.trim() || joinPath("win32", context.homeDir, "AppData", "Local"),
  ];
  const candidates: BlenderInstallation[] = [];
  for (const root of roots) {
    const base =
      /Programs$/.test(root) || /Local$/.test(root)
        ? joinPath("win32", root, "Programs", "Blender Foundation")
        : joinPath("win32", root, "Blender Foundation");
    let entries: string[] = [];
    try {
      entries = await context.fs.listDir(base);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) {
      const version = /Blender\s+(\d+\.\d+)/i.exec(entry)?.[1] ?? null;
      candidates.push({
        executable: joinPath("win32", base, entry, "blender.exe"),
        version,
      });
    }
  }
  return candidates;
}

async function readBlenderVersion(
  context: ProvisionContext,
  command: string,
): Promise<string | null> {
  const result = await context.runner
    .exec(command, ["--version"], { timeoutMs: 8_000 })
    .catch(() => null);
  if (!result || result.code !== 0) return null;
  const match = /Blender\s+(\d+\.\d+)/i.exec(result.stdout);
  return match?.[1] ?? null;
}

/**
 * 一键把桥接装进 Blender：写入用户插件目录，再用一次后台启动把它启用并保存偏好，
 * 之后每次打开 Blender 都会自动起桥接。仍然连不上时（例如 Blender 已经开着）由调用方
 * 决定是否帮用户启动 Blender。
 */
export async function provisionBlender(
  context: ProvisionContext,
  options: { launch?: boolean; address?: string } = {},
): Promise<ProvisionResult> {
  const launch = options.launch ?? true;
  const installation = await findBlender(context);
  if (!installation) {
    return {
      ok: false,
      detail: "没有找到本机 Blender。装好 Blender 后重试，或设置 WEFTCANVAS_BLENDER_BIN 指向它。",
      action: null,
    };
  }

  let source: string;
  try {
    source = (await context.fs.readText(context.assets.blenderAddon)) ?? "";
  } catch {
    return { ok: false, detail: "读不到桥接插件文件，请检查安装是否完整", action: null };
  }
  if (!source.trim()) {
    return { ok: false, detail: "桥接插件文件为空，请检查安装是否完整", action: null };
  }
  source = applyBridgeAddress(source, options.address);

  const addonsDir = await resolveBlenderAddonsDir(context, installation.version);
  const addonDir = joinPath(context.platform, addonsDir, BLENDER_ADDON_DIR_NAME);
  const addonFile = joinPath(context.platform, addonDir, "__init__.py");
  const existing = await context.fs.readText(addonFile).catch(() => null);
  const alreadyInstalled = existing === source;

  try {
    if (!alreadyInstalled) {
      await context.fs.ensureDir(addonDir);
      await context.fs.writeText(addonFile, source);
    }
  } catch {
    return { ok: false, detail: `没有权限写入 Blender 插件目录：${addonDir}`, action: null };
  }

  // 已经装过同样内容就不再重复跑一次后台 Blender（每次要几秒）。
  const enabled = alreadyInstalled
    ? true
    : await enableBlenderAddon(context, installation.executable);
  const enabledNote = alreadyInstalled
    ? "插件已安装"
    : enabled
      ? "已装好插件并启用"
      : "插件已装好，但自动启用没成功（可在 Blender 插件列表里勾选一次）";

  if (!launch) {
    return { ok: true, detail: `${enabledNote}。重启 Blender 后生效。`, action: "重启 Blender" };
  }

  try {
    context.runner.launch(installation.executable, []);
  } catch {
    return { ok: true, detail: `${enabledNote}。请手动打开 Blender。`, action: "打开 Blender" };
  }
  return {
    ok: true,
    detail: `${enabledNote}，已启动 Blender，桥接会随 Blender 一起起来。`,
    action: null,
  };
}

/** 把画布里配置的 host:port 写进插件默认值，避免用户再去 Blender 面板里改。 */
function applyBridgeAddress(source: string, address: string | undefined) {
  const value = address?.trim();
  if (!value) return source;
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(value);
  if (!match) return source;
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return source;
  return source
    .replace(/^DEFAULT_HOST = .*$/m, `DEFAULT_HOST = ${JSON.stringify(match[1]!.trim())}`)
    .replace(/^DEFAULT_PORT = .*$/m, `DEFAULT_PORT = ${port}`);
}

async function enableBlenderAddon(context: ProvisionContext, executable: string) {
  const script = [
    "import addon_utils, bpy",
    `addon_utils.enable(${JSON.stringify(BLENDER_ADDON_DIR_NAME)}, default_set=True, persistent=True)`,
    "bpy.ops.wm.save_userpref()",
  ].join("; ");
  const result = await context.runner
    .exec(executable, ["--background", "--python-expr", script], { timeoutMs: 60_000 })
    .catch(() => null);
  return Boolean(result && result.code === 0);
}

/* ------------------------------------------------------------------ paths */

function joinPath(platform: NodeJS.Platform, ...parts: string[]) {
  return (platform === "win32" ? path.win32 : path.posix).join(...parts);
}

function pathDir(platform: NodeJS.Platform, filePath: string) {
  return (platform === "win32" ? path.win32 : path.posix).dirname(filePath);
}

export function defaultFileSystem(): ProvisionFileSystem {
  return {
    async readText(filePath) {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async writeText(filePath, content) {
      await writeFile(filePath, content, "utf8");
    },
    async ensureDir(dirPath) {
      await mkdir(dirPath, { recursive: true });
    },
    async exists(target) {
      try {
        await stat(target);
        return true;
      } catch {
        return false;
      }
    },
    async listDir(dirPath) {
      return readdir(dirPath);
    },
  };
}

export function defaultRunner(): ProvisionRunner {
  return {
    exec(command, args, options = {}) {
      return new Promise((resolve) => {
        const child = spawn(command, args, {
          shell: process.platform === "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolve({ code: null, stdout, stderr });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
    },
    launch(command, args) {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        ...(process.platform === "win32" ? { shell: true } : {}),
      });
      child.unref();
    },
  };
}

export function defaultProvisionContext(
  overrides: Partial<ProvisionContext> & {
    agentBaseUrl: string;
    agentToken: string;
    assets: ProvisionContext["assets"];
  },
): ProvisionContext {
  return {
    fs: defaultFileSystem(),
    runner: defaultRunner(),
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
    nodeBinary: process.execPath,
    ...overrides,
  };
}
