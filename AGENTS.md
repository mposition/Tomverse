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
   `accent-plan-max`(둘 다 purple)도 같습니다.
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
- 새 이슈의 완료 조건이 generic 신호에 안 잡히면 `ISSUE_PROBES`에 추가합니다.
  증명하지 못하는 부분은 `remainder`에 적습니다 — 그래야 부분 완료가 완료로
  보고되지 않습니다.
- 이 script는 보고 전용이라 gate가 아닙니다. 단 하나의 비정상 종료는
  `lib/modelPricing.ts` 해석이 실제 module과 어긋날 때이며, 그때는 출력 전체를
  믿을 수 없다는 뜻입니다.

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
- **PACKAGE-01은 아직 `pending`입니다.** Vite build matrix 증거가 없으며
  `apps/mobile`과 함께 옵니다. 표준 `tsc` project를 build matrix라고 부르지
  않습니다.

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

- Settings is a closable panel, not a route. A detail page navigates up to settings by name (`settingsSectionHref()`), never with `router.back()`, and never grows a second link to the chat — leaving settings entirely is the panel's own close action.
- "Back to settings" must work from a directly-opened detail-page URL, on every shell and in every sidebar state, and must not disturb the browser's own Back button (the deep link is dropped with `replaceState`, never a pushed entry).
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
