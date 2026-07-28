# Tomverse Insight 외부 UI 검토 결과 평가 및 진행 방향

> 작성일 2026-07-28 · 평가 대상 배포 SHA `791fef1d0468388f54d8e6d8bfddca55534766c0`
> 이 문서는 신규 생성된 자문 보고서이며, 그 외 어떤 파일·설정·스냅샷도 변경하지 않았습니다.

---

## 1. Executive Decision

| 항목 | 결정 |
|---|---|
| **외부 보고서 신뢰도** | **중간** |
| **외부 결과 수용 여부** | **부분 반박** (핵심 결론은 수용, 최대 근거 1건은 반박) |
| **제품 Go-Live 해석** | **NOT READY** — 외부 업체와 결론은 같으나 **이유가 상당 부분 다릅니다** |
| **최종 권고 진행 방향** | **④ 수정 우선 진행 후 재검증** (부수적으로 ②·③ 병행) |

### 핵심 요약

외부 업체의 **최종 결론(NOT READY)은 유지되어야 합니다.** 그러나 그 결론을 떠받치는 3대 근거 중 **가장 무겁게 제시된 `UI-P1-01` FAIL(모바일 44px 미달)은 방법론 오류이며 반박합니다.** 반대로 업체가 놓친 자리에서 **실제 출시 차단급 결함이 따로 존재합니다.**

즉 **"제품은 출시 불가"라는 결론은 옳지만, 수정해야 할 대상 목록은 업체가 제시한 것과 다릅니다.** 업체 목록대로 작업하면 멀쩡한 것을 고치고 진짜 결함을 방치하게 됩니다.

### 지금 즉시 해야 할 일 (우선순위 순)

1. **`UI-P1-01` 기반 수정 작업을 착수하지 마세요.** 44px는 실제 터치 기기에서 이미 충족되어 있습니다. 업체 수치는 touch pointer 미에뮬레이션 산물입니다(§6-A에서 소수점까지 재현). 이 지시로 `h-11`을 desktop까지 확대하면 **PC UI가 의도적 설계에 반해 둔해지고 `touch-targets.spec.ts`가 깨집니다.**
2. **요금 페이지 확대 overflow를 수정하세요.** 스테이징 실측 ko 128px / en 66px. 업체 보고서에 **전혀 없는 항목**이며, 현재 red인 CI의 실제 원인입니다.
3. **PR Fast Gate red 상태로 merge된 사실을 처리하세요.** 필수 aggregator가 실패한 채 `791fef1`이 develop에 들어갔습니다(§6-D 근거 확보 완료).
4. **`nightly-visual-regression.yml`을 `main`에 반영하세요.** 현재 GitHub에 **워크플로 자체가 등록되어 있지 않아 63장 golden이 CI에서 단 한 번도 실행된 적이 없습니다.**
5. **로그인 320px 분석 설정 pill 겹침을 수정하세요.** 업체 지적이 옳습니다. OAuth 버튼 탭의 9–22%를 pill이 실제로 가로챕니다.

### 가장 중요한 근거와 위험

- **결정적 반박 근거**: 업체 수치(전송 36×36, 크레딧 44.5×36, 완료 71.5×32, 모델선택 110.8×40, 뒤로 36×36)를 `hasTouch:false`에서 **소수점까지 100% 재현**했고, `hasTouch:true`에서는 전부 44로 바뀝니다. 소스의 `touchTarget = isMobileShell || hasCoarsePointer` 분기와 정확히 일치합니다.
- **가장 큰 제품 위험**: 업체가 `NOT VERIFIED`로 비워둔 **125–200% 확대 구간에 실제 P1이 숨어 있었다는 점.** 검증 공백이 곧 결함 은닉이 된 사례입니다.
- **가장 큰 의사결정 위험**: 업체 보고서를 그대로 작업지시서로 쓰면 **잘못된 수정 + 진짜 결함 방치**가 동시에 발생합니다.

---

## 2. 검토 자료와 한계

### 확인한 파일

| 파일 | 성격 | 상태 |
|---|---|---|
| `UI 검사.txt` (업로드) | 원 Review 명령서 (614행) | 전문 확인 |
| `TomverseInsightUIFinalReauditko.md` (업로드) | 외부 업체 최종 재감사 보고서 (453행) | 전문 확인 |
| `AGENTS.md`, `docs/ui-contracts/*.md` | 프로젝트 UI 계약 | 확인 |
| `components/chat/*.tsx`, `components/analytics/AnalyticsProvider.tsx` | 판정 근거 소스 | 확인 |
| `tests/e2e/*.spec.ts`, golden 63장 | 테스트·증거 | 확인 |
| `.github/workflows/*.yml` | CI 구성 | 확인 |

### 문서 버전·작성일

외부 보고서에 **버전 번호와 문서 작성일 필드가 없습니다.** 본문 내 "재감사 종료 2026-07-28 22:07:22 AEST"로 시점을 추정했습니다. 재감사 대상 SHA는 명확히 기재되어 있어 정합성 판단에는 지장이 없었습니다.

### 기준 감사 및 배포 SHA 정합성

| 항목 | 외부 업체 | 본 평가 | 판정 |
|---|---|---|---|
| Staging SHA | `791fef1d…` | `791fef1d…` (`/api/build-info` 재확인) | **일치** |
| origin/develop | `791fef1d…` | `791fef1d…` | **일치** |
| Local HEAD | `174a62bd…` (**17 커밋 뒤짐**) | `791fef1d…` (배포 SHA와 동일) | **불일치 — 업체 측 열위** |
| 배포 상태·시각 | success, 21:45:15 AEST | success, 2026-07-28T11:45:15Z | **동일 시각** (AEST=UTC+10) |

업체는 stale worktree를 인지하고 "최종 UI 판정에는 스테이징과 원격 SHA를 사용했다"고 명시했습니다. **이 처리는 적절합니다.** 다만 소스 대조 시 로컬 파일을 참조했다면 오염 가능성이 남으며, 보고서상 어느 판정이 로컬 소스에 의존했는지 구분되어 있지 않습니다.

### 열지 못했거나 누락된 별첨

외부 보고서가 참조하는 다음 자료는 **이번 평가에 첨부되지 않아 열람하지 못했습니다.**

- `./chat-guest-ko-320x568.jpg`, `./consent-pricing-ko-320x568.jpg`, `./signin-ko-320x568.jpg`, `./landing-ko-320x568.jpg`, `./signin-ko-1440x900.jpg`, `./model-picker-ko-390x844.jpg` — 업체 캡처 원본 6장
- 증거 폴더 `C:/Users/Vyper/.codex/visualizations/2026/07/28/019fa88b-…/tomverse-ui-final-reaudit`
- 기준 감사 보고서 `Tomverse-Insight-UI-Audit-ko.md` (기준 점수 항목별 배분의 원본)
- `./approved-goldens/*.png` — 단, 동일 파일이 저장소에 존재하여 **원본으로 직접 대조했습니다.**

**추정으로 채우지 않았습니다.** 위 자료가 필요한 판정은 §4에 `증거 부족`으로 표기했습니다.

### 이번 평가에서 직접 확인한 것 / 확인하지 못한 것

**직접 확인 (읽기 전용, 배포 SHA `791fef1` 대상)**
- 320px hit-area를 coarse/fine pointer 양쪽에서 실측 — 업체 수치 재현 검증
- 로그인 320/390 × ko/en × consent 3상태에서 설정 pill 겹침 및 격자 hit-test
- 전 route SSR 원본 HTML의 `<html lang>` (curl, hydration 이전)
- 1280·1366px × sidebar 3상태의 모델 패널 수
- GitHub Actions 워크플로 등록 목록, PR Fast Gate run `30355658889` job/step 결과
- 요금 페이지 확대 overflow (layout viewport 직접 축소 방식)

**확인하지 못한 것**
- 실기기 iOS/Android (컨테이너에 WebKit 없음)
- golden 픽셀 동등성 (repo가 pin한 chromium build 1234를 egress 정책이 차단)
- 업체 캡처 원본 6장의 캡처 조건 메타데이터

---

## 3. 원 Review 명령 준수 매트릭스

| 원 요구사항·Finding | 외부 업체 결론 | 제출 증거 | 준수도 | 독립 의견 | 빠진 조건·증거 | 영향 |
|---|---|---|---|---|---|---|
| **기준선·배포 SHA 정합성** | staging=origin/develop 확인, local 17커밋 뒤짐 명시 | build-info, git 상태 | **충족** | 동일 확인. 처리 방식 적절 | 로컬 소스 의존 판정의 구분 부재 | 낮음 |
| **UI-P1-01** 44px | **FAIL** | 13행 측정표, 320/390 | **미충족** | **반박.** touch pointer 미에뮬레이션 | 원 명령 §3 "실제 클릭 가능한 영역" = 실기기 조건. coarse pointer 미적용 | **높음** — 잘못된 수정 유발 |
| **UI-P1-02** 동의 notice | **FAIL** | notice box, CTA 교차 px² | **부분 충족** | **조건부 수용.** 결함 실재하나 scope·등급 정정 필요 | consent 3상태 구분, 390/1440 대조, hit-test 부재 | 중간 |
| **UI-P1-03** 상태 렌더 | **PARTIAL** | golden 63장 인벤토리, 대표 8장 | **부분 충족** | **수용, 근거 보강.** 실제로는 더 심각 | 원 명령 §3 "렌더 결과를 시각적으로 검사" — 63장 중 8장만 검사 | 중간 |
| **UI-P2-01** ko 줄바꿈 | PARTIAL | 320 H1 3줄, overflow 0 | **부분 충족** | **조건부 수용.** 측정은 정확, 확대 미검증으로 PARTIAL은 타당 | 어절별 Range 측정 부재(줄 수만 확인) | 낮음 |
| **UI-P2-02** 로그인 언어 | PARTIAL | ko/en DOM, SSR lang | **충족** | **수용, 범위 확대 필요** | signin만 지적. 실제로는 전 route | 중간 |
| **UI-P2-03** Bottom Sheet | PARTIAL | 390 첫 화면 항목, focus 복귀 | **부분 충족** | **조건부 수용.** PARTIAL 사유 중 32px 근거는 무효 | 완료 32px 근거가 UI-P1-01과 동일 오류 | 중간 |
| **UI-P2-04** 보조 text | PARTIAL | "관찰 최저 11px" | **부분 충족** | **조건부 수용.** 결론 방향 맞으나 근거 약함 | 전수 스캔 아닌 "관찰". 확대 미검증이 P1 은닉 | **높음** |
| **UI-P3-01** 브랜드 | PASS | 랜딩·Chat·Review 골든 | **충족** | **수용** | `check:accent-tokens` 실행 근거 부재 | 낮음 |
| **새 회귀 탐색** | 3건 (P1×2, P2×1) | CI run, 교차 측정, SSR | **부분 충족** | 2건 수용·1건 반박, **3건 신규 누락** | 태블릿·확대·키보드 회귀 미탐색 | **높음** |
| **필수 화면 전 범위** | 대부분 확인 | 10장 스테이징 캡처 | **부분 충족** | AI Review·첨부·DR은 골든 의존 | 실렌더 캡처 10장은 필수 18개 화면 대비 부족 | 중간 |
| **PC/mobile** | 8개 viewport | DOM 측정표 | **충족** | 1280 결과만 재현 불가 | — | 낮음 |
| **light/dark** | 라이트 실렌더 + 골든 다크 | | **부분 충족** | **다크 실렌더 0장** | 원 명령 "필수 테마: 라이트, 다크" | 중간 |
| **한국어/영어** | 양쪽 확인 | | **충족** | 동일 확인 | — | 낮음 |
| **320px** | 확인 | | **충족** | 동일 확인 | — | 낮음 |
| **200% 확대** | **NOT VERIFIED** | — | **미충족** | **바로 이 구간에 실제 P1 존재** | 원 명령 §6 필수 항목 | **매우 높음** |
| **상태 fixture·골든** | 63장 인벤토리 | 8장 검사 | **부분 충족** | 이미지 품질은 우수 | CI 실행 이력 0회 (업체 지적 옳음) | 중간 |
| **keyboard/focus** | focus trap PASS, 전수 미완료 | Picker 검사 | **부분 충족** | 동일 결과 재현 | 앱 전역 tabbable 미검사 | 낮음 |
| **contrast** | **NOT VERIFIED** | — | **미충족** | 로컬 실행 시 light·dark 각 5종 **통과** | CI red를 이유로 미판정 처리 — 과도 | 중간 |
| **safe area** | **NOT VERIFIED** | — | **미충족** | 구조상 위험 낮음, 실기기 미확인 | — | 중간 |
| **점수 재산정** | 78/100 (+5) | 항목별 표 | **충족** | 형식 충족, 일부 근거 무효 | UI-P1-01 오류가 2개 항목 점수에 반영됨 | 중간 |
| **Go-Live 규칙 적용** | NOT READY | | **충족** | 결론 동의 | — | 낮음 |

---

## 4. 외부 업체 주장별 판정

| 주장·판정 | 외부 근거 위치 | 독립 판정 | 판단 이유 | 확신 수준 | 필요한 후속 조치 |
|---|---|---|---|---|---|
| **UI-P1-01 FAIL** — 전송 36×36 등 다수 44px 미달 | §4 UI-P1-01 측정표 (13행) | **반박** | `hasTouch:false`에서 업체 수치를 **소수점까지 전부 재현**. `hasTouch:true`에서는 전량 44. 소스 `touchTarget = isMobileShell \|\| hasCoarsePointer`와 일치하며, `touch-targets.spec.ts`는 desktop이 44 미만임을 **의도적으로 assert**함 | **높음** | 이 finding 기반 수정 **중단**. 업체에 재측정 요청 |
| "44px 모서리에서 `elementFromPoint()`가 부모 div 반환" | §4 UI-P1-01 본문 | **반박(부수)** | 36px 버튼의 가상 44px 모서리는 원래 버튼 밖이므로 부모 반환이 정상. 순환 논증 | 높음 | — |
| **UI-P1-02 FAIL** — 설정 pill이 계정 CTA 침범 | §4 UI-P1-02 교차표 | **조건부 수용** | 결함 **실재**. 단 ①consent 결정 후에만 발생 ②320px 한정(390 겹침 0) ③실제 탭 탈취는 Microsoft 버튼 면적의 9%(ko)/22%(en). 업체 수치(Google 628.4 + MS 171.4)는 본 평가(MS 1142.5, Google 0)와 불일치 | **높음**(결함), 중간(수치) | 수정 필요. 등급은 P1 조건 위반이나 실패 강도는 P2 |
| notice 자체는 크게 개선됨 (교차 0px², 44×44 버튼) | §4 UI-P1-02 전반부 | **수용** | 44개 조합 독립 재현: 교차 0px², `position: static` | 높음 | 없음 |
| **UI-P1-03 PARTIAL** | §4 UI-P1-03 | **수용 (근거 보강)** | 결론 정당. **실제로는 업체 서술보다 심각** — golden suite는 CI에서 **0회 실행** | 높음 | §6-E 참조 |
| "nightly workflow가 활성 목록에 없고 실행 이력 미확인" | §4 UI-P1-03 | **수용 (확정)** | GitHub 활성 워크플로 9개 중 부재 확정. 원인 규명: 파일이 `develop`에만 있고 `main`에 없음. schedule은 기본 브랜치에서만 등록·실행 | **높음** | `main` 반영 필요 |
| **UI-REG-P1-01** — `@ui-risk` red 상태로 merge | §10 | **수용 (근본 원인 제공)** | run `30355658889` step 12 failure, 필수 aggregator failure 확정. **업체가 확보 못 한 실패 spec을 본 평가에서 특정**: `pricing-promotion-reflow.spec.ts:152` 320@200%(en), 2개 project 동시 | **높음** | 즉시 수정 |
| **UI-REG-P2-01** — SSR `<html lang="en">` | §10 | **수용 (범위 확대)** | curl 확인. **signin뿐 아니라 `/ko`, `/chat` 등 전 route**가 `lang="en"`. `/ko`는 `<div lang="ko">` subtree로 부분 보정되나 **signin은 subtree조차 없음**(`lang="ko"` 출현 0회) | **높음** | 루트 문서 lang 전달. `docs/ui-contracts/typography.md`의 `:lang()` 계약과도 충돌 |
| "1280px에서 3열이 아니라 단일 active panel" | §6 viewport 표 | **반박** | 1280×720에서 sidebar `auto`/`collapsed`/`expanded` **3상태 모두 3열**(각 280px) 재현. 1366도 3열 | 높음 | 업체 측 viewport 실측치 확인 요청 |
| "125/150/200% 확대 NOT VERIFIED" | §2, §6 | **수용하되 중대 결함으로 평가** | 미검증 처리 자체는 정직. 그러나 **이 구간에 실제 P1 존재** — 검증 공백이 결함 은닉으로 직결 | 높음 | 도구 교체 후 필수 재검증 |
| "가상 키보드·safe area NOT VERIFIED" | §2, §6 | **조건부 수용** | 미검증 처리는 타당. 단 "UI-risk CI가 실패해서 fixture를 근거로 쓰지 않았다"는 논리는 과도 — 실패 spec은 요금 reflow 1건이며 키보드 spec은 통과 | 중간 | 실패 spec 특정 후 재평가 가능 |
| "WCAG AA NOT VERIFIED" | §7 | **반박(부분)** | 동일 이유. `ui-state-contrast.spec.ts` light·dark 각 5종을 로컬 재실행하여 **전부 통과** 확인 | 높음 | AA는 통과로 상향 가능 |
| **UI-P2-04 PARTIAL** — "관찰 최저 11px" | §4 UI-P2-04 | **조건부 수용** | 결론 방향 일치. 단 "관찰"은 전수 아님. 본 평가 전수 스캔: 6개 화면 × 4 zoom에서 **11px 미만 0건**. 그러나 요금 확대 overflow로 PARTIAL은 유지 타당 | 높음 | 근거를 전수 측정으로 교체 |
| **UI-P2-03 PARTIAL** — "완료 32px, 뒤로 36px" | §4 UI-P2-03 | **부분 반박** | 정보 단계화 PASS 판단은 수용. **32/36px 근거는 UI-P1-01과 동일한 측정 오류**로 무효. 실기기 조건에서 완료 71.5×44, 뒤로 44×44 | 높음 | PARTIAL 사유를 키보드·safe area 미검증만으로 축소 |
| **UI-P3-01 PASS** | §4 UI-P3-01 | **수용** | 독립 확인 일치. `check:accent-tokens` 통과(guarded 10파일·10역할)로 근거 보강 | 높음 | 없음 |
| **점수 78/100 (+5)** | §11 | **조건부 수용** | 체계·형식은 원 명령 부합. 단 "컴포넌트 일관성 8→7", "접근성 6→5" 하향이 **무효한 UI-P1-01에 의존** | 중간 | §11 독립 재산정 참조 |
| **최종 NOT READY** | §14 | **수용** | 결론 일치. 단 근거 구성은 재작성 필요 | 높음 | — |
| "모바일 UI가 지나치게 성김 — 문제 없음" | §9 | **범위 외 표현 오류** | 표의 "문제 없음" 판정과 비고 문장이 서로 어긋남(서술 오류). 실질 판단은 동의 | 낮음 | 문장 정정 요청 |

---

## 5. 증거 및 방법론 품질

### 배포 SHA와 기준선 통제 — **양호**

staging/origin/local 3자를 분리 기재하고 local이 17커밋 뒤졌음을 명시한 점, 판정에 스테이징을 우선한 점은 원 명령 §1을 정확히 따랐습니다. **이 항목은 모범적입니다.**

### viewport·locale·theme·zoom 범위 — **미흡**

| 축 | 원 명령 요구 | 업체 실행 | 판정 |
|---|---|---|---|
| viewport | 필수 3 + 회귀 4 + 태블릿 | 8종 | 충족 |
| locale | ko, en | ko, en | 충족 |
| theme | **light, dark 필수** | **실렌더 light만**, dark는 골든 이미지로 대체 | **미충족** |
| zoom | **100/125/150/200% 필수** | **100%만** | **미충족** |

**zoom 축 전면 누락이 이 보고서의 최대 방법론 결함입니다.** 업체는 "인앱 브라우저 확대가 CSS viewport/scale에 적용되지 않아"를 사유로 들었으나, 원 명령 §6이 제시한 대안(**Playwright mobile emulation**)을 시도한 흔적이 없습니다. layout viewport를 직접 축소하는 방식(320÷2=160px)은 별도 도구 없이 즉시 가능하며, 본 평가는 그 방식으로 P1을 찾았습니다.

### 스크린샷 메타데이터와 추적 가능성 — **부분 충족**

§12에 공통 메타데이터(SHA, 캡처일, theme, zoom)를 블록으로 제시한 점은 원 명령 §8에 부합합니다. 다만 **개별 이미지에 캡처 시각·finding ID가 붙어 있지 않고**, 이미지 파일 자체가 이번 평가에 첨부되지 않아 **교차 검증이 불가능**했습니다. 골든 8장만 저장소 원본으로 대조 가능했습니다.

### DOM bounding-box, hit-test, overlap, contrast 측정 — **혼재**

- **overlap 측정**: px² 단위 교차 면적을 제시한 점은 원 명령 §3 "실제 화면상의 교차 영역을 측정"에 정확히 부합. **방법론상 우수.**
- **hit-test**: `elementFromPoint()` 사용은 적절하나, **대상 요소가 실기기 조건으로 렌더되지 않은 상태**에서 수행되어 결과가 무의미해졌습니다.
- **bounding-box**: 수치 자체는 정확(재현됨). **환경 설정이 틀렸을 뿐입니다.**
- **contrast**: 측정을 수행하지 않고 CI 상태로 대체 판정 — 원 명령이 요구한 실측이 아닙니다.

### fixture의 실제 제품 컴포넌트 사용 여부 — **충족**

"deterministic route fixture가 실제 Chat 컴포넌트를 사용합니다", "골든 자동 갱신 없이 screenshot diff를 검사합니다"는 서술을 독립 확인했습니다. 원 명령 §9의 "테스트 전용 가짜 UI 우회" 위험을 정확히 점검했습니다. **이 항목도 모범적입니다.**

### 테스트 재현 가능성 및 CI 포함 여부 — **우수**

nightly workflow 미등록 발견은 **이 보고서에서 가장 가치 있는 기여**입니다. 본 평가에서 확정했습니다.

| workflow | 등록 | 트리거 | develop 라인 실행 |
|---|---|---|---|
| PR Fast Gate | ✅ | PR | 실행됨 — **RED** |
| Main Chromium Regression | ✅ | `push: main` | **미실행** |
| Nightly Visual Regression | ❌ **미등록** | schedule(기본 브랜치) | **영구 미실행** |
| Daily Security Audit | ✅ | schedule(기본 브랜치) | main 코드 대상 |

→ **63장 golden과 전체 chromium 회귀는 이번 UI 작업에 대해 CI에서 한 번도 실행되지 않았습니다.**

### PASS/PARTIAL/FAIL/NOT VERIFIED 적용의 일관성 — **비일관**

- `NOT VERIFIED` 남용: "`@ui-risk` gate가 red이므로 통과 근거로 쓸 수 없다"를 contrast·키보드·safe area·11px floor에 **일괄 적용**했습니다. 실패 spec 1건(요금 reflow)이 무관한 6개 항목의 판정을 오염시켰습니다. 이는 **연좌 적용**이며 원 명령의 항목별 판정 원칙에 어긋납니다.
- `FAIL` 기준 불일치: UI-P1-01은 일부 조작 실패로 전체 FAIL, UI-P2-03은 동일 성격 실패(32px)에도 PARTIAL. 같은 근거에 다른 등급입니다.

### 점수와 Go-Live 결론의 논리적 정합성 — **부분 정합**

원 명령의 100점 체계와 항목 배점을 정확히 사용했고, 기준 대비 증감 근거를 항목마다 달았습니다. **형식은 충족.** 다만 "컴포넌트 일관성 8→7(hit-area token 전파 실패)"과 "접근성 6→5(44px)" 두 하향이 무효 근거에 의존하므로 **최소 2–3점이 부당하게 차감**되었습니다. 동시에 요금 overflow 미발견으로 **레이아웃·접근성 항목이 과대평가**되어, 우연히 총점은 비슷한 수준에 수렴합니다.

---

## 6. 독립 표적 검증 결과

배포 SHA `791fef1` 대상 읽기 전용 검증. **업체 제출 증거와 혼합하지 않았습니다.**

| 항목 | 외부 보고서 주장 | 독립 확인 조건 | 독립 관찰·측정 | 일치 여부 | 판정 영향 |
|---|---|---|---|---|---|
| **A. 44px hit-area** | 전송 36×36, 크레딧 44.5×36, 완료 71.5×32, 모델선택 110.8×40, 뒤로 36×36 → FAIL | 320×568 ko, staging 실렌더, `hasTouch` 양쪽 | `hasTouch:false`: 전송 **36×36**, 크레딧 **44.5×36**, 완료 **71.5×32**, 모델선택 **110.8×40**, 뒤로 **36×36** / `hasTouch:true`: 전송 **44×44**, 크레딧 **44.5×44**, 완료 **71.5×44**, 모델선택 107.5×44, 뒤로 **44×44** | **수치 완전 일치(fine), 결론 불일치** | **UI-P1-01 FAIL 반박** |
| **B. 로그인 pill 겹침** | Google 628.4px², Microsoft 171.4px² → FAIL | signin 320/390 × ko/en × consent 3상태, 격자 hit-test(45점) | consent `unset`: pill **부재**. `accepted`/`declined`: pill `fixed` 69.6×44 @ (242.4, 516). **Microsoft 버튼과 1142.5px² 교차**, Google 0. 실제 탭 탈취 **ko 4/45(9%), en 6/27(22%)**. 390×844: **겹침 0** | **결함 일치, 수치·대상 불일치** | **UI-P1-02 조건부 수용 / 본 평가 이전 PASS 판정 정정** |
| **C. SSR 문서 언어** | `?lang=ko` SSR이 `<html lang="en">` → UI-REG-P2-01 | curl로 hydration 이전 원본 HTML | `/auth/signin?lang=ko`, `/auth/signin?lang=en`, `/ko`, `/chat` **모두 `<html lang="en">`**. `lang="ko"` 출현: `/ko` 1회(div wrapper), **signin 0회** | **일치, 범위는 업체 서술보다 넓음** | **수용 + 범위 확대** |
| **D. `@ui-risk` CI 실패** | PR #125 UI-risk 단계 실패, merge 시 미대기 | run `30355658889` job/step 조회 + 로컬 재현 | step 12 "Run high-risk UI regression checks" **failure** (11:42:23–11:44:27Z), 필수 aggregator "Enforce upstream job results" **failure**. 로컬 재현: **74 passed / 2 failed**, 실패 spec = `pricing-promotion-reflow.spec.ts:152` **320@200%(en)**, 2 project 동시 | **일치 + 근본 원인 신규 확정** | **수용, 실행 가능한 수정 대상 확보** |
| **E. nightly workflow 미등록** | 활성 목록에 없고 실행 이력 미확인 | GitHub 활성 워크플로 목록 + main/develop 파일 대조 | 활성 9개 중 **부재 확정**. 파일이 `develop`에만 존재, **`main`에 없음** → schedule 미등록 | **완전 일치, 원인 규명** | **수용, 수정 방법 확정** |
| **F. 1280px 단일 패널** | "compact desktop 단일 panel" | 1280×720 / 1366×768 × sidebar `auto`·`collapsed`·`expanded` | **6/6 조합 모두 3열.** 1280: 280×3, 1366: 223×3 | **불일치** | **반박** |
| **G. 요금 확대 overflow (업체 미보고)** | 언급 없음 | layout viewport 직접 축소, ko/en × 160/195/213/260px | ko: 160px **128px 넘침**, 260px(390@150%) **28px 넘침**. en: 160px **66px** 넘침. 원인 `span.text-5xl.font-black` 요금 숫자 | **업체 보고서에 부재** | **신규 P1 확정** |
| **H. 태블릿 3패널 (업체 "overflow 0"으로 통과 처리)** | 768/1024 "단일 active panel, overflow 0" | 768×1024, 834×1112, 1024×768 × coarse/fine | 빈 대화에서 패널 너비 **[568, 0, 0]** — 2·3번 패널 너비 0, **탭 바 미렌더**(`!isConversationEmpty` 조건) | **업체가 결함으로 인지하지 못함** | **신규 P2** |
| **I. WCAG AA 대비** | NOT VERIFIED | `ui-state-contrast.spec.ts` 로컬 실행 | light·dark 각 5종(full-error/partial-failure/mobile chrome/sidebar/model panel) **전부 통과** | **불일치 — 업체가 과소평가** | **AA 통과로 상향** |
| **J. 11px floor** | "관찰 최저 11px" | 6개 화면 × 100/125/150/200% 전수 스캔 | **11px 미만 0건** (모델 sheet·전체 카탈로그 32개 포함) | **결론 일치, 근거 강화** | 수용 |

---

## 7. 동의하는 점, 이견, 누락

### 동의하는 점

1. **최종 결론 NOT READY** — 근거 구성은 달라도 결론은 같습니다. 신규 P1(요금 overflow) + P1 조건 위반(pill 겹침) + 필수 CI red 상태 merge가 모두 성립합니다.
2. **필수 UI 게이트가 red인 채 merge된 사실** (UI-REG-P1-01) — GitHub API로 확정했습니다. 프로세스 결함으로서 제품 결함 못지않게 중요합니다.
3. **nightly visual workflow 미등록** — 이 보고서의 최고 기여입니다. 파일 존재를 실행 증거로 착각하지 않은 정확한 판단이며, 원 명령 §9의 "테스트 파일이 존재하지만 CI에 포함되지 않았다면 미검증" 지침을 정확히 적용했습니다.
4. **SSR `<html lang="en">`** — 실재하며 업체 서술보다 범위가 넓습니다.
5. **로그인 320px 설정 pill이 계정 CTA를 침범** — 실재하며 실제로 탭을 가로챕니다.
6. **UI-P3-01 PASS** — 독립 확인 일치.
7. **fixture가 실제 제품 컴포넌트를 렌더링하는지 점검한 것** — 방법론적으로 정확합니다.
8. **로컬 worktree가 17커밋 뒤졌음을 명시하고 스테이징을 우선한 것** — 정직하고 적절합니다.

### 조건부로 동의하는 점

1. **UI-P1-02 FAIL** — 결함은 실재하나 ①consent 결정 후 상태 한정 ②320px 한정(390 겹침 0) ③탭 탈취율 9–22%. `notice` 본체는 44개 조합에서 결백하므로 **FAIL보다 PARTIAL이 정확**합니다.
2. **UI-P1-03 PARTIAL** — 결론 수용. 단 "attachment/AI Review가 데스크톱 라이트 편중"이라는 사유보다 **"CI 실행 이력 0회"** 가 훨씬 무거운 사유이며, 그 순서로 재서술되어야 합니다.
3. **UI-P2-04 PARTIAL** — 결론 수용, 근거 교체 필요("관찰" → 전수 측정 0건 + 요금 overflow).
4. **UI-P2-03 PARTIAL** — 정보 단계화 평가는 우수. **32/36px 사유는 삭제**하고 키보드·safe area 미검증만 남겨야 합니다.
5. **점수 78** — 체계는 정확, 2개 항목의 하향 근거가 무효.

### 반박하거나 재검토가 필요한 점

1. **UI-P1-01 FAIL — 반박.** 최우선 근거로 제시된 항목이며, 그대로 수용하면 실질적 해를 끼칩니다.
   - 업체 수치를 `hasTouch:false`에서 소수점까지 재현했습니다.
   - 소스 근거: `ModelCatalogue.tsx:127`, `ModelPickerPanel.tsx:174` — `touchTarget = isMobileShell || hasCoarsePointer`. `h-11`(44) vs `h-9`(36) / `h-8`(32) / `py-2`(32) 분기가 업체 수치와 1:1 대응합니다.
   - `tests/e2e/touch-targets.spec.ts`의 `assertBelowMinTouchTarget()`은 **desktop이 44 미만임을 의도적으로 검증**합니다. 업체 지시대로 고치면 이 테스트가 깨집니다.
   - 원 명령 §3은 "**320px와 390px에서** 모든 핵심 조작의 실제 클릭 가능한 영역"을 요구합니다. 이는 폭 조건이 아니라 **모바일 기기 조건**이며, coarse pointer 없이는 성립하지 않습니다.
2. **"1280px 단일 패널" — 반박.** sidebar 3상태 전부에서 3열 재현. 업체 측 실제 CSS viewport가 1280 미만이었을 가능성이 높습니다(zoom 미적용 문제와 동일 원인 추정).
3. **contrast·키보드·11px의 `NOT VERIFIED` 처리 — 재검토.** 무관한 spec 1건의 실패를 6개 항목에 연좌 적용했습니다. contrast는 로컬 실행 결과 **light·dark 전부 통과**입니다.
4. **§9 "모바일 UI가 지나치게 성김: 문제 없음"** 행의 비고 문장이 판정과 모순됩니다(서술 오류).

### 원 명령 대비 누락된 점

| 누락 | 원 명령 근거 | 심각도 |
|---|---|---|
| **125/150/200% 확대 전면 미실행** | §6 필수 | **치명적** — 실제 P1이 이 구간에 존재 |
| **다크 테마 실렌더 0장** | §2 "필수 테마: 라이트, 다크" | 높음 |
| **요금 페이지 확대 검사** | §3 UI-P2-04 완료 조건 | **치명적** |
| **태블릿 3패널 붕괴 미인지** | §6 "모델 패널 높이 불균형" | 중간 |
| **골든 63장 중 55장 미검사** | §3 "렌더 결과를 시각적으로 검사" | 중간 |
| **`check:accent-tokens` 미실행** | §9 소스·테스트 검토 | 낮음 |
| **before/after 대조 부재** | §8 "기준 보고서 스크린샷과 동일 조건 비교" | 중간 |
| **실패 spec 특정 실패** | §9 CI 확인 | 높음 — 수정 착수 불가 상태로 보고됨 |

---

## 8. 위험 평가

### 제품 결함 위험

| 위험 | 심각도 | 발생 가능성 | 현재 증거 | 출시 영향 | 완화 방법 |
|---|---|---|---|---|---|
| 요금 페이지 확대 overflow (ko 128px/en 66px) | **P1** | 확실 (재현 100%) | 스테이징 실측 + CI red, 독립 2중 근거 | **차단** — 결제 전환 경로 | 요금 숫자 fluid type 적용, plan card min-width 제한 |
| 로그인 320px pill이 OAuth 탭 9–22% 탈취 | **P2**(P1 조건 위반) | 높음 (consent 결정 후 모든 방문) | 격자 hit-test 45점 | **차단** (P1 완료 조건 위반) | signin에서 pill을 문서 흐름 또는 전용 slot으로 |
| SSR `<html lang="en">` 전 route | **P2** | 확실 | curl 원본 HTML | 조건부 | 서버에서 locale을 루트 문서까지 전달 |
| 태블릿 768–1024 빈 대화 1/3 패널·탭 부재 | **P2** | 높음 | 5개 폭 실측 + 소스 `!isConversationEmpty` | 후속 가능 | 빈 대화에서도 탭 바 렌더 |
| 환영 화면 composer 키보드 하단 이탈 | **P2 (미검증)** | 불명 | 시뮬레이션 재현, 실기기 미확인 | 조건부 | 실기기 1회 확인 후 판단 |
| 160px sheet 제목 어절 분절 | P3 | 낮음 | 스크린샷 | 없음 | `break-keep` |
| Google 로고 외부 도메인 직참조 | P3 | 중간 | 소스 + 렌더 실패 관찰 | 없음 | 로컬 asset 전환 |

### 검증·의사결정 위험

| 위험 | 심각도 | 발생 가능성 | 현재 증거 | 출시 영향 | 완화 방법 |
|---|---|---|---|---|---|
| **업체 보고서를 작업지시서로 사용** → 멀쩡한 44px를 "수정"하고 desktop UI 훼손 + `touch-targets.spec.ts` 파손 | **매우 높음** | **높음** (보고서 최우선 근거) | §6-A | 회귀 유발 | 본 문서 §1-1 즉시 전달 |
| **golden 63장이 CI에서 0회 실행** — 회귀 감지망 부재 | **높음** | 확실 | 워크플로 목록 + 파일 대조 | 상시 위험 | nightly를 `main`에 반영 |
| **필수 gate red 상태 merge 가능** — 프로세스 구멍 | **높음** | 재발 가능 | run 30355658889 | 상시 위험 | branch protection 재점검 |
| 확대·다크 실렌더 검증 공백 | **높음** | 확실 | §7 누락표 | 미발견 결함 잔존 | 도구 교체 후 재검증 |
| 업체 캡처 원본 미첨부 → 교차 검증 불가 | 중간 | 확실 | §2 | 신뢰도 저하 | 원본 요청 |
| 업체 로컬이 17커밋 뒤짐 | 낮음 | 확실 | §2 | 낮음 | 업체가 이미 통제 |

---

## 9. 권고 진행 계획

### 즉시

| # | 작업 | 담당 | 산출물 | 완료 조건 | 선행 조건 |
|---|---|---|---|---|---|
| I-1 | **UI-P1-01 기반 수정 전면 보류 공지** | 개발 리드 | 팀 공지 | 44px 관련 커밋 0건 확인 | 없음 |
| I-2 | **요금 숫자 확대 overflow 수정** | 프론트엔드 | 코드 변경 + 테스트 | ko/en × 160/195/213/260px에서 `scrollWidth-clientWidth ≤ 1`, `pricing-promotion-reflow.spec.ts` 전 조합 green | 없음 |
| I-3 | **`nightly-visual-regression.yml`을 `main`에 반영** | DevOps | PR | GitHub 활성 워크플로 목록에 등장 + 1회 수동 실행 green | 없음 |
| I-4 | **red gate merge 경위 확인 및 branch protection 점검** | DevOps | 설정 스크린샷 | `fast-gate` required 확인, 우회 경로 차단 | 없음 |

### 출시 판단 전

| # | 작업 | 담당 | 산출물 | 완료 조건 | 선행 조건 |
|---|---|---|---|---|---|
| B-1 | **로그인 pill 재배치** | 프론트엔드 | 코드 + 회귀 테스트 | 320/360/390 × ko/en × consent 3상태에서 CTA 교차 0px², 격자 hit-test 탈취 0점 | I-2 |
| B-2 | **SSR 루트 `lang` 수정** | 프론트엔드 | 코드 | 첫 응답부터 `/ko`·`/auth/signin?lang=ko`가 `<html lang="ko">`. `typography.md` `:lang()` 계약 부합 | 없음 |
| B-3 | **golden 63장 pinned browser 1회 green** | QA | CI run 링크 | `nightly-visual-regression` 또는 `e2e.yml`에서 63장 pass | I-3 |
| B-4 | **확대 축 재검증 (125/150/200%)** | QA | 측정표 | 필수 4화면 × ko/en × light/dark × 3 zoom, overflow 0 | I-2 |
| B-5 | **다크 테마 실렌더 캡처** | QA | 스크린샷 세트 | 필수 화면 dark 실렌더 확보 | 없음 |
| B-6 | **실기기 키보드 1회 확인** (환영 화면 composer) | 제품 담당 | 확인 기록 | iOS Safari·Android Chrome에서 입력창·전송 도달 가능 | 없음 |

### 출시 후 후속 가능

| # | 작업 | 담당 | 완료 조건 |
|---|---|---|---|
| A-1 | 태블릿 768–1024 빈 대화 탭 바 노출 | 프론트엔드 | 3개 모델 인지·도달 가능 |
| A-2 | Google 로고 로컬 asset 전환 | 프론트엔드 | 외부 호스트 차단 상태에서도 정상 렌더 |
| A-3 | sheet 제목 `break-keep` | 프론트엔드 | 160px에서 어절 단위 줄바꿈 |
| A-4 | 320px sheet 첫 화면 후보 2개 확보 | 디자인 | 안내 문구 1줄 축약 |
| A-5 | `develop` push 시 전체 chromium 회귀 실행 검토 | DevOps | golden 회귀가 스테이징 도달 전 검출 |

---

## 10. 외부 업체에 보낼 보완 요청

> 아래를 그대로 전달할 수 있습니다.

### ☐ 요청 1 — UI-P1-01 재측정 (최우선)

- **대상 finding**: UI-P1-01
- **필요한 원본 증거**: 측정 시 사용한 브라우저 컨텍스트 설정 전문 — 특히 `hasTouch` / `isMobile` / device emulation 여부, 그리고 측정 시점의 `matchMedia('(any-pointer: coarse)').matches` 값
- **재현 조건**: `https://staging.tomverse.app/chat`, 320×568, ko, light, **터치 디바이스 에뮬레이션 활성** (Playwright `devices['iPhone 13']` 또는 DevTools Device Toolbar의 mobile 모드)
- **합격 기준**: `(any-pointer: coarse)`가 `true`인 상태에서 전송·크레딧·완료·뒤로의 bounding box를 재측정하여 제출. 44 이상이면 UI-P1-01을 **PASS로 정정**하고, 이에 의존한 §11 점수(컴포넌트 일관성, 접근성)와 §14 결론을 재작성

### ☐ 요청 2 — 125/150/200% 확대 재검증

- **대상**: UI-P2-01, UI-P2-04, 접근성 reflow, §6 전체
- **필요한 증거**: 4개 필수 화면 × ko/en × light/dark × 3 zoom의 `documentElement.scrollWidth - clientWidth` 측정표와 스크린샷
- **재현 조건**: 인앱 브라우저 확대가 CSS에 반영되지 않으므로 **layout viewport 직접 축소** 방식 사용 (320@200% → viewport width 160, mobile emulation 없이). 저장소 `tests/e2e/pricing-promotion-reflow.spec.ts:146-152`가 동일 기법을 사용합니다
- **합격 기준**: 모든 조합 overflow ≤ 1px. **요금 페이지가 이 기준을 위반한다는 사실을 확인·보고할 것** (본 평가 실측: ko 160px에서 128px, 260px에서 28px)

### ☐ 요청 3 — UI-P1-02 측정 조건 명시

- **대상**: UI-P1-02, UI-REG-P1-02
- **필요한 증거**: 교차 측정 시점의 `localStorage['tomverse_analytics_consent_v1']` 값, 페이지 스크롤 위치, 그리고 교차 영역에 대한 **`elementFromPoint()` 격자 hit-test 결과**
- **재현 조건**: `/auth/signin?lang=ko` 및 `?lang=en`, 320×568 **및 390×844**, consent `unset`/`accepted`/`declined` 3상태
- **합격 기준**: 겹침이 발생하는 정확한 조건 범위 확정. 본 평가는 `unset`에서 pill 부재, `accepted`/`declined`에서 Microsoft 버튼과 1142.5px² 교차·탭 탈취 9%(ko)/22%(en), 390px 겹침 0을 관측했습니다. Google 628.4px² 수치의 재현 조건 제시 요망

### ☐ 요청 4 — 1280px 단일 패널 주장 근거

- **대상**: §6 viewport 표
- **필요한 증거**: 1280×720 측정 시점의 `window.innerWidth` 실측값과 sidebar 접힘 상태, 모델 패널 스크린샷
- **합격 기준**: 본 평가는 sidebar `auto`/`collapsed`/`expanded` 3상태 모두에서 3열(각 280px)을 관측했습니다. 재현되지 않으면 해당 행 및 §11 "PC Shell — 1280 breakpoint 확인 필요" 삭제

### ☐ 요청 5 — `@ui-risk` 실패 spec 특정

- **대상**: UI-REG-P1-01
- **필요한 증거**: run `30355658889` job `90263135387` step 12의 artifact `pr-fast-gate-playwright-*`
- **참고**: 본 평가에서 로컬 재현으로 이미 특정했습니다 — **`tests/e2e/pricing-promotion-reflow.spec.ts:152` "pricing reflows without overflow at 320 @200% (en)"**, desktop-chromium·mobile-chromium 2개 project 동시 실패, 74 passed / 2 failed
- **합격 기준**: artifact 대조로 일치 확인. 불일치 시 추가 실패 spec 보고

### ☐ 요청 6 — 다크 테마 실렌더 및 골든 전수 검사

- **대상**: UI-P1-03, §2 theme 축
- **필요한 증거**: 필수 화면의 dark **실렌더** 스크린샷(골든 대체 불가), 골든 63장 중 미검사 55장의 검사 결과
- **합격 기준**: 원 명령 §2 "필수 테마: 라이트, 다크" 충족

### ☐ 요청 7 — 증거 원본 일괄 제출

- **대상**: 전체
- **필요한 증거**: 캡처 6장(`chat-guest-ko-320x568.jpg` 등) 원본 + 이미지별 메타데이터(viewport / locale / theme / zoom / SHA / 캡처 시각 / finding ID)
- **합격 기준**: 원 명령 §8 증거 요건 충족, 제3자 교차 검증 가능

### ☐ 요청 8 — `NOT VERIFIED` 연좌 적용 재판정

- **대상**: contrast, 키보드, safe area, 11px floor
- **근거**: `@ui-risk` 실패는 요금 reflow **1건**이며 위 항목들과 무관합니다. 본 평가 로컬 실행 결과 `ui-state-contrast.spec.ts` light·dark **각 5종 전부 통과**
- **합격 기준**: 항목별 개별 판정으로 교체

---

## 11. 의사결정 게이트

| Gate | 통과 조건 | 필요한 증거 | 책임 주체 | 미통과 시 조치 |
|---|---|---|---|---|
| **G0 — 잘못된 작업 차단** | UI-P1-01 기반 44px 수정 커밋 0건 | 팀 공지 + `git log` 확인 | 개발 리드 | 해당 커밋 revert |
| **G1 — 신규 P1 해소** | 요금 확대 overflow 수정, `pricing-promotion-reflow.spec.ts` 전 조합 green | CI run 링크 + 스테이징 재실측표 | 프론트엔드 | 출시 보류 |
| **G2 — 필수 게이트 복구** | PR Fast Gate 전체 green, branch protection 확인 | run 링크 + 설정 캡처 | DevOps | 출시 보류 |
| **G3 — 회귀 감지망 복구** | nightly workflow 등록 + golden 63장 1회 green | 활성 워크플로 목록 + run 링크 | DevOps | 출시 보류 (감지망 없이 출시 불가) |
| **G4 — P1 조건 위반 해소** | 로그인 pill 겹침 0px², hit-test 탈취 0점 (320/360/390 × ko/en × consent 3상태) | 측정표 + 스크린샷 | 프론트엔드 | 출시 보류 |
| **G5 — 검증 공백 해소** | 125/150/200% × ko/en × light/dark 전 조합 overflow ≤1px, 다크 실렌더 확보 | 측정표 + 스크린샷 세트 | QA (또는 외부 업체 보완) | 조건부 출시 검토 |
| **G6 — 접근성 잔여** | SSR `<html lang>` 정정, 실기기 키보드 1회 확인 | curl 응답 + 실기기 기록 | 프론트엔드 / 제품 담당 | 후속 항목으로 이관 가능 |
| **G7 — 외부 보고서 신뢰 회복** | 요청 1·2·3 회신 수령 및 정정본 접수 | 정정 보고서 | 외부 업체 | 향후 감사 계약 재검토 |

**G0–G4는 출시 차단 게이트입니다. G5는 조건부, G6–G7은 병행 가능합니다.**

---

## 12. 최종 자문

### 외부 업체 결과를 어느 범위까지 믿고 사용할 수 있는가

**프로세스·CI·구조 분석은 신뢰하고 그대로 사용하십시오.** nightly workflow 미등록 발견, red gate merge 적발, fixture가 실제 제품 컴포넌트를 쓰는지 점검, SSR `lang` 지적, 배포 SHA 정합성 통제 — 이 다섯은 정확하고 가치가 높으며, 그중 둘은 본 평가에서 확정 근거까지 확보했습니다.

**픽셀·치수 측정 결과는 신뢰하지 마십시오.** 환경 설정 오류로 실기기 조건이 재현되지 않았고, 그 오류가 최우선 finding(UI-P1-01)과 UI-P2-03 사유, 그리고 §11 점수 2개 항목을 오염시켰습니다. 1280px 관측치도 재현되지 않습니다.

**보고서를 작업지시서로 그대로 전달하지 마십시오.** §1의 5개 항목으로 대체하십시오.

### 현재 가장 합리적인 진행 방향

**④ 수정 우선 진행 후 재검증.** 이유는 세 가지입니다.

1. 출시를 막는 결함 4건(요금 overflow, pill 겹침, CI red, 회귀 감지망 부재)이 **이미 특정되었고 수정 범위가 명확**합니다. 추가 감사로 얻을 정보가 거의 없습니다.
2. 요금 overflow는 **본 평가에서 근본 원인까지 확정**되어 즉시 착수 가능합니다.
3. 남은 검증 공백(확대·다크)은 수정 과정에서 **G1·G5를 동시에 만족**시킬 수 있어, 별도 재감사보다 빠르고 저렴합니다.

동시에 **② 외부 업체에 증거 보완 요청**(§10)을 병행하고, **③ 확대·다크 축은 내부 표적 재검증**으로 처리하십시오. **⑥ 전체 독립 재감사는 불필요합니다** — 비용 대비 새 정보가 거의 없습니다.

### 역할별 핵심 사항

**경영진**
- 출시 결론(NOT READY)은 유지됩니다. 다만 **차단 사유는 업체 보고서와 다릅니다.**
- 차단 항목 4건은 모두 범위가 명확하며, 대규모 재설계가 아닙니다.
- 외부 업체 비용은 **프로세스·CI 분석 부분에서 값을 했습니다.** 픽셀 측정 부분은 정정본을 받아야 합니다.
- 63장 golden이 CI에서 한 번도 돌지 않았다는 사실이 **가장 구조적인 위험**입니다. 이번에 반드시 닫으십시오.

**디자인**
- 44px는 실제 터치 기기에서 이미 충족되어 있습니다. **desktop을 44px로 키우라는 요구는 거부하십시오** — 의도된 반응형 설계이고 테스트가 이를 보호합니다.
- 요금 숫자 48px(`text-5xl font-black`)의 확대 대응 정책 결정이 필요합니다.
- 로그인 화면에서 분석 설정 pill의 위치 결정이 필요합니다(고정 → 문서 흐름).

**개발**
- 착수 순서: 요금 fluid type → nightly workflow `main` 반영 → pill 재배치 → SSR `lang`.
- `docs/ui-contracts/typography.md`의 `:lang()` 계약이 SSR `lang="en"`과 충돌합니다. 이 문서는 위반을 **release blocker**로 규정하고 있습니다.
- `touch-targets.spec.ts`의 `assertBelowMinTouchTarget()`을 삭제·완화하지 마십시오.

**QA**
- 확대 검증은 **layout viewport 직접 축소** 방식으로 표준화하십시오. 브라우저 확대 UI는 헤드리스에서 신뢰할 수 없습니다.
- 터치 타깃 측정은 반드시 `hasTouch: true` + coarse pointer로 수행하십시오. 이번 사고의 직접 원인입니다.
- 다크 테마는 골든으로 대체하지 말고 실렌더를 확보하십시오.

### 독립 점수 재산정

증거가 충분하므로 재산정합니다. (업체 78 / 본 평가 82)

| 항목 | 만점 | 기준 | 업체 | **독립** | 차이 사유 |
|---|---:|---:|---:|---:|---|
| 브랜드·차별성 | 10 | 8 | 9 | **8.5** | token 검사 통과 확인, 다만 Google 로고 방식 불일치 |
| 시각적 계층 | 12 | 10 | 10 | **10** | 동일 |
| 레이아웃·화면 밀도 | 12 | 9 | 10 | **9** | 요금 확대 overflow + 태블릿 3열 붕괴 반영(업체 미발견) |
| 타이포그래피 | 8 | 6 | 7 | **7.5** | 어절 분절 0 전수 확인으로 상향, 160px sheet 제목 감점 |
| 색상·테마 | 8 | 6 | 7 | **7.5** | AA light·dark 실측 통과로 상향 |
| 컴포넌트 일관성 | 10 | 8 | 7 | **8.5** | **업체 하향 근거(hit-area token 미전파) 무효** |
| 상태·오류 디자인 | 10 | 6 | 8 | **8** | 이미지 품질 우수, CI 실행 이력 0회 반영 |
| PC Shell | 8 | 7 | 7 | **6.5** | 태블릿 빈 대화 1/3 패널 반영 |
| Mobile Shell | 12 | 7 | 8 | **9.5** | **44px는 실제 충족**으로 상향, pill 겹침·키보드 미검증 감점 |
| 접근 가능한 시각 디자인 | 10 | 6 | 5 | **7.5** | 44px 근거 무효로 상향, pill 탭 탈취·SSR lang·요금 reflow 감점 |
| **총점** | **100** | **73** | **78** | **82** | **기준 대비 +9** |

- **PC 체감: 84 / 100**
- **모바일 체감: 79 / 100**

미검증 항목(golden 픽셀 동등성, 실기기 키보드)은 만점 처리하지 않았습니다. 업체 점수와 4점 차이지만 **항목별 구성은 크게 다릅니다** — 업체는 접근성·컴포넌트를 부당하게 낮추고 레이아웃을 과대평가했습니다.

### 한 문장 최종 권고

**외부 업체의 `NOT READY` 결론은 채택하되 근거 목록은 폐기하고, 요금 페이지 확대 overflow·로그인 pill 겹침·red 상태 merge·미등록 nightly workflow 4건을 수정한 뒤 확대·다크 축만 표적 재검증하십시오 — 44px 재작업은 즉시 중단해야 합니다.**

---

## 부록 — 본 평가의 증거 재현 명령

```bash
# 배포 SHA 확인
curl -sS https://staging.tomverse.app/api/build-info

# SSR 문서 언어 (hydration 이전)
curl -sS "https://staging.tomverse.app/auth/signin?lang=ko" | grep -o '<html[^>]*>'

# @ui-risk 재현 (74 passed / 2 failed)
npx playwright test --project=desktop-chromium --project=mobile-chromium --grep=@ui-risk --workers=1

# 대비 검사만
npx playwright test --project=desktop-chromium tests/e2e/ui-state-contrast.spec.ts

# accent token 정책
npm run check:accent-tokens
```

터치 타깃 재측정 시 필수 설정:

```js
// 올바름 — 실기기 조건
browser.newContext({ viewport: {width:320,height:568}, isMobile: true, hasTouch: true })
// 잘못됨 — 업체가 사용한 조건 (fine pointer)
browser.newContext({ viewport: {width:320,height:568} })
```

**본 평가 중 실제 provider 호출·결제·데이터 변경·커밋·배포는 0건입니다.**
