# SHORT-VIEWPORT-001 — 짧은 viewport에서 mobile sidebar drawer 도달성 감사·수정

- 작성일: 2026-07-30
- 대상: mobile chat sidebar drawer (`MobileChatShell` + `ChatSidebar isMobileDrawer`)
- 기준 build SHA: `cb57c8d758baf99ef174e7f79a3b6562472766db`
- 판정: **재현됨 (P1 확정) → 수정 완료, 자동화 회귀 확보**

---

## 1. 재현 환경

| 항목 | 값 |
|---|---|
| build | `cb57c8d` (`npm run build`, production server `next start -p 3100`) |
| runner | Linux 6.18.5 container, Playwright project `mobile-chromium` (Pixel 5 preset) |
| browser | Chromium **141.0.7390.37** (`/opt/pw-browsers/chromium-1194`) |
| 실행 방식 | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=…` fallback 사용 |

> **canonical 여부**: `playwright.config.ts`가 고정한 Chromium revision은 1234
> (151.0.7922.34)이며, 이 환경에서는 다운로드가 차단돼 pre-provisioned 141을
> 사용했습니다. `docs/qa/canonical-visual-baseline.md` 기준으로 이 실행은
> **golden screenshot 판정에 쓸 수 없습니다.** 이번 작업은 golden을 갱신하지
> 않았고, 모든 판정은 geometry·hit-test 수치로만 했습니다.

---

## 2. 재현 결과 — finding은 실재합니다

스크린샷이 아니라 DOM geometry로 측정했습니다. guest / 대화 1개 / organizer
collapsed 기준(수정 전 build):

| viewport | drawer 높이 | 실제 content 높이 | 잘린 양 | footer box | analytics 버튼 box | list scroll range |
|---|---|---|---|---|---|---|
| 382×560 (제보) | 560 | 638 | **78px** | 405–638 | **542–582** | **0** |
| 320×480 | 480 | 658 | **178px** | 405–658 | **542–602** | **0** |
| 360×520 | 520 | 658 | **138px** | 405–658 | 542–602 | 0 |
| 320×568 | 568 | 658 | **90px** | 405–658 | 542–602 | 0 |
| 390×568 | 568 | 638 | **70px** | 405–638 | 542–582 | 0 |
| 568×320 | 320 | 638 | **318px** | 405–638 | 542–582 | 0 |
| 390×844 | 844 | 844 | 0 | 611–844 | 748–788 | 0 (정상) |

핵심은 **scroll range 0**입니다. drawer 안의 유일한 scroller는 conversation
list인데 footer는 그 안에 없습니다. 즉 382×560에서
`guest-analytics-cookie-settings` 버튼은 중심점이 y=562 (viewport 560 바깥)에
있고, **어떤 스크롤로도 도달할 수 없었습니다.** `toBeAttached()`와 프로그램
방식 `.click()`은 이 build에서도 통과합니다 — 그래서 둘 다 근거로 쓰지
않았습니다.

추가로 측정한 상태:

- **guest, 대화 20개 + organizer expanded, 382×560**: content 798px(238px 잘림).
  list는 자체적으로 1065px 스크롤되지만 footer는 여전히 밖.
- **authenticated, 382×560**: content 560px으로 **딱 맞아 재현되지 않음**
  (계정 footer는 120px으로 guest의 233px보다 짧음). 단 320×480·568×320·667×375
  에서는 동일하게 재현됨. 즉 이 finding은 guest 전용이 아니며, 높이가
  더 줄면 계정 사용자도 동일하게 잃습니다.

---

## 3. Root cause

`ChatSidebar`의 drawer layout은 **고정 chrome + 가운데 list scroller** 구조이고,
이 구조에는 넘길 수 없는 최소 높이가 있습니다.

| 구간 | 높이 |
|---|---|
| header + New Chat + search/organizer | 245px |
| conversation list 하한 (`min-h-[10rem]`) | 160px |
| account footer (usage + language + login + analytics + feedback) | 233–253px |
| **합계** | **638–658px** |

footer는 `shrink-0`, list는 `min-h-[10rem]` 아래로 못 줄어들기 때문에, 남은
높이가 부족하면 flex column이 압축되는 대신 **footer가 panel 아래로 밀려나갑니다.**
그런데 `aside`의 overflow는 `visible`이라 스크롤이 생기지 않고, 실제 overflow
owner인 conversation list는 footer를 포함하지 않습니다.

- 실제 overflow owner: `aside[data-testid="chat-sidebar"]` (`overflow-y: visible`,
  scrollHeight 638–798 vs clientHeight 320–568)
- 실제 scroll owner: `div[data-testid="sidebar-conversation-list"]` — footer 미포함

즉 **overflow가 나는 곳과 스크롤할 수 있는 곳이 다른 것**이 근본 원인입니다.
특정 기기나 620px이라는 숫자는 원인이 아니라 증상의 경계일 뿐입니다.

부수적으로 확인된 두 번째 원인축: 가상 키보드입니다. iOS Safari와 Android
Chrome 기본 모드에서 layout viewport는 키보드가 올라와도 844px 그대로이므로,
`position: fixed` drawer는 키보드 아래로 뻗고 footer도 같이 가려집니다. CSS
`max-height` media query로는 이 축을 볼 수 없습니다.

---

## 4. 변경 파일과 최소 diff의 근거

| 파일 | 변경 | 이유 |
|---|---|---|
| `components/chat/useVisualViewport.ts` | `useShortViewport()` 추가(`MIN_PINNED_DRAWER_HEIGHT = 700`), 공용 subscribe에 `window resize/orientationchange` 추가 | 판단 기준을 **visible viewport**로. 키보드·회전·동적 chrome을 CSS query는 못 봅니다. subscribe 보강은 `visualViewport` 없는 browser의 fallback |
| `components/chat/ChatSidebar.tsx` | drawer의 `aside`에 `overflow-y-auto overscroll-contain`; 짧을 때 list는 `flex-none overflow-visible`, organizer panel은 자체 scroller 해제; header `sticky top-0 z-10`; footer `mt-auto` | overflow가 나는 요소를 그대로 scroll owner로 만들고, 짧은 높이에서는 scroll 주인을 **하나로 단순화** |
| `components/chat/MobileChatShell.tsx` | panel에 `pb-[env(safe-area-inset-bottom)]`, `data-testid`, `style={{bottom: useKeyboardInset()}}`, close button `z-20` | bottom safe-area 확보, 키보드가 가린 만큼 panel을 줄임, sticky header 위로 close button 유지 |
| `components/auth/AuthButton.tsx` | guest 로그인 행 `flex flex-wrap`, analytics 버튼 `shrink-0` → `min-w-0` | 200% text scale에서 analytics 버튼이 drawer보다 **168px 넓어** 가로 overflow를 만들었음 |
| `components/chat/FeedbackButton.tsx` | `triggerTestId` prop | feedback 버튼에 안정적인 selector가 없어 회귀 테스트가 텍스트에 의존해야 했음 |

의도적으로 **하지 않은 것**: 기능 숨기기, "더보기" 이동, touch target 축소,
글자 크기 축소, 기기·UA 분기, footer overlay, sidebar 대규모 refactor.

### 동작 규칙 (두 상태, 각각 scroll owner 하나)

- **visible height ≥ 700px**: 기존과 동일. list가 scroller, header·footer 고정,
  drawer 자체는 overflow 없음.
- **visible height < 700px**: list가 scroller를 내려놓고 자연 높이(`flex-none`)를
  가지며, drawer 전체가 header·list·footer를 포함한 **단일 scroll region**이 됨.

`flex-none`을 쓴 이유는 명시해 둘 만합니다. 줄어들 수 있는 item에
`overflow: visible`을 주면 box보다 큰 내용이 footer 위에 그대로 그려집니다.
`mt-auto`는 반대쪽 극단(내용이 panel보다 짧은 경우)에서 footer가 공중에 뜨는 것을
막고, overflow 상황에서는 auto margin이 0으로 resolve되므로 부작용이 없습니다.

700px의 근거는 §3의 측정치 658px에 locale·font·rounding 여유를 더해 올림한
값입니다. 임의의 기기 숫자가 아닙니다.

---

## 5. viewport/state별 before/after

guest / en / 대화 1개 기준. after의 `lastCtrl`은 스크롤 후 analytics 버튼 box,
`( )` 안은 visible viewport 하단.

| viewport | before: 잘린 양 / 도달 가능? | after: drawer scroll range / list nested / 스크롤 후 analytics box |
|---|---|---|
| 320×480 | 178px / ✗ | 178 / 0 / 364–424 (480) |
| 360×520 | 138px / ✗ | 138 / 0 / 404–464 (520) |
| 382×560 | 78px / ✗ | 78 / 0 / 464–504 (560) |
| 320×568 | 90px / ✗ | 90 / 0 / 452–512 (568) |
| 390×568 | 70px / ✗ | 70 / 0 / 472–512 (568) |
| 568×320 | 318px / ✗ | 318 / 0 / 224–264 (320) |
| 667×375 | 263px / ✗ | 263 / 0 / 279–319 (375) |
| **390×844** | 0 / ✓ | **0 / 1102 / footer 611–844 고정** |

ko(guest)는 footer가 234px으로 조금 더 높아 content 673px, 각 viewport에서
동일하게 전부 도달 가능합니다. authenticated는 content 525px이라 320×480(45),
360×520(5), 568×320(205), 667×375(150)에서 drawer가 스크롤되고 나머지는 스크롤
없이 전부 보입니다.

**390×844 무회귀 확인**: drawer scroll range 0, conversation list가 여전히
scroller(대화 24개에서 range 1102), footer bottom과 panel bottom 차이 0px.

---

## 6. 자동화

새 spec: `tests/e2e/mobile-short-viewport-drawer.spec.ts` (31 test).

측정 항목: `innerHeight` / `documentElement.clientHeight` /
`visualViewport.height`·`offsetTop` / panel·sidebar·list·footer bounding box /
scroll owner의 `clientHeight`·`scrollHeight`·`scrollTop` / 각 필수 조작의 초기
box와 최대 스크롤 후 box / 중심점 `elementFromPoint` / document·drawer 가로
overflow / focus 이동 후 가시 영역 교차 면적 / body scrollTop.

커버: 320×480, 360×520, 382×560, 320×568, 390×568, 568×320, 667×375, 390×844 ×
(guest en/light, guest ko/dark, authenticated) · 대화 0/1/3/24개 · organizer
collapsed/expanded · 100%/200% root text · drawer를 연 채 844→560→480 축소 ·
회전(390×844 → 667×375) · 가상 키보드 320px · focus trap 전체 순회 ·
Escape/backdrop/close 버튼 dismissal과 focus 복귀.

### 실행 명령과 결과

| 명령 | 결과 |
|---|---|
| `playwright test --project=mobile-chromium tests/e2e/mobile-short-viewport-drawer.spec.ts` | **31 passed / 0 failed** |
| 위 spec을 수정 전 로직으로 되돌린 build에 실행 | **21 failed** — 예: `guest-en-382x560 / feedback: centre below the visible viewport (610 > 560)` |
| 필수 기존 spec 7종 × 3 project (`--workers=1`) | **168 passed / 2 failed** (아래 참조) |
| `npm run test:unit` | 552 passed / 0 failed |
| `npm run test:server-contract` | 6 passed / 0 failed |
| `npm run security:regression` | 113 checks passed |
| `npm run typecheck` | pass |
| `npm run lint` | 0 error / 0 warning |
| `npm run check:accent-tokens` | pass (10 guarded files) |
| `npm run check:encoding` | pass |
| `npm run build` | pass |
| `npm run verify:smoke-coverage` | pass (21/21) |

### 남은 2건 — 이번 변경과 무관함을 확인

1. `mobile-composer-contract.spec.ts` golden 2건(390px·320px, 3 models, partial
   web search). 원인은 §1의 non-canonical Chromium(141 vs 151)입니다.
   **golden을 갱신하지 않았습니다.**
2. `upgrade-discovery.spec.ts › panel-only send waits for a changed model
   selection to persist` (desktop-chromium·desktop-compact).

두 건 모두 **변경 전 clean tree(`cb57c8d`)에서 동일하게 실패**하는 것을 직접
확인했습니다. 그 밖에 병렬 실행에서 산발적으로 관측된 실패
(`analytics-settings-target` marketing/pricing/signin, `remediation-accessibility`
ko select)는 `--workers=1` 또는 `--repeat-each=3` 단독 실행에서 전부 통과했으며,
runner 부하로 인한 flake입니다.

### artifact 경로

- geometry JSON: `test-results/short-viewport-drawer/<state>-<viewport>.json`
  (22개, Playwright report에도 attach)
- 상태별 screenshot: 각 test의 attachment `<state>-<viewport>.png`
- 실패 재현 시 trace/video: `test-results/<test-dir>/trace.zip`, `video.webm`

---

## 7. 실제 기기 검증

- iOS Safari: **Not verified on physical device**
- Android Chrome: **Not verified on physical device**
- 동적 browser chrome(URL bar 접힘/펼침) 실사용 축: **Not verified on physical device**

이 환경에는 WebKit browser가 설치돼 있지 않아 `mobile-safari` project도 실행하지
못했습니다(`mobile-chromium`만 실행). 가상 키보드는 `openOnScreenKeyboard()`의
`visualViewport` 축소 emulation으로 검증했으며, 이는 layout/visual viewport
괴리라는 **문제의 축에 대해서는 충실하지만** 키보드 애니메이션 타이밍이나
browser별 scroll-anchoring 동작은 말해주지 않습니다.

---

## 8. 남은 위험과 후속 관찰

1. **700px 위에서의 잔여 nested scroll.** visible height가 700px 이상인데
   organizer expanded + 200% text 같은 조합으로 drawer가 넘칠 수 있습니다. 이때는
   list와 drawer가 둘 다 scroller가 되지만, drawer가 `overflow-y-auto`이고 list가
   `overscroll-auto`라 drag가 list 끝에서 drawer로 이어져 갇히지 않습니다.
   (390×844 + 200% text는 spec에서 커버.)
2. **긴 대화 목록에서의 스크롤 거리.** 짧은 viewport에서는 drawer가 단일 scroll
   region이므로 대화가 많으면 footer까지의 스크롤 거리가 길어집니다. 도달성은
   보장되지만(대화 24개 케이스 통과) 인체공학은 최선이 아닙니다. 상단 chrome을
   sticky로 더 고정하는 방안은 200% text에서 sticky 높이가 viewport를 넘길 위험이
   있어 채택하지 않았습니다.
3. **이번 finding 범위 밖의 관찰(별도 항목 후보).** drawer 안에서 44px 미만인
   조작이 이미 존재합니다 — chat search 36px, organizer toggle 36px, language
   `<select>` 18px(40px 행 안), login/analytics/feedback/account trigger 40–41px.
   이번 변경으로 **줄이지도 늘리지도 않았고**, 회귀 테스트가 현재 값을 하한으로
   고정했습니다. 확대 여부는 별도 design decision이 필요합니다.
4. sidebar tour panel(`absolute inset-x-3 bottom-3`)은 이제 drawer scroll 내용의
   맨 아래에 위치합니다. 스크롤로 도달 가능하지만 짧은 viewport에서 표시 위치가
   달라집니다.

---

## 9. Go-Live 판정

| 완료 조건 | 결과 |
|---|---|
| 필수 matrix 전 viewport/state에서 잘린 필수 조작 0 | ✅ |
| scroll로 도달 불가한 필수 조작 0 | ✅ |
| drawer/footer와 viewport·safe-area overlap 0 | ✅ |
| center hit-test 실패 0 | ✅ |
| keyboard focus가 viewport 밖에 남는 경우 0 | ✅ |
| 가로 overflow 및 background scroll 0 | ✅ (200% text의 기존 168px overflow도 함께 제거) |
| 44×44 target·typography·accessible name·focus return 회귀 0 | ✅ |
| Guest/Authenticated, en/ko 통과 | ✅ |
| 390×844 및 desktop sidebar 무회귀 | ✅ |
| before/after geometry·screenshot artifact 보존 | ✅ |
| 실제 기기 검증 | ⚠️ **N/V** (§7) |

**판정: 자동화 축 기준 Go.** 단, iOS Safari / Android Chrome 실기기와 동적
browser chrome 축은 검증되지 않았으므로 **완전 Pass로 표현하지 않습니다.**
릴리스 전 실기기 smoke 1회(382×560급 창 높이에서 drawer를 열고 login·analytics·
feedback까지 스크롤)를 권장하며, 그 전까지 해당 축은 N/V로 남깁니다.
