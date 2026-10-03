# Release deviation — 2026-10-02, `a4ff6a3`

**A selective release (§7.9.1) reached `main` without a release record.** PR
#1942 was merged with its checklist block still blank, and its release
candidate was never deployed to staging on its own. This records what was
verified, what was not, and why, after the fact.

Drafted by the agent (Claude) on 2026-10-03 from repository, GitHub and
`/api/build-info` reads. The operator chose, in the session, to record the
staging item as skipped with a reason (option B) rather than deploy the RC to
staging. Nothing below is a verification that did not happen.

## The release

| | |
|---|---|
| Pull request | #1942, `release/2026-10-02-review-orchestrator` → `main` |
| `main` before the merge | `f9d85450469008fe34d5cc4db6c775cf44675aaa` |
| Release candidate (head of the branch) | `cd8bb2d34654ece53818e35baf2262ca46c0c181` |
| Merge commit | `a4ff6a3d435b26d670eb5f8aae622c8239b01356`, merged 2026-10-02T12:52:04Z by `mposition` |
| Content | 8 commits cherry-picked with `-x` from `develop`, no conflict resolutions: the review orchestrator (#1924, #1932, #1934) and its `AGENTS.md` call rule (#1940). 21 files, all additions |
| Back-merge to `develop` | Confirmed: `a4ff6a3d…` is an ancestor of `origin/develop` |
| **Rollback SHA** | `f9d85450469008fe34d5cc4db6c775cf44675aaa` (`main` before this release) |

## The gap

§7.9.1 asks for the RC SHA to be deployed to staging and read back through
`/api/build-info`. That was not done.

- Staging was serving `develop` at `457fe3b324d808246e5bb5532bbf615643eb1789`
  (deployment `51e236a2-1bbd-4e59-8b9a-17ee40a10ffb`, deployed
  2026-10-02T11:39:44Z, `deploymentStatus: success`). That build already
  contained the same eight commits byte-for-byte, so the files built and
  deployed, but a different build was measured, which §7.9.1 says does not count.
- Whether production ever served `a4ff6a3d…` itself was not checked. When this
  record was drafted, production served
  `b243b0e1e26aff7fd1ca24ff344d27167b8a74cf` (deployment
  `6cfa1e22-d5c6-4632-88a1-b88882ae1781`, deployed 2026-10-02T23:44:44Z),
  which is later than this release and covered by the signed record
  `release-2026-10-02__b8673738.md` and the releases after it.

## Why the gap carries no irreversible risk

The only file the running app can reach is `lib/agentAuthorityFiles.ts`, used
by the engineering agent's path classification (latched off in production). It
adds `tools/**` as control-plane; a path under `tools/` was tier two before (an
unknown top-level directory) and is tier two after, so no verdict changes. The
rest is `tools/review-orchestrator/**` (an operator tool run on the review
server, imported by no app route, build step or migration), its tests,
`AGENTS.md` and one `package.json` script. Nothing writes user data, credits,
prices or migrations. The tool itself was exercised end to end on the review
server under its dedicated account on 2026-10-02 (two live reviews).

## Review

- [x] Confirm or correct the statement above that this release needed no staging
      measurement, and sign below.

```
Reviewed by:   mposition
Reviewed on:   2026-10-03
```

**Signed.** `mposition` reviewed this record and gave the signature above in the
session on 2026-10-03; the agent transcribed it. The signature confirms the
record's account of the gap and the risk judgement. It is not a staging
measurement of the RC, which did not happen.
