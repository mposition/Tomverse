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
| 7. 기존 baseline 대비 diff 측정 | **49 / 74 실패** (예상된 실패, §2.1) |
| 9. `--update-snapshots` 재기록 | **63장 전부 재기록됨** |
| 10. 재기록본 clean run 재검증 | **74 passed (1.9m)** |
| 11. review branch push | **`No golden changed; nothing to push.`** ← 거짓 |

재기록은 정상적으로 이뤄졌는데 **push step이 그것을 보지 못했습니다.**
`git diff --quiet -- '*-snapshots'`의 pathspec은 wildcard가 경로 전체에
매칭되므로 `...-snapshots/foo.png`에는 걸리지 않습니다. 아무것도 매칭하지
않는 pathspec은 "차이 없음"을 보고하고, 그것은 깨끗한 tree와 구별되지
않습니다. 그래서 `visual-baseline/*` branch가 생성되지 않았습니다.

`dcdc5bd`가 이 pathspec을 고쳤고, baseline이 실패한 뒤 tree가 그대로면
성공으로 보고하는 대신 실패하도록 방어까지 넣었습니다.

### 2.1 step 7의 `success`는 통과가 아니었습니다

`continue-on-error: true`가 걸린 step은 실제로 실패해도 API의
`steps[].conclusion`이 `success`로 보고됩니다. 이 값을 통과로 읽은 것이 이
문서 초판의 오독이었습니다. artifact의 **409 files**(golden 63장 + 실패
49건의 actual/diff/screenshot/video/trace/error-context)가 실패를 가리키고
있었습니다.

## 3. 남은 모순 — 같은 SHA, 같은 image, 같은 golden, 다른 결과

`Main Chromium Regression`(`e2e.yml`)을 같은 `da3443c`에 dispatch했습니다.
[runs/30436130482](https://github.com/mposition/Tomverse/actions/runs/30436130482)

| run | workflow | SHA | 결과 |
|---|---|---|---|
| #9 step 7 | Record Visual Baseline (baseline 판정) | `da3443c` | **49 / 74 실패** |
| #9 step 10 | Record Visual Baseline (재기록 후 재검증) | `da3443c` | 74 passed |
| #39 | Main Chromium Regression | `da3443c` | **failure** |

step 10이 통과한 것은 그 시점에 disk의 이미지가 **이미 재기록된 새 golden**
이었기 때문입니다. 커밋된 golden을 판정한 것은 step 7이고, 그 결과는 #39와
같습니다. 두 workflow는 **일치합니다** — 커밋된 63장이 canonical 환경의
렌더링과 다릅니다.

#39의 실패 예: `chat-deep-research-complete-desktop-light-ko` — 시도 3회 모두
`14539 pixels (ratio 0.02)`로 픽셀 수까지 동일합니다.

이 문서 초판은 여기서 "같은 SHA에서 두 canonical workflow가 반대 결과를
낸다"는 모순을 제기하고 원인 후보로 `e2e.yml`의 cache restore를 지목했습니다.
**그 전제가 틀렸습니다.** step 7의 `continue-on-error` 결과를 통과로 읽었고,
push step의 "No golden changed"를 재기록 결과가 동일하다는 뜻으로 읽었기
때문입니다. 둘 다 아니었습니다.

## 4. 로컬 재현은 근거가 되지 못합니다

이 container에서 cold(서버 신규 기동) / warm 각각 1회씩 돌려 양쪽 다 74/74
통과했지만, 이 container는 `cdn.playwright.dev`에 접근하지 못해
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 사전 설치 Chromium을 씁니다.
`docs/qa/canonical-visual-baseline.md`와 `playwright.config.ts`의 주석이
명시한 대로 **그런 run은 canonical이 아니며 golden 판정 근거가 될 수
없습니다.** 커밋된 golden이 바로 그런 환경에서 기록된 것이고(`cc34def`),
그래서 그 환경에서만 통과합니다. 로컬 통과는 오히려 이 진단과 일치합니다.

## 5. 판정

- 지시받은 재기록은 **canonical runner에서 실행됐고 63장 전부 재기록됐지만,
  push step의 pathspec 결함으로 산출물이 유실**됐습니다. `dcdc5bd`가 그
  결함을 고쳤습니다.
- canonical visual gate는 여전히 **PASS가 아닙니다.** 커밋된 golden이
  canonical 렌더링과 다르다는 것이 확인됐을 뿐, 교체가 완료되지 않았습니다.
- golden을 로컬에서 다시 쓰지 않았습니다. 정책상 재기록은 recorder workflow
  에서만 가능합니다.

## 6. 다음 단계

1. `dcdc5bd`가 포함된 `develop`에 `Record Visual Baseline`을 다시 dispatch
2. 이번에는 `visual-baseline/<run id>` branch가 생성되는지 확인 — pathspec
   결함이 고쳐졌으므로 63장이 실제로 push돼야 합니다
3. artifact의 diff를 검토한 뒤 그 branch를 `develop`에 정식 merge
4. `Main Chromium Regression`을 다시 돌려 49건이 사라지는지 확인
