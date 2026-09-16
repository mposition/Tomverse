# Independent design review: support reply delivery (Tomverse)

You are an independent reviewer. Read-only; modify nothing. Repository: the current working
directory (git worktree of origin/develop@705b65ad).

Incident: on 2026-09-15 an operator resolved a support report, typed a reply to the reporter in
the completion dialog, pressed confirm, and the reporter received nothing.

Read, in order:
1. `.github/audits/support-reply-delivery-truth-design-2026-09-16.md` (the analysis and proposed design, Korean)
2. `docs/policy/email-notifications.md` — §3 (classification table and definitions), the consent
   rules, §13.3 (suppression), the sender-identity and purpose tables, and the revision history
3. The code the design cites: `components/admin/FeedbackInboxPanel.tsx`,
   `app/api/admin/feedback/[feedbackId]/route.ts`, `lib/notificationDeliveries.ts`,
   `lib/notificationRetryCore.ts`, `lib/feedbackLifecycleCore.ts`, `lib/feedbackLifecycleEmails.ts`,
   `lib/emailSuppression.ts`, `app/api/feedback/route.ts`, `components/chat/FeedbackButton.tsx`,
   `components/marketing/SupportPageContent.tsx`, `lib/adminConsoleData.ts`
4. `AGENTS.md` sections "이메일 알림" and "Admin Console information architecture invariant"

Judge:
1. Is the diagnosis right and complete? Name any path by which a typed reply can still be lost
   that the analysis (§1, §2) misses.
2. Is treating the *completed* reply as transactional (no consent needed when an address is on
   the report) correct under the policy as written, for each of: a guest-supplied address, a
   signed-in account address, an address scrubbed by account deletion, an address whose owner
   later withdrew consent, and an address under local suppression? Does anything in the policy
   (unsubscribe, purpose, sender identity, jurisdiction, double opt-in work in v9-v11) contradict it?
3. §4.2's fix for the "already announced but never sent" trap: does updating a lifecycle event
   that never produced a delivery break the immutability contract that the retry queue depends on
   (identical payload per attempt)? Is there a race (two concurrent PATCHes, or a drain in flight)
   that makes it unsafe? Propose a safer alternative if so.
4. §4.3 suppression check, §4.4 operator visibility, §4.5 form changes (always showing a guest
   address field): any policy, privacy or contract problem, or a better shape?
5. Anything here that is a release blocker under AGENTS.md "검증 범위는 되돌릴 수 없는 것에 비례합니다".

Reply in Korean:
1) 판정: approve / approve_with_changes / reject
2) 진단 정확성 (빠진 경로가 있으면 구체적 시퀀스)
3) §6의 네 질문에 각각 답
4) 발견 목록: severity(blocker/major/minor), 근거 파일:줄, 확인 방법, 권장 수정
