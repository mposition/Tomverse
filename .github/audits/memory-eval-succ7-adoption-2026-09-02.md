# mem-eval-succ-7 채택 — 2026-09-02

## 1. 검수 판정 (`@mposition`)

```
검수자: @mposition
검수일: 2026-09-02
same_boundary 통과 건수: 53 / 53
coverage_repair 판정: 같은 경계 해당 없음 / gold 적합
문제 있는 건수: 0
succ-7을 decision set으로 채택하는가: 예
```

## 2. 승인 범위 (축자)

> 54건을 전수 검수했다. `same_boundary` 53건은 모두 동일 경계를 유지하며
> gold가 적합하다. `coverage_repair` 1건은 동일 경계 판정 대상이 아니며, 새
> 대화의 gold는 적합하다. 미해결 mixed-turn 정책은 regression에 보존되고
> whole-turn fail-closed 규칙은 변경되지 않는다. 따라서 `mem-eval-succ-7`을
> decision set으로 채택한다.

**이 승인은 dataset 검수·채택까지입니다.** `mem-extract-v8`, pair·예산·유료
실행, release gate와 production flag는 포함하지 않습니다.

## 3. 검수 이력

초판 검수에서 11건이 지적됐고 전부 타당했습니다.

- **잔여 사실 4건** (`en-601`, `en-608`, `ko-601`, `ko-604`) — gold가 인정하지
  않는 두 번째 지속 사실을 실어 `exhaustive` 계약을 깼습니다. 올바른 추출이
  false positive로 채점될 case였습니다.
- **kind 오류 4건** — `coach`·`secretary`는 현재 역할이므로 `identity`가
  아니고, "훈련받은 적 없다"는 직업 부인이 아니라 expertise 진술입니다.
- **gold 근거 불충분 2건** — `ko-605`는 일반 선호를 확립하지 못했고,
  `ko-609`는 `sensitive_review`의 근거(의학적 제한)가 모호했습니다.
- **`succ-injection-en-601` 1건** — 같은 경계를 시험하지 않음. B안으로
  `coverage_repair` 분류
  (`.github/audits/memory-eval-succ7-coverage-repair-decision-2026-09-02.md`).

10건 수정 후 재검수에서 전부 통과했습니다.

## 4. 채택된 것

| 항목 | 값 |
|---|---|
| datasetVersion | `mem-eval-succ-7` |
| schemaVersion | 3 |
| supersedes | `mem-eval-succ-6` |
| caseCount | 1,150 (inherited 1,096 + replaced 54) |
| datasetDigest | `3eb0d80c7b922933558c5523ee8583ce11a06814439aedf855ee6d7327188de1` |
| manifestDigest | `567c9ed6f50bc1bfb5bbc26bfa0ad6da62080b9804363072fbcc98214a250f6c` |
| sourceDatasetDigest | `2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63` |
| scoringContract | `mem-score-v3.4` / `a62f4bdd…` |
| transitionTypes | same_boundary 53 / coverage_repair 1 |
| unresolvedPolicies | 1 (mixed-turn) |
| **FROZEN** | **true** |

`frozen`은 fingerprint 입력이므로 `true`로 바꾸면서 digest가 움직였고, pin은
그 뒤의 값입니다.

## 5. 동결이 실제로 무엇을 잡는가

`verifySucc7Manifest()`는 **pin된 기록**과 **트리 재계산**을 서로 다른 기본값
두 개로 받습니다. succ-6은 양쪽 모두 builder였고, 그래서 무인자 호출이 트리와
트리를 비교해 트리가 아무리 움직여도 빈 배열을 돌려줬습니다. 그 실수를
반복하지 않기 위한 구조입니다.

실제 파일을 고쳐 확인했습니다.

| 고친 것 | 결과 |
|---|---|
| `succ-durable-en-601`의 user 메시지 본문 | **잡힘** — datasetDigest·manifestDigest 둘 다 이동 |
| gold 토큰 `[kayak]` → `[canoe]` | **잡힘** — 둘 다 이동 |
| 대화 `title` | **안 잡힘** |

`title`이 빠지는 것은 의도된 범위입니다. `datasetFingerprintInputV3()`가 덮는
것은 id·category·language·goldCompleteness·criticalGoldMode·gold 전 필드
(kind·polarity·disposition·factValueAll·factValueAny·anchorId·anchorQuote)·
대화 id·`messageId:role:content`이며, **title은 채점기가 보지 않는 라벨**입니다.
"어떤 편집이든 잡힌다"가 아니라 **채점에 들어가는 것은 전부 잡힌다**가 정확한
서술입니다.

## 6. 이 채택이 바꾸지 않은 것

`HARNESS_TARGET_DATASET_VERSION`은 여전히 `mem-eval-succ-6`입니다. harness
target 이동은 별도 변경이며 이 승인에 포함되지 않았습니다.

`mem-extract-v7`·`mem-extract-v8`, `MEMORY_EXTRACTION_EVAL_REGISTER`의 모든
pair(`gpt-5-6-luna::mem-extract-v7`은 `revoked` 유지), 예산, release gate
registry, `feature.memoryExtractionEnabled`,
`feature.memoryInjectionEnabled` — 전부 그대로입니다.

`FROZEN=true`가 제거하는 것은 `decideEvalRunMode()`의 `dataset_not_frozen`
거절 **하나뿐**입니다. 유료 실행에는 여전히 등록된 pair, 이 dataset의 digest에
결속된 승인 예산, 깨끗한 named commit, 사용하지 않은 run ordinal이 모두
필요하며 넷 다 없습니다.
