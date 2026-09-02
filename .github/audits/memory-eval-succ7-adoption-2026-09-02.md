# `mem-eval-succ-7` 채택·동결 기록

**상태: 채택됨 · 동결됨 (2026-09-02).**

- 검수자: **@mposition**
- 검수일: **2026-09-02**
- dataset: `mem-eval-succ-7` (`lib/memoryEvalSucc7.ts`)
- 선행: `mem-eval-succ-6`, digest `2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63`
- 검수 시트: `npm run make:memory-eval-succ7-review-sheet` (생성물, 저장소에 두지 않음)
- 검수 대상 commit: `e522796dd11e3d009d23a13836b7a45b005f3bc8`

## 1. 결속된 값

| 항목 | 값 |
| --- | --- |
| dataset digest | `9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251` |
| manifest digest | `42c9b0a877086dc4767613e6b357d85ccba7ef40a67f7ff02d7d64b0ced91965` |
| source dataset digest (succ-6) | `2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63` |
| scoring contract | `mem-score-v3.4`, digest `a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd` |
| fingerprint | v4 (대화 `title` 포함) |
| 동결 commit SHA (40자리) | `79ffe61687e61d31a74b1800fc9361d6b7cf1da4` |

SHA는 동결 commit 자신을 가리키므로 그 commit 안에 담을 수 없습니다. succ-6과 같은
순서로, 바로 다음 commit이 기입합니다. 그 사이에 dataset·manifest digest는 움직이지
않으므로 위 두 값이 SHA와 무관하게 대조 가능합니다.

## 2. 동결 순서 — succ-6과 다른 점

succ-6은 `SUBTYPE_REVIEW`의 서명 값이 `subtypeTableDigest` 안에 있었기 때문에
**서명 자체가 digest를 움직였고**, 그래서 서명 → 재계산 → pin 순서가 강제됐습니다.

succ-7의 manifest에는 subtype table digest가 없고 `frozen`도 fingerprint 밖에
있으므로, **검수자가 본 digest가 그대로 동결된 digest입니다.** 서명 전후로
`42c9b0a8…`가 움직이지 않았고, `tests/memoryEvalSucc7Adoption.test.mjs`의
"freezing did not move the digest that was signed"가 이를 고정합니다.

실행 순서는 셋을 각각 별도 commit으로:

1. 서명 기록 (`MEMORY_EVAL_SUCC7_REVIEW`) — `reviewed`가 문자열이 아니라 트리와
   대조 가능한 기록이 됨
2. `MEMORY_EVAL_SUCC7_DATASET_FROZEN = true`
3. manifest literal pin + `verifySucc7Manifest()`

## 3. 무엇을 채택했나

`mem-eval-succ-6`에서 **54건이 나가고 54건이 들어왔습니다.** 근거가 둘이고 목록을
섞지 않았습니다(`lib/memoryEvalSucc7Transition.ts`).

- **`approved10` 10건** — 승인된 gold 수정을 가진 케이스. 원본은
  `lib/memoryEvalSucc7Regression.ts`에 **수정된 형태로** 보존됩니다(§12.2).
- **`polarity44` 44건** — `mem-extract-v8` 문안이 **선택된** 근거가 된 케이스.
  §12.1의 B+ 대상이며, 원본은 gold를 손대지 않은 채 보존됩니다.

전환 유형은 `same_boundary` 53건, `coverage_repair` 1건이고 **합산하지 않습니다.**
coverage repair(`succ-injection-en-301` → `succ-injection-en-601`)는 미해결 정책
질문을 함께 싣고 있으며, 그 질문은 manifest digest에 결속돼 있어 조용히 해소될 수
없습니다.

## 4. 판정

| 항목 | 판정 |
| --- | --- |
| `same_boundary` | 53 / 53 통과 |
| `coverage_repair` 1건 | 같은 경계 판정 해당 없음 · gold 적합 |
| gold 적합 | 54 / 54 |
| 문제 있는 건수 | 0 |
| cell 다양성 | 모든 cell 충분 |
| 채택 | **예** |

## 5. 두 차례의 반려와 무엇이 바뀌었나

이 기록이 남기는 것은 통과한 사실만이 아닙니다. 서명 전에 **두 번 반려**됐고,
반려 사유가 이 dataset이 무엇을 재는지를 정했습니다.

### 5.1 1차 반려 — 13건 + 묶음

- **6건**(`en-602`, `en-610`, `ko-607`, `ko-614`, `ko-619`, `ko-620`)이 "이 분야는
  아니 설명 생략"과 "다만 이 용어는 설명하라"를 한 케이스에 담고 두 번째 절을
  `explanation_depth`/negated로 라벨했습니다. 설명 요구는 **긍정** depth이므로
  부호가 틀렸고, `exhaustive` 두 gold 아래에 유효 memory가 셋 있었습니다.
  §4.1.2에 따라 라벨이 아니라 케이스를 고쳤습니다.
- **2건**(`assistant-en-607`, `assistant-ko-606`)에 원본에 없던 긍정 설명 요청이
  붙어 있었고, 제거했습니다.
- **`assistant-en-603`** — 원본의 경계는 "assistant가 **초안으로 쓴 문장** 안의
  1인칭을 사용자가 부인하되 문장은 남긴다"였는데 단순 추측 정정으로 바뀌어 있었습니다.
- **gold 결속 4건** — `en-612`는 목발이 아니라 계단에, `ko-615`는 "한도"가 아니라
  실제 금액에, `ko-617`은 흡입기가 아니라 먼지에(천식은 대화에 남고 토큰에서 빠짐,
  `ko-428`이 편두통을 다룬 방식), `en-618`은 부사 "bluntly"가 아니라 승인된 교정
  gold의 핵심에 결속했습니다.
- **묶음** — decision 12건이 전부 같은 문장 틀이었고 durable 38건이 전부 2턴이었습니다.

### 5.2 2차 반려 — 3건 + title + 다양성

- **`en-603`** 지난달 모집 한 건을 흘려보낸 **사건**이었고, `en-155`가 시험한
  지속적 결정이 아니었습니다.
- **`en-614`** "wetsuit을 사지 않겠다"는 `constraint` 라벨을 단 `decision`이었습니다.
  `en-433`이 시험한 것은 **습득하지 못한 기능**이므로 그 종류로 재작성했습니다.
- **`en-617`** 개인 시력 문제로 쓰여 있어 접근성 사실이 되었고, `formatting` gold
  하나로는 `exhaustive`가 성립하지 않았습니다. `en-441`의 이유(붙여넣기 시 사라짐)로
  되돌렸습니다.
- **검수 시트가 새 대화의 `title`을 출력하지 않았습니다.** title은
  `renderConversation()`이 `## <label>: <title>`로 프롬프트에 넣는 **모델 입력**이고,
  fingerprint v4가 존재하는 이유가 v3의 title 누락입니다. 보여 주지 않은 것에 서명을
  요구하는 셈이었습니다.
- **다양성** — 4턴이 없었고, 카약·해먹·우표수집·우쿨렐레 등 **7건**이 en/ko 직역
  대응이라 ko 20건이 en 20건의 두 번째 측정이 되고 있었습니다.

### 5.3 최종 형태

각 durable 언어 cell이 세 가지 대화 형태를 갖습니다 — en 2턴 10 / 3턴 6 / 4턴 2,
ko 2턴 12 / 3턴 6 / 4턴 2. 4턴에서는 assistant의 제안 뒤에 사실이 도착하며, 제안은
사용자에 대해 아무것도 단정하지 않고 나머지 turn은 단순 확인입니다 — `exhaustive`
케이스가 gold가 인정하지 않는 후보를 얻지 않기 위해서입니다. ko cell의 직역 대응
7건은 고유 소재로 교체됐습니다.

## 6. 다중 대화를 넣지 않은 이유

2차 검토에서 다중 대화 부재가 지적됐고, **이번 채택 조건에서 제외**하기로 정리됐습니다.

succ-6의 1150건 중 대화가 2개 이상인 케이스는 **0건**입니다. 넣으면 (a) 그 케이스만
프롬프트에서 `## <label>: <title>` 블록을 두 번 갖는 경로를 타고, (b) 단일 대화
원본과 같은 경계라고 말할 수 없어져 `SUCC7_TRANSITION`의 `same_boundary` 53 선언과
충돌합니다. 다양성 보완을 넘어 **교차 대화 귀속**이라는 새 측정 축이 되므로, 필요하면
별도 결정으로 다룹니다.

## 7. 이 서명이 덮지 않는 것

동결은 `decideEvalRunMode()`가 **미동결 decision sample에 대해 거는 거절**을 없앨
뿐입니다. 다음은 각각 별개의 사람 결정이며 **이 서명에 포함되지 않습니다.**

- `HARNESS_TARGET_DATASET_VERSION` 이동 — 여전히 `mem-eval-succ-6`입니다.
  `harnessTarget()`은 등록되지 않은 version에 대해 예외를 던지므로,
  `lib/memoryEvalDatasetManifests.ts`·`lib/memoryEvalHarnessTarget.ts` 등록은 이동과
  같은 결정에 속합니다.
- `mem-extract-v8` 구현, 새 pair 등록·승인, 예산, 유료 실행
- release gate 상태 전환, `memoryExtractionEnabled`·`memoryInjectionEnabled` 등
  feature flag

## 8. 무엇이 이 기록을 무효로 만드는가

`succ7SignatureProblems()`와 `verifySucc7Manifest()`가 다음을 실패로 만듭니다.

- 54건 중 하나라도 편집돼 dataset digest가 움직이는 경우
- manifest의 어느 필드든 움직여 manifest digest가 달라지는 경우
- succ-6이 움직여 source digest가 달라지는 경우
- `frozen`이 기록과 모듈에서 어긋나는 경우 (fingerprint 밖이라 digest 비교가 못 잡음)
- 판정 수치가 약화되는 경우 (53/53, 0건, 모든 cell 충분)

이 중 하나라도 발생하면 **새 채택 기록 없이는 고치지 않습니다.**
