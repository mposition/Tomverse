<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 소통 언어

사용자와의 모든 대화는 **한국어**로 합니다(설명, 보고, 질문, 확인 요청). 저장소에 남기는
것 — code identifier, 파일명, `data-testid`, test 제목, 코드 주석, commit message, PR
제목·본문, `locales/*.ts` 제품 문구 — 는 기존 영어 관례를 따릅니다. 이미 한국어로 쓰인
문서(`.github/audits/` 등)는 한국어로 이어 씁니다.

<!-- development-execution -->
## Frontier Pioneer: deliver working product first

Owner direction, 2026-10-19: Tomverse is an early startup with very few users and new ideas every day. Optimize development for fast, visible product learning. Spend the work on implementation and relevant verification; policy maintenance is supporting work, not the default deliverable.

- For a feature or bug fix, implement the smallest useful behavior within the user's requested scope and run the relevant test or check. Resolve routine technical choices yourself. Present working behavior early, then iterate; do not make a complete design, new policy document, or speculative future risk a prerequisite for ordinary reversible development.
- LLM first. Tomverse is an AI platform and shrinks development scope through LLM calls. Start semantic features (search, extraction, classification, copy, research, matching) with an existing LLM call, a focused prompt, structured output and existing tools; do not hand-write a crawler, parser, heuristic, classifier, scoring engine, planner or agent workflow that a model call can replace. When a model call replaces a hand-written path, delete that path; fewer lines of code is a goal in itself. Keep deterministic code at the irreversible boundaries (cost caps and ledgers, human approval before an external post, deletion, credentials and security) and put one cheap check on model output there. A model-based design does not itself authorize a new paid run.
- Read the code and binding instructions relevant to the next change. Reuse existing approvals and decisions. Do not start a fresh policy audit, rewrite approved contracts, or repeat independent reviews without a changed requirement, applicable rule, or unresolved finding.
- Human approval is needed only for irreversible actions: real money leaving (enabling a paid call, raising a spending ceiling), anything leaving Tomverse (external posts, sends, publication), deleting user data, credentials and security boundaries, and production merges and deployments. Every other design choice is the owner's call in chat, implemented and recorded in one line in the commit or PR, with no policy revision, version bump, plan or prior approval record. Writing code, prototypes, tests or isolated local migrations never needs prior policy approval. Put risky features behind a default-off switch and ship them rather than blocking them.
- Treat implementation, review, activation, merge, and deployment as separate steps. An approval needed for a later action blocks that action; it does not block already-authorized implementation and local verification. Draft release gates and missing production evidence do not by themselves mean a feature cannot be built.
- When an actual rule blocks a step, identify the exact rule, affected action, and concrete risk briefly. Continue another authorized, testable part of the requested work. Ask only for the missing decision, once; do not send preparation or routine engineering judgment back to the owner.
- Each finished diff gets its tests and one independent review. Review is not a planning loop: it runs once on the finished diff, not before code exists, and an accepted review is reused while the boundary it covered is unchanged.

Report implemented and tested behavior separately from documentation, review, merge, and deployment. A plan or review alone is not implementation progress. For an explicitly documentation-only or review-only request, deliver that requested artifact without inventing a code task.
<!-- /development-execution -->

# 먼저 만들고, 되돌릴 수 없는 것에만 게이트를 둡니다

운영자 지시(2026-10-19). 매일 새 아이디어를 **동작하는 기능으로 먼저** 보여 주는 것이 일입니다.

- **사람의 승인이 필요한 것은 되돌릴 수 없는 일뿐입니다**: 실제 돈이 나가는 것(유료 호출
  활성화, 상한 인상), 외부로 나가는 것(게시, 발송), 사용자 데이터 삭제, 자격증명과 보안
  경계, production 병합과 배포.
- 그 밖의 설계 결정(표, 데이터 형식, 상한값, 서비스 구성, 에이전트 내부 설계)은 운영자가
  대화에서 정하면 끝입니다. 구현하고 commit이나 PR에 한 줄로 남깁니다. 정책 개정, 정책
  버전 증가, 계획 문서, 사전 승인 기록을 요구하지 않습니다.
- 정책 문서가 적은 구현 세부가 바뀌었다면 그 서술이 낡은 것입니다. 같은 PR에서 고칩니다.
- 위험한 기능은 막지 말고 기본 꺼진 스위치 뒤에 두고 먼저 배포합니다.
- **LLM이 할 수 있는 일은 LLM 호출로 풉니다.** 검색, 추출, 분류, 문안, 조사, 매칭을 위해
  crawler·parser·휴리스틱을 짜지 않고, LLM 호출이 대신하는 손으로 짠 경로는 지웁니다.
  결정적 코드는 비용 상한과 원장, 외부 게시 전 사람 승인, 삭제, 자격증명·보안에만 둡니다.
- **게이트 테스트는 되돌릴 수 없는 영역만 실패로 둡니다**(과금·크레딧, migration·데이터
  삭제, 인증·비밀, 외부 게시, 감사 체인). 소스 위치 digest나 snapshot처럼 코드가 움직이면
  깨지는 고정값은 새로 만들지 않고, 기존 것은 개수·구조 검사로 대체해 나갑니다.
- 이 절과 아래 색인의 상세 규칙이 충돌하면 이 절이 우선합니다. 되돌릴 수 없는 것을 지키는
  계약(과금, 크레딧, 동의, 삭제, release blocker인 UI 계약)의 조건은 그대로입니다.

# 보고와 진행 관리

- **의미 있는 사이클의 완료 보고**: 전체 진행도 · 이번에 완료한 것 · 남은 핵심 기능을 짧은
  표로 보이고, 구현·검증·병합·배포를 분리합니다. 백분율은 근거가 있을 때만, 잠정치는
  "추정"으로 적습니다. 다음 권장 작업을 우선순위로 제안합니다. 추천은 착수·과금·병합·배포
  승인이 아닙니다.
- **긴 목표는 단계에 묶습니다**: 진행 중 발견한 버그는 다음 단계를 막을 때만 고치고, 아니면
  다음 권장 작업에 적습니다(보안 취약점·데이터 손실 위험은 바로 알림). 긴 목표에 속한 PR은
  본문에 `Goal-Step: <목표 ID>/<단계 ID>`(끝내는 PR은 뒤에 ` completes`) 줄을 하나 넣습니다.
- **명령을 줄 때는 실행 위치를 먼저 적습니다**: 어느 기계(로컬 PC / Railway shell / 웹
  대시보드), 어느 셸(기본 PowerShell), 어느 디렉터리, 먼저 필요한 것. production 자격증명
  필요 여부와 읽기·쓰기 여부를 밝히고, package.json script가 있으면 그 script를 줍니다.
  비밀값을 대화에 붙여 달라고 하지 않습니다.

# 브랜치와 PR

- `Auto PR to Develop`은 이름에 `to-develop` 경로 조각이 있는 브랜치에만 develop PR을 엽니다
  (`scripts/auto-pr-branch-policy.mjs`). 기능은 develop으로 보냅니다.
- main으로 가는 PR은 `develop`(release), `release/**`, `hotfix/**`(체크리스트 7.9.2)와 각자
  게이트가 있는 자동화 브랜치뿐입니다(`scripts/main-pr-source-policy.mjs`).
- workflow는 PR을 열기만 하고 병합하거나 auto-merge를 켜지 않습니다. 병합은 운영자의
  `npm run merge-train`이 합니다. 사람이 끈 스위치를 자동화가 다시 켜지 않습니다.
- PR은 draft로 시작하고 끝나면 ready로 바꿉니다(draft는 CI가 돌지 않습니다). develop은 dev
  환경에, Test는 `test` 브랜치에 배포됩니다(`docs/ops/dev-test-lanes.md`).

# 독립 검토와 모델 역할

- 독립 검토는 위 Frontier 절대로 끝난 diff마다 한 번 받고, 그 검토가 덮은 경계가 바뀌지 않는 동안 다시 받지 않습니다.
  검토 서버를 씁니다: commit 후 `node "$HOME/bin/review.mjs" submit --author <자기 이름> --scope "<요약>"`,
  `wait <jobId>`를 종료 코드가 3이 아닐 때까지 반복합니다. 0 accept, 1 reject(고치고 새로 submit),
  2 unknown(다시 보내지 않고 사람에게 알림). 자세한 동작은 `tools/review-orchestrator/README.md`.
  검토 결과는 신호이지 병합·배포 승인이 아닙니다.
- 모델 역할(`.claude/agents/*.md`, `.codex/agents/*.toml`): `contract`는 되돌릴 수 없는 변경(가격·
  크레딧, `prisma/migrations/**`, `Conversation.productKey`, UI 계약 파일, 프로모션·가격 카탈로그·
  플랜 변경·이메일 발송), `impl`은 그 밖의 코드, `chore`는 판단이 필요 없는 기계적 작업입니다.
  역할이 달라도 PR Fast Gate의 통과 기준은 같습니다.

# 영역별 규칙 색인

해당 영역을 **고칠 때만** 그 문서를 읽습니다. 영역별 상세 규칙 원문은
`docs/agents/agents-reference.md`에 있습니다(같은 제목의 절).

| 영역 | 먼저 읽을 문서 |
|---|---|
| Accent colour roles | 원문 절 |
| 다음 작업 고를 때 — 열린 이슈를 그대로 믿지 않습니다 | 원문 절 |
| 검증 범위는 되돌릴 수 없는 것에 비례합니다 | `docs/ops/assistant-profile-staging-checklist.md` |
| 릴리스 게이트에서 일감을 고를 때 | `docs/policy/goodwill-credit-grants.md` |
| Credit entitlement vs operational guardrail | `docs/policy/credit-and-cost-limits.md`, `docs/policy/perplexity-sonar-credit-price-hold.md`, `docs/policy/anthropic-prompt-caching.md` |
| Conversation.productKey | `docs/policy/conversation-product-key.md` |
| Chat concurrency and identity namespace | `docs/policy/chat-concurrency-and-identity.md` |
| Code managed-path credits, guardrail and concurrency | `docs/policy/code-task-cost-guardrails.md`, `docs/policy/code-concurrency.md`, `docs/policy/credit-and-cost-limits.md` |
| 프로모션 할인과 통화 | `docs/policy/promotion-discount-currency.md` |
| 가격 카탈로그 default는 fixture가 아닙니다 | `docs/policy/promotion-discount-currency.md` |
| Plan change (Pro <-> Max) | `docs/policy/plan-change.md` |
| Default model (GPT 6 Luna) | `docs/policy/default-model-luna-migration.md`, `docs/policy/credit-and-cost-limits.md`, `docs/ui-contracts/account-model-settings.md` |
| 공유 package와 framework 순수성 | `docs/policy/shared-packages.md` |
| 채팅 첨부 형식과 압축파일 | `docs/policy/chat-attachment-formats.md` |
| 이미지 생성 (v2: 멀티 모델 비교) | `docs/policy/image-generation.md` |
| 사용자 입력 첨부파일 | `docs/policy/user-attachment-persistence.md` |
| AI 생성 파일 (Generated Artifact) | `docs/policy/generated-artifacts.md` |
| Trace 기반 오류 신고 자동화 | `docs/policy/trace-feedback-automation.md` |
| 이메일 알림 | `docs/policy/email-notifications.md`, `docs/ops/email-sending-domains.md` |
| 마케팅 자동화 | `docs/policy/marketing-automation.md` |
| 엔지니어링 Agent | `docs/policy/engineering-agent.md` |
| AMUX Decision Maker | `docs/policy/amux-decision-maker.md`, `docs/ops/amux/decision-maker-s0.md` |
| AMUX 카드 표시 번호 | `docs/policy/amux-card-display-key.md`, `docs/policy/amux-intake.md` |
| AI Review (교차검토) 품질과 M5 | `docs/policy/ai-review-m5-quality-contract.md`, `docs/ui-contracts/ai-review-evidence-chain.md` |
| Mobile chat composer invariant | `docs/ui-contracts/mobile-chat-composer.md` |
| Mobile sidebar drawer invariant | `docs/ui-contracts/mobile-sidebar-drawer.md` |
| Comparison action rail invariant | `docs/ui-contracts/comparison-action-rail.md` |
| Typography and font system invariant | `docs/ui-contracts/typography.md` |
| Image generation workspace invariant | `docs/ui-contracts/image-generation-workspace.md` |
| Settings navigation invariant | `docs/ui-contracts/settings-navigation.md` |
| Admin Console information architecture invariant | `docs/ui-contracts/admin-console-ia.md` |
| Auto model selection invariant | `docs/ui-contracts/auto-model-selection.md`, `docs/ui-contracts/chat-product-switcher.md`, `docs/policy/chat-refiner-initial-auto-release-v1.md` |
| Prompt Refiner suggestion invariant | `docs/ui-contracts/prompt-refiner-suggestion.md`, `docs/ui-contracts/chat-e04-staging-fixture.md`, `docs/policy/prompt-refiner-observability.md` |
| Chat starter catalogue invariant | `docs/ui-contracts/chat-starter-catalog.md` |

`docs/ui-contracts/`의 계약(모바일 composer, drawer, 비교 action rail, typography, 이미지 생성 workspace, 설정 navigation, Admin IA의 redirect 규칙, Auto 선택, Prompt Refiner, starter catalogue)은 위반이 release blocker입니다. 해당 컴포넌트를 고칠 때 그 문서의 회귀 테스트를 함께 돌립니다.

## 기계 색인 (도구가 읽습니다)

engineering agent의 권한·정책 테스트 판정(`lib/agentAuthorityFiles.ts`, `lib/agentPushPolicy.ts`)이 이 목록을 읽습니다. 항목을 지우면 그 판정이 바뀌므로, 지우기 전에 해당 코드와 테스트를 함께 확인합니다.

- 계약 상수: `ACTIVE_SUBSCRIPTION_EXISTS`, `ADMIN_ALERT_EMAIL`, `AMUX_DM_DIGEST_KEYS`, `AMUX_DM_RELAY_TOKEN_SHA256`, `ARTIFACT_FORMAT_TABLE`, `ARTIFACT_LIMITS`, `ARTIFACT_TOOL_CAPABILITIES`, `ATTACHMENT_ENCRYPTED`, `AX001`, `CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED`, `CHAT_ATTACHMENT_FORMATS`, `CHAT_GUEST_CONCURRENT`, `CHAT_IP_CONCURRENCY_EXCEEDED`, `CHAT_IP_CONCURRENT`, `CHAT_STARTER_KILL_SWITCH`, `CHAT_STARTER_MAX_VISIBLE`, `CONVERSATION_FORBIDDEN`, `CONVERSATION_PRODUCT_KEYS`, `COPYFILE_EXCL`, `CROSS_LOCK_ORDER`, `DEFAULT_BILLING_PRICE_CATALOG`, `DEFAULT_MODEL_ID`, `DEPLOY_EXCLUDED_PREFIXES`, `DM_INSTRUCTION_SHA256`, `DM_REQUEST_POLICY_VERSION`, `DM_SEND_OPTION_EFFECTS`, `EMPTY_RESPONSE`, `FEEDBACK_AUTOFIX_ENABLED`, `FEEDBACK_AUTOFIX_SHADOW_ENABLED`, `GATE_EVIDENCE`, `GITHUB_TOKEN`, `GUARDED_FILES`, `GUEST_BRAND_TRIO_MODEL_IDS`, `GUEST_DEFAULT_MODEL_ID`, `IMAGE_INLINE_MODEL_DISCOVERY_LIMIT`, `IMAGE_MODEL_SELECTION_INVALID`, `ISSUE_PROBES`, `KNOWN_ROLES`, `LOCKED_EMAIL_PURPOSES`, `MARKETING_EMAIL_FROM`, `MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL`, `NULL`, `OPERATIONAL_COST_GUARDRAIL_TRIGGERED`, `OPS_ALERT_EMAIL`, `OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS`, `PENDING_VERIFIED_PRICE_REGISTER`, `PLAN_CHANGE_NOT_SUPPORTED`, `PRODUCT_KEY_READ_MODE`, `PROMOTION_CURRENCY_NOT_SUPPORTED`, `PROVIDER_BUDGET_EXHAUSTED`, `PUBLIC_MESSAGE_ATTACHMENT_SELECT`, `REFUSED_ARTIFACT_EXTENSIONS`, `RESERVATION_ONLY_RECONCILIATION_MODEL_IDS`, `REVIEWED_MODULE_SHA256`, `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`, `TOMVERSE_AMUX_DM_RELAY_LOCAL_TOKEN`, `TOMVERSE_AMUX_DM_ROUTING`, `UNDERPOWERED`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`
- 정책 테스트와 fixture: tests/support/amuxDmBrokerFixture.mjs, tests/support/amuxDmLauncherFixture.mjs, tests/support/compoundFile.mjs, tests/adminNavigation.test.mjs, tests/adminReauthenticationCta.test.mjs, tests/agentAuthorityFiles.test.mjs, tests/agentControlPlaneSlice.test.mjs, tests/agentCredentialReachability.test.mjs, tests/agentPushPolicy.test.mjs, tests/amuxCardDisplayKeyCore.test.mjs, tests/amuxCardDisplayKeyWriters.test.mjs, tests/amuxDecisionMakerAdminList.test.mjs, tests/amuxDecisionMakerBody.test.mjs, tests/amuxDecisionMakerBridgeRelay.test.mjs, tests/amuxDecisionMakerBroker.test.mjs, tests/amuxDecisionMakerBrokerCore.test.mjs, tests/amuxDecisionMakerCardFields.test.mjs, tests/amuxDecisionMakerCore.test.mjs, tests/amuxDecisionMakerDashboardAnswer.test.mjs, tests/amuxDecisionMakerDelivery.test.mjs, tests/amuxDecisionMakerInstall.test.mjs, tests/amuxDecisionMakerInstallShell.test.mjs, tests/amuxDecisionMakerJudgment.test.mjs, tests/amuxDecisionMakerLauncherCore.test.mjs, tests/amuxDecisionMakerLauncherFs.test.mjs, tests/amuxDecisionMakerLauncherProcess.test.mjs, tests/amuxDecisionMakerReleaseOut.test.mjs, tests/amuxDecisionMakerRequest.test.mjs, tests/amuxDecisionMakerRetentionSweep.test.mjs, tests/amuxDecisionMakerS0Isolation.test.mjs, tests/amuxDecisionMakerSwitch.test.mjs, tests/amuxDmRelayUnit.test.mjs, tests/autoPrAutoMergeArming.test.mjs, tests/autoPrBranchPolicy.test.mjs, tests/autoRoutingUi.test.mjs, tests/billingPriceCatalogDefaults.test.mjs, tests/chatStarterCatalog.test.mjs, tests/client/amuxDecisionMakerJudgmentRender.test.tsx, tests/client/amuxDecisionMakerReportRender.test.tsx, tests/client/amuxDecisionMakerRequestDetailRender.test.tsx, tests/client/amuxDecisionMakerRequestsRender.test.tsx, tests/client/amuxDecisionMakerSwitchRender.test.tsx, tests/client/marketingWebhookProductionRender.test.tsx, tests/client/promptRefinerSuggestionRender.test.tsx, tests/comparisonReadiness.test.mjs, tests/draftPrCiSkip.test.mjs, tests/e2e/chat-starter-catalog.spec.ts, tests/e2e/comparison-action-rail.spec.ts, tests/e2e/font-system.spec.ts, tests/e2e/image-generation-workspace.spec.ts, tests/e2e/mobile-short-viewport-drawer.spec.ts, tests/e2e/prompt-refiner-chat-input.spec.ts, tests/e2e/settings-information-architecture.spec.ts, tests/engineeringAgentCapability.test.mjs, tests/engineeringAgentCore.test.mjs, tests/engineeringAgentModelCall.test.mjs, tests/engineeringAgentRegistrationGuard.test.mjs, tests/engineeringAgentTreeVerify.test.mjs, tests/generatedArtifactToolPolicy.test.mjs, tests/integration/amux-card-display-key.db.test.ts, tests/integration/amux-decision-maker-body.db.test.ts, tests/integration/amux-decision-maker-delivery.db.test.ts, tests/integration/amux-decision-maker-judgment.db.test.ts, tests/integration/amux-decision-maker-request.db.test.ts, tests/integration/amux-decision-maker-switch.db.test.ts, tests/integration/conversation-product-key.db.test.ts, tests/integration/marketing-automation-schema.db.test.ts, tests/integration/marketing-competitor-registry.db.test.ts, tests/integration/marketing-competitor-routes.db.test.ts, tests/integration/marketing-draft-intake.db.test.ts, tests/integration/marketing-fact-row-hold.db.test.ts, tests/integration/marketing-generator-context.db.test.ts, tests/integration/marketing-intel-reports.db.test.ts, tests/integration/marketing-llm-budget-route.db.test.ts, tests/integration/marketing-llm-budget-store.db.test.ts, tests/integration/marketing-llm-call-ledger.db.test.ts, tests/integration/marketing-llm-expiry.db.test.ts, tests/integration/marketing-llm-hold-retention.db.test.ts, tests/integration/marketing-retention.db.test.ts, tests/mainPrSourcePolicy.test.mjs, tests/marketingA3Core.test.mjs, tests/marketingA3Cycle.test.mjs, tests/marketingCompetitorCore.test.mjs, tests/marketingDraftIntakeCore.test.mjs, tests/marketingFactResolution.test.mjs, tests/marketingGeneratorCycle.test.mjs, tests/marketingGeneratorDraftingCore.test.mjs, tests/marketingIntelReportCore.test.mjs, tests/marketingLlmBudgetCore.test.mjs, tests/marketingLlmClientCore.test.mjs, tests/marketingModelReferences.test.mjs, tests/marketingPriceAlert.test.mjs, tests/marketingPublisherBoundedCallers.test.mjs, tests/marketingPublisherStatementBudget.test.ts, tests/marketingRetentionCompaction.test.mjs, tests/marketingS2b1Store.test.mjs, tests/marketingWebhookApplyTransition.test.mjs, tests/marketingWebhookProductionConfig.test.ts, tests/marketingWebhookProductionConfigStore.test.ts, tests/marketingWebhookRecordSignability.test.mjs, tests/promptRefinerShadowAdmissionCore.test.mjs, tests/promptRefinerSuggestion.test.mjs, tests/server-contract/admin-amux-decision-maker-judgments-route.test.ts, tests/server-contract/admin-amux-decision-maker-switches-route-budget.test.ts, tests/server-contract/admin-amux-decision-maker-switches-route.test.ts, tests/server-contract/amux-decision-maker-broker-routes-budget.test.ts, tests/server-contract/amux-decision-maker-broker-routes.test.ts, tests/server-contract/amux-decision-maker-delivery-routes.test.ts, tests/server-contract/amux-decision-maker-routing-route-budget.test.ts, tests/server-contract/amux-decision-maker-routing-route.test.ts, tests/settingsNavigation.test.mjs, tests/typographyPolicy.test.mjs, tests/userSettingsDefaultModelWriters.test.mjs
