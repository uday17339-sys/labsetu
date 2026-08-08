import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Argon2id parameters (SECURITY.md §2).
 *
 * 64 MiB / 3 passes / 4 lanes is a commonly recommended interactive-login
 * baseline. Raising memoryCost is the most effective lever against GPU
 * cracking, and should be re-tuned against real hardware before production —
 * the target is roughly 250-500ms per hash on the API instance.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536, // KiB = 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/**
 * Never throws on a malformed stored hash — returns false. A corrupted hash
 * column must read as "wrong password", not as a 500 that tells an attacker
 * the account exists and is in an unusual state.
 */
export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain, OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Fixed-cost decoy used when the account does not exist, so login timing does
 * not reveal which emails are registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

export async function burnTiming(plain: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plain);
}
