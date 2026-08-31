# `mem-eval-succ-6` 채택·동결 기록

**상태: 채택됨 · 동결됨 (2026-08-31).**

- 검수자: **@mposition**
- 검수일: **2026-08-31**
- dataset: `mem-eval-succ-6` (`lib/memoryEvalSucc6.ts`)
- 선행: `mem-eval-succ-5`, digest `0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0`
- 검수 시트: `docs/ops/memory-eval-succ6-replacement-review.md`

## 1. 결속된 값

| 항목 | 값 |
| --- | --- |
| dataset digest | `2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63` |
| subtype table digest | `89e10d0d8b16901f2989f655a39786ffd6487fbe6d21272fefe232a00c234e83` |
| manifest digest | `b1904682a2920a6554f533001a2b59cbd2d4cdc06b517aa2b53588c094ce603d` |
| scoring contract | `mem-score-v3.4`, digest `a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd` |
| 동결 commit SHA (40자리) | *(다음 commit에서 기입)* |

dataset digest만으로는 부족합니다. `docs/ops/memory-extraction-eval-dataset.md`
§3.3 하한은 **분류표**가 정하는데, 어떤 case가 subtype 3인지는 case에 대한
판단이지 case의 일부가 아니어서 dataset digest가 덮지 않습니다. 두 행만 다르게
읽어도 cell이 38 아래로 내려가면서 dataset digest는 그대로입니다. 그래서 manifest가
`subtypeTableDigest`를 함께 싣고 manifest digest가 그것을 덮습니다.

## 2. 동결 순서

`SUBTYPE_REVIEW`의 `status`·`reviewer`·`reviewedAt`·`method`가 전부
`subtypeTableDigest` 안에 있으므로 **서명 기록 자체가 digest를 움직입니다.**
초안 값을 먼저 pin 했다면 기록된 digest가 더 이상 존재하지 않는 표를 가리켰을
것입니다. 실행 순서는 서명 → 재계산 → pin이었고, 표본을 건드리지 않았으므로
dataset digest는 유지됐습니다(움직인 것은 subtype과 manifest 둘).

이 순서는 `verifySucc6Manifest()`가 강제합니다 — `FROZEN=true`인데 분류표가
`ai_draft`이거나 검수자·검수일이 비어 있으면 실패합니다.

## 3. 무엇을 채택했나

`mem-eval-succ-5`에서 **13건이 나가고 13건이 들어왔습니다.** 이유가 둘이고 목록을
섞지 않았습니다.

### 3.1 B+ 이동 10건

`.github/audits/memory-boundary-decision-2026-08-30.md` §5.2에 따라, 2026-08-30
경계 규칙을 **형성한** case들입니다. 이력은
`lib/memoryEvalSucc6Regression.ts`에 보존되며 그중 다섯 건은 **수정된 형태**로
(§12.2) 실행 가능한 `regressionCase`를 갖습니다.

### 3.2 cell 하한 보완 3건

`ko-71` → `ko-507`, `ko-311` → `ko-508`, `en-107` → `en-505`. 결함이 아니라
**중복**이 사유이므로 B+ 회귀 corpus에 넣지 않았습니다. 각 cell에서 중복도가 가장
높은 subtype 1·2 case를 골랐습니다.

### 3.3 비어 있지 않은 gold 2건

`ko-501`(`expertise`)과 `ko-504`(`recurring_context`). 둘 다 mixed-critical
예외(`.github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md`)로
`criticalGoldMode: "allow_expected_only"` + exhaustive입니다.

두 건 모두 **처음에는 빈 gold였고**, 근거가 "대체 대상의 gold가 비어 있었으므로"
였습니다. 그 근거는 폐기됐습니다 — **gold는 새 대화의 의미가 정합니다.** 빈 gold는
정답 추출을 critical 위반으로 채점했고, 그것은 모델에 대한 발견이 아니라 표본의
결함입니다.

## 4. §3.3 하한

| cell | subtype 3 | 4 | 합계 | 하한 | succ-5 |
| --- | --- | --- | --- | --- | --- |
| `assistant_only:ko` | 28 | 10 | **38** | 38 | 31 (미달) |
| `assistant_only:en` | 27 | 11 | **38** | 38 | 34 (미달) |

**`mem-eval-succ-5`도 미달이었고 아무도 측정하지 않았습니다.** 부족분은 승계된
것입니다.

**분류를 바꿔 충족시키지 않았습니다.** §3.1 제외 기준 넷을 subtype 3으로 인정하면
각 cell이 42가 되어 즉시 통과하지만, 그것은 임계값에 측정을 맞추는 것이고 한 번
하면 그 측정은 이후 아무 뜻도 갖지 못합니다. 표본 교체(§3.2)로 메웠습니다.

승인된 제외 기준 넷:

1. 추측 놀이 안의 부정 — subtype 1의 응답 구조
2. 처음부터 제3자로 제시된 질문 — 귀속이 바뀐 정정이 아님
3. 처음부터 허구로 선언된 자료 — subtype 2
4. 전문·소문 확인 — 자기 사실의 정정이 아님

## 5. 이 서명이 덮지 않는 것

- **유료 실행.** `decideEvalRunMode()`의 미동결 거절이 사라질 뿐입니다. decision-grade
  실행에는 승인된 eval budget, 등록된 pair, 깨끗한 named commit, 미사용 run
  ordinal이 여전히 각각 필요합니다.
- **pair 등록**과 `PENDING_VERIFIED_PRICE_REGISTER` 관련 승인.
- **`mem-extract-v7`** — 아직 존재하지 않습니다.
- **release gate 상태 전환**과 **feature flag 활성화**
  (`feature.memoryExtractionEnabled`, `feature.memoryInjectionEnabled`는 둘 다
  꺼진 상태 그대로입니다).

## 6. 남는 판정 한계

- 분류표는 사람이 확정했지만 **250건에 대한 읽기**입니다. 여백은 0건이므로 어떤
  행이든 다시 읽어 subtype이 바뀌면 cell이 하한 아래로 내려갑니다. 그때는 이
  기록이 아니라 새 채택 기록이 필요합니다.
- `regressionLeakViolations()`는 `forbiddenValues`에 적힌 문자열만, 정규화된
  포함으로만 검사합니다. 값을 **말하지 않고 함의하는** 문장은 통과하며 여전히
  누출입니다. 그 판정은 사람의 몫이고 blind review 시트가 그 자리입니다.
