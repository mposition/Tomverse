# The admin console fixture route

`app/(site)/(application)/e2e/admin-console-fixture/page.tsx` is a
Playwright-only mount of the admin console shell and the admin panels that
carry browser-level contracts. This document records why it exists, what it is
not allowed to do, and what it would cost to remove it.

## Decision: keep it

The real admin console cannot be reached by the E2E suite. `/admin/**` requires
an authorised administrator session (`getAdminSessionAccessState`, which needs
a matching `ADMIN_EMAILS`/`ADMIN_USER_IDS` entry *and* a recent `authenticatedAt`
claim) and its pages query Prisma directly. The Playwright server runs
`next start` with `E2E_AUTH_BYPASS` and `E2E_DISABLE_DATABASE` and points
`DATABASE_URL` at an unreachable host, so it has neither. Reaching the console
would mean adding an administrator bypass to the admin layout, the admin pages
and the admin APIs — a far larger and genuinely dangerous change than a single
gated fixture page.

No repository policy forbids a test-only route. The nearest thing is a note in
`.github/audits/REMEDIATION_EXECUTION_RESULT_20260729T214124Z_KO.md` that an
ad-hoc *measurement* harness was kept out of the repository; that is about
throwaway scripts, not about test surface, and it is not a policy.

What the route buys, and what nothing else buys:

- **Toast rendering.** `dispatchAppToast()` only fires a window event. That the
  admin shell now renders it, exactly once per event, with the right live-region
  semantics, is a DOM fact.
- **Focus and hit testing.** Which field takes focus after a validation
  failure, and whether a toast covers a control, are measured with
  `elementFromPoint()` on a laid-out page.
- **Layout overflow.** The 9px overflow that `min-w-0` fixed was invisible to
  every non-browser check: it comes from `<input type="datetime-local">`'s
  intrinsic width against a grid item's default `min-width: auto`.

A source-string assertion can state that a class name is present. It cannot
state that the page does not scroll sideways at 320px.

## What the route is not allowed to do

- It renders **fixture props only**. It grants nothing.
- Every write still goes to the real `/api/admin/**` handlers, which keep their
  own session, permission, rate-limit, reauthentication and two-person approval
  checks. Specs control those responses with Playwright network interception —
  never by relaxing the server.
- It is not linked from any navigation, and `app/robots.ts` disallows `/e2e`.
- It must import `isE2EFixtureMode()` from `lib/e2eTestMode.ts` rather than read
  the flags itself. `tests/goLiveSecurityFixes.test.ts` fails the build if it
  stops doing so.

## Why the gate holds

`isE2EFixtureMode()` requires **both** flags **and** a loopback `NEXTAUTH_URL`.
`NODE_ENV` is deliberately not part of it: `next start` sets `NODE_ENV=production`
on the fixture server too, so a `NODE_ENV` check would be worthless here.

Two independent proofs:

| Proof | What it covers |
|---|---|
| `tests/e2eTestMode.test.mjs` | Executes the helper across the whole matrix: both flags absent, both false, each flag alone, both flags with a missing / blank / unparseable / public `NEXTAUTH_URL`, hostnames that merely *contain* a loopback name, and the four real loopback forms including IPv6 `[::1]`. Every case restores the environment, including keys that were absent. |
| `scripts/verify-fixture-route-gate.mjs` | Starts the **same production build** three times over real HTTP: public origin with no flags → 404, public origin with both flags set → 404, loopback origin with both flags → 200. |

The second is the one that matters for the claim "this is a 404 in production",
because it is the deployment, not the helper, that is being asserted. A stray
or leaked `E2E_AUTH_BYPASS` on a real deployment is covered by the middle probe.

`/api/ready` independently reports not-ready when either flag is set with
`NODE_ENV=production` (`lib/securityEnvironment.ts`), so a misconfigured deploy
also fails its health gate rather than serving traffic.

## Residual risk

- The route's chunk is in the production bundle even though the page 404s. It
  contains admin navigation labels and hrefs — not secrets, and already shipped
  to every administrator — but it is a larger client bundle than strictly
  necessary.
- The gate is one function. If `isE2EFixtureMode()` were ever loosened, this
  route loosens with it. That is why the helper has its own executed matrix and
  why the page is in the guarded-files list.
- The fixture data is static and can drift from the real `AdminUserDetail`
  shape. `toAdminSecurityUser()` is shared with `AdminUsersPanel`, so a field
  added to the detail API is wired in one place and typechecked in both.

## Alternatives considered

| Option | Cost |
|---|---|
| **Drop to unit coverage** | Loses toast rendering, live-region semantics, focus order, `elementFromPoint` occlusion checks and every overflow assertion. The 320px overflow this work found would not have been detectable. Cheapest to maintain, and the least honest. |
| **A separate component-test app** (Storybook, or a second Next app) | Keeps the production build clean, and is the right answer if test routes ever multiply. Costs a second build target, a second dependency set and a second CI job, for one page. Worth revisiting if a third fixture mount is ever needed. |
| **Make `/admin/**` reachable in fixture mode** | Requires an administrator bypass in the admin layout, the admin pages and the admin APIs. Strictly worse: it puts the bypass on the surface that actually guards customer data. |
| **Keep the gated fixture route** (chosen) | One page, one gate, two proofs, no change to any admin API. |

If a third fixture mount is ever proposed, take the component-test app instead
of adding another route.
