import { createDatabasePool } from "../database/pool.js";
import { CloudResourceService } from "./cloud-resource-service.js";
import { createMediaObjectStore } from "./object-store-factory.js";
import { PostgresMediaMetadataStore } from "./postgres-store.js";

/**
 * 运维用孤立素材清理：删除所有“不被任何云项目引用”的服务端素材（记录 + 对象字节），
 * 释放账号存储配额。默认 dry-run，只有显式 `--apply` 才真正删除。
 *
 *   node dist/media/cleanup-orphans-cli.js --all              # 预览全部
 *   node dist/media/cleanup-orphans-cli.js --all --apply      # 执行全部
 *   node dist/media/cleanup-orphans-cli.js --owner <id> [--apply]
 *
 * 必须显式给 --all 或 --owner，避免误删所有账号。运行环境需带 DATABASE_URL 与对象存储
 * 变量（生产经 deploy/linux/environment.mjs run /etc/weftcanvas/api.env 注入）。
 * 日志只输出脱敏 owner 前缀与数量/字节，不打印密钥。
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const all = process.argv.includes("--all");
  const ownerId = readArgument("--owner");
  if (!all && !ownerId) {
    throw new Error("specify --all or --owner <id> (add --apply to actually delete)");
  }
  const pool = createDatabasePool(process.env);
  if (!pool) throw new Error("DATABASE_URL is required to clean orphaned cloud media");
  const store = new PostgresMediaMetadataStore(pool);
  const service = new CloudResourceService(store, createMediaObjectStore(process.env));

  try {
    const owners = ownerId ? [ownerId] : await store.listOwnersWithOrphanedMedia();
    let ownersTouched = 0;
    let deletedCount = 0;
    let freedBytes = 0;
    for (const owner of owners) {
      const { items } = await service.list(owner, 0);
      const orphans = items.filter((item) => item.orphaned);
      if (!orphans.length) continue;
      ownersTouched += 1;
      const orphanBytes = orphans.reduce((sum, item) => sum + item.size, 0);
      if (!apply) {
        console.log(
          `[dry-run] owner=${maskOwner(owner)} orphans=${orphans.length} bytes=${orphanBytes}`,
        );
        continue;
      }
      const result = await service.cleanup(
        owner,
        orphans.map((item) => item.id),
        0,
      );
      deletedCount += result.deleted.length;
      freedBytes += result.freedBytes;
      console.log(
        `[apply] owner=${maskOwner(owner)} deleted=${result.deleted.length} freed=${result.freedBytes} skipped=${result.skipped.length}`,
      );
    }
    console.log(
      apply
        ? `done owners=${ownersTouched} deleted=${deletedCount} freedBytes=${freedBytes}`
        : `dry-run owners=${ownersTouched}（加 --apply 执行删除）`,
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function readArgument(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function maskOwner(ownerId: string) {
  return ownerId.length <= 8 ? `${ownerId.slice(0, 2)}…` : `${ownerId.slice(0, 8)}…`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
