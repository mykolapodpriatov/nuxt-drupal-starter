# ADR-005: Signed, expiring links for preview and cache invalidation

- **Status:** accepted
- **Date:** 2026-09-02

## Context

Two things have to cross the boundary from Drupal into the front end, and both
ask the front end to do something it will not do for the public:

- **Preview.** An editor needs to see unpublished content at a URL they can open
  and share with a reviewer. The public must not.
- **Revalidation.** When content changes, the front end has to drop the cached
  pages that showed it. Without that, the choice is between stale pages and no
  caching at all — `swr` means an editor's change appears within the TTL, and
  the gap between "within an hour" and "now" is the difference between a CMS
  that feels live and one that feels broken.

Neither caller is a *user*. Drupal is a server; a preview link is opened by
someone who may have no account on the front end at all. So sessions, cookies
and OAuth are the wrong shape: there is no login to hang them from, and adding
one would mean the front end maintaining its own identity system alongside
Drupal's.

The failure mode that matters is asymmetric. A preview endpoint that is too
strict inconveniences an editor. One that is too loose publishes every draft in
the CMS, and does so silently.

## Decision

An HMAC-SHA256 signature over the payload plus an expiry, with a secret shared
between Drupal and the front end. Stateless, verifiable by either side, and the
secret never travels.

```
token = base64url(payload) "." expiry "." base64url(HMAC(payload ":" expiry))
```

Three details carry the security, and all three are easy to get subtly wrong:

**The expiry is inside the signed message.** A token of the form
`payload.expiry.signature` whose signature covers only the payload can have its
expiry rewritten by whoever holds it, which makes a fifteen-minute link
permanent. The signed message is `payload:expiry`, so editing the plain
component invalidates it. There is a test that performs exactly this forgery.

**Comparison is constant-time.** `a === b` on strings returns as soon as two
characters differ, and that timing difference recovers a signature byte by byte
given enough attempts. `timingSafeEqual` does not leak the position of the first
mismatch — and lengths are compared separately first, because it throws on a
length mismatch and the exception would itself leak the expected length.

**A missing secret fails closed.** An unset `NUXT_DRUPAL_PREVIEW_SECRET` must
not mean "signatures are not checked". That is the deployment mistake that
publishes every draft, and it is the one that looks like everything working.
Verification returns false with no secret, so preview simply does not work until
it is configured.

Beyond the signature:

**The preview token's payload is the node id it was issued for**, and it is
compared against the id in the path. Without that comparison, one preview link
grants preview of every draft — the difference between a link an editor can
paste into a review thread and one that cannot leave the building.

**An invalid preview request is a 404, not a 401.** A 401 confirms that
something exists at the address and only the credential is missing. For draft
content, that confirmation is itself the leak.

**Revalidation signs the raw body, not the parsed object.** Two JSON documents
that parse equal can serialise differently, so signing the parsed form lets
sender and receiver disagree about what was signed. Paths are validated before
use — a cache key is derived from them, and an unvalidated path is a way to
address entries the caller has no business touching.

**Revalidation failure never blocks a save.** An editor pressing Save is not
responsible for the front end being reachable. Every failure is logged and
swallowed on the Drupal side, with a two-second timeout; the worst case is a
page that stays cached for its normal TTL.

**The previous alias is purged alongside the new one.** Renaming a URL otherwise
leaves the old path cached and still serving content that has moved — the
failure nobody tests for, because the edit that caused it looked successful.

**Secrets live in `settings.php`, not configuration.** Drupal configuration is
exported to `config/sync` and committed. A secret in configuration is a secret
in git.

## Alternatives considered

**A bearer token in a header.** Fine for the webhook, useless for preview: a
preview link is a URL an editor clicks, and a header cannot travel in one.

**A session cookie issued by the front end.** Requires the front end to have its
own identity system, and to decide who is an editor — duplicating a judgement
Drupal already makes correctly.

**An unguessable UUID in the URL, with no signature.** No expiry, no revocation,
and a link that leaks once is valid forever. It also cannot distinguish "this
link is for node A" from "this link is for anything", so a single leaked URL
becomes a key to the whole draft corpus.

**Drupal renders the preview itself.** Loses the entire point: the editor would
be reviewing Drupal's theme, not the front end that will actually serve the
content.

**A nonce store to prevent webhook replay.** Rejected as disproportionate. The
worst a replayed purge does is evict a cache entry that repopulates on the next
request. A nonce store would cost more, in moving parts, than the attack does.

## Consequences

**Easier.** Preview works for anyone holding a link, with no account on the
front end. Content changes appear immediately. Both endpoints are stateless, so
they work unchanged behind a load balancer or on a serverless platform.

**Harder.** Two secrets have to be configured in two places and kept in step. A
mismatch presents as "preview links stopped working" with a `bad-signature` line
in the front end's log and nothing on the Drupal side — which is why the
rejection reason is logged there rather than silently swallowed.

**Now has to be true.** `FrontendSigner.php` and `server/utils/signature.ts`
implement the same scheme in two languages with no shared library. They can
diverge on any detail that does not announce itself: base64 versus base64url,
padded versus unpadded, raw digest versus hex, `:` versus `.` as the separator.
Every one of those produces a signature that looks right and verifies false.

So the contract is pinned by test: `test/signature.spec.ts` contains a token and
a body signature produced by the real PHP implementation running in Drupal 11,
captured verbatim. If either side changes its encoding, that test fails rather
than a preview link doing so in production.
