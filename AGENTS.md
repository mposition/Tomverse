<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 소통 언어

이 저장소에서 작업할 때는 **사용자와의 모든 대화를 한국어로** 진행합니다.
설명, 계획, 작업 결과 보고, 질문, 확인 요청 모두 해당됩니다. 사용자가 영어로
질문하더라도 별도 요청이 없으면 한국어로 답합니다.

한국어로 쓰지 않는 것 — 저장소에 이미 자리 잡은 관례를 따릅니다.

- code identifier, 파일명, `data-testid`, test 제목
- 소스 코드 주석
- commit message, PR 제목과 본문
- 사용자에게 보이는 제품 문구(`locales/*.ts`가 언어별로 관리)

즉, **사람에게 말할 때는 한국어, 저장소에 남기는 코드·이력은 기존 영어 관례**
입니다. `.github/audits/` 아래 감사·작업 보고서처럼 이미 한국어로 작성된
문서는 계속 한국어로 씁니다.

# Accent colour roles

UI-012에서 승인된 정책(B안)입니다. accent 색은 **hue가 아니라 역할로** 지정합니다.
`app/globals.css`에 역할별 token이 정의돼 있고, `npm run check:accent-tokens`가
아래 규칙을 강제합니다. PR Fast Gate의 static 단계에서 실행됩니다.

## 역할과 token

| 역할 | token 접두사 | 현재 palette |
|---|---|---|
| AI Review | `accent-ai-review-start\|mid\|end-*`, `tomverse-accent-*`, `tomverse-review-*` | cyan → blue → purple |
| Deep Research | `accent-deep-research-*` | violet |
| 이미지 생성 | `accent-image-*` | fuchsia |
| AI 생성 파일 | `accent-generated-artifact-*` | emerald |
| Web Search | `accent-web-search-*` | sky |
| Model Catalogue | `accent-model-catalogue-*` | purple |
| Max plan | `accent-plan-max-*` | purple |
| Promotion | `accent-promotion-*` | emerald |
| Account identity | `accent-account-*` | teal |
| Account memory 제어 | `accent-account-memory-*` | teal |
| 성공·검증 상태 | `status-success-*` | emerald |

## 규칙

1. **`cyan → blue → purple` gradient 전체 조합은 AI Review 전용으로 예약**합니다.
   다른 기능은 이 조합을 쓰지 않습니다. `accent-ai-review-*` token을 AI Review
   외 component에서 쓰면 검사에서 실패합니다.
2. **역할이 다르면 값이 같아도 token을 분리**합니다. `accent-promotion`과
   `status-success`는 오늘 둘 다 emerald지만 별개 결정이며, 한쪽을 바꿔도
   다른 쪽이 따라 움직여서는 안 됩니다. `accent-model-catalogue`와
   `accent-plan-max`(둘 다 purple), `accent-generated-artifact`(세 번째
   emerald)도 같습니다.
3. **guarded 파일 안에서는 raw accent utility 금지.** `bg-violet-500`,
   `text-emerald-600` 같은 직접 지정 대신 역할 token을 씁니다. 대상 hue는
   `cyan`, `emerald`, `fuchsia`, `purple`, `sky`, `teal`, `violet`입니다.
   `blue`·`zinc`(기본 인상)와 `red`·`amber`(오류·크레딧 상태)는 대상이 아닙니다.
4. **신규 역할은 token부터.** `app/globals.css`에 역할 namespace를 추가하고
   `scripts/check-accent-tokens.mjs`의 `KNOWN_ROLES`에 등록한 뒤 사용합니다.
   token 없는 역할 utility는 검사에서 실패합니다.
5. **guarded 목록은 역할을 token으로 옮긴 파일만** 포함합니다
   (`scripts/check-accent-tokens.mjs`의 `GUARDED_FILES`). admin console과
   일반 status 색은 아직 대상이 아니며, design decision 없이 범위를 넓히지
   않습니다.

예외가 필요하면 이 문서에 근거를 적고 나서 추가합니다.

# 브랜치 이름이 자동화 권한을 정합니다

**브랜치의 목적이 아니라 병합 대상이 자동화 권한을 결정합니다.** `claude/`,
`codex/`, `docs/`, `fix/`는 누가 왜 만들었는지를 말할 뿐 어디로 가는지를 말하지
않고, push 이벤트는 그것을 알아낼 방법이 없습니다 — 브랜치는 PR보다 먼저
존재합니다.

`Auto PR to Develop`은 이름에 **`to-develop` 경로 조각이 있는 브랜치에만**
develop PR을 만듭니다. 판정은 `scripts/auto-pr-branch-policy.mjs`가 하고
`tests/autoPrBranchPolicy.test.mjs`가 허용·거부 양쪽을 고정합니다.

```
claude/to-develop/image-generation   자동 PR
codex/to-develop/fix-picker          자동 PR
docs/to-develop/release-policy       자동 PR
to-develop/ime-submit                자동 PR

claude/to-main/dependabot-hold       없음 — main PR은 손으로 엽니다
release/**, hotfix/**                없음 — production에 닿습니다
dependabot/**, autofix/**,
feedback-autofix/**                  없음 — 각자 자기 PR을 엽니다
visual-baseline/**                   없음 — 골든 재기록은 사람이 diff를 보고 병합합니다
그 밖의 모든 이름                     없음
```

`to-develop`은 **경로 조각**이지 부분 문자열이 아닙니다.
`feature/to-development-notes`는 개발 노트에 관한 브랜치이고
`chore/to-develop-later`는 누군가의 약칭입니다. 둘 다 대상을 말한 것이
아닙니다.

이전 규칙은 `branches-ignore`에 예외를 쌓는 방식이었고, 그 목록은 **이미 한 번
당해 본 namespace만** 담을 수 있습니다. 2026-08-15에 `.github/dependabot.yml`
변경(기본 브랜치에서만 읽히는 파일)을 담은 브랜치가 main용으로 push되자 develop
PR #573이 먼저 열렸습니다 — 한 브랜치에 PR 둘, 그중 하나는 변경이 아무 효과도
없는 base였습니다. opt-in에서 모르는 브랜치는 **PR 없음**이고 비용은 `gh pr
create` 한 번이지만, opt-out에서는 **잘못된 base의 PR에 auto-merge까지 켜진
상태**입니다.

기존에 열린 PR과 브랜치는 그대로 둡니다. 새 규칙은 이 변경 이후 만드는
브랜치부터 적용합니다.

# 다음 작업 고를 때 — 열린 이슈를 그대로 믿지 않습니다

이슈가 **열려 있다**는 것과 **아직 안 됐다**는 것은 다른 사실입니다. 이 저장소는
수정을 먼저 넣고 이슈를 나중에 닫으므로, 열린 목록을 그대로 후보로 쓰면 이미
끝난 일을 다시 제안하게 됩니다. 2026-08-12에 열린 이슈 6건이 전부 이미
해결된 상태였습니다.

작업 후보를 고르기 전에 실행합니다.

```
npm run report:issue-backlog -- --issues-file <열린 이슈 JSON>
```

`GITHUB_TOKEN`이 있으면 `--issues-file` 없이 API에서 직접 읽습니다.

- 판정 근거는 `scripts/report-issue-backlog-core.mjs`에 있습니다. 세 신호를
  각각 따로 보고하며 하나의 boolean으로 합치지 않습니다 — `pricing`(profile
  존재 + pending register 이탈), `probe`(이슈별 손으로 쓴 완료 조건),
  `commits`(이슈 번호를 언급한 commit, 셋 중 가장 약한 신호).
- **내용 검사는 release branch마다 따로** 합니다. `develop`과 `main`의 간격은
  이슈마다 다르게 걸치므로, 한쪽만 읽고 "고쳐졌다"고 답하면 반대쪽에 대해
  틀립니다.
- 착수해도 되는 것은 `candidates`(= `open_work`)뿐입니다.
  `landed_but_unverified`는 사람이 확인할 대상이지 시작할 작업이 아닙니다.
- `blocked`는 **열려 있고 끝나지도 않았지만 시작해서는 안 되는** 것입니다.
  probe의 `blockedOn`이 무엇을 기다리는지 이름을 대며, 대개 저장소가 답할 수 없는
  사실(운영 DB, 결제 제공자 상태)입니다. 그것을 모른 채 시작하면 멈추거나
  추측하게 되고, 추측이 곧 결과가 됩니다 — 예: 어떤 프로모션이 살아 있는지 모르는
  채 생성을 막으면 진행 중인 캠페인이 끊깁니다. 보고서가 `blocked on`으로 무엇을
  읽어야 하는지 알려 주므로, 그것부터 구하고 나서 착수합니다.
- 새 이슈의 완료 조건이 generic 신호에 안 잡히면 `ISSUE_PROBES`에 추가합니다.
  증명하지 못하는 부분은 `remainder`에 적습니다 — 그래야 부분 완료가 완료로
  보고되지 않습니다.
- 이 script는 보고 전용이라 gate가 아닙니다. 단 하나의 비정상 종료는
  `lib/modelPricing.ts` 해석이 실제 module과 어긋날 때이며, 그때는 출력 전체를
  믿을 수 없다는 뜻입니다.

# 검증 범위는 되돌릴 수 없는 것에 비례합니다

**이 저장소는 1인 조직입니다.** staging 검증의 모든 항목을 매 회차 실행하는
것은 감당할 수 있는 일이 아니고, 그렇게 요구하면 검증 자체가 미뤄집니다.
그래서 범위를 정하는 규칙을 여기에 둡니다.

**항목을 릴리스 차단으로 올리는 근거는 단 하나 — 틀렸을 때 되돌릴 수 없는가.**

- **되돌릴 수 없음** = 이력 테이블이 없어 원상 복구가 불가능하거나(예:
  `Conversation.selectedModels`, pin된 profile version), 유출처럼 회수가
  성립하지 않거나, 사용자 데이터가 사라지는 것.
- **되돌릴 수 있음** = 고쳐서 배포하면 끝나는 것. 라벨·문구·breadcrumb·탭
  배치·편의 기능이 여기 속합니다. 잘못된 과금도 여기입니다 — 환급됩니다.

"중요해 보인다", "완성도가 떨어진다"는 차단 근거가 아닙니다. **무엇이 복구
불가인지 한 줄로 적을 수 없으면 차단이 아닙니다.**

## 에이전트가 검증을 설계할 때

1. 체크리스트를 통째로 요구하지 않습니다. **차단 항목부터 제시하고, 나머지는
   선택지로 알립니다.** 총 항목 수와 유료 turn 수를 먼저 말합니다.
2. 유료 항목은 **무엇을 판별하는지** 한 줄로 설명합니다. 설명할 수 없는 유료
   turn은 제안하지 않습니다.
3. 사람이 범위를 줄이면 그대로 따릅니다. 건너뛴 구획은 기록의 `미기록`이며,
   판정란에 **무엇을 왜 건너뛰었는지** 적습니다 — 그러면 그 기록은 비어 있는
   것이 아니라 범위를 밝힌 것이 됩니다.
4. 차단·비차단 갈래는 각 체크리스트 안에 적습니다. 예:
   `docs/ops/assistant-profile-staging-checklist.md`의
   "무엇이 flag를 막고, 무엇이 막지 않는가".

## 검증을 건너뛴다는 뜻이 아닙니다

차단 항목은 줄이지 않습니다. 줄이는 것은 **차단이 아닌 항목을 지금 할지
나중에 할지**뿐입니다. flag를 켠 뒤에 발견된 라벨 오류는 고치면 되지만,
덮어써진 대화 설정은 고칠 수 없습니다.

# 릴리스 게이트에서 일감을 고를 때

`docs/release-gates/tomverse-chat-v1.yaml`의 40개 게이트가 전부 `status: pending`
입니다. **이는 정상이며 고칠 대상이 아닙니다** — registry는 `metadata.status:
draft`이고 `governance.implementationStatus: planned`이며, 검증기는 `--release`
에서만 승인과 증거를 강제합니다(PR Fast Gate는 `--release` 없이 실행).

다만 draft 상태에서는 "pending"이라는 한 단어가 서로 다른 세 상황을 덮습니다.
구분해서 보려면 실행합니다.

```
npm run report:release-gate-evidence
npm run report:release-gate-evidence -- --condition memory-release-b-enabled=false
```

- 판정 근거는 `scripts/report-release-gate-evidence-core.mjs`의 `GATE_EVIDENCE`
  이며 **손으로 쓴 매핑**입니다. 게이트의 `evidence` 문구에서 파일을 추측하지
  않습니다 — 아무도 안 본 게이트에 대해 확신을 지어내는 것이 이 도구가 막으려는
  실패입니다. 매핑 없는 게이트는 `unmapped`으로 보고합니다.
- **`evidence_present`는 통과가 아닙니다.** 게이트가 이름 댄 산출물이 트리에
  있다는 뜻일 뿐이고, 대부분의 기준은 이 저장소에 없는 production·부하 데이터
  위에서 정의됩니다. 임계값 판단은 사람이 합니다.
- **이 도구는 registry에 쓰지 않습니다.** status 전환도 `evidenceRefs` 채우기도
  하지 않습니다. 승인은 registry에 기록되는 사람의 행위이고, 보고서가 자기
  대상을 편집하면 registry가 존재하는 이유인 감사 기록이 사라집니다.
- **`appliesWhen`은 저장소 사실이 아니라 런타임 조건입니다.** MEMORY 4건은
  `AppSetting`의 `feature.memoryExtractionEnabled`·`feature.memoryInjectionEnabled`
  에 달려 있으므로, 조건을 주지 않으면 `applicability_unknown`으로 남깁니다.
  꺼져 있다고 가정하면 blocking 프라이버시·안전 게이트 4건을 조용히 면제하게
  됩니다.
- 착수 후보는 `nothing built yet`입니다. `built, nothing measures it`은 보통
  기능이 아니라 테스트나 리포트 한 건입니다.

`nothing built yet` 11건 중 **BILLING-04만 다른 작업에 막혀 있지 않습니다.**
Planner·context manifest·moderation은 선행 작업 대기이고, store·native auth는 이
저장소에서 만들 수 없습니다. BILLING-04에 착수하기 전에 읽습니다.

- `docs/policy/goodwill-credit-grants.md`

goodwill 지급은 Stripe 환불도 구매 취소도 아닌 **세 번째 것**이며, 대응 결제가
없으므로 멱등성을 빌려올 수 없습니다. 설계 문서 §8의 여섯 가지(1회·기간 상한,
이중 승인 임계값, 만료, 소진 순서, 환불 상호작용, 사용자 가시성)는 finance-ops의
결정이며 **정해지기 전에는 구현하지 않습니다.**

# Credit entitlement vs operational guardrail

크레딧·비용 한도를 건드리기 전에 읽습니다.

- `docs/policy/credit-and-cost-limits.md`

절대 조건:

- **사용자 entitlement는 크레딧입니다.** 플랜 크레딧과 구매 크레딧이 사용
  권한을 정하며, 그 위에 숨은 USD 한도를 두지 않습니다.
- **operational guardrail은 별개 층입니다.** 이름(`CHAT_COST_GUARDRAIL_*`),
  오류 코드(`OPERATIONAL_COST_GUARDRAIL_TRIGGERED`, `PROVIDER_BUDGET_EXHAUSTED`),
  버킷(`op-cost-*`), 지표를 entitlement와 섞지 않습니다.
- guardrail 한도는 플랜 크레딧에서 유도하며, 환경변수 override는 유도값
  아래로 내려갈 수 없습니다(`lib/chatCostGuardrails.ts`가 강제).
- 모든 enabled premium 모델은 `lib/modelPricing.ts`에 명시적 가격 profile을
  가져야 합니다. `npm run check:model-pricing`이 PR Fast Gate에서 fail-closed로
  검사합니다.
- **`ModelRegistryEntry`의 가격 컬럼이 `NULL`이면 코드 profile을 상속하고,
  숫자면 관리자 override입니다.** seed는 항상 `NULL`을 쓰고 reconciliation은 이
  세 컬럼을 아예 쓰지 않습니다. 해석된 가격을 행에 다시 넣으면 장문 tier가
  사라지고 `costSource`가 전부 override로 보고돼 fallback 지표가 0%가 됩니다.
  확인은 `npm run check:model-pricing-db`.
- **`creditWeight`에는 그 `NULL` 구분이 없습니다.** `ModelRegistryEntry.creditWeight`는
  `Int` non-nullable이라 모든 행이 숫자를 갖고, 어떤 행도 그 숫자의 출처를 말하지
  못합니다. `ensureModelRegistrySeeded()`는 `skipDuplicates: true`로 넣으므로 이미
  있는 행을 다시 보지 않고, 갱신은 `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에
  등록된 모델에만 닿습니다. **그래서 `lib/models.ts`의 `creditWeight`를 고쳐도
  기존 행에는 반영되지 않고, 코드는 계속 옛 값을 말합니다.**
  2026-08-15에 `perplexity/sonar`가 이 상태로 발견됐습니다 — 코드 16, 청구 20.
  `npm run report:model-credit-weights`가 코드와 DB의 차이를 나열합니다. **gate가
  아니라 보고입니다**: 행이 카탈로그와 다른 것은 `PUT /api/admin/models`가 만들라고
  있는 상태이고, 의도된 override와 편집 실패는 컬럼만 봐서 구분되지 않습니다.
  새 모델의 크레딧을 바꿀 때는 코드만 고치지 말고 이 보고로 실제 행을 확인합니다.
- **처리 tier를 요청에 넣지 않습니다.** 모든 profile이 Standard 가격이며, 이는
  아무 요청도 `service_tier`를 지정하지 않는 동안에만 참입니다(생략 시 OpenAI
  기본값은 `auto`). `npm run check:model-pricing`이 request-side tier 지정을
  fail-closed로 막습니다.
- **`GET /v1/models`는 가격 출처가 아닙니다.** 계정별 모델 가시성만 확인합니다
  (`npm run check:openai-model-access`).
- cache write 가격은 감사용으로 기록만 하고 과금하지 않습니다 — cache write
  토큰을 보고하는 usage adapter가 없습니다.
- 가격이 아직 검증되지 않은 premium 모델은 `PENDING_VERIFIED_PRICE_REGISTER`에
  담당자·검증 티켓·등록일·기한·production 승인과 함께 등록합니다. 기한(최대
  90일)이 지나면 같은 검사가 경고에서 실패로 바뀝니다. fallback 사용 비율과
  예약 대비 정산 비율은 `GET /api/admin/fallback-pricing`에서 봅니다.
- **provider 예산은 production에서 반드시 명시합니다.** production 기본값은
  없고, 활성 provider에 `CHAT_PROVIDER_*_COST_MICROUSD_PER_DAY`/`_PER_MONTH`가
  없으면 `/api/ready`가 실패합니다. 단일 계정의 plan guardrail보다 낮은 값은
  바닥으로 올려 강제하고 보고합니다. 환경변수를 **먼저** 배포하고 코드를
  나중에 배포합니다. 현황은 `GET /api/admin/provider-budgets`에서 봅니다.
- 가격 변경은 소급 적용하지 않습니다. `pricingVersion`과 `costSource`를
  reservation·settlement snapshot에 저장합니다.
- 사용자 응답에 원시 내부 USD를 노출하지 않습니다. `internal*` 진단 필드는
  `publicChatErrorDetails()`가 제거하고, Admin Console과 구조화 로그에만
  남깁니다.
- 모든 오류 응답의 `resetAt`은 생성 시점보다 미래여야 합니다.
- **크레딧을 예약·환급하는 트랜잭션은 `lockCreditAccount(tx, userId)`를 가장
  먼저 잡습니다**(정책 문서 §9). `reserveAddOnCredits()`는 읽어서 판정하고
  차감하는데 `CreditLot.remainingCredits`에 CHECK도 사후 검사도 없어서, 잠금이
  없으면 같은 잔액을 읽은 두 경로가 모두 통과해 잔액이 음수가 됩니다. 순서도
  계약입니다 — workflow advisory 잠금(`memory-extraction:*` 등)보다 **앞**이며,
  종료 여부 같은 조건 분기 **안**에서 잠그지 않습니다.
- **`CreditLot`의 non-negative CHECK는 그 잠금의 대체물이 아닙니다.** CHECK는
  직렬화를 못 하므로 잠금 없는 경로를 안전하게 만들지 못하고, 조용히 틀린
  잔액을 실패한 트랜잭션으로 바꿀 뿐입니다. `NOT VALID`로 배포했으므로
  validate는 `npm run report:credit-lot-invariants`가 0을 보고한 뒤 **별도
  migration**으로 합니다 — production에서 손으로 validate하면 schema 비교가
  drift로 잡습니다.
- 이 계약을 어기는 변경은 릴리스 차단 사유입니다.

# Conversation.productKey

`Conversation.productKey`, 그 CHECK 제약, 또는 productKey를 쓰는 생성 경로를
건드리기 전에 읽습니다.

- `docs/policy/conversation-product-key.md`

절대 조건:

- **`kind`를 제품 정체성으로 재사용하지 않습니다**(계획서 §5). `kind`는
  `lib/conversationKindGuard.ts`가 소유하는 **서버 authorization·modality 경계**
  이고, `productKey`는 사용자가 수행하는 제품 작업입니다. 두 축은 직교하며 어느
  것도 다른 하나를 대체하지 않습니다.
- **`selectionMode`로 제품을 유도하거나 백필하지 않습니다.** Chat에서 사용자가
  모델을 직접 골라도 그 대화는 Chat입니다. 그리고 manual 복귀가 sticky state를
  지우므로(`Conversation_manual_has_no_sticky_state_check`) "Auto였던 적이 있나"를
  나중에 물을 수조차 없습니다.
- **허용값은 `chat` · `review` · `studio` 셋뿐이고 `code`는 없습니다.** Code가
  Conversation을 쓰기 시작할 때 `lib/conversationProduct.ts`의
  `CONVERSATION_PRODUCT_KEYS`와 DB CHECK에 **함께** 추가합니다
  (`npm run check:enum-constraints`가 어긋남을 잡습니다).
- **DB default를 두지 않습니다.** `review` default는 컬럼을 빼먹은 writer를
  Review를 의도한 writer처럼 보이게 만듭니다. 전환 기간의 NULL은 "아직 안 정해짐"
  이고 그것이 백필의 대상 목록입니다.
- **Auto는 Chat 전용이며 규칙은 허용 하나로 씁니다**, 금지 목록이 아니라.
  v1.1은 `review + auto`만 금지했고 `studio + auto`가 통과했습니다.
- **NOT VALID 제약은 writer 누락을 막지 못합니다.** 셋 다 `productKey IS NULL`을
  통과시킵니다. 누락은 공통 생성 서비스 · 직접 `conversation.create` 정적 검사 ·
  writer coverage 테스트가 막으며, 이 셋은 제약과 별개로 계속 필요합니다.
- **`VALIDATE CONSTRAINT`와 `NOT NULL`은 각각 별도 migration이고 별도 증거를
  갖습니다.** 정책 문서 §7의 조건이 충족되기 전에는 작성하지 않습니다.
  `tests/integration/conversation-product-key.db.test.ts`가 조기 전환을 실패로
  만듭니다.

# Chat concurrency and identity namespace

게스트 동시 실행 scope, lease 수명, guest→로그인 전환의 대화 ID를 건드리기 전에
읽습니다.

- `docs/policy/chat-concurrency-and-identity.md`

- **동시 실행은 entitlement도 guardrail도 아닌 세 번째 층입니다.** `limitLayer`는
  주체 한도가 `concurrency`, IP 집계 상한이 `operational_admission`입니다.
  크레딧·플랜·provider 예산과 코드도 문구도 섞지 않습니다.
- **게스트의 동시 실행 한도는 signed guest cookie(`access.subjectKey`) 기준입니다.**
  `access.ipKey`로 되돌리면 같은 NAT의 서로 다른 게스트가 서로의 한도를 소비합니다.
- **IP 집계 상한은 별개로 유지합니다**(`CHAT_IP_CONCURRENT`,
  `CHAT_IP_CONCURRENCY_EXCEEDED`). 게스트 한도 아래로 설정할 수 없고, 기존 IP
  기준 분당·일일·토큰·비용 abuse protection을 대체하지 않습니다.
  `CHAT_GUEST_CONCURRENT`를 올려 문제를 덮지 않습니다.
- **다중 모델 비교는 전부 승인되거나 전부 거절됩니다.** aggregate preflight가 한
  transaction에서 슬롯을 예약하고, 서명·subject 결속·만료를 가진 admission token을
  각 모델 요청이 조건부 UPDATE로 한 번만 소비합니다. token은 어느 슬롯을 쓸지만
  정하며 모델·소유권·크레딧·비용 검사를 대체하지 않습니다.
- **lease는 고정 TTL이 아니라 heartbeat로 유지합니다.** 완료·provider 오류·취소·
  연결 끊김·스트림 생성 실패·deep research 인계 모두에서 결정적으로 해제하고,
  실패는 구조화 이벤트로 남기며 15분 주기 reconciliation이 orphan을 정리합니다.
- **계정 API에는 현재 identity namespace의 서버 Conversation ID만 전달합니다.**
  `guest_` 접두사 검사는 보안 경계가 아니라 상태 invariant이고, 소유권은 계속
  서버가 정합니다. `guest_*`를 DB Conversation ID로 인정하거나
  `CONVERSATION_FORBIDDEN`을 완화하지 않습니다.
- **로그인 시 guest localStorage를 삭제하지 않습니다.** 전환은 *선택*만 해제하고
  guest snapshot은 import modal이 결정할 수 있도록 보존합니다.

# 프로모션 할인과 통화

프로모션의 할인 형태, `discountAmountCents`, Admin billing PATCH의 프로모션
분기를 건드리기 전에 읽습니다.

- `docs/policy/promotion-discount-currency.md`

절대 조건:

- **신규 프로모션은 정률만입니다.** 고정액 할인은 승인된 상태로 deprecated이고
  (docs/policy/promotion-discount-currency.md §2, rollout 승인 2026-08-16,
  활성 0개 확인), 다중 통화로 확장하지 않습니다.
- **`discountAmountCents`는 USD 금액입니다.** 다른 통화의 가격에 비율로 환산해
  적용하지 않습니다. 그 환산이 이 정책을 만든 사고입니다.
- **컬럼은 삭제하지 않습니다.** 과거 상환 기록이 프로모션 행을 가리키므로
  당시 할인을 재구성할 수 없게 됩니다. 삭제는
  docs/policy/promotion-discount-currency.md §5의 세 조건을 확인한 뒤 별도 migration입니다.
- **판정은 `fixedAmountPromotionRefusal()` 한 곳에 있습니다**
  (`lib/billingPromotionAdminPolicy.ts`). Admin API와 Admin 패널이 같은 함수를
  부릅니다.
  docs/policy/promotion-discount-currency.md §4 행렬을 route와 component에
  각각 옮겨 적지 않습니다.
- **판정은 요청 본문이 아니라 저장된 행과 비교합니다.** 패널이 매 저장마다
  프로모션 목록 전체를 PATCH하므로, 본문만 보고 고정액을 거절하면 기존 코드가
  하나라도 있는 동안 billing 폼 전체가 잠깁니다.
- **거절은 어떤 write보다 먼저** 합니다. plan·price·promotion이 한 요청에 실려
  오므로 늦게 거절하면 절반만 적용된 상태가 남습니다.
- **좁히는 편집은 계속 허용합니다** — 비활성화, 종료일 단축, 할인액 인하, 플랜
  제거, 상한 인하. 비활성화까지 막으면 살아 있는 프로모션을 끌 수단이 없어집니다.
- 통화 판정 자체(`promotionCurrencyFailure()`, `PROMOTION_CURRENCY_NOT_SUPPORTED`)
  는 별개 계층이며 validation과 Checkout이 공유합니다. 완화하지 않습니다.
# 가격 카탈로그 default는 fixture가 아닙니다

`DEFAULT_BILLING_PRICE_CATALOG`(`lib/billingPriceCatalog.ts`)의 숫자를 고치기
전에 읽습니다.

- docs/policy/promotion-discount-currency.md §8

**이 표는 세 상황에서 실제로 청구됩니다.** `AppSetting` 행 없음(첫 read가
default를 DB에 씁니다), 저장값 JSON 파싱 실패, schema 검증 실패. 그러므로 여기의
숫자를 바꾸는 것은 **가격 변경**이고, 테스트 값 조정이 아닙니다.

- **필드 하나가 빠지면 카탈로그 전체가 버려집니다.** 손상된 항목만이 아니라
  멀쩡한 값까지 default로 되돌아갑니다.
- **값은 승인된 것만 넣습니다.** 2026-08-16에 production 저장값(20건)에 맞췄고,
  근거는 `npm run report:billing-price-catalog`의 production read입니다. 환율로도
  비율로도 유도하지 않습니다.
- **부분 정렬 금지.** 20건은 한 transaction에서 저장됐고, 어떤 절단선을 잡아도
  일관성이 깨집니다 — Pro AUD 월간만 옮기면 연간가가 월 12회 결제보다 비싸집니다.
- **fallback은 조용하지 않아야 합니다.** `billing_price_catalog_fallback` 구조화
  이벤트가 세 상태를 구분해 남기고 `served: compiled_default`를 함께 적습니다.
  정상 경로에서는 아무것도 남기지 않습니다 — 매 요청 로그는 진짜 신호를 묻습니다.
- **두 reader 모두 source를 반환합니다.** Admin 패널은 저장된 행의 `updatedAt`을
  카탈로그 옆에 그리므로, source 없이는 그 행이 가진 적 없는 숫자 옆에 최근
  타임스탬프가 붙습니다.
- **`AdminAuditLog`는 가격 이력이 아닙니다.** `billing.updated`는 가격이 바뀌었다는
  사실(`localizedPricesUpdated`)만 남기고 이전·이후 값은 남기지 않습니다. 과거
  가격은 이 로그로 재구성할 수 없습니다.
- 값 변경은 `tests/billingPriceCatalogDefaults.test.mjs`를 함께 고쳐야 합니다.
  전체 비교이므로 언급되지 않은 가격이 조용히 움직일 수 없고, 연간 할인 구간·
  Max > Pro·크레딧팩 단조성 불변식이 자릿수 실수를 잡습니다.

# Plan change (Pro <-> Max)

플랜 변경 CTA나 `/api/billing/checkout`의 차단 분기를 건드리기 전에 읽습니다.

- `docs/policy/plan-change.md`

**Pro↔Max 온라인 변경은 전용 엔드포인트로만 합니다.** `/api/billing/checkout`은
변경을 수행하지 않으며 앞으로도 하지 않습니다.

- 서버는 동일 플랜 재구매와 다운그레이드를 `PLAN_CHANGE_NOT_SUPPORTED`로,
  활성 구독 상태의 상위 플랜 요청을 `ACTIVE_SUBSCRIPTION_EXISTS`로 각각 409
  차단합니다. **이 세 분기는 그대로 둡니다.** 풀면 신규 구독 Checkout으로 변경을
  우회할 수 있게 되고, 한 계정이 두 플랜을 동시에 결제합니다.
- 변경은 `app/api/billing/plan-change/**`(preview · confirm · 조회 · 예약 취소)가
  수행하고, 판정은 `lib/planChangeStateMachine.ts`(순수), Stripe 실행은
  `lib/planChangeService.ts`가 맡습니다. 이 분담을 섞지 않습니다.
- **결제 전에 권한을 올리지 않습니다.** 업그레이드는
  `proration_behavior=always_invoice` + `payment_behavior=pending_if_incomplete`로
  보내고, 계정의 plan은 오직 `syncSubscription()`이 Stripe에서 다시 읽은 구독으로
  옮깁니다.
- **다운그레이드는 Subscription Schedule을 직접 관리합니다.** Customer Portal은
  같은 interval의 Price 여러 개를 한 Product에 두지 못하므로 이 변경을 담지
  못합니다. Portal을 실행 경로로 되돌리지 않습니다.
- **`cancel_at_period_end`를 자동으로 해제하지 않습니다.** 별도 opt-in(별도 label을
  가진 별도 control)에서 온 `resumeRenewal`이 있을 때만 해제합니다.
- **같은 interval끼리만 허용합니다.** 월간↔연간 변경은 아직 없습니다. 구독
  interval을 모르는 계정은 CTA가 `manage_plan`(고객지원)으로 남습니다.
- 크레딧 산식은 `lib/planChangeCredits.ts`에 있습니다. 플랜 변경은 월 사용량을
  초기화하지도, 추가 지급하지도, 이미 쓴 크레딧을 회수하지도 않습니다.
  업그레이드와 다운그레이드가 같은 함수를 씁니다.

# Default model (GPT-5.6 Luna)

`DEFAULT_MODEL_ID`, 게스트 기본값, `gpt-5-4-mini`의 lifecycle을 건드리기 전에
읽습니다.

- `docs/policy/default-model-luna-migration.md`

- **"기본 모델"은 두 개의 다른 결정입니다.** 게스트 첫 대화는 DB의
  `AppSetting["guestDefaultModelId"]`이고 brand trio 중 **선두만** 정합니다.
  신규 로그인 계정은 `DEFAULT_MODEL_ID` → `APP_DEFAULTS.defaultModelId` →
  `UserSettings.defaultModel` 컬럼 기본값 → `app/api/user/settings/route.ts`가
  만드는 행입니다. 둘을 섞지 않습니다. `npm run check:default-models`가 양쪽을
  함께 읽고 PR Fast Gate에서 검사합니다.
- **trio 밖의 모델은 `guestDefaultModelId`로 저장할 수 없습니다.** resolver가
  무시하므로 저장은 되고 효과는 없는 설정이 됩니다. `guestDefaultLeadRejection()`
  이 거부합니다.
- **기본 모델은 `gpt-5-6-luna`입니다.** `lib/models.ts`의 `DEFAULT_MODEL_ID`,
  `lib/appDefaults.ts`의 `GUEST_DEFAULT_MODEL_ID`와 `GUEST_BRAND_TRIO_MODEL_IDS`,
  Prisma 컬럼 기본값이 함께 움직입니다. 한쪽만 바꾸지 않습니다.
- **`gpt-5-4-mini`는 은퇴하지 않았습니다.** enabled·publiclyListed 상태를
  유지하는 것은 의도된 관찰 기간입니다.
- **수치 eval 통과는 은퇴의 필요조건이지 충분조건이 아닙니다.** 정책 문서
  4.3(수치)과 4.6(사용량·고정 사용자 비율, 도구 호환성, support·공유 링크,
  안내·유예기간, staging 검증)을 **모두** 충족해야 은퇴할 수 있습니다.
- **eval 표본 하한은 규칙마다 다릅니다.** 합산 규칙(오류율·빈 응답률)은 arm당
  ≥300(권장 500), **시나리오별 5%p 규칙은 시나리오당 ≥100**입니다 —
  `--repeats=25`면 시나리오당 25회라 해상도가 4%p여서 5%p 기준을 판정할 수
  없습니다. 판정은 점추정이 아니라 Wilson 95% 구간 경계로 합니다.
- **`--repeats=25`를 돌렸다는 사실만으로 decision-grade가 아닙니다.** 정책 문서
  4.5.1의 절차 — 사전 점검, 네 arm 동일 commit·동일 실행, `--json` 증거 보존
  (manifest·원본 기록·블라인드 검토 세트), 블라인드 정성 검토, 다른 시간대
  독립 재실행, staging 수동 검증 — 을 모두 묶어야 인용할 수 있습니다.
  `scripts/evalDefaultModel.mjs`가 `SMOKE RUN`·`PARTIAL RUN`·`UNDERPOWERED`·
  dirty tree를 경고로 출력합니다.
- **긴급 운영 비활성화는 품질 eval과 분리합니다.** 공급자 장애·폐기·보안 사유는
  4.3·4.6을 기다리지 않고 운영 lifecycle로 즉시 내릴 수 있으며, 이는 이 문서의
  은퇴가 아닙니다(4.7). `operationalReason`이 제품 은퇴와 운영 중단을 구분해야
  합니다.
- OpenAI는 `gpt-5.4-mini`를 계속 서비스합니다. 은퇴하더라도 공급자 종료가
  아니라 **Tomverse 제품 카탈로그 결정**입니다.
- **은퇴는 마케팅 갱신과 한 변경으로 배포합니다.** 공개 마케팅이 지목하는 모델
  ID는 `lib/marketingModelReferences.ts` 하나뿐이고
  `tests/marketingModelReferences.test.mjs`가 이를 강제합니다. 문구·CTA·배지·결과
  라벨·ko/en·SEO metadata·deep link·캡처 fixture는 사람이 함께 옮깁니다. mini로
  생성된 예시 답변은 이름만 바꾸지 말고 재생성하거나 과거 결과임을 유지합니다.
- **`reservationOutputBasis`를 p90으로 바꾸려면 정책 문서 3.1의 9개 조건**
  (모델별 독립 산출, 기간·표본 수, workload 분리, 정산된 출력·과금 reasoning
  토큰, 중단·부분 응답 포함, 동질 표본, 감사 보관, 안전 여유·floor, drift 감시)
  을 충족하고 새 `pricingVersion`으로 구분합니다. 그 전까지는
  `conservative_default`를 유지합니다.
- 두 모델 모두 Guest 계층 Standard **1크레딧**입니다. 은퇴 평가 중에 크레딧을
  임의로 바꾸지 않고, 기존 mini 사용자를 Terra·Sol 같은 상위 유료 모델로
  자동 이동시키지 않습니다.
- 사용자 선택 상태(`UserSettings.defaultModel`,
  `Conversation.selectedModels`)의 일괄 이전은
  `scripts/run-default-model-reconciliation.mjs`가 담당하며 **은퇴 배포와 함께**
  실행합니다. dry run은 자유롭지만 **쓰기에는 `--approved-retirement`·티켓·
  실행자·대상/대체 모델이 모두 필요하고, CI와 build/start/deploy/migrate
  lifecycle에서는 어떤 승인으로도 쓰지 않습니다.** `Conversation.selectedModels`는 문자열 치환이 아니라 JSON 배열로
  파싱해 변환하고, malformed 값은 파괴하지 않고 보고합니다.
- 과거 `Message.modelId`, usage reservation/settlement의 modelId와 pricing
  snapshot, 결제 ledger, `catalogDeleted`는 소급 변경하지 않습니다.
- **"새 대화 기본 조합"은 세 번째 독립 결정입니다**(정책 문서 1.2).
  `UserSettings.newConversationModelIds`(`Json?`, default 없음)가 로그인
  사용자의 새 대화 시작 상태의 source of truth이고, `NULL`은
  `[defaultModel]`로 해석합니다. 해석은 `lib/newConversationModels.ts`의
  공통 resolver만 담당합니다. 조합을 저장하는 모든 쓰기 경로는 첫 항목과
  `defaultModel`을 같은 transaction에서 동기화합니다.
- **읽기 경로는 DB를 rewrite하지 않습니다.** `GET /api/user/settings`가
  비활성 기본 모델을 발견해도 stored 값은 보존하고 effective 상태와
  `modelSelectionNotice`만 반환합니다. 영구 변경은 사용자의 명시적 재저장
  또는 승인된 retirement reconciliation뿐입니다. 저장 성공 응답은 요청
  echo가 아니라 실제 DB 저장값만 반환합니다. UI 계약은
  `docs/ui-contracts/account-model-settings.md`.

# 공유 package와 framework 순수성

`packages/**`, workspace 설정, `transpilePackages`, `eslint.config.mjs`의
`no-restricted-imports` 규칙을 건드리기 전에 읽습니다.

- `docs/policy/shared-packages.md`

절대 조건:

- **`packages/*`는 세 환경에서 그대로 돌아야 합니다** — Next.js 서버, 브라우저
  번들, Capacitor shell. 한 곳에서만 해석되는 import 하나가 공유 package를
  "디렉터리만 다른 app 코드"로 되돌립니다.
- **금지 import**: `next`·`next/*`, `server-only`·`@/*`·`@prisma/client`·
  `next-auth`, `node:*`와 bare Node builtin, `@capacitor/*`·`react-native`.
  플랫폼 의존은 port로 주입합니다.
- **package는 `dependencies`·`peerDependencies`를 선언하지 않습니다.**
  dependency block은 어떤 소스 파일도 이름을 대지 않은 채 framework가 돌아오는
  경로입니다. `"type": "module"`은 필수입니다.
- **package tsconfig는 root를 `extends`하지 않습니다.** `lib`는 `["ES2022"]`,
  `types`는 `[]`, `paths` 없음 — `window`·`process`·`Buffer`가 해석되지 않는
  것이 요점입니다. ESLint는 금지된 *import*를, 이쪽은 금지된 *global*을
  잡습니다.
- **PACKAGE-01 지표는 ESLint 자체 API로 셉니다**
  (`npm run check:shared-packages`). 별도 scanner를 만들어 두 숫자가 어긋나게
  하지 않습니다.
- **seed는 이동이지 재export shim이 아닙니다.** `lib/`에 shim을 남기면 예전
  import 경로가 계속 동작하므로 경계를 강제하는 것이 아무것도 없습니다.
- **PACKAGE-01은 `approved`입니다**(2026-08-12, `@mposition`). 증거는
  `docs/release-gates/evidence/PACKAGE-01-2026-08-12.md`에 commit SHA와 CI run
  링크로 남아 있고, 그 승인이 덮는 범위는 **존재하는 두 package가 한 commit에서
  framework-neutral했다**는 것까지입니다 — `chat-ui`·`api-client`가 생기면
  다시 읽습니다.
- **artefact가 있다는 것과 승인 가능한 증거가 있다는 것은 다릅니다.** registry는
  `evidenceRefs`에 immutable link 또는 artifact identifier를 요구합니다. script가
  tree에 있다는 사실은 그 어느 것도 아닙니다.
- **한 사람이 두 역할을 겸하는 것은 registry에 기록된 허용입니다**
  (`approvalPolicy.soleApproverAllowed`). 1인 조직에서 "서로 다른 두 사람"
  규칙은 엄격한 것이 아니라 충족 불가능하며, 모든 blocking gate가 영원히
  승인 불가가 됩니다. 남은 분리는 **증거를 만든 주체(대개 자동화)와 승인자가
  다르다**는 것이고, 승인자는 사람이어야 합니다. 두 번째 담당자가 생기면
  `soleApproverAllowed`를 `false`로 되돌리는 한 줄이면 됩니다 — validator가
  그 field를 읽습니다.
- 승인 없이 `status`·`approvedBy`·`approvedAt`·`evidenceRefs`를 건드리지
  않습니다.
- 표준 `tsc` project를 build matrix라고 부르지 않습니다. bundler가 아닙니다.

<!-- BEGIN:mobile-chat-composer-invariant -->
# 이미지 생성 (v2: 멀티 모델 비교)

이미지 생성 관련 코드를 건드리기 전에 읽습니다.

- `docs/policy/image-generation.md` (v2 개정 §11–§15 포함)

절대 조건:

- **핵심 계약은 멀티 모델 비교입니다.** 단일 모델 요청은 1-모델 그룹의
  특수한 경우입니다. 채팅 admission token은 재사용하지 않습니다 —
  `modelIds` 단일 POST가 한 트랜잭션에서 그룹·target·attempt·예약·
  admission·budget을 원자 생성하고, 거절은 행도 비용도 남기지 않습니다.
- **그룹 상태는 저장하지 않습니다.** 각 target의 최신 attempt에서
  파생하며, 재시도는 새 그룹이 아니라 같은 target의 새 attempt입니다.
  succeeded target 재실행은 거부합니다(이중 과금 금지).
- **고정 성공 가격은 최악 원가가 유한할 때만 유지됩니다.** thinking
  상한을 공식 문서로 확인할 수 없는 모델은 fail-closed로 비활성입니다.
  `ceil(maxCost/900µ)`이 수학적 최소 크레딧이고 판매 크레딧은 별도
  승인입니다. 이미지 가격 검증은 텍스트 모델의
  `PENDING_VERIFIED_PRICE_REGISTER`와 별개 계층입니다.
- **budget은 provider별 총액입니다**(`IMAGE_PROVIDER_{P}_COST_*`).
  모델별은 관측 차원일 뿐입니다. 동시성은 workflow(활성 그룹 수)와
  execution(provider별 job 수) 두 층입니다.
- **Guest·Free는 전 위치 잠금 노출**(비노출·마지막 단계 차단 금지)이고,
  이미지 결과 비교는 `comparison-action-rail`의 원칙만 차용하며 계약·
  컴포넌트를 직접 재사용하지 않습니다. AI Review는 이미지 대화에서 계속
  금지입니다.
- **v1 flag는 staging 검증 전용입니다.** 멀티 모델 UX 완성 전 production
  공개 활성화 금지, Google 모델은 가격 검증 통과 전 활성화 금지.

# AI 생성 파일 (Generated Artifact)

채팅 답변이 만들어 내는 실제 파일 — tool 정의, 명세, 형식 표, 생성기, 저장,
다운로드 권한, 수명주기 — 를 건드리기 전에 읽습니다.

- `docs/policy/generated-artifacts.md`

절대 조건:

- **앱이 파일을 만들지 못했으면 만들었다고 말하지 않습니다.** 코드블록,
  base64, sandbox 경로(`/mnt/data/...`), 가짜 링크는 파일의 대체물이 아닙니다.
  파일 생성 요청의 결과는 다운로드 가능한 artifact이고, 안 되면 왜 안 되는지와
  무엇을 하면 되는지를 말합니다.
- **구조가 있는 형식에서 모델은 명세만 만들고 바이트는 서버가 만듭니다.**
  tool은 형식마다가 아니라 종류마다 하나입니다 — `create_spreadsheet`,
  `create_document`, `create_presentation`, `create_text_file`,
  `create_archive`. 입력은 Zod로 검증된 명세이며, tool schema는 힌트일 뿐이라
  `admit*Spec()`이 `execute` 안에서 다시 판정합니다. 명세에 `formula` 필드는
  없고 writer는 `<f>` 요소를 쓰지 않습니다.
- **소스 코드·마크업·설정은 모델이 텍스트를 직접 씁니다.** Python module에는
  "그 텍스트"가 아닌 명세가 없기 때문이고, 대신 제한된 크기·이 앱이 정한
  확장자·구조 검사(JSON·YAML·XML·SVG)·다운로드 전용 전달이 적용됩니다.
  SVG의 `<script>`·event handler·`javascript:`는 거절합니다.
- **형식은 표 하나입니다.** `lib/generatedArtifactFormats.ts`의
  `ARTIFACT_FORMAT_TABLE`이 확장자·media type·kind·검증·label을 함께 정합니다.
  형식 추가는 표의 행 하나 + `lib/generatedArtifactRenderers.ts`의 분기 하나 +
  migration의 `format` CHECK뿐이고, 그 밖의 어디에도 형식별 분기를 만들지
  않습니다.
- **실행되는 형식은 만들지 않습니다**(`REFUSED_ARTIFACT_EXTENSIONS`). 기준은
  "열면 실행되는가"이므로 `.sh`·`.ps1`·`.py`는 지원하고 `.exe`·`.msi`·`.bat`은
  거절합니다. 같은 목록이 아카이브 항목에도 적용되므로 zip으로 우회할 수
  없습니다. 아카이브 경로는 정규화하지 않고 **거절**합니다.
- **조용한 퇴행이 없습니다.** 모든 turn이 artifact system block을 하나 싣고,
  tool을 못 쓰는 turn은 그 사실을 말하라고 지시받습니다. 가용성 판정은
  `planGeneratedArtifactTool()` 한 곳이며, 검증되지 않은 모델은 fail-closed
  입니다(`ARTIFACT_TOOL_CAPABILITIES`).
- **게스트는 MVP에서 파일을 만들 수 없습니다.** tool은 등록되지만 즉시
  거절하고, UI는 `blocked` 카드와 로그인 CTA를 보여 줍니다. 표·코드로 대신하지
  않습니다.
- **생성은 객체 먼저·행 나중, 삭제는 행 먼저·객체 나중**입니다. 행은 assistant
  메시지와 같은 트랜잭션에서 쓰고, 메시지를 쓰지 못한 모든 종료 경로는
  `releaseSafely()`에서 객체를 회수하며, tombstone queue와 orphan sweep이
  15분 cron에서 나머지를 정리합니다.
- **`objectKey`·저장소 URL·서명 URL은 클라이언트에 가지 않습니다.**
  클라이언트가 보는 것은 `ChatStreamArtifact` allowlist뿐이고, 다운로드는
  `GET /api/artifacts/{id}` 하나뿐입니다. 모델이 만든 URL은 다운로드 URL이
  아닙니다.
- **소유권·잠금 실패는 전부 404**입니다(잠금만 423). 조회 자체가 `userId`로
  범위를 잡으므로 "없음"과 "남의 것"을 구분할 분기가 존재하지 않습니다.
- **web search와의 충돌은 검색이 이깁니다.** 강제된 native 검색
  (`toolChoice: "required"`)과 Google grounding에서는 artifact tool을 등록하지
  않습니다. Anthropic 검색은 공존합니다.
- **요청한 형식으로 만듭니다.** xlsx를 csv로, docx를 md로 대체하지 않습니다.
  표에 없는 확장자는 지원하지 않는다고 말합니다.
- **billing의 `allowDownloads`를 재사용하지 않습니다.** 그 권한은 대화 TXT
  내보내기의 것이며, 생성 파일은 로그인한 모든 계정이 쓸 수 있습니다:
  docs/policy/generated-artifacts.md §11.

# Trace 기반 오류 신고 자동화

feedback의 Trace 검증, `errorReportToken`, `TraceErrorEvidence`, chat 오류
응답 builder를 건드리기 전에 읽습니다.

- `docs/policy/trace-feedback-automation.md`

절대 조건:

- **Trace ID 문자열은 인증 수단이 아닙니다.** provenance
  (`server_generated`/`client_supplied`/`client_fallback`/`unknown`)를
  구분하고, 사용자 입력 Trace만으로 자동화 적격성을 인정하지 않습니다.
- **token은 서버가 직접 생성한 Trace의 server-classified 오류에만 중앙
  발급합니다** (`issueChatErrorReportGrant` 한 곳). client/Edge Trace와
  client-classified `EMPTY_RESPONSE`에는 발급하지 않고, 정상 stream에
  선발급하지 않습니다. token 모듈은 Node 전용이며 `proxy.ts`/Edge bundle에
  import하지 않습니다.
- **원시 token은 저장·전송 금지.** feedback 제출 body 1회가 유일한 예외이고
  서버는 검증 후 즉시 버립니다. `Message.errorReport`는 runtime 전용이며
  모든 직렬화는 `lib/chatMessageSerialization.ts`의 allowlist를 통합니다.
- **evidence identity는 Trace ID와 독립입니다.** `traceId`를 PK·unique·
  upsert key로 쓰지 않고, 연결은 token payload의 `occurrenceId`로만 합니다.
- **feedback 제출과 Trace 검증은 분리됩니다.** 검증 실패는 신고 저장을 막지
  않습니다. verification/classification/evidence availability는 독립 관찰로
  별도 저장하며, client 분류를 server 사실로 승격하지 않습니다.
- **Phase 2는 diagnosis-only shadow mode입니다**
  (`FEEDBACK_AUTOFIX_SHADOW_ENABLED` 뒤에서 fail-closed).
  `FeedbackAutoFixCase`는 증거 수집·결정적 분류·진단 요약까지만 하며, 코드
  수정·branch·PR·LLM 호출이 없습니다. 상태 전이는
  `lib/feedbackAutoFixCore.ts`의 그래프만 허용하고 진단 요약에 사용자
  본문을 넣지 않습니다.
- **Phase 3(자동 수정)은 인프라만 존재하고 운영은 비활성입니다**
  (`FEEDBACK_AUTOFIX_ENABLED` + sync secret + 수동 dispatch 3중 잠금,
  정책 문서 §9.1). LLM confidence를 자동 게이트로 쓰지 않고, 결정적
  Red→Green 증명 없는 자동 수정을 금지하며, 자동 생성 수정의 target은
  `develop`뿐이고 auto-merge는 켜지 않습니다. change policy는
  `lib/feedbackAutoFixPolicy.ts`가 정의하며 파이프라인 자기 자신을 수정
  대상에서 제외합니다. staging 배포를 production 해결로 표시하지 않습니다.

# 이메일 알림

이메일 발송 경로, 수신 동의·수신 거부, suppression, 관할권 판정, 발송 템플릿을
건드리기 전에 읽습니다.

- `docs/policy/email-notifications.md`

이 문서는 감사 보고서가 아니라 승인된 계약입니다. `.github/audits/`에 있던
초안을 `docs/policy/`로 옮긴 것이며, 코드 주석의 인용은 전부 이 경로를 가리킵니다.

절대 조건:

- **차선(lane)이 둘이고 보증이 서로 반대입니다.** credential synchronous
  lane(로그인 코드 등)은 요청 안에서 예산 안에 보내고 실패를 즉시 알리며,
  standard lane은 outbox에 넣고 cron drain이 끝까지 재시도합니다. 수명이 10분인
  자격증명을 15분 주기 큐에 넣지 않습니다(§9.4a).
- **enqueue는 호출자의 transaction 안에서 합니다.** fire-and-forget 발송을
  되살리지 않습니다 — 그것이 이 시스템이 대체한 것입니다(§2.4).
- **security·billing 수신 설정은 끌 수 없습니다**(`LOCKED_EMAIL_PURPOSES`,
  DB CHECK). marketing은 동의가 있어야 보내고, 동의 철회는 purpose 범위
  suppression을 함께 씁니다.
- **suppression은 주소 기준이라 계정 삭제 후에도 남습니다.** transactional은
  hard bounce에서만 막고 complaint로는 막지 않습니다(§13.3). Resend의 suppression은
  계정·region 전체 범위라는 확인된 제약이 있으므로, marketing 활성화 전에
  발송 계정 분리를 결정합니다(§5.3.1, A18).
- **IP만으로 관할권을 정하지 않습니다.** 신호 우선순위는 자기 신고 → 결제 국가 →
  직전 동의 시점의 관할권이고, IP는 관측용입니다. 신호가 충돌하면 marketing을
  보류하고 확인을 요청합니다(docs/policy/email-notifications.md §6).
- **국가 규칙은 데이터입니다.** `JurisdictionProfile`·`JurisdictionCountryMap`은
  `EmailPolicyVersion`에 묶이고, 활성화는 사람이 승인해 registry에 기록하는
  행위입니다. 코드가 status를 스스로 `active`로 올리지 않습니다(§12.5).
- **자격증명 본문은 어디에도 남기지 않습니다.** 코드·magic link는
  `EmailEvent.payload`, `renderDataSnapshot`, 로그 어디에도 넣지 않습니다.
  standard lane의 snapshot은 봉투 암호화하고 보관 기한이 지나면 지웁니다(§10.3).
- **스트림마다 발송 도메인이 다릅니다.** marketing은 `MARKETING_EMAIL_FROM`이
  없으면 transactional 주소로 대체되지 않고 **거부**합니다 — 대체는 프로모션
  스팸 신고를 로그인 코드가 나가는 도메인에 얹는 일이고, 증상은 로그인 메일이
  안 온다는 신고로만 나타납니다. 두 스트림을 같은 도메인에 설정하면
  `/api/ready`가 실패합니다. 절차는 `docs/ops/email-sending-domains.md`.
- **unsubscribe는 로그인 없이 한 번에 됩니다.** RFC 8058 one-click을 지원하고,
  marketing에 서명 키가 없으면 헤더 없이 보내는 대신 발송을 거부합니다(§11.3).
- marketing은 위 suppression 경계 결정 전까지 production에서 비활성입니다.

## Mobile chat composer invariant

Before changing `ChatInput.tsx`, `MobileChatShell.tsx`, composer styles, tool chips, or mobile bottom-dock layout, read:

- `docs/ui-contracts/mobile-chat-composer.md`

Non-negotiable requirements:

- The mobile textarea must always own a dedicated full-width row with at least one complete visible input line.
- Tool, web-search, deep-research, attachment, billing, and model-status controls must never consume the textarea's horizontal row, overlap it, or float above it.
- Increasing ChatMessageList height must never reduce the textarea to residual horizontal space.
- Do not use absolute positioning, negative margins, transforms, or shared grid cells to place controls beside or over the textarea.
- Any mobile composer layout change must include bounding-box, overlap, horizontal-overflow, Korean IME, 320px-width, and 200% text-scaling regression coverage.
- A change that violates this contract is a release blocker.
<!-- END:mobile-chat-composer-invariant -->

<!-- BEGIN:mobile-sidebar-drawer-invariant -->
## Mobile sidebar drawer invariant

Before changing the drawer in `MobileChatShell.tsx`, `ChatSidebar.tsx`'s
`isMobileDrawer` layout, `useVisualViewport.ts`, or the account footer inside the
drawer, read:

- `docs/ui-contracts/mobile-sidebar-drawer.md`

Non-negotiable requirements:

- Every drawer control must be visible or reachable by one vertical scroll on any
  supported viewport, including one shortened by browser chrome, rotation or the
  on-screen keyboard.
- Reachable is measured from the control's centre point with
  `elementFromPoint`, not with `toBeAttached()` or a programmatic `.click()`.
- Exactly one scroll owner at a time: when the drawer scrolls, the conversation
  list must not also be a scroller, and the owner must contain every control.
- The short/tall switch reads the visible viewport (`useShortViewport()`), never
  `window.innerHeight`, a CSS `max-height` query, a device name or a UA string.
- No control may be hidden, demoted behind a "more" affordance, or have its touch
  target, text size, accessible name or focus ring reduced to make room.
- Safe-area insets, modal semantics, focus trapping and focus return are
  preserved, and the page behind the drawer never scrolls in its place.
- Any related change must keep `tests/e2e/mobile-short-viewport-drawer.spec.ts`
  passing across its full viewport/state matrix.
- A change that violates this contract is a release blocker.
<!-- END:mobile-sidebar-drawer-invariant -->

<!-- BEGIN:comparison-action-rail-invariant -->
## Comparison action rail invariant

Before changing `ComparisonActionRail.tsx`, `lib/comparisonReadiness.ts`, the bottom workflow dock in either shell, or the rail's copy, read:

- `docs/ui-contracts/comparison-action-rail.md`

Non-negotiable requirements:

- Desktop and mobile must use the same state-driven disclosure policy: decide with `shouldShowVisualStatus()` in `lib/comparisonReadiness.ts`, never with `layout === "mobile"`, a media query, or any other shell-shaped condition.
- In the normal, all-complete, runnable state the status sentence ("Comparing N completed answers") is visually hidden in both shells, and leaves no row height or bottom gap behind.
- Visually hidden means `sr-only`: the sentence stays in the DOM and in the accessibility tree, and each action keeps the comparison target count in its own `aria-describedby`.
- Generating, too-few-answers, excluded, analysis-running and per-action credit-shortfall states must be visible on screen, with each action describing only its own price and its own reason.
- Any related change must include the desktop *and* mobile state matrix tests (`tests/comparisonReadiness.test.mjs`, `tests/e2e/comparison-action-rail.spec.ts`).
- A change that violates this contract is a release blocker.
<!-- END:comparison-action-rail-invariant -->

<!-- BEGIN:typography-invariant -->
## Typography and font system invariant

Before changing `lib/fonts.ts`, the font tokens or `@utility type-*` roles in `app/globals.css`, `components/DocumentShell.tsx`'s font wiring, or `lib/emailTypography.ts`, read:

- `docs/ui-contracts/typography.md`

Non-negotiable requirements:

- Every `font-family` resolves through `--font-ui` or `--font-code`. Never hard-code a family, and never register a font variable that the rendered UI does not actually use.
- Locale families are selected by `:lang()` over the whole subtree, never by per-glyph fallback: `Geist` by default, `Noto Sans KR` for `:lang(ko)`, `Noto Sans SC` for `:lang(zh)`.
- Only the Latin UI face is preloaded. `Geist_Mono`, `Noto_Sans_KR` and `Noto_Sans_SC` stay `preload: false`; verify with `node scripts/report-font-preload.mjs` after a build.
- Webfonts are self-hosted through `next/font`. The browser must never request Google's servers.
- Customer text is never below 11px; body copy and primary controls start at 14px; mobile text inputs stay at 16px.
- `font-black` (900) is limited to headline-sized text (≥18px) and short brand expressions; small buttons, chips, badges and labels use 500–700.
- Monospace is only for code, model IDs, build metadata, verification codes and preserved-formatting input.
- Emails use the single web-safe stack in `lib/emailTypography.ts` and never load a webfont.
- Any related change must keep `tests/typographyPolicy.test.mjs` and `tests/e2e/font-system.spec.ts` passing, and must re-run the mobile composer contract specs.
- A change that violates this contract is a release blocker.
<!-- END:typography-invariant -->
<!-- BEGIN:image-generation-workspace-invariant -->
## Image generation workspace invariant

Before changing `components/images/ImageGenerationWorkspace.tsx`, `components/chat/NewConversationLauncher.tsx`, `components/chat/ImageModelTabPanel.tsx`, the `Chat | Image` tabs in `ModelPickerPanel.tsx`, or the image entry points in `ChatInput.tsx`/`ChatSidebar.tsx`/`ChatPageClient.tsx`, read:

- `docs/ui-contracts/image-generation-workspace.md`

Non-negotiable requirements:

- There are exactly four entry points (sidebar split button, mobile drawer rows, composer tools menu, catalogue image tab) and no standalone "new image" button. Switching to the image draft creates no server row.
- Guest and Free see every entry point locked, with the requirement stated up front and the click routed to sign-in or `/pricing` — never hidden, never blocked only at the last step. With the flag off nothing renders at all.
- Image generation models are their own catalogue tab. They are never mixed into the chat model list, and the chat list's `modelSupportsImageInput` filter (image *input*) is never reused to mean generation.
- The comparison limit reaches the composer as a **prop resolved on the server** (`imageGroupMaxModels()`, `lib/imageGroupLimits.ts` — the same function admission calls). The client never reads `process.env`, never hard-codes the number, and never derives it from `IMAGE_INLINE_MODEL_DISCOVERY_LIMIT`, which is a separate decision about one row of UI. Exceeding the limit refuses the change without altering the selection, states the reason, and still allows deselecting an already selected model; `IMAGE_MODEL_SELECTION_INVALID` gets its own message rather than a generic retry.
- Every registered image model is listed, including one held by the price-verification rule; a held row is stated as a hold and is not selectable. The tab quotes "from N credits"; only the composer quotes an exact price.
- The workspace follows the mobile composer contract's shape: the textarea owns a dedicated full-width row and no control shares, overlaps or floats above it.
- An image conversation never mounts `ChatInput`, `ChatApp` or the comparison action rail, never enables AI Review, and never imports `ComparisonActionRail`/`shouldShowVisualStatus()` — only their principles.
- Group state is derived from the latest attempt per target, never stored: one card per target, a retry replaces its card in place, and a succeeded target offers no re-run.
- Prices are quoted before submission, per model and in total; a model with no resolvable price cannot be submitted.
- Generated images always carry the AI-generated label; signed asset URLs are never persisted and R2 keys never reach the client.
- Visual role is `accent-image-*` only; the AI Review gradient is reserved.
- Any related change must keep `tests/e2e/image-generation-workspace.spec.ts` passing on desktop **and** mobile, and must re-run the mobile composer, sidebar drawer and model picker specs.
- A change that violates this contract is a release blocker.
<!-- END:image-generation-workspace-invariant -->
<!-- BEGIN:settings-navigation-invariant -->
## Settings navigation invariant

Before changing the Data tab's entries in `AuthButton.tsx`, `lib/settingsNavigation.ts`, `lib/accountSettingsEvents.ts`, `components/settings/**`, or the top of `/settings/imports` and `/settings/memory`, read:

- `docs/ui-contracts/settings-navigation.md`

Non-negotiable requirements:

- Two movements, two controls, both rendered. A detail page navigates *up* to settings by name (`settingsSectionHref()`), never with `router.back()`; leaving settings *entirely* is a separate one-click exit to `/chat` (`settingsExitHref()`, no query string) rendered once by the `/settings` route shell for every screen under it. Neither control is merged into the other, and no detail component renders its own copy of the exit.
- "Back to settings" and the exit must both work from a directly-opened detail-page URL, on every shell and in every sidebar state, and must not disturb the browser's own Back button (the deep link is dropped with `replaceState`, never a pushed entry). The exit is not an `X`: it names the chat and carries a `MessageSquare`-family icon, with the full phrase as its accessible name at every width.
- External import and account memory stay separate features with separate detail pages and separate state, presented as separate rows under one group (`settingsNav.dataAndPersonalization`) — not merged, and not two stacked full-width cards.
- Every entry's action label names its own purpose; a generic label repeated across entries ("Open settings") is a violation. A "back" label must name where the link actually goes, in every locale.
- Desktop and mobile use the same hierarchy, order and wording; only the desktop breadcrumb trail is extra. Nothing here may be decided by `layout === "mobile"`, a UA string or a device name.
- A row is one link with an explicit accessible name (title + action), its description and status in `aria-describedby`, a visible focus ring, and keyboard activation. Returning from a detail page restores that row's scroll position and focus.
- Any related change must keep `tests/settingsNavigation.test.mjs` and `tests/e2e/settings-information-architecture.spec.ts` passing on the desktop *and* mobile projects.
- A change that violates this contract is a release blocker.
<!-- END:settings-navigation-invariant -->
<!-- BEGIN:admin-console-ia-invariant -->
## Admin Console information architecture invariant

Before changing `lib/adminNavigation.ts`, `components/admin/adminNavigationIcons.ts`, `lib/adminNavigationBadges.ts`, `components/admin/AdminConsoleShell.tsx`, `AdminSidebar.tsx`, `AdminCommandPalette.tsx`, `AdminPageTabs.tsx`, or any route under `app/(site)/(application)/admin/**`, read:

- `docs/ui-contracts/admin-console-ia.md`

Non-negotiable requirements:

- **Every retired `/admin/*` URL keeps a redirect.** Bookmarks, runbooks and `href`s already written into audit summaries point at them, so deleting a route without leaving one behind is a release blocker. A redirect carries the request's own query to the destination but never its own stale `tab`.
- A section lives in `?tab=`, not in component state. Tabs are `<Link>`s, the page's server component reads `searchParams`, and only the open section's data is loaded.
- Adding an entry means adding it in three places at once: the route table in `lib/adminNavigation.ts`, an icon in `adminNavigationIcons.ts`, and a real route segment. There is no catch-all `[section]` route — an unknown admin URL must answer 404, not 200.
- A badge is for work, not decoration: only entries an operator acts on carry one, and an unknown count renders nothing rather than zero.
- The layout loads counts; a page loads its own data. Nothing that only one workspace displays may move into `admin/layout.tsx`. A panel showing the newest N rows states N on screen and does not present its own counters as totals.
- Authorization is out of this contract's scope and was not changed by it: `writeRoles` in the route table drives the sidebar's "Read" marker only, and access is still decided server-side by `lib/adminAuth.ts` and each `/api/admin/**` handler.
- Any related change must keep `tests/adminNavigation.test.mjs` and the `tests/e2e-admin/**` suite (`npm run test:e2e:admin`, the "Admin Console E2E (PostgreSQL)" workflow) passing.
- A change that violates the redirect rule is a release blocker; the rest is ordinary review.
<!-- END:admin-console-ia-invariant -->
<!-- BEGIN:auto-model-selection-invariant -->
## Auto model selection invariant

Before changing `components/chat/AutoRoutingToggle.tsx`, `components/chat/AutoRoutedByBadge.tsx`, `lib/autoRoutingUi.ts`, `lib/autoRoutingCopy.ts`, or the `selectionMode` handling in `app/api/conversations/[conversationId]/route.ts`, read:

- `docs/ui-contracts/auto-model-selection.md`

Non-negotiable requirements:

- **`offered` is the only input.** It already folds the feature flag together with cohort eligibility, so no surface may derive availability from the flag alone. There is no disabled state and no greyed row: a control that flips, saves and changes nothing cannot be told apart from Auto agreeing with the user every time.
- No user-facing string may name a bucket, a percentage, a cohort salt or a readiness gate. A client that could read its own bucket could work out the rollout percentage.
- No locale may promise a better, best, optimal or smartest model. `ROUTE-01` measures non-inferiority, which is a far weaker claim than that copy would be making, and `tests/autoRoutingUi.test.mjs` fails the build on the words.
- The badge renders only on a turn Auto actually routed. A turn that fell back to the user's own model gets none, or it claims a routing decision that did not happen.
- Returning a conversation to `manual` is accepted unconditionally, including when Auto is no longer offered — it is how a conversation leaves a mode the account can no longer act on, and how Auto's sticky state is cleared.
- Auto never appears as a row in the model catalogue: it has no context window, price or provider, and the credit estimate would have nothing to show for it.
- A change that violates this contract is a release blocker.
<!-- END:auto-model-selection-invariant -->
