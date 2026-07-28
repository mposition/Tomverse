# Tomverse Insight 최종 UX 감사 작업명령서 (개정 1)

> **이 문서는 외부 측 `Tomverse-Insight-UX-Audit-Final-Work-Order.md`의 개정본입니다.**
> WO 번호·구조·문체를 그대로 유지했고, 변경한 부분에만 `[개정 1]` 표시를 넣었습니다.
> 표시가 없는 문단은 원문 그대로이므로 diff로 변경점만 확인할 수 있습니다.
>
> **개정 근거**: 2026-07-28 02:16 UTC 교차검증. 원문이 "환경 제약으로 확인 불가"로 남긴
> 항목을 실측했고, 재현율·기준선·대상 파일 3건의 사실관계를 정정했습니다.
>
> **개정 요약 (5건 + 1)**
> 1. WO-001 대상 파일에서 `lib/chatKeyboardPolicy.ts`를 **변경 금지**로 명시
> 2. WO-001 재현율을 실측치로 교체 (`1920 0/3` → 약 29%, 20회 반복 필요)
> 3. 기준선을 `e062da86` / deployment `95bee9e2`로 갱신
> 4. UX-F002·UX-F003 증거 등급 `부분 확인됨` → **`확인됨`** (동일 시점 대조 완료)
> 5. WO-001에 테스트 실행 모드 의존성 요구사항 추가
> 6. (추가) §2에 수치가 명시된 회귀 금지 불변조건 블록 신설

## 1. 작업 목적과 범위

이 작업명령서는 `Tomverse-Insight-UX-Audit-Final-Report.md`에서 채택한 13개 최종 이슈를 구현 가능한 10개 작업으로 전환한다. 구현자는 원본 감사 문서를 다시 읽지 않아도 각 문제, 유지 조건, 수용 기준과 검증 절차를 이해할 수 있어야 한다.

### 목표

- chat 핵심 전송 흐름의 비결정적 실패 제거
- Provider 상태·model availability·picker/chat 의미 통합
- retired/disabled 모델 노출 제거
- comparison preflight와 web-search/credit 계약 강화
- pricing 접근성 및 레이아웃 안정성 개선
- 접근성·visual regression·운영 검증 공백 해소

### 기준

- 제품 repository: `C:\Project\Tomverse`
- 감사 기준 SHA: `8d02fc1d35f988d5c9d61ab9463fea01a3f0b3b6`

**[개정 1] 기준선 갱신**

- 현재 `origin/develop`: `e062da86bf572c2076f56fe41726fefd0dfd4c75`
- **staging도 같은 SHA로 재배포됨**: deployment `95bee9e2-d705-4398-8b1f-5e7eebea1e8f`,
  builtAt `2026-07-28T01:38:42.881Z`, deployedAt `2026-07-28T01:40:31.481Z`, `success`
- 감사 기준 SHA와 `e062da86`의 차이는 `.github/audits/final-stg-reaudit-2026-07-28.md`
  추가 **1건뿐이며 `app`/`components`/`lib`/`tests`/`scripts`/`package.json` 제품 소스
  변경은 0건**이다. 따라서 모든 작업이 그대로 유효하다.
- **작업 시작 시 `e062da86` 이후 추가 변경 여부를 다시 확인한다.** 이전 판(`2351b283`
  deployment)을 기준으로 검증 결과를 기록하지 않는다.
- 연결 보고서: `C:\Project\Tomverse\Tomverse-Insight-UX-Audit-Final-Report.md`

## 2. 구현 원칙

1. 작업 시작 시 `AGENTS.md`와 해당 기능의 `node_modules/next/dist/docs/` 문서를 읽는다.
2. 사용자의 기존 modified/untracked 파일을 보존하고 관련 없는 refactor를 하지 않는다.
3. symptom, fixture, timeout을 조정하기 전에 root cause를 재현한다.
4. assertion 삭제·약화, 무조건 retry, timeout 증가, test skip, snapshot 무검토 갱신으로 완료 처리하지 않는다.
5. UI, API, server guard, model registry, credit ledger가 가능한 한 하나의 의미 계약을 공유하게 한다.
6. CSP에 `unsafe-inline`, `unsafe-eval`, wildcard 또는 Cloudflare Browser Insights origin을 추가하지 않는다.
7. 실제 Provider 호출, credit 소비, catalog cron, staging/production 배포, consent 영구 변경은 사용자 승인 후에만 실행한다.
8. 실제 호출이 없는 자동화 결과를 운영 가용성이나 실제 과금 검증으로 표현하지 않는다.
9. model ID는 비밀이 아니다. 지원·운영 추적에 필요한 model ID는 문서화하되 API key, token, cookie, session identifier, 사용자 prompt/file 내용은 기록하지 않는다.
10. 제품 상태와 test fixture가 충돌하면 제품 요구사항을 먼저 확인하고 fixture를 실제 계약에 맞춘다.

### [개정 1] 2-A. 회귀 금지 불변조건 (수치 기준)

아래는 두 감사가 **해결을 확인한 동작**이다. 모든 작업 후 아래 수치가 그대로 성립해야 하며,
"유지했다"는 판단은 이 수치로만 한다.

| 영역 | 불변조건 |
|---|---|
| 마케팅 동의 배너 | `getComputedStyle().position === "static"`, `[data-testid="marketing-consent-slot"]` 내부에 렌더 |
| 동의 배너 ↔ 콘텐츠 | H1 교차 **0 px²**, `#landing-hero-primary` 교차 **0 px²** |
| CTA 조작성 | CTA 중심 `document.elementFromPoint()`가 CTA 자신에 도달 |
| 동의 액션 | Decline·Accept 모두 **44×44 이상** (실측 61.1×44 / 51.3×44) |
| 배너 높이 | phone 기준 **≤ 80px** |
| 배너 본문 폭 | 320px에서 **≥ 130px** |
| 가로 overflow | 320 / 360 / 375 / 390 / 430 / landscape 및 `/`·`/pricing`·`/privacy`·guest chat 전부 **0** |
| reflow | 320 CSS px(=1280@400%)와 640 CSS px(=1280@200%)에서 overflow **0** |
| header brand | 항상 완전한 단어(`Tomverse` / `Tomverse Insight`), `scrollWidth ≤ clientWidth + 1`, header overflow **0** |
| 마케팅 3rd-party | 요청 **0건**, console error **0건** |
| 동의 게이팅 | 동의 전 GA/GTM **0건**, 거부 후 **0건**, 수락 후에만 실행 |
| CSP | production script-src에 `unsafe-inline`·`unsafe-eval`·wildcard **없음**, Cloudflare Insights origin **없음** |
| 보안 헤더 | `/chat` `no-store`, HSTS 1년 includeSubDomains, `nosniff`, frame `DENY`, strict referrer, restrictive Permissions-Policy |
| security regression | **113건 이상 전부 통과** |
| preflight 계약 | `/api/chat/preflight` body가 UI의 현재 `webSearchMode`를 그대로 전달 (stale 0건) |
| credit | native 지원 모델당 **+8**, unsupported·bundled **+0**, `off`/`auto` **+0** |
| pricing 시각 문법 | `1 credit`, `2 credits`, `A$10.00 per month`, `Regular: A$20.00 per month`, 한국어 `/ 월` |
| guest 첫 페인트 | 기본 **3 models / 3 credits**, hydration 전후 불변 |
| 모바일 요약 | `GPT-5.4 mini +2`, composer `3 AIs`와 일치 |
| build-info | environment / full·short SHA / builtAt / deploymentId / startedAt / deployedAt / status 8개 필드, 실제 배포와 일치, secret 노출 0 |

## 3. 작업 순서 및 의존성

```text
WO-001 Chat send 안정화
    └─ WO-004 Preflight·web-search 계약

WO-002 Provider 상태 정책
    ├─ WO-003 Registry 정합성
    └─ WO-009 Model identity 문서

WO-005 Pricing a11y·CLS

WO-006 Mobile test 계약
WO-007 접근성 검증
WO-008 Visual release gate

WO-010 승인된 운영 검증
    └─ WO-001, WO-002, WO-003, WO-004 완료 후
```

권장 실행 순서:

1. WO-001
2. WO-002
3. WO-003
4. WO-004
5. WO-005
6. WO-006
7. WO-007
8. WO-008
9. WO-009
10. WO-010

## 4. 작업 목록

### WO-001 — Chat send/render pipeline의 결정성 확보

- **작업 ID:** WO-001
- **연결된 UX 이슈 ID:** UX-F001
- **제목:** 1920px desktop 및 mobile external-keyboard 전송 race 제거
- **우선순위:** P1
- **작업 목적:** 사용자가 어떤 지원 입력 방법을 사용해도 전송한 메시지가 main panel에 정확히 한 번 표시되고 conversation·request 상태와 일치하게 한다.
- **대상 화면 또는 사용자 흐름:** authenticated new chat, desktop Enter, mobile Ctrl/Cmd+Enter, retry
- **현재 문제:**

  전송 시 textarea는 비워지고 sidebar conversation은 생성되지만 main panel이 empty state에 남는다.

  **[개정 1] 실측 재현율 — 원문의 `1920 0/3`, `Ctrl+Enter 4/6`을 아래로 교체한다.**
  원문 수치는 교차검증 환경에서 재현되지 않았다. 결정적 실패가 아니라 **간헐 실패**이며,
  적은 횟수만 돌려보고 "이미 고쳐졌다"고 판단하면 안 된다.

  | 프로젝트 | 테스트 | 실측 |
  |---|---|---|
  | desktop-chromium (1920×1080) | `Enter sends the message exactly once` | 약 24회 중 7회 실패 (**~29%**) |
  | desktop-compact (1366×768) | 동일 | 6회 중 1회 실패 (**~17%**) |
  | mobile-chromium | `sends from an external keyboard` (Ctrl/Cmd) | 5회 중 2회 실패 (**~40%**, 단독 실행) |
  | mobile-chromium | 위 spec **파일 전체** 실행 | **9/9 통과 ×3회** |

  실패 시 관측되는 정확한 신호:

  ```
  Error: expect(locator).toHaveCount(expected) failed
  Locator: locator('[data-message-role="user"]').filter({ hasText: 'PC Enter send' })
  Expected: 1   Received: 0   Timeout: 5000ms
    - 14 × locator resolved to 0 elements
  ```

  5초 동안 14회 폴링에도 사용자 자신의 메시지가 0개다. 타이밍 여유 부족이 아니라 렌더 자체가
  누락된 것으로 해석해야 한다.

  **[개정 1] 실행 모드 의존성**: 같은 테스트가 파일 전체 실행에서는 통과하고 단독 실행에서는
  실패한다. 테스트 간 초기화·공유 상태 의존이 있다는 뜻이며, 이는 root cause의 단서인 동시에
  독립적인 CI 신뢰성 문제다. 로컬 `retries: 0` / CI `retries: 2` 차이로 CI에서는 이
  불안정성이 가려진다.

- **변경 요구사항:**
  1. conversation 생성, active ID 설정, optimistic message 추가, router 전환, API dispatch의 실제 순서를 계측해 root cause를 확정한다.
  2. 버튼·Enter·Ctrl/Cmd+Enter가 하나의 authoritative send function을 사용하게 한다.
  3. active conversation과 message store가 바뀌는 순간 stale closure가 이전 ID나 empty-state를 참조하지 않게 한다.
  4. optimistic user message를 request 전 안정적으로 렌더하고 성공·실패·retry에서 같은 ID로 reconcile한다.
  5. 중복 submit guard는 유지하되 정상 첫 submit을 삼키지 않게 한다.
  6. **[개정 1]** 테스트 간 공유 상태·초기화 의존성을 제거해 **단독 실행과 파일 전체 실행이
     동일한 결과**를 내게 한다. 이 항목을 timeout 증량이나 retry로 해결하지 않는다.
     제품 초기화 순서가 원인이면 제품을, fixture가 원인이면 fixture를 고치되 어느 쪽인지
     근거와 함께 기록한다.
- **유지해야 할 기존 동작:**
  - desktop Enter 전송
  - Shift+Enter 줄바꿈
  - mobile Enter 줄바꿈
  - Ctrl/Cmd+Enter 전송
  - `isComposing` 및 `keyCode === 229` 중 전송 차단
  - textarea clear/focus 정책
  - retry와 Report error
  - **[개정 1]** §2-A 회귀 금지 불변조건 전체
- **예상 대상 파일 또는 컴포넌트:**
  - `app/(application)/chat/ChatPageClient.tsx` — `handleGlobalSubmit`, `activeChatId` 결정, `setCurrentChatId`, 대화 생성 분기
  - `components/chat/ChatApp.tsx` — 메시지 상태와 전송 요청
  - `components/chat/ChatInput.tsx` — `handleKeyDown`
  - `components/chat/DesktopChatShell.tsx`
  - `components/chat/MobileChatShell.tsx`
  - `tests/e2e/chat-keyboard-policy.spec.ts`
  - `tests/e2e/support/app-fixtures.ts`
  - **[개정 1] `lib/chatKeyboardPolicy.ts` — 참조용. 변경 금지.**
    이 파일의 정책(`isComposing` 또는 `keyCode === 229` 차단, PC Enter 전송 /
    Shift+Enter 줄바꿈 / 모바일 Enter 줄바꿈 / Ctrl·Cmd+Enter 전송)은 두 감사가 모두
    올바르다고 확인했고 단위 테스트도 통과한다. 이번 결함은 키 정책이 아니라 전송 이후의
    상태·렌더 경로에 있다. **이 파일을 수정하면 원인과 무관한 회귀를 만든다.**
- **선행 작업 및 의존성:** 없음. WO-004보다 먼저 수행.
- **접근성 요구사항:** IME 조합 보호, keyboard-only 완료, visible focus, 실패 메시지의 인지 가능한 announcement.
- **반응형 요구사항:** 1920×1080, 1440×900, 1366×768, 420px, mobile viewport에서 동일한 message 결과.
- **오류·로딩·빈 상태 요구사항:** send 후 empty-state가 유지되면 안 된다. 실패 시 optimistic message와 panel error가 같은 conversation에 남고 retry 가능해야 한다.
- **수용 기준:**
  - main panel user message 정확히 1개
  - sidebar active conversation ID와 main panel conversation ID 일치
  - `/api/chat` request count 기대값과 일치
  - duplicate message/request 0
  - 전송 후 composer focus 정책 일치
  - **[개정 1]** 동일 테스트가 **단독 실행 20회와 파일 전체 실행 20회에서 같은 결과**
    (양쪽 모두 실패 0)
- **검증 절차:**
  - 1920, 1440, 1366, 420에서 desktop Enter를 clean context로 각 20회
  - mobile Ctrl+Enter와 Cmd+Enter를 각 20회
  - Shift+Enter, multiline, IME, on-screen send, error/retry 포함
  - 최초 실패와 수정 후 반복 수치를 모두 기록
  - **[개정 1]** Playwright `-g` 필터로 반복할 때 **테스트명에 포함된 `+`가 정규식
    수량자로 해석되어 0건 매칭**될 수 있다(`-g "Ctrl+Enter …"`는 아무 테스트도 고르지
    못한다). 매칭 건수를 먼저 확인하고, 0건 매칭을 실패로 집계하지 않는다.
    교차검증에서 실제로 이 오류로 6/6 허위 실패가 집계된 바 있다.
- **회귀 테스트 항목:** `chat-keyboard-policy`, authenticated bootstrap, conversation creation/title, mobile summary, comparison layout
- **완료 정의:** 모든 필수 조합에서 20회 연속 failure 0이며 원인과 state sequence가 PR에 설명됨. **[개정 1]** 실행 모드에 따른 결과 차이 0.
- **예상 작업 규모:** L

### WO-002 — Provider public status와 model/chat availability 통합

- **작업 ID:** WO-002
- **연결된 UX 이슈 ID:** UX-F002, UX-F010
- **제목:** Provider 상태의 단일 정책 projection 및 evidence-age 표시
- **우선순위:** P1
- **작업 목적:** `/status`, `/api/models/status`, picker, default trio, banner, send guard가 같은 근거와 시각을 사용하게 한다.
- **대상 화면 또는 사용자 흐름:** public status 확인, model picker, 기본 비교 모델, 장애/복구 전환
- **현재 문제:**

  Perplexity는 오래된 202회 probe failure 때문에 Incident지만 model status는 available이었다. Google이 Degraded/Incident였던 시점에도 기본 Gemini 경고가 없었다.

  **[개정 1] 증거 등급 `부분 확인됨` → `확인됨`.** 원문은 `/api/models/status`를 다시 읽지
  못해 부분 확인으로 두었으나, 교차검증에서 두 endpoint를 **동일 시점에** 조회해 확정했다.

  `2026-07-28T02:16:19Z` (`/api/models/status`의 `generatedAt`이 초 단위로 일치):

  | 소스 | 결과 |
  |---|---|
  | `/status` | 11개 Provider 중 **Perplexity만 Incident**, 나머지 10개 Operational |
  | `/api/models/status` | **33개 모델 전부 `available`, non-available 0건**, `fallbackModelIds` 전부 `[]` |

  즉 가용성 투영이 사실상 **상수**이며 공개 판정을 전혀 반영하지 않는다. 이는 "두 소스가
  가끔 어긋난다"보다 강한 사실이므로, 수정은 개별 상태 매핑이 아니라 **투영 자체의
  재설계**여야 한다.

  Perplexity의 `Last automated check`는 `2026-07-27 23:30 UTC`로 고정되어 있고 나머지
  Provider는 계속 갱신된다. 즉 프로브 대상이 아닌 Provider의 실패 카운터가 동결되어 영구
  Incident가 된 것이다.

- **변경 요구사항:**
  1. `operational`, `degraded/limited`, `incident/unavailable`, `unknown`, `disabled/retired`의 Provider→model mapping을 명시한다.
  2. `no_probe_model`은 과거 probe failure를 현재 장애 증거로 계속 사용하지 않도록 neutralize한다.
  3. probe 불가 Provider는 real-traffic evidence가 없으면 `unknown`으로 귀결시키고 “probe 실패” 문구를 표시하지 않는다.
  4. model status route가 공개 health projection 또는 명시적으로 합의된 동일 policy를 사용하게 한다.
  5. incident/degraded 모델의 fallback, warning, send 가능 여부를 명시한다.
  6. synthetic/real evidence source와 actual age를 빠르게 읽을 수 있게 표시한다.
  7. **[개정 1]** 판정은 `lib/providerPublicStatusCore.ts`의 순수 함수 안에서 결정되게
     유지한다. 공개 페이지와 admin 패널이 각자 판정을 유도하지 않는 기존 설계를 깨지 않는다.
- **유지해야 할 기존 동작:**
  - 성공 근거 없음 → Operational 금지
  - Unknown 중립 표시
  - probe와 real traffic evidence 분리
  - scheduler 지연과 Provider 장애 분리
  - rate limit, DB fallback, cache policy
- **예상 대상 파일 또는 컴포넌트:**
  - `lib/providerPublicStatusCore.ts`
  - `lib/providerMonitoring.ts`
  - `lib/providerProbe.ts`
  - `app/api/internal/provider-probe/check/route.ts`
  - `app/api/models/status/route.ts`
  - `app/(application)/status/page.tsx`
  - `lib/statusPageEvidence.ts`
  - model picker/chat warning 관련 컴포넌트
- **선행 작업 및 의존성:** 제품 책임자의 degraded/incident 정책 결정 필요. **[개정 1]** §8에 기본 권고가 있으므로, 회신이 지연되면 기본 권고로 착수하고 결정 후 조정한다.
- **접근성 요구사항:** 색만으로 상태를 전달하지 않고 label·reason·timestamp 제공. live update는 과도한 announcement를 피한다.
- **반응형 요구사항:** 320px에서도 provider, state, evidence source, age가 의미 손실 없이 읽혀야 한다.
- **오류·로딩·빈 상태 요구사항:** dashboard 실패 시 근거 없는 available/operational을 반환하지 않고 Unknown 및 재시도 가능한 설명 표시.
- **수용 기준:**
  - 동일 generatedAt fixture에서 모든 surface의 Provider 판정 일치
  - no-probe + 과거 failure 입력은 Incident가 아님
  - incident 모델은 fallback 또는 명확한 차단/경고 제공
  - stale real traffic age가 status UI에 표시
  - **[개정 1]** staging 배포 후 `/status`와 `/api/models/status`를 **같은 시각에** 조회해
    Provider별 판정 모순 **0건**. 특히 `/api/models/status`의 non-available 개수가
    공개 판정과 일관되게 변하는지 확인한다(현재는 항상 0).
- **검증 절차:**
  - table-driven unit: Operational, Degraded, Incident, Unknown, stale, recovered, no-probe
  - route contract: `/status` projection과 `/api/models/status`
  - E2E: default model incident/degraded banner와 replacement
  - 배포 후 같은 시각 두 endpoint 비교
  - **[개정 1]** 비교 전 `/api/build-info`의 `commitSha`가 배포한 커밋과 일치하는지 먼저
    확인한다. 불일치 상태의 관측은 기록하지 않는다.
- **회귀 테스트 항목:** provider-status, status-page, build-info, E2E DB fallback, cache/rate-limit
- **완료 정의:** 같은 snapshot에서 API/UI/chat 모순 0, no-probe 허위 Incident 0.
- **예상 작업 규모:** L

### WO-003 — Retired/disabled 모델의 public 노출 차단

- **작업 ID:** WO-003
- **연결된 UX 이슈 ID:** UX-F003
- **제목:** Model Registry public projection과 reconciliation 정합화
- **우선순위:** P1
- **작업 목적:** 사용자가 선택 가능한 모델과 실제 호출 가능한 모델을 일치시킨다.
- **대상 화면 또는 사용자 흐름:** model picker, model status API, 저장된 conversation 복원
- **현재 문제:**

  static seed에서는 `llama-4-scout`가 hidden/disabled지만 runtime DB row가 public 상태를 유지해 API에 available로 노출된 증거가 있다.

  **[개정 1] 증거 등급 `부분 확인됨` → `확인됨`.**

  - 정적 소스: `lib/models.ts`의 `llama-4-scout`는
    `publiclyListed: false, enabled: false, status: "disabled", replacementModelId: "llama-3-3"`
  - 라이브: `/api/models/status`에서 `2026-07-28T01:52:08Z`와
    **재배포(`e062da86`) 이후인 `02:16:19Z`** 모두 `available`, `fallbackModelIds: []`
  - 따라서 **배포 타이밍이나 reconciliation 미실행 대기 문제가 아니다.** 이미 배포된
    reconciliation이 이 row를 내리지 못하고 있다는 뜻이므로, 크론 1회 실행으로 해결되는지
    반드시 실측 확인이 필요하다.
  - 실제 호출은 HTTP 404다(카탈로그 스캔 7회 연속 누락, `missingSinceAt`
    `2026-07-21T03:40:12.564Z`).

- **변경 요구사항:**
  1. public model selector가 `publiclyListed`, `enabled/status`, `catalogDeleted`, lifecycle 상태를 일관되게 적용하게 한다.
  2. runtime DB가 authoritative라는 기존 원칙을 유지하되 retired 판정의 reconciliation이 실제 row에 반영되게 한다.
  3. 운영 승인을 받은 뒤 catalog monitor를 한 번 실행해 전/후 상태를 확인한다.
  4. 기존 대화에 retired 모델이 저장돼 있으면 replacement 안내와 안전한 재선택 경로를 제공한다.
  5. 모델을 단지 `lib/models.ts`에서만 삭제해 해결한 것으로 처리하지 않는다.
  6. **[개정 1]** 크론 실행 후에도 반영되지 않으면 다음을 점검한다.
     - `PROVIDER_MODEL_CATALOG_AUTO_DISABLE`이 `false`로 설정되어 있는지
     - "한 Provider의 enabled 라인업 전체를 한 번에 비활성화하지 않는다" 보호장치가
       `PROVIDER_MODEL_CATALOG_RECONCILIATION_HELD`로 이 건을 보류시키고 있는지
- **유지해야 할 기존 동작:** historical conversation readability, human-controlled `catalogDeleted`, registry audit trail, replacement mapping.
- **예상 대상 파일 또는 컴포넌트:**
  - `lib/modelRegistry.ts`
  - `lib/providerModelCatalogReconciliation.ts`
  - `lib/providerModelCatalogCore.ts`
  - `app/api/models/status/route.ts`
  - `components/ModelCatalogProvider.tsx`
  - model picker 관련 컴포넌트
- **선행 작업 및 의존성:** WO-002 정책. catalog cron 실행은 별도 승인.
- **접근성 요구사항:** unavailable/replacement 안내가 이름·상태·action을 명확히 제공.
- **반응형 요구사항:** mobile picker에서 안내와 대체 action이 잘리거나 sheet 밖으로 밀리지 않음.
- **오류·로딩·빈 상태 요구사항:** 저장된 retired 모델 복원 시 silent failure 대신 replacement 또는 제거 안내.
- **수용 기준:**
  - public API와 picker에 `llama-4-scout` 선택 가능 항목 0
  - unavailable로 유지한다면 replacement ID와 사용자 안내 존재
  - 실제 route handler contract가 mock 없이 통과
  - **[개정 1]** 크론 수동 실행의 **시각·방법·전후 응답**이 PR에 기록됨
- **검증 절차:** registry seed/DB unit, route integration, picker E2E, 저장 conversation migration case, 승인 후 staging API 전/후 비교.
- **회귀 테스트 항목:** model recommendations, registry DB, catalogue reconciliation, attachments/comparison fallback.
- **완료 정의:** public projection과 runtime availability가 일치하고 retired selection 0.
- **예상 작업 규모:** M

### WO-004 — Comparison preflight readiness 및 web-search/credit 계약

- **작업 ID:** WO-004
- **연결된 UX 이슈 ID:** UX-F005, UX-F006
- **제목:** auth/bootstrap race 제거와 exact preflight mode contract 추가
- **우선순위:** P2
- **작업 목적:** authenticated comparison의 safety preflight가 항상 실행되고 UI·preflight·chat·credit이 같은 web-search mode를 사용하게 한다.
- **대상 화면 또는 사용자 흐름:** 2/3-model comparison, web-search toggle, 즉시 submit, safety-limit 429
- **현재 문제:**

  fixture/auth readiness race에서 7회 중 1회 preflight reject에도 `/api/chat` mock이 호출됐다. repo에는 preflight body transition을 고정하는 exact test가 없다.

  **[개정 1] 교차검증 결과 보강.**
  - 해당 테스트는 교차검증 환경에서 **8/8 통과로 재현되지 않았다**(합산 15회 중 1회, 약 7%).
  - 그러나 이 작업의 우선순위 근거는 flake가 아니다. **현재 테스트가 `/api/chat` 자체를
    mock하므로 서버측 권위 가드의 "Provider adapter 호출 0회·credit mutation 0"이 어떤
    테스트로도 증명되지 않는다.** 이 커버리지 공백은 flake 재현 여부와 무관하게 성립하며,
    변경 요구사항 3번과 수용 기준 2번이 이를 겨냥한다.
  - 참고로 preflight body의 `webSearchMode` 자체는 감사 전용 스펙에서 5개 전이
    (`off` / `off→always` / `always→off` / 즉시 submit / 빠른 연속 전환) 모두 일치하며
    stale 0건으로 확인되었다. 즉 **제품 동작은 현재 올바르고, 없는 것은 회귀 보호다.**

- **변경 요구사항:**
  1. authenticated/session/settings/conversation/selected models readiness를 명시적인 state로 정의한다.
  2. 준비 전 comparison submit을 disable하거나 안전하게 queue하며 guest/1-model로 오판하지 않게 한다.
  3. server chat route를 최종 권위 guard로 유지해 client preflight가 빠져도 Provider adapter와 credit mutation이 0이 되게 한다.
  4. UI, preflight, chat body, provider tool, credit estimate가 동일 mode/capability helper를 사용한다.
  5. `off`, `off→always`, `always→off`, 즉시 submit, 빠른 연속 toggle, model/conversation 변경을 exact capture한다.
  6. native 지원 수 0/1/2/3, mixed, unsupported, Perplexity bundled surcharge를 검증한다.
  7. **[개정 1]** 공용 fixture `tests/e2e/support/app-fixtures.ts`의 preflight 핸들러는
     현재 body에서 `comparisonId`와 `modelIds`만 읽는다. `webSearchMode`를 읽고 단언할 수
     있도록 확장하되 기존 스펙을 깨지 않는다.
- **유지해야 할 기존 동작:**
  - mode off의 chat body field omission
  - native 지원 모델당 +8
  - unsupported와 bundled search +0
  - input multiplier의 surcharge 중복 적용 금지
  - insufficient credit의 친절한 toast/way out
- **예상 대상 파일 또는 컴포넌트:**
  - `app/(application)/chat/ChatPageClient.tsx`
  - `app/api/chat/preflight/route.ts`
  - `app/api/chat/route.ts`
  - `lib/webSearchCredits.ts`
  - `lib/webSearchCapability.ts`
  - `tests/e2e/support/app-fixtures.ts`
  - `tests/e2e/native-web-search.spec.ts`
  - `tests/e2e/upgrade-discovery.spec.ts`
  - 신규 또는 기존 preflight contract spec
- **선행 작업 및 의존성:** WO-001의 send pipeline.
- **접근성 요구사항:** readiness/blocked/unsupported 상태를 chip 색상만으로 전달하지 않음.
- **반응형 요구사항:** mobile tool sheet에서 toggle 직후 submit과 partial-support 설명이 조작 가능.
- **오류·로딩·빈 상태 요구사항:** preflight 429에서 Provider panel에 `Unexpected response`를 만들지 않고 request 시작 전 명확히 중단.
- **수용 기준:**
  - client preflight 429에서 `/api/chat` request 0
  - 방어적으로 server chat이 호출돼도 Provider adapter 0, credit reserve/mutation 0
  - 모든 mode 전환에서 UI/preflight/chat/credit breakdown 일치
  - 20회 반복 failure 0
- **검증 절차:** 단일·병렬 worker 20회, route/adapter spy integration, table-driven surcharge test, dependency 제거 시 test가 실패하는 mutation check 후 원복.
- **회귀 테스트 항목:** web-search composer state, native search, comparison credit, conversation mode persistence.
- **완료 정의:** stale mode·preflight bypass·잘못된 surcharge 0.
- **예상 작업 규모:** L

### WO-005 — Pricing accessible text 및 layout stability

- **작업 ID:** WO-005
- **연결된 UX 이슈 ID:** UX-F007, UX-F008
- **제목:** 가격 낭독 문자열과 mobile cold-load CLS 수정
- **우선순위:** P2
- **작업 목적:** 가격과 기간이 자연스럽게 읽히고 billing config hydration 중 카드가 이동하지 않게 한다.
- **대상 화면 또는 사용자 흐름:** `/pricing`, EN/KO/DE/FR, promotion/non-promotion, credit packs
- **현재 문제:**

  accessibility tree가 `$15per month`를 반환한다. 외부 감사에서는 390×844 cold cache median CLS 0.173을 반복 관찰했다.

  **[개정 1] 교차검증 실측 보강.**
  - 접근성 결합은 프로모션 적용 상태에서도 동일하게 재현된다:
    `$0.00per month`, `$7.50per month`, `$12.50per month`.
    (관측 통화·프로모션 상태에 따라 표시 금액은 달라지지만 **공백 누락은 동일**하다.)
  - 원인: 가격과 기간이 형제 `<span>`이고 사이에 텍스트 공백 없이 CSS `ml-2`만 있다.
  - CLS: 390×844 cold cache 3회 median **0.173**(max 0.259), 원인 규명 2회 추가 측정에서
    매번 **정확히 0.1734 단일 shift**가 **~1.54s**에 발생. 원인 노드는 요금제 카드
    `ARTICLE`(텍스트 `"For starting outFree300 monthly AI credi…"`).
  - 참고 대비값: `/` CLS median 0.034, `/chat` 360px CLS **0.000**, `/pricing` LCP median
    **888ms**(개선됨). 즉 **LCP는 좋고 CLS만 나쁘다.**

- **변경 요구사항:**
  1. sibling span의 CSS margin이 아니라 실제 공백, 통합 문자열 또는 중복 없는 `aria-label`을 사용한다.
  2. promotion sale/regular price도 자연스러운 하나의 accessible phrase를 제공한다.
  3. `usePublicBilling()` 응답 전후 credit-pack 영역과 plan card의 최종 높이를 예약한다.
  4. placeholder/skeleton은 최종 content와 유사한 block geometry를 사용한다.
  5. 가격 계산·통화 값·promotion 정책은 변경하지 않는다.
- **유지해야 할 기존 동작:**
  - `1 credit`, `2 credits`
  - `A$10.00 per month`
  - `Regular: A$20.00 per month`
  - locale별 통화와 한국어 `/ 월`
  - LCP 개선과 responsive card layout
- **예상 대상 파일 또는 컴포넌트:**
  - `components/marketing/PricingPageContent.tsx`
  - `components/marketing/usePublicBilling.ts`
  - `lib/pricingFormat.ts`
  - `tests/pricingFormat.test.mjs`
  - pricing E2E/performance spec
- **선행 작업 및 의존성:** 없음.
- **접근성 요구사항:** accessibility tree exact string, 중복 announcement 없음, promotion의 original/sale 관계가 이해 가능.
- **반응형 요구사항:** 320/390/768/1440, 200% zoom, long locale에서 overflow 0.
- **오류·로딩·빈 상태 요구사항:** billing config 실패 시 무한 “Loading…” 대신 fallback pricing 또는 명확한 availability message를 제공하되 레이아웃 유지.
- **수용 기준:**
  - accessibility tree에 `$15 per month`
  - promotion에서 `Regular: A$20.00 per month`
  - 390×844 cold cache 5회 median CLS ≤ 0.1, max와 원인 node 기록
  - LCP가 기준 대비 유의하게 악화되지 않음
  - **[개정 1]** 시각 렌더 문법(`1 credit` 등) 회귀 0. `innerText`만으로 통과 판정하지 않고
    `textContent`/accessibility tree 결합값을 함께 확인한다.
- **검증 절차:** browser accessibility snapshot, screen-reader smoke, unit exact string, PerformanceObserver/Lighthouse 동등 계측 5회.
- **회귀 테스트 항목:** promotion, locale, currency, annual/monthly, credit packs, hydration.
- **완료 정의:** accessible string과 CLS 기준 모두 충족.
- **예상 작업 규모:** M

### WO-006 — Mobile new-chat web-search reset test 정합화

- **작업 ID:** WO-006
- **연결된 UX 이슈 ID:** UX-F009
- **제목:** 모바일의 실제 new-chat 경로로 mode reset 계약 검증
- **우선순위:** P2
- **작업 목적:** 상시 red test를 제거하면서 모바일에서도 web-search mode가 새 대화로 이월되지 않는 계약을 유지한다.
- **대상 화면 또는 사용자 흐름:** mobile authenticated chat, empty/non-empty conversation, new chat
- **현재 문제:** test는 빈 대화에서 의도적으로 숨겨진 `New chat` button을 기다려 5/5 timeout이 발생했다. **[개정 1]** 근거: `components/chat/MobileChatShell.tsx`의 새 채팅 버튼이 `{!isActiveConversationEmpty && …}` 조건부 렌더이며, `desktop-chromium`·`desktop-compact`에서는 통과한다. 즉 제품 결함이 아니라 오래된 기대값이다.
- **변경 요구사항:** 모바일에서 먼저 메시지 또는 deterministic fixture로 대화를 non-empty로 만든 후 header button을 사용한다. desktop-only로 축소해야 한다면 동등한 mobile test를 별도로 추가한다.
- **유지해야 할 기존 동작:** 빈 mobile conversation에서 불필요한 new-chat button 숨김, 새 대화의 default web-search mode.
- **예상 대상 파일 또는 컴포넌트:**
  - `tests/e2e/chat-tools.spec.ts`
  - `tests/e2e/support/app-fixtures.ts`
  - `components/chat/MobileChatShell.tsx`는 제품 결함 근거가 생긴 경우에만 수정
- **선행 작업 및 의존성:** WO-001 완료 후 안정적인 send fixture 사용.
- **접근성 요구사항:** button은 나타날 때 unique accessible name과 44px target 유지.
- **반응형 요구사항:** mobile-chromium과 desktop projects 모두 계약 검증.
- **오류·로딩·빈 상태 요구사항:** empty-state에서 test가 존재하지 않는 control을 기다리지 않음.
- **수용 기준:** 3개 Chromium project 실패 0, mobile mode-reset assertion 존재.
- **검증 절차:** 해당 spec 10회 반복 및 전체 Chromium suite.
- **회귀 테스트 항목:** tools menu, new chat, conversation mode persistence.
- **완료 정의:** stale expectation 0, 모바일 계약 coverage 유지.
- **예상 작업 규모:** S

### WO-007 — 핵심 접근성 실기기 검증

- **작업 ID:** WO-007
- **연결된 UX 이슈 ID:** UX-F011
- **제목:** Screen reader·IME·physical keyboard·adaptation QA matrix 수행
- **우선순위:** P2
- **작업 목적:** 자동화만으로 확인할 수 없는 핵심 사용자 blocker를 출시 전에 찾는다.
- **대상 화면 또는 사용자 흐름:** landing consent, pricing, model picker, comparison send, error/retry, status
- **현재 문제:** NVDA/JAWS, VoiceOver, TalkBack, 실제 한국어 IME, physical external keyboard, forced-colors, reduced-motion이 미검증이다. **[개정 1]** 특히 WO-001의 전송 실패가 **외부 키보드 경로에서 재현**되므로 물리 키보드 검증의 우선순위가 높다. WO-001 수정 후 이 경로를 실기기로 재확인한다.
- **변경 요구사항:** 환경·기기·브라우저·task·기대 결과·실제 결과·증거를 갖춘 수동 matrix를 실행하고 발견 defect를 별도 ID로 triage한다.
- **유지해야 할 기존 동작:** 44px targets, focus-visible, logical order, 320 reflow, no horizontal overflow.
- **예상 대상 파일 또는 컴포넌트:** `TBD — 구현 전 접근성 QA 문서 위치 결정 필요`; defect 발생 시 해당 컴포넌트.
- **선행 작업 및 의존성:** WO-001, WO-005 이후.
- **접근성 요구사항:**
  - NVDA+Chrome
  - VoiceOver+iOS
  - TalkBack+Android
  - Gboard/Samsung/iOS Korean keyboard
  - mobile external keyboard
  - 200% text zoom, forced-colors, reduced-motion
- **반응형 요구사항:** 최소 320px phone, mobile landscape, tablet, desktop.
- **오류·로딩·빈 상태 요구사항:** status update와 error/retry announcement, focus restoration.
- **수용 기준:** 핵심 task별 결과와 evidence 존재, P0/P1 accessibility blocker 0.
- **검증 절차:** 각 조합의 수동 checklist와 video/screenshot/notes; 자동 axe는 보조 증거로만 사용. **[개정 1]** 200% text-only zoom은 CSP `style-src`가 계측용 스타일 주입을 차단하므로 자동 계측이 불가하다(보안이 올바르게 동작한 결과). 실제 브라우저 확대로 수동 확인한다.
- **회귀 테스트 항목:** consent, pricing, picker, send, error, status.
- **완료 정의:** 지원하기로 합의한 matrix 완료 및 blocker triage.
- **예상 작업 규모:** 추가 조사 필요

### WO-008 — 출시 직전 visual regression gate

- **작업 ID:** WO-008
- **연결된 UX 이슈 ID:** UX-F012
- **제목:** Nightly visual test를 release evidence에 연결
- **우선순위:** P3
- **작업 목적:** PR fast gate 밖의 chat golden 회귀가 출시 후 발견되지 않게 한다.
- **대상 화면 또는 사용자 흐름:** chat shell 핵심 상태와 release workflow
- **현재 문제:** `chat-state-visual-regression`은 nightly 중심이며 출시 직전 실행 계약이 명확하지 않다. **[개정 1]** 이 이동은 커밋 `8d02fc1`에서 의도적으로 이뤄진 트레이드오프이며 커밋 메시지에 근거가 기록되어 있다. 되돌리는 것이 아니라 출시 게이트를 보완하는 방향이 원 설계와 일치한다.
- **변경 요구사항:** release checklist 또는 release workflow에 `npm run test:e2e:visual`의 reviewed run을 요구한다. CI 필수 gate 복귀 여부는 책임자가 결정한다.
- **유지해야 할 기존 동작:** PR fast gate의 속도, nightly artifact 보존.
- **예상 대상 파일 또는 컴포넌트:**
  - `.github/workflows/nightly-visual-regression.yml`
  - `.github/workflows/pr-fast-gate.yml`
  - release checklist 문서 `TBD — 구현 전 위치 확인 필요`
  - `tests/e2e/chat-state-visual-regression.spec.ts`
- **선행 작업 및 의존성:** 제품 책임자의 gate 방식 결정.
- **접근성 요구사항:** visual golden은 accessibility 검증을 대체하지 않는다고 명시.
- **반응형 요구사항:** desktop, compact, mobile 핵심 상태 포함 여부 검토.
- **오류·로딩·빈 상태 요구사항:** empty, loading, partial failure, error/retry golden 포함.
- **수용 기준:** 출시 commit SHA에 연결된 visual run, diff review 결과, artifact 경로가 release record에 존재.
- **검증 절차:** snapshot update 없이 첫 실행, diff review 후 의도된 변경만 승인.
- **회귀 테스트 항목:** chat state golden 전부.
- **완료 정의:** release checklist에서 누락 시 출시가 중단되거나 명시적 waiver가 필요.
- **예상 작업 규모:** S

### WO-009 — Model ID와 표시명 mapping 문서화

- **작업 ID:** WO-009
- **연결된 UX 이슈 ID:** UX-F013
- **제목:** Provider request ID와 user-facing generation name의 추적성 확보
- **우선순위:** P3
- **작업 목적:** 운영·지원 담당자가 model ID와 표시명을 혼동하지 않게 한다.
- **대상 화면 또는 사용자 흐름:** model registry, admin, logs, incident/runbook
- **현재 문제:** `gemini-2-5-flash` request ID가 UI에서 `Gemini 3.1 Flash-Lite`로 표시된다. **[개정 1]** 실측 확인: 같은 전송의 `/api/chat` body는 `modelId: "gemini-2-5-flash"`, 패널 헤더는 `Gemini 3.1 Flash-Lite`. 기능상 영향은 없다.
- **변경 요구사항:** ID를 위험하게 migration하지 않고 registry 주석 또는 운영 문서에 provider API ID, Tomverse ID, display name, replacement/alias 관계를 기록한다.
- **유지해야 할 기존 동작:** request body model ID, historical conversation, billing mapping.
- **예상 대상 파일 또는 컴포넌트:**
  - `lib/models.ts`
  - Model Registry admin 설명
  - `README.md` 또는 별도 운영 문서
- **선행 작업 및 의존성:** WO-002/WO-003의 상태·registry 용어.
- **접근성 요구사항:** UI에 노출할 경우 약어·세대 관계가 text로 이해 가능.
- **반응형 요구사항:** admin table/mobile card에서 mapping이 잘리지 않음.
- **오류·로딩·빈 상태 요구사항:** mapping 없음은 추측 대신 Unknown/Not documented.
- **수용 기준:** 해당 model의 세 식별자가 한 문서/registry record에서 추적 가능.
- **검증 절차:** registry/API/log 예시를 redaction해 교차 확인.
- **회귀 테스트 항목:** model lookup, billing profile, conversation restore.
- **완료 정의:** ID 변경 없이 운영 mapping이 문서화됨.
- **예상 작업 규모:** S

### WO-010 — 승인된 authenticated staging 운영 검증

- **작업 ID:** WO-010
- **연결된 UX 이슈 ID:** UX-F004
- **제목:** 기본 3-model·AI Review·actual credit/refund 검증
- **우선순위:** P1
- **작업 목적:** mock이 아닌 production-like staging 경로에서 핵심 task와 과금 원장을 확인한다.
- **대상 화면 또는 사용자 흐름:** authenticated 3-model comparison, AI Review, partial failure/recovery
- **현재 문제:**

  외부 감사의 guest 자동화 요청은 20건 모두 Turnstile에서 403으로 차단되어 Provider 도달 0, credit 0이었다. 내부 감사는 실제 호출을 수행하지 않았다.

  **[개정 1] 차단 상세와 게스트 경로의 한계.**
  - 응답 본문은 `{"error":"Guest verification is required.","code":"TURNSTILE_REQUIRED"}`이며,
    Cloudflare Turnstile이 자동화 브라우저에 토큰 발급을 거부한 것이다. **제품 결함이 아니라
    검증 경로의 제약이다.** Provider 장애·credential·egress 문제로 해석하지 않는다.
  - **게스트 세션으로는 전체 AI Review를 검증할 수 없다.** 게스트에는
    `ai-review-guest-locked`(로그인 게이트)가 걸려 있고 quick comparison summary만 가능하다.
    따라서 이 작업은 **인증 계정이 사실상 필수**다.
  - 부수 확인(긍정): 요청 거부 시 3개 패널 모두 Retry / Report error / 대체 모델 안내 /
    Trace ID를 노출하며 "생성 중" 상태에 고착되지 않았다. 실패 복구 UX 자체는 정상이다.

- **변경 요구사항:**
  1. 실행 전에 사용자에게 환경, 계정, 모델, 횟수, prompt, 최대 credit, 증거, 중단 조건을 제시해 승인받는다.
  2. 비자동화 브라우저 또는 승인된 staging test account를 사용한다.
  3. web search는 첫 검증에서 `off`로 고정한다.
  4. 기본 3-model 동일 prompt 3회와 AI Review 1회를 수행한다.
  5. expected/reserved/actual/refund ledger를 비교한다.
  6. partial failure는 안전한 승인된 방법이 없으면 강제하지 않고 N/V로 남긴다.
- **유지해야 할 기존 동작:** Turnstile guest 보호, 개인정보 redaction, request limit, Provider safety cap. **[개정 1]** Turnstile 우회를 도입한다면 **staging 한정·일회성**이어야 하며 게스트 보호 자체를 약화하지 않는다.
- **예상 대상 파일 또는 컴포넌트:** 코드 수정 아님. 운영 runbook과 staging account/ledger access. 경로는 `TBD — 운영 책임자 확인 필요`.
- **선행 작업 및 의존성:** WO-001–WO-004 완료와 사용자 승인.
- **접근성 요구사항:** keyboard로 비교·AI Review·retry 완료 가능 여부를 함께 기록.
- **반응형 요구사항:** 최소 desktop authenticated path, 가능하면 mobile smoke.
- **오류·로딩·빈 상태 요구사항:** 각 panel loading, partial/total failure, retry, refund feedback.
- **수용 기준:**
  - 비교 3회에서 세 panel completion
  - AI Review 1회 완료
  - expected/reserved/actual credit 일치
  - 실패한 미사용 예약분 refund 일치
  - status와 실제 결과의 모순 없음
- **검증 절차:** redacted trace ID, status, latency, ledger before/after, screenshot을 동일 SHA와 연결. **[개정 1]** 참고 예산: 기본 3-model 3회 = 9 credit, AI Review 1회 ≈ 4–8 credit, web search `off` 고정 시 8-credit surcharge 미발생 → **최대 약 17 credit**. 중단 조건: 첫 비교에서 2개 이상 panel 실패, 또는 실제 차감 credit이 예상치를 초과하면 즉시 중단.
- **회귀 테스트 항목:** 운영 검증이며 자동화 대체 불가. 실패 시 해당 component/adapter의 별도 defect 생성.
- **완료 정의:** 승인 범위 내 runbook 완료 또는 정확한 blocker와 N/V 사유 기록.
- **예상 작업 규모:** 추가 조사 필요

## 5. 공통 검증 기준

### 코드 품질

- `npm run typecheck`
- `npm run lint -- app components lib tests scripts`
- `npm run test:unit`
- `npm run security:regression`
- `npm run check:encoding:strict`
- `npm run build`

실제 `package.json` script를 다시 확인하고 존재하지 않는 command를 가정하지 않는다.

**[개정 1] 현재 기준선 수치** — 수정 전 상태이며, 회귀 판정의 기준으로 사용한다.

| 항목 | 기준값 |
|---|---|
| unit | **499 pass / 0 fail / 0 skip** |
| security regression | **113 checks 통과** |
| typecheck / lint / encoding / build | 통과 (lint 경고 0) |
| E2E (chromium 3 project) | **829 pass / 4 fail / 511 skip** |
| E2E 실패 4건의 내역 | `chat-tools.spec.ts:114` mobile 결정적 1건(WO-006) + `chat-keyboard-policy` 간헐 3건(WO-001) |

### E2E

- `desktop-chromium`
- `desktop-compact`
- `mobile-chromium`
- marketing consent/hero
- provider status/status page
- model picker
- chat keyboard/IME
- comparison layout
- web-search composer/native search/preflight
- pricing/i18n
- build-info
- visual golden

### 반복 안정성

- P1 send와 preflight: clean process 20회
- 이전 flake/stale test: 최소 10회
- 단독 재실행 한 번의 성공으로 해결 판정 금지
- 최초 전체 suite 결과와 isolated 반복 결과를 모두 보존
- **[개정 1]** **단독 실행과 파일 전체 실행을 모두 측정한다.** 현재 일부 테스트는 파일 전체
  실행에서만 통과하므로, 한쪽만 측정하면 해결 여부를 오판한다.
- **[개정 1]** `-g` 필터 사용 시 **매칭 건수를 먼저 확인한다.** 테스트명의 `+` 등
  정규식 메타문자로 0건 매칭이 발생할 수 있고, 이를 실패로 집계하면 허위 실패율이 나온다.

### 브라우저

- 320×568, 360×640, 375×667, 390×844, landscape
- 420, 767, 768, 820, 912, 1024, 1180, 1280, 1366, 1440, 1920
- bounding box, overlap, hit-test, accessibility tree, console, hydration
- **[개정 1]** 접근성 문자열 검증에는 `innerText`를 쓰지 않는다. `innerText`는 요소 경계에서
  공백을 삽입하므로 결합 결함을 가린다. `textContent` 또는 accessibility tree를 사용한다.
- **[개정 1]** WCAG 1.4.10 reflow는 CSS `zoom`으로 emulate하지 않는다. CSS `zoom`은 미디어
  쿼리 breakpoint를 이동시키지 않아 실제 브라우저 확대와 다른 레이아웃이 나온다.
  **CSS px viewport = 물리 폭 ÷ 확대율**로 측정한다(320 CSS px = 1280@400%).

### 보안·개인정보 회귀

- Cloudflare Browser Insights request/script 0
- CSP에 `unsafe-eval`, 일반 `unsafe-inline`, broad wildcard 추가 0
- consent 정책에 맞는 GA/GTM 실행
- prompt/file payload analytics 전송 0
- chat `no-store`, HSTS, framing, nosniff, referrer, permissions policy 유지

### 증거 규칙

- source, automated test, browser, operational evidence를 분리
- screenshot만으로 기능 성공 판정 금지
- timestamp, timezone, branch, local/origin/staging SHA 기록
- secret·cookie·session·사용자 content 제거

## 6. 완료 조건

- [ ] UX-F001–UX-F013이 각 작업 ID로 추적됨
- [ ] P1 네 건이 구현 또는 승인된 운영 검증으로 종료됨
- [ ] status/API/picker/chat 모순 0
- [ ] retired/disabled public model 0
- [ ] chat send와 preflight 20회 반복 실패 0
- [ ] **[개정 1]** chat send가 **단독 실행과 파일 전체 실행에서 동일한 결과**
- [ ] pricing accessibility tree와 CLS 기준 충족
- [ ] 전체 unit/type/lint/security/build 통과
- [ ] Chromium 전체 suite의 설명되지 않은 failure 0
- [ ] visual diff 검토 완료
- [ ] 접근성 수동 matrix의 P0/P1 blocker 0
- [ ] staging 검증 시 local/origin/staging SHA 일치
- [ ] **[개정 1]** §2-A 회귀 금지 불변조건 전부 유지
- [ ] 실제 Provider/credit 검증이 없으면 Go로 보고하지 않음
- [ ] 최종 결과에 완료·부분 완료·미완료와 근거가 각각 기록됨

## 7. 범위 제외 항목

- Provider 응답 내용의 사실 정확성 비교
- production 배포 또는 production credential 검증
- 승인 없는 Provider 호출·credit 소비·결제·환불
- 사용자의 기존 consent 영구 변경
- 현재 지원하지 않는 RTL locale의 제품 구현
- consent inline text link에 근거 없이 44×44 block을 강제하는 변경
- model ID의 대규모 migration
- 공식 디자인 시스템 전체 재설계
- 관련 없는 UI polish 또는 대규모 architecture refactor
- **[개정 1]** `lib/chatKeyboardPolicy.ts`의 Enter/IME 정책 변경 — 두 감사 모두 올바르다고
  확인했고 단위 테스트도 통과한다. 제품 결함 근거가 새로 생긴 경우에만 예외.
- **[개정 1]** `/pricing` 외 route의 Web Vitals 기준선 수립 — 출시 차단과 무관하므로
  후속 작업으로 분리한다. (`/pricing` CLS는 WO-005가 다룬다.)

## 8. 구현 전 확인이 필요한 결정사항

| 결정 | 책임자 | 선택지 | 기본 권고 |
|---|---|---|---|
| Degraded 모델 정책 | Product + SRE | limited 사용 / 선택 차단 | limited + 명확한 경고 |
| Incident 모델 정책 | Product + SRE | 차단 / explicit override | 기본 차단 + 재선택 |
| 자동 fallback | Product | silent / 사용자 확인 | 사용자 확인 |
| no-probe Provider 표시 | SRE | Unknown / traffic-only 별도 상태 | Unknown + 이유 |
| retired model API 표현 | Product + Platform | 제거 / unavailable+replacement | picker 제거, API는 migration 기간 replacement |
| actual staging budget | Product owner | 호출·credit 상한 | 비교 3회 + Review 1회, 사전 상한 **최대 약 17 credit** `[개정 1]` |
| Turnstile 검증 경로 | Security + QA | manual / staging account / test mechanism | **인증 staging account** `[개정 1]` — 게스트는 AI Review가 로그인 게이트라 검증 불가 |
| visual test gate | Engineering lead | release checklist / required CI | 출시 전 필수 reviewed run |
| accessibility device matrix | Product + QA | 지원 범위 | NVDA, VoiceOver, TalkBack와 한국어 IME 우선 |
| 디자인 시스템 문서 | Design lead | 별도 문서 / 현행 코드 계약 | 후속 문서화 작업으로 분리 |

---

## 부록 — 개정 1 변경 이력 (diff 확인용)

| # | 위치 | 변경 | 근거 |
|---|---|---|---|
| 1 | §1 기준 | `origin/develop` = `e062da86`, staging deployment `95bee9e2` 추가. 제품 소스 차이 0건 명시 | `git diff 8d02fc1..origin/develop -- app components lib tests scripts package.json` 결과 비어 있음, `/api/build-info` 실측 |
| 2 | §2-A (신설) | 수치가 명시된 회귀 금지 불변조건 표 추가 | 두 감사가 해결을 확인한 항목의 판정 기준을 수치로 고정 |
| 3 | WO-001 현재 문제 | `1920 0/3` → 약 29%(24회 중 7회) 등 실측 재현율로 교체, 실패 로그 원문 추가 | 교차검증 반복 측정 |
| 4 | WO-001 현재 문제 | 실행 모드 의존성(파일 전체 9/9 vs 단독 2/5) 추가 | 교차검증 실측 |
| 5 | WO-001 변경 요구사항 6 | 실행 모드 독립성 요구사항 신설 | 위 4번 |
| 6 | WO-001 대상 파일 | `lib/chatKeyboardPolicy.ts`를 **변경 금지**로 명시 | 정책 코드가 올바름을 양측 감사가 확인. 오수정 방지 |
| 7 | WO-001 수용 기준·완료 정의 | 실행 모드 동일 결과 조건 추가 | 위 4번 |
| 8 | WO-001 검증 절차 | `-g` 정규식 0건 매칭 주의 추가 | 교차검증에서 실제 발생한 측정 오류 |
| 9 | WO-002 현재 문제 | `부분 확인됨` → `확인됨`. 동일 시점 대조표 추가 | 02:16:19Z 페어 스냅샷 |
| 10 | WO-002 수용 기준 | 동일 시각 대조 및 build-info 선확인 조건 추가 | 위 9번 |
| 11 | WO-003 현재 문제 | `부분 확인됨` → `확인됨`. 재배포 후에도 노출됨을 명시 | 01:52:08Z / 02:16:19Z 실측 |
| 12 | WO-003 변경 요구사항 6 | 크론 미반영 시 점검 포인트 2가지 추가 | 소스 확인 |
| 13 | WO-004 현재 문제 | 8/8 미재현 사실과 **우선순위 근거를 서버 가드 미검증으로 교체** | 교차검증 8회 + 테스트 구조 확인 |
| 14 | WO-004 변경 요구사항 7 | 공용 fixture가 `webSearchMode`를 읽지 않는 사실 명시 | 소스 확인 |
| 15 | WO-005 현재 문제 | CLS 원인 노드·발생 시각·대비값 추가, 접근성 결합 실측값 추가 | 5회 측정 |
| 16 | WO-005 수용 기준 | `innerText` 단독 판정 금지 추가 | 본 감사가 실제로 놓친 원인 |
| 17 | WO-007 / WO-010 | 외부 키보드 우선순위, 게스트 AI Review 로그인 게이트, credit 상한 추가 | 실측 |
| 18 | §5 | 현재 기준선 수치표, 실행 모드 양측 측정, `-g` 주의, `innerText` 금지, CSS `zoom` 금지 추가 | 교차검증 방법론 |
| 19 | §6 | 실행 모드 동일 결과, §2-A 유지 조건 추가 | 위 항목들 |
| 20 | §7 | `chatKeyboardPolicy.ts` 정책 변경, 성능 기준선 확대를 범위 제외로 명시 | 오수정·범위 확산 방지 |
| 21 | §8 | credit 상한과 Turnstile 경로 기본 권고 구체화 | 실측 |
