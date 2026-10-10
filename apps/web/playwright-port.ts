export const DEFAULT_PLAYWRIGHT_PORT = 4173;

export function resolvePlaywrightPort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PLAYWRIGHT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return DEFAULT_PLAYWRIGHT_PORT;
  return port;
}
