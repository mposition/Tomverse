# Independent review: capacity state and the availability observation

You are an independent reviewer. You did not write these changes. **Do not
modify any file. Read-only.** If a command is refused by the environment, say so
rather than inferring its result.

Repository: current working directory (Tomverse, Next.js + Prisma). Two commits
are under review — find them with `git log --oneline -6`:

- *"feat(routing): capacity state, added dark"*
- *"feat(routing): one availability observation, added dark"*

Both are `contract`-grade (Prisma migrations), additive and dark.

## Read

1. `prisma/migrations/20260923180000_quota_capacity_state_dark/migration.sql`
2. `prisma/migrations/20260923200000_availability_observation_dark/migration.sql`
3. `lib/quotaCapacity.ts`, `lib/availabilityObservation.ts`
4. `tests/quotaCapacity.test.mjs`, `tests/availabilityObservation.test.mjs`
5. `prisma/schema.prisma` — `QuotaCapacityState`, `AvailabilityObservation`
6. The code they claim things about: `lib/providerErrorClassification.ts`
   (`PROVIDER_SCOPED`), `lib/providerMonitoring.ts`
   (`recordProviderHealthHeartbeat`), `lib/providerProbe.ts`,
   `lib/routerRuntimeSignals.ts`, `lib/routingAttemptStore.ts`
7. `.github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md`
   — §5, §8.1, §9 (gap 4)
8. `AGENTS.md` — "Credit entitlement vs operational guardrail"

## What to judge

### A. Is capacity genuinely separate from health?

- The claim is that a 429 and a 5xx increment the same counter today. Verify it
  against `PROVIDER_SCOPED` and `recordProviderHealthHeartbeat`.
- Does `QuotaCapacityState` introduce any path back into provider health, in
  the schema, the SQL or `lib/quotaCapacity.ts`?
- `capacityRefusal` returns null for a deprioritised scope and
  `isDeprioritized` answers separately. Is that split right, or does it leave a
  caller able to ignore the demotion entirely?
- `concurrencyLimit: 0` refuses. `concurrencyLimit: null` does not. Is that the
  right reading of "no limit", and can a writer produce 0 by accident where it
  meant null?

### B. The capacity constraints

- Are the three CHECKs correct PostgreSQL, and do they mean what the comments
  say?
- `rateLimitedCount` with a window but no rotation logic: is a count that is
  never reset a hazard the schema should prevent, or is that the projection's
  problem?
- `retryAfterUntil` can only be filled by code that reads the header, which
  does not exist. Is recording that on the column enough, or should the column
  wait?

### C. The observation, and idempotency

- `eventId` is unique and `shouldApply` is a pure predicate over a set. Is that
  a sufficient idempotency story for a real projection — what happens with
  concurrent projectors, or a projector restarting mid-window?
- The append-only trigger covers UPDATE and DELETE. Does anything else need to
  be stopped? Consider `TRUNCATE`.
- `AvailabilityObservation_deployment_has_endpoint_check`: right rule? Is there
  a legitimate observation that knows its deployment and not its endpoint?
- `rollupGrainsFor` returns `["provider"]` for an observation with neither id.
  Does that make the provider rollup a mixture of grains that cannot be
  compared over time, as deployments start appearing?

### D. Does this actually solve what the design said it had to?

The design's §8.1 said deployment-grain health cannot be cut over without a
sample, and listed five prerequisites. Which of them do these two commits
satisfy, and which remain? Be specific — the design will be updated from your
answer.

### E. Vocabulary sharing

`AvailabilityObservation.errorClass` reuses `ROUTING_ATTEMPT_ERROR_CLASSES`.
One list for two tables is the opposite of this work's usual advice about two
lists for one thing. Is reuse right here, or are these different questions that
will diverge?

### F. Irreversibility

Under `AGENTS.md` "검증 범위는 되돌릴 수 없는 것에 비례합니다": name what is
irreversible if these are wrong.

## Output format

Reply in **Korean**. Structure:

1. **판정**: `approve` / `approve_with_changes` / `reject`
2. **사실 오류** — 커밋 메시지·주석의 주장 중 코드와 맞지 않는 것. 파일:줄 근거 필수.
   없으면 "없음"
3. **발견 사항** — severity (`blocker` / `major` / `minor`), 근거, 확인 방법, 권장 수정
4. **A–F 각 절에 대한 답**
5. **권장 후속 작업**

근거 없는 동의는 검토가 아닙니다. 동의하는 항목도 왜 동의하는지 한 줄로 적으십시오.
