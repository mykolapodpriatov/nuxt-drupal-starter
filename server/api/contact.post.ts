import { contactSchema, toFieldErrors } from '#shared/contact';
import { checkRateLimit } from '../utils/rate-limit';
import { useDrupal } from '../utils/drupal';

/**
 * Accept a contact submission and hand it to Drupal.
 *
 * The browser never posts to Drupal directly, and that is the whole design.
 * A direct write would mean shipping a credential that can create content to
 * every visitor, and exposing Drupal's write surface to the open internet. Here
 * the front end is the only thing Drupal accepts writes from, and it validates
 * before forwarding.
 *
 * Three gates, in the order that costs least first:
 *
 * 1. **Rate limit.** Rejected before parsing, so a flood costs almost nothing.
 * 2. **Honeypot.** A hidden field no human sees; anything in it came from
 *    something filling every input it found. Answered with a plausible success
 *    rather than an error, so a bot has no signal to adapt to.
 * 3. **Schema validation.** The server's copy is the real gate — the client
 *    shares the schema for immediate feedback, but anything the browser
 *    enforces can be skipped by not using the browser.
 */
export default defineEventHandler(async (event) => {
  // `x-forwarded-for` is trivially spoofed, and is used anyway: this is a
  // speed bump against scripted abuse, not an access control. Treating a
  // forged header as a distinct client costs an attacker nothing, but the
  // honest majority of traffic is limited correctly.
  const clientKey =
    getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim() ??
    getRequestIP(event) ??
    'unknown';

  const limit = checkRateLimit(`contact:${clientKey}`, 5, 10 * 60_000);
  if (!limit.allowed) {
    setHeader(event, 'retry-after', limit.retryAfter);
    throw createError({
      statusCode: 429,
      statusMessage: 'Too many submissions. Please try again later.',
    });
  }

  const body = await readBody<unknown>(event);
  const parsed = contactSchema.safeParse(body);

  if (!parsed.success) {
    const errors = toFieldErrors(parsed.error);

    // The honeypot failing is not a validation problem to report — telling a
    // bot which field gave it away is telling it how to succeed next time.
    if (errors.website) {
      console.warn(`[contact] honeypot triggered from ${clientKey}`);
      return { ok: true as const };
    }

    // 422 rather than 400: the request was well-formed JSON, its contents were
    // just unacceptable — and the distinction is what lets the client tell a
    // field error apart from a bug in its own request.
    throw createError({
      statusCode: 422,
      statusMessage: 'Validation failed',
      data: { errors },
    });
  }

  const { name, email, subject, message } = parsed.data;
  const { client } = useDrupal(event);
  const { drupal } = useRuntimeConfig(event);

  if (!drupal.baseUrl) {
    // Fixture mode has no backend to write to. Accepting the submission and
    // discarding it would be a lie; saying so keeps the demo honest.
    console.info(`[contact] fixture mode: discarded a submission from ${email}`);
    return { ok: true as const, delivered: false as const };
  }

  try {
    // Not JSON:API. Writing through it needs `read_only` off, and that flag is
    // global — switching it off to accept a contact form opens the write
    // surface of every entity type the requester can touch, to anyone who finds
    // the endpoint, bypassing the validation and rate limit above.
    // `drupal/modules/custom/nuxt_contact` is a POST route that creates exactly
    // one entity type. See ADR-006.
    await client.getJson('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mail: email, subject, message }),
    });
  } catch (error: unknown) {
    // The visitor is not responsible for the CMS being unavailable, and the
    // error text may name internal hosts — so it is logged in full and
    // reported generically.
    console.error(
      '[contact] Drupal rejected a submission:',
      error instanceof Error ? error.message : error,
    );
    throw createError({
      statusCode: 502,
      statusMessage: 'We could not deliver your message. Please try again shortly.',
    });
  }

  return { ok: true as const, delivered: true as const };
});
