# Admin Console Information Architecture

## Status

- Contract type: Product invariant for the Admin Console shell and its routes
- Applies to: every `/admin/**` page, the sidebar, the command palette, and the
  per-page section tabs
- Severity when violated: release blocker for the redirect table; ordinary
  review for everything else
- Last reviewed: 2026-09-29

## Scope

| Area | File |
| --- | --- |
| Route table, groups, aliases, tabs, view roles, redirect map | `lib/adminNavigation.ts` |
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
| AMUX section status chips, read from each section's switch | `lib/adminAmuxTabStatus.ts` |
| Coverage | `tests/adminNavigation.test.mjs`, `tests/adminAmuxTabStatus.test.mjs`, `tests/adminHealthScore.test.mjs`, `tests/adminEnvironmentChecks.test.mjs`, `tests/adminAlertsDrawer.test.mjs`, `tests/adminOverviewFigures.test.mjs`, `tests/adminFetchDeadline.test.mjs`, `tests/adminPollTick.test.mjs`, `tests/adminWriteRouteGuards.test.mjs`, `tests/adminReauthenticationCta.test.mjs`, `tests/e2e-admin/**` |

## The navigation

Seven groups, twenty-eight entries. One page, one job. The owner sees all
twenty-eight; every other role sees twenty-six, because two AMUX entries are
owner-only (rule 14).

| Group | Entry | Route | Sections (`?tab=`) |
| --- | --- | --- | --- |
| Command Center | Overview | `/admin/overview` | `summary`, `health` |
| Command Center | Work queue | `/admin/work-queue` | — |
| Command Center | Analytics | `/admin/analytics` | `usage`, `product`, `imports`, `ai-review` |
| Customers | Users | `/admin/users` | — |
| Customers | Support | `/admin/support` | `feedback`, `fixes`, `privacy` |
| Revenue | Billing | `/admin/billing` | `plans`, `promotions` |
| Revenue | Refunds | `/admin/refunds` | — |
| Revenue | Credit ledger | `/admin/credit-ledger` | — |
| AI Platform | Providers | `/admin/providers` | `health`, `usage-cost`, `incidents` |
| AI Platform | Models | `/admin/models` | `registry`, `discovery` |
| AI Platform | Routing | `/admin/routing` | — |
| Operations | Infrastructure | `/admin/infrastructure` | — |
| Operations | Automation | `/admin/automation` | `jobs`, `webhooks`, `reports` |
| Operations | Alerts | `/admin/alerts` | `policy`, `templates`, `deliveries` |
| Operations | Email campaigns | `/admin/email-campaigns` | `campaigns`, `schedule` |
| Operations | Email delivery | `/admin/email-delivery` | `deliveries`, `suppressions` |
| Operations | Marketing | `/admin/marketing` | `queue`, `published`, `accounts`, `experiments`, `reports`, `comments` |
| Operations | Engineering agent | `/admin/engineering-agent` | `queue`, `runs`, `pull-requests`, `settings` |
| Operations | Agent digests | `/admin/agent-digests` | `qa-release` |
| Operations | Agent office | `/admin/office` | `live`, `dashboard` |
| Operations | Platform settings | `/admin/platform` | — |
| AMUX | Backlog (owner only) | `/admin/amux-backlog` | `intake`, `import`, `reconciliation`, `metadata` |
| AMUX | Promotion (owner only) | `/admin/amux-promotion` | `recommendation`, `promotion`, `auto-promotion` |
| AMUX | Execution | `/admin/amux-execution` | `cards` (owner only), `assignment`, `halts` |
| Governance | Email policy | `/admin/email-policy` | `jurisdictions`, `domains` |
| Governance | Audit log | `/admin/audit` | — |
| Governance | Retention | `/admin/retention` | — |
| Governance | Admin access | `/admin/admin-access` | `administrators`, `readiness`, `integrity` |

**Marketing** is the marketing automation's record: what the Guard sent to a
person, what went out, which brand accounts exist and what the automation
reported (`docs/policy/marketing-automation.md` §6.1, §8). Its badge counts
drafts in `pending_approval`, because the Guard's second verdict is "a person
decides" and without the count the queue is a page nobody opens. Its
`experiments` and `comments` sections are labelled as belonging to later
stages rather than drawn as queues that happen to be empty: "nothing is
waiting" and "nothing writes this yet" are different answers, and only one of
them is true. Reading any of it takes ordinary admin authentication; the
`writeRoles` on this entry drive the sidebar marker and the mutations a later
slice adds, not these screens.

**Engineering agent** is the engineering agent's record and the controls a
person owns (`docs/policy/engineering-agent.md §11` and `docs/policy/engineering-agent.md §12`): T2 drafts decided,
decision items acknowledged, the mode and freeze, a halt acknowledged and the
record that both dead-man monitors alert. It carries no badge in
this slice. Reading takes ordinary admin authentication; every control takes
`engineering-agent:write` and a recent sign-in, checked by its own route, and
`t1` is not a mode this screen can set.

**Agent digests** is the common area where agent teams' daily digests are
read (`docs/policy/qa-release-agent.md` section 4), one section per agent
that stores them; QA and release is the first. It shows the newest operator
control revision and the recent digests as counts and codes, says how many
it lists, and shows an expired or unreadable body as such rather than
drawing a digest that is not there. It carries no badge. Its one control
records the next operator control revision, offered to owner and ops only;
its route checks that role and a recent sign-in again and answers a stale
sign-in with the way back. Clearing a merge-lane latch arrives with the lane.

**Agent office** is a shell: a pixel office for the eight agent teams and the
digest desk, after the original AI OFFICE UI by godseng.mom. It opens on the
real view: every team's staff at their desks, every room at its real or link
status, nobody moving or speaking a scripted line, and the console declining
orders that would move staff. A demo day plays in the browser only when the
operator asks for it ("Watch demo"), and while it plays, under rule 8,
everything on it that could be read as a fact says it is a demo -- a notice
above the office, a chip on the approval card, "SIMULATION" and "SIM CLOCK"
where the original said real-time; "Back to the real view" ends it. The
demo's approve button advances the demo and nothing else; there is no publish
link.
The facts on it are the record links and the rooms marked LIVE. Each team
links to the page above that holds its record while the route table has that
page and section, and a team without one -- including on a branch that does
not carry its screen yet -- is drawn as waiting on a link instead of being
given a status (the teams the demo day gives work to have screens on every
branch, and a test holds that); a linked team
the demo day has no script for stays waiting rather than being reported as
done. A LIVE room reads that team's operating state on the server and the
demo leaves it alone -- no scripted work, no seat in a meeting (the day's or
one the operator calls), and its staff say only the record's line. For product research that is the app
switch, the latest scheduled slot (recorded, failed, or not yet, and whether
its window is open), the newest success and the agent's own silence verdict,
all in UTC -- never its observations, which
`docs/policy/product-research-agent.md §4` and
`docs/policy/product-research-agent.md §8` keep to its own section. For QA
and release it is the agent's own digest freshness verdict
(`lib/qaReleaseDigestFreshnessCore.ts`, with the digest secret seen only as a
length), when the newest digest was stored, the operator control revision and
whether the merge lane is latched -- never what a digest says, which
`docs/policy/qa-release-agent.md §4` keeps to the common digest area. For
billing and finance it is the app switch row as the agent reads it (unreadable
is never off), the agent's own silence verdict for today's price-deadline
digest and when the newest digest was stored -- never the verdict, models or
deadlines inside it, which `docs/policy/billing-finance-ops.md §1.4` keeps to
its digest tab. For
engineering it is the mode the agent acts on (its own switch resolution, the
kill switch seen only as engaged or not), the halt it tells its services, how
many decisions wait for a person, how many runs are in progress and since
when, and the newest ended run's status, outcome and times -- a run needs a
look unless the agent's own settlement handed its result to a person -- never
a patch, a reason or a card, which
`docs/policy/engineering-agent.md §11` keeps to its own record. While
engineering is live the demo plays no draft and no approval: its decisions
are real and are made on its own screen, so the office's approval windows and
the end-of-day briefing say so and link there instead of offering a demo
approval, and the phases it replaces are marked as replaced, never ticked.
Under the teams, the AMUX execution room is LIVE as a whole: a desk for each
worker in the app's AMUX worker catalog (archived ones left out; past twelve,
the ones that need a look are drawn first and the room says in words how many
are not drawn, as it does for a failed read or a missing catalog), each worker
drawn seated with its real state -- the operator's exclusions first, then its
runtime row read the way AMUX reads it when it hands out work (live while the
lease has not run out and the status is idle or busy) -- and, while the
route table has it, a link to the AMUX execution page. Workers are not demo staff: they never walk, meet or
speak a demo line, and nothing about the cards they work on is read.
Those reads are read-only (the silence anchor is looked up rather than
created), and a read that fails is drawn as unread, never as a state
(`lib/agentOfficeLiveRead.ts`, `lib/agentOffice/roster.ts`,
`tests/agentOffice.test.mjs`). The page writes nothing and carries no badge
and no `writeRoles`. Its two sections are `?tab=` addresses (rule 2); it
draws its own tab strip, as the original did, and those tabs are links, so
moving between them keeps the panel and its demo day mounted and brings a
fresh reading of the LIVE rooms. The console shell owns the page's `h1`, so
the office's own titles are `h2`s. It wears the console's colours rather than
the original's pink: role tokens for text, line, surface, the primary blue and
the room states, set for light and for dark so it follows the console's
theme; the AI Review gradient is not among them.

**AMUX** is the development-agent work board
(`docs/policy/development-agent-orchestration.md`). Its eight screens used to
be eight unlisted owner-only routes, left out of the table because the table
fed every role's palette and every other role gets a 404 from them. They are
now sections of three pages, listed by role (rule 14): **Backlog** (what
enters the backlog and what is recorded about a card) and **Promotion** (how a
card reaches Todo) are owner-only; **Execution** opens to every admin role on
**Assignment** -- why AMUX assigned the work, and the escalations waiting on a
person, which used to sit on Routing -- while its **Cards** section stays
owner-only. The owner opens Execution on Cards, everyone else on Assignment,
and a non-owner who names `?tab=cards` gets a 404 rather than another section.
The panels are the same components and send what they sent; each page loads
only its open section.

Its Assignment tab carries the count of AMUX escalations still `open` or
`acknowledged`, from the same status list the section reads
(`AMUX_ESCALATION_AWAITING_STATUSES`). Its **Halts** tab (orchestration policy
version 20, section 7) lists the AMUX Orchestrator's halts, the writes a person
has to confirm with their receipts, and the owner's clear, and carries the count
of halts no person has cleared (`amuxOrchestratorHalts`). Every admin role reads
it, because the Execution entry's badge counts it for every role; the clear
takes the owner role and a recent step-up in its own route, and a stale step-up
is answered with the way back (rule 7). The Execution entry's badge
(`amuxExecution`) is the escalation count plus the halt count, and is drawn only
when both are known: a partial sum would read as "no halt". Each gated section's tab carries a chip
-- "Preview · apply off" or "Apply on", and "Behind server switch" or "Server
switch on" for auto-promotion -- computed by `lib/adminAmuxTabStatus.ts` from
the environment variable and shipped code latch that section's own route
reads (rule 8). Cards reads "Read only" because the card list issues no
request and writes nothing; Assignment reads "Read only" to a role without
`ops:write`, the permission every decision route checks.

**Routing** keeps Chat shadow routing only, and one line pointing at AMUX ›
Execution, because runbooks written before the move send operators there.

Plus three routes with no sidebar entry: `/admin/search` ("Global search",
reachable from the header control, `Ctrl/Cmd+K` and the palette's "View all
results"), `/admin/users/[userId]` and `/admin/providers/[provider]`.

`/admin` itself is an entry point, not a workspace: it forwards to Overview.

## Old route → new route

Nothing was deleted. Every previously reachable URL still resolves, and it
resolves to the *section* it named rather than to the first tab of whichever
page absorbed it. `tests/adminNavigation.test.mjs` fails if a retired route
loses its redirect route or points at a tab that does not exist, and
`tests/e2e-admin/admin-shell-navigation.spec.ts` drives all sixteen in a browser.

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
| `/admin/amux-intake` | `/admin/amux-backlog?tab=intake` | The AMUX screens became sections of the AMUX group |
| `/admin/amux-board-import` | `/admin/amux-backlog?tab=import` | As above |
| `/admin/amux-reconciliation` | `/admin/amux-backlog?tab=reconciliation` | As above |
| `/admin/amux-backlog-metadata` | `/admin/amux-backlog?tab=metadata` | As above |
| `/admin/amux-board-recommendation` | `/admin/amux-promotion?tab=recommendation` | As above |
| `/admin/amux-board-promotion` | `/admin/amux-promotion?tab=promotion` | As above |
| `/admin/amux-board-auto-promotion` | `/admin/amux-promotion?tab=auto-promotion` | As above |
| `/admin/amux-cards` | `/admin/amux-execution?tab=cards` | As above |

The AMUX redirects decide nothing about access. A role the destination refuses
is redirected and then gets the destination's 404, as it got one from the old
address; the redirect page itself never reads the session.

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
   - **A switch state is read, never written.** A chip that says a section's
     writes are off is a claim about a switch, so it is computed from that
     switch -- the AMUX section chips from the same environment variable and
     shipped code latch the section's own route passes to the same permit
     function (`lib/adminAmuxTabStatus.ts`). Written as a string it would go on
     saying "off" the day apply was turned on, and
     `tests/adminAmuxTabStatus.test.mjs` pins each chip to its route's
     variable.

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
   marker only, and `viewRoles` (rule 14) what the console lists;
   authorization is still decided server-side by `lib/adminAuth.ts`, each page
   and each `/api/admin/**` route handler. Rule 7 is not an exception to this:
   *whether* to refuse is that policy's decision, and what the screen owes the
   operator once refused is this contract's.

14. **A page or section a role cannot open is not offered to it.** An entry or
    a tab may declare `viewRoles`; the sidebar, the command palette, pins,
    recents and the tab strip then show it to those roles alone
    (`adminNavigationFor`, `adminSearchablePagesFor`, `adminHrefIsVisibleTo`,
    `adminVisibleTabs`). A role that cannot be determined sees only what every
    role sees. This is visibility, not authorization: the page still refuses
    on its own, with `notFound()`, and `tests/adminNavigation.test.mjs` keeps
    the two equal -- a listed page that answers 404 advertises what it hides,
    and a hidden page that would open is a way in nobody can find. A request
    that names a section its role may not open is a 404, not a different
    section: substituting one would confirm the named section exists.

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
