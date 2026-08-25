# Admin Console Information Architecture

## Status

- Contract type: Product invariant for the Admin Console shell and its routes
- Applies to: every `/admin/**` page, the sidebar, the command palette, and the
  per-page section tabs
- Severity when violated: release blocker for the redirect table; ordinary
  review for everything else
- Last reviewed: 2026-08-06

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
| Coverage | `tests/adminNavigation.test.mjs`, `tests/e2e-admin/**` |

## The navigation

Six groups, seventeen entries. One page, one job.

| Group | Entry | Route | Sections (`?tab=`) |
| --- | --- | --- | --- |
| Command Center | Overview | `/admin/overview` | — |
| Command Center | Work queue | `/admin/work-queue` | `queue`, `approvals` |
| Command Center | Analytics | `/admin/analytics` | `product`, `imports` |
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
| `/admin/approvals` | `/admin/work-queue?tab=approvals` | An approval is queue work |

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

   This has been got wrong three times. `tests/adminReauthenticationCta.test.mjs`
   now fails any panel under `components/admin/` that can see a step-up
   refusal and cannot render that link. A panel that already has the banner
   raises its existing flag rather than adding a second way to say the same
   thing.

8. **Role, re-authentication, two-person approval, audit, credit/cost and
   provider-budget policy are out of scope for this contract** and were not
   changed by it. `writeRoles` in the route table drives the sidebar's "Read"
   marker only; authorization is still decided server-side by
   `lib/adminAuth.ts` and each `/api/admin/**` route handler. Rule 7 is not an
   exception to this: *whether* to refuse is that policy's decision, and what
   the screen owes the operator once refused is this contract's.

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
