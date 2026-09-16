# Confirmation review of the round-1 fixes (narrow scope)

Same reviewer. Read-only; modify nothing. Not a new full review: check only whether your round-1
"merge 전 반드시 고칠 것" list is closed in code, and whether the fixes introduced a defect.

Your round-1 report: `.github/audits/support-reply-delivery-review-round1-2026-09-16.md`.

The five items were:
1. the re-send preview and the payload must come from one source, and the operator must see the
   text that will be sent;
2. the resend contract test's fake claim must match production;
3. an inline-vs-drain race test;
4. the suppression check's scope;
5. manual/privacy_request reporting.

What changed since your review (`git diff`, untracked files):
`lib/adminConsoleData.ts` (completionSnapshot from the completed lifecycle event, for the same
bounded rows), `components/admin/FeedbackInboxPanel.tsx` (the re-send block now gates and previews
on completionSnapshot), `lib/adminMessages/feedbackInbox.ts` (preview copy, both languages),
`lib/notificationDeliveries.ts` (suppression scoped to `feedback_user_*`; the inline claim now
reads the row and re-uses the drain's exact CAS), `docs/policy/email-notifications.md` (§0 v12
records the scope and the manual/privacy limitation), and the tests
`tests/feedbackReplyResendSurface.test.mjs` (new), `tests/server-contract/notification-delivery-queue.test.ts`
(new inline-vs-drain test, fake findUnique), `tests/server-contract/admin-feedback-resend-route.test.ts`
and the other fakes (claim support).

The author ran typecheck, eslint, security:regression, the static checks, test:unit (9347) and
test:server-contract (642): all pass.

Judge:
1. Each of the five: closed or not, with code evidence.
2. Did the fixes introduce anything new -- in particular, can the preview and the sent payload
   still diverge (second close, concurrent close, retention), does the inline claim leave a row
   stuck (claimed then crashed), and is the suppression scope right?
3. Anything still a release blocker.

Reply in Korean: 1) 판정 approve / approve_with_changes / reject 2) 항목별 확인 3) 새 결함(없으면 없다고 명시).
