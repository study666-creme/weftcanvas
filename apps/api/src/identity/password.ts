import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

import type { IdentityPasswordHasher } from "./types.js";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 32 * 1024 * 1024;
const DUMMY_SALT = Buffer.alloc(SALT_LENGTH).toString("base64url");
const DUMMY_DIGEST = Buffer.alloc(KEY_LENGTH).toString("base64url");

export const DUMMY_PASSWORD_HASH = encode(DUMMY_SALT, DUMMY_DIGEST);

export class ScryptPasswordHasher implements IdentityPasswordHasher {
  async hash(password: string) {
    const salt = randomBytes(SALT_LENGTH);
    const digest = await derive(password, salt);
    return encode(salt.toString("base64url"), digest.toString("base64url"));
  }

  async verify(password: string, encodedHash: string) {
    const parsed = parse(encodedHash);
    const comparison = parsed ?? parse(DUMMY_PASSWORD_HASH)!;
    const digest = await derive(password, comparison.salt);
    const matches = timingSafeEqual(digest, comparison.digest);
    return parsed !== null && matches;
  }
}

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(password, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function encode(salt: string, digest: string) {
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${digest}`;
}

function parse(value: string) {
  const [algorithm, n, r, p, encodedSalt, encodedDigest, extra] = value.split("$");
  const valid = algorithm === "scrypt"
    && n === String(SCRYPT_N)
    && r === String(SCRYPT_R)
    && p === String(SCRYPT_P)
    && !extra;
  if (!valid || !encodedSalt || !encodedDigest) return null;
  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const digest = Buffer.from(encodedDigest, "base64url");
    if (salt.length !== SALT_LENGTH || digest.length !== KEY_LENGTH) return null;
    return { salt, digest };
  } catch {
    return null;
  }
}
