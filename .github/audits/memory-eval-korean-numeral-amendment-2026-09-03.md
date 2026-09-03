# 채점 계약 개정 — 한국어 숫자 정규화의 단어 경계 (`mem-score-v3.5`)

**상태: 계약 개정은 @mposition의 2026-09-03 지시에 따라 적용됨. 후속 dataset
`mem-eval-succ-8`의 동결 서명은 §7 — 아직 없습니다.**

이 문서에 적힌 "승인"은 **개정 방향에 대한 지시**입니다. gold를 고칠지 채점기를
고칠지, 그리고 그 결과를 새 계약 버전과 contract-only successor로 담을지는
@mposition이 정했습니다. `mem-eval-succ-8`의 digest에 대한 **서명은 별개
행위이고 아직 이뤄지지 않았습니다.**

- 대상: `lib/memoryEvalCanonicalisation.ts`의 `KOREAN_NUMERAL_RE`
- 계약 버전: `mem-score-v3.4` → **`mem-score-v3.5`**
- 표본 변경: **없음.** 이 개정은 채점 계약만 바꿉니다.

## 1. 무엇이 잘못돼 있었나

한국어 숫자 정규화는 **뒤에 단위가 올 때만** 숫자를 치환한다고 문서에 적혀
있었고, 그것이 `세`(셋 / 세상·세계)나 `이`(2 / 주격 조사)를 아무 데서나 바꾸지
않게 하는 장치였습니다. 그런데 **왼쪽 조건이 없었습니다.** 숫자로 읽히는 음절이
다른 단어의 **끝**에 있어도 규칙이 걸렸습니다.

```
토요일 일정   ->   토요1일정
```

`토요일`의 `일`이 숫자 1로, `일정`의 `일`이 날짜 단위로 읽혀 `1일`이 됐습니다.
그 결과 토큰 `격주토요일`은 그렇게 표현한 어떤 후보에도 존재하지 않게 됩니다.

같은 결함이 숫자 자체에도 있었습니다 — `이십일`(21)은 `십`이 `이` 뒤에 있으므로
`10일`로 치환돼 **`이10일`**이 됐습니다.

## 2. 어떻게 발견됐나

harness target을 `mem-eval-succ-7`로 옮기는 작업에서, smoke run이 자기 stub도
맞히지 못하는 gold를 하나 보고했습니다. stub은 모든 gold를 정답으로 돌려주므로
smoke는 1.000이어야 하고 succ-6에서는 476/476이었는데, succ-7에서는 **484/485**
였습니다.

빠진 하나가 `succ-durable-ko-611`이고, gold 토큰이 `["격주토요일", "일정"]`
입니다. stub이 만드는 문장뿐 아니라 **그럴듯한 모델 표현 다섯 중 셋**이 같은
치환에 걸립니다.

| 표현 | v3.4 | v3.5 |
| --- | --- | --- |
| `격주토요일 일정을 잡을 수 없다` | 토큰 소실 | ok |
| `격주 토요일 일정 불가` | 토큰 소실 | ok |
| `사용자는 격주토요일 일정이 불가능하다` | 토큰 소실 | ok |
| `사용자는 격주토요일에는 일정을 잡을 수 없다` | ok | ok |
| `격주토요일에 일정을 잡지 못한다` | ok | ok |

## 3. 왜 gold가 아니라 채점기를 고쳤나

`["격주", "일정"]`이나 `["격주", "토요"]`로 토큰을 줄이면 다섯 표현 모두
통과합니다. 그러나 **정답지를 버그에 적응시키는 일**입니다.

- `["격주", "일정"]`은 **토요일이라는 핵심 조건을 잃습니다.**
- `["격주", "토요"]`는 의미를 더 보존하지만 정규화 결함을 **우회할 뿐**입니다.

그리고 succ-7은 이미 동결·서명됐습니다. dataset digest가 움직이는 편집을 같은
`datasetVersion`에 재서명하는 것은 docs/ops/memory-extraction-eval-dataset.md
§7.3 원칙과 맞지 않습니다.

## 4. 개정 내용

숫자 앞에 음절이 오면 매치하지 않습니다.

```
(?<![가-힣])(numeral)\s*(counter)
```

문서화된 의도를 그대로 적은 것입니다 — **숫자는 단어이지 음절이 아닙니다.**
데이터셋이 쓰는 정상 형태는 하나도 바뀌지 않습니다: `육 개월`, `육개월`,
`새벽 세 시`, `여섯 개`, `삼 일`, `매주 두 번`, `총 세 개` 전부 그대로입니다.

`CANON_STEP_ORDER`의 단계 이름도 `numeral_words_to_digits` →
`numeral_words_at_word_start_to_digits`로 바꿨습니다. 이름이 곧 변경 내용입니다.

## 5. 계약 digest와 후속 dataset

`canon`은 채점 계약의 일부이므로 이 변경은 **digest를 움직입니다.** 그래서:

- 계약 버전을 `mem-score-v3.5`로 올리고 `v3-canonicalisation` 규칙 문장에 단어
  경계 조건을 적었습니다. 규칙 문장은 digest에 그대로 들어가므로, 규칙을 말없이
  바꿀 수 없습니다.
- succ-7의 **표본 1,150건을 참조로 그대로 상속하는** contract-only successor
  `mem-eval-succ-8`을 만들고, harness는 그쪽으로 옮깁니다. succ-7의 표본·서명·
  digest는 보존되며 B+ case 이동도 새로 필요하지 않습니다. 바뀌는 것은 **채점
  계약과 successor manifest뿐**입니다.

succ-5·succ-6·succ-7은 이제 **자기가 동결된 계약을 기록으로 들고** 있습니다
(`MEMORY_EVAL_SUCC*_SCORING_CONTRACT`). 계약 bump가 이들의 pinned manifest
digest를 움직이지 않게 하기 위해서이고, 세 dataset 모두 binding 검사에서
"superseded contract" 한 건씩을 보고합니다 — **읽을 수는 있고 실행 대상은
아니라는 뜻**이며 그것이 맞는 상태입니다.

## 6. 회귀

`tests/memoryEvalCanonicalisation.test.mjs`가 고정합니다.

- 위 다섯 표현 전부에서 `격주토요일`과 `일정`이 살아남는다
- `이십일`이 `이10일`이 되지 않는다
- 기존 숫자·단위 정규화가 전부 유지된다(정상 형태 목록을 그대로 단언)
- 단어 끝의 숫자 음절은 치환되지 않는다(`생일`, `일요일`, `토요일` 단독)

## 7. 아직 없는 것 — succ-8의 동결 서명

`mem-eval-succ-8`은 `MEMORY_EVAL_SUCC8_DATASET_FROZEN = false`,
`MEMORY_EVAL_SUCC8_APPROVAL.approvedBy = null` 상태입니다. 표본이 succ-7의
것이므로 case 재검토는 필요 없지만, **동결은 사람의 서명**이고 서명 대상은
succ-8이 자기 이름으로 갖는 두 값입니다.

```
datasetDigest    9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251
manifestDigest   35749cf36c1268bd4592a4b7f3d97b65163dc0a05900643c5f8b1ae363dd14e9
```

`datasetDigest`는 succ-7과 같습니다 — 그것이 contract-only successor라는
주장이며, `succ8Problems()`가 같지 않으면 실패합니다. `manifestDigest`는
달라야 하고, 그 차이는 계약 하나뿐입니다.

서명이 없는 동안 `decideEvalRunMode()`는 succ-8에 대한 유료 실행을
`dataset_not_frozen`으로 거절합니다. smoke run은 영향을 받지 않으며
485/485입니다.
