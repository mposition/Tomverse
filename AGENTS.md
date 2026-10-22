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
- Human approval is needed only for irreversible actions: real money leaving (enabling a paid call, raising a spending ceiling), anything leaving Tomverse (external posts, sends, publication), deleting user data, credentials and security boundaries, production merges and deployments, and giving an autonomous agent a new permission (for example unattended merge, post or spend; a one-line approval in chat is enough, with no policy revision). Every other design choice is the owner's call in chat, implemented and recorded in one line in the commit or PR, with no policy revision, version bump, plan or prior approval record. Writing code, prototypes, tests or isolated local migrations never needs prior policy approval. Put risky features behind a default-off switch and ship them rather than blocking them.
- Treat implementation, review, activation, merge, and deployment as separate steps. An approval needed for a later action blocks that action; it does not block already-authorized implementation and local verification. Draft release gates and missing production evidence do not by themselves mean a feature cannot be built.
- When an actual rule blocks a step, identify the exact rule, affected action, and concrete risk briefly. Continue another authorized, testable part of the requested work. Ask only for the missing decision, once; do not send preparation or routine engineering judgment back to the owner.
- Each finished diff gets its tests. Only a diff that touches an irreversible area (the approval list above, plus pricing, credits, migrations and the audit chain) also gets one independent review; every other diff is done when its tests and local checks pass. Review is not a planning loop: it runs once on the finished diff, not before code exists, and an accepted review is reused while the boundary it covered is unchanged.

Report implemented and tested behavior separately from documentation, review, merge, and deployment. A plan or review alone is not implementation progress. For an explicitly documentation-only or review-only request, deliver that requested artifact without inventing a code task.
<!-- /development-execution -->

# 먼저 만들고, 되돌릴 수 없는 것에만 게이트를 둡니다

위 Frontier 절이 정본입니다(승인이 필요한 일의 목록, LLM 우선, 설계 결정은 대화에서, 기본
꺼진 스위치). 여기에는 그 절에 없는 것만 적습니다.

- 정책 문서가 적은 구현 세부가 바뀌었다면 그 서술이 낡은 것입니다. 같은 PR에서 고칩니다.
- **게이트 테스트는 되돌릴 수 없는 영역만 실패로 둡니다**(과금·크레딧, migration·데이터
  삭제, 인증·비밀, 외부 게시, 감사 체인). 소스 위치 digest나 snapshot처럼 코드가 움직이면
  깨지는 고정값은 새로 만들지 않고, 기존 것은 개수·구조 검사로 대체해 나갑니다.
- 이 절과 아래 색인의 상세 규칙이 충돌하면 이 절이 우선합니다. 되돌릴 수 없는 것을 지키는
  계약(과금, 크레딧, 동의, 삭제, Admin IA의 redirect 규칙)의 조건은 그대로입니다.

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
- dev에서 확인을 마친 develop PR의 release PR은 직접 열지 않습니다. 운영자가 Admin › Agent digests ›
  QA·릴리스의 "다음 열차"에서 실을 PR을 고르고, QA·릴리스 에이전트의 릴리스 열차가 정해진 시각(AEST
  08·11·14·17·20시)에 그 PR들로 `release/train-*` main PR 하나를 엽니다(`docs/policy/qa-release-agent.md`
  8절 12항). `main:next` 라벨은 더 읽지 않습니다. 급한 수정은 `hotfix/**`입니다.
- workflow는 PR을 열기만 하고 병합하거나 auto-merge를 켜지 않습니다. 병합은 운영자의
  `npm run merge-train`이 합니다. 사람이 끈 스위치를 자동화가 다시 켜지 않습니다.
- PR은 draft로 시작하고 끝나면 ready로 바꿉니다(draft는 CI가 돌지 않습니다). develop은 dev
  환경에, Test는 `test` 브랜치에 배포됩니다(`docs/ops/dev-test-lanes.md`).
- **CI 입장 관리**: head 커밋의 `CI admission` 상태가 pending인 PR은 대기열에서 차례를 기다리는 중입니다.
  다시 ready로 바꾸거나 CI를 re-run하지 않습니다 — 칸이 나면 자동으로 ready가 되고, 순서는 운영자가
  Admin › Agent digests에서 정합니다. push 직후 같은 순간에 ready로 바꾸지 말고, push의 CI 실행이 생긴 뒤에
  바꿉니다(두 이벤트가 겹치면 draft 시점의 skipped 실행만 남을 수 있습니다).

# 독립 검토와 모델 역할

- 독립 검토는 되돌릴 수 없는 영역(위 Frontier 절의 승인 목록과 가격·크레딧·migration·감사 체인)을 건드린 diff만
  한 번 받고, 그 검토가 덮은 경계가 바뀌지 않는 동안 다시 받지 않습니다. 그 밖의 diff는 테스트와 로컬 검사로 끝납니다.
  검토 서버를 씁니다: commit 후 `node "$HOME/bin/review.mjs" submit --author <자기 이름> --scope "<요약>"`,
  `wait <jobId>`를 종료 코드가 3이 아닐 때까지 반복합니다. 0 accept, 1 reject(고치고 새로 submit),
  2 unknown(다시 보내지 않고 사람에게 알림). 자세한 동작은 `tools/review-orchestrator/README.md`.
  검토 결과는 신호이지 병합·배포 승인이 아닙니다.
- 모델 역할(`.claude/agents/*.md`, `.codex/agents/*.toml`): `contract`는 되돌릴 수 없는 변경(가격·
  크레딧, `prisma/migrations/**`, `Conversation.productKey`, 프로모션·가격 카탈로그·플랜 변경·
  이메일 발송), `impl`은 그 밖의 코드(UI 계약 파일 포함 — 그 계약의 회귀 테스트를 함께 돌립니다),
  `chore`는 판단이 필요 없는 기계적 작업입니다.
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
| Review Studio and Classic workspace | `docs/ui-contracts/review-studio.md` |
| Settings navigation invariant | `docs/ui-contracts/settings-navigation.md` |
| Admin Console information architecture invariant | `docs/ui-contracts/admin-console-ia.md` |
| Auto model selection invariant | `docs/ui-contracts/auto-model-selection.md`, `docs/ui-contracts/chat-product-switcher.md`, `docs/policy/chat-refiner-initial-auto-release-v1.md` |
| Prompt Refiner suggestion invariant | `docs/ui-contracts/prompt-refiner-suggestion.md`, `docs/ui-contracts/chat-e04-staging-fixture.md`, `docs/policy/prompt-refiner-observability.md` |
| Chat starter catalogue invariant | `docs/ui-contracts/chat-starter-catalog.md` |

`docs/ui-contracts/`의 계약(모바일 composer, drawer, 비교 action rail, typography, 이미지 생성 workspace, 설정 navigation, Admin IA, Auto 선택, Prompt Refiner, starter catalogue)은 고쳐서 배포하면 되돌릴 수 있으므로 release blocker가 아닙니다. 해당 컴포넌트를 고칠 때 그 문서의 회귀 테스트를 함께 돌립니다. **예외는 Admin IA의 redirect 규칙 하나**입니다 — 은퇴한 `/admin/*` URL의 redirect를 지우면 북마크·runbook·감사 기록의 링크가 되돌릴 수 없이 끊기므로 위반은 release blocker입니다. 각 계약 문서의 "release blocker" 문장은 이 결정이 우선합니다(운영자 결정 2026-10-19).

engineering agent 판정이 읽는 계약 상수·정책 테스트 목록은 `docs/agents/machine-index.md`에 있습니다(도구용, 읽지 않아도 됩니다).
