# Admin Console Information Architecture

## Status

- Contract type: Product invariant for the Admin Console shell and its routes
- Applies to: every `/admin/**` page, the sidebar, the command palette, and the
  per-page section tabs
- Severity when violated: release blocker for the redirect table; ordinary
  review for everything else
- Last reviewed: 2026-09-14

## Scope

| Area | File |
| --- | --- |
| Route table, groups, aliases, tabs, redirect map | `lib/adminNavigation.ts` |
| Icon per entry | `components/admin/adminNavigationIcons.ts` |
| Badge shape and per-entry derivation (client-safe) | `lib/adminNavigationBadges.ts` |
| Badge loader (server-only) | `lib/adminNavigationCounts.ts` |
| Shell, header, breadcrumb, auto-refresh | `components/admin/AdminConsoleShell.tsx` |
| Header account menu (`Return to Tomverse`, `Sign out`) | `components/admin/AdminAccountMenu.tsx` |
| Sidebar, collapsible groups, quick access | `components/admin/AdminSidebar.tsx` |
| Command palette | `components/admin/AdminCommandPalette.tsx` |
| Pinned pages and recents | `components/admin/AdminConsolePreferences.tsx` |
| Section tabs | `components/admin/AdminPageTabs.tsx` |
| Per-surface loaders | `lib/adminConsoleData.ts`, `lib/adminWorkQueue.ts`, `lib/adminEnvironmentChecks.ts` |
| Health score and its breakdown | `lib/adminHealthScore.ts`, `components/admin/AdminHealthScorePanel.tsx` |
| Overview figures, derived from reads that may have failed | `lib/adminOverviewFigures.ts` |
| Notification drawer state | `lib/adminAlertsDrawer.ts` |
| Request deadline for every panel | `lib/adminFetch.ts` |
| Whether a polling panel may issue a request | `lib/adminPollTick.ts` |
| Refusal copy, and the notice that renders it | `lib/adminApiOutcome.ts`, `components/admin/AdminApiFailureNotice.tsx` |
| Coverage | `tests/adminNavigation.test.mjs`, `tests/adminHealthScore.test.mjs`, `tests/adminEnvironmentChecks.test.mjs`, `tests/adminAlertsDrawer.test.mjs`, `tests/adminOverviewFigures.test.mjs`, `tests/adminFetchDeadline.test.mjs`, `tests/adminPollTick.test.mjs`, `tests/adminWriteRouteGuards.test.mjs`, `tests/adminReauthenticationCta.test.mjs`, `tests/e2e-admin/**` |

## The navigation

Six groups, seventeen entries. One page, one job.

| Group | Entry | Route | Sections (`?tab=`) |
| --- | --- | --- | --- |
| Command Center | Overview | `/admin/overview` | `summary`, `health` |
| Command Center | Work queue | `/admin/work-queue` | — |
| Command Center | Analytics | `/admin/analytics` | `usage` (`&period=`), `product`, `imports` |
| Customers | Users | `/admin/users` | — |
| Customers | Support | `/admin/support` | `feedback`, `privacy` |
| Revenue | Billing | `/admin/billing` | `plans`, `promotions` |
| Revenue | Refunds | `/admin/refunds` | — |
| Revenue | Credit ledger | `/admin/credit-ledger` | — |
| AI Platform | Providers | `/admin/providers` | `health`, `usage-cost`, `incidents` |
| AI Platform | Models | `/admin/models` | — |
| Operations | Infrastructure | `/admin/infrastructure` | — |
| Operations | Automation | `/admin/automation` | `jobs`, `webhooks`, `reports` |
| Operations | Alerts | `/admin/alerts` | `policy`, `templates`, `deliveries` |
| Operations | Platform settings | `/admin/platform` | — |
| Governance | Audit log | `/admin/audit` | — |
| Governance | Retention | `/admin/retention` | — |
| Governance | Admin access | `/admin/admin-access` | `administrators`, `readiness`, `integrity` |

Plus three routes with no sidebar entry: `/admin/search` ("Global search",
reachable from the header control, `Ctrl/Cmd+K` and the palette's "View all
results"), `/admin/users/[userId]` and `/admin/providers/[provider]`.

`/admin` itself is an entry point, not a workspace: it forwards to Overview.

## Old route → new route

Nothing was deleted. Every previously reachable URL still resolves, and it
resolves to the *section* it named rather than to the first tab of whichever
page absorbed it. `tests/adminNavigation.test.mjs` fails if a retired route
loses its redirect route or points at a tab that does not exist, and
`tests/e2e-admin/admin-shell-navigation.spec.ts` drives all eight in a browser.

| Old route | New destination | Why |
| --- | --- | --- |
| `/admin/feedback` | `/admin/support?tab=feedback` | Both rendered `FeedbackInboxPanel` from the same rows |
| `/admin/promotions` | `/admin/billing?tab=promotions` | Promotions are part of the billing catalogue |
| `/admin/incidents` | `/admin/providers?tab=incidents` | Rendered `AdminProviderOpsPanel`, identically to fallback policies |
| `/admin/fallback-policies` | `/admin/providers?tab=incidents` | Rendered the *same component with the same props* as incidents |
| `/admin/usage-cost` | `/admin/providers?tab=usage-cost` | Re-rendered the provider health panel and metrics table |
| `/admin/jobs` | `/admin/automation?tab=jobs` | Scheduled work supervised, not performed, by an operator |
| `/admin/webhooks` | `/admin/automation?tab=webhooks` | As above |
| `/admin/approvals` | `/admin/work-queue` | Two-person approval was retired; the address still opens the queue |

`/admin?tab=<value>` — the console's addressing scheme before every workspace
got its own route — is mapped by `ADMIN_LEGACY_TAB_ROUTES` and covers both the
surviving names and the merged ones.

A redirect carries the request's own query onto the destination
(`/admin/feedback?status=open` → `/admin/support?tab=feedback&status=open`) but
never its own `tab`, which the lookup has already consumed.

## Rules

1. **Every retired URL keeps a redirect.** Deleting a `/admin/*` route without
   leaving a redirect behind is a release blocker: bookmarks, runbooks and
   `href`s already written into audit summaries all point at them.
2. **A section lives in `?tab=`, not in component state.** Tabs are `<Link>`s,
   the page's server component reads `searchParams`, and only the open
   section's data is loaded.
3. **Adding an entry means adding it in three places at once**: the route table
   in `lib/adminNavigation.ts`, an icon in `adminNavigationIcons.ts`, and a real
   route segment. The unit test fails on any of the three being missing.
4. **A badge is for work, not for decoration.** Only entries an operator acts on
   carry one, and an unknown count renders nothing rather than zero.
5. **The layout loads counts; a page loads its own data.** Nothing that only one
   workspace displays may move into `admin/layout.tsx`.

   **And a page's reads are settled one at a time.** A workspace that runs
   several independent reads uses `Promise.allSettled`, degrades the sections
   that depended on a failed one, and leaves the rest usable. Overview ran
   thirteen reads inside a single `Promise.all`, so one rejection took the whole
   workspace to the error boundary -- including the provider health dashboard,
   which is the read most likely to reject during a provider incident and the
   reason an operator opened Overview in the first place. The layout has read
   its badge counts this way since the console was split up; the pages had not
   caught up.

   A failed read is reported, never absorbed: a `console.warn` carrying
   `{ event: "admin_overview_read_failed", read }` so the loss is visible in
   logs, and a banner naming the reads that did not come back so the operator
   knows which figures to distrust and which are still good.
6. **Bounded reads say they are bounded.** A panel showing the newest N rows
   states N on screen and does not present its own counters as totals.
7. **A step-up refusal must offer the way back.** When a control is refused
   because the administrator's sign-in is no longer recent enough, the screen
   renders a link to the step-up flow —
   `adminRecentAuthenticationHref(<this screen's path>)`, which carries a
   callback so the sign-in returns the operator to where they were and the
   console session survives. **A toast alone is a defect**: it names the
   remedy and gives no way to reach it, so the screen reads as broken rather
   than gated and the only exit anyone finds is guessing a URL.

   This has been got wrong three times, and the test written to stop it asked
   the question from the wrong end. It checked that a panel which *handles* a
   refusal renders the link -- so a panel that never looked at the status
   passed for free, carrying none of the markers the sweep searched for. Four
   panels calling routes that answer 428 were in exactly that state on
   2026-09-14, invisible to the test written to prevent it, which is worse than
   having no test.

   `tests/adminReauthenticationCta.test.mjs` now asks from the server end.
   Which routes can answer 409 or 428 is a fact about the route files --
   `adminApprovalErrorResponse` is the only thing that produces either -- and
   which panels reach them is a fact about the paths they name. Every panel in
   that intersection must read the answer (`readAdminApiFailure`) and must
   offer the way back, directly or through `<AdminApiFailureNotice>`.

   A refusal may be announced twice: a toast that fades and a notice that does
   not. That is deliberate and is what `PlatformSettingsPanel` already did for
   its step-up alert -- the toast announces, the notice is the recovery. A test
   asserting the copy scopes itself to the notice.

8. **The console states only what it read.** Three separate surfaces broke
   this and each one sent an operator somewhere wrong, so it is a rule rather
   than three fixes.

   - **A failed read is never an empty result.** A list whose fetch returned
     403, 500 or nothing at all renders as unread, with the reason and a way
     to try again — never as the empty state. The alerts drawer said "No
     notification records." on the strength of a 500, on the surface an
     operator opens first during an incident. The branch order that prevents
     it lives in `lib/adminAlertsDrawer.ts` because an ordering is only
     testable if something can call it. This is the same rule
     `lib/adminNavigationCounts.ts` states for badges — *zero is a claim and an
     unknown count is not* — applied to the panel the badge points at.
   - **A count that could not be read does not score as zero.**
     `adminHealthBreakdown()` takes `number | null`, prices a null at nothing,
     and marks the result `incomplete` so the screen can say the score is a
     ceiling rather than a reading.
   - **Nor does a figure derived from one.** Every Overview derivation lives in
     `lib/adminOverviewFigures.ts` and propagates null, because `null` becomes
     zero the moment a caller writes `?? 0` to satisfy the compiler — and
     "Paid conversion 0.0%", "$0 MRR" and "0 open feedback" are all claims an
     operator would act on, assembled out of an answer that never arrived. A
     ratio with an unknown side, or a zero denominator, is null rather than
     `0.0%`. A KPI card given null says so in words at the size the figure
     would have been; an empty card or a dash reads as "nothing here", which is
     the reading this exists to prevent.
   - **`process.env` is a reading, not the deployment.** It is fixed at process
     start, so a variable added to the host afterwards is absent here and the
     refresh control cannot bring it in — it re-renders inside the same
     process. Any surface reporting a variable as unset states when the
     process it read started. On 2026-09-14 three variables were set on the
     host and reported missing, and the panel's wording sent the diagnosis
     toward generating keys that already existed.

9. **A number an operator is asked to act on can be taken apart.** The health
   score links to `?tab=health`, which renders every factor — including the
   ones deducting nothing — with its count, its weight, the arithmetic, and
   what to do about that line. Weights live once, in `ADMIN_HEALTH_WEIGHTS`,
   and the card and the breakdown derive from the same function so they cannot
   drift.

10. **Only `required` environment rows are priced.** Every row in
    `adminEnvironmentChecks()` carries a severity, and `conditional`,
    `recommended` and `optional` rows deduct nothing while still being listed.
    A `conditional` row names its condition and is **not** claimed to be
    satisfied: whether a KR or AU recipient exists is not a fact an
    environment holds, which is exactly why `businessIdentityProblems()` keeps
    those findings at warning severity. Counting every unset variable made an
    optional Discord webhook dearer than a provider running limited and drove
    correctly-configured deployments toward zero.

11. **No admin request may be unable to end.** Every panel fetch goes through
    `adminFetch()` (`lib/adminFetch.ts`), which is `fetch` with a deadline and
    nothing else. Thirty-three of thirty-four fetching panels had none: a
    request with no deadline does not fail, it hangs, and a panel spinning
    forever teaches an operator no more than one that lies. A bare `fetch(`
    under `components/admin/` fails `tests/adminFetchDeadline.test.mjs`.

    **And a polling panel issues one request at a time.** `shouldIssueAdminPoll()`
    decides; the timer only asks. Neither polling panel tracked an in-flight
    request, so a slow endpoint made ticks stack, an early `finally` cleared the
    spinner belonging to a request still open, and a late response overwrote
    newer data -- all silent. Interval ticks also stop in a background tab,
    which one of the two already did and the other did not.

12. **A write that would revert an unseen change is refused.**
    `PATCH /api/admin/models/{id}` writes the whole submitted body, so a save
    from a stale form reverts whatever ran in between -- usually catalogue
    reconciliation rather than a second operator, which is why this matters in
    a one-person organisation. The list read is stamped server-side and echoed
    back as `?readAt=`; `modelRegistryWriteFreshness()` decides, and a stale
    write answers 409 `MODEL_REGISTRY_STALE_READ` rather than applying. An
    unparseable `readAt` is refused rather than ignored: a guard that fails
    open on a malformed value is not one.

13. **Role, re-authentication, two-person approval, audit, credit/cost and
   provider-budget policy are out of scope for this contract** and were not
   changed by it. `writeRoles` in the route table drives the sidebar's "Read"
   marker only; authorization is still decided server-side by
   `lib/adminAuth.ts` and each `/api/admin/**` route handler. Rule 7 is not an
   exception to this: *whether* to refuse is that policy's decision, and what
   the screen owes the operator once refused is this contract's.

## Language

The console is written in **English and Korean**, and in nothing else. It is an
internal tool; a half-translated console is worse than an English one, because
an operator acting on a refund or a kill switch has to trust that every label
on the screen says the same thing in the same language. Any product locale the
console has no copy for (French, German, …) reads English.

1. **The server decides the language, once per request.** `getAdminLocale()`
   (`lib/adminLocaleServer.ts`) resolves, most specific first: the console
   cookie `tomverse_admin_lang`, the product cookie `tomverse_lang`, then
   `Accept-Language`. The product's `?lang=` pin is deliberately not an input:
   a per-URL value cannot survive a layout that client navigation does not
   re-render, and prefetches never carry it. The layout passes the answer to
   `AdminLocaleProvider`; server components (`AdminPageTabs`, pages) call
   the same function. Nothing in the console picks a language in the browser,
   either after hydration or optimistically on a click — either would leave a
   server-rendered tab strip in one language beside a client-rendered panel in
   the other. A layout is not re-rendered by client navigation, and a locale
   cookie can change after the shell rendered — in another tab, or in this one
   when the product's `LanguageProvider` persists a restored language after
   hydration. Shortly after mount, after each navigation and on focus, the
   provider compares the locale the cookies imply with the one on screen and
   refreshes the route when they differ. Router prefetches skip the
   proxy's language headers, so `getAdminLocale()` reads the raw request
   instead of those headers.
2. **Copy lives in `lib/adminMessages/<namespace>.ts`, declared with
   `defineAdminMessages({ en, ko })`.** English is the shape; the Korean
   dictionary is type-checked against it. The type catches most mistakes but
   not all (TypeScript accepts a formatter with fewer parameters, and an extra
   key on a dictionary built elsewhere), so `tests/adminLocale.test.mjs` is the
   enforcement: it fails on a missing or extra key, an empty string, a formatter
   with a different arity, and a formatter that returns empty text. Client components read it with `useAdminMessages()`, server
   components with `getAdminMessages()`. No panel compares
   `locale === "ko"` to choose a string.
3. **The route table stays English.** `lib/adminNavigation.ts` owns ids, hrefs,
   roles, badges and redirects, and its labels are what runbooks and the E2E
   suite name. Korean labels live in `lib/adminNavigationLocale.ts`, keyed by
   the same ids; adding an entry, tab or detail route without Korean copy fails
   the test above. The command palette matches both languages in both consoles.
4. **Identifiers are not translated.** Role names, status codes, model and
   provider ids, error codes, environment names, trace ids and product names
   (Stripe, Railway, R2, AI Review) render as they are stored, because they are
   what an operator searches the logs and the database for.
5. **The switch is in the account menu**, each language named in its own
   language, and choosing one writes the console cookie and refreshes the route.
   It never writes the product cookie: the console choice must not move an
   operator's customer-facing language.
6. **The console root carries `lang` and `data-locale-root`.** `:lang()` only
   re-points the font tokens, and `font-family` is inherited as the family
   already resolved on `<body>`, so the root re-applies `var(--font-ui)` and
   re-declares the Latin stack for `:lang(en)` (`app/globals.css`). Without it
   a Korean console inside an English document keeps Geist, and an English
   console inside a Korean document keeps the Korean stack
   (docs/ui-contracts/typography.md). Assistive technology announces Korean
   copy as Korean.
7. **Server-generated text is not yet translated.** API error messages, audit
   summaries and diagnostic sentences built in `lib/**` and `/api/admin/**`
   arrive in English and are shown as they arrive. Translating them means
   returning codes the client renders, not translating strings on the server.
   The one exception is `describeAdminApiFailure()` (`lib/adminApiOutcome.ts`),
   which composes the console's own sentences around a response and takes the
   console locale; the server's `error` text inside it is still shown as sent.
8. **Every component under `components/admin/` reads a catalog.** The test
   above fails on a component that imports none, unless it is listed as having
   no copy of its own. The audit integrity verdicts in
   `AdminAuditIntegrityPanel.tsx` keep their sentences inline, Korean beside
   English, because `tests/adminAuditIntegrityDiagnosis.test.mjs` reads those
   literals from the function body.

## What was removed, and what replaced it

| Removed | Replacement |
| --- | --- |
| `AdminWorkspace` — one server component that ran ~29 queries for every route | one server component per route, each loading only its own surface |
| `AdminOperationsPanel` — a KPI strip, an attention list and a full env table, all of which Overview also rendered separately | `AdminOverviewSummary`, one section per fact, plus `AdminSnapshotActions` for the two operator actions |
| `AdminProviderTabs` — client tab strip whose third tab mounted a second live copy of the model registry | `AdminPageTabs`, URL-backed; the registry exists only at `/admin/models` |
| `AdminSavedViewsPanel` — "Set default" wrote `tomverse-admin-default-view`, which nothing read | `AdminQuickAccessPanel` + `AdminConsolePreferences`, shared by the sidebar and the palette |
| `AdminRiskPanels` — one component forcing four unrelated panels onto any page that wanted one | four named exports, each mounted where it belongs; the duplicated administrator table is gone (`AdminAccessPanel` already renders it) |
| `syncBillingDefaultsToDatabase()` on every admin page render | `/admin/billing` only (and `/api/admin/billing`, which already called it) |
| `ALL_ITEMS.slice(0, 9)` in the empty palette | Pinned, Recent, and every page grouped exactly as the sidebar groups them |
| `AdminMemoryImportPanel` stacked under the product funnel, so opening either fetched both | its own `?tab=imports` section |
