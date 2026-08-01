# Release checklist

Run through this before promoting a build. Every item needs either evidence
tied to the **release SHA** or a written waiver — an unticked box is a release
blocker, not a formality.

Record the release SHA once and reuse it everywhere below; evidence produced
against a different SHA does not count.

```
Release SHA:        ____________________
Staging deployment: ____________________
Date / timezone:    ____________________
```

## 1. Automated gates

- [ ] `npm ci` (lockfile installs cleanly)
- [ ] `npm audit --omit=dev` — **0 vulnerabilities**
- [ ] `npm audit` — 0, or every remaining advisory has a waiver recorded in §7
- [ ] `npm run typecheck`
- [ ] `npm run lint -- app components lib tests scripts`
- [ ] `npm run test:unit`
- [ ] `npm run security:regression`
- [ ] `npm run check:accent-tokens`
- [ ] `npm run check:encoding:strict`
- [ ] `npm run build`
- [ ] `npm run verify:smoke-coverage`
- [ ] `npm run test:e2e:ui-risk`
- [ ] `npm run test:e2e:admin` (needs `ADMIN_E2E_DATABASE_URL` — a dedicated,
      disposable database; the harness truncates every table between tests)
- [ ] `npm run test:db:integration` (needs `TEST_DATABASE_URL`, whose name must
      carry a test marker and must differ from the application database URL)
- [ ] Chromium E2E: `desktop-chromium`, `desktop-compact`, `mobile-chromium`
      — no unexplained failures

A suite that could not run is **not** a pass. Record it as N/V in §7 with the
reason, the owner and what is needed to run it.

## 2. Visual regression gate (required)

`tests/e2e/chat-state-visual-regression.spec.ts` is deliberately outside PR
Fast Gate, so a drifting golden can otherwise go unnoticed for up to a day
(see the header of `.github/workflows/nightly-visual-regression.yml`). That
trade is only acceptable if the suite is reviewed before a release rather
than merely before a merge.

- [ ] A **Nightly Visual Regression** run exists for the release SHA. Trigger
      it on demand via `workflow_dispatch` against the release ref if the
      scheduled run predates the SHA.
- [ ] The run was reviewed by a person, not just observed to be green.
- [ ] For any diff: the change was intentional, and the actual/expected/diff
      artifacts were inspected before accepting.

```
Workflow run URL:   ____________________
Reviewed by:        ____________________
Artifacts checked:  ____________________
```

Goldens are never refreshed by CI. If a baseline genuinely needs updating,
update it in a reviewed pull request of its own — never as part of a release.

### Waiver

Shipping without this gate requires an explicit, recorded waiver:

```
Waived by:          ____________________
Reason:             ____________________
Follow-up issue:    ____________________
```

A waiver is a decision someone owns, not a silent skip. It also does not carry
over: the next release needs its own reviewed run or its own waiver.

## 3. Staging verification

- [ ] `/api/build-info` reports the release SHA
- [ ] local, `origin/develop` and staging SHAs agree
- [ ] `/status` and `/api/models/status` queried in the same window, with no
      per-provider contradiction between them
- [ ] Model picker, provider banner and chat send agree with both of the above

## 4. Accessibility

- [ ] `.github/ACCESSIBILITY_QA_MATRIX.md` filled in for this release SHA
- [ ] No P0/P1 accessibility blocker outstanding
- [ ] Any row still marked N/V is an accepted, named risk — not an oversight

The automated rows in that matrix run in CI. The screen-reader, Korean-IME,
external-keyboard and real-browser-zoom rows do not, and a green suite says
nothing about them.

## 5. Scope notes

A green visual run is **not** an accessibility result. Screenshot goldens
cannot see focus order, accessible names, announcements or contrast in forced
colors. Accessibility evidence is tracked separately and is not satisfied by
anything in section 2.

## 6. Database and deployment configuration

Every box needs evidence captured against the release SHA — a command and its
output, or a screenshot of the setting. "Looks right" is not evidence, and a
value nobody could read is N/V in §7, never a tick.

### 6.1 Migrations

- [ ] `prisma migrate deploy` run against the target database
- [ ] No pending migration remains (`prisma migrate status` is clean)
- [ ] `20260730120000_add_user_sessions_revoked_at` is applied
- [ ] `User.sessionsRevokedAt` is nullable, so the previous release still runs
      against this schema and a rollback does not need a down-migration
- [ ] A backup or restore point exists from **before** the migration ran

```
Migrate output:     ____________________
Backup / snapshot:  ____________________
```

### 6.2 Environment

- [ ] `CSP_MODE=enforce`
- [ ] `REQUIRE_CLOUDFLARE_ORIGIN_SECRET=true`
- [ ] `CLOUDFLARE_ORIGIN_SECRET` is at least 32 characters
- [ ] `TRUSTED_PROXY_IP_HEADER=cf-connecting-ip`
- [ ] `NEXTAUTH_URL` is exactly the public HTTPS origin. Session cookies lose
      `Secure` and the `__Secure-` prefix when it is not `https://`, and the
      Playwright short-circuits are gated on it not being a loopback address
- [ ] `E2E_AUTH_BYPASS` and `E2E_DISABLE_DATABASE` are unset, or at least not
      `"true"`, in production
- [ ] `DATABASE_URL` and `DIRECT_DATABASE_URL` are private hosts, or carry
      `sslmode=verify-full` / `verify-ca`

### 6.3 Edge

- [ ] Cloudflare strips or overwrites client-supplied `cf-*` headers.
      **Spoof test**, from outside the edge, against the release deployment:

      curl -s -o /dev/null -w '%{http_code}\n' https://<origin>/chat \
        -H 'cf-ipcountry: XX' -H 'purpose: prefetch'

      The billing market and client IP must not reflect the forged values.
      `purpose: prefetch` is included deliberately: the proxy matcher is
      unconditional, and a request carrying it must still be host-checked.
- [ ] A request that reaches the origin directly, without the Cloudflare origin
      secret, is rejected with 421

### 6.4 Readiness and liveness

- [ ] `/api/ready` is wired into pre-promotion checks and into the external
      readiness monitor
- [ ] The Railway container healthcheck stays on **`/api/health`**.
      `/api/ready` reports dependency state, so wiring it to container liveness
      makes a database blip restart healthy processes and turns a degradation
      into an outage.

### 6.5 Legacy conversation-lock passwords

- [ ] Migration script run with `--dry-run` first; row count recorded
- [ ] Migration executed, and a follow-up query confirms **0** remaining
      plaintext rows
- [ ] `compareLegacyPassword` removal is scheduled for a *later* release, not
      this one — it stays until production has been observed at 0 rows

```
Dry-run count:      ____________________
Post-run count:     ____________________
```

## 7. Unverified items and waivers

Anything above that could not be verified from this environment goes here with
a named owner. N/V is an accepted, tracked risk; a silent tick is neither.

| Item | Why not verified | Owner | Command / evidence needed |
| --- | --- | --- | --- |
|  |  |  |  |
