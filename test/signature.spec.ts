import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createToken,
  verifyBodySignature,
  verifyToken,
} from '../server/utils/signature.js';

const SECRET = 'a-secret-that-only-drupal-and-nuxt-share';

describe('createToken', () => {
  it('produces a three-part token', () => {
    expect(createToken('node-1', SECRET, 600).split('.')).toHaveLength(3);
  });

  it('refuses to sign without a secret', () => {
    // A caller asking to sign with no secret has a configuration bug; returning
    // an unsigned token would hide it until something accepted the token.
    expect(() => createToken('node-1', '', 600)).toThrow(/secret is required/);
  });

  it('produces a different token for a different payload', () => {
    expect(createToken('a', SECRET, 600)).not.toBe(createToken('b', SECRET, 600));
  });
});

describe('verifyToken', () => {
  it('accepts a token it just issued and returns the payload', () => {
    const token = createToken('4f2b-uuid', SECRET, 600);
    expect(verifyToken(token, SECRET)).toEqual({ valid: true, payload: '4f2b-uuid' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = createToken('node-1', SECRET, 600);
    expect(verifyToken(token, 'a-different-secret')).toEqual({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('fails closed when no secret is configured', () => {
    // The deployment mistake this guards against is an unset
    // NUXT_DRUPAL_PREVIEW_SECRET quietly meaning "do not check signatures",
    // which publishes every draft.
    const token = createToken('node-1', SECRET, 600);
    expect(verifyToken(token, '')).toEqual({ valid: false, reason: 'no-secret' });
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    const token = createToken('node-1', SECRET, 60);
    vi.advanceTimersByTime(61_000);
    expect(verifyToken(token, SECRET)).toEqual({ valid: false, reason: 'expired' });
    vi.useRealTimers();
  });

  it('accepts a token that has not expired yet', () => {
    vi.useFakeTimers();
    const token = createToken('node-1', SECRET, 60);
    vi.advanceTimersByTime(59_000);
    expect(verifyToken(token, SECRET).valid).toBe(true);
    vi.useRealTimers();
  });

  it('rejects a token whose expiry was rewritten', () => {
    // The attack this defeats: take a token that has expired, edit the plain
    // expiry component to a future time, and reuse it forever. It fails because
    // the expiry is inside the signed message, not merely adjacent to it.
    const token = createToken('node-1', SECRET, 60);
    const [payload, , signature] = token.split('.') as [string, string, string];
    const forged = `${payload}.${Math.floor(Date.now() / 1000) + 99_999}.${signature}`;

    expect(verifyToken(forged, SECRET)).toEqual({ valid: false, reason: 'bad-signature' });
  });

  it('rejects a token whose payload was swapped', () => {
    // Otherwise a preview link for one draft grants preview of every draft.
    const token = createToken('node-1', SECRET, 600);
    const other = createToken('node-2', SECRET, 600);
    const [, expiry, signature] = token.split('.') as [string, string, string];
    const forged = `${other.split('.')[0]}.${expiry}.${signature}`;

    expect(verifyToken(forged, SECRET).valid).toBe(false);
  });

  it('reports a forged signature rather than an expiry when both are wrong', () => {
    // Order matters for what an attacker learns: "expired" would confirm the
    // signature was accepted, telling them they have the secret.
    vi.useFakeTimers();
    const token = createToken('node-1', SECRET, 60);
    vi.advanceTimersByTime(61_000);
    const [payload, expiry] = token.split('.') as [string, string];
    const forged = `${payload}.${expiry}.not-a-real-signature-at-all-here`;

    expect(verifyToken(forged, SECRET).reason).toBe('bad-signature');
    vi.useRealTimers();
  });

  it.each([
    ['an empty string', ''],
    ['one part', 'justpayload'],
    ['two parts', 'payload.123'],
    ['four parts', 'a.1.b.c'],
    ['a non-numeric expiry', 'cGF5bG9hZA.notanumber.sig'],
  ])('rejects %s as malformed', (_label, token) => {
    expect(verifyToken(token, SECRET).valid).toBe(false);
  });

  it('survives a payload containing the separator character', () => {
    // The payload is base64url-encoded precisely so a colon or a dot in it
    // cannot shift the field boundaries.
    const token = createToken('node:1.with.dots', SECRET, 600);
    expect(verifyToken(token, SECRET)).toEqual({
      valid: true,
      payload: 'node:1.with.dots',
    });
  });
});

describe('verifyBodySignature', () => {
  const body = JSON.stringify({ paths: ['/blog/hello'] });
  /**
   * What Drupal would send: HMAC-SHA256 of the raw body, base64url.
   *
   * Built from the crypto primitive rather than by calling the production
   * signing helper, so the test still fails if that helper silently changes
   * algorithm or encoding — a test that signs with the code under test can only
   * ever agree with it.
   */
  const signatureFor = (raw: string, secret: string): string =>
    createHmac('sha256', secret).update(raw).digest('base64url');

  it('accepts a correctly signed body', () => {
    expect(verifyBodySignature(body, signatureFor(body, SECRET), SECRET)).toBe(true);
  });

  it('accepts the sha256= prefix webhook senders conventionally use', () => {
    expect(
      verifyBodySignature(body, `sha256=${signatureFor(body, SECRET)}`, SECRET),
    ).toBe(true);
  });

  it('rejects a body that was modified after signing', () => {
    const tampered = JSON.stringify({ paths: ['/', '/blog/hello'] });
    expect(verifyBodySignature(tampered, signatureFor(body, SECRET), SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyBodySignature(body, signatureFor(body, 'other'), SECRET)).toBe(false);
  });

  it('fails closed with no secret configured', () => {
    expect(verifyBodySignature(body, signatureFor(body, SECRET), '')).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyBodySignature(body, '', SECRET)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which would turn a forged
    // request into a 500 — and the exception itself would leak the expected
    // length.
    expect(() => verifyBodySignature(body, 'short', SECRET)).not.toThrow();
    expect(verifyBodySignature(body, 'short', SECRET)).toBe(false);
  });
});

/**
 * Cross-language contract: signatures produced by Drupal, verified here.
 *
 * `FrontendSigner.php` and `signature.ts` implement the same scheme in two
 * languages with no shared library between them. That is a deliberate
 * trade — the scheme is small enough that duplicating it beats introducing a
 * dependency on both sides — but it means the two can silently diverge on any
 * of the details that do not announce themselves: base64 vs base64url, padded
 * vs unpadded, raw digest vs hex, `payload:expiry` vs `payload.expiry`.
 *
 * Every one of those produces a signature that looks correct and verifies
 * false, and the symptom is "preview links stopped working" with nothing in
 * either log to say why.
 *
 * The values below were produced by the real PHP implementation running in
 * Drupal 11 and captured verbatim, so this fails if either side changes the
 * encoding.
 */
describe('interoperability with the Drupal signer', () => {
  const PREVIEW_SECRET = 'test-preview-secret';
  const REVALIDATE_SECRET = 'test-revalidate-secret';

  /** Emitted by `json_encode(['paths' => [...]], JSON_UNESCAPED_SLASHES)`. */
  const PHP_BODY = '{"paths":["/blog/hello"]}';
  const PHP_BODY_SIGNATURE = 'H8gTwl5i8xVl1Xq6l_CFhMWI_31nUGKid_DfBMnXfHA';

  /** `FrontendSigner::token('test-uuid', 'nuxt_preview_secret', 600)`. */
  const PHP_TOKEN = 'dGVzdC11dWlk.1788367870.MluV9UqTjkSrVO3gz2DaA9AZLq5lUcHoWUKs3J-Ovkw';
  /** One second before the captured token's expiry. */
  const BEFORE_EXPIRY = 1_788_367_869_000;

  it('accepts a webhook body signed by Drupal', () => {
    expect(verifyBodySignature(PHP_BODY, PHP_BODY_SIGNATURE, REVALIDATE_SECRET)).toBe(true);
  });

  it('rejects that signature against the wrong secret', () => {
    expect(verifyBodySignature(PHP_BODY, PHP_BODY_SIGNATURE, PREVIEW_SECRET)).toBe(false);
  });

  it('accepts a preview token issued by Drupal and reads its payload', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_EXPIRY);
    expect(verifyToken(PHP_TOKEN, PREVIEW_SECRET)).toEqual({
      valid: true,
      payload: 'test-uuid',
    });
    vi.useRealTimers();
  });

  it('rejects a Drupal-issued token once it expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_EXPIRY + 2000);
    expect(verifyToken(PHP_TOKEN, PREVIEW_SECRET).valid).toBe(false);
    vi.useRealTimers();
  });

  it('rejects a Drupal-issued token against the wrong secret', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_EXPIRY);
    expect(verifyToken(PHP_TOKEN, REVALIDATE_SECRET).reason).toBe('bad-signature');
    vi.useRealTimers();
  });

  it('uses unpadded base64url on both sides', () => {
    // The encoding detail most likely to drift: PHP's base64_encode pads with
    // `=` and uses `+/`, Node's base64url does neither.
    expect(PHP_BODY_SIGNATURE).not.toContain('=');
    expect(PHP_BODY_SIGNATURE).not.toMatch(/[+/]/);
  });
});
