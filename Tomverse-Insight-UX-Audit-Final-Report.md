# Tomverse Insight 최종 UX 감사 보고서

## 1. 문서 정보

### 감사 대상

- 제품: Tomverse Insight
- Branch: `develop`
- 검증 SHA: `8d02fc1d35f988d5c9d61ab9463fea01a3f0b3b6`
- Staging: `https://staging.tomverse.app`
- Railway deployment: `2351b283-29a3-4b98-8ada-038da7324c6d` (`SUCCESS`)

### 검토일

2026-07-28 (교차검증 수행 구간 01:45–02:35 UTC)

> **개정 이력 — 2026-07-28 02:16 UTC (개정 1)**
> 외부 측이 양쪽 자료를 통합한 최종본을 회신함에 따라, 그들이 "환경 제약으로 확인 불가"로
> 남긴 두 항목을 이 감사가 실측해 반영했습니다. 상세는 §11 참조.
> - **기준선 이동**: `origin/develop`가 `e062da86bf572c2076f56fe41726fefd0dfd4c75`로,
>   staging도 같은 SHA로 재배포되었습니다(deployment
>   `95bee9e2-d705-4398-8b1f-5e7eebea1e8f`, deployedAt `2026-07-28T01:40:31.481Z`,
>   `SUCCESS`). `8d02fc1…`와의 차이는 **`.github/audits/final-stg-reaudit-2026-07-28.md`
>   추가 1건뿐이며 `app`/`components`/`lib`/`tests`/`scripts`/`package.json` 제품 소스
>   변경은 0건**입니다. 따라서 본 보고서의 모든 발견점은 그대로 유효합니다.
> - **UX-002·UX-004 증거 등급 상향**: `검증 필요`/`부분 확인` → **`확인됨`**
>   (동일 시점 대조 완료).

### 검토 범위

두 개의 독립 재감사 결과를 비교·검증하고, 현재 제품에서 직접 확인 가능한 사실을 기준으로
단일 이슈 목록과 우선순위를 도출했습니다. 제품 코드는 수정하지 않았습니다.

### 검토 자료 목록

| # | 자료 | 실제 파일명 / 위치 |
|---|---|---|
| 1 | 원본 UX 감사 요청서 | 대화 내 원문 (파일 아님). "역할 / 감사 자료 / 감사 목적 / 감사 원칙 / Phase 0–11 / 판정 체계 / 점수 체계 / 최종 보고 형식 / 종료 규칙" 구조 |
| 2 | 외부 UX 감사 결과 | `ac88e44d-REPORT_REAUDIT_KO.md` (원제 `REPORT_REAUDIT_KO.md`) |
| 3 | 외부 작업명령서 | `cd6cd24a-TOMVERSEINSIGHTREAUDITREMEDIATIONPROMPT.md` (원제 "Tomverse Insight — 독립 재감사 전체 개선 실행 프롬프트") |
| 4 | 본인 UX 감사 결과 | `.github/audits/final-stg-reaudit-2026-07-28.md` (커밋 `80a567b`, `08b5c19`) |
| 5 | 본인 작업명령서 | `remediation-prompt.md` (scratchpad, 사용자에게 전달됨) |
| 6 | 제품 소스 | `/home/user/Tomverse` @ `8d02fc1d…` (읽기 전용) |
| 7 | 라이브 제품 | staging 브라우저 계측 및 공개 API |
| 8 | 참고 문서 | `.github/audits/provider-probe-staging-reaudit.md`, `AGENTS.md` |

**주의**: 두 감사가 참조한 과거 문서 `REPORT_FINAL_KO.md`는 현재 리포지토리의 어떤
ref에도 존재하지 않습니다(전체 히스토리 검색 결과 0건). `FINAL-F001`–`F006` 식별자는
소스 주석과 테스트 파일에만 남아 있으며, 두 감사 모두 그 주석을 근거로 재구성했습니다.
따라서 "과거 심각도" 값은 **양쪽 감사의 재구성치**이며 원본 확인이 불가합니다.

### 검증 가능 범위와 한계

| 구분 | 상태 |
|---|---|
| 소스 코드 정적 확인 | 확인됨 |
| staging 공개 화면·API 계측 | 확인됨 |
| 로컬 mock E2E 실행·반복 | 확인됨 |
| Railway 배포 메타데이터 | 확인됨 |
| 실제 Provider 호출 | **미검증** — 승인 후 시도했으나 Turnstile이 자동화 클라이언트를 차단 |
| 실제 credit 소비·환불 원장 | **미검증** |
| 실기기 보조기술(SR)·모바일 키보드 | **미검증** |
| staging DB 직접 조회 | **판단 불가** — 접근 권한 없음 |
| production 환경 | **범위 외** |

---

## 2. 경영진 요약

### 전반적인 UX 상태

핵심 화면(랜딩, 요금제, 개인정보, 게스트 채팅)의 **반응형·보안·개인정보 영역은 견고합니다.**
320px에서 동의 배너가 Hero/CTA를 가리던 P1 결함, 브랜드 축약 결함, CSP 위반 beacon,
영문 요금제 문법 결함은 실제 staging 배포물에서 해소가 확인되었습니다. 320 CSS px 기준
reflow는 4개 route 전부 overflow 0이며, 동의 이전 추적은 0건입니다.

반면 **신뢰(trust) 계층과 핵심 전송 경로에 출시를 막는 문제가 남아 있습니다.**
공개 상태 페이지가 선언하는 Provider 상태와 채팅 UI가 소비하는 모델 가용성 API가 서로
모순되고, 은퇴 처리된 모델이 여전히 사용자에게 선택 가능하며, 사용자가 보낸 메시지가
화면에 나타나지 않는 간헐적 렌더 실패가 재현됩니다.

### 가장 중요한 결론

1. **사용자 메시지 미렌더 race가 실재합니다.** 두 감사가 서로 다른 브라우저 환경에서
   독립적으로 관측했고, 이번 교차검증에서 재현했습니다. 증상은 "textarea는 비워지고
   대화는 생성되지만 본문 패널에 사용자 메시지가 0개". 이것은 테스트 하네스 문제가 아니라
   제품이 사용자에게 보여야 할 최소 피드백의 실패입니다.
2. **Provider 상태 정합성이 두 겹으로 깨져 있습니다.** (a) 모델 가용성 API가 공개 판정이
   아닌 내부 상태만 읽고, (b) 프로브 대상이 아닌 Provider의 실패 카운터가 동결되어 영구
   장애로 표시됩니다. 원인이 다르므로 수정도 두 개여야 합니다.
3. **상용 AI 경로는 여전히 미검증입니다.** 승인을 받아 실행했으나 Provider 도달 0회입니다.

### 즉시 대응해야 할 위험

| 위험 | 영향 |
|---|---|
| 사용자 메시지 미렌더 | 사용자가 전송 실패로 오인해 재전송 → 중복 과금 가능성 |
| 상태 페이지 ↔ 채팅 UI 모순 | 공개 약속과 제품 동작 불일치, 신뢰도 훼손 |
| 은퇴 모델 선택 가능 | 선택 시 HTTP 404, 3-model 비교의 부분 실패 유발 |
| 상용 경로 미검증 | 출시 후에야 결함이 드러날 위험 |

### 외부 결과와 본인 결과의 전반적인 일치도

**핵심 판정은 일치, 세부는 상호 보완적입니다.** 두 감사 모두 독립적으로 `No-Go`에
도달했고 배포 기준선(local = origin/develop = staging = Railway) 일치도 동일하게
확인했습니다. FINAL-F001/F004/F005는 양쪽 모두 `Verified fixed`입니다.

점수는 외부 67 / 본인 78로 11점 차이가 났는데, 그 차이는 대부분 **STG-F003(전송 race)의
심각도 판단**과 **FINAL-F006(접근성 문자열) 발견 여부**에서 발생했습니다. 교차검증 결과
**두 쟁점 모두 외부 감사의 판단이 옳았습니다.**

---

## 3. 원본 요청사항 충족도

원본 요청서는 Phase 0–11과 14개 보고 섹션, 8개 채점 항목을 규정했습니다.

### 요구사항별 충족도

| 원본 요구사항 | 외부 감사 | 본인 감사 | 비고 |
|---|---|---|---|
| Phase 0 감사 기준선(시각·SHA·배포 ID) | 충족 | 충족 | 양쪽 모두 4기준 일치 확인 |
| Phase 0 `REPORT_FINAL_KO.md` matrix 선작성 | 부분 충족 | 부분 충족 | **원본 문서가 리포지토리에 부재**. 양쪽 다 소스 주석으로 재구성 |
| Phase 0 staging smoke | 충족 | 충족 | 외부가 `/api/ready` 추가 확인 |
| Phase 1 FINAL-F001 재검사 | 충족 | 충족 | 양쪽 모두 bounding box + hit-test |
| Phase 1 200% zoom / RTL | 부분 충족 | 부분 충족 | RTL은 지원 locale에 없음(N/A) |
| Phase 2 FINAL-F002 공개 상태 실측 | 충족 | 충족 | 양쪽 모두 새로 수집, 과거 수치 미재사용 |
| Phase 2 승인된 실호출 | 미충족 | **부분 충족** | 본인은 승인 후 실행, Turnstile 차단으로 도달 0 |
| Phase 3 FINAL-F003 전이 검증 | 부분 충족 | **충족** | 본인이 5개 전이 request body 실캡처 |
| Phase 3 credit matrix | 충족 | 충족 | 양쪽 8 credit/모델 확인 |
| Phase 4 FINAL-F004 | 충족 | 충족 | |
| Phase 5 FINAL-F005 CSP | 충족 | 충족 | |
| Phase 6 FINAL-F006 | **충족** | 미충족 | 외부만 접근성 트리 확인 |
| Phase 7 STG-F001–F010 | 충족 | 부분 충족 | 외부가 STG-F003 Fail 판정 |
| Phase 8 자동화 신뢰성·flake 반복 | 충족 | 충족 | 양쪽 반복 실행 수행 |
| Phase 9 접근성 | 충족 | 부분 충족 | 외부가 접근성 트리까지 확인 |
| Phase 10 성능 3회 이상 측정 | **미충족** | **충족** | 외부 0회, 본인 3–5회 |
| Phase 11 신규 회귀 탐색 | 부분 충족 | 충족 | 본인 6건 vs 외부 1건 |
| 판정 체계·점수 체계 준수 | 충족 | 충족 | |

### 양쪽 모두에서 누락된 내용

1. **`REPORT_FINAL_KO.md` 원본 부재를 blocker로 승격하지 않음.** 원본 요청서는 이 문서를
   Phase 0의 필수 입력으로 지정했으나, 리포지토리에 존재하지 않습니다. 양쪽 다 소스
   주석으로 우회했을 뿐 "기준 문서 부재"를 QA 추적성 리스크로 명시하지 않았습니다.
2. **forced-colors / prefers-reduced-motion** — 양쪽 모두 미실행.
3. **light 테마 전수 계측** — 양쪽 모두 dark 기준.
4. **실기기 보조기술** — 양쪽 모두 미검증(양쪽 다 정직하게 명시함).
5. **production credential/egress 경로** — 범위상 불가.

---

## 4. 비교 분석

### 4.1 공통 발견사항

| 항목 | 외부 | 본인 | 교차검증 |
|---|---|---|---|
| 배포 기준선 4기준 일치 | 확인 | 확인 | 확인됨 |
| FINAL-F001 해결 | Verified fixed | Verified fixed | 확인됨 |
| FINAL-F004 해결 | Verified fixed | Verified fixed | 확인됨 |
| FINAL-F005 해결 | Verified fixed | Verified fixed | 확인됨 |
| Provider 상태 ↔ 모델 API 불일치 | Google 사례 | Perplexity 사례 | 확인됨 (동일 근본 원인) |
| `llama-4-scout` public API 노출 | 확인 | 확인 | 확인됨 (01:52Z 재확인) |
| 상용 AI 경로 미검증 | 확인 | 확인 | 확인됨 |
| preflight 계약 회귀 테스트 부재 | 확인 | 확인 | 확인됨 |
| 실기기 보조기술 미검증 | 확인 | 확인 | 확인됨 |
| 최종 판정 `No-Go` | 67/100 | 78/100 | 판정 일치 |

### 4.2 외부 감사에만 있는 발견사항

| 항목 | 외부 판단 | 교차검증 결과 |
|---|---|---|
| **FINAL-F006 접근성 문자열 결합** | Partially fixed, `$15per month` | **확인됨 — 외부가 옳음.** `$0.00per month`, `$7.50per month`, `$12.50per month` 재현 |
| **STG-F003 전송 race를 P1 제품 회귀로 판정** | Fail, P1 | **확인됨 — 외부 진단이 옳음.** 단 재현율은 수정 필요(아래 4.4) |
| preflight 429 provider-zero 비결정성 | REAUDIT-F001, P2 | **재현 실패** — 본인 환경 8/8 통과. 보류 |
| `/api/ready` smoke | Pass | 확인하지 않음 (범위 보완) |

### 4.3 본인 감사에만 있는 발견사항

| 항목 | 본인 판단 | 교차검증 결과 |
|---|---|---|
| **Perplexity 실패 카운터 동결 메커니즘** | REAUDIT-F001, P1 | **확인됨.** 외부는 202회 수치만 인용, 동결 원인은 미진단 |
| **`/pricing` CLS 0.173** | REAUDIT-F003, P2 | **확인됨.** 5회 재현, 단일 shift 0.1734 |
| **mobile `chat-tools` 결정적 실패** | REAUDIT-F004, P2 | **확인됨.** mobile 5/5 실패, desktop 통과 |
| FINAL-F003 런타임 5개 전이 실캡처 | Verified fixed | 확인됨 |
| 상태 페이지 real-traffic 경과 시간 미표시 | 권고 #9 | 확인됨 |
| 모델 id ↔ 브랜드명 불일치 | 부수 관찰 | 확인됨 |
| consent 인라인 링크 hit area | 부수 관찰 | 확인됨 |

### 4.4 충돌하는 판단

#### 충돌 1 — STG-F003 전송/렌더 race의 심각도와 재현율

| | 외부 | 본인(최초) |
|---|---|---|
| 판정 | **Fail / Confirmed product regression / P1** | Pass(조건부) + 별도 flake 항목 P2 |
| 1920px | "0/3" (결정적 실패) | 전체 suite에서 통과 |
| mobile 외부 키보드 | "4/6" | 간헐 실패 |

**교차검증 결과 (본인 환경, 반복 측정)**

| 프로젝트 | 테스트 | 결과 |
|---|---|---|
| desktop-chromium (1920×1080) | `Enter sends the message exactly once` | **약 24회 중 7회 실패 (~29%)** |
| desktop-compact (1366×768) | 동일 | 6회 중 1회 실패 (~17%) |
| mobile-chromium | `sends from an external keyboard` (Ctrl/Cmd) | **5회 중 2회 실패 (~40%)** |
| mobile-chromium | 파일 전체 실행 | 9/9 통과 ×3회 |

**실패 상세 (실측)**
```
Error: expect(locator).toHaveCount(expected) failed
Locator: locator('[data-message-role="user"]').filter({ hasText: 'PC Enter send' })
Expected: 1   Received: 0   Timeout: 5000ms
  - 14 × locator resolved to 0 elements
```

**최종 판단**: **외부 감사의 진단이 옳고, 본인의 최초 분류는 과소평가였습니다.**
5초 동안 14회 폴링에도 사용자 자신의 메시지가 0개라는 것은 하네스 타이밍 문제가 아니라
제품이 보여야 할 최소 피드백의 실패입니다. 다만 외부의 "0/3 결정적"은 본인 환경에서
재현되지 않았고 **간헐 재현(약 17–40%, 실행 모드 의존)** 이 정확합니다. 심각도는 P1로
채택하되 재현율 기술은 수정합니다.

**정정 고지**: 본인 최초 감사는 이 실패군을 "매번 다른 테스트가 실패하는 전형적 타이밍
flake"로 분류했습니다. 이 분류는 틀렸습니다. 실패 양상(사용자 메시지 미렌더)을 확인하지
않고 실패 테스트 이름의 분산만으로 판단한 것이 원인입니다.

#### 충돌 2 — FINAL-F006 판정

| | 외부 | 본인(최초) |
|---|---|---|
| 판정 | **Partially fixed** | Verified fixed |
| 근거 | 접근성 트리 `$15per month` | 렌더 텍스트 `1 credit`, `per month` 정확 |

**교차검증 결과**: 소스 확인 — `components/marketing/PricingPageContent.tsx`에서 가격과
기간이 형제 `<span>`이고 사이에 **텍스트 공백 없이 CSS `ml-2`만** 존재합니다. 브라우저
실측 `textContent` 결합값: `$0.00per month`, `$7.50per month`, `$12.50per month`.

**최종 판단**: **외부가 옳습니다.** 본인은 `innerText`(요소 경계에서 공백을 삽입함)만
확인해 결함을 놓쳤습니다. 채택.

#### 충돌 3 — FINAL-F003 판정

| | 외부 | 본인 |
|---|---|---|
| 판정 | Fixed locally, not verified on staging | Verified fixed |

**교차검증 결과**: 본인은 배포 SHA와 동일한 코드를 mock 런타임에서 실행해 5개 상태 전이의
`/api/chat/preflight` 및 `/api/chat` request body를 **실제 캡처**했고 stale 값 0건을
확인했습니다. 외부는 이 캡처를 수행하지 않아 보수적으로 판정했습니다.
다만 **staging authenticated 환경의 실제 캡처는 양쪽 모두 없습니다.**

**최종 판단**: `Verified fixed (코드 + 로컬 런타임)`으로 채택하되, staging authenticated
캡처 부재는 UX-010(회귀 테스트 부재)으로 이관합니다. 외부의 신중함은 타당하나 판정을
낮출 만큼의 근거 공백은 아닙니다.

#### 충돌 4 — Google Gemini 상태

외부는 최종 스냅샷에서 `Degraded`(2회 연속 실패), 본인은 00:33Z `Incident`(5회) →
00:54Z `Operational`을 관측했습니다.

**최종 판단**: 충돌이 아니라 **시점 차이**입니다. Google은 감사 구간 내에 실제로
Incident → Degraded → Operational로 변동했습니다. 이는 Google의 간헐 불안정을 보여줄 뿐
별도 이슈가 아니며, 문제의 본질은 "어떤 상태이든 모델 API가 항상 `available`을
반환한다"는 UX-002입니다.

#### 충돌 5 — FINAL-F001 notice body width

외부는 320px에서 body width 약 116.8px(스크롤바로 client width 305px), 본인은 141.5px
(client width 320px)를 측정했습니다.

**최종 판단**: **환경 의존 차이**이며 결함이 아닙니다. 양쪽 모두 판정 기준(판독 가능한 폭,
교차 0, overflow 0, 44×44)을 통과했습니다. 이슈로 등록하지 않습니다.

### 4.5 제외하거나 보류한 주장과 사유

| 주장 | 출처 | 처리 | 사유 |
|---|---|---|---|
| preflight 429에서 `/api/chat` 1회 호출 (7회 중 1회) | 외부 | **보류(P3)** | 본인 환경 8/8 통과로 재현 실패. 합산 15회 중 1회(~7%). 외부 스스로 "이 테스트는 `/api/chat`을 mock하므로 실제 Provider 호출·과금을 증명하지 못한다"고 명시함 |
| mobile Ctrl/Cmd+Enter 6/6 실패 | 본인 1차 측정 | **제외** | **본인 측정 오류.** `-g "Ctrl+Enter…"`의 `+`가 정규식 수량자로 해석돼 0개 테스트가 매칭됐고 이를 실패로 집계함. 올바른 패턴 재측정 결과 5회 중 2회 실패 |
| 200% zoom `/pricing` 96px overflow | 본인 1차 관측 | **제외(자체 철회)** | CSS `zoom`은 미디어 쿼리 breakpoint를 이동시키지 않아 실제 브라우저 줌과 다름. WCAG 기준인 320 CSS px 재측정 시 overflow 0 |
| FINAL-F001 body width 116.8px 문제 | 외부 | **제외** | 스크롤바로 인한 환경 차이. 판정 기준 통과 |
| Google `Degraded` 자체 | 외부 | **흡수** | 시점 의존. UX-002의 사례로 통합 |
| Provider 장애 원인(credential/quota/egress) | 양쪽 | **판단 불가** | 양쪽 모두 `Unknown cause`로 정직하게 유지. 유지 |

---

## 5. 최종 UX 이슈 목록

### 핵심 수치

| 지표 | 값 |
|---|---:|
| 외부 감사 이슈 수 | 8 (FINAL 6 + STG-F003 + REAUDIT-F001) + 권고 10 |
| 본인 감사 이슈 수 | 12 (FINAL 6 + REAUDIT-F001–F006) + 권고 10 |
| **통합 후 최종 이슈 수** | **16** |
| 공통 이슈 수 | 6 |
| 외부에만 있는 이슈 수 | 2 |
| 본인에만 있는 이슈 수 | 7 |
| 제외 또는 보류된 주장 수 | 6 (제외 4, 보류 1, 흡수 1) |
| 최종 검토에서 새로 발견한 이슈 수 | 1 |
| P0 | 0 |
| P1 | 5 |
| P2 | 5 (개정 1: 3 → 5) |
| P3 | 6 (개정 1: 8 → 6) |

---

### UX-001 · P1 · 전송 후 사용자 메시지가 본문 패널에 렌더되지 않음

- **화면/흐름**: 인증 채팅 — 새 대화 첫 메시지 전송
- **문제**: Enter(또는 외부 키보드 Ctrl/Cmd+Enter)로 전송하면 textarea는 비워지고 대화는
  생성되지만, 본문 패널에 사용자 자신의 메시지가 나타나지 않는 경우가 있습니다.
- **사용자 영향**: 사용자는 전송이 실패했다고 판단해 재전송합니다. 3-model 비교에서
  재전송은 중복 요청과 중복 과금으로 이어질 수 있습니다. 핵심 작업의 최소 피드백 실패입니다.
- **확인 근거**:
  - 실측 실패: `expect(locator('[data-message-role="user"]')).toHaveCount(1)` → `Received: 0`,
    5000ms 동안 14회 폴링 모두 0개
  - 재현율: desktop-chromium 1920×1080 약 29%(24회 중 7회), desktop-compact 1366×768
    약 17%(6회 중 1회), mobile 외부 키보드 약 40%(5회 중 2회)
  - 실행 모드 의존: mobile 파일 전체 실행은 9/9 통과 ×3회
  - 외부 감사가 다른 브라우저(system Chrome)에서 동일 증상 독립 관측
  - 관련: `tests/e2e/chat-keyboard-policy.spec.ts`
- **검증 상태**: **확인됨** (재현율은 본인 환경 기준)
- **권장 개선 방향**: 키 입력 경로와 버튼 클릭 경로가 단일 전송 파이프라인을 쓰도록 하고,
  대화 생성과 메시지 목록이 동일한 source of truth를 참조하게 합니다. optimistic 렌더가
  요청 이전에 확정되도록 하되 IME 조합 중 미전송 정책은 보존합니다.
  구체적 구현안은 근거가 충분하지 않으므로 고정하지 않습니다.
- **출처**: 양쪽 공통 (외부가 정확히 진단, 본인 최초 분류는 과소평가 — 정정함)

---

### UX-002 · P1 · 공개 Provider 상태와 모델 가용성 API의 모순

- **화면/흐름**: `/status` ↔ 채팅 모델 선택/첫 페인트
- **문제**: 같은 시각에 `/status`는 특정 Provider를 `Incident`/`Degraded`로 선언하는데
  `/api/models/status`는 해당 Provider의 모든 모델을 `available`, `fallbackModelIds: []`로
  반환합니다. 채팅 UI는 아무 경고 없이 해당 모델을 제공합니다.
- **사용자 영향**: 공개 약속과 제품 동작이 정면으로 어긋납니다. 상태 페이지를 믿고 회피한
  사용자는 불필요하게 이탈하고, 채팅만 쓰는 사용자는 경고 없이 장애 모델을 사용합니다.
- **확인 근거**:
  - 2026-07-28 00:54Z 및 01:52Z: `/status` Perplexity = Incident, `/api/models/status`는
    `perplexity/sonar`, `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research` 모두
    `available`
  - 00:33Z: `/status` Google = Incident, 같은 API는 `gemini-2-5-flash`(기본 3-model 중
    하나) `available`
  - 외부 감사 01:27Z: Google = Degraded, 같은 API `available`
  - 소스: `app/api/models/status/route.ts` — 공개 판정 `publicStatus`가 아니라 내부
    `provider.status === "outage"`만 참조. `/status`와 admin 패널은 `publicStatus`를 사용
  - **[개정 1] 동일 시점 대조 (2026-07-28 02:16:19Z, `generatedAt` 초 단위 일치)**:
    `/status` 11개 Provider 중 Perplexity만 `Incident`, 나머지 10개 `Operational`.
    같은 순간 `/api/models/status`는 **33개 모델 전부 `available`,
    non-available 0건**. 즉 가용성 투영이 사실상 상수이며 공개 판정을 전혀 반영하지 않음
- **검증 상태**: **확인됨** (4개 시점, 2개 Provider, 동일 시점 대조 1건)
- **권장 개선 방향**: 공개 상태·모델 API·picker·배너·전송 가드가 동일한 판정과 동일한
  `generatedAt` 스냅샷을 사용하게 합니다. 기본 모델이 degraded/incident일 때 사용자에게
  상태와 대안을 제시하되, 사용자에게 알리지 않는 자동 교체는 하지 않습니다.
- **출처**: 양쪽 공통 (외부는 Google 사례, 본인은 Perplexity 사례 — 동일 근본 원인)

---

### UX-003 · P1 · 프로브 대상이 아닌 Provider가 영구 Incident로 표시됨

- **화면/흐름**: `/status`
- **문제**: Perplexity가 *"202 consecutive automated probes have failed"* 사유로 Incident로
  표시되지만, 실제로는 **더 이상 프로브되지 않습니다.** 카운터가 동결되어 영원히 리셋되지
  않습니다.
- **사용자 영향**: 정상일 가능성이 높은 Provider에 대한 영구적 허위 장애 공시입니다.
  상태 페이지 전체의 신뢰도를 훼손합니다.
- **확인 근거**:
  - Perplexity `Last automated check` 2026-07-27 23:30 UTC로 고정. 나머지 10개 Provider는
    00:50 UTC (두 시점 00:33Z/00:54Z 관측에서 80분 이상 격차)
  - 소스: `lib/providerProbe.ts` — `PROBE_EXCLUDED_USAGE_CLASSES`가 `research`/
    `deep-research`를 제외하고, Perplexity는 전 모델이 검색 기반이라
    `getProbeModelFor("perplexity")`가 `undefined` 반환
  - 소스: `app/api/internal/provider-probe/check/route.ts` — `no_probe_model`을
    *"neither recorded as probe evidence nor logged as an attempt"* 로 early return
  - 결과: `consecutiveProbeFailures = 202`가 임계치(3) 이상으로 고정 →
    `evaluatePublicProviderStatus()`가 계속 `incident` 반환
- **검증 상태**: **확인됨**
- **권장 개선 방향**: `no_probe_model`을 단순 스킵이 아니라 **프로브 증거 무효화**로
  처리해 `unknown`(중립)으로 귀결시키고, 상태 사유 문구가 "프로브 실패"를 주장하지 않도록
  별도 reason code를 둡니다. 누적 카운터 정리 경로도 필요합니다.
- **출처**: 본인 (외부는 202회 수치만 인용, 동결 메커니즘은 미진단)

---

### UX-004 · P1 · 은퇴·비공개 처리된 모델이 공개 API에 노출되어 선택 가능

- **화면/흐름**: 모델 선택기 / `/api/models/status`
- **문제**: `llama-4-scout`가 정적 레지스트리에서 `publiclyListed: false, enabled: false,
  status: "disabled"`인데도 공개 API가 `available`로 반환합니다. 실제 호출은 HTTP 404입니다.
- **사용자 영향**: 사용자가 이 모델을 포함해 비교를 실행하면 해당 패널이 404로 실패합니다.
  3-model 비교에서 1개 패널 실패는 부분 실패·환불 경로를 동시에 트리거하므로 credit
  정합성까지 위험해집니다.
- **확인 근거**:
  - 소스 확인: `lib/models.ts:156` — `publiclyListed: false, enabled: false,
    status: "disabled", replacementModelId: "llama-3-3"`
  - 라이브 확인: `/api/models/status` 2026-07-28 01:52:08Z 및 **02:16:19Z(재배포 후)**
    — `llama-4-scout` `available`, `fallbackModelIds: []` (전체 33개 모델에 포함,
    non-available 0건). 재배포(`e062da86`) 후에도 동일하므로 배포 타이밍 문제가 아님
  - 배경: 커밋 `8a59091` 메시지가 *"sat at seven consecutive misses for six days while
    staying enabled and user-selectable, failing every call with HTTP 404"* 및
    *"lib/models.ts is a seed, not the runtime source … reconciliation … on the next
    catalog run"* 로 명시
  - 카탈로그 서비스 배포 `b48105ed-f851-4048-8a64-ae9ecb602578` SUCCESS (00:26:25Z)
- **검증 상태**: **확인됨** (정적 소스 ↔ 라이브 API 계약 drift)
- **권장 개선 방향**: catalogue·status API·picker가 공유하는 authoritative public-model
  selector를 두고 `publiclyListed:false`/disabled/retired를 일관되게 제외합니다. mock이
  아닌 실제 route handler 대상 contract test가 필요합니다. 아울러 이미 배포된 자동
  reconciliation이 실효했는지 1회 수동 실행으로 확인해야 합니다.
- **출처**: 양쪽 공통 (외부가 정적 소스 근거, 본인이 카탈로그/reconciliation 맥락)

---

### UX-005 · P1 · 기본 3-model 경로와 AI Review의 상용 가용성 미검증

- **화면/흐름**: 게스트/인증 채팅 — 기본 3-model 비교, AI Review
- **문제**: 기본 3-model(`gpt-5-4-mini`, `claude-haiku-4-5`, `gemini-2-5-flash`)이 실제
  Provider 환경에서 완료되는지, expected/actual credit이 일치하는지, 실패 시 환불이
  이루어지는지 확인되지 않았습니다.
- **사용자 영향**: 상용 서비스의 핵심 가치(다중 모델 비교)가 실환경에서 동작한다는 근거가
  없습니다.
- **확인 근거**:
  - 본인 감사가 승인을 받아 실행: `/api/chat` POST 20건 전부 HTTP 403
    `{"code":"TURNSTILE_REQUIRED"}`, **Provider 도달 0회, 소비 credit 0**
  - 원인: Cloudflare Turnstile이 자동화 브라우저에 토큰 발급 거부 — 제품 결함이 아니라
    검증 경로 제약
  - 게스트는 전체 AI Review가 로그인 게이트(`ai-review-guest-locked`)
  - 현재 Operational 판정은 전부 synthetic probe 근거이며 실 트래픽 성공은
    2026-07-27 10:19 UTC(약 14.5시간 경과)
  - 부수 확인(긍정): 요청 거부 시 3개 패널 모두 Retry/Report error/대체 모델 안내/Trace ID를
    노출하며 스핀 상태에 갇히지 않음
- **검증 상태**: **검증 필요** (승인은 있었으나 경로 부재)
- **권장 개선 방향**: 비자동화 브라우저 수동 실행, staging 인증 계정 자격증명, 또는 staging
  한정 Turnstile 우회 세션 중 하나를 확보해 실행합니다.
- **출처**: 양쪽 공통

---

### UX-006 · P2 · 요금제 가격과 기간이 접근성 트리에서 공백 없이 결합됨

- **화면/흐름**: `/pricing` — 요금제 카드
- **문제**: 시각적으로는 `$0.00 per month`로 보이지만 접근성 이름 계산에는 공백이 없어
  `$0.00per month`로 결합됩니다.
- **사용자 영향**: 스크린리더 사용자가 가격과 청구 주기를 부자연스럽게 듣습니다. 요금제
  선택은 결제 직전 판단이므로 오해 비용이 큽니다.
- **확인 근거**:
  - 소스: `components/marketing/PricingPageContent.tsx` —
    `<span className="text-4xl font-black">{displayPrice}</span>` 다음에
    `<span className="ml-2 …">{formatBillingPeriodLabel(...)}</span>`.
    형제 span 사이에 **텍스트 공백 없이 CSS margin만** 존재
  - 브라우저 실측 `textContent`: `$0.00per month`(Free), `$7.50per month`(Pro),
    `$12.50per month`(Max)
- **검증 상태**: **확인됨** (결합 사실). 개별 스크린리더의 실제 낭독 결과는 **검증 필요**
- **권장 개선 방향**: CSS 간격에 의존하지 않고 실제 공백·통합 문자열·정확한 `aria-label`
  중 의미 중복이 없는 방식을 택합니다. 시각 레이아웃과 현재 문법(`1 credit`,
  `Regular: … per month`)은 보존해야 합니다.
- **출처**: 외부 (본인 감사는 `innerText`만 확인해 놓침 — 정정함)

---

### UX-007 · P2 · `/pricing` 첫 로드 레이아웃 이동(CLS 0.173)

- **화면/흐름**: `/pricing` 모바일 첫 로드
- **문제**: 통화 확정 가격이 늦게 도착하면서 요금제 카드 높이가 재계산되어 큰 레이아웃
  이동이 발생합니다.
- **사용자 영향**: 읽는 중 내용이 밀려 오탭을 유발합니다. Core Web Vitals "good"
  기준(0.1)을 초과합니다.
- **확인 근거**:
  - 390×844 cold cache 3회: median CLS **0.173**, max 0.259 (LCP median 888ms)
  - 원인 규명 2회 추가 측정: 매번 정확히 **0.1734** 단일 shift, ~1.54s 발생
  - 원인 노드: `ARTICLE.relative flex min-h-full flex-col rounded-[1.75rem] border …`
    (텍스트 `"For starting outFree300 monthly AI credi…"`)
  - 페이지에 `Loading current credit-pack pricing…` placeholder 존재
  - 비교: `/` CLS median 0.034, `/chat` 360px CLS **0.000**
- **검증 상태**: **확인됨** (5회 재현, 결정적)
- **권장 개선 방향**: 가격 라인이 확정 전에도 최종과 동일한 높이를 점유하게 합니다.
  가격 **계산** 로직은 변경하지 않습니다.
- **출처**: 본인 (외부는 성능 측정 0회 수행, 스스로 `Not verified`로 명시)

---

### UX-008 · P2 · 모바일 프로젝트에서 100% 재현되는 E2E 실패(오래된 기대값)

- **화면/흐름**: 모바일 채팅 — 새 채팅 시작
- **문제**: `tests/e2e/chat-tools.spec.ts`의 *"web search mode selection does not repeat
  across a new chat"* 가 `mobile-chromium`에서 5/5 실패합니다.
- **사용자 영향**: 사용자 직접 영향은 없습니다(제품 결함 아님). 그러나 (a) 전체 suite가
  상시 red라 진짜 회귀를 가리고, (b) **"웹 검색 모드가 새 채팅으로 이월되지 않는다"는
  계약이 모바일에서 전혀 검증되지 않습니다.**
- **확인 근거**:
  - `mobile-chromium` 5/5 실패, `desktop-chromium`·`desktop-compact` 통과
  - 소스: `components/chat/MobileChatShell.tsx` — 새 채팅 버튼이
    `{!isActiveConversationEmpty && …}` 조건부 렌더. 테스트는 메시지를 보내지 않은 빈 대화
    상태에서 버튼을 찾음
- **검증 상태**: **확인됨**
- **권장 개선 방향**: 테스트를 삭제하지 말고, 모바일에서는 메시지 1회 전송 후 헤더 버튼을
  사용하는 경로로 수정하거나 데스크톱 전용 스코프 + 모바일 동등 검증을 별도 추가합니다.
- **출처**: 본인

---

### UX-009 · P2 · preflight 거절 시 provider-zero 보장의 비결정성

> **개정 1**: P3 → **P2**로 상향. 외부 측 지적을 수용합니다. flake 자체는 재현되지
> 않았으나(8/8 통과), **테스트가 `/api/chat`을 mock하므로 서버측 권위 가드의
> "Provider adapter 0회·credit mutation 0"이 어떤 테스트로도 증명되지 않는다**는 커버리지
> 공백은 flake 재현 여부와 무관하게 성립합니다. 심각도의 근거를 "저빈도 flake"가 아니라
> "안전 경계 미검증"으로 교체합니다.

- **화면/흐름**: 인증 2+ model 비교 — preflight 거절
- **문제**: preflight 429 상황에서 `/api/chat` 요청이 0건이어야 하는데, 외부 감사에서
  7회 중 1회 호출이 관측되었습니다.
- **사용자 영향**: 관측 자체는 자동화 증거의 비결정성입니다. 실제 사용자 영향은 확인되지
  않았습니다.
- **확인 근거**:
  - 외부: 7회 중 1회 실패, `Unexpected response` 패널 표시 (스크린샷 아티팩트 보유)
  - 본인 교차검증: `tests/e2e/upgrade-discovery.spec.ts` 해당 테스트 **8/8 통과, 재현 실패**
  - 합산 15회 중 1회(~7%)
  - 외부 스스로 명시한 한계: 이 테스트는 `/api/chat` 자체를 mock하므로 **실제 서버의 권위
    있는 per-model credit/cost 검증도 우회**합니다. 따라서 실제 Provider 호출이나 실제
    과금으로 단정할 수 없습니다
- **검증 상태**: **검증 필요** (한쪽에서만 재현, 저빈도)
- **권장 개선 방향**: 심각도를 P3으로 조정합니다. 근본 대응은 client preflight와 **서버측
  권위 가드를 분리해** 검증하는 것입니다 — 서버 통합 테스트에서 chat endpoint가 호출되어도
  Provider adapter 0회·credit mutation 0을 증명해야 합니다.
- **출처**: 외부 (심각도 P2 → P3 수정 채택)

---

### UX-010 · P3 · web-search 모드 preflight 계약의 회귀 테스트 부재

- **화면/흐름**: 인증 비교 — web search 모드 전환
- **문제**: `/api/chat/preflight` body의 `webSearchMode`를 단언하는 테스트가 없습니다.
- **사용자 영향**: 동일 유형의 결함(dependency array 누락)이 재발해도 CI가 잡지 못합니다.
  이 결함은 이미 한 번 배포 경로까지 간 유형입니다.
- **확인 근거**:
  - 수정 커밋 `f360ee3`는 `app/(application)/chat/ChatPageClient.tsx` 1줄만 변경, 테스트
    추가 없음
  - 공용 fixture `tests/e2e/support/app-fixtures.ts`의 preflight 핸들러는 `comparisonId`와
    `modelIds`만 읽음
  - `tests/e2e/native-web-search.spec.ts`는 `/api/chat` body만 검사
  - 본인 감사가 별도 스펙으로 5개 전이를 실캡처해 현재 동작이 올바름은 확인
    (off / off→always / always→off / 즉시 전송 / 빠른 연속 전환 모두 일치, stale 0건)
  - staging authenticated 환경의 실캡처는 양쪽 모두 없음
- **검증 상태**: **확인됨** (테스트 부재), 현재 동작은 **확인됨**(로컬 런타임)
- **권장 개선 방향**: 5개 전이와 credit matrix(지원 모델당 +8, 미지원/bundled +0)를 잠그는
  회귀 테스트를 추가합니다.
- **출처**: 양쪽 공통

---

### UX-011 · P3 · 상태 페이지에 실 트래픽 근거의 경과 시간이 드러나지 않음

- **화면/흐름**: `/status`
- **문제**: `Operational` 배지 대부분이 synthetic probe 근거만 가지며 실 트래픽 성공은
  14시간 이상 지난 값인데, 경과 시간이 드러나지 않습니다.
- **사용자 영향**: 상태의 신뢰 수준을 과대평가할 수 있습니다.
- **확인 근거**: 모든 Provider의 `Last real-traffic check`가 2026-07-27 10:19 UTC 또는
  `Never`. UI는 근거 유형(*"from an automated synthetic check, not real user traffic"*)은
  밝히지만 경과 시간은 표시하지 않음
- **검증 상태**: 확인됨
- **권장 개선 방향**: 표기만 추가합니다. 상태 판정 로직은 변경하지 않습니다.
- **출처**: 본인

---

### UX-012 · P3 · 성능 기준선 부재(chat/landing)

- **화면/흐름**: 전 구간
- **문제**: `/pricing` 외 route의 Web Vitals 기준선이 없습니다.
- **확인 근거**: 본인 감사가 `/pricing`, `/`, `/chat` 3개 route를 3회씩 측정(§UX-007).
  외부는 0회. 그러나 network throttling·cold/warm 조건 통제, landing/status 반복은 미수행
- **검증 상태**: 부분 확인됨
- **권장 개선 방향**: 현재 SHA에서 동일 조건 3–5회로 기준선을 만들고 단일 HTTP 응답 시간을
  Web Vitals로 보고하지 않습니다.
- **출처**: 본인 (외부 권고 #10과 동일 취지)

---

### UX-013 · P2 · 실기기 보조기술·모바일 키보드 미검증

> **개정 1**: P3 → **P2**로 상향. 외부 측 지적을 수용합니다. UX-001이 **외부 키보드
> 경로에서 재현**되므로 물리 키보드·IME 검증의 가치가 당초 평가보다 높습니다.

- **화면/흐름**: 전 구간
- **문제**: NVDA/JAWS, VoiceOver, TalkBack, Gboard, 삼성 키보드, iOS 한국어 키보드, 물리
  모바일 기기, 물리 외부 키보드가 모두 미검증입니다.
- **사용자 영향**: 자동 검사만으로 WCAG 전체 통과를 주장할 수 없습니다. 특히 UX-001이
  외부 키보드 경로에서 재현되므로 물리 키보드 확인의 가치가 큽니다.
- **확인 근거**: 양쪽 감사 모두 명시적으로 `Not verified`
- **검증 상태**: **검증 필요**
- **권장 개선 방향**: 핵심 5개 task(랜딩, 요금제, 모델 선택, 비교 전송, 실패 복구)에 대한
  수동 테스트 절차·기대 결과·기록 양식을 만들고 표본 검증합니다.
- **출처**: 양쪽 공통

---

### UX-014 · P3 · 모델 id와 브랜드 표시명의 세대 표기 불일치

- **화면/흐름**: 모델 선택기 / 운영 로그
- **문제**: 모델 id `gemini-2-5-flash`의 표시명이 `Gemini 3.1 Flash-Lite`입니다.
- **사용자 영향**: 기능상 영향 없음(요청 body는 id를 정확히 사용). 운영 로그 해석과
  고객 지원 시 혼동 여지가 있습니다.
- **확인 근거**: 브라우저에서 패널 헤더 `Gemini 3.1 Flash-Lite`, 같은 전송의
  `/api/chat` body `modelId: "gemini-2-5-flash"`
- **검증 상태**: 확인됨
- **권장 개선 방향**: id 변경은 마이그레이션 위험이 크므로 레지스트리에 대응 관계를
  문서화하는 선에서 처리합니다.
- **출처**: 본인

---

### UX-015 · P3 · 동의 배너 내 인라인 링크의 터치 영역

- **화면/흐름**: 동의 배너 (marketing / chat)
- **문제**: 본문 내 `Privacy policy` 링크가 marketing 138.2×28px, chat 74×12px입니다.
- **사용자 영향**: WCAG 2.5.8은 인라인 텍스트 링크를 예외로 두므로 위반은 아니나 모바일
  탭 정확도가 떨어집니다.
- **확인 근거**: 6개 viewport 실측
- **검증 상태**: 확인됨
- **권장 개선 방향**: 개선 시 배너 높이 계약(phone ≤80px)과 44×44 동의 버튼을 깨뜨리지
  않아야 합니다. 두 제약이 상충하므로 신중히 처리합니다.
- **출처**: 본인

---

### UX-016 · P3 · 테스트 실행 모드에 따라 결과가 달라짐

- **화면/흐름**: QA 파이프라인
- **문제**: 동일 테스트가 파일 전체 실행에서는 통과하고 단독(`-g`) 실행에서는 실패합니다.
- **사용자 영향**: 직접 영향 없음. 그러나 UX-001의 진단을 어렵게 하고, CI 결과의 의미를
  불안정하게 만듭니다. 또한 로컬 `retries: 0` / CI `retries: 2` 차이로 CI에서 불안정성이
  가려집니다.
- **확인 근거**: `chat-keyboard-policy.spec.ts` mobile 파일 전체 실행 9/9 통과 ×3회 vs
  단독 실행 5회 중 2회 실패
- **검증 상태**: 확인됨
- **권장 개선 방향**: 테스트 간 공유 상태·초기화 의존성을 제거해 실행 모드와 무관하게
  동일 결과가 나오게 합니다. UX-001 수정과 함께 다루는 것이 효율적입니다.
- **출처**: 최종 검토에서 추가

---

## 6. 핵심 사용자 흐름별 평가

| 흐름 | 평가 | 근거 | 관련 이슈 |
|---|---|---|---|
| 첫 진입과 정보 이해 | **양호** | 320–430px에서 H1·CTA 가림 0, overflow 0, console error 0 | — |
| 탐색 및 내비게이션 | **양호** | 브랜드 완전 단어 유지, header overflow 0, 200%/400% zoom 통과 | UX-015 |
| 핵심 작업 수행(비교 전송) | **위험** | 사용자 메시지 미렌더 간헐 재현 | UX-001 |
| 핵심 작업(실제 AI 응답) | **미검증** | Provider 도달 0회 | UX-005 |
| 모델 탐색·선택 | **주의** | 2단 disclosure·필터 정상, 그러나 은퇴 모델 노출 | UX-004 |
| 상태 확인(신뢰) | **위험** | 상태 페이지 ↔ API 모순, 영구 허위 Incident | UX-002, UX-003 |
| 빈 상태·로딩 | **주의** | 가격 로딩이 큰 레이아웃 이동 유발 | UX-007 |
| 오류·권한 제한 상태 | **양호** | 요청 거부 시 Retry·Report error·대체 모델 안내·Trace ID 노출, 스핀 고착 없음 | — |
| 성공·실패 피드백 | **위험** | 성공 경로의 피드백(사용자 메시지)이 누락될 수 있음 | UX-001 |
| 반응형 | **양호** | 320/360/375/390/430/landscape, 768–1024 비교 레이아웃 통과 | — |
| 키보드·포커스 | **주의** | 동의 배너 포커스 순서 양호(거부 우선), 그러나 전송 경로 race | UX-001 |
| 가독성·색상 의미 | **주의** | `unknown` 중립 렌더 등 의미 전달 양호, 접근성 문자열 결합 결함 | UX-006 |
| 디자인 시스템 일관성 | **양호** | 컨테이너 쿼리 기반 배너가 slot 폭에 일관 반응 | — |

---

## 7. 접근성 및 일관성 평가

| 항목 | 판정 | 자동 | 키보드 | 실기기 | 근거 |
|---|---|---|---|---|---|
| 동의 배너 포커스 순서·동등성 | Pass | 확인 | Tab 4/5(`/`), 8/9(chat), Decline 선행 | 미검증 | 실측 |
| 동의 액션 44×44 | Pass | Decline 61.1×44, Accept 51.3×44 | — | 미검증 | 6 viewport |
| 마케팅 CTA hit-test | Pass | `#landing-hero-primary` 자기 도달 | — | 미검증 | 6 viewport |
| 브랜드 accessible name | Pass | 가시 텍스트와 일치(숨김 변형 `display:none`) | — | 미검증 | 소스+실측 |
| composer 컨트롤 타깃 | Pass | 4개 모두 44×44 이상 | 전송 race 존재 | 미검증 | 실측 |
| 모델 선택기·모달 | Pass | back/done hit-area 단언 포함 | 통과 | 미검증 | E2E |
| Source grounding 의미 | Pass | *"does not measure factual accuracy, source reliability, or model confidence"* 명시 | 통과 | 미검증 | 소스 |
| **요금제 접근성 문자열** | **Fail** | `$0.00per month` 결합 | — | 미검증 | 소스+실측 |
| Provider 상태 semantics | Partial | `unknown` 중립 렌더 정상 | — | 미검증 | UX-002/003 |
| 320 CSS px reflow (1.4.10) | Pass | 4개 route overflow 0 | — | 미검증 | 실측 |
| 640 CSS px reflow | Pass | overflow 0 | — | 미검증 | 실측 |
| 200% text-only zoom (1.4.4) | **검증 필요** | CSP `style-src`가 계측 스타일 주입 차단 | — | 미검증 | 보안이 올바르게 동작한 결과 |
| forced-colors / reduced-motion | **검증 필요** | 미실행 | 미실행 | 미실행 | 양쪽 공통 누락 |
| light 테마 | 부분 확인 | dark 기준 계측 | — | 미검증 | |
| RTL locale | N/A | 지원 7개 locale(en/ko/zh/fr/de/es/pt)에 RTL 없음 | — | — | |
| 보조기술 실기기 | **검증 필요** | — | — | 미검증 | UX-013 |

**자동 검사만으로 WCAG 전체 통과를 주장하지 않습니다.**

---

## 8. 우선순위 로드맵

### 즉시 수정 (출시 차단 해소)

| 이슈 | 작업 |
|---|---|
| UX-001 | 전송/렌더 race 근본 수정 |
| UX-002 | 상태 판정 단일화 |
| UX-003 | 프로브 스킵의 증거 무효화 처리 |
| UX-004 | 은퇴 모델 노출 제거 및 실효 확인 |

### 단기 개선

| 이슈 | 작업 |
|---|---|
| UX-005 | 검증 경로 확보 후 상용 실호출 검증 |
| UX-006 | 요금제 접근성 문자열 |
| UX-007 | 요금제 CLS |
| UX-008 | 모바일 E2E 기대값 정정 |

### 중기 구조 개선

| 이슈 | 작업 |
|---|---|
| UX-009 | client/server 안전 경계 분리 검증 |
| UX-010 | preflight 계약 회귀 테스트 |
| UX-011 | 상태 근거 경과 시간 표기 |
| UX-016 | 테스트 실행 모드 독립성 |

### 추가 조사 또는 사용자 검증 필요

| 이슈 | 작업 |
|---|---|
| UX-012 | Web Vitals 기준선 |
| UX-013 | 보조기술 실기기 표본 검증 |
| UX-014 | 모델 id ↔ 표시명 정합 문서화 |
| UX-015 | 인라인 링크 터치 영역(제약 상충 검토 필요) |

---

## 9. 최종 결론

**판정: No-Go.** 두 독립 감사와 이번 교차검증이 동일한 결론에 도달했습니다.

해결된 것은 분명합니다. 320px 동의 배너 가림(P1), 브랜드 축약, CSP 위반 beacon, 영문
요금제 문법, web-search preflight의 stale mode는 실제 배포물에서 해소가 확인되었고,
보안·개인정보 영역은 회귀가 없습니다. 동의 이전 추적 0건, CSP 완화 0건은 실측으로
확인했습니다.

남은 차단 사유는 **신뢰 계층과 핵심 전송 경로**에 집중되어 있습니다. 사용자가 보낸
메시지가 화면에 나타나지 않는 경우가 있고, 공개 상태 페이지가 선언한 장애가 제품 UI에
반영되지 않으며, 은퇴 처리된 모델이 여전히 선택 가능합니다. 이 셋은 모두 "제품이 사용자에게
말하는 것과 실제로 하는 것이 다르다"는 하나의 문제 계열입니다.

**두 감사의 관계에 대하여**: 외부 감사는 접근성 트리와 전송 경로 심각도에서, 본인 감사는
상태 동결 메커니즘·성능 실측·테스트 무결성에서 각각 상대가 놓친 것을 잡았습니다. 어느
쪽도 다른 쪽의 상위 집합이 아닙니다. 특히 본인 감사의 두 가지 판단(전송 실패를 flake로
분류, FINAL-F006을 완전 해결로 판정)은 **틀렸고 이 보고서에서 정정했습니다.**

점수는 통합 기준으로 재산정하지 않았습니다. 두 감사가 서로 다른 가중치 해석을 적용했고,
어느 한쪽 점수를 채택하는 것이 근거를 더하지 않기 때문입니다. **판정(`No-Go`)과 차단
이슈 목록이 실질적 결론입니다.**

---

## 10. 확인 필요 사항과 감사 한계

### 제품 책임자 결정이 필요한 사항

1. **UX-002 설계 선택** — 모델 API가 공개 판정을 그대로 반영할지(A안), 아니면 분리를
   유지하되 채팅 UI에 경고를 넣을지(B안). 두 소스의 분리가 의도된 설계인지 단순 누락인지는
   현재 자료로 판단 불가합니다.
2. **UX-005 검증 경로** — staging 인증 계정 자격증명 제공 여부. 게스트 경로로는 전체
   AI Review를 검증할 수 없습니다.
3. **UX-004 대응 범위** — 이미 `llama-4-scout`를 선택해 둔 사용자의 처리 정책.
4. **UX-014** — 모델 id 리네이밍을 감수할지, 문서화로 갈음할지.
5. **UX-015** — 배너 높이 계약(≤80px)과 인라인 링크 44×44 중 무엇을 우선할지.

### 가정 (원본 요청서에 명시되지 않아 감사자가 설정)

- "대상 사용자"는 게스트 및 Free/Pro/Max 구독자로 가정했습니다. 원본 요청서는 명시하지
  않았습니다.
- "승인된 short brand"(FINAL-F004)는 `Tomverse`로 가정했습니다. 별도 승인 문서를 찾지
  못했습니다.
- STG-F008의 "승인된 추천 개수"는 코드의 `MAX_MODEL_RECOMMENDATIONS = 8`을 승인값으로
  간주했습니다.

### 감사 한계

1. **`REPORT_FINAL_KO.md` 원본 부재** — 리포지토리 전체 히스토리에 존재하지 않아 과거
   심각도와 기대 수정 내용을 원본으로 대조하지 못했습니다. 양쪽 감사 모두 소스 주석 기반
   재구성입니다.
2. **실제 Provider·credit 경로 미검증** — UX-005.
3. **staging DB 직접 조회 불가** — Provider 상태의 원시 레코드를 확인하지 못하고 공개
   API·상태 페이지·Railway 메타로 대체했습니다.
4. **브라우저 환경 제약** — 감사 컨테이너의 Chromium(1194)이 리포지토리 고정 버전
   (@playwright/test 1.62)과 달라 바이너리 경로를 지정했고, TLS 종단 프록시가 TLS 1.3
   handshake를 리셋해 `--ssl-version-max=tls1.2`를 사용했습니다. **인증서 검증은
   비활성화하지 않았습니다.** DOM·레이아웃·CSP·요청 본문 계측에는 영향이 없으나 TLS 버전
   의존 동작은 브라우저 경로로 관측되지 않았습니다.
5. **재현율의 환경 의존성** — UX-001의 실패율은 본인 감사 컨테이너 기준이며 CPU 부하에
   민감합니다. 절대 수치가 아닌 "간헐 재현" 사실로 해석해야 합니다.
6. **외부 감사 아티팩트 직접 검증 불가** — 외부 감사의 스크린샷·trace 파일에 접근하지
   못해 보고서 서술만으로 대조했습니다.
7. **본인 측정 오류 1건** — 초기 반복 측정에서 정규식 패턴 오류로 모바일 키보드 테스트를
   6/6 실패로 잘못 집계했습니다. 정정 후 5회 중 2회 실패입니다. 이 보고서의 수치는 정정본입니다.
