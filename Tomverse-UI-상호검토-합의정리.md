# Tomverse Insight UI 상호 검토 및 합의 정리

> 조정 수행일 2026-07-28 · 조정 시점 배포 SHA `21a94db510e8a7a88541bc7bad1771f1c1772b06`
> 이 문서와 `Tomverse-UI-최종-작업-프롬프트.md` 외에 어떤 파일도 수정하지 않았습니다.

---

## 1. 최종 조정 결론

| 항목 | 값 |
|---|---|
| **합의 상태** | **핵심 합의 · 일부 후속** |
| **최종 작업 프롬프트 상태** | **실행 가능** (단, 태블릿 방향 1건은 `사용자 결정 필요`로 분리) |
| **제품 Go-Live 판정** | **NOT READY** — 양측 공통 |

### 최종 수용한 핵심 사항

1. **`UI-P1-02` 재개방(FAIL).** 동의를 허용·거부한 **이후** 나타나는 고정 `분석 설정` 버튼이 320px 로그인 화면에서 계정 선택 CTA를 실제로 침범합니다. 3개 독립 측정이 모두 겹침을 확인했습니다. **최초 재감사의 `PASS` 판정은 상태 매트릭스 설계 결함이며 철회합니다.**
2. **`UI-P2-02` 재개방(FAIL).** `app/layout.tsx:75`가 root `lang="en"`을 하드코딩합니다. 한국어 본문과 문서 언어가 첫 byte부터 불일치하며, `/auth/signin`은 subtree 보정조차 없습니다. **hydration 후 DOM만 검사한 최초 `PASS` 판정은 철회합니다.**
3. **`UI-P1-03` 하향(PARTIAL).** golden 63장이 pinned browser에서 current-green으로 실행된 증거가 없고, 유일한 전용 runner인 `nightly-visual-regression.yml`은 **GitHub에 등록조차 되어 있지 않습니다**(파일이 `develop`에만 있고 기본 branch `main`에 없음).
4. **요금 페이지 확대 overflow는 P1이며, 원인이 2개**입니다. ① `PricingPageContent.tsx:1064`의 할인가 `text-5xl` 고정(일반가 1024행은 이미 `clamp()` 적용됨) ② `p.text-xs font-bold uppercase tracking-[0.18em]` 계열 plan eyebrow — CI는 promotion 유무와 무관하게 4px 초과.
5. **`UI-P1-01`(44px)은 실기기 조건에서 충족**되며, 미달 주장은 fine-pointer 오측정입니다. 양측이 `touchTarget = isMobileShell || hasCoarsePointer` 분기를 각각 확인해 **사실상 합의**에 도달했습니다.
6. **CI 신뢰성 결함 2건 확정.** ① 필수 gate가 red인 상태로 `791fef1`이 merge됨 ② 문서 전용 PR은 build·smoke·`@ui-risk`가 전부 **skipped**인 채 필수 check가 green이 됨.

### 수용하지 않은 핵심 사항과 이유

| 미수용 항목 | 출처 | 이유 |
|---|---|---|
| **`UI-P1-01` FAIL (전송 36×36 등)** | 재감사 B | fine pointer 조건의 산출물. 수치가 `h-9`/`h-8`/`py-2` 분기와 소수점까지 일치하며, `touch-targets.spec.ts`는 desktop이 44 미만임을 **의도적으로 assert**함 |
| **`1280px에서 단일 패널`** | 재감사 B | sidebar `auto`/`collapsed`/`expanded` 3상태 × 1280·1366에서 **6/6 모두 3열** 재현. 반례 확보 |
| **`85/100` 점수** | 재감사 A | 철회된 3개 `PASS`에 의존. 수정·검증 완료 후 재산정 |
| **"요금 한 건 수정 후 Go-Live 가능"** | 재감사 A | `UI-P1-02`·`UI-P1-03`·`UI-P2-02`가 추가로 남음 |
| **`78/100` 점수** | 재감사 B | 무효한 `UI-P1-01` FAIL이 2개 항목 점수에 반영됨 |
| **contrast `NOT VERIFIED`** | 재감사 B | 무관한 spec 1건의 실패를 6개 항목에 연좌 적용. `ui-state-contrast.spec.ts` light·dark 각 5종 실행 시 전부 통과 |

### 남은 P1 / release blocker

| # | 항목 | 상태 |
|---|---|---|
| B-1 | 요금 확대 overflow (원인 2개) | **수정 필요** |
| B-2 | 로그인 post-consent 설정 pill 겹침 | **수정 필요** |
| B-3 | golden 63장 current-green 부재 + nightly workflow 미등록 | **검증체계 복구 필요** |
| B-4 | 비문서 PR에서 `@ui-risk` 실제 실행 green | **CI 증거 필요** |

### 권고 진행 순서

`B-1 · B-2` 수정 → `B-3` workflow 등록 및 전수 green → `B-4` 비문서 PR gate green → SSR lang 수정 → 표적 재검증 → 점수 재산정 → Go-Live 재심의

---

## 2. 검토 자료와 버전

| 자료 | 작성 주체 | 버전·작성일 | 문서 역할 | 참조 가능한 증거 | 누락·접근 제한 |
|---|---|---|---|---|---|
| `UI 검사.txt` | 발주자 | 25,136 bytes · 2026-07-28 21:58 AEST | **원 Review 명령서** (614행) | — | 없음 |
| `TomverseInsightUIFinalReauditko.md` | **재감사 A** (Linux 컨테이너) | 50,736 bytes · 검수 창 2026-07-28 11:45–13:20 UTC | 1차 재감사. **85/100, CONDITIONAL, P1 3건 PASS** | 표·측정치 본문 인용 | **원본 138장 screenshot, `01-sweep.json` 등 JSON/log 전부 미제출**. 경로가 `/tmp/…`로 축약되어 제3자 재현 불가 |
| `Tomverse__UI_________.md` (첨부) | **평가자 C** | 버전 표기 없음 · 조정 시점 최신 | **재감사 A에 대한 독립 평가 및 진행 방향** | live 교차 측정, SSR HTML, source 위치, CI run URL | 원본 screenshot 미첨부 |
| `TomverseInsightUIFinalReauditko.md` (직전 회차 첨부) | **재감사 B** (Windows · Codex 인앱 Chromium) | 453행 · 재감사 종료 2026-07-28 22:07:22 AEST | 별도 1차 재감사. **78/100, NOT READY** | 측정표, CI run 링크 | 캡처 6장 원본 미첨부. local HEAD `174a62bd` (17커밋 뒤짐) |
| `Tomverse-외부-UI-검토-평가-및-진행방향.md` | 조정자(본 문서와 동일 주체) | commit `e94b618` · 507행 | **재감사 B에 대한 독립 평가** | 표적 검증 10종 | — |
| `.github/audits/final-stg-reaudit-2026-07-28-independent.md` | **재감사 D** | 875행 · 검수 창 2026-07-28 11:21–12:41 UTC · branch `claude/tomverse-reaudit-final-stg-r8glem` | 또 다른 독립 재감사. **69/100, Conditional No-Go** | 저장소 내 원본 존재 | 이번 조정에서는 교차 확인 용도로만 참조 |
| `AGENTS.md`, `docs/ui-contracts/*.md` | 저장소 | 현행 | **release blocker 계약** | 원본 확인 | 없음 |

### 자료 역할에 대한 명시적 정정

원 지시문은 자료를 `외부 업체 1차 → 독립 평가 → 외부 업체 재검토 답변` 3단계로 상정했습니다. **실제 제출물은 이 구조와 다릅니다.**

- 첨부된 `Tomverse__UI_________.md`(평가자 C)가 평가 대상으로 삼은 문서는 **재감사 A**입니다. 인용된 파일명(`01-sweep.json`, `04-consent.json`, `06-zoom.json`, `/tmp/…/scratchpad/audit/shots/`), 검수 창(11:45–13:20 UTC), 점수(85/100), 절 번호(§4 L75–111, §11 L610–634)가 모두 재감사 A와 일치합니다.
- **`4. 외부 업체의 재검토 답변·반론·수용 의견`에 해당하는 문서는 이번에 첨부되지 않았습니다.** 추정으로 채우지 않았습니다. 따라서 아래 원장에서 재감사 A 측이 평가자 C의 지적을 **명시적으로 수용했다는 기록은 존재하지 않으며**, 해당 항목은 `상호 명시 합의`가 아니라 **`증거상 수용`**으로 판정했습니다.
- 별개의 재감사 B·D가 존재하므로, 이 조정은 **2자 왕복이 아니라 4개 감사 산출물의 교차 조정**입니다.

### 기준선 및 배포 SHA 정합성

| 시점 | local | origin/develop | staging |
|---|---|---|---|
| 재감사 A·B·D 수행 시 | `791fef1` | `791fef1` | `791fef1` |
| **조정 시점(현재)** | `e94b618`(작업 branch) | **`21a94db`** | **`21a94db`** |

`791fef1 → 21a94db` 차이는 `.github/audits/final-stg-reaudit-2026-07-28-independent.md` **1개 파일 추가(875행)뿐**이며 **제품 UI 코드는 완전히 동일**합니다(`git diff --stat` 확인). 따라서 세 재감사의 UI 관찰은 현재 배포에도 그대로 유효합니다.

재감사 A의 작업 branch는 `develop`이 아닌 `claude/tomverse-insight-ui-reaudit-kqrw4n`이었습니다. tree는 동일했으나 원 명령 §1-1의 문자적 조건에는 부합하지 않습니다 — **실질 영향 없음, 절차 기록으로만 남깁니다.**

### 이번 조정에서 직접 확인한 것

`app/layout.tsx:75` root lang · `PricingPageContent.tsx:1024/1064` 가격 class · PR run `30360601168` step-level skip · GitHub 활성 workflow 목록 · `main`/`develop` workflow 파일 대조 · 현재 3자 SHA와 diff 범위

### 확인하지 않은 것

원본 138장 재생성 · pinned browser(build 1234) 픽셀 동등성 · 실기기 iOS/Android · 실제 provider 호출

---

## 3. 쟁점별 상호 검토 원장

> 판정 범례 — `상호 명시 합의` / `증거상 수용` / `부분 합의` / `미합의` / `증거 부족` / `오해 해소` / `범위 외`

| ID·쟁점 | 원 기준 | 재감사 A | 재감사 B | 평가자 C | 조정자 확인 증거 | 최종 판정 | 최종 반영 |
|---|---|---|---|---|---|---|---|
| **UI-P1-01** 44px | §3 완료조건 7개 | PASS (17종 44+, 5점 hit-test) | **FAIL** (전송 36² 등) | 조건부 수용 (touch 분기 인정) | fine pointer에서 B 수치 **소수점 일치**, touch에서 전량 44. `ModelCatalogue.tsx:127` · `ModelPickerPanel.tsx:174` · `touch-targets.spec.ts` `assertBelowMinTouchTarget()` | **증거상 수용 → PASS(조건부)** | 수정 없이 재검증. 대화 후 조작 geometry 보완 |
| **UI-P1-02** 동의 notice | §3 "닫거나 선택한 뒤"포함 | PASS (44조합 교차 0) | **FAIL** (Google 628.4 / MS 171.4px²) | **반박** (동일 수치 재현) | 조정자 실측: consent `unset`→pill 부재, `accepted`/`declined`→pill `fixed` 69.6×44, MS 교차 1142.5px², **탭 탈취 ko 9% / en 22%**, 390px 겹침 0 | **증거상 수용 → FAIL** | **반드시 수정** |
| **UI-P1-03** 상태 렌더 | §3 완료조건 10개 | PASS | PARTIAL | **반박 → PARTIAL** | nightly workflow **미등록 확정**(main 부재), 외부 실행 52 fail, pinned green 없음 | **상호 명시 합의 → PARTIAL** | **검증체계 복구 + 전수 green** |
| **UI-P2-01** ko 줄바꿈 | §3 완료조건 6개 | PASS (Range 측정) | PARTIAL (확대 미검증) | **수용** | 재감사 A의 Range 측정법이 저장소 `korean-typography.spec.ts`와 동일 | **증거상 수용 → PASS** | 수정 없이 재검증 |
| **UI-P2-02** 로그인 언어 | §3 "hydration 전후" | PASS | PARTIAL (SSR lang 지적) | **반박** | `app/layout.tsx:75` `lang="en"` 하드코딩 확인. `/auth/signin?lang=ko`의 SSR HTML에 `lang="ko"` **0회** | **상호 명시 합의 → FAIL** | **반드시 수정** |
| **UI-P2-03** Bottom Sheet | §3 완료조건 9개 | PASS | PARTIAL (완료 32px) | 조건부 수용 | 단계화는 3자 모두 개선 인정. **32px 근거는 UI-P1-01과 동일 오측정으로 무효** | **부분 합의 → PARTIAL** | 재검증 + 실기기 keyboard |
| **UI-P2-04** 보조 text | §3 완료조건 7개 | PARTIAL | PARTIAL | 수용 | 11px 미만 **0건**(6화면×4 zoom). pricing zoom 실패로 PARTIAL 유지 | **상호 명시 합의 → PARTIAL** | pricing 수정 후 재측정 |
| **UI-P3-01** 브랜드 | §3 완료조건 7개 | PASS | **PASS** | 수용 | `check:accent-tokens` 통과(guarded 10파일·10역할) | **상호 명시 합의 → PASS** | 수정 없음 |
| **REG** 요금 확대 overflow | §3 UI-P2-04 / §6 | **P1 신규 발견** | 미발견 | 조건부 수용(존재 O, exact px 조건부) | **원인 2개 확정**: `PricingPageContent.tsx:1064` 할인가 `text-5xl`(1024행 일반가는 clamp 적용됨) + `p.text-xs font-bold uppercase` eyebrow. CI: promotion 4px / baseline 4px 동시 초과 | **증거상 수용 → P1** | **반드시 수정** |
| **REG** 태블릿 단일 패널 | §6 태블릿 | **P2 신규 발견** | "overflow 0"으로 통과 처리 | 수용 | `DesktopChatShell.tsx:383` `!isConversationEmpty && useTabsLayout` → 빈 대화에서 탭 바 미렌더. 768/834/1024에서 패널 폭 `[N,0,0]` | **증거상 수용 → P2** | **사용자 결정 필요** |
| **REG** composer 키보드 | §6 virtual keyboard | P2 (실기기 NOT VERIFIED 명시) | NOT VERIFIED | 조건부 수용 | `MobileChatShell.tsx:479` `h-[100dvh] overflow-hidden`, 환영 화면 scroller 0개. 시뮬레이션에서 전송 버튼 66.5px 이탈 | **추가 검증 후 결정** | 실기기 1회 확인 |
| **REG** nightly workflow 미등록 | §9 CI 확인 | 미발견(“문서화된 트레이드오프”로 서술) | **발견** | 수용 | 활성 9개 중 부재. **원인: 파일이 `develop`에만 있고 `main`에 없어 schedule 미등록** | **상호 명시 합의 → 검증 위험 P1** | **반드시 수정** |
| **REG** red gate merge | §9 CI 확인 | **발견**(P1) | 발견 | 수용 | run `30355658889` step 12 failure + 필수 aggregator failure | **상호 명시 합의** | 프로세스 조치 |
| **REG** docs-only skip green | §9 CI 확인 | 미발견 | 미발견 | **발견** | run `30360601168`: build·smoke·`@ui-risk` **전부 skipped**, 필수 check는 success | **증거상 수용 → 프로세스 결함** | gate 조건 명시 |
| **REG** Google 아이콘 외부 참조 | §10 신규 탐색 | **P3 발견** | 미발견 | 수용 | `SignInPageContent.tsx:268` `authjs.dev` 직접 참조 | **상호 명시 합의 → P3** | 출시 후 후속 |
| **REG** 160px sheet 제목 분절 | §10 신규 탐색 | **P3 발견** | 미발견 | 수용 | 스크린샷 | **증거상 수용 → P3** | 출시 후 후속 |
| **REG** textarea focus ring | §7 visible focus | P3(정보성) | PARTIAL | 수용 | caret이 focus 표시 역할 — WCAG 2.4.7 허용 | **증거상 수용 → P3** | 출시 후 후속 |
| **1280px 3열** | §6 | 3열(382×3) | **단일 패널** | 미판정 | sidebar 3상태 × 1280·1366 = **6/6 3열** | **미합의 → 반증으로 종결** | 수용하지 않음 |
| **contrast AA** | §7 | PASS(합성 픽셀 5종) | **NOT VERIFIED** | 조건부 | `ui-state-contrast.spec.ts` light·dark 각 5종 **전부 통과** | **증거상 수용 → PASS(조건부)** | pinned 재확인 |
| **점수** | §11 | 85/100 | 78/100 | 재산정 거부 | 양측 모두 무효 근거 포함 | **미합의 → 재산정 보류** | 수정·검증 후 산정 |
| **Go-Live** | §12 | CONDITIONAL | **NOT READY** | NOT READY | P1 3건 잔존 | **상호 명시 합의 → NOT READY** | gate 통과 후 재심의 |
| **원본 증거 미제출** | §8 증거 요건 | — | — | **지적** | `/tmp/…` 축약 경로, hash·manifest 없음 | **증거상 수용** | artifact 패키지화 |

---

## 4. 최종 수용 사항

### 4-1. `UI-P1-02` 재개방 — 로그인 post-consent 설정 pill 겹침

- **받아들인 주장**: 재감사 B·평가자 C의 "고정 설정 버튼이 계정 CTA를 침범한다"
- **받아들이지 않은 반대 의견**: 재감사 A의 `PASS`. 사유 — consent가 `unset`인 상태만 검사해 원 명령 §3의 "**notice를 닫거나 선택한 뒤**" 조건을 누락한 **상태 매트릭스 설계 결함**
- **가장 강한 증거**: 조정자 격자 hit-test — Microsoft 버튼 표본 45점 중 ko 4점(9%) / en 6점(22%)이 pill에 탈취됨. 단순 시각 가림이 아니라 **실제 탭 탈취**
- **남은 위험**: 측정 x좌표가 227.44(스크롤바 노출 환경) vs 242.4(모바일 에뮬레이션)로 갈림 → 정확한 교차 면적은 환경 의존
- **최종 작업 반영**: 반드시 수정 + persisted-consent 회귀 test 추가

### 4-2. `UI-P2-02` 재개방 — SSR root 문서 언어

- **받아들인 주장**: 재감사 B·평가자 C의 SSR `<html lang="en">` 지적
- **받아들이지 않은 반대 의견**: 재감사 A의 `PASS`. 사유 — hydration **이후** `document.documentElement.lang`만 읽어 서버 응답을 검사하지 않음
- **가장 강한 증거**: `app/layout.tsx:75`의 `lang="en"` 하드코딩 + `/auth/signin?lang=ko` SSR HTML에 `lang="ko"` 0회
- **범위 확대**: signin뿐 아니라 `/ko`·`/chat` 등 **전 route**. `/ko`는 `[locale]/page.tsx:80`의 `<div lang>` wrapper로 subtree만 부분 보정
- **계약 충돌**: `docs/ui-contracts/typography.md`는 "Locale families are selected by `:lang()` over the whole subtree, **never by per-glyph fallback**"를 요구하며 위반을 **release blocker**로 규정
- **남은 위험**: root layout에서 locale을 얻으려면 서버 측 locale 결정 경로가 필요 — 구현 난이도 중간

### 4-3. `UI-P1-03` 하향 — 상태 golden의 current-green 부재

- **받아들인 주장**: 재감사 B의 "nightly workflow 미등록", 평가자 C의 "pinned green 없음"
- **가장 강한 증거**: GitHub 활성 workflow 9개 중 `Nightly Visual Regression` 부재. 원인은 파일이 `develop`에만 존재하고 기본 branch `main`에 없어 schedule 이벤트가 등록되지 않음. `e2e.yml`도 `push: main` 전용
- **귀결**: **63장 golden과 전체 chromium 회귀는 이번 UI 작업에 대해 CI에서 0회 실행**
- **남은 위험**: golden 이미지 자체의 디자인 품질은 3자 모두 양호 판정 — 문제는 **회귀 감지망 부재**

### 4-4. 요금 확대 overflow — 원인 2개 확정

| # | 위치 | 조건 | 증거 |
|---|---|---|---|
| A | `PricingPageContent.tsx:1064` `<span className="text-5xl font-black">{salePrice}</span>` | promotion 활성(스테이징 현재) | 실측 ko 128px / en 66px 초과. 1024행 일반가는 이미 `text-[clamp(1.5rem,10vw,2.25rem)]` |
| B | `p.text-xs font-bold uppercase tracking-[0.18em]` 계열 plan eyebrow | promotion 유무 무관 | CI: `promotion=4px baseline=4px`, offender `p.text-xs.font-bold.uppercase` right=164 @vw160 |

- **받아들인 주장**: 재감사 A의 결함 발견 + 평가자 C의 근본 원인 특정(할인가만 fluid 미적용)
- **조정자 기여**: 두 원인이 **서로 다른 요소**임을 확정. A만 고치면 CI는 여전히 red
- **남은 위험**: exact px는 billing locale·promotion 상태에 의존 → locale matrix 필요

### 4-5. `UI-P1-01` 종결(조건부 PASS)

- **받아들인 주장**: 재감사 A의 touch 조건 측정
- **받아들이지 않은 반대 의견**: 재감사 B의 `FAIL`. 사유 — `hasTouch:false`에서만 재현되는 수치이며, 이는 **의도된 반응형 설계**
- **가장 강한 증거**: 조정자가 두 조건을 나란히 측정 — fine에서 전송 36×36 / 크레딧 44.5×36 / 완료 71.5×32 / 모델선택 110.8×40 / 뒤로 36×36 (재감사 B와 소수점 일치), touch에서 전량 44. `touchTarget = isMobileShell || hasCoarsePointer`가 `h-11`↔`h-9`/`h-8`/`py-2`로 분기
- **조건**: 대화 진행 후에만 나타나는 조작(AI Review, retry, stop, mobile model-tab remove)의 원본 geometry가 미제출 → 재검증에 포함
- **경고**: **이 finding을 근거로 desktop을 44px로 확대하면 `touch-targets.spec.ts`의 `assertBelowMinTouchTarget()`이 깨집니다.**

### 4-6. CI 신뢰성 결함 2건

- **red gate merge**: run `30355658889` — step 12 `Run high-risk UI regression checks` failure, 필수 aggregator `Enforce upstream job results` failure. 그럼에도 해당 branch가 `791fef1`로 merge됨
- **docs-only skip green**: run `30360601168` — `Determine whether this PR touches anything but documentation`가 code=false로 판정하여 build·smoke·`@ui-risk`가 **전부 skipped**, 필수 check는 success. **문서 PR의 green을 제품 검증 통과로 해석하면 안 됩니다.**

---

## 5. 조건부 수용 사항

| 항목 | 수용 범위 | 조건 | 미충족 시 |
|---|---|---|---|
| `UI-P1-01` PASS | 헤더·composer·sheet·카탈로그 17종 | 대화 후 조작 4종의 실제 fixture rect + 5점 hit-test 제출 | PARTIAL로 재하향 |
| `UI-P2-03` 정보 단계화 | 390×844 첫 화면 완료 조건 | 실기기 또는 동등 fixture의 keyboard·safe area 증거 | PARTIAL 유지 |
| contrast AA | `ui-state-contrast` light·dark 각 5종 | pinned browser에서 재실행 green | NOT VERIFIED로 환원 |
| 요금 overflow exact px | 결함 존재는 무조건 수용 | billing locale(ko-KR/en-US/en-AU/en-GB) 구분 재현 | 수치만 조건부, 수정은 그대로 진행 |
| composer 키보드 | 시뮬레이션 재현은 확정 | 실기기 iOS Safari · Android Chrome 1회 | 잔여 위험으로 명시 유지 |

---

## 6. 수용하지 않은 사항

| 항목 | 주장 주체 | 미수용 사유 | 결정적 반례 |
|---|---|---|---|
| `UI-P1-01` FAIL | 재감사 B | 측정 환경 오류 | fine/coarse 대조 측정 |
| `1280px 단일 패널` | 재감사 B | 재현 불가 | sidebar 3상태 × 2폭 = 6/6 3열 |
| contrast·keyboard·11px `NOT VERIFIED` | 재감사 B | 무관 spec 1건 실패의 연좌 적용 | `ui-state-contrast` 전 항목 통과 |
| `85/100` | 재감사 A | 철회된 3개 PASS에 의존 | §4-1·4-2·4-3 |
| "요금 한 건 수정 후 Go-Live" | 재감사 A | P1 3건 추가 잔존 | §1 남은 blocker |
| `78/100` | 재감사 B | 무효 근거가 2개 항목 점수에 반영 | §4-5 |
| nightly가 매일 실행 중이라는 해석 | 재감사 A(암묵) | workflow 미등록 | 활성 목록 부재 |

**점수는 어느 쪽도 채택하지 않고 재산정을 보류합니다.** 원 명령 §11의 "미검증 상태는 만점으로 계산하지 마세요"에 따라, `UI-P1-02`·`UI-P1-03`·`UI-P2-02`가 미해결인 현 시점의 숫자는 의사결정 가치가 없습니다.

---

## 7. 추가 검증 또는 사용자 결정 필요 사항

| # | 항목 | 유형 | 필요한 것 | 차단 여부 |
|---|---|---|---|---|
| D-1 | **태블릿 768–1024px 빈 대화 구조** | **사용자 결정 필요** | ① 빈 대화에서도 탭 바 노출 ② 빈 상태에서 패널 영역 숨김 ③ 현 상태 명시적 risk accept — 셋 중 택일 | 최종 작업을 **차단하지 않음** (분리 항목) |
| D-2 | composer 가상 키보드 | 추가 검증 | 실기기 iOS Safari · Android Chrome 각 1회 | 조건부 |
| D-3 | 대화 후 조작 44px geometry | 추가 검증 | fixture rect + hit-test | 조건부 |
| D-4 | golden 픽셀 동등성 | 추가 검증 | pinned Chromium(build 1234) 전수 green | **차단** |
| D-5 | 원본 증거 패키지 | 추가 검증 | screenshot·JSON·log + SHA-256 manifest | 차단 아님(추적성) |

---

## 8. 최종 작업 범위

### 8-1. 반드시 수정

| 우선순위 | 작업 | 대상 | 완료 조건 | 필수 검증 | 보호할 장점 | 의존성 |
|---|---|---|---|---|---|---|
| **P1-a** | 요금 확대 overflow 해소 (원인 A·B 모두) | `components/marketing/PricingPageContent.tsx` (1064행 할인가, `text-xs uppercase tracking-[0.18em]` eyebrow 계열) | ko/en × layout viewport 160·195·213·260px에서 `scrollWidth - clientWidth ≤ 1`. promotion 활성·비활성 양쪽 | `tests/e2e/pricing-promotion-reflow.spec.ts` 전 조합 green | 요금 계층·가격 강조·promotion 인지성 | 없음 |
| **P1-b** | 로그인 post-consent 설정 pill 재배치 | `components/analytics/AnalyticsProvider.tsx` 고정 pill 분기 | 320·360·390 × ko/en × consent `unset`·`accepted`·`declined`에서 계정 CTA·약관·링크와 교차 **0px²**, 격자 hit-test 탈취 **0점**, pill 자체 ≥44×44 유지 | 신규 persisted-consent E2E + 기존 `analytics-consent*.spec.ts` | 동의 재설정 경로 접근성, opt-out 유지 | 없음 |
| **P1-c** | `nightly-visual-regression.yml`을 기본 branch에 반영 | `.github/workflows/` | GitHub 활성 workflow 목록에 등장 + 수동 1회 실행 | 63장 전수 green, `retries=0`, snapshot 갱신 없음 | golden 무단 갱신 금지 정책 | 없음 |
| **P1-d** | 비문서 PR에서 `@ui-risk` 실제 실행 green | CI 운영 | step-level에서 `Run high-risk UI regression checks`가 **skipped가 아닌 success** | run URL 제출 | 문서 PR 고속 경로 유지 | P1-a·P1-b |
| **P2-a** | SSR root 문서 언어 정정 | `app/layout.tsx:74-78` 및 서버 locale 결정 경로 | `/ko`, `/auth/signin?lang=ko`의 **첫 HTTP 응답**부터 `<html lang="ko">`, en도 동일. hydration 전후 불일치 0 | SSR HTML 검사 test + `tests/e2e/font-system.spec.ts` 유지 | `typography.md`의 `:lang()` 계약 | 없음 |

### 8-2. 수정 없이 재검증

| 우선순위 | 작업 | 대상 | 완료 조건 | 필수 검증 |
|---|---|---|---|---|
| V-1 | `UI-P1-01` 대화 후 조작 geometry | AI Review · retry · stop · mobile model-tab remove | 320·390 touch 조건에서 ≥44×44, 5점 hit-test 자기 명중, 인접 오명중 0 | `tests/e2e/touch-targets.spec.ts` + 상태 fixture |
| V-2 | `UI-P2-01` 한국어 display heading | 랜딩 H1 · 모바일 환영 문구 | 어절 분절 0, 320px H1 ≤4줄, 환영 ≤2줄 | `tests/e2e/korean-typography.spec.ts` |
| V-3 | `UI-P2-04` 보조 text floor | 모델 선택기·요금·Sidebar·패널 헤더·AI Review | 11px 미만 0건, 100/125/150/200%에서 겹침·잘림·overflow 0 | `ui-state-contrast.spec.ts` sub-11px 검사 |
| V-4 | contrast AA | 오류·복구·상태 표면 light·dark | 합성 픽셀 기준 AA 통과 | `tests/e2e/ui-state-contrast.spec.ts` |
| V-5 | `UI-P3-01` accent 역할 | guarded 파일 | `npm run check:accent-tokens` 통과 | 동일 |
| V-6 | `UI-P2-03` 390 정보 단계화 | 모델 Bottom Sheet | 검색·선택요약·후보 ≥2·필터 접힘·`필터 N` 표시·완료 접근 | `model-picker-responsive.spec.ts` |
| V-7 | PC 3열 구조 | 1280·1366·1440·1920 | 3열 균등 폭·높이, 모델별 독립 composer, 공통 composer 유지 | `model-comparison-layout.spec.ts`, `comparison-action-rail.spec.ts` |

### 8-3. 출시 후 후속 가능

| 작업 | 대상 | 완료 조건 |
|---|---|---|
| Google provider 아이콘 로컬화 | `SignInPageContent.tsx:268` | 외부 호스트 차단 상태에서도 Microsoft와 동일 품질 렌더 |
| 160 CSS px sheet 제목 어절 분절 | 모델 sheet heading | `break-keep` 적용, 어절 단위 줄바꿈 |
| composer `focus-within` 시각 강조 | `ChatInput.tsx` | 키보드 focus 시 composer 카드 경계 강조 |
| 320px sheet 첫 화면 후보 2개 확보 | 모델 sheet 안내 문구 | 안내 1줄 축약 후 후보 2개 완전 노출 |
| badge·카탈로그 밀도 정성 개선 | 모델 카탈로그 | 디자인 승인 |

### 8-4. 수행하지 않음

| 항목 | 사유 |
|---|---|
| desktop 조작을 44×44로 확대 | `UI-P1-01` FAIL 주장이 무효. 실행 시 `assertBelowMinTouchTarget()` 파손 |
| `touch-targets.spec.ts`의 desktop assertion 완화·삭제 | 위 결정을 보호하는 회귀 방지선 |
| 1280px breakpoint 변경 | 단일 패널 주장 재현 불가 |
| 점수 재산정 | 수정·검증 완료 전에는 의사결정 가치 없음 |
| 전체 독립 재감사 재실행 | 결함이 이미 특정됨. 비용 대비 신규 정보 없음 |
| 무관한 리팩터링 | 범위 밖 |

---

## 9. 범위에서 제외한 사항

- **재감사 D(`final-stg-reaudit-2026-07-28-independent.md`, 69/100)의 운영 경로 blocker(FINAL-F002, provider 도달 0회)** — 기능·상용 경로 검증 영역이며 이번 UI 조정의 범위가 아닙니다. 별도 트랙으로 유지하십시오.
- **Turnstile 자동화 차단 이슈** — 보안 설계상 의도된 동작. UI 결함 아님.
- **실제 provider 호출·결제·장시간 streaming** — 원 명령의 안정성 지침에 따라 금지.
- **`develop` push 시 전체 chromium 회귀 실행 여부** — CI 정책 결정 사항으로, P1-c 완료 후 별도 검토.

---

## 10. 위험 및 의사결정 게이트

| Gate | 통과 조건 | 필요한 증거 | 미통과 시 조치 |
|---|---|---|---|
| **G1** 요금 reflow | ko/en × 160·195·213·260px에서 overflow ≤1px, promotion 활성·비활성 양쪽 | 측정 JSON + 스테이징 재실측 + `pricing-promotion-reflow.spec.ts` green | 출시 보류 |
| **G2** 로그인 겹침 | 3 consent 상태 × 3폭 × 2 locale에서 교차 0px², hit-test 탈취 0 | rect/intersection JSON + before/after 스크린샷 | 출시 보류 |
| **G3** 필수 CI 실행 | 비문서 PR에서 `@ui-risk`가 **skipped가 아닌 success** | run URL의 **step-level** 결과 | merge 금지 |
| **G4** 상태 golden | 63장 전수 green, `retries=0`, snapshot 갱신 0 | Playwright report + actual/diff artifact | `UI-P1-03` PARTIAL 유지 |
| **G5** SSR locale | 첫 HTTP 응답부터 root `lang`과 본문 locale 일치 | raw HTML + 회귀 test | `UI-P2-02` 미해결 |
| **G6** 키보드·safe area | 키보드 노출 시 textarea·전송·sheet 완료가 visual viewport 안, hit-test 자기 명중 | 실기기 기록 또는 동등 fixture | 조건부 상태 유지 |
| **G7** 태블릿 결정 | 3모델이 인지·도달 가능하거나 명시적 risk accept | 디자인 승인안 + test | P2 release exception 필요 |
| **G8** 증거 추적성 | 보고서 수치와 원본 artifact가 연결됨 | manifest + SHA-256 | 해당 PASS 단독 채택 불가 |

**G1–G5는 Go-Live 전 필수입니다.** G6·G7은 결과가 정상이거나 Product/Accessibility가 위험을 명시적으로 수용해야 합니다.

---

## 11. 한 문장 최종 합의

**`UI-P1-01`(44px)과 `UI-P2-01`·`UI-P3-01`은 종결하되, 로그인 post-consent 겹침·요금 확대 overflow(원인 2개)·SSR 문서 언어·상태 golden 검증체계 4건을 수정·복구하고 비문서 PR에서 `@ui-risk`가 실제로 실행되어 green이 될 때까지 Go-Live는 보류하며, 점수 재산정은 그 이후에 수행합니다.**
