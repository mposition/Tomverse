# Nightly Visual Regression #4 실패 분석 (2026-08-04)

대상 실행: [run 30851439553](https://github.com/mposition/Tomverse/actions/runs/30851439553)
(`Chat state visual regression goldens`, job 91812146982, `main` / `c266ea8`).
비교 실행: 성공 #2 [run 30716928149](https://github.com/mposition/Tomverse/actions/runs/30716928149) (`87a18e1`),
실패 #3 [run 30765658062](https://github.com/mposition/Tomverse/actions/runs/30765658062) (`0a99fdc`).

## 요약

실패 24건은 **서로 무관한 두 원인**이 겹친 결과입니다.

| 분류 | 건수 | 원인 | 조치 |
|---|---|---|---|
| A. 골든 노후 | 15 | UI-014(#267)의 패널 모델 select 필드화가 canonical 골든에 반영되지 않음 | canonical workflow로 재기록 |
| B. fixture 결함 | 9 | E2E mock의 `PATCH /api/conversations/:id`가 `selectedModels`를 저장하지 않음 | mock 수정 |

**제품 회귀는 없습니다.** B는 제품이 설계대로 동작한 결과를 test mock이 잘못
유발한 것이고, A는 의도된 접근성 개선이 골든에 반영되지 않은 것입니다.

Playwright 1.62.0 → 1.62.1은 원인이 아닙니다. #3은 1.62.0에서 이미 같은 15건이
실패했고, 픽셀 실패 목록이 #3과 #4에서 완전히 동일합니다.

## 실패 이미지별 분류

### A. 골든 노후 — 15건 (#3·#4 공통, 전부 desktop)

`chat-streaming-desktop-{light,dark}-ko`, `chat-streaming-reduced-motion-desktop-light-ko`,
`chat-success-desktop-{light,dark}-ko`, `chat-partial-failure-desktop-{light,dark}-ko`,
`chat-error-desktop-{light,dark}-ko`, `chat-error-long-message-desktop-light-{ko,en}`,
`chat-retry-desktop-{light,dark}-ko`, `chat-attachment-complete-desktop-light-ko`,
`chat-partial-failure-desktop-dark-en`.

- diff 비율 0.02–0.03. 허용치(`GOLDEN_MAX_DIFF_PIXEL_RATIO` = 0.006)의 3–5배.
- 판단 근거: 재기록 전후 골든을 **둘 다 canonical 환경에서 얻어** 직접 비교한
  결과, 패널 헤더의 모델 select가 테두리 없는 라벨에서 UI-014의 입력 필드
  형태(테두리·배경·padding)로 바뀌었고 그 높이 증가만큼 패널 본문이 약 6px
  아래로 밀렸습니다. 본문 텍스트의 줄바꿈 위치는 신구 골든이 동일합니다.
- rasterization 차이가 아닙니다. canonical runner에서 mobile 골든은 한 장도
  실패하지 않았고 sidebar 영역 diff는 0입니다. 변경은 `DesktopChatShell`에만
  국한됩니다.
- 마지막 canonical 기록 커밋 `28f2c57`(#229) 이후 이 spec의 PNG는 한 장도
  변경되지 않았고, UI-014는 그 뒤인 `b0615fc`(#267)에서 들어왔습니다.

`chat-loading-desktop-*`은 같은 select 변경을 담고 있으면서도 통과했습니다.
패널에 메시지가 없어 아래로 밀릴 내용이 없고, select 자체의 변화만으로는
0.006을 넘지 않기 때문입니다. 재기록에서도 이 이미지는 바뀌지 않았습니다.

### B. Deep Research 기능 실패 — 9건 (#4에서 신규)

`chat-deep-research-{desktop,mobile}-{light,dark}-ko`,
`chat-deep-research-complete-{desktop-light,mobile-dark}-ko`,
`chat-deep-research-failed-{desktop-light,mobile-dark}-ko`,
`chat-deep-research-failed-active-mobile-dark-ko`.

- 골든 diff가 아니라 `element(s) not found` / `locator.click` 30s timeout입니다.
  desktop은 `심층 리서치 요청 중…`을 찾지 못했고, mobile은
  `[data-testid="mobile-model-tab"][data-model-id="perplexity/sonar-deep-research"]`
  자체가 나타나지 않았습니다.
- #3에서는 같은 테스트들이 **화면 캡처 단계까지 도달해 픽셀로만** 실패했습니다
  (`chat-state-fixtures.ts:651`). 즉 기능 실패는 #4에서 새로 생긴 것입니다.
- 재현 결과 원인은 다음 한 줄로 확인됩니다.

  ```
  chat_model_settings_flush_failed  outcome:"confirmed"
  capturedModelIds:  [claude-sonnet-5, gemini-3-5-flash, perplexity/sonar-deep-research]
  confirmedModelIds: [claude-sonnet-5, gemini-3-5-flash]
  ```

  Deep Research 모델은 선택에 **정상적으로 추가됐고**, 그 직후 send barrier가
  이를 되돌렸습니다.

## 근본 원인 (B)

`tests/e2e/support/app-fixtures.ts`의 mock `PATCH /api/conversations/:id`는
`password`·`title`·`unlock`만 처리하고 `selectedModels`·`disabledPanels`를
무시한 뒤, seed 값으로 다시 만든 conversation 본문을 응답했습니다. 실제
endpoint(`app/api/conversations/[conversationId]/route.ts`)는 두 필드를 저장하고
저장된 값을 반환합니다.

이 괴리는 #301의 serialized model-selection sync가 실제 send barrier를 도입하면서
치명적이 됐습니다. `ensureModelSettingsReady()`는 이 응답에서 확인값을 읽어
**전송하려는 선택과 정확히 일치할 때만** 통과합니다. seed를 되돌려주는 mock은
앱에게 "저장된 적 없음"을 알린 셈이고, 앱은 설계대로 전송을 포기하고 화면을
마지막 확인 선택으로 되돌린 뒤 `모델 선택을 서버에 저장하지 못했습니다`를
표시했습니다.

Deep Research가 먼저 드러난 이유는, **선택을 바꾼 직후 그 선택으로 곧바로
전송하는 유일한 흐름**이기 때문입니다. 다른 골든은 선택을 바꾸지 않으므로
영향을 받지 않았습니다.

`docs/policy/chat-concurrency-and-identity.md`의 계약은 그대로입니다. 제품
코드는 수정하지 않았습니다.

## 조치

1. `tests/e2e/support/app-fixtures.ts` — mock이 PATCH에서 `selectedModels`·
   `disabledPanels`를 저장하고 되돌려주도록 실제 endpoint와 맞췄습니다.
   `AuthenticatedQaState`가 저장값을 노출합니다.
2. canonical 골든 19장 재기록 —
   [Record Visual Baseline run 30864171184](https://github.com/mposition/Tomverse/actions/runs/30864171184),
   branch `visual-baseline/30864171184`, 아티팩트 `visual-baseline-30864171184`.
   `--update-snapshots`는 이 workflow 안에서만 실행됐고 Nightly/PR/Main workflow는
   손대지 않았습니다.

19장 = A의 15장 + Deep Research **desktop** 4장입니다. Deep Research **mobile**
5장은 fixture 수정만으로 기존 골든과 일치했습니다 — 그 골든들은 처음부터
옳았고 fixture만 깨져 있었다는 뜻입니다.

## 검증

| 검증 | 결과 |
|---|---|
| Record Visual Baseline, 재기록 전 canonical 판정 | 19 failed / 62 passed — **#3과 완전히 동일**, 즉 #4의 기능 실패 9건이 사라짐 |
| Record Visual Baseline, 재기록 후 clean run (`--retries=0`) | **81 passed / 0 failed** |
| Nightly Visual Regression 재실행 ([run 30865246182](https://github.com/mposition/Tomverse/actions/runs/30865246182), 수정 브랜치, `npm run test:e2e:visual -- --retries=0`) | **success** — 아티팩트 268 KB로 diff PNG·video·trace 없음 (실패 0건) |
| PR #336 전체 체크 | 10/10 green (High-risk UI regression desktop·mobile, 빌드·smoke, lint·unit, Admin Console E2E 포함) |
| `npm run test:unit` | 1583 passed |
| `npm run security:regression` | 125 checks passed |
| `npx tsc --noEmit` / eslint | 통과 |

Nightly workflow의 zero-retry·fail-closed 정책은 변경하지 않았습니다.
`continue-on-error`, retry 증가, 허용 오차 확대, 테스트 skip은 없습니다.

## 남은 위험

- 이 컨테이너는 `cdn.playwright.dev`에 접근할 수 없어(403) canonical Chromium을
  설치할 수 없습니다. 로컬에서 픽셀을 판정한 결과는 전부 `Not verified`이며,
  본 문서의 픽셀 판단은 모두 CI(canonical)에서 얻은 이미지에 근거합니다.
  실제로 로컬 substitute Chromium(141)은 canonical(151)과 native `<select>`
  렌더링과 텍스트 줄바꿈이 달라, 초기에 UI-026(`whitespace-pre-wrap` 제거)이
  원인인 것처럼 보이게 했습니다. canonical 신구 골든 비교에서 줄바꿈은 동일했고
  UI-026은 이 골든들과 무관합니다. `docs/qa/canonical-visual-baseline.md`가
  경고하는 바로 그 함정입니다.
- 실패 아티팩트 `nightly-visual-regression-30851439553`는 내려받지 못했습니다.
  `productionresultssa17.blob.core.windows.net`이 이 세션의 egress 정책에서
  차단됩니다(403). 대신 job log의 실패 목록·픽셀 수와, canonical 재기록의
  신구 골든 직접 비교를 근거로 삼았습니다.
- `chat-loading-desktop-*`이 허용치 바로 아래에서 통과하고 있습니다. 같은
  영역에 추가 변경이 생기면 이 이미지도 넘어갈 수 있으며, 그 자체는 회귀가
  아닙니다.

---

# 후속: 실행 #5–#8 (2026-08-06)

위 분석과 그 수정(release #342)이 배포된 뒤의 이력입니다. 위 문서는 #4까지만
다루고 있어서, 그 뒤로 한 번 더 빨간 밤이 있었다는 사실이 어디에도 기록되지
않았습니다.

| # | 일시 | commit | 결과 |
|---|---|---|---|
| 5 | 08-04 00:20 | `7ee5937d` (수정 브랜치) | success |
| 6 | 08-04 03:20 | `18d1e891` | success |
| 7 | 08-04 20:49 | `18d1e891` | **failure** |
| 8 | 08-05 20:43 | `94e19842` | success |

**#6과 #7은 같은 commit에서 갈렸습니다.** 골든 문제도 fixture 문제도 아닙니다 —
픽셀 diff가 아니라 focus 경합입니다.

    expect(purchaseDialog.locator("button").first()).toBeFocused()
    Expected: focused / Received: inactive
    14 x locator resolved to ... data-testid="credit-pack-modal-close"

버튼은 5초 내내 거기 있었고 focus만 잡히지 않았습니다.

## 원인과 조치

`UsageLimitModal`이 scroll lock·초기 focus·Escape/Tab 핸들러를 **한 effect**에
두고 있었고, 그 dependency 목록에는 `onClose`가 들어가야 합니다. 호출부
`ChatInput`은 `onClose={() => setIsUsageLimitModalOpen(false)}`를 넘기므로 매
render마다 새 함수입니다. 즉 이 dialog가 열려 있는 동안 `ChatInput`이 render될
때마다 effect가 해체·재구성됐고, 매 주기마다 focus가 두 번 움직였습니다 —
cleanup이 열기 전 요소로 되돌리고, 재실행이 자기 close 버튼으로 당겨왔습니다.

위에 아무것도 없을 때는 무해합니다. 크레딧 팩 구매 dialog가 **이 dialog 안에서**
열리고 `ChatInput`은 입력·스트리밍·모델 상태 폴링으로 끊임없이 render되므로,
구매 dialog가 방금 잡은 focus를 지키는지는 어느 requestAnimationFrame이 마지막에
착지하느냐로 결정됐습니다. 그것이 nightly가 잡아낸 동전 던지기이고, 키보드
사용자에게는 flaky test보다 나쁩니다 — 자기가 연 dialog 밖으로, 아무 입력도 하지
않았는데 focus가 떨어집니다.

`DeepResearchSetupSheet`도 `ChatPageClient`에서 같은 모양입니다.

두 component 모두 effect를 나눴습니다(commit `b20841c`). focus와 scroll lock은
`open`만 보고, key 핸들러는 `onClose` dependency를 유지합니다 — listener를 붙였다
떼는 것은 focus를 움직이지 않으므로 부모 render마다 재구독해도 비용이 없습니다.
`tests/modalFocusEffectDeps.test.mjs`가 그 모양을 고정합니다: focus를 *예약하는*
effect(rAF·timeout으로 focus하는)는 callback prop에 의존할 수 없습니다. event
handler 안에서 옮기는 focus는 의도적으로 제외했습니다 — Tab trap은 focus를
옮겨야 하고 현재 `onClose`를 봐야 합니다.

## 아직 증명되지 않은 것

**#8이 green인 것은 이 수정의 증거가 아닙니다.** #8은 `main`의 `94e19842`에서
돌았고 `b20841c`는 아직 PR #400에 머물러 있어 그 commit에 없습니다. #6이 #7과
같은 commit에서 통과했듯, flake는 원래 통과하는 밤이 있습니다.

이 컨테이너에서는 해당 spec을 돌릴 수 없습니다. `skipUnlessCanonicalVisualBrowser()`가
걸려 있어 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 없이는 브라우저가 뜨지 않고, 그것을
지정하면 spec이 설계대로 skip합니다(gate가 정상 작동하는 것입니다). 따라서 진단은
CI 로그와 코드에서 나온 것이고 재현이 아닙니다.

**증거가 되는 것은 `b20841c`가 `main`에 들어간 뒤의 nightly입니다.** 그 전까지
이 항목은 열려 있습니다.

## 같은 계열의 미해결 flake

`tests/e2e/source-grounding.spec.ts:347`("the explanation is reachable by keyboard
and dismissed with Escape")이 daily security audit에서 flaky로 보고되며, 로컬
substitute Chromium에서 2/10·4/12로 재현됩니다. 실패 양상은 두 가지입니다 —
`info.focus()` 뒤 popover 요소가 없거나, Escape 뒤 `info`가 focus되지 않고
`aria-expanded="false"`에 focus가 `<body>`에 있습니다.

실험으로 배제한 가설:

1. `onBlurCapture`의 rAF close 경로 — 비활성화해도 4/12로 동일
2. dialog의 focus 탈취 — `ComparisonReviewDialog`와 `ChatPageClient`에 `.focus(`
   호출이 **하나도 없음**
3. test 쪽 settle 타이밍 — 값 텍스트 대기 추가 시 2/12로 감소하나 잔존
4. `ComparisonReviewDialog`의 setup fetch effect가 불안정한 dependency로 매
   render마다 abort·재요청 — `t`는 `useCallback([lang])`으로, `guestSource`는
   `useState`로 각각 안정. 성립하지 않음

probe로 확인된 사실: `info.focus()` 직후의 `await expect(info).toBeFocused()`는
**한 번도 실패하지 않았습니다.** 즉 focus 시점의 node 교체와 focus 탈취는
제외됩니다. 실패는 Escape 이후 구간에 있습니다.

가설 네 개가 죽었으므로 다음 사람은 추측이 아니라 실패하는 실행의 DOM을 직접
계측하는 것에서 시작하는 편이 낫습니다.

---

# 후속: source-grounding flake의 원인 (2026-08-12)

위 "같은 계열의 미해결 flake" 항목이 닫혔습니다. 가설이 아니라 실패하는 실행의
DOM을 계측해서 나온 결론입니다.

## 계측

`openReviewResult()`가 `page.goto()` 하기 전에 `addInitScript`로 probe를 심고
(`focusin`/`focusout`/`keydown`을 capture로, `aria-expanded` 변화와 info 버튼
subtree의 추가·제거를 `MutationObserver`로), Escape 뒤 focus가 info에 없을 때만
전체 log를 출력하도록 했습니다. `--repeat-each=12`에서 1건이 실패했고 log는
이렇습니다.

    7568 focusin  button[ai-review-source-grounding-info]
    7615 focusout button[ai-review-source-grounding-info] -> button{flex h-9 w-9 …}
    7616 focusin  button{flex h-9 w-9 …}
    7662 keydown  Escape

**focus 탈취가 맞습니다.** test가 `info.focus()`한 지 47ms 뒤, 아무 입력도 없이
focus가 dialog의 Close 버튼(`ComparisonReviewDialog` 헤더의 `h-9 w-9`)으로
옮겨갔습니다. Escape는 그 뒤에 도착했습니다.

이전 조사가 가설 2("dialog의 focus 탈취")를 기각한 것은 `ComparisonReviewDialog`와
`ChatPageClient`에 `.focus(` 호출이 없다는 근거였습니다. 그 관찰은 맞지만 결론이
틀렸습니다 — focus를 옮기는 코드는 두 파일 어디에도 없고, 두 파일이 함께 쓰는
hook `components/useModalDialog.ts`에 있습니다.

probe가 확인한 부수 사실: 실패한 실행에서도 `aria-expanded`는 `false`가 되고
popover는 사라집니다. 그 두 assertion은 **틀린 이유로 통과**했습니다. Escape가
닫은 것이 아니라, focus가 탈취되면서 badge의 `onBlurCapture`가 닫은 것입니다.
보고된 다른 실패 양상("`info.focus()` 뒤 popover 요소가 없음")도 같은 사건이
assertion보다 조금 일찍 일어난 경우입니다.

## 원인

`useModalDialog`가 초기 focus·scroll lock·Tab trap·Escape·focus 복귀를 **한
effect**에 두고 dependency에 `onClose`를 넣고 있었습니다. #7의 `UsageLimitModal`과
정확히 같은 결함이며, 다른 점은 위치입니다 — 이번에는 modal 10곳이 공유하는
hook입니다.

`ChatPageClient`는 `onClose={() => setShowComparisonReview(false)}`를 넘기므로 매
render마다 새 함수이고, chat 화면은 입력·스트리밍·모델 상태 폴링으로 끊임없이
render됩니다. 그때마다 이 effect가 해체·재구성되면서 focus가 두 번 움직입니다 —
cleanup의 rAF가 trigger로 되돌리고, 재실행의 rAF가 panel의 첫 focusable(=Close)로
당겨옵니다. 어느 쪽이 마지막에 착지하느냐가 동전 던지기이고, 그것이 flake의
전부입니다.

**이것은 test 문제가 아닙니다.** 키보드 사용자가 AI Review 안에서 출처 일치도
설명 버튼에 focus를 두면, 아무것도 누르지 않아도 약 50ms 뒤 Close 버튼으로
튕겨납니다.

## 조치

effect를 둘로 나눴습니다. focus와 scroll lock은 `open`과 ref만 보고, key
handler는 `onClose` dependency를 유지합니다 — listener 교체는 focus를 옮기지
않고, Tab trap은 현재 `onClose`를 봐야 합니다. focus 복귀는 focus 배치와 같은
effect에 남깁니다(같은 쌍의 teardown이므로).

`tests/modalFocusEffectDeps.test.mjs`의 scan이 `components/**/*.tsx`만 읽고
있어서 이 hook을 한 번도 보지 않았습니다. `.ts`와 `app/`까지 넓혔고, 넓힌 상태로
수정 전 코드에 대해 **실패하는 것을 먼저 확인**했습니다(offender 1건, 오탐 0건).
hook 전용 pin도 추가했습니다.

## 증거

| 실행 | 수정 전 | 수정 후 |
|---|---|---|
| `-g "reachable by keyboard" --repeat-each` | 12회 중 1 실패 | 24 + 60 = **84회 연속 통과** |

수정 전 관측 실패율은 이번 12회 1건과 이전 기록(2/10, 4/12)을 합쳐 대략 10–30%
입니다. 그 하한인 10%라 해도 84회 연속 통과 확률은 약 0.014%입니다.

modal 관련 e2e도 함께 돌렸습니다: desktop 94건 + 76건, mobile 49건, 전부 통과.
unit 2578건 통과.

**남은 것**: `b20841c`가 `main`에 들어간 뒤의 nightly는 여전히 그 수정의 증거로
남아 있습니다. 이 항목은 그것과 별개입니다.

---

# 계획했던 증거는 더 이상 증거가 아닙니다 (2026-08-13)

위 두 절이 각각 "`b20841c`가 `main`에 들어간 뒤의 nightly가 증거"라고 적어
두었습니다. **그 계획은 이제 성립하지 않습니다.** 실행 이력이 그 이유입니다.

| # | 일시 | commit | 결과 |
|---|---|---|---|
| 7 | 08-04 20:49 | `18d1e891` | **failure** |
| 8 | 08-05 20:43 | `94e19842` | success |
| 9–12 | 08-07 00:45 · 08-07 · 08-08 · 08-09 | `9d9052c8` | success |
| 13–14 | 08-10 · 08-11 | `df969816` | success |
| 15 | 08-12 20:08 | `43c870dc` | success |

**#8부터 #15까지 8일 연속 green이고, 그 어느 것에도 수정이 들어 있지 않습니다.**
2026-08-13 기준 `b20841c`와 `b6223be`는 `develop`에만 있고 `main`
(`9db1d5e`)에는 없습니다.

따라서 수정이 `main`에 들어간 뒤 nightly가 green이어도 그것은 아무것도
증명하지 않습니다. 수정 없이 이미 8번 green이었으므로, 같은 결과를 수정의
효과로 읽으면 안 됩니다. #6과 #7이 **같은 commit에서 갈렸다**는 사실이 원래
이 항목의 출발점이었는데, 같은 사실이 지금은 "nightly 한 번은 이 flake에 대해
판정력이 없다"를 뜻합니다.

## 대신 무엇이 증거인가

flake의 판정은 nightly가 아니라 **통제된 반복 실행**에서 나옵니다. 이미 그렇게
얻은 것이 두 가지입니다.

1. **`source-grounding` 경로**: 수정 전 12회 중 1 실패, 수정 후 84회 연속 통과
   (위 표). 관측 실패율 하한 10%로 계산해도 우연일 확률 약 0.014%입니다.
2. **`useModalDialog` 자체**: `tests/e2e/modal-focus-contract.spec.ts`의
   "a re-render of the component that owns the dialog does not move focus"가
   결정론적 negative control을 가집니다 — split 이전 hook(`b6223be~1`)으로
   되돌려 다시 빌드하면 그 assertion에서 실패하고, 되돌리면 통과합니다.
   nightly가 우연히 표본을 잘못 뽑는 것과 달리 이 테스트는 매번 같은 답을
   냅니다.

`b20841c`가 `main`에 도달한 뒤의 nightly는 **회귀 감시**로는 계속 의미가
있습니다. 다만 그것을 이 수정의 *증명*으로 인용해서는 안 됩니다. 증명은 위 두
가지이고, 그 둘은 이미 저장소 안에 있습니다.

## 이 계열에서 남은 것

- `main`이 수정을 받은 뒤에도 nightly가 red로 돌아오면, 그때는 새 조사입니다 —
  이 문서의 focus 경합은 재현·수정·고정이 끝났습니다.
- WebKit 실패 9건은 이 컨테이너에 WebKit이 없어 여전히 확인하지 못했습니다.
