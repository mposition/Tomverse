# Independent design review request: support trace review → approval → promotion

You are an independent reviewer. You did not write this design. Do not modify any
file. Read-only.

Repository: current working directory (Tomverse, Next.js + Prisma). Base commit is
`origin/develop` HEAD.

## Read first, in this order

1. `.github/audits/support-trace-review-flow-design-2026-09-15.md` (the design, Korean)
2. `docs/policy/trace-feedback-automation.md` (esp. §2, §8, §9, §9.1, §9.2)
3. `AGENTS.md` sections "Trace 기반 오류 신고 자동화", "이메일 알림",
   "Admin Console information architecture invariant", "브랜치 이름이 자동화 권한을 정합니다"
4. Code the design depends on — verify the design's "현재 사실" claims:
   `app/api/feedback/route.ts`, `lib/feedbackAutoFixCore.ts`, `lib/feedbackAutoFixSync.ts`,
   `lib/feedbackAutoFixShadow.ts`, `app/api/internal/feedback-autofix/**`,
   `.github/workflows/feedback-autofix.yml`, `lib/notificationDeliveries.ts`,
   `app/api/admin/feedback/[feedbackId]/route.ts`, `components/admin/FeedbackInboxPanel.tsx`,
   `lib/adminNavigation.ts`, `lib/adminNavigationCounts.ts`, `lib/buildInfo.ts`,
   `lib/adminReauthentication.ts`, `docs/ops/staging-access-boundary.md`,
   `.github/workflows/back-merge-main-to-develop.yml`, `prisma/schema.prisma` (Feedback,
   FeedbackAutoFixCase, NotificationDelivery) and any DB CHECK constraints on those
   tables under `prisma/migrations/`.

## What to judge

- Is any factual claim in §1 wrong?
- Security: the production promotion path (§2, §4.4). Can an attacker or a bug cause
  a merge/deploy of code the owner did not approve? Consider: head SHA binding,
  push-after-approval, cherry-pick producing different content than what was reviewed,
  workflow self-report vs server observation, the dispatch token on the server,
  sync-secret/PAT separation, replay/out-of-order results, concurrent approvals.
- State machine (§3): unreachable/stuck states, double merge, lease expiry handling,
  timeouts, interactions with existing edges and `reclaimExpiredFixLeases()`.
- Policy: is the proposed amendment coherent with the rest of the policy, or does it
  silently weaken another invariant (e.g. "staging ≠ production resolved", "no user
  content in diagnosis", email lane rules, admin IA rules)?
- Request 1 scope (verified token only) and duplicate-email handling.
- Server-side deploy observation: is comparing staging `/api/build-info` and the
  production process's own build info sound (rolling deploys, multiple replicas,
  squash vs cherry-pick SHA, Railway "Wait for CI")?
- Anything missing that would make this a release blocker under AGENTS.md
  "검증 범위는 되돌릴 수 없는 것에 비례합니다".
- Answer the five open questions in §8 with a recommendation each.

## Output format

Reply in Korean. Structure:

1. 판정: `approve` / `approve_with_changes` / `reject`
2. 사실 오류 (파일:줄 근거)
3. 발견 사항 목록 — 각 항목: severity (blocker/major/minor), 근거(파일:줄 또는 추론),
   재현 또는 확인 방법, 권장 수정
4. §8 열린 질문별 권고
5. 권장 작업 순서 변경이 있으면 제시
