# Tomverse Insight 최종 UX 작업명령서

연결 문서: `Tomverse-Insight-UX-Audit-Final-Report.md`
기준 SHA: `8d02fc1d35f988d5c9d61ab9463fea01a3f0b3b6` (branch `develop`)

---

## 1. 작업 목적과 범위

### 목적

최종 UX 감사 보고서에서 채택된 16개 이슈(UX-001–UX-016)를 해소해, 현재 `No-Go` 판정의
차단 사유를 제거합니다.

### 범위에 포함

- 채팅 전송·렌더 경로의 정합성
- Provider 상태 판정의 단일화 및 모델 레지스트리 노출 정합성
- 요금제 화면의 접근성 문자열과 레이아웃 안정성
- QA 자동화의 결정성과 계약 커버리지
- 검증 절차(운영 실호출, 보조기술 표본)의 경로 확보

### 범위에서 제외

§7 참조.

---

## 2. 구현 원칙

1. **증상이 아니라 원인을 고칩니다.** 테스트를 통과시키기 위한 우회는 금지합니다.
2. **회귀 금지 항목을 지킵니다.** 감사에서 해결이 확인된 아래 동작은 모든 작업 후 유지되어야
   합니다.
   - 마케팅 동의 배너가 `position: static`으로 `marketing-consent-slot` 안에 렌더되고,
     H1 및 `#landing-hero-primary`와 교차 0, CTA 중심 hit-test가 CTA에 도달,
     동의 버튼 44×44 이상, 320–430px overflow 0
   - `/api/chat/preflight` body가 UI의 현재 `webSearchMode`를 그대로 전달
   - header brand가 항상 완전한 단어(`Tomverse` / `Tomverse Insight`), header overflow 0
   - 마케팅 route에서 third-party 요청 0건, console error 0건
   - 시각 렌더 기준 `1 credit` / `2 credits` / `A$10.00 per month` 문법
3. **금지 사항**
   - CSP 완화(`unsafe-inline`/`unsafe-eval`/wildcard/third-party host 추가)
   - 실패 테스트 삭제 또는 assertion 약화
   - timeout 증량, 무조건 retry, skip 추가로 flake 은폐
   - snapshot/golden 무검토 갱신
   - 가격 **계산** 로직 변경
   - `catalogDeleted` 자동 설정 (사람의 결정으로 남겨둔 필드)
   - 동의 이전 analytics 실행 허용
   - 승인 없는 실제 Provider 호출 및 credit 소비
4. **근거 없는 단정 금지.** Provider 장애 원인을 credential·quota·egress로 추정하지 않고,
   증거가 없으면 `Unknown cause`로 기록합니다.
5. **Next.js 버전 주의.** `AGENTS.md`에 따라 코드 수정 전 `node_modules/next/dist/docs/`의
   관련 문서를 읽습니다.

---

## 3. 작업 순서 및 의존성

```
[1단계 · 출시 차단 해소]
  TASK-01 (UX-001) 전송/렌더 race ──┐
  TASK-03 (UX-003) 프로브 스킵 처리 ─┼─→ TASK-02 (UX-002) 상태 판정 단일화
  TASK-04 (UX-004) 은퇴 모델 노출 제거 ┘        (TASK-03의 상태 정의에 의존)

[2단계 · 단기 개선]
  TASK-06 (UX-006) 접근성 문자열      독립
  TASK-07 (UX-007) 요금제 CLS         독립 (TASK-06과 동일 파일 → 함께 처리 권장)
  TASK-08 (UX-008) 모바일 E2E 기대값   TASK-01 이후 (전송 안정화 후 판정이 명확해짐)
  TASK-16 (UX-016) 실행 모드 독립성    TASK-01과 함께

[3단계 · 구조 개선]
  TASK-09 (UX-009) client/server 안전 경계   TASK-02 이후
  TASK-10 (UX-010) preflight 계약 테스트     독립
  TASK-11 (UX-011) 상태 근거 경과 시간       TASK-02, TASK-03 이후

[4단계 · 검증 경로]
  TASK-05 (UX-005) 상용 실호출 검증    1단계 전부 완료 후. 자격증명 필요
  TASK-12 (UX-012) 성능 기준선         TASK-07 이후
  TASK-13 (UX-013) 보조기술 표본 검증   TASK-01, TASK-06 이후

[5단계 · 정리]
  TASK-14 (UX-014) 모델 id 표기 문서화  독립
  TASK-15 (UX-015) 인라인 링크 터치 영역 결정 필요 (§8)
```

**핵심 의존성**: TASK-02는 TASK-03이 정의하는 "프로브 증거 없음" 상태를 전제로 하므로
TASK-03을 먼저 또는 함께 설계해야 합니다. 두 작업을 하나의 일관된 상태 정책으로 처리하는
것을 권장합니다.

---

## 4. 작업 목록

---

### TASK-01 — 전송 후 사용자 메시지 렌더 보장

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-01 |
| **연결 UX 이슈** | UX-001 |
| **우선순위** | P1 |
| **예상 규모** | L |

**작업 목적**
사용자가 메시지를 전송했을 때 본문 패널에 자신의 메시지가 반드시 1회 표시되도록 합니다.

**대상 화면 또는 사용자 흐름**
인증 채팅 — 새 대화 첫 메시지 전송 (Enter, 외부 키보드 Ctrl/Cmd+Enter, 화면 전송 버튼)

**현재 문제**
전송 시 textarea는 비워지고 대화는 생성되지만 본문 패널에 사용자 메시지가 나타나지 않는
경우가 있습니다. 5초/14회 폴링에도 `[data-message-role="user"]`가 0개입니다.
재현율: desktop 1920×1080 약 29%(24회 중 7회), desktop-compact 1366×768 약 17%(6회 중 1회),
mobile 외부 키보드 약 40%(5회 중 2회, 단독 실행 기준).

**변경 요구사항**
1. 키 입력 경로와 버튼 클릭 경로가 **단일 전송 파이프라인**을 사용하게 합니다.
2. 대화 생성(사이드바)과 메시지 목록(본문)이 **동일한 source of truth**를 참조하게 합니다.
   현재 증상은 대화 id 전환과 메시지 기록 대상이 어긋날 때 발생하는 패턴과 일치하므로,
   `activeChatId` 결정 시점과 메시지 append 시점의 순서를 먼저 추적하십시오.
3. optimistic 렌더가 요청 결과와 무관하게 안정적으로 선행되고, 성공·부분 실패·전체 실패·
   재시도에서 일관되게 reconcile되게 합니다.
4. 동일 입력의 중복 전송을 막는 in-flight guard를 유지합니다.
5. 원인을 확정한 뒤 최소 범위로 수정합니다. 광범위한 리팩터는 하지 않습니다.

**유지해야 할 기존 동작**
- IME 조합 중 Enter 미전송 (`isComposing` 또는 `keyCode === 229`)
- PC Enter 전송 / Shift+Enter 줄바꿈 / 모바일 Enter 줄바꿈 / Ctrl·Cmd+Enter 전송
- 전송 후 textarea clear 및 포커스 정책
- 게스트 Turnstile 재시도 경로

**예상 대상 파일 또는 컴포넌트**
- `app/(application)/chat/ChatPageClient.tsx` (`handleGlobalSubmit`, `activeChatId` 결정,
  `setCurrentChatId`, 대화 생성 분기)
- `components/chat/ChatApp.tsx` (메시지 상태·전송 요청)
- `components/chat/ChatInput.tsx` (`handleKeyDown`)
- `lib/chatKeyboardPolicy.ts` — **정책 자체는 올바르므로 변경 대상 아님**

**선행 작업 및 의존성**
없음. 1단계 최우선.

**접근성 요구사항**
- 전송 결과가 스크린리더에 전달되도록 라이브 리전 의미를 유지합니다.
- 키보드만으로 전송·재시도가 가능해야 합니다.

**반응형 요구사항**
1920×1080, 1440×900, 1366×768, 420px narrowed desktop, 모바일 셸에서 동일하게 동작해야
합니다.

**오류·로딩·빈 상태 요구사항**
- 요청 실패 시 현재의 복구 UX(Retry, Report error, 대체 모델 안내, Trace ID)를 유지합니다.
- 실패가 "생성 중" 상태로 고착되지 않아야 합니다.

**수용 기준**
- [ ] `tests/e2e/chat-keyboard-policy.spec.ts`의 `Enter sends the message exactly once`가
      `desktop-chromium`·`desktop-compact`에서 **각 20회 연속 실패 0**.
- [ ] 모바일 외부 키보드 전송 테스트가 **단독 실행과 파일 전체 실행 모두 20회 연속 실패 0**.
- [ ] 매 실행에서 다음이 동시에 성립: 사용자 메시지 본문 패널에 정확히 1회 표시 /
      사이드바 대화와 활성 대화 일치 / `/api/chat` 요청 수가 기대값과 일치 / 중복 메시지 0.
- [ ] timeout 증량이나 retry 추가 없이 달성.

**검증 절차**
1. 수정 전 현재 코드에서 실패를 재현하고 실패 시점의 상태(활성 대화 id, 메시지 배열 키)를
   기록합니다.
2. 원인과 수정한 상태·이벤트 흐름을 문서화합니다.
3. `npx playwright test --project=desktop-chromium --project=desktop-compact
   --project=mobile-chromium tests/e2e/chat-keyboard-policy.spec.ts` 를 20회 반복합니다.

**회귀 테스트 항목**
`tests/e2e/chat-keyboard-policy.spec.ts` 전체, `tests/e2e/chat-tools.spec.ts`,
`tests/e2e/guest-flow.spec.ts`, `tests/e2e/mobile-flow.spec.ts`,
`tests/e2e/desktop-flow.spec.ts`

**완료 정의**
반복 기준 실패 0, 원인·수정 내용 문서화, 회귀 항목 통과.

---

### TASK-02 — Provider 상태 판정 단일화

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-02 |
| **연결 UX 이슈** | UX-002 |
| **우선순위** | P1 |
| **예상 규모** | M |

**작업 목적**
공개 상태 페이지와 채팅 UI가 소비하는 모델 가용성이 서로 모순되지 않게 합니다.

**대상 화면 또는 사용자 흐름**
`/status` ↔ 모델 선택기 / 채팅 첫 페인트 / 전송 가드

**현재 문제**
`/status`가 `Incident`/`Degraded`로 선언한 Provider의 모델을 `/api/models/status`가
`available`, `fallbackModelIds: []`로 반환합니다. 채팅 UI는 경고 없이 해당 모델을
제공합니다. 원인은 모델 API가 공개 판정 `publicStatus`가 아닌 내부
`provider.status === "outage"`만 참조하기 때문입니다.

**변경 요구사항**
1. Provider health → 모델 API → picker → 배너 → 전송 가드가 **동일한 판정과 동일한
   `generatedAt` 스냅샷**을 사용하게 합니다.
2. 다음 상태를 명확히 구분합니다: `available` / `limited`(또는 `degraded`) /
   `unavailable` / `unknown` / 정적 `disabled`·`retired`.
3. 아래 두 설계 중 하나를 선택하고 **선택 이유를 코드 주석에 남깁니다** (§8 결정사항).
   - (A) 모델 API가 `publicStatus`를 반영하고 `fallbackModelIds`를 제공 — **권장**
   - (B) 분리를 유지하되 채팅 UI가 `incident`/`degraded` Provider 모델에 대해 명확히 경고
4. 기본 3-model에 장애 Provider가 포함될 때 사용자에게 상태와 대안을 제시합니다.
   **사용자에게 알리지 않는 자동 모델 교체는 금지합니다.**
5. 근거 없는 `Operational` 승격을 하지 않습니다(기존 원칙 유지).

**유지해야 할 기존 동작**
- 성공 근거 없으면 `operational` 불가
- `unknown`은 중립(zinc) 렌더, 초록 금지
- probe 증거와 real-traffic 증거의 필드 분리
- `E2E_DISABLE_DATABASE` fallback 경로, rate-limit 처리

**예상 대상 파일 또는 컴포넌트**
- `app/api/models/status/route.ts`
- `lib/providerPublicStatusCore.ts`
- `lib/providerMonitoring.ts`
- `app/(application)/status/page.tsx`
- 모델 선택기/배너 컴포넌트 — `TBD — 구현 전 코드 확인 필요`

**선행 작업 및 의존성**
TASK-03과 상태 정의를 공유합니다. 함께 설계하십시오.

**접근성 요구사항**
상태 표시는 색상만으로 의미를 전달하지 않아야 하며(아이콘+텍스트 유지), 경고는 스크린리더에
전달되어야 합니다.

**반응형 요구사항**
상태 배너·경고가 320px에서 overflow를 만들지 않아야 합니다.

**오류·로딩·빈 상태 요구사항**
health 데이터 로드 실패 시 전 Provider를 `unknown`으로 표시하는 기존 fallback을 유지합니다.

**수용 기준**
- [ ] 임의 시각에 `/status`와 `/api/models/status`를 동시 조회했을 때 Provider별 판정이
      모순되지 않는다.
- [ ] `incident`/`degraded` Provider의 모델에 대해 `fallbackModelIds` 또는 사용자 경고가
      존재한다.
- [ ] 동일 상태 fixture와 동일 `generatedAt`에 대해 `/status`, `/api/models/status`,
      picker, 기본 trio, 배너, 전송 가드 결과를 검증하는 table-driven contract test가
      존재하고, 서로 다른 상태를 표시하면 **테스트가 실패한다**.
- [ ] Operational / Degraded / Incident / Unknown / stale / recovered 전환을 포함한다.

**검증 절차**
1. contract test 작성 및 실행.
2. staging 배포 후 `/status`와 `/api/models/status`를 같은 시각에 조회해 대조.
3. `/api/build-info`의 `commitSha`가 배포한 커밋과 일치하는지 먼저 확인.

**회귀 테스트 항목**
`tests/e2e/provider-status.spec.ts`, `tests/e2e/status-page.spec.ts`,
`tests/e2e/chat-model-selection-readiness.spec.ts`

**완료 정의**
수용 기준 전부 충족 + staging 실측 대조 기록.

---

### TASK-03 — 프로브 대상이 아닌 Provider의 증거 처리

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-03 |
| **연결 UX 이슈** | UX-003 |
| **우선순위** | P1 |
| **예상 규모** | M |

**작업 목적**
자동 프로브 대상이 아닌 Provider가 영구적으로 허위 장애로 표시되지 않게 합니다.

**대상 화면 또는 사용자 흐름**
`/status` — Provider 상태 카드

**현재 문제**
Perplexity가 *"202 consecutive automated probes have failed"* 사유로 `Incident`이지만
실제로는 프로브되지 않습니다(`Last automated check` 2026-07-27 23:30 UTC로 고정, 나머지
Provider는 00:50 UTC). 전 모델이 검색 기반이라 `getProbeModelFor("perplexity")`가
`undefined`를 반환하고, 라우트가 `no_probe_model`로 early return하여 성공·실패 어느 쪽도
기록하지 않으므로 기존 카운터가 영원히 리셋되지 않습니다.

**변경 요구사항**
1. `no_probe_model`을 단순 스킵이 아니라 **프로브 증거 무효화**로 처리합니다. 해당
   Provider의 probe 상태를 중립화해 근거 없음이 `unknown`으로 귀결되고 **절대 `incident`가
   되지 않게** 합니다.
   - `recordProviderProbeSuccess`/`recordProviderProbeFailure`와 동일 계층에
     `recordProviderProbeSkipped`(또는 동등한 이름)를 추가하는 방향을 권장합니다.
2. 판정 자체는 `lib/providerPublicStatusCore.ts`의 순수 함수 안에서 결정되게 유지합니다
   (공개 페이지와 admin 패널이 어긋날 수 없어야 하는 기존 설계).
3. 이미 누적된 카운터를 정리하는 경로를 제공합니다. 첫 사이클에 자연히 리셋되는 설계를
   권장합니다.
4. 상태 사유 문구가 실제 상황과 일치해야 합니다. 프로브 대상이 아닌 Provider에
   "연속 프로브 실패"를 주장하는 문구가 나오면 안 되며, 별도 reason code를 추가합니다.

**유지해야 할 기존 동작**
- 성공 근거 없으면 `operational` 불가
- probe 증거와 real-traffic 증거의 분리
- probe 스케줄러 지연을 provider 문제로 접지 않고 별도 공지로 분리하는 처리

**예상 대상 파일 또는 컴포넌트**
- `lib/providerProbe.ts` (`getProbeModelFor`, `PROBE_EXCLUDED_USAGE_CLASSES`)
- `app/api/internal/provider-probe/check/route.ts` (`no_probe_model` 분기)
- `lib/providerMonitoring.ts` (probe 기록 함수)
- `lib/providerPublicStatusCore.ts` (판정·reason code)
- `lib/statusPageEvidence.ts`

**선행 작업 및 의존성**
TASK-02와 상태 정의 공유.

**접근성 요구사항**
새 상태의 사유 문구가 색상 없이도 의미를 전달해야 합니다.

**반응형 요구사항**
상태 카드가 320px에서 overflow 0을 유지해야 합니다.

**오류·로딩·빈 상태 요구사항**
프로브 대상이 없는 Provider는 "근거 없음"으로 중립 표시되어야 하며 장애로 오인되지 않아야
합니다.

**수용 기준**
- [ ] 프로브 대상이 아닌 Provider가 `/status`에서 `incident`로 표시되지 않는다.
- [ ] 해당 Provider의 상태 문구가 "프로브 실패"를 주장하지 않는다.
- [ ] `lib/providerPublicStatusCore.ts` 단위 테스트가 추가되어, "프로브 모델 없음 + 과거
      실패 카운터 잔존" 입력이 `unknown`으로 귀결됨을 검증한다.
- [ ] staging에서 Perplexity 상태가 `incident`가 아님을 실측 확인한다.

**검증 절차**
`npm run test:unit` → staging 배포 후 `/status` 실측 → `/api/models/status`와 대조.

**회귀 테스트 항목**
`tests/e2e/provider-status.spec.ts`, `tests/e2e/status-page.spec.ts`, 관련 단위 테스트

**완료 정의**
수용 기준 충족 + staging 실측 기록.

---

### TASK-04 — 은퇴·비공개 모델의 공개 노출 제거

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-04 |
| **연결 UX 이슈** | UX-004 |
| **우선순위** | P1 |
| **예상 규모** | M |

**작업 목적**
`publiclyListed:false` / disabled / retired 모델이 사용자에게 선택 가능하지 않게 합니다.

**대상 화면 또는 사용자 흐름**
모델 선택기 / `/api/models/status`

**현재 문제**
`lib/models.ts:156`에서 `llama-4-scout`는 `publiclyListed: false, enabled: false,
status: "disabled", replacementModelId: "llama-3-3"`인데, 공개 API가 2026-07-28 01:52:08Z
기준 `available`, `fallbackModelIds: []`로 반환합니다. 실제 호출은 HTTP 404입니다.
정적 레지스트리는 seed일 뿐이고 런타임 소스는 DB 레지스트리이므로, seed만 수정해서는
배포된 레지스트리가 바뀌지 않습니다.

**변경 요구사항**
1. catalogue·status API·picker가 공유하는 **authoritative public-model selector**를 만들고
   `publiclyListed:false`/disabled/retired를 일관되게 제외합니다.
2. 이미 배포된 자동 reconciliation
   (`lib/providerModelCatalogReconciliation.ts`, `lib/providerModelCatalogCore.ts`)이 실제로
   이 항목을 비활성화하는지 **1회 수동 실행으로 확인**합니다
   (`npm run maintenance:provider-model-catalog` 또는 Railway `Provider Model Catalog`
   크론 1회 트리거).
3. 반영되지 않으면 다음을 점검합니다.
   - `PROVIDER_MODEL_CATALOG_AUTO_DISABLE`이 `false`인지
   - "한 Provider의 enabled 라인업 전체를 한 번에 비활성화하지 않는다" 보호장치가
     `PROVIDER_MODEL_CATALOG_RECONCILIATION_HELD`로 보류시키고 있는지
4. 이름·ID alias나 provider mapping으로 은퇴 모델이 재유입되지 않게 합니다.
5. 이미 이 모델을 선택해 둔 사용자의 처리 정책을 정의합니다(§8 결정사항).

**유지해야 할 기존 동작**
- `catalogDeleted`는 사람의 결정으로 남깁니다. 자동으로 설정하지 마십시오.
- 내부 운영 상태가 필요하면 인증된 internal endpoint로 분리합니다.

**예상 대상 파일 또는 컴포넌트**
- `app/api/models/status/route.ts`
- `lib/modelRegistry.ts` (`getPublicRuntimeModels`)
- `lib/providerModelCatalogReconciliation.ts`, `lib/providerModelCatalogCore.ts`
- `scripts/run-provider-model-catalog-monitor.mjs`
- `lib/models.ts` (seed — 이미 올바름, 참조용)

**선행 작업 및 의존성**
없음. TASK-02와 함께 배포하면 상태 계약을 한 번에 검증할 수 있습니다.

**접근성 요구사항**
모델이 사라질 때 선택기에서 포커스가 유실되지 않아야 합니다.

**반응형 요구사항**
모델 수 변화가 320/390px 선택기 시트 레이아웃을 깨뜨리지 않아야 합니다.

**오류·로딩·빈 상태 요구사항**
사용자가 이미 은퇴 모델을 선택해 둔 경우 명확한 안내와 대체 모델(`llama-3-3`)을 제시해야
합니다.

**수용 기준**
- [ ] `/api/models/status` 실제 응답에 `llama-4-scout`가 **0건**이거나 `unavailable` +
      `fallbackModelIds`가 채워져 있다.
- [ ] 전체 catalogue와 picker에서도 0건이다.
- [ ] mock이 아닌 **실제 route handler 또는 실행 중인 local endpoint 대상 contract test**가
      존재한다.
- [ ] 공개 모델 수와 status 모델 수의 계약이 명시된다.
- [ ] 수동 실행 시각·방법·전후 응답이 기록된다.

**검증 절차**
1. 카탈로그 모니터 1회 수동 실행.
2. `curl -s https://staging.tomverse.app/api/models/status` 전후 대조.
3. contract test 실행.

**회귀 테스트 항목**
`tests/e2e/model-picker.spec.ts`, `tests/e2e/model-picker-limit-state.spec.ts`,
`tests/e2e/model-finder.spec.ts`, `tests/e2e/chat-model-selection-readiness.spec.ts`

**완료 정의**
라이브 API 실측으로 노출 0 확인 + contract test 통과.

---

### TASK-05 — 상용 AI 경로 실호출 검증

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-05 |
| **연결 UX 이슈** | UX-005 |
| **우선순위** | P1 |
| **예상 규모** | 추가 조사 필요 |

**작업 목적**
기본 3-model 비교와 AI Review가 실제 Provider 환경에서 동작하고 credit이 정합함을
증명합니다.

**대상 화면 또는 사용자 흐름**
게스트/인증 채팅 — 기본 3-model 비교, AI Review

**현재 문제**
승인 하에 실행했으나 `/api/chat` 20건 전부 HTTP 403 `{"code":"TURNSTILE_REQUIRED"}`로
거부되어 **Provider 도달 0회, 소비 credit 0**입니다. 원인은 Cloudflare Turnstile이 자동화
브라우저에 토큰 발급을 거부한 것으로, 제품 결함이 아니라 검증 경로의 제약입니다.
게스트는 전체 AI Review가 로그인 게이트(`ai-review-guest-locked`)입니다.

**변경 요구사항**
코드 변경 작업이 아닙니다. 다음 중 하나로 검증 경로를 확보합니다.
- (A) 비자동화 브라우저에서 사람이 수동 1회 실행
- (B) **staging 인증 계정 자격증명 확보 — 권장.** 전체 AI Review까지 검증 가능
- (C) staging 한정 Turnstile 우회 키를 부여한 일회성 세션

**유지해야 할 기존 동작**
게스트 Turnstile 보호는 **약화하지 않습니다.** 우회는 staging 한정·일회성이어야 합니다.

**예상 대상 파일 또는 컴포넌트**
없음(운영 절차).

**선행 작업 및 의존성**
TASK-01–04 완료 후 실행해야 의미가 있습니다. 자격증명 확보는 제품 책임자 결정 사항입니다.

**접근성 요구사항**
해당 없음.

**반응형 요구사항**
해당 없음.

**오류·로딩·빈 상태 요구사항**
부분 실패 시 환불 원장 반영을 확인합니다.

**수용 기준**
- [ ] 기본 3-model 동일 프롬프트 **3회** 실행, 매회 3개 패널 완료.
- [ ] AI Review **1회** 실행 성공.
- [ ] expected credit과 actual credit이 일치.
- [ ] 부분 실패 시 미소비 credit이 환불됨을 원장에서 확인.
- [ ] Provider 상태 표시와 실제 요청 결과가 모순되지 않음.
- [ ] 기록: 패널별 완료·HTTP status·latency·credit·redaction된 trace ID.

**검증 절차**
프롬프트 `"In one sentence, what is the capital city of France?"`,
web search `off` 고정, staging 한정.
**중단 조건**: 첫 비교에서 2개 이상 패널 실패, 또는 실제 차감 credit이 예상치를 초과하면
즉시 중단. **예상 최대 17 credit.**

**회귀 테스트 항목**
없음(운영 검증).

**완료 정의**
수용 기준 전부 기록 또는, 경로를 확보하지 못하면 명시적으로 `Not verified` 유지.
**미검증 상태를 Go 근거로 사용하지 않습니다.**

---

### TASK-06 — 요금제 가격·기간 접근성 문자열 수정

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-06 |
| **연결 UX 이슈** | UX-006 |
| **우선순위** | P2 |
| **예상 규모** | S |

**작업 목적**
스크린리더가 가격과 청구 주기를 자연스럽게 읽도록 합니다.

**대상 화면 또는 사용자 흐름**
`/pricing` — 요금제 카드 (일반/프로모션 모두)

**현재 문제**
가격과 기간이 형제 `<span>`이고 사이에 텍스트 공백 없이 CSS `ml-2`만 있어 접근성 이름이
`$0.00per month`, `$7.50per month`, `$12.50per month`로 결합됩니다.

**변경 요구사항**
1. CSS 간격에 의존하지 않고 자연스러운 accessible string을 제공합니다.
2. 실제 공백, 통합 문자열, 정확한 `aria-label` 중 **의미가 중복되지 않는** 방식을
   선택합니다(같은 정보가 두 번 낭독되면 안 됩니다).
3. 프로모션 정가(`Regular: …`)와 할인가에도 동일하게 적용합니다.

**유지해야 할 기존 동작**
- 시각 레이아웃과 폰트 크기 대비
- 현재 문법: `1 credit`, `2 credits`, `A$10.00 per month`, `Regular: A$20.00 per month`,
  한국어 `/ 월`
- 가격 **계산** 로직 (변경 금지)
- hydration 전후 가격 문자열 불변

**예상 대상 파일 또는 컴포넌트**
- `components/marketing/PricingPageContent.tsx` (일반 가격 블록 및 프로모션 블록)
- `lib/pricingFormat.ts` (`formatBillingPeriodLabel`)

**선행 작업 및 의존성**
없음. TASK-07과 동일 파일이므로 함께 처리 권장.

**접근성 요구사항**
접근성 트리에서 `$15 per month` 형태의 공백이 확인되어야 합니다. EN/KO/FR 및 프로모션·
비프로모션 모두 검증합니다.

**반응형 요구사항**
320–430px에서 가격 블록이 줄바꿈되어도 의미가 유지되어야 합니다.

**오류·로딩·빈 상태 요구사항**
가격 로딩 중 placeholder도 접근성상 오해를 주지 않아야 합니다.

**수용 기준**
- [ ] 브라우저 접근성 트리(또는 `textContent` 결합값)에서 가격과 기간 사이에 공백이 있다.
- [ ] EN `$15 per month`, `A$10.00 per month`, `Regular: A$20.00 per month` 형태가 확인된다.
- [ ] 한국어에서 자연스러운 accessible name이 확인된다.
- [ ] 시각 snapshot만으로 통과 처리하지 않는다.
- [ ] `tests/pricingFormat.test.mjs`가 계속 통과한다.

**검증 절차**
브라우저에서 요금제 카드의 접근성 이름을 직접 조회하고, EN/KO/FR 각각 확인합니다.

**회귀 테스트 항목**
`tests/pricingFormat.test.mjs`, `tests/e2e/korean-typography.spec.ts`,
`tests/e2e/language-detection.spec.ts`

**완료 정의**
수용 기준 충족 + 접근성 트리 실측 기록.

---

### TASK-07 — 요금제 첫 로드 레이아웃 이동 해소

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-07 |
| **연결 UX 이슈** | UX-007 |
| **우선순위** | P2 |
| **예상 규모** | S |

**작업 목적**
`/pricing` 첫 로드의 CLS를 Core Web Vitals "good" 기준(0.1) 이하로 낮춥니다.

**대상 화면 또는 사용자 흐름**
`/pricing` 모바일 첫 로드

**현재 문제**
390×844 cold cache에서 median CLS 0.173(max 0.259). 5회 측정 모두 정확히 0.1734의 단일
shift가 ~1.54s에 발생하며, 원인 노드는 요금제 카드 `ARTICLE`입니다. 통화 확정 가격이 늦게
도착하면서 카드 높이가 재계산되는 것으로 보입니다(`Loading current credit-pack pricing…`
placeholder 존재).

**변경 요구사항**
가격 라인이 확정되기 전에도 **최종과 동일한 높이를 점유**하게 합니다(고정 높이 예약 또는
동일 높이 skeleton). 카드 전체 높이가 변하지 않아야 합니다.

**유지해야 할 기존 동작**
- 가격 **계산** 로직 (변경 금지)
- TASK-06의 접근성 문자열
- LCP 현재 수준(median ~0.9s)

**예상 대상 파일 또는 컴포넌트**
- `components/marketing/PricingPageContent.tsx`

**선행 작업 및 의존성**
TASK-06과 동일 파일. 함께 처리 권장.

**접근성 요구사항**
skeleton은 스크린리더에 노출되지 않거나 로딩 상태로 올바르게 표기되어야 합니다.

**반응형 요구사항**
320/360/390/430px 및 데스크톱에서 카드 높이 예약이 과도한 여백을 만들지 않아야 합니다.

**오류·로딩·빈 상태 요구사항**
가격 조회 실패 시에도 레이아웃이 무너지지 않아야 합니다.

**수용 기준**
- [ ] `/pricing` 390×844 cold cache **3회 반복 median CLS ≤ 0.1**.
- [ ] LCP median이 현재 수준에서 유의하게 악화되지 않는다.
- [ ] 시각 문법 회귀 0 (`1 credit` 등).

**검증 절차**
동일 device/viewport/network/cache 조건에서 3회 이상 측정하고 개별값·median·max를
기록합니다. 단일 HTTP 응답 시간을 Web Vitals로 보고하지 않습니다.

**회귀 테스트 항목**
`tests/e2e/ui-zoom-reflow.spec.ts`, 마케팅 관련 E2E

**완료 정의**
측정 기록과 함께 수용 기준 충족.

---

### TASK-08 — 모바일 web-search 모드 이월 방지 검증 복구

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-08 |
| **연결 UX 이슈** | UX-008 |
| **우선순위** | P2 |
| **예상 규모** | S |

**작업 목적**
전체 suite를 green으로 되돌리고, 모바일에서도 "웹 검색 모드가 새 채팅으로 이월되지 않는다"는
계약을 실제로 검증합니다.

**대상 화면 또는 사용자 흐름**
모바일 채팅 — 새 채팅 시작

**현재 문제**
`tests/e2e/chat-tools.spec.ts`의 *"web search mode selection does not repeat across a new
chat"* 가 `mobile-chromium`에서 5/5 실패합니다. 모바일 새 채팅 버튼이
`{!isActiveConversationEmpty && …}` 조건부 렌더인데, 테스트는 빈 대화 상태에서 버튼을
찾습니다. 제품 결함이 아니라 오래된 기대값입니다.

**변경 요구사항**
**테스트를 삭제하지 마십시오.** 다음 중 하나를 선택하되 모바일 계약 검증을 남깁니다.
- (A) 모바일에서는 메시지 1회 전송 후 헤더 새 채팅 버튼을 사용 — **권장**
- (B) 데스크톱 전용 스코프 + 모바일 동등 검증을 별도 추가

**유지해야 할 기존 동작**
모바일에서 빈 대화일 때 새 채팅 버튼을 숨기는 현재 UX는 의도된 동작이므로 유지합니다.

**예상 대상 파일 또는 컴포넌트**
- `tests/e2e/chat-tools.spec.ts`
- `components/chat/MobileChatShell.tsx` (참조용, 변경 불필요)

**선행 작업 및 의존성**
TASK-01 이후(전송이 안정화되어야 (A)안이 안정적으로 동작).

**접근성 요구사항**
해당 없음.

**반응형 요구사항**
`mobile-chromium`(412×915)에서 통과해야 합니다.

**오류·로딩·빈 상태 요구사항**
해당 없음.

**수용 기준**
- [ ] `desktop-chromium`·`desktop-compact`·`mobile-chromium` 3개 프로젝트 전체 suite가
      **실패 0**으로 종료.
- [ ] 모바일에서 웹 검색 모드 이월 방지 계약이 검증된다.

**검증 절차**
3개 프로젝트 전체 suite 실행.

**회귀 테스트 항목**
`tests/e2e/chat-tools.spec.ts`, `tests/e2e/web-search-composer-state.spec.ts`

**완료 정의**
전체 suite 실패 0.

---

### TASK-09 — preflight 거절 시 client/server 안전 경계 분리 검증

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-09 |
| **연결 UX 이슈** | UX-009 |
| **우선순위** | P3 |
| **예상 규모** | M |

**작업 목적**
preflight 거절 시 Provider 호출과 credit 변동이 0임을 client와 server 양쪽에서 결정적으로
증명합니다.

**대상 화면 또는 사용자 흐름**
인증 2+ model 비교 — preflight 거절

**현재 문제**
외부 감사에서 7회 중 1회 `/api/chat`가 호출되었습니다. 교차검증(8회)에서는 재현되지
않았습니다(합산 15회 중 1회, 약 7%). 더 근본적으로, 현재 테스트는 `/api/chat` 자체를
mock하므로 **실제 서버의 권위 있는 per-model credit/cost 검증을 우회**합니다. 즉 이 테스트가
통과해도 실제 Provider 호출 0이나 과금 0을 증명하지 못합니다.

**변경 요구사항**
1. client preflight는 UX 최적화로 유지하고, **서버를 권위 있는 최종 안전 경계**로 둡니다.
2. 테스트 helper가 다음 상태를 명시적으로 대기하게 합니다: authenticated,
   `isGuestMode=false`, session/settings/conversation ready, `selectedModels` 2개 이상,
   preflight route 설치 완료.
3. stale closure가 guest 또는 1-model 상태를 캡처하지 않게 합니다.
4. **별도의 server 통합/contract test**를 추가해, 방어적으로 chat endpoint가 호출되더라도
   Provider adapter 호출 0회·credit mutation 0을 증명합니다.

**유지해야 할 기존 동작**
- preflight 실패 시 명확하고 재시도 가능한 사용자 메시지
- `COMPARISON_PREFLIGHT_FAILED` 시 서버 권위 검증으로 진행하는 degraded 경로

**예상 대상 파일 또는 컴포넌트**
- `tests/e2e/upgrade-discovery.spec.ts`
- `tests/e2e/support/app-fixtures.ts`
- `app/(application)/chat/ChatPageClient.tsx` (`runComparisonPreflight` readiness)
- 서버 contract test 위치 — `TBD — 구현 전 코드 확인 필요`

**선행 작업 및 의존성**
TASK-02 이후.

**접근성 요구사항**
거절 토스트가 `role="alert"`로 즉시 안내되는 현재 동작을 유지합니다.

**반응형 요구사항**
해당 없음.

**오류·로딩·빈 상태 요구사항**
패널에 `Unexpected response` 같은 오해성 결과가 남지 않아야 합니다.

**수용 기준**
- [ ] client preflight 429에서 `/api/chat` client request 0 — **clean process 20회 이상
      반복에서 비결정성 0**.
- [ ] 별도 server test에서 chat endpoint가 호출되어도 **Provider adapter 0, credit
      mutation 0**.
- [ ] 테스트가 제품의 권위 있는 server guard를 mock으로 우회하지 않는다.

**검증 절차**
단일 worker와 병렬 worker 각각 20회 반복.

**회귀 테스트 항목**
`tests/e2e/upgrade-discovery.spec.ts` 전체

**완료 정의**
수용 기준 충족 + 재현율 기록.

---

### TASK-10 — web-search preflight 계약 회귀 테스트 추가

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-10 |
| **연결 UX 이슈** | UX-010 |
| **우선순위** | P3 |
| **예상 규모** | S |

**작업 목적**
이미 한 번 배포 경로까지 갔던 stale mode 결함의 재발을 CI가 잡게 합니다.

**대상 화면 또는 사용자 흐름**
인증 비교 — web search 모드 전환 후 전송

**현재 문제**
`/api/chat/preflight` body의 `webSearchMode`를 단언하는 테스트가 없습니다. 공용 fixture는
body에서 `comparisonId`와 `modelIds`만 읽고, `native-web-search.spec.ts`는 `/api/chat`
body만 검사합니다.

**변경 요구사항**
UI 모드 / preflight body / 각 `/api/chat` body **세 값이 모두 일치**함을 단언하는 테스트를
추가합니다. preflight는 2개 이상 모델이 선택되어야 실행되므로 기본 3-model로 구성합니다.

| 전이 | 기대 preflight | 기대 chat body |
|---|---|---|
| 기본 `off` | `"off"` | 필드 부재 |
| `off → always` | `"always"` | `"always"` ×N |
| `always → off` | `"off"` | 필드 부재 |
| 모드 변경 직후 즉시 전송 | `"always"` | `"always"` ×N |
| 빠른 연속 전환 후 전송 | `"always"` | `"always"` ×N |

credit matrix도 함께 잠급니다: native 지원 모델당 +8, 미지원 +0, bundled(Perplexity) +0,
`off`/`auto` +0, input multiplier가 surcharge에 중복 적용되지 않음.

**유지해야 할 기존 동작**
기존 스펙을 깨지 않는 선에서 공용 fixture를 확장합니다.

**예상 대상 파일 또는 컴포넌트**
- `tests/e2e/support/app-fixtures.ts`
- `tests/e2e/native-web-search.spec.ts` 또는 신규 스펙
- 참조: `lib/webSearchCredits.ts`, `lib/models.ts`(`webSearchSurcharge: 8`)

**선행 작업 및 의존성**
없음.

**접근성 요구사항**
해당 없음.

**반응형 요구사항**
해당 없음.

**오류·로딩·빈 상태 요구사항**
해당 없음.

**수용 기준**
- [ ] 위 5개 전이 중 최소 3개(`off→always`, `always→off`, 빠른 연속 전환)를 단언한다.
- [ ] `app/(application)/chat/ChatPageClient.tsx`의 dependency array에서 `webSearchMode`를
      일부러 제거하면 이 테스트가 **실패한다**(확인 후 원복).
- [ ] credit matrix 단언이 포함된다.

**검증 절차**
테스트 추가 → 의도적 회귀 삽입 → 실패 확인 → 원복 → 통과 확인.

**회귀 테스트 항목**
`tests/e2e/native-web-search.spec.ts`, `tests/e2e/web-search-composer-state.spec.ts`,
`tests/webSearchCredits.test.mjs`

**완료 정의**
수용 기준 충족.

---

### TASK-11 — 상태 페이지에 실 트래픽 근거 경과 시간 표기

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-11 |
| **연결 UX 이슈** | UX-011 |
| **우선순위** | P3 |
| **예상 규모** | S |

**작업 목적**
`Operational` 배지의 신뢰 수준을 사용자가 정확히 판단하게 합니다.

**대상 화면 또는 사용자 흐름**
`/status`

**현재 문제**
현재 `Operational` 대부분이 synthetic probe 근거이고 실 트래픽 성공은 14시간 이상 지난
값인데, 경과 시간이 드러나지 않습니다. UI는 근거 유형은 밝히지만 신선도는 밝히지 않습니다.

**변경 요구사항**
real-traffic 근거가 freshness window를 크게 벗어난 경우 경과 시간을 명시합니다
(예: *"last real-traffic success 14h ago"*). **표기만 추가하고 상태 판정 로직은 변경하지
않습니다.**

**유지해야 할 기존 동작**
- `unknown`을 초록으로 렌더하지 않는 원칙
- `lib/providerPublicStatusCore.ts`의 판정 동작 불변

**예상 대상 파일 또는 컴포넌트**
- `app/(application)/status/page.tsx`
- `lib/statusPageEvidence.ts`

**선행 작업 및 의존성**
TASK-02, TASK-03 이후.

**접근성 요구사항**
경과 시간이 `<time>` 요소의 의미와 함께 전달되어야 합니다.

**반응형 요구사항**
320px에서 상태 카드 overflow 0.

**오류·로딩·빈 상태 요구사항**
근거가 전혀 없는 경우 "기록 없음"으로 명확히 표기합니다.

**수용 기준**
- [ ] `Operational` Provider의 real-traffic 근거 경과 시간이 UI에 표시된다.
- [ ] `lib/providerPublicStatusCore.ts`의 판정 결과가 변하지 않는다(단위 테스트로 확인).

**검증 절차**
staging 실측 + 단위 테스트.

**회귀 테스트 항목**
`tests/e2e/status-page.spec.ts`, `tests/e2e/provider-status.spec.ts`

**완료 정의**
수용 기준 충족.

---

### TASK-12 — Web Vitals 기준선 수립

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-12 |
| **연결 UX 이슈** | UX-012 |
| **우선순위** | P3 |
| **예상 규모** | S |

**작업 목적**
현재 SHA의 성능 기준선을 만들어 이후 회귀를 판정 가능하게 합니다.

**대상 화면 또는 사용자 흐름**
`/`, `/pricing`, `/status`, 320px 채팅

**현재 문제**
`/pricing` 외 route의 통제된 기준선이 없습니다.

**변경 요구사항**
코드 변경 없음. 동일 device/browser/network throttling/cache 조건에서 각 3–5회 측정하고
개별값·median·max를 기록합니다.

**유지해야 할 기존 동작**
해당 없음.

**예상 대상 파일 또는 컴포넌트**
없음(측정 절차). 결과 기록 위치는 `.github/audits/` 권장.

**선행 작업 및 의존성**
TASK-07 이후(수정 효과를 포함해 측정).

**접근성 요구사항**
해당 없음.

**반응형 요구사항**
모바일·데스크톱 각각 측정.

**오류·로딩·빈 상태 요구사항**
cold/warm 조건을 섞지 않습니다.

**수용 기준**
- [ ] 대상 route별 LCP·CLS의 개별값·median·max가 기록된다.
- [ ] 측정 환경(device, viewport, network, cache)이 명시된다.
- [ ] 단일 HTTP 응답 시간을 Web Vitals로 보고하지 않는다.
- [ ] 과거 감사의 단일 값을 현재 값으로 재사용하지 않는다.

**검증 절차**
측정 스크립트 실행 및 결과 기록.

**회귀 테스트 항목**
없음.

**완료 정의**
기준선 문서 작성.

---

### TASK-13 — 보조기술·모바일 키보드 표본 검증

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-13 |
| **연결 UX 이슈** | UX-013 |
| **우선순위** | P3 |
| **예상 규모** | 추가 조사 필요 |

**작업 목적**
자동 검사로 대체할 수 없는 실사용 접근성을 표본 확인합니다.

**대상 화면 또는 사용자 흐름**
랜딩, 요금제, 모델 선택, 비교 전송, 실패 복구

**현재 문제**
NVDA/JAWS, VoiceOver, TalkBack, Gboard, 삼성 키보드, iOS 한국어 키보드, 물리 모바일 기기,
물리 외부 키보드가 모두 미검증입니다. 특히 UX-001이 외부 키보드 경로에서 재현되므로
물리 키보드 확인의 가치가 큽니다.

**변경 요구사항**
코드 변경 없음. 수동 테스트 절차·기대 결과·기록 양식을 만들고 표본 검증합니다.
실기기를 사용할 수 없다면 **자동화 성공으로 대체하지 말고 각각 `Not verified`로 남깁니다.**

**유지해야 할 기존 동작**
해당 없음.

**예상 대상 파일 또는 컴포넌트**
없음(검증 절차).

**선행 작업 및 의존성**
TASK-01, TASK-06 이후.

**접근성 요구사항**
작업 자체가 접근성 검증입니다.

**반응형 요구사항**
모바일 실기기 포함.

**오류·로딩·빈 상태 요구사항**
실패 복구 흐름을 표본에 포함합니다.

**수용 기준**
- [ ] 핵심 5개 task별 기록이 존재하고 blocker 0.
- [ ] 미수행 항목은 명시적으로 `Not verified`로 남는다.

**검증 절차**
수동. 기록 양식에 따라 수행.

**회귀 테스트 항목**
없음.

**완료 정의**
표본 기록 완료 또는 미수행 사유 명시.

---

### TASK-14 — 모델 id와 표시명 대응 관계 문서화

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-14 |
| **연결 UX 이슈** | UX-014 |
| **우선순위** | P3 |
| **예상 규모** | S |

**작업 목적**
운영 로그 해석과 고객 지원 시 혼동을 줄입니다.

**대상 화면 또는 사용자 흐름**
모델 선택기 / 운영 로그

**현재 문제**
모델 id `gemini-2-5-flash`의 표시명이 `Gemini 3.1 Flash-Lite`로 세대 표기가 어긋납니다.
기능상 문제는 없습니다(요청 body는 id를 정확히 사용).

**변경 요구사항**
id 변경은 마이그레이션 위험이 크므로 기본적으로 **레지스트리에 대응 관계를 주석/문서로
남기는 선**에서 처리합니다. 리네이밍 여부는 §8 결정사항입니다.

**유지해야 할 기존 동작**
기존 id를 사용하는 저장된 대화·설정이 깨지지 않아야 합니다.

**예상 대상 파일 또는 컴포넌트**
- `lib/models.ts`

**선행 작업 및 의존성**
없음.

**접근성 요구사항**
해당 없음.

**반응형 요구사항**
해당 없음.

**오류·로딩·빈 상태 요구사항**
해당 없음.

**수용 기준**
- [ ] id ↔ 표시명이 어긋나는 항목이 레지스트리에 명시적으로 문서화된다.

**검증 절차**
코드 리뷰.

**회귀 테스트 항목**
없음.

**완료 정의**
문서화 완료.

---

### TASK-15 — 동의 배너 인라인 링크 터치 영역 검토

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-15 |
| **연결 UX 이슈** | UX-015 |
| **우선순위** | P3 |
| **예상 규모** | S |

**작업 목적**
모바일 탭 정확도를 높이되 배너 높이 계약을 깨지 않습니다.

**대상 화면 또는 사용자 흐름**
동의 배너 (marketing / chat)

**현재 문제**
본문 내 `Privacy policy` 링크가 marketing 138.2×28px, chat 74×12px입니다. WCAG 2.5.8은
인라인 텍스트 링크를 예외로 두므로 위반은 아닙니다.

**변경 요구사항**
**제약이 상충합니다.** 44×44를 강제하면 배너 높이 계약(phone ≤80px)을 깨뜨릴 수 있습니다.
어느 쪽을 우선할지 결정(§8) 후 진행합니다. 결정 전에는 착수하지 마십시오.

**유지해야 할 기존 동작**
- 배너가 `position: static`으로 slot 안에 렌더
- H1·CTA와 교차 0, overflow 0
- 동의 버튼 44×44 이상
- phone에서 배너 높이 ≤80px

**예상 대상 파일 또는 컴포넌트**
- `components/analytics/AnalyticsProvider.tsx`

**선행 작업 및 의존성**
§8 결정사항 해소 후.

**접근성 요구사항**
링크의 accessible name과 포커스 표시를 유지합니다.

**반응형 요구사항**
320–430px 및 chat slot 폭에서 모두 검증합니다.

**오류·로딩·빈 상태 요구사항**
해당 없음.

**수용 기준**
- [ ] 결정된 방향에 따라 링크 터치 영역이 개선되거나, 현행 유지 결정이 문서화된다.
- [ ] 배너 높이 ≤80px(phone), 동의 버튼 44×44, 교차 0, overflow 0이 유지된다.

**검증 절차**
6개 viewport 실측.

**회귀 테스트 항목**
`tests/e2e/marketing-consent-hero.spec.ts`, `tests/e2e/analytics-consent.spec.ts`,
`tests/e2e/touch-targets.spec.ts`

**완료 정의**
수용 기준 충족 또는 현행 유지 결정 문서화.

---

### TASK-16 — 테스트 실행 모드 독립성 확보

| 항목 | 내용 |
|---|---|
| **작업 ID** | TASK-16 |
| **연결 UX 이슈** | UX-016 |
| **우선순위** | P3 |
| **예상 규모** | M |

**작업 목적**
CI 결과가 실행 방식과 무관하게 동일한 의미를 갖게 합니다.

**대상 화면 또는 사용자 흐름**
QA 파이프라인

**현재 문제**
`chat-keyboard-policy.spec.ts` 모바일 테스트가 파일 전체 실행에서는 9/9 통과하고 단독
실행에서는 5회 중 2회 실패합니다. 실행 순서·초기화 의존성이 있음을 시사합니다. 또한 로컬
`retries: 0` / CI `retries: 2` 차이로 CI에서 불안정성이 가려집니다.

**변경 요구사항**
1. 테스트 간 공유 상태·초기화 의존성을 제거합니다.
2. **timeout 증량이나 retry로 덮지 마십시오.**
3. 단독 재실행 1회 통과로 해결을 주장하지 마십시오.

**유지해야 할 기존 동작**
`lib/chatKeyboardPolicy.ts`의 정책은 올바르므로 변경하지 않습니다.

**예상 대상 파일 또는 컴포넌트**
- `tests/e2e/chat-keyboard-policy.spec.ts`
- `tests/e2e/support/app-fixtures.ts`
- `playwright.config.ts` (retries 정책 검토)

**선행 작업 및 의존성**
TASK-01과 함께 처리 권장(원인이 공유될 가능성이 높음).

**접근성 요구사항**
해당 없음.

**반응형 요구사항**
해당 없음.

**오류·로딩·빈 상태 요구사항**
해당 없음.

**수용 기준**
- [ ] 동일 테스트가 단독 실행과 파일 전체 실행에서 **동일한 결과**를 낸다(각 20회).
- [ ] 원인과 수정 내용이 커밋 메시지에 기록된다.

**검증 절차**
단독 실행 20회 + 파일 전체 실행 20회 결과 대조.

**회귀 테스트 항목**
`tests/e2e/chat-keyboard-policy.spec.ts` 전체

**완료 정의**
수용 기준 충족.

---

## 5. 공통 검증 기준

### 각 작업 후

```bash
npm run typecheck
npx eslint . --max-warnings=0
npm run test:unit
npm run security:regression
npm run check:encoding:strict
```

### 전체 완료 후

```bash
npm run build
npm run verify:smoke-coverage
npx playwright test --project=desktop-chromium --project=desktop-compact --project=mobile-chromium
```

- **E2E 실패 0이어야 합니다.** 현재 기준선은 829 pass / 4 fail / 511 skip입니다.
- flake 판정이 필요한 스펙은 **격리 상태로 최소 5회, P1 관련은 20회 반복**해 실패 0을
  확인합니다.
- 관련 UI를 수정했다면 `npm run test:e2e:visual`(골든)을 실행하고, 변화가 있으면
  **무검토 갱신하지 말고 diff를 검토**합니다.

### 회귀 확인 (필수)

`tests/e2e/marketing-consent-hero.spec.ts`, `tests/e2e/native-web-search.spec.ts`,
`tests/e2e/web-search-composer-state.spec.ts`, `tests/pricingFormat.test.mjs`,
`tests/e2e/provider-status.spec.ts`, `tests/e2e/status-page.spec.ts`,
`tests/e2e/build-info.spec.ts`, `tests/e2e/touch-targets.spec.ts`

### staging 검증 (TASK-02, 03, 04, 07, 11)

```bash
curl -s https://staging.tomverse.app/api/build-info
curl -s https://staging.tomverse.app/api/models/status
curl -s https://staging.tomverse.app/status
```

`/api/build-info`의 `commitSha`가 배포한 커밋과 일치하는지 **먼저** 확인합니다.
**staging SHA와 local/origin SHA가 다르면 검증 결과를 신뢰하지 마십시오.**
`/status`와 `/api/models/status`는 **같은 시각에** 조회해 대조합니다.

### 환경 문제와 제품 실패의 분리

브라우저 설치·인증서·sandbox·network 문제는 환경 문제로 기록하고 안전한 대체 실행 환경을
사용합니다. **TLS 검증을 끄거나 보안 설정을 약화하지 않습니다.**

---

## 6. 완료 조건

- [ ] TASK-01–04 완료 — **출시 차단 해소**
- [ ] TASK-05 검증 경로 확보 또는 자격증명 요청 및 `Not verified` 명시
- [ ] TASK-06–08 완료
- [ ] TASK-09–16 완료 또는 미완료 사유 명시
- [ ] 전체 E2E 실패 0, unit 실패 0, lint 경고 0, security regression 통과
- [ ] §2의 회귀 금지 항목 전부 유지
- [ ] `/status`와 `/api/models/status`가 동일 시각에 모순 없음
- [ ] 미검증 항목을 `Go` 근거로 사용하지 않음

---

## 7. 범위 제외 항목

| 항목 | 사유 |
|---|---|
| production 배포 및 production credential 경로 | 감사 범위 외 |
| Provider 응답 **내용**의 사실 정확도 | 가용성 검증과 분리 |
| RTL locale 대응 | 지원 7개 locale(en/ko/zh/fr/de/es/pt)에 RTL 없음 |
| 가격 **계산** 로직 변경 | 표시·레이아웃만 대상 |
| 대규모 리팩터 및 무관한 코드 정리 | 최소 범위 원칙 |
| `catalogDeleted` 자동 설정 | 사람의 결정으로 유지 |
| CSP 완화를 통한 third-party 도입 | 명시적 금지 |
| 게스트 Turnstile 보호 약화 | 명시적 금지 |
| `REPORT_FINAL_KO.md` 복원 | 원본 부재. 필요 시 별도 과제 |

---

## 8. 구현 전 확인이 필요한 결정사항

| # | 결정사항 | 영향 작업 | 판단 불가 사유 |
|---|---|---|---|
| 1 | 모델 API가 공개 판정을 그대로 반영할지(A), 분리 유지 + 채팅 경고(B) | TASK-02 | 두 소스의 분리가 의도된 설계인지 단순 누락인지 현재 자료로 판단 불가 |
| 2 | staging 인증 계정 자격증명 제공 여부 | TASK-05 | 게스트 경로로는 전체 AI Review 검증 불가 |
| 3 | 이미 은퇴 모델을 선택해 둔 사용자의 처리 정책 | TASK-04 | 제품 정책 결정 |
| 4 | 모델 id 리네이밍 감수 여부 | TASK-14 | 마이그레이션 위험 대비 이득 판단 필요 |
| 5 | 배너 높이 계약(≤80px)과 인라인 링크 44×44 중 우선순위 | TASK-15 | 두 제약이 상충 |
| 6 | 골든 스위트를 PR 게이트로 되돌릴지 여부 | 공통 검증 | 현재 nightly로 이동(커밋 `8d02fc1`, 의도된 트레이드오프). 출시 직전 수동 실행으로 갈음할지 결정 필요 |
