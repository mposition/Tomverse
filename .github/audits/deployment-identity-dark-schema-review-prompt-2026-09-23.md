# Independent review: deployment identity, added dark

You are an independent reviewer. You did not write this change. **Do not modify
any file. Read-only.** If a command is refused by the environment, say so rather
than inferring its result.

Repository: current working directory (Tomverse, Next.js + Prisma), checked out at
the commit under review (`HEAD`).

This is a `contract`-grade change: a Prisma migration. It is additive and dark --
three new tables, nothing reads them, nothing is activated. It was allowed to
proceed ahead of a pending provider-contract review on exactly that condition.

## Read

1. `git show HEAD` — the whole diff
2. `prisma/migrations/20260923120000_deployment_identity_dark/migration.sql`
3. `prisma/schema.prisma` — `ProviderEndpoint`, `EndpointResidencyApproval`,
   `ModelDeployment`
4. `lib/deploymentIdentity.ts`, `lib/providerDataDestinations.ts`
5. `tests/deploymentIdentity.test.mjs`
6. `.github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md`
   — the design, especially §1 (owner decisions D1–D7), §2, §4, §6, §8
7. `AGENTS.md` — "검증 범위는 되돌릴 수 없는 것에 비례합니다",
   "Conversation.productKey" (for this repository's CHECK/NOT NULL conventions)

## What to judge

### A. Is it actually dark, and will it stay that way?

- Does anything in the running product read these tables? Check beyond the list
  the test asserts on.
- `tests/deploymentIdentity.test.mjs` pins darkness by grepping a fixed list of
  readers. Is that list the right one, and what reader could be added that the
  test would not notice?
- Is `npx prisma generate` output the only other thing this changes?

### B. The migration

- Is it safe to deploy against a live database with no downtime? Anything here
  that takes a lock worth naming?
- Is the rollback statement in the header true — can these three tables be
  dropped with no other effect?
- Are the CHECK constraints correct PostgreSQL, and do they mean what the
  comments say? In particular the two `jsonb_array_length` ones and the
  `effectiveTo > effectiveFrom` window.
- `ModelDeployment_enabled_requires_gate_check` couples two columns. Is that
  enforceable in practice, or does it make an ordinary two-step update
  impossible (set gate passed, then enable)?
- Are `ON DELETE RESTRICT` the right choices? Consider what an operator
  removing a misconfigured endpoint would experience.

### C. The identity model

- `ProviderEndpoint` has `gatewayProvider` and `servingProvider` and no single
  `provider`. Does anything downstream need one, and is the absence going to be
  reintroduced by the first caller?
- `logicalModelId` is not a foreign key. Right call, or does it leave orphans
  nothing detects?
- `ModelDeployment` is unique on `(providerEndpointId, upstreamDeploymentName)`.
  Is that the right uniqueness? Can one endpoint legitimately serve the same
  upstream name twice — different versions, say?
- Is anything missing that the design's §2 said would be here, and is anything
  here that the design did not ask for?

### D. Residency

- `residencyClass` defaults `unproven` and has two values. The design argues a
  third value for "probably" would be read as a yes. Agree or not, with a
  reason.
- `EndpointResidencyApproval` is described as append-only, but nothing in the
  database enforces that — there is no trigger preventing `UPDATE`. Is the
  claim in the comment therefore false, and should it be enforced or reworded?
- Does `lib/providerDataDestinations.ts` overlap with
  `EndpointResidencyApproval` in a way that recreates the two-lists problem the
  design says it is avoiding? One is a code registry of provider facts, the
  other a database record of approvals. Say whether that split is coherent or
  whether it is the same duplication wearing two names.

### E. What this commits the project to

- Under `AGENTS.md` "검증 범위는 되돌릴 수 없는 것에 비례합니다": is anything here
  irreversible if wrong? A dark table can be dropped — is that the whole story?
- Is there a claim in the commit message that the code does not support?

## Output format

Reply in **Korean**. Structure:

1. **판정**: `approve` / `approve_with_changes` / `reject`
2. **사실 오류** — 커밋 메시지·주석·설계 문서의 주장 중 코드와 맞지 않는 것.
   파일:줄 근거 필수. 없으면 "없음"
3. **발견 사항** — severity (`blocker` / `major` / `minor`), 근거, 확인 방법, 권장 수정
4. **A–E 각 절에 대한 답**
5. **권장 후속 작업**

근거 없는 동의는 검토가 아닙니다. 동의하는 항목도 왜 동의하는지 한 줄로 적으십시오.
