import { timingSafeEqual } from "node:crypto";

export function createBearerAuth(expectedToken: string) {
  const expected = expectedToken.trim();
  if (!expected) throw new Error("AGENT_RUNTIME_TOKEN is required");

  return (authorizationHeader: string | undefined) => {
    if (!authorizationHeader) return false;
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (!match?.[1]) return false;
    const provided = match[1].trim();
    if (!provided) return false;
    return tokensEqual(provided, expected);
  };
}

function tokensEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
