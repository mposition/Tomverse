# Independent review, round 1: implementation of the support-reply delivery fix

Same reviewer as round 0. Read-only; modify nothing. Working directory is the git worktree of
origin/develop@705b65ad with the change uncommitted (`git status`, `git diff`, and the untracked
files).

Round 0 verdict and findings: `.github/audits/support-reply-delivery-design-review-round0-2026-09-16.md`
Design v2, with §3a mapping each round-0 finding to a decision:
`.github/audits/support-reply-delivery-truth-design-2026-09-16.md`
Policy amendment: `docs/policy/email-notifications.md` §0 v12, and the AGENTS.md email section.

Main files: `lib/feedbackLifecycleCore.ts` (feedbackStageRecipient),
`lib/notificationDeliveries.ts`, `app/api/admin/feedback/[feedbackId]/route.ts`,
`app/api/admin/feedback/[feedbackId]/resend-reply/route.ts`, `lib/adminConsoleData.ts`,
`components/admin/FeedbackInboxPanel.tsx`, `lib/adminMessages/feedbackInbox.ts`,
`components/chat/FeedbackButton.tsx`, `locales/*.ts`, and the tests
`tests/feedbackStageRecipient.test.mjs`, `tests/server-contract/admin-feedback-route.test.ts`,
`tests/server-contract/admin-feedback-resend-route.test.ts`,
`tests/server-contract/notification-delivery-queue.test.ts`.

Judge:
1. Is each round-0 finding (F1 blocker, F2 blocker, F3, F4, F5, F6, F7) closed in the code? F5 in
   particular: did the author actually give the inline first attempt the same claim as the drain,
   or only say so? Name anything claimed in §3a but not implemented.
2. Does the new rule send anything the design did not intend? Walk the stages against: guest with
   an address, guest without one, signed-in with the tick, signed-in without it, address scrubbed
   after enqueue, suppression of each reason, and a resend.
3. The resend endpoint: authorization, idempotency, what it renders, what it can be made to do
   twice, whether it can send content the operator has not seen.
4. The console: does anything still suggest a mail that will not be sent, or claim delivery the
   system cannot know? Does the bounded read stay bounded?
5. Correctness defects anywhere in the diff (state, transactions, types, copy in 7 locales), and
   any test that now passes for the wrong reason.
6. Anything that is a release blocker under AGENTS.md "검증 범위는 되돌릴 수 없는 것에 비례합니다".

Reply in Korean:
1) 판정 approve / approve_with_changes / reject
2) round-0 발견별 해소 여부 (코드 근거 파일:줄)
3) 새 발견: severity, 근거, 재현, 권장 수정 (없으면 없다고 명시)
4) merge 전 반드시 고칠 것 / 후속으로 미뤄도 되는 것
