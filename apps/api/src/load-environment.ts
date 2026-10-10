import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

for (const name of [".env.local", ".env"]) {
  const path = resolve(repositoryRoot, name);
  if (existsSync(path)) process.loadEnvFile(path);
}
