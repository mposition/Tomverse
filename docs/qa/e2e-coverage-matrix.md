# E2E coverage matrix

What the Playwright suites actually protect, per product area, and what they
deliberately do not.

Two suites, two configurations, because they need opposite environments:

| Suite | Config | Server | Session | Data |
|---|---|---|---|---|
| User platform | `playwright.config.ts` | `next start` on `127.0.0.1:3100` | `E2E_AUTH_BYPASS` + the `__tomverse_e2e_auth` cookie, plus `page.route()` API mocks | none — `E2E_DISABLE_DATABASE=true` |
| Admin Console | `playwright.admin.config.ts` | `next start` on `127.0.0.1:3102`, behind TLS on `https://127.0.0.1:3101` | a genuine NextAuth JWT in the production `__Secure-next-auth.session-token` cookie | an isolated PostgreSQL database, truncated and re-seeded before every test |

The admin suite's https origin is load-bearing, not decoration. `lib/auth.ts`
names the session cookie from `NODE_ENV`, so the production server this suite
runs reads `__Secure-next-auth.session-token` — and Chromium's CDP
`Storage.setCookies` refuses to write a `__Secure-` cookie from a non-https
source URL, while Playwright's `APIRequestContext` will not attach a `Secure`
cookie to an http request. On plain http the suite could neither create the
session nor send it to `/api/admin/**`, which is what left every signed-in spec
staring at the sign-in page. `scripts/admin-e2e-tls-terminator.mjs` terminates
TLS with a throwaway certificate generated per run; the production cookie
policy is untouched.

Run them with `npm run test:e2e:pr` / `npm run test:e2e:chromium` and
`npm run test:e2e:admin`.

In CI the user suite's `@smoke` and `@ui-risk` tiers run inside PR Fast Gate,
and the admin suite runs as its own workflow, `Admin Console E2E`
(`.github/workflows/admin-console-e2e.yml`), against a PostgreSQL service
container. It runs on **every** pull request: a path filter would be a guess
about which files can break the admin console, and that guess is exactly what
failed when #193's toast rewrite broke four specs with every check green. The
job is measured at ~5 minutes against ~11 for the Chromium build job it runs
beside, so it costs no wall-clock time.

`Admin Console E2E (PostgreSQL)` is a **required** check on `develop` and
`main`. A red admin suite blocks the merge. It is required through branch
protection rather than through the `fast-gate` aggregation in
`pr-fast-gate.yml`, whose check name is load-bearing and whose member jobs are
deliberately not required individually.

Requiring it depends on the workflow having no `paths` filter. A workflow
skipped by a path filter creates no check run at all, and a required check
that never reports leaves a pull request pending forever — so if the filter is
ever reintroduced, the check has to come out of branch protection in the same
change, or every pull request that misses the filter becomes unmergeable.

---

## 1. The Admin Console harness

### Why it exists

The user-platform bypass does not reach the admin console. `AdminLayout`,
its per-route pages and all 41 `/api/admin/**` route handlers call
`getServerSession(authOptions)` themselves and then query Prisma directly, so
neither the `__tomverse_e2e_auth` cookie (which only fabricates a session for
the React tree in `app/(site)/(application)/layout.tsx`) nor a browser-side
`page.route()` interception of `/api/auth/session` changes what the server
sees. Before this work the console was unreachable under `next start` with the
E2E flags, and the only admin E2E in the tree
(`tests/e2e/admin-user-security-controls.spec.ts`) had to mount two components
on a synthetic `/e2e/admin-security-controls` page instead of driving the real
route.

### How it works

Nothing in the application is stubbed, short-circuited or replaced.

- **Authentication is real.** `tests/e2e-admin/support/session.ts` mints a
  NextAuth JWT with `next-auth/jwt`'s `encode()` and the server's own
  `NEXTAUTH_SECRET`, and sets it as the ordinary `next-auth.session-token`
  cookie. The unmodified `authOptions` decodes it, so server components,
  client fetches and `page.request` calls all observe one identity. Minting a
  token is exactly equivalent to knowing the deployment secret and grants
  nothing beyond it.
- **Authorization is real.** The identities become administrators only because
  `ADMIN_EMAILS` / `ADMIN_<ROLE>_EMAILS` list them — the same mechanism a
  deployment uses. `owner`, `billing`, `support`, `ops` and `readonly` are
  five separate fixture identities, plus a second `owner` (`approver`) so
  two-person approval can be completed, plus a signed-in non-administrator
  (`member`).
- **Data is real.** `tests/e2e-admin/support/database.ts` truncates every
  table and re-seeds a fixed dataset before each test, so specs are
  order-independent. The connection string must carry a `test`/`ci`/`e2e`
  marker and must differ from `DATABASE_URL`, or the run refuses to start.
- **Session ages are real.** `authenticatedMinutesAgo` moves the JWT's
  `authenticatedAt` claim, which is what `resolveAdminSessionAccessState()`
  and `assertRecentAdminAuthentication()` read — so the not-authorized,
  reauthentication-required and step-up-expired states are produced by the
  product's own rules.

### Why it cannot be enabled in production

The harness adds **no runtime bypass at all**, so there is no flag to leak.
`tests/adminE2eHarness.test.ts` (in `npm run test:unit`) proves it:

| Claim | Assertion |
|---|---|
| The harness server environment enables no Playwright short-circuit | `adminE2eServerEnv()` sets no `E2E_*`, `*BYPASS*`, `*DISABLE_DATABASE*` or `*SKIP_AUTH*` key |
| The identities are not privileged by construction | with no `ADMIN_EMAILS`, `resolveAdminSessionAccessState()` returns `not-authorized` for every one of them |
| Their authority comes only from ordinary configuration | with the harness env, each resolves to exactly the role it declares, via the real `resolveConfiguredAdminRole()` |
| Their session still expires normally | a 9-hour-old harness session is `reauthentication-required` under the real rule |
| No code path can special-case them | no file under `app/`, `components/`, `lib/`, `scripts/`, `prisma/`, `types/` mentions the harness domain, its secret, or a harness user id |
| A leaked identity is inert | the identity domain is under RFC 2606 `.invalid` and can never receive mail |
| The fixture database is fail-closed | an unset, non-PostgreSQL, unmarked, or application-shared URL is refused before anything is truncated |
| The *pre-existing* short-circuits stay loopback-only | with both flags set and a public `NEXTAUTH_URL`, `isE2EFixtureMode()` is still false |

Two supporting facts: `/api/ready` already reports not-ready when
`E2E_AUTH_BYPASS`/`E2E_DISABLE_DATABASE` are set with `NODE_ENV=production`
(`lib/securityEnvironment.ts`), and the harness never sets them anyway.

### External services

`tests/e2e/block-external-network.cjs` is loaded into the harness server, so
every outbound socket, HTTP(S) request, HTTP/2 session and `fetch` to a
non-loopback host throws. Stripe, Resend, Slack, R2, Railway and the AI
providers are additionally unconfigured, so the code takes its documented
"not configured" paths rather than attempting a call.

---

## 2. Admin Console coverage

Role column = the fixture identity the test signs in as. All rows run on the
`admin-desktop` project (1440x900) unless noted.

### 2.1 Access control — `admin-access-control.spec.ts`

| Journey | Risk | Role | Success state | Failure state |
|---|---|---|---|---|
| Signed-out visitor opens `/admin/overview` | High | none | — | redirect to `/auth/signin?callbackUrl=/admin/overview` |
| Signed-in non-administrator opens the console | High | `member` | — | HTTP 404 + the generic not-found page; no console chrome, no navigation landmark |
| Non-administrator calls `/api/admin/users` | High | `member` | — | 404 `Not found.`, never 403 (existence is not disclosed) |
| Stale admin session (9h) opens `/admin/refunds` | High | `owner` | after re-signing in, `/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Frefunds` forwards back to `/admin/refunds` | reauthentication card, with the account named |
| `readonly` browses a write-restricted workspace | Med | `readonly` | read UI renders; "Read-only for readonly", "Role: readonly", per-entry `Read` markers | — |
| `readonly` mutates via the API directly | High | `readonly` | reads still 200 | 403 on feedback, plan-adjust and incident writes |
| Role-scoped write permissions | High | `support`, `billing`, `ops` | support→feedback 200, ops→incident 2xx | support→plan-adjust 403, billing→feedback 403, billing→incident 403 |

> All admin API calls in the suite send an `Origin` header via `adminApi()`.
> Without it `lib/requestOrigin.ts` rejects the mutation before any permission
> check runs, and a 403 from the CSRF guard is indistinguishable from a 403
> from the role check — which would make these tests pass for the wrong reason.

### 2.2 Shell, routing and navigation — `admin-shell-navigation.spec.ts`

The console's information architecture is described in
`docs/ui-contracts/admin-console-ia.md`: six groups, seventeen entries, and a
redirect for every route the old twenty-four-entry sidebar had.

| Journey | Risk | Success state | Failure state |
|---|---|---|---|
| Sidebar lists exactly the 17 `ADMIN_NAVIGATION` entries, in their 6 groups | Med | every label maps to its declared href; each group is a real toggle button | — |
| Each of the 17 workspaces opens (17 parameterised tests) | Med | correct `<h1>`, exactly one active nav item | — |
| `/admin/search`, which has no nav entry | Med | headed **"Global search"**; no nav entry claims to be current | previously headed "Overview" — finding 2, now fixed |
| All 8 retired routes still resolve (8 parameterised tests) | High | each lands on its declared `?tab=`, with that tab marked `aria-current` | — |
| A retired route's own query survives the redirect | High | `/admin/feedback?status=resolved` → `/admin/support?tab=feedback&status=resolved`, opened on that filter | — |
| Unknown section `/admin/not-a-real-section` | Med | — | **HTTP 404**, root not-found UI, no console chrome |
| Legacy `/admin`, `/admin?tab=refunds`, `/admin?tab=feedback` | Low | forward to `/admin/overview`, `/admin/refunds`, `/admin/support?tab=feedback` | — |
| Breadcrumb on `/admin/users/:id` | Low | `Admin Console / Users / Customer detail`, parent nav still active | — |
| Header identity and role badge | Low | name, role chip, `Role: owner`, no read-only chip for owner | — |
| Group collapse by pointer **and** by keyboard | Med | `aria-expanded` tracks state; the group's entries leave and re-enter the DOM | — |
| The current route's group opens even when collapsed | Med | navigating into a collapsed group expands it without rewriting the stored preference | — |
| Current entry in view at **1280x720** without scrolling | High | the active entry's own centre point resolves to itself via `elementFromPoint` | — |
| Action counts on the entries that need them | Med | `Refunds, N awaiting action` in the entry's accessible name; reference pages carry none | — |
| Pin / unpin a page | Med | the pin appears in the sidebar's Quick access **and** in the palette's Pinned section, and unpinning sticks | — |
| Empty palette reaches every page, grouped | High | all 17 entries under their own group heading, plus Global search | previously `ALL_ITEMS.slice(0, 9)` — 8 pages unreachable |
| Palette separates Pages from Records | Med | both section headings render; "no record matched" is scoped to Records and says page results are unaffected | previously a bare "No matching records." under the page hits |
| Palette keyboard: ↑ ↓ Enter Escape | Med | exactly one `aria-selected` option, Enter opens it | — |
| Palette → global search | Med | "View all results" opens `/admin/search?q=…` | — |
| Notification centre | Med | `aria-expanded` toggles, seeded failed delivery listed, "View all" → `/admin/alerts?tab=deliveries` | — |
| Manual refresh and the auto-refresh toggle | Med | `aria-pressed` reflects state; the label reads **"Auto 3m"**, derived from the same 180000ms constant as the timer | previously labelled "Auto 60s" |

### 2.3 Narrow viewport — `admin-shell-responsive.spec.ts` (`admin-mobile`, Pixel 5)

| Journey | Risk | Success state |
|---|---|---|
| Drawer stays closed until asked for | Med | navigation landmark hidden; open button visible |
| All 17 workspaces reachable in the drawer, at **390px and 320px** | High | each link's **centre point** resolves to itself via `elementFromPoint` — attachment alone is not accepted |
| Each entry explains itself in visible text | Med | the drawer carries no `title`; the description renders as text, because a hover hint is unreachable on touch |
| The drawer opens on the current entry | High | the active entry's centre point resolves to itself without scrolling first |
| Groups collapse in the drawer and report their state | Med | all six start expanded; `aria-expanded` tracks the toggle |
| Choosing a workspace navigates and closes the drawer | Med | URL, heading, drawer closed |
| `Escape` and the backdrop both close it | Med | drawer closed, page intact |
| Header controls and horizontal overflow at 412px, **390px and 320px** | High | search, notifications and menu visible; `scrollWidth <= clientWidth + 1` |
| A consolidated page's tab strip at 320px | High | the active tab is `aria-current`, another tab navigates, and nothing overflows sideways |
| Command palette without a hardware keyboard | Med | opens by tap, closes by its own button |

### 2.4 Read surfaces — `admin-read-surfaces.spec.ts` (one test per surface, tabs included)

Every area asserts a heading **plus** a seeded record, an empty state, or a
status badge — never a bare HTTP 200, which would pass with an empty panel or
a swallowed fetch error. Client-rendered panels (jobs, alerts, webhooks,
retention, models, privacy requests, approvals, infrastructure) are exercised
in a browser precisely because their data arrives after mount.

Several rows also assert an **absence**, which is how the de-duplication is
held in place: a panel that comes back in a second location fails the spec.

| Surface | What is asserted |
|---|---|
| `overview` | operations snapshot, launch-readiness and revenue sections; `2 feedback / 1 refund` counter; seeded audit summary; each of those sections exactly **once** |
| `overview` quick access | "Quick access" panel present; no "Set default" control |
| `work-queue` | ranked queue; the pending refund links to `/admin/refunds` and the open feedback to `/admin/support?tab=feedback`; resolved feedback absent; **no** stacked jobs/refund management panels |
| `work-queue?tab=approvals` | approval queue and its empty state |
| `providers?tab=incidents` | open and resolved incidents; exactly one `Resolve`; readiness tests; incident mode |
| `analytics` | three funnel sections, the seeded campaign and event, plus the account-level launch funnel that moved here from promotions |
| `analytics?tab=imports` | `AdminMemoryImportPanel`, the only reader of `/api/admin/memory` and `/api/admin/external-imports`, on its own tab rather than stacked under the funnel |
| `users` | seeded names, per-row detail link, `AI access held`, `Debt 640 credits` |
| `users/:id` | plan, Stripe ids, credit purchases, recent conversations |
| `support?tab=feedback` | open + resolved entries, the status filter, and the stated row limit |
| `support?tab=privacy` | data-rights queue with its seeded request |
| `billing` | lifecycle split and the Free/Pro/Max catalogue |
| `billing?tab=promotions` | promotion code, risk monitor with abuse signals; **no** role matrix (that lives only on admin access) |
| `refunds` | Pending/Approved/Rejected/All counters, credit-review notice, reviewed request under "All" |
| `credit-ledger` | `purchase_grant` and `settlement` rows with the owning customer, plus the stated row limit |
| `providers` | health, usage-sync and model-metric panels; **no** second copy of the model registry |
| `models` | seeded enabled and disabled models, per-row Edit control |
| `providers?tab=usage-cost` | usage sync, latency watch and model metrics |
| `infrastructure` | operations panel |
| `automation?tab=jobs` | the two seeded runs joined onto their job cards |
| `automation?tab=webhooks` | failed Stripe event id and its Reprocess control |
| `automation?tab=reports` | the operations report, which previously had no navigation entry of its own |
| `alerts` (3 tabs) | policy by field value; templates; delivery log with the `failed 1` filter |
| `platform` | product defaults, feature controls, save control |
| `audit` | seeded entry, its actor, and the stated row limit |
| `retention` | cleanup controls, `Execute cleanup` disabled by default |
| `admin-access` (3 tabs) | all five configured administrators; audit integrity; operational readiness |
| `search` | headed "Global search"; finds a seeded customer end to end |

### 2.5 Recovery eligibility — `admin-recovery-eligibility.spec.ts`

The console's account-recovery action is "Cancel deletion & restore account".
Its eligibility is decided in three places —
`AdminUserSecurityControls` (is it rendered at all),
`validateAdminSecurityAction()` (may it be submitted), and the route handler's
`hasAdminPermission()` (is it allowed) — each of which has unit coverage. What
unit tests cannot show is whether the decision reaches the screen, and that is
what these seven browser tests assert on the real `/admin/users/:id` route.

| Case | Role | Expected |
|---|---|---|
| Eligible (`pending_deletion`) | `owner` | control visible and enabled; request payload carries the reason, the ticket and `until: null`; success message; account becomes `active`; control disappears; database agrees |
| Ineligible (`active`) | `owner` | no restore group, no deletion notice; suspend control still present |
| Ineligible (`suspended`) | `owner` | no restore group; the suspend control reads "Unsuspend account"; suspension reason shown |
| Missing audit reason | `owner` | inline error on the reason field, focus moved there, **zero** requests sent |
| Missing support ticket | `owner` | inline error on the ticket field, focus moved there, **zero** requests sent |
| Insufficient role | `billing` | server refuses; error surfaced in the panel; account unchanged in the database |
| Stale sign-in (45 min) | `owner` | 428 surfaced as the re-authentication message, with a link back to the same customer |
| Eligibility lost mid-session | `owner` | second attempt reports "already active, so no change was made"; the stale control re-renders as ineligible |

### 2.6 Mutation journeys

| Category | Spec | Role | Success | Failure |
|---|---|---|---|---|
| User search → detail → support note | `admin-support-journeys.spec.ts` | `support` | search narrows to one row; note saved, rendered and attributed in the database | empty note keeps the save disabled |
| Feedback status change | `admin-support-journeys.spec.ts` | `support` | status changes, survives reload, `feedback.status.updated` audit row | current status is not re-selectable |
| Privacy request progression | `admin-support-journeys.spec.ts` | `support` | status, note and handler stored | — |
| Refund approval | `admin-billing-journeys.spec.ts` | `billing` | acknowledged approval moves the counters, adds the timeline entry, records the reviewer | approval without the credit acknowledgement is 400 and the request stays pending |
| Refund rejection | `admin-billing-journeys.spec.ts` | `billing` | rejected with the operator note | — |
| Double review | `admin-billing-journeys.spec.ts` | `billing` | — | 409 `already been reviewed`, status unchanged |
| Promotion catalogue save | `admin-billing-journeys.spec.ts` | `billing` | two-step publish confirmation, saved, survives reload | a promotion with no discount is refused and nothing is written |
| Provider incident open / resolve | `admin-platform-operations.spec.ts` | `ops` | incident stored with its author; resolving removes the action and records the resolver | a title-less incident cannot be submitted |
| Model registry status change | `admin-platform-operations.spec.ts` | `ops` | status persisted, attributed, re-rendered after reload | restricting the **guest default** model is refused with the cross-surface reason; dialog stays open; nothing written |
| Platform setting | `admin-platform-operations.spec.ts` | `ops` | guest default saved and read back | — |
| Alert acknowledgement | `admin-platform-operations.spec.ts` | `ops` | acknowledged, attributed, control removed | — |
| Webhook replay | `admin-platform-operations.spec.ts` | `ops`, `billing` | — | `ops` 403 (replay is `billing:write`); the console reports the failure instead of a false success, and the record is not marked replayed |
| Destructive retention cleanup | `admin-platform-operations.spec.ts` | `ops` | dry run recorded | `Execute cleanup` stays disabled until the exact `RUN CLEANUP` phrase is typed |
| Two-person approval | `admin-approval-workflow.spec.ts` | `billing` + `approver` | request queued (customer unchanged) → self-approval refused → second owner approves (still unchanged) → identical re-send executes → plan changed, approval `consumed`, `user.plan_adjusted` and `admin_approval.*` audit rows, change visible in the audit workspace | rejected approval leaves the customer untouched |
| Plan-adjust confirmation gate | `admin-approval-workflow.spec.ts` | `billing` | enabled only with a reason **and** the exact `ADJUST PLAN` phrase | nothing is sent while disabled |
| KPI counters after a write | `admin-billing-journeys.spec.ts` | `billing` | approving a refund moves the customer to Free **and** `/admin/users` renders the new "Free access" figure on the next server render | `/admin/users` is visited before the write, so a re-introduced cache would hold the pre-write figures; a reload still showing them is the failure |

### 2.7 Step-up recovery — `admin-step-up-recovery.spec.ts`

A 428 is not the bug; having no way past it was. A session inside the 8-hour
console window but past the 30-minute step-up window renders the console
normally and is refused every high-risk write, so this suite follows the whole
way out rather than asserting the status code alone.

| Case | Role | Expected |
|---|---|---|
| Refused platform save, end to end | `ops` (45 min) | save refused; "Nothing was saved" alert persists and Save is disabled; nothing written; CTA opens the card (not a redirect back); a reload still shows the card; sign-out clears the session cookie and lands on sign-in with `reason=admin-step-up-expired`; after a fresh sign-in the same edit is made again by hand, saves, and is read back from the database |
| Console reads on a stale step-up window | `ops` (45 min) | `/admin/platform` renders stored values and Save is enabled — the step-up window is not console access |
| Reauthentication page for a non-administrator | `member` | 404, so it is not an oracle for `/admin` |
| Reauthentication page on a recent sign-in | `ops` | redirected to the callback |
| Sign-out from the console | `ops` | account menu and `Sign out` reachable at 1440px and 390px; Escape closes the menu |

---

## 3. User platform coverage

Existing specs, by product area. Only two rows are new; everything else was
already covered and no duplicate was added.

| Area | Specs | Notes |
|---|---|---|
| Localized marketing, landing, status | `landing-content-contract`, `marketing-consent-hero`, `marketing-language-analytics`, `marketing-language-focus`, `marketing-status-navigation`, `status-page`, `smoke` | |
| Sign-in and language | `signin-localization`, `signin-hydration`, `signin-analytics-placement`, `language-detection`, `ssr-root-language` | |
| Analytics consent | `analytics-consent`, `analytics-consent-signin`, `analytics-settings-target`, `analytics-campaign-funnel`, `chat-analytics-settings-placement` | |
| Guest chat | `guest-flow`, `guest-initial-cost-hydration`, `guest-turnstile-verification`, `guest-attachment-ai-review-flow` | |
| Authenticated chat | `desktop-flow`, `mobile-flow`, `chat-tools`, `chat-send-history-race`, `chat-markdown-theme`, `chat-keyboard-policy` | |
| Model selection and availability | `model-picker`, `model-picker-limit-state`, `model-picker-responsive`, `model-finder`, `model-only-input`, `chat-model-selection-readiness`, `model-panel-tablet-reachability`, `provider-status` | |
| Conversation lifecycle | `conversation-title`, `conversation-draft-isolation`, `mobile-recent-conversations`, `tab-resume`, `account-flow` (share, lock, delete) | |
| **Conversation export** | **`conversation-export` (new)** | Download (.txt) and its `allowDownloads` entitlement had no behavioural coverage |
| Attachments | `attachment-flow`, `guest-attachment-ai-review-flow` | |
| Web Search | `native-web-search`, `web-search-composer-state`, `source-grounding` | |
| Deep Research | `deep-research-message-contract` | |
| Comparison and AI Review | `comparison-review`, `comparison-action-rail`, `model-comparison-layout` | |
| Streaming and scroll | `chat-streaming-scroll` | |
| **Partial failure and retry** | **`chat-failure-recovery` (new)** | Retry was only captured as a screenshot; nothing clicked it |
| Provider outage recovery | `provider-status` | banner, per-model recovery offers, replacement selection |
| Credits, pricing, upgrade, billing | `credit-entitlement-disclosure`, `pricing-accessible-price`, `pricing-promotion-reflow`, `upgrade-discovery`, `account-flow` | |
| Account settings | `account-flow` | theme, settings, billing return language |
| Mobile / 320px / zoom / text scaling | `mobile-composer-contract`, `mobile-composer-banner-reflow`, `mobile-header-spacing`, `mobile-header-model-summary`, `mobile-message-visibility`, `mobile-short-viewport-drawer`, `ui-zoom-reflow`, `root-font-resize-text`, `sidebar-compact` | |
| Keyboard, touch, accessibility | `accessibility-core-tasks`, `remediation-accessibility`, `touch-targets`, `chat-keyboard-policy`, `ui-state-contrast` | |
| Typography and UI contracts | `font-system`, `korean-typography`, `ui-contracts`, `chat-state-visual-regression` | |
| Build and release | `build-info`, `go-live-regressions`, `fixtures` | |

### New user-platform specs

**`chat-failure-recovery.spec.ts`** — one model fails while the other two
answer; the failed panel offers exactly one Retry; clicking it re-requests
**only** that model (the healthy panels are scripted with a distinct second
answer that must never appear) and appends the recovered answer while the
failed turn stays in the transcript as history; a zero-byte 200 is reported as
a failure rather than a blank answer; the retry is reachable by its own centre
point on a 390px viewport and recovers there too.

**`conversation-export.spec.ts`** — an entitled account downloads the
conversation (request issued, `Content-Disposition` filename honoured, menu
closes); a plan without `allowDownloads` disables the control, explains why,
and sends nothing.

---

## 4. Exclusions, with reasons

| Not covered | Why | What it would take |
|---|---|---|
| A **successful** Stripe webhook replay | `/api/admin/webhooks/:id/reprocess` re-fetches the event from Stripe. The harness has no `STRIPE_SECRET_KEY` and the network guard blocks the call, so only the permission boundary and the failure UI are assertable. | A Stripe fixture boundary (a recorded-events double behind `getStripe()`). None exists today. |
| A **successful** Stripe refund with a live charge, *in this suite* | Same boundary. The refund route's no-Stripe path is exercised here instead, which is the path the harness can reach deterministically. | Nothing further: the money path is covered a tier down, see below. |
| Provider health probes, Railway/Prisma usage sync, Slack/Discord/Resend delivery | All are outbound calls the network guard blocks by design. The panels' rendering and their failure handling are covered; the calls themselves are not. | Per-service fixture boundaries. |
| Admin console visual regression goldens | The visual baseline policy (`docs/qa/canonical-visual-baseline.md`) pins one canonical environment; adding a second suite of goldens is a separate decision. | A design decision plus canonical-runner capacity. |
| `/e2e/admin-security-controls` harness page | Kept as-is. `tests/e2e/admin-user-security-controls.spec.ts` still guards the component's toast/error/expiry behaviour in isolation; the new suite covers the same controls on the real route. Removing it is a separate cleanup. | — |

### The refund money path, covered a tier down

The row above used to say a Stripe fixture boundary was what it would take.
That was the wrong shape of answer, and finding out why is the useful part:
`tests/integration/refund-decision-route.db.test.ts` already replaces
`lib/stripe.ts` with a module double, so no new boundary was needed — but its
double answered `latest_invoice: null`, which sent **every** test in the file
down the `no_payment_intent` branch. The amount arithmetic underneath had
therefore never run at any tier.

It runs now, and four cases are pinned there because each is wrong in a
direction a green suite would not show: the outstanding amount is refunded
(with `refund.execution_started` written *before* the provider call), a partly
refunded charge gets only its remainder, a fully refunded charge creates
nothing, and a refund already at the provider carrying this request's metadata
is adopted rather than issued a second time.

What stays out of reach here is the browser half — an operator clicking
approve and reading the result — which is what the exclusion row is now scoped
to. The `/api/admin/webhooks/:id/reprocess` row is unchanged: its Stripe call
has no equivalent double yet.

## 5. Running the user suite outside the canonical environment

A sandbox or developer machine will not produce a clean `npm run test:e2e:pr`,
for two reasons that are both about the environment rather than the product.
Both were measured rather than assumed, so the distinction is checkable:

**Concurrency.** The config uses `workers: 4, retries: 0` locally and
`workers: 1, retries: 2` under `CI`. On a constrained machine the parallel run
produces scattered failures across unrelated specs. Re-running the exact
failing test locations with `CI=1` — same commit, same build, same browser,
only the concurrency changed — turned 27 failing locations into **45 passed,
0 failed**. Reproduce with:

```
CI=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE=<chromium> \
  npx playwright test --project=desktop-chromium <file>:<line> ...
```

**Screenshot goldens.** `chat-state-visual-regression.spec.ts` compares against
committed PNGs, and `docs/qa/canonical-visual-baseline.md` states that a run
using `PLAYWRIGHT_CHROMIUM_EXECUTABLE` is not canonical and its screenshots
must not be judged against them. On such a runner the spec fails
deterministically (identically across all three `CI=1` retries) with pixel
diffs of 0.01–0.03 of the image, concentrated in glyph edges — the signature
the baseline document describes for a Chromium version mismatch. These
failures are not a signal about a change: verified by running the same
locations on the commit *before* this suite was added, which produced the
**same 20 failing screenshots and the same leading diff of 11966 pixels**,
against a spec file and golden set that are byte-identical between the two
commits.

Judge goldens only on the canonical runner described in
`docs/qa/canonical-visual-baseline.md`.

## 6. Known findings

1. ~~**An unknown admin section answers HTTP 200, not 404.**~~ **Fixed.** The
   cause was the `[section]` catch-all: `admin/loading.tsx` opens a Suspense
   boundary, so the status was already committed by the time the segment called
   `notFound()`. Every workspace now has its own route segment and there is no
   catch-all left to match, so the router answers a real 404 before anything
   streams. `admin-shell-navigation.spec.ts` asserts the status directly.
   (`/admin/**` is still `noindex` from the layout's own metadata.)
2. ~~**`/admin/search` is titled "Overview".**~~ **Fixed.** It had no navigation
   entry, and `titleFromPath()` fell through to the first item.
   `resolveAdminPageMeta()` in `lib/adminNavigation.ts` now lists it under
   `ADMIN_UNLISTED_PAGES` — it is headed "Global search" — and any route the
   table does not describe resolves to a neutral "Admin Console" heading rather
   than borrowing the first entry's title.
3. **The model registry bootstrap is once-per-process.**
   `ensureModelRegistrySeeded()` memoises its promise, so it can never refill
   `ModelRegistryEntry` after the table is emptied. The fixture seeder
   therefore writes the static catalogue itself, from
   `staticModelRegistrySeedRows()` in `lib/modelRegistryShared.ts` — extracted
   there so the runtime bootstrap and the fixture share one definition.
