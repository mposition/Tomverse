# Tomverse Chat mobile authentication

- Status: Phase 0 approved; N2 implementation authorized
- Approval: `.github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md`
  sections 8.1-8.2, recorded in `bb108653da93e039a659be2a281ca4cd7561a477`;
  approved design SHA `190056fc2ee9ffc923a8f6e1331081e272762d2f`;
  approved by `mposition` on 2026-08-31
- Decision owners: Backend/AI and Mobile/Release, **jointly**
- Gates: `AUTH-01` through `AUTH-04`, `PRIVACY-01`, `STORE-01`, `STORE-02`
- Related: `docs/ops/tomverse-chat-store-review.md`,
  `docs/policy/tomverse-chat-delivery-plan.md` §7

Joint ownership is part of the decision, not a note about it. The delivery plan
puts token issuance, rotation, reuse detection and revocation under Backend/AI
and Mobile/Release together, as design and implementation rather than a
review-only handoff, so no one person is the single point of failure on the
boundary that holds every account.

## The problem

The web session is a NextAuth JWT in a secure cookie (`session.strategy: "jwt"`,
`useSecureCookies` in production). A Capacitor app runs from `capacitor://localhost`,
which is a different origin with different cookie semantics, so the web session
cannot simply be assumed to work there.

The decision is therefore **not** to make cookies work from the app shell, but
to add a separate bearer-token path beside the cookie path, with the cookie path
unchanged.

## Decision

**Keep secure cookie sessions for the web. Add a mobile bearer path.** They
share identity, accounts and every authorisation check; they differ only in how
a request proves who it is.

`api-client` selects transport at runtime — cookie on the web, bearer in the
app — so no caller has to know which surface it is on, and no surface is
tempted to reimplement the other's rules.

### Why not extend the cookie session

Three reasons, in order of weight:

1. A cookie from a non-HTTPS custom-scheme origin cannot carry the protections
   the web session relies on, so it would be a weaker session wearing the same
   name.
2. CSRF reasoning differs between the two: cookies are sent ambiently and need
   the protection, bearer tokens are not and do not. One mechanism serving both
   would have to satisfy the stricter rule everywhere, or quietly satisfy
   neither.
3. Revocation. A stolen mobile token has to be killable per device without
   ending every web session on the account. That needs device identity, which
   the cookie session does not carry.

## Token lifecycle

- **Access token**: short-lived, sent as `Authorization: Bearer`, never
  persisted anywhere but memory.
- **Refresh token**: rotating. Each refresh mints a new one and retires its
  predecessor; the family is tracked so a replayed predecessor is detectable.
- **Reuse detection**: presenting a retired refresh token invalidates the whole
  family, not just that token. A replay means a copy exists somewhere, and the
  safe reading is that the legitimate holder is one of two parties, not that
  the request is merely stale.
- **Device sessions**: each family is bound to a device record, listable and
  individually revocable, so losing a phone does not mean ending every session
  on the account.
- **Storage**: refresh tokens live in Keychain or Keystore. Never
  `localStorage`, which any injected script in the WebView can read.

`AUTH-03` grades rotation, reuse detection, logout and device revoke together,
because each is only meaningful with the others.

## Sign-in paths

Three, all reaching the same accounts as the web:

**System-browser OAuth with PKCE.** Google's guidance for installed apps is a
system browser with a local redirect, and an embedded WebView is both against
that guidance and unable to reuse an existing browser session. Return happens
through a claimed HTTPS universal link or app link, never a custom scheme alone
— a custom scheme can be registered by any app on the device, so the callback
would be interceptable.

**Sign in with Apple**, or the equivalent App Review 4.8 requires. Private relay
addresses are handled as first-class identities. An Apple identity is never
merged into an existing account on matching email alone, because a relay
address is not proof of control of the mailbox behind it. `AUTH-01` requires
deletion to revoke the Apple token, not just to forget it.

**Email OTP and magic link**, reusing the existing policy rather than adding a
password. `lib/emailLogin.ts` already enforces a bounded code TTL, an attempt
threshold with lockout, and Turnstile above the threshold; the mobile path
exchanges a verified code for a token family instead of setting a cookie. No
password is introduced anywhere.

### Store review is the exception, and is bounded

Reviewers cannot read the dedicated account's mailbox, so a submission-scoped
fixed verification code exists — an explicitly isolated static credential,
bound to one account, one submission and one build, hash-stored, rate-limited
and revoked on a terminal submission state. `docs/ops/tomverse-chat-store-review.md`
holds the lifecycle. `AUTH-02` grades that ordinary accounts can never enter
that branch, which is what keeps a review affordance from becoming a password
feature.

## Attack surface this introduces

Two things a cookie-only product did not have, both graded by `AUTH-04`:

**CORS.** The app's origin must be allowlisted explicitly and narrowly. A
hostile page reaching a bearer endpoint with a permissive policy is the
straightforward way to lose this, so hostile-origin tests are part of the gate
rather than a follow-up.

**Deep-link hijacking.** The OAuth return is the moment a code is in flight, and
another app claiming the same link would receive it. Claimed HTTPS links, PKCE,
and single-use codes each remove part of the attack; the tests run on physical
devices, because the claiming behaviour they exercise is a device-level
registration and a simulator does not reproduce it.

## Deliberately excluded

- **No password authentication**, on any surface. Adding one to serve the app
  would add credential stuffing, reset flows and breach exposure to a product
  that has none of them today.
- **No remote `server.url`.** The app ships a local bundle; a production app
  pointing at a hosted URL is both a store-review risk and an origin the token
  policy above cannot reason about.
- **No token in `localStorage`**, and no long-lived access token as a
  substitute for refresh rotation.
- **No shared secret between app and server** beyond the standard OAuth and
  token exchange; a secret shipped in an app binary is a published secret.

## What has to exist before the gates can pass

- `AUTH-01`: Apple sign-in with link, unlink, delete and token revoke, on a
  physical device.
- `AUTH-02`: the email OTP and magic-link path through the bearer exchange, with
  abuse, expiry, lockout and review-code isolation.
- `AUTH-03`: rotation, reuse detection, logout and device revoke.
- `AUTH-04`: hostile-origin CORS and deep-link hijacking, on physical devices.
- `PRIVACY-01`: in-app account deletion, including revoking every device family.

None of these is separable. A rotation scheme without reuse detection, or a
device list without revoke, is a mechanism that describes a guarantee it does
not provide.
