import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contactSchema, toFieldErrors } from '../shared/contact.js';
import { checkRateLimit, resetRateLimits } from '../server/utils/rate-limit.js';
import { buildPolicy, drupalOriginFor } from '../server/utils/csp.js';

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  subject: 'A question about the analytical engine',
  message: 'Could you tell me more about how the front end is decoupled?',
};

describe('contactSchema', () => {
  it('accepts a well-formed submission', () => {
    expect(contactSchema.safeParse(valid).success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const parsed = contactSchema.parse({ ...valid, name: '  Ada  ' });
    expect(parsed.name).toBe('Ada');
  });

  it('rejects a submission that is only whitespace', () => {
    // Trimming happens before the length check, so `"   "` is empty rather than
    // three characters long.
    expect(contactSchema.safeParse({ ...valid, name: '   ' }).success).toBe(false);
  });

  it.each([
    ['a missing name', { name: '' }],
    ['a malformed email', { email: 'not-an-email' }],
    ['a missing subject', { subject: '' }],
    ['a one-word message', { message: 'hi' }],
  ])('rejects %s', (_label, override) => {
    expect(contactSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it.each([
    ['a name', { name: 'a'.repeat(101) }],
    ['an email address', { email: `${'a'.repeat(250)}@example.test` }],
    ['a subject', { subject: 'a'.repeat(151) }],
    ['a message', { message: 'a'.repeat(5001) }],
  ])('rejects an over-long %s', (_label, override) => {
    // Bounded so a submission cannot be used to push megabytes into Drupal.
    expect(contactSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it('treats the honeypot as optional when absent', () => {
    expect(contactSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a submission with anything in the honeypot', () => {
    // No human sees the field, so a value in it came from something filling
    // every input it found.
    expect(
      contactSchema.safeParse({ ...valid, website: 'https://spam.test' }).success,
    ).toBe(false);
  });

  it('accepts an empty honeypot', () => {
    expect(contactSchema.safeParse({ ...valid, website: '' }).success).toBe(true);
  });
});

describe('toFieldErrors', () => {
  it('keys errors by field name', () => {
    const result = contactSchema.safeParse({ ...valid, email: 'nope', name: '' });
    expect(result.success).toBe(false);
    const errors = toFieldErrors(result.error!);
    expect(Object.keys(errors).sort()).toEqual(['email', 'name']);
  });

  it('keeps only the first error per field', () => {
    // Three complaints about one input is noise; the first is the one to fix.
    const result = contactSchema.safeParse({ ...valid, email: '' });
    const errors = toFieldErrors(result.error!);
    expect(typeof errors.email).toBe('string');
  });

  it('produces messages written for a visitor, not a developer', () => {
    const result = contactSchema.safeParse({ ...valid, message: 'hi' });
    expect(toFieldErrors(result.error!).message).toBe('Please write at least a sentence.');
  });
});

describe('checkRateLimit', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('allows requests up to the limit', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(checkRateLimit('client-a', 3, 60_000).allowed).toBe(true);
    }
  });

  it('blocks the request after the limit', () => {
    for (let i = 0; i < 3; i += 1) checkRateLimit('client-a', 3, 60_000);
    expect(checkRateLimit('client-a', 3, 60_000).allowed).toBe(false);
  });

  it('counts each client separately', () => {
    for (let i = 0; i < 3; i += 1) checkRateLimit('client-a', 3, 60_000);
    expect(checkRateLimit('client-b', 3, 60_000).allowed).toBe(true);
  });

  it('reports how many requests remain', () => {
    expect(checkRateLimit('client-a', 5, 60_000).remaining).toBe(4);
    expect(checkRateLimit('client-a', 5, 60_000).remaining).toBe(3);
  });

  it('reports seconds until the window resets, for Retry-After', () => {
    checkRateLimit('client-a', 1, 60_000);
    const blocked = checkRateLimit('client-a', 1, 60_000);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
  });

  it('starts a fresh window once the old one expires', () => {
    // Fake timers rather than a tiny real window: two calls in the same
    // millisecond is a coin flip, and a flaky rate-limit test is worse than
    // none.
    vi.useFakeTimers();
    checkRateLimit('client-a', 1, 60_000);
    expect(checkRateLimit('client-a', 1, 60_000).allowed).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(checkRateLimit('client-a', 1, 60_000).allowed).toBe(true);
    vi.useRealTimers();
  });

  it('never reports a negative remaining count', () => {
    for (let i = 0; i < 10; i += 1) checkRateLimit('client-a', 2, 60_000);
    expect(checkRateLimit('client-a', 2, 60_000).remaining).toBe(0);
  });
});

describe('drupalOriginFor', () => {
  it('reduces a base URL to its origin', () => {
    // A full URL with a path in a CSP source list is a common way to write a
    // directive that matches nothing.
    expect(drupalOriginFor('https://cms.example.test/subdir')).toBe(
      'https://cms.example.test',
    );
  });

  it('keeps a non-default port', () => {
    expect(drupalOriginFor('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('returns null in fixture mode', () => {
    expect(drupalOriginFor('')).toBeNull();
  });

  it('returns null for a malformed base URL rather than throwing', () => {
    // A bad value makes the policy stricter than intended, which fails
    // visibly — better than taking every response down.
    expect(drupalOriginFor('not a url')).toBeNull();
  });
});

describe('buildPolicy', () => {
  const policy = buildPolicy('https://cms.example.test');
  const directive = (name: string): string =>
    policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

  it('allows no inline or eval-ed script', () => {
    // The whole value of a CSP is here. Vue's hydration payload is a JSON
    // script tag, not executable code, so it needs neither.
    expect(directive('script-src')).toBe("script-src 'self'");
  });

  it('allows inline styles, deliberately', () => {
    // Vue's scoped styles and Nuxt's SSR <style> blocks both require it.
    // Removing it means giving up scoped styles or hashing every generated
    // block on every render — a bad trade for a directive that cannot execute.
    expect(directive('style-src')).toContain("'unsafe-inline'");
  });

  it('allows images from the Drupal origin', () => {
    // Every article image is served from there; without it the pages render
    // with broken images and a console full of CSP violations.
    expect(directive('img-src')).toContain('https://cms.example.test');
  });

  it('omits the Drupal origin in fixture mode', () => {
    expect(buildPolicy(null)).not.toContain('cms.example.test');
    expect(buildPolicy(null)).toContain("img-src 'self' data: blob:");
  });

  it('forbids framing entirely', () => {
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('restricts form submission to this origin', () => {
    // Without it, an injected <form action="https://evil.test"> can exfiltrate
    // whatever a visitor types — including a contact message.
    expect(policy).toContain("form-action 'self'");
  });

  it('pins base-uri, so an injected <base> cannot redirect relative URLs', () => {
    expect(policy).toContain("base-uri 'self'");
  });

  it('restricts connect-src to this origin', () => {
    // The browser talks to this app's server routes, never to Drupal. That is
    // what keeps the credentials server-side.
    expect(directive('connect-src')).toBe("connect-src 'self'");
  });

  it('blocks plugin content', () => {
    expect(policy).toContain("object-src 'none'");
  });

  it('upgrades insecure requests', () => {
    // An absolute http:// URL an editor pasted into body HTML is upgraded
    // rather than blocked, so mixed content does not silently break a page.
    expect(policy).toContain('upgrade-insecure-requests');
  });
});
