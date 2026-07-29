# Golden 63건 재기록 — canonical runner 실행 결과와 미해결 모순

> 2026-07-29 · 대상 SHA `da3443c` (`origin/develop`)
> 지시: "PR #136 병합 후 canonical runner에서 golden 63개 재기록 완료"

---

## 1. PR #136은 병합되지 않았습니다

| 항목 | 값 |
|---|---|
| state | `closed` |
| merged | **`false`** |
| closed_at | 2026-07-29T07:52:06Z |

Auto PR to Develop workflow가 `main`에서 갈라진 branch로 잘못 연 PR이라
닫혔습니다. 실제 목적지는 **PR #137이 `main`에 병합**된 것이고, 그때
`.github/workflows/visual-baseline-record.yml`(`Record Visual Baseline`,
workflow id 322687170)이 등록되면서 dispatch가 가능해졌습니다.

## 2. 재기록 실행 — 기록할 것이 없었습니다

`Record Visual Baseline` run #9 · `develop@da3443c` · ubuntu-24.04 ·
번들 Chromium · [runs/30435110860](https://github.com/mposition/Tomverse/actions/runs/30435110860)

| 단계 | 결과 |
|---|---|
| 7. 기존 baseline 대비 diff 측정 | `continue-on-error: true` — **판정 불가** (§2.1) |
| 9. `--update-snapshots` 재기록 | 실행됨 |
| 10. 재기록본 clean run 재검증 | **74 passed (1.9m)** |
| 11. review branch push | **`No golden changed; nothing to push.`** |

`visual-baseline/*` branch는 생성되지 않았습니다. 재기록이 만든 이미지가
커밋된 golden과 byte 단위로 같았기 때문입니다. 증거는 artifact
`visual-baseline-30435110860`(409 files / 87.5MB / 2026-08-12 만료)입니다.

### 2.1 step 7의 `success`는 통과가 아닙니다

`continue-on-error: true`가 걸린 step은 실제로 실패해도 API의
`steps[].conclusion`이 `success`로 보고됩니다. workflow 주석 자체가 이 step은
"실패하는 것이 정상"이라고 적고 있습니다. artifact의 **409 files**는 golden
63장 + 실패 49건의 증거물(actual/diff/screenshot/video/trace/error-context)
수와 맞아떨어지므로, step 7은 실패했을 가능성이 높습니다 — 다만 로그로
확정하지 못했으므로 **판정 불가**로 둡니다.

## 3. 남은 모순 — 같은 SHA, 같은 image, 같은 golden, 다른 결과

`Main Chromium Regression`(`e2e.yml`)을 같은 `da3443c`에 dispatch했습니다.
[runs/30436130482](https://github.com/mposition/Tomverse/actions/runs/30436130482)

| run | workflow | SHA | 결과 |
|---|---|---|---|
| #9 step 10 | Record Visual Baseline | `da3443c` | **74 passed** |
| #39 | Main Chromium Regression | `da3443c` | **failure** |

#39의 실패 예: `chat-deep-research-complete-desktop-light-ko` — 시도 3회 모두
`14539 pixels (ratio 0.02)`로 **픽셀 수까지 동일**합니다. 그 job 안에서는
결정적입니다. 그런데 recorder run #9의 step 10은 08:31:53에 같은 golden을
통과시켰습니다.

golden 파일은 `20fb3ec`부터 `da3443c`까지 한 번도 바뀌지 않았습니다
(`git diff 20fb3ec..origin/develop -- '*-snapshots'` = 비어 있음). 따라서 이
차이는 **제품 코드도 baseline도 아니고 workflow에서 옵니다.**

두 workflow의 차이는 셋입니다.

1. `e2e.yml`에만 있는 `Restore Next.js build cache`, `Restore Playwright
   Chromium cache` 두 step (recorder는 매번 fresh install)
2. `e2e.yml`은 3개 project 전체 suite, recorder는 `desktop-chromium` 단일 spec
3. `e2e.yml`은 `retries: 2`(config), recorder는 `--retries=0`

`workers: 1` / `fullyParallel: false`이므로 (2)의 병렬 부하 가설은 성립하지
않습니다. (3)은 #39가 3회 모두 같은 픽셀 수로 실패했으므로 무관합니다.
**남는 후보는 (1)의 cache restore**이며, 특히 `~/.cache/ms-playwright` 복원이
fresh install과 다른 browser 산출물을 주는지가 핵심입니다.

## 4. 로컬 재현은 근거가 되지 못합니다

이 container에서 cold(서버 신규 기동) / warm 각각 1회씩 돌려 **양쪽 다
74/74 통과**했습니다. 그러나 이 container는 `cdn.playwright.dev`에 접근하지
못해 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 사전 설치 Chromium을 씁니다.
`docs/qa/canonical-visual-baseline.md`와 `playwright.config.ts`의 주석이
명시한 대로 **그런 run은 canonical이 아니며 golden 판정 근거가 될 수
없습니다.** 위 결과는 "로컬에서는 실패가 재현되지 않는다"는 사실 이상을
주장하지 않습니다.

## 5. 판정

- 지시받은 재기록은 **canonical runner에서 실행 완료**했고, 결과는
  **"기록할 변경 없음"**입니다.
- 그러나 canonical visual gate는 **PASS가 아닙니다.** 같은 SHA에서 두
  canonical workflow가 반대 결과를 내고, 어느 쪽이 이 환경을 대표하는지
  아직 모릅니다.
- golden을 지금 다시 쓰는 것은 **하지 않았습니다.** recorder가 바꿀 것이
  없다고 답한 이상, 재기록은 이 모순을 해소하지 못하고 덮을 뿐입니다.

## 6. 이 모순을 가르는 실험

`e2e.yml`의 두 cache restore step을 뺀 사본을 branch에 두고 같은 `da3443c`에
dispatch합니다(workflow_dispatch는 지정한 ref의 workflow 파일을 씁니다).

- 통과하면 → 원인은 cache restore이고, `e2e.yml`의 #35·#36·#39 판정은
  canonical 렌더링을 대표하지 않았습니다. golden은 정상입니다.
- 그대로 실패하면 → 원인은 recorder와 `e2e.yml`의 실행 형태 차이로 좁혀지고,
  다음은 recorder에서 전체 suite를 돌려 재확인합니다.

어느 쪽이든 이 실험 전에는 golden을 다시 쓰지 않습니다.
