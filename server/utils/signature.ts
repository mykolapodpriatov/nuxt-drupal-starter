import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring tokens for the two places this starter trusts a caller.
 *
 * Preview links let an editor see unpublished content. Revalidation webhooks
 * let Drupal purge the front end's cache. Both are requests from outside that
 * cause the front end to do something it will not do for the public, so both
 * need to be unforgeable — and neither justifies a session, a database or an
 * OAuth flow.
 *
 * An HMAC over the payload plus an expiry, with a shared secret, is the right
 * size of mechanism: stateless, verifiable by either side, and the secret never
 * travels.
 *
 * Three details carry the security, and all three are easy to get subtly wrong:
 *
 * 1. **The expiry is inside the signature.** A token of the form
 *    `payload.expiry.signature` where the signature covers only the payload can
 *    have its expiry rewritten by the holder, which makes it permanent. Here the
 *    signed message is `payload:expiry`.
 * 2. **Comparison is constant-time.** `a === b` on strings returns as soon as
 *    two characters differ, and that timing difference is enough to recover a
 *    signature byte by byte given enough attempts. `timingSafeEqual` does not
 *    leak the position of the first mismatch.
 * 3. **A missing secret fails closed.** An unset `NUXT_DRUPAL_PREVIEW_SECRET`
 *    must not mean "signatures are not checked" — that is the deployment
 *    mistake that publishes every draft. Verification returns `false` when the
 *    secret is empty, so preview simply does not work until it is configured.
 */

/** Why a token was rejected. Never surfaced to the caller — see `verifyToken`. */
export type TokenFailure = 'no-secret' | 'malformed' | 'expired' | 'bad-signature';

export type TokenResult =
  | { valid: true; payload: string }
  | { valid: false; reason: TokenFailure };

/** Base64url, so a token survives being put in a query string unescaped. */
function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('base64url');
}

/**
 * Create a token for `payload` valid for `ttlSeconds`.
 *
 * @throws when the secret is empty — a caller asking to sign without a secret
 *   has a configuration bug, and returning an unsigned token would hide it.
 */
export function createToken(payload: string, secret: string, ttlSeconds: number): string {
  if (!secret) throw new Error('createToken: a signing secret is required');
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const message = `${payload}:${expiresAt}`;
  return `${encode(payload)}.${expiresAt}.${sign(message, secret)}`;
}

/**
 * Verify a token and return its payload.
 *
 * The `reason` is for logs only. Telling a caller *why* their token was
 * rejected distinguishes "expired" from "forged", which tells an attacker
 * whether they have the right shape and are only missing a valid signature.
 */
export function verifyToken(token: string, secret: string): TokenResult {
  // Fail closed. An unset secret must never mean "accept everything".
  if (!secret) return { valid: false, reason: 'no-secret' };

  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };

  const [encodedPayload, expiryPart, provided] = parts as [string, string, string];

  const expiresAt = Number(expiryPart);
  if (!Number.isInteger(expiresAt)) return { valid: false, reason: 'malformed' };

  let payload: string;
  try {
    payload = decode(encodedPayload);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // The expiry is part of the signed message, so a holder cannot extend it.
  const expected = sign(`${payload}:${expiresAt}`, secret);

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // expected length — so the lengths are compared first and both paths return
  // the same answer.
  if (expectedBuffer.length !== providedBuffer.length) {
    return { valid: false, reason: 'bad-signature' };
  }
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { valid: false, reason: 'bad-signature' };
  }

  // Checked after the signature, deliberately: an unsigned token should be
  // rejected as a forgery rather than reported as expired.
  if (expiresAt < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}

/**
 * Verify a webhook body against a signature header.
 *
 * Signs the raw body rather than a parsed object: two JSON documents that parse
 * equal can serialise differently, so signing the parsed form means the sender
 * and receiver can disagree about what was signed.
 */
export function verifyBodySignature(
  rawBody: string,
  providedSignature: string,
  secret: string,
): boolean {
  if (!secret || !providedSignature) return false;

  const expected = sign(rawBody, secret);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  // Accept the common `sha256=…` prefix so the header is compatible with the
  // convention most webhook senders already use.
  const normalised = providedSignature.replace(/^sha256=/, '');
  const providedBuffer = Buffer.from(normalised, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
