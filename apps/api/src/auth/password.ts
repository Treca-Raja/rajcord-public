import { hash, verify, argon2id } from 'argon2';
export const passwordOptions = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;
export function hashPassword(password: string) {
  return hash(password, passwordOptions);
}
export async function checkPassword(encoded: string, password: string) {
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
}
// Initialized once per process; unknown accounts still run the same password verification.
let dummy: Promise<string> | undefined;
export async function verifyLogin(encoded: string | null, password: string) {
  dummy ??= hashPassword('not-a-real-account-password');
  const matches = await checkPassword(encoded ?? (await dummy), password);
  return encoded !== null && matches;
}
