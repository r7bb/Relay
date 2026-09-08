import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id at the OWASP-recommended baseline (19 MiB, 2 iterations, 1 lane).
 * Memory cost is what makes GPU cracking expensive, so it is the parameter to
 * raise first if this ever needs hardening.
 */
const PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password, PARAMS);
  } catch {
    // A malformed or truncated digest is a failed login, not a 500.
    return false;
  }
}
