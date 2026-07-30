# Provider status banner UX — visual golden 2건 `Not verified` 판정 증거

> 2026-07-30 · 대상 SHA `bf55493` (`claude/provider-status-banner-ux-nc7sv1`)
> 대조 SHA `e46389e` (clean trunk, 변경 이전 시점)
> 판정: **`Not verified – non-canonical browser`** (Pass 아님, 제품 Fail 아님)

`docs/qa/canonical-visual-baseline.md`의 "When the canonical browser cannot be
installed" 조항에 따른 처리입니다. golden은 갱신하지 않았습니다.

---

## 1. 대상

`tests/e2e/mobile-composer-contract.spec.ts` › `Mobile composer: visual record`

- `composer golden at 320px, 3 models, partial web search`
- `composer golden at 390px, 3 models, partial web search`

두 test 모두 `maxDiffPixelRatio: 0.01` 초과로 실패했습니다.

## 2. 실행 환경

| 항목 | 값 |
|---|---|
| 실행 SHA | `bf55493261678422ff3db6b59249e02c8115a9bc` |
| 대조 SHA | `e46389e` (직전 trunk, 이 작업의 변경 0건) |
| OS | Ubuntu 24.04.4 LTS, x86_64, kernel 6.18.5 |
| Playwright | 1.62.0 (`package.json` `^1.62.0`, lockfile 고정) |
| Playwright 고정 Chromium | revision **1234** / **151.0.7922.34** |
| 실제 실행 Chromium | revision **1194** / **141.0.7390.37** |
| executable path 사용 | **예** — `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` |
| locale / TZ | `en-US` / `UTC` (`canonicalRendering`, 정상 적용) |
| project | `desktop-chromium` (`hasTouch: true`, spec 자체 설정) |

### 왜 escape hatch를 썼는가

고정 build를 내려받을 수 없습니다.

```
$ curl https://cdn.playwright.dev/
curl: (56) CONNECT tunnel failed, response 403

$ curl .../builds/chromium/1234/chromium-linux.zip
curl: (56) CONNECT tunnel failed, response 403
```

Playwright가 요구하는 `chromium_headless_shell-1234`가 image에 없어
`browserType.launch: Executable doesn't exist` 로 Chromium project 전체가
기동하지 않습니다. 저장소가 이미 제공하는 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
fallback으로 **behavioural coverage만** 확보했습니다.

`mobile-safari`는 `/opt/pw-browsers/webkit-2336/pw_run.sh` 부재로 아예
기동하지 않아 이번 실행에서 제외됐습니다(별도 N/V).

## 3. 실행 명령

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
npm run build
npx playwright test --project=desktop-chromium \
  tests/e2e/mobile-composer-contract.spec.ts --grep "composer golden"
```

`--update-snapshots`는 어떤 실행에서도 사용하지 않았습니다.

## 4. diff pixel 수와 비율

Playwright(pixelmatch, antialiasing-aware) 보고값:

| golden | 이미지 | 다른 pixel | 비율 | 임계값 |
|---|---|---|---|---|
| `mobile-composer-partial-web-search-320.png` | 304×141 (42,864 px) | **906** | **0.03** | 0.01 |
| `mobile-composer-partial-web-search-390.png` | 374×141 (52,734 px) | **906** | **0.02** | 0.01 |

원시 채널 비교(문턱값 없음, 자체 계측):

| golden | 차이 pixel | 비율 | \|Δ\|>64 | 최대 Δ | 최대 연결 blob |
|---|---|---|---|---|---|
| 320 | 3,508 | 8.18% | 1,455 (3.39%) | 250 | 607 px, bbox **71×14** @ (43,55), 채움 61% |
| 390 | 3,508 | 6.65% | 1,455 (2.76%) | 250 | 607 px, bbox **71×14** @ (43,55), 채움 61% |

두 viewport에서 차이 pixel 수·강도·최대 blob의 위치와 크기가 완전히 같습니다.
차이는 canvas 폭이 아니라 **동일한 text 내용의 재래스터화**에서만 나옵니다.
최대 blob도 71×14 px — 단어 하나 크기의 text run이며, 이동한 control이
남기는 넓은 사각형 blob이 아닙니다.

이 signature는 `docs/qa/canonical-visual-baseline.md`가 이미 기록한 선례와
일치합니다: *"a run on Chromium 141 against goldens recorded on Chromium 151
reported 906 differing pixels (2-3% of the image) spread across the glyph edges
of every text run, with no element moved and no layout changed."*

### 이미지

`expected` / `actual` / `diff` 3종 × 2 viewport은 Playwright가
`test-results/mobile-composer-contract-M-*/`에 남깁니다. 재생성:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test --project=desktop-chromium \
  tests/e2e/mobile-composer-contract.spec.ts --grep "composer golden"
ls test-results/mobile-composer-contract-M-*/*-{expected,actual,diff}.png
```

## 5. geometry 무변화 자료

`chat-input` subtree의 모든 `[data-testid]` 요소 bounding box를 golden과 같은
fixture(en, 3 models, `webSearchMode: always`, 320/390 × 680, light, 애니메이션
정지)에서 측정해 trunk와 대조했습니다.

| viewport | root box | innerText | 공통 요소 | **이동한 요소** |
|---|---|---|---|---|
| 320 | `304×140`, scroll `302×138` — 동일 | 동일 | 10 | **0** |
| 390 | `374×140`, scroll `372×138` — 동일 | 동일 | 10 | **0** |

측정 대상: `tool-status-chip-row`, `web-search-mode-chip`,
`web-search-exception-toggle`, `composer-textarea-row`, `chat-textarea`,
`composer-active-model-count`, `request-credit-estimate`, `credit-cost-badge`,
`credit-coin-icon`, `chat-send-button`.

feature branch에만 `composer-model-select`(320: `x=96.3 y=89 w=92.7 h=44`,
390: `x=166.3 y=89 w=92.7 h=44`)가 추가로 잡히는데, 이는 **새 요소가 아니라
기존 model selector button에 `data-testid`를 붙였기 때문**입니다. probe가
`[data-testid]`로 열거하므로 attribute를 단 순간 목록에 나타납니다. 렌더 결과가
바뀌지 않았다는 것은 §6이 pixel 단위로 증명합니다.

`mobile-composer-contract.spec.ts`의 비-visual geometry 계약(overlap 0,
textarea width ratio ≥ 0.9, 최소 1줄 line box, 가로 overflow ≤ 1px, 320/360/
390/430px, 한국어 IME, 키보드 표시, 200% text scaling)은 이번 실행에서 전부
통과했습니다.

## 6. clean trunk 대조 결과 — 결정적 증거

`e46389e`(이 작업의 변경 0건)를 checkout → 재빌드 → 동일 명령으로 실행:

```
✘ composer golden at 390px  →  906 pixels (ratio 0.02) are different
✘ composer golden at 320px  →  906 pixels (ratio 0.03) are different
```

즉 **변경 없는 trunk도 같은 2건이 같은 수치로 실패**합니다. 나아가 두 실행이
만들어낸 PNG를 해시로 대조하면:

| viewport | 이미지 | trunk `e46389e` | feature `bf55493` | |
|---|---|---|---|---|
| 320 | expected | `ddaba0cf2cf65d7b` | `ddaba0cf2cf65d7b` | 동일 |
| 320 | actual | `d0c7c497b4a46a62` | `d0c7c497b4a46a62` | **동일** |
| 320 | diff | `b28e100032dc85ae` | `b28e100032dc85ae` | 동일 |
| 390 | expected | `b394db58ffb8ac85` | `b394db58ffb8ac85` | 동일 |
| 390 | actual | `4b6c270447b6ee40` | `4b6c270447b6ee40` | **동일** |
| 390 | diff | `f370e958a556d04a` | `f370e958a556d04a` | 동일 |

(SHA-256 앞 16자)

렌더 결과가 **byte 단위로 같습니다**. 이 diff는 `bf55493`과 인과관계가 없습니다.

### 같은 실행에서 손대지 않은 spec도 광범위 실패

`tests/e2e/chat-state-visual-regression.spec.ts`(이번 작업이 건드리지 않음)를
같은 browser로 실행하면 25 pass / 다수 실패이며, 실패 항목은 en·ko 양쪽에
걸쳐 동일한 glyph-edge signature를 보입니다. 특정 surface의 회귀가 아니라
rasteriser 차이입니다.

## 7. 판정과 다음 단계

- 두 golden: **`Not verified – non-canonical browser`**. Pass로도, 제품 Fail로도
  기록하지 않습니다.
- golden **미갱신**. `docs/qa/canonical-visual-baseline.md` §"A baseline recorded
  off-canonical is a defect, not a baseline"에 따라, 비-canonical 환경에서의
  재기록은 baseline을 오염시킵니다.
- 최종 판정은 canonical `ubuntu-24.04` + lockfile 고정 Playwright/Chromium
  (revision 1234 / 151.0.7922.34)에서 재실행해 확정합니다.
- **canonical 실행에서도 실패한다면 이 환경 결론을 유지하지 않습니다.** 그때는
  실제 제품 변경(`ChatInput.tsx`의 `data-testid` 추가가 유일한 composer 접점)과
  baseline 자체의 적합성을 다시 검토합니다.

## 8. 같은 실행의 나머지 결과 (참고)

| 항목 | 결과 |
|---|---|
| `provider-status` × desktop-chromium / desktop-compact / mobile-chromium | 54 pass / 6 skip / 0 fail |
| 관련 spec 6종 합산 (동일 3 project) | 268 pass / 246 skip / **2 fail (본 문서의 golden 2건)** |
| `node scripts/run-unit-tests.mjs` | 580 pass / 0 fail |
| `npm run security:regression` | 113 checks pass |
| `npm run typecheck` / `eslint . --max-warnings=0` | pass |
| `check:encoding` / `check:accent-tokens` | pass |
| `mobile-safari` | 미실행 — WebKit 2336 binary 부재 (N/V) |
