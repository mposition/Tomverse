# `mem-eval-succ-7` 채택·동결 기록

**상태: 채택됨 · 동결됨 (2026-09-03, 2차 서명).**

> **1차 서명(2026-09-02)은 무효화됐고, 2차 서명(2026-09-03)으로 채택됐습니다.**
> 아래 §1은 **2차 서명이 결속한 값**입니다. 무효화 경위는 §9에 있습니다.
>
> 1차 서명 이야기: `@mposition`이 2026-09-02에 54개 케이스를
> 읽고 서명했고 dataset은 그 서명으로 동결됐습니다. 이어진 동결 장치 검토에서
> manifest가 **원본↔대체본 대응을 덮지 않는다**는 것이 확인돼 `transitionDigest`를
> 추가했고, 그 결과 manifest digest가 `42c9b0a8…` → `ecfb84a4…`로 이동했습니다.
> **서명은 version 번호가 아니라 digest에 대한 것이므로** 이 서명은 새 manifest를
> 덮지 못했습니다. 1차 서명은 삭제하지 않고
> `MEMORY_EVAL_SUCC7_SUPERSEDED_REVIEWS`에 사유와 함께 보존합니다.
>
> **표본은 움직이지 않았습니다** — dataset digest `9326730a…`는 1차 검수자가 읽은
> 그 값이고 54개 케이스도 그대로입니다. 그래서 2차 서명은 54건을 다시 읽는 일이
> 아니라 **manifest를 다시 읽는 일**이었습니다.

- 검수자: **@mposition**
- 검수일: **2026-09-03** (2차 서명). 1차 서명일은 2026-09-02.
- 검수 대상 commit: **`3ce908f29620d95d0be1bfa25079dd84735126ee`**
- dataset: `mem-eval-succ-7` (`lib/memoryEvalSucc7.ts`)
- 선행: `mem-eval-succ-6`, digest `2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63`
- 검수 시트: `npm run make:memory-eval-succ7-review-sheet` (생성물, 저장소에 두지 않음)
- 1차 검수 대상 commit: `e522796dd11e3d009d23a13836b7a45b005f3bc8` *(무효화됨, §9)*

## 1. 결속된 값

| 항목 | 값 |
| --- | --- |
| dataset digest | `9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251` |
| manifest digest | `42c9b0a877086dc4767613e6b357d85ccba7ef40a67f7ff02d7d64b0ced91965` |
| source dataset digest (succ-6) | `2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63` |
| scoring contract | `mem-score-v3.4`, digest `a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd` |
| fingerprint | v4 (대화 `title` 포함) |
| manifest digest | `ecfb84a40d1df50d2df59402711473c37dfe1c59310bfc1d7b69ccfdc9e40902` |
| transition digest | `36a18e179bb1e5b2e0de79872f7f458696abac0ed1f3ddb3ed14fae7c9241bb1` |
| 1차 동결 commit SHA (40자리) | `79ffe61687e61d31a74b1800fc9361d6b7cf1da4` *(무효화됨, §9)* |
| 2차 동결 commit SHA (40자리) | *(다음 commit이 기입)* |

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

## 9. 1차 서명이 무효화된 이유 (2026-09-02)

서명 직후 동결 장치 자체를 검토한 결과 **차단 결함 3건**이 재현됐습니다. 셋 다
"검사가 통과했다"와 "검사가 무언가를 확인했다"의 차이에 관한 것입니다.

### 9.1 pinned manifest가 자기 자신과 대조되지 않았습니다

`verifySucc7Manifest()`는 기록된 `manifestDigest` **문자열**을 트리의 문자열과만
비교했습니다. 그래서 pinned record의 `caseCount`를 999로, 53/1 집계를 1/53으로,
contract version과 unresolved 질문을 바꿔도 digest를 그대로 두면 `verify=[]`,
전체 검사 `EXIT=0`이었습니다. 감사 문서 §8의 "manifest의 어느 필드든 움직이면
실패"는 그 시점에 **사실이 아니었습니다.**

지금은 기록의 나머지 필드에서 `manifestFingerprintInput()`을 다시 계산해 기록된
digest와 대조합니다. 회귀 테스트 4건이 네 가지 변조를 각각 실패로 고정합니다.

### 9.2 53개 대응 관계가 서명 밖에 있었습니다

manifest는 몇 건이 어떤 유형으로 움직였는지(53과 1)는 담았지만 **어느 대체본이
어느 원본을 대신하는지**는 담지 않았습니다. 같은 cell의 두 행이 원본을 맞바꿔도
케이스 집합·cell 수·유형 집계·dataset digest가 전부 그대로이고, 검수자가 53번
답한 "이 대체본이 이 원본과 같은 경계인가"만 다른 곳을 가리키게 됩니다.

실제로 `succ-durable-en-103 → en-601`과 `succ-durable-en-11 → en-602`를 맞바꾼
상태에서 모든 검증이 빈 배열이었습니다.

`SUCC7_TRANSITION_DIGEST`가 전 행의 `retired`·`replacement`·`basis`·
`transitionType`·`unresolvedPolicy`를 덮고, manifest가 그 값을 싣습니다.
`retired` 기준으로 정렬해 계산하므로 배열 순서 변경은 digest를 움직이지 않고
대응 변경만 움직입니다.

**이 추가가 manifest digest를 이동시켰고, 그래서 1차 서명이 무효화됐습니다.**

### 9.3 재생성된 시트가 stale signature를 "채택됨"으로 출력했습니다

`make-memory-eval-succ7-review-sheet.mjs`는 `MEMORY_EVAL_SUCC7_REVIEWED` boolean
하나만 읽었습니다. 서명 후 케이스 title을 바꾸자 두 검증 함수는 drift를 올바르게
보고했는데, 생성기는 정상 종료하며 `reviewed=true`·`frozen=true`·"@mposition이
서명해 채택됐습니다"와 **바뀐 digest**를 함께 출력했습니다. 나중에 이 문서를 믿을
독자에게는 시트가 없는 것보다 나쁩니다.

지금은 생성 전에 `succ7SignatureProblems()`와 `verifySucc7Manifest()`를 호출하고,
drift가 있으면 사유를 적고 비정상 종료하며 파일을 쓰지 않습니다. **명령 수준
테스트**가 격리된 sandbox에서 실제로 그 명령을 두 번 실행합니다 — 정상 상태에서
성공하는 것을 먼저 보이고, 서명이 트리를 덮지 않는 상태에서 exit≠0·stderr·파일
부재를 확인합니다.

### 9.4 함께 고친 보통 심각도 2건

- `reviewedCommit`과 `record`가 빈 문자열이어도 통과했습니다. 이제 40자리 SHA
  형식과 `.github/audits/*.md` 경로를 검사하고, 검사 script가 **기록 파일의 존재**와
  **검수 commit이 HEAD의 조상인지**를 확인합니다. 얕은 checkout에서 commit을 모를
  때는 실패가 아니라 "여기서는 검증 불가"로 보고합니다 — 결함이 아닌 이유로 빨간
  검사는 곧 읽히지 않게 되기 때문입니다.
- `lib/memoryEvalSucc7.ts` 상단에 "adopted and frozen"과 "Not adopted, no manifest
  literal, frozen=false"가 동시에 남아 있었습니다.

### 9.5 재서명 시 무엇이 달라지는가

새 서명은 `signedTransitionDigest`를 **반드시** 포함해야 합니다 —
`succ7SignatureProblems()`가 그 필드가 없는 서명을 거절합니다. 1차 서명에 그 값이
없는 것이 이 무효화의 내용 그 자체입니다.

### 9.6 검토 3회차에서 나온 차단 2건 (2026-09-02)

위 수정 자체를 다시 검토해 두 건이 더 나왔습니다. 둘 다 digest를 움직이지
않습니다.

- **Windows에서 신규 회귀 테스트가 깨졌습니다.** sandbox가 `node_modules`를
  기본 디렉터리 symlink로 만드는데, 이 저장소의 개발 환경인 Windows에서는 권한이
  없어 `EPERM`으로 실패합니다. Linux CI는 내내 green이었고 **개발 환경에서만 unit
  gate 전체가 깨졌습니다.** `process.platform === "win32"`이면 `junction`을 씁니다.
- **검수 commit 조상 검사가 CI에서 fail-open이었습니다.** commit 객체가 없으면
  실패가 아니라 `OK ... not verifiable here`를 냈는데, 이 검사가 도는
  `static-and-unit`의 checkout에는 `fetch-depth`가 없어 depth 1입니다. 즉 **검사가
  실제로 도는 유일한 환경에서 "확인 불가지만 OK"가 정상 경로**였고, 40자리이기만
  하면 존재하지 않는 SHA도 서명 commit으로 통과했습니다. 이제 commit을 확인할 수
  없으면 **실패**하고, workflow의 해당 checkout에 `fetch-depth: 0`을 넣었습니다.
  git 저장소가 아닌 sandbox에서 검사를 실제로 실행해 실패하는 것을 테스트가
  고정합니다.

앞서 §9.4에서 "결함이 아닌 이유로 빨간 검사는 읽히지 않게 된다"를 근거로 완화를
택했는데, 그 논리가 통하려면 **완화된 경로가 예외여야** 합니다. 여기서는 그것이
유일한 경로였으므로 근거가 성립하지 않았습니다.

### 9.7 재서명 (2026-09-03, 완료)

표본을 다시 읽을 필요는 없었습니다. dataset digest와 source digest는 1차 서명 값
그대로이고, `tests/memoryEvalSucc7Adoption.test.mjs`가 그 사실을 고정합니다.

2차 서명은 `3ce908f29620d95d0be1bfa25079dd84735126ee`에 한정해 주어졌습니다. 그
commit은 #1252가 develop에 병합된 뒤의 develop이며, 그 시점에 시트를 생성하고
검사를 돌려 네 digest를 확인했습니다. **서명 대상은 움직이는 `develop`이라는
이름이 아니라 그 40자리 SHA와 digest 네 개입니다** — 이후 commit이 쌓여도 서명이
가리키는 곳은 바뀌지 않고, `succ7SignatureProblems()`가 `reviewedCommit`을 HEAD의
조상으로 요구합니다.

1차 서명은 `MEMORY_EVAL_SUCC7_SUPERSEDED_REVIEWS`에 보존됩니다. 삭제하면 저장소가
**왜 지금 서명이 두 번째인지** 말할 수 없게 됩니다.
`succ7SupersededReviewProblems()`가 각 항목이 실제로 낡았는지 — 서명한 digest 중
하나 이상이 트리와 다른지 — 를 검사하므로, 이 목록이 조용히 살아 있는 서명의
보관소가 되지 않습니다.
