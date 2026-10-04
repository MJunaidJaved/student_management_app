/**
 * Password hashing and policy (Part 6.1).
 *
 * argon2id, as the brief prefers. `@node-rs/argon2` rather than the `argon2`
 * package because the latter builds through node-gyp, and a native build step
 * on Windows is a reliable way to make `npm install` fail on the machine this
 * is developed on. This one ships prebuilt binaries.
 *
 * argon2id specifically — not argon2i or argon2d. It is the hybrid, and it is
 * what resists both GPU cracking and side-channel attacks, which is why it is
 * the variant RFC 9106 recommends for password storage.
 */

import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import { ValidationError } from '../errors';

/**
 * Cost parameters.
 *
 * 19 MiB and 2 iterations is the RFC 9106 second-recommended option, and it is
 * chosen over the higher-memory variant because this runs on a modest server
 * that also serves requests. The real protection here is the memory cost: it is
 * what makes large-scale GPU cracking expensive, far more than the iteration
 * count does.
 *
 * These are read back out of the stored hash on verify, so raising them later
 * does not invalidate existing passwords — old hashes keep verifying with their
 * own parameters.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/**
 * Check a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash. A corrupt or
 * truncated hash in the database must read as "wrong password" and not as a
 * 500 — a stack trace from the login endpoint tells an attacker that the
 * account exists and that something about it is unusual.
 */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

/**
 * A dummy hash used to burn the same CPU time when no user was found.
 *
 * Part 6.1 requires login to take a similar time whether the username or the
 * password was wrong. Without this, "no such user" returns in a millisecond
 * while a real user's wrong password costs a full argon2 verification, and the
 * difference is measurable from outside — which turns the login endpoint into a
 * username oracle regardless of how carefully the message is worded.
 *
 * Generated once at startup rather than hard-coded, so it always matches the
 * current cost parameters.
 */
let decoyHash: string | null = null;

export async function burnPasswordTime(plain: string): Promise<false> {
  decoyHash ??= await hashPassword('a-password-that-belongs-to-nobody');
  await verifyPassword(plain, decoyHash);
  return false;
}

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Passwords rejected outright.
 *
 * A short deny-list, not a breach corpus. The brief asks for "common or
 * breached password rejection"; doing that properly means a k-anonymity lookup
 * against a service such as Pwned Passwords, which is an outbound HTTP call
 * from the password-change path and needs a decision about failure behaviour
 * (fail open or fail closed). That is listed as deferred rather than pretended
 * at. This catches the handful that a staff member genuinely does try first.
 */
const FORBIDDEN = new Set([
  'password', 'password1', 'password123', 'passw0rd',
  '1234567890', '12345678', '123456789',
  'qwertyuiop', 'qwerty123',
  'iloveyou', 'welcome1', 'admin123', 'administrator',
  'school123', 'teacher123', 'student123',
  'letmein123', 'changeme', 'changeme123',
]);

/**
 * Validate a new password, throwing with every failure at once.
 *
 * All the reasons are collected rather than returning the first, because
 * fixing one rule at a time across four round trips is a genuinely unpleasant
 * way to change a password.
 */
export function assertPasswordAcceptable(
  plain: string,
  context: { username?: string | undefined } = {},
): void {
  const issues: { field: string; message: string }[] = [];
  const field = 'newPassword';

  if (plain.length < MIN_PASSWORD_LENGTH) {
    issues.push({ field, message: `Must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  // A cap, because argon2's cost scales with input and an unbounded password is
  // a cheap way to make the login endpoint expensive.
  if (plain.length > 200) {
    issues.push({ field, message: 'Must be 200 characters or fewer.' });
  }
  if (plain.trim() !== plain) {
    issues.push({ field, message: 'Must not begin or end with a space.' });
  }
  if (!/[A-Za-z]/.test(plain) || !/\d/.test(plain)) {
    issues.push({ field, message: 'Must contain at least one letter and one number.' });
  }

  const folded = plain.toLowerCase();
  if (FORBIDDEN.has(folded)) {
    issues.push({ field, message: 'That password is too common. Choose something else.' });
  }
  // A password that is just the username is the single most common choice when
  // an admin sets one on someone's behalf.
  if (context.username && folded.includes(context.username.toLowerCase())) {
    issues.push({ field, message: 'Must not contain the username.' });
  }
  if (/^(.)\1+$/.test(plain)) {
    issues.push({ field, message: 'Must not be the same character repeated.' });
  }

  if (issues.length) {
    throw new ValidationError('That password does not meet the policy.', issues);
  }
}

/**
 * A temporary password for a newly created or admin-reset account.
 *
 * Deliberately excludes characters that are misread when a password is written
 * on a slip of paper and handed to a parent: 0/O, 1/l/I, 5/S, 2/Z. The whole
 * point of a temporary password is that it gets typed correctly once.
 *
 * `randomInt` rather than `Math.random`, and rejection-free because the
 * alphabet length divides evenly into the rejection-sampled range `randomInt`
 * already provides.
 */
export function generateTemporaryPassword(length = 12): string {
  const alphabet = 'ABCDEFGHJKMNPQRTUVWXYabcdefghjkmnpqrtuvwxy34679';

  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
  }
  // The policy demands a letter and a digit; with this alphabet that is
  // overwhelmingly likely but not guaranteed, so it is enforced rather than
  // assumed. Recursion depth here is bounded by probability, not by input.
  if (!/[A-Za-z]/.test(out) || !/\d/.test(out)) return generateTemporaryPassword(length);
  return out;
}
