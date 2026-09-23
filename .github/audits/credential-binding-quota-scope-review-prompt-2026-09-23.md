# Independent review: credential bindings and quota scopes, added dark

You are an independent reviewer. You did not write this change. **Do not modify
any file. Read-only.** If a command is refused by the environment, say so rather
than inferring its result.

Repository: current working directory (Tomverse, Next.js + Prisma). The change
under review is the commit whose subject is *"feat(routing): credential bindings
and quota scopes, added dark"* — find it with `git log --oneline -5`; it may not
be `HEAD`, because a review prompt is usually committed after it.

`contract`-grade: a Prisma migration. Additive and dark — three new tables,
nothing reads them, nothing activated.

## Read

1. `prisma/migrations/20260923140000_credential_binding_quota_scope_dark/migration.sql`
2. `prisma/schema.prisma` — `ProviderRegistryEntry`, `CredentialBinding`,
   `QuotaScope`, and the two back-relations added to `User`
3. `lib/deploymentIdentity.ts` — the second half, from `QUOTA_SCOPE_KINDS`
4. `tests/quotaScopeShape.test.mjs`
5. `scripts/check-dark-tables.mjs`, `scripts/check-enum-constraints.mjs`
6. `.github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md`
   — §1.2 (D6, account ownership), §7 (cost semantics), §8.2, §8.3
7. `AGENTS.md` — "Credit entitlement vs operational guardrail"

## What to judge

### A. The shape rule

- `QuotaScope_shape_check` enumerates five kinds with required and forbidden
  columns. Is the SQL correct, and does it match
  `QUOTA_SCOPE_REQUIRED_FIELDS` in `lib/deploymentIdentity.ts` exactly?
- The five partial unique indexes: right columns, right predicates? Can the
  same logical scope still be created twice by any route?
- `endpoint_credential` is unique on `(providerEndpointId, credentialBindingId)`
  while `deployment_credential` is unique on
  `(modelDeploymentId, credentialBindingId)`. A deployment already belongs to
  one endpoint — does that make one of these redundant, or are they different
  questions?
- Is anything expressible that should not be? For example, a
  `deployment_credential` scope whose deployment belongs to a different
  endpoint than the credential binding does. Nothing appears to prevent that.

### B. Funding

- `CredentialBinding_billing_owner_account_check` and
  `CredentialBinding_budget_account_check` bind the funding columns to
  `billingOwner`. Are both directions right, and is
  `credentialBindingFundingProblems` the same rule?
- `providerBudgetAccountId` is free text with no foreign key. Should it have
  one, and what is it supposed to point at?
- Does this arrangement actually keep an account's BYOK spend out of the
  Tomverse provider budget and out of the purchased-credit funded allowance, or
  does it only make that possible for a later caller to get right? Read
  `lib/chatSecurity.ts` for how `reservedCost` currently reaches three
  consumers.

### C. Account ownership

- `accountId` cascades on delete, matching the rest of the schema. Is that
  right for a credential binding — what happens to spend records that
  referenced it?
- `QuotaScope.accountId` also cascades while every other foreign key on that
  table restricts. Is the mix deliberate-looking or accidental?

### D. Darkness and the registry

- Does `check:dark-tables` actually cover the three new tables, and can you
  construct a use it would miss?
- `ProviderRegistryEntry` duplicates the `AiProvider` union in `lib/models.ts`.
  Two lists of providers is the shape this work has repeatedly called a defect.
  Is this an exception that earns itself, or the same mistake again?

### E. What is missing

- The design's §8.3 asks for `providerBudgetAccountId` on the attempt cost
  snapshot and a versioned dual-read for bucket keys. Neither is here. Is
  deferring them right, or does the schema as written make them harder later?
- Anything in `AGENTS.md` "Credit entitlement vs operational guardrail" that
  this contradicts?

### F. Irreversibility

Under `AGENTS.md` "검증 범위는 되돌릴 수 없는 것에 비례합니다": name what is
irreversible if this is wrong. Dark tables can be dropped — is that the whole
story?

## Output format

Reply in **Korean**. Structure:

1. **판정**: `approve` / `approve_with_changes` / `reject`
2. **사실 오류** — 커밋 메시지·주석의 주장 중 코드와 맞지 않는 것. 파일:줄 근거 필수.
   없으면 "없음"
3. **발견 사항** — severity (`blocker` / `major` / `minor`), 근거, 확인 방법, 권장 수정
4. **A–F 각 절에 대한 답**
5. **권장 후속 작업**

근거 없는 동의는 검토가 아닙니다. 동의하는 항목도 왜 동의하는지 한 줄로 적으십시오.
