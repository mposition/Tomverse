# AI Review 블라인드 파일럿 (답변 비교)

제품의 **답변 비교 AI Review**가 두 고정 답변 사이의 실제 모순을 찾는지, 출처를 모르는
사람이 판정하도록 돕는 로컬 오프라인 도구입니다. 코드·PR을 검토하는 engineering
cross-review와는 다른 기능입니다.

- 파일만 읽고 씁니다. provider 호출, 유료 판정, 외부 전송, 가입·결제는 없습니다.
- M5 평가와 분리되어 있습니다. M5 등록부·임계값·예산·승격 상태를 읽거나 바꾸지 않고,
  이 파일럿의 수치는 M5 승인·승격 근거가 아닙니다.
- 실제 제품 출력과 사람 판정이 없으면 보고서는 항상 **품질 미측정**을 표시합니다.

## 실행 위치

로컬 PC, PowerShell, 이 저장소(또는 기능 worktree) 루트. `npm ci`로 설치한 의존성과
`npx prisma generate`가 필요합니다(제품의 인용 검사 모듈이 이를 import합니다). 운영
자격증명은 필요 없고, 쓰기는 `--out` 폴더에만 합니다.

## 합성 시연 (한 번에)

```powershell
npm run experiment:ai-review-blind-pilot -- demo --out .tmp/ai-review-blind-pilot/demo
```

`.tmp/`는 gitignore 대상입니다. 만들어지는 파일:

| 경로 | 누가 보나 | 내용 |
|---|---|---|
| `judge-1/packet.md` | 판정자 | 문서·질문·고정 답변·익명 출력·인용·중립 ID만 |
| `judge-1/record.json` | 판정자 | 빈 기록지 |
| `judge-1/record.mock-locked.json` | 시연용 | 모의 판정 기록(사람 아님, `mock: true`) |
| `operator/freeze.json` | 운영자 | 사례·정답표 digest 고정 |
| `operator/key.json` | 운영자 전용 | 출력 ID→제품, 사례 라벨→사례 ID, 표시 라벨 대응, 위치·seed, 가림 기록 |
| `operator/adjudication.mock-locked.json` | 시연용 | 모의 정답 대조 |
| `report-before-judging.md` | 운영자 | 판정 전 보고서 (품질 미측정, 건수만) |
| `report.md`, `report.json` | 운영자 | 제품별·짝비교 보고서 |

## 실제 절차

`<dir>`은 이번 실행의 작업 폴더입니다. 판정자 폴더(`judge-N/`)만 판정자에게 줍니다.

1. **과제와 정답표 준비.** `fixtures/`와 같은 형식으로 `cases.json`, `gold.json`을 씁니다.
   정답표는 사람이 검토하기 전까지 `review.status: "candidate"`입니다. 사람이 검토했다면
   그 사람이 `human_reviewed`, `reviewedBy`, `reviewedAt`을 직접 적습니다(도구는 쓰지 않습니다).
2. **출력을 보기 전에 고정.**
   ```powershell
   npm run experiment:ai-review-blind-pilot -- freeze --plan <plan.json> --out <dir>
   ```
   이후 사례나 정답표를 한 글자라도 바꾸면 `prepare`와 `report`가 거부합니다.
3. **출력 수입.** 사람이 합법적으로 확보한 제품 출력을 `outputs/*.json` 형식으로 옮깁니다
   (아래 형식). 원문은 고치지 않습니다. `plan.json`의 `products`에 슬롯(X, Y)과 파일을 적습니다.
4. **판정자 묶음 준비.**
   ```powershell
   npm run experiment:ai-review-blind-pilot -- prepare --plan <plan.json> --out <dir>
   ```
5. **판정.** 판정자는 `packet.md`를 읽고 `record.json`에 항목마다 행을 적은 뒤 직접 잠급니다.
   ```powershell
   npm run experiment:ai-review-blind-pilot -- lock --record <dir>/judge-1/record.json --judge "<판정자 이름>"
   ```
6. **정답 대조 (제품 키 없이).**
   ```powershell
   npm run experiment:ai-review-blind-pilot -- adjudicate --plan <plan.json> --out <dir> --records <dir>/judge-1/record.json
   ```
   `operator/adjudication-template.json`에 행마다 `verdict`(matched | false_finding | gold_gap |
   undetermined), `goldId`, 필요하면 `sufficiency: "insufficient"`를 적고, `adjudicatedBy`,
   `adjudicatedAt`, `status: "locked"`를 사람이 적습니다. 판정자가 둘이면 `consensus`에 합의 결과를
   `{judge, row, verdict, goldId, sufficiency}`로 적습니다(합의 전에는 `null`).
7. **보고서 (여기서 제품 키가 열림).**
   ```powershell
   npm run experiment:ai-review-blind-pilot -- report --plan <plan.json> --out <dir> --records <dir>/judge-1/record.json --adjudication <dir>/operator/adjudication-template.json
   ```

## 파일 형식 요점

**plan.json** — `seed`(정수), `judges`(1|2), `documentExposure`(`shown_in_question` | `hidden`),
`cases`, `gold`, `products: [{slot, output}]`, 판정자에게 숨길 추가 문자열 `forbiddenTerms`.

**cases.json** — 사례마다 `caseId`, `familyId`, `variantId`, `translationPairId`, `language`,
`document.clauses[{id, text}]`, `question`, `answers[{id, content}]`. 번역쌍은 ko 1개 + en 1개이며
독립 표본으로 세지 않습니다.

**gold.json** — 사례마다 `contradictions`(두 답변의 원문 구간 `answerSpans`, `subject`, `condition`,
`period`, `clauseRef`, `rationale`, 언어 대응 `counterpartGoldId`), `missing`(`targetAnswer`,
`requirementId`), `jointDocumentErrors`(`documentValue`, 모든 답변의 구간), 종류별 `completeness`.
구간은 원답변에 글자 그대로 있어야 합니다.

**outputs/*.json** — `productName`, `aliases`, `modelIds`(모두 판정자 묶음에서 가림), `source`
(`synthetic_mock` | `real_capture`), `captureMethod`, `capturedAt`, `conditions.fixedAnswersAccepted`,
`conditions.documentExposure`, `items[]`:

- `status: "failed"` + `failureReason` — 실패 응답(판정 안 함). 항목이 없으면 미수집.
- `status: "ok"`, `format`:
  - `structured` — 제품 필드 그대로의 `findings[{field, text, citations[{displayLabel, quote}]}]`
  - `free_text` — `rawText` 원문과, 운영자가 표시한 원문 구간 `findings`(문장을 고쳐 쓰지 않음)
  - `observation_only` — eval journal처럼 발견 문자열과 인용 **합계**(`totalQuotes`, `matchedQuotes`)만
    있는 경우. 인용별 출처는 추정하지 않고 '판정 불가'로 둡니다.
- `displayMap` — 그 실행에서 실제로 쓴 표시 라벨→원답변 id(제품의 `responseMap`). 모르면 `null`이고,
  그때 인용 출처는 '판정 불가'입니다. 입력 배열 순서를 A/B로 간주하지 않습니다.
- `findings: []` — 출력이 실제로 낸 빈 발견 목록(판정 대상, 정답이 있으면 미탐).

자체 모델이 후보 답변을 새로 만든 제품은 `fixedAnswersAccepted: false`로 적습니다. 그 출력은
'전체 제품 경험'으로 따로 세고 고정 답변 비교표와 짝비교에서 뺍니다. 검토기 문서 노출 조건이
plan과 다르면 `condition_mismatch`로 뺍니다.

## 채점 규칙

- 모순은 같은 대상·조건·기간에서 동시에 참일 수 없는 한 명제 쌍입니다. 사람이 명시적 지적을
  gold와 일대일로 대조합니다. 같은 gold를 다시 지적하면 중복, 대상은 맞지만 조건·기간을 특정하지
  못하면 불충분(오탐으로 셈)입니다.
- 정밀도는 종류별 gold가 완전한 사례만 분자·분모에 넣습니다. 재현율 분모는 gold 모순 수입니다.
  분모 0은 N/A입니다. 음성 사례(모순 gold 0, 완전)의 가짜 모순은 따로 셉니다.
- gold 밖의 옳은 지적(`gold_gap`)이 완전 gold에서 나오면 그 사례는 **양쪽 제품 모두 보류**되고
  정답표 결함으로 보고됩니다. `undetermined`가 있으면 그 출력은 채점하지 않습니다.
- 누락은 기존 judged-v3 채점기(`scoreJudgedCase`)로 셉니다. 대칭 모순은 judged-v3의 `missing`으로
  저장하지 않습니다.
- 증거: (a) 표시 라벨 대응을 거쳐 지정 원답변에 인용이 있는지(제품의 인용 검사와 같은 정규화),
  (b) 인용이 양쪽 주장과 결론을 지지하는지(판정자), (c) 인용 미제시·판정 불가를 나눕니다. 인용
  일치나 기존 `verified=true`는 의미 TP가 아닙니다.
- 양 답변의 공동 오류는 답변 간 모순 0건입니다. 문서 오류 탐지는 검토기에 원문을 보여 준 조건
  (`shown_in_question`)에서만 평가합니다.

## 무효화

출력·문서·질문·답변·표시 라벨 대응이 바뀌면 그 출력의 판정이, seed·사례 순서·출력 위치가 바뀌면
그 판정자의 기록 전체가, 정답표가 바뀌면 모든 단계가 거부됩니다. 잠긴 기록을 고치면 그 기록에
결속된 정답 대조가 거부됩니다.

## 눈가림의 한계

제품명·별칭·모델 ID·사례 ID·정답 ID·파일명은 판정자 묶음과 기록지에서 검사해 남아 있으면 준비를
멈춥니다. 출력 문장 속 이름은 `[가림]`으로 바꾸고(운영자 키에 횟수 기록), 인용문 안에 있으면 인용을
고치지 않고 **눈가림 불가**로 뺍니다. 그래도 구조화 필드 대 자유서술 같은 형식이나 문체로 출처를
추측할 수 있습니다.

## 자료의 출처

`fixtures/`의 사례·정답표·출력 X/Y·판정은 모두 이 저장소가 쓴 **합성 자료**입니다. 가상 견적서이며
실제 회사·고객·계약이 아니고, 출력 X/Y는 어떤 제품의 캡처도 아닙니다. 정답표는 사람이 검토하지 않은
후보이고, 모의 판정자는 사람이 아닙니다.

## 테스트

```powershell
node --conditions=react-server --import tsx --test tests/aiReviewBlindPilot.test.mjs
```
