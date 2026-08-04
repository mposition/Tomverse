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
