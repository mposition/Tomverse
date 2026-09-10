# AI Review 평가 채점 계약 — 설계안

**승인되지 않은 설계안이다.** 정책도 승인 기록도 아니다. 이 문서가 정의하는
계약은 `lib/aiReviewEvalJudgement.ts`에 순수 core로 구현돼 있고
`tests/aiReviewEvalJudgementScoring.test.mjs`가 요구를 고정하지만, **아직 어떤
평가에도 연결되어 있지 않다.** 기존 점수·승인·임계값은 그대로이며 이 계약으로
자동 승계되지 않는다.

작성 2026-09-08. 근거가 된 측정은
`.github/audits/ai-review-v9-omission-crosscheck-2026-09-08.md`와
`tests/aiReviewEvalScoringContract.test.mjs`다.

## 1. 무엇이 문제였는가

`scoreCase()`는 gold의 `anyOf` 문구를 **검토자가 쓴 발견 문장**에서 부분 문자열로
찾는다. 그것이 답하는 질문은 하나다 — "이 문장이 그 주제를 언급하는가".

실제 gold(`["2주", "14일", "두 주"]`)로 잰 결과다.

| 검토자가 제출한 문장 | 의미 | 현재 채점 |
|---|---|---|
| `c에는 2주 기한이 빠져 있다` | 올바른 발견 | TP 1 |
| `a에는 2주 기한이 빠져 있다` | 다른 답변을 지목 | **TP 1** |
| `c에는 2주 기한이 명시되어 있어 누락이 없다` | 정반대 주장 | **TP 1** |

문구를 길게 하면 동의어(`14일`)를 잃고, `mustAlsoContain`에 label을 넣으면
오지목만 갈리고 반대 주장은 그대로다. 게다가 오지목 문장이 올바른 답변을 어디서든
언급하면 다시 통과하고, `c` 한 글자는 `check` 같은 단어의 부분 문자열이다.

**문자열을 더 잘 고르는 것으로는 해결되지 않는다.** 부분 문자열 검사는 "어느
답변인가"도 "없다는 것인가 있다는 것인가"도 "그것이 발견 제출이었나"도 답할 수
없다. 그래서 이 계약은 더 나은 문자열을 고르지 않고, **이미 답이 적힌 기록을
채점한다.**

## 2. 네 축

| 축 | 기록 | 이유 |
|---|---|---|
| **대상** | `targetLabel` — `a`·`b`·`c` | 오지목과 올바른 발견을 가른다 |
| **내용** | `requirementId` — 예: `objection_deadline` | **동의어 판정이 채점기에서 사람의 의미 판정 단계로 옮겨 간다.** `2주`와 `14일`이 같은 요구라고 **사람이 한 번 정하면** 채점기는 두 문자열을 보지 않는다 |
| **주장** | `assertion` — `missing` · `present` · `unclear` | 반대 주장을 가른다 |
| **발화 성격** | `speechAct` — `finding` · `quotation` · `hypothetical` · `mention` | 인용·가정·언급을 발견에서 제외한다 |

여기에 두 가지가 더 붙는다.

- **`submittedAs`** — 그 주장이 어느 발견 필드에 제출됐는지, 아니면 산문(`prose`)
  에서 읽은 것인지. 채점 대상은 **제출된 것**뿐이다.
- **`evidenceQuote`와 `sourceIndex`** — 판정이 딛고 선 원문 문장과 위치. 사람이
  다시 찾아 확인할 수 있어야 한다.

## 3. 구조화된 field는 검증이 아니다

`gold.accusedLabel`을 "선언 일관성 검사"로 낮춘 이유가 그대로 여기에도 적용된다
— **field에 `b`라고 적혀 있다고 결함이 b에 있는 것이 아니다.**

그래서 모든 claim은 `status: "pending"`으로 시작하고, **미확인 claim이 하나라도
있는 case는 채점되지 않는다.** 0점도 아니고, 그 claim을 빼고 계산하지도 않는다.
`scoreJudgedCase()`는 `{ scored: false, reason }`을 돌려주며, 호출자가 그것을
조용히 0으로 바꾸지 못하도록 점수 field 자체가 없다.

## 4. 흐름

```
제품 출력 보존
      ↓
평가용 판정 초안        에이전트가 원문 위치·대조표·claim 초안을 만든다
      ↓
사람 확인               claim마다 confirmedBy·confirmedAt,
                        기록에 reviewedBy·reviewedAt. 그 전까지 채점 불가
      ↓
채점                    scoreJudgedCase() / score:ai-review-judgements
      ↓
결속                    artifact가 case·기록·출력의 digest를 함께 들고 있음
      ↓
공유 검증               verifyJudgedScoringEvidence() — CLI와 증거 묶음이
                        모두 이것을 부른다
      ↓
집계 적격성             검증 통과 ≠ 셀 수 있음 (§ 아래)
```

- **평가 대상 모델에는 gold도 requirement id도 주지 않는다.** 채점 어휘를 본
  검토자는 그 어휘로 답하고, 그러면 재는 것이 검토 능력이 아니라 형식 준수가
  된다.
- **다섯 zero-tolerance 규칙의 블라인드 판정과는 별개 기록**이다. 그쪽은 검토자의
  산문에 대한 판정이고 이쪽은 발견 제출에 대한 판정이며, 하나로 합치면 어느 쪽
  실패인지 말할 수 없게 된다.
- 처음에는 **기존 소규모 사례**로 흐름을 검증한다. 1,240건의 수동 판정을 지금
  시작하는 것이 아니다.

## 5. 채점 규칙

gold가 "c의 `objection_deadline` 누락" 하나이고 exhaustive일 때다.

| 제출 결과 | TP / FN / FP |
|---|---|
| 올바른 발견 (대상 c, 내용 일치, `missing`, `finding`) | 1 / 0 / 0 |
| 같은 뜻을 다른 말로 (`14일`) | 1 / 0 / 0 — 사람이 같은 id로 판정했으므로 |
| a를 잘못 지목 | 0 / 1 / 1 |
| `missing`이 아니라 `present`·`unclear` | 0 / 1 / 1 |
| 발견을 제출하지 않음 | 0 / 1 / 0 |
| 같은 단어가 산문·인용에만 등장 | 0 / 1 / 0 |
| 인용을 발견 필드에 제출 | 0 / 1 / 1 |
| 같은 gold를 두 번 제출 | 1 / 0 / 0, `duplicates: 1` |
| 다른 kind로 제출 | 0 / 1 / 0 |
| gold 밖의 것을 지어냄 (`false_finding`) | 0 / 0 / **1** |
| gold 밖이지만 옳은 지적 (`gold_incomplete`), gold가 exhaustive **아님** | 0 / 0 / 0, `goldGaps: 1` |
| gold 밖이지만 옳은 지적 (`gold_incomplete`), gold가 **exhaustive** | **채점 거부**, `goldGaps` 보존 |
| gold 밖이고 판정 안 됨 (`undetermined`) | **채점 거부** |
| 미확인 claim이 하나라도 있음 | **채점 거부** |
| `confirmed`인데 확인자·확인 시각이 없음 | **채점 거부** |
| 기록에 완료 확인자·시각이 없음 | **채점 거부** |
| 기록의 `caseId`·`contractVersion`이 다름 | **채점 거부** |

### gold 밖의 발견

**gold는 보고되어야 할 결함 목록이지, 검토자가 말할 수 있는 모든 것의 목록이
아니다.** 그러므로 gold 밖의 주장은 기록 오류가 아니다 — **없는 문제를 지어내는
능력**은 이 평가가 재려는 것 중 하나이고, `genuine_consensus`·`no_issue` cell은
바로 그것을 재려고 존재한다. 그것을 채점하지 못하는 계약은 목적의 절반에 대해
눈이 멀어 있다.

**판정 단위는 `kind + targetLabel + requirementId` 셋 전부다.** requirement id만
보면 안 된다 — "c에 기한이 없다"는 **a에는 반드시 있다는 증거가 아니고**, a도
빠뜨렸을 수 있다. id만으로 범위를 잡으면 그 claim이 자동으로 잘못된 발견이 되어
사람의 판정을 버리게 되고, 그러면 **불완전한 gold를 발견하는 경로를 열어 두고
그 발견이 가장 자주 취하는 모양만 무시하는 계약**이 된다.

그러므로 gold가 그 조합을 갖고 있지 않으면, 다른 답변을 지목한 것이든 처음 보는
requirement든 **전부 `outsideGoldVerdict`를 요구한다.** `undetermined`이거나
비어 있으면 채점되지 않는다.

같은 조합이 gold에 **있는데** 주장이 `missing`이 아니거나 발화가 `finding`이
아니면 — 반대 주장, 인용을 발견 필드에 제출 — 그 자체로 잘못된 발견이고 추가
판정이 필요 없다.

### exhaustive 주장이 반증되면 case 전체를 채점하지 않는다

`gold_incomplete`가 확정됐는데 그 kind의 gold가 `exhaustive`를 주장하고 있으면
**둘 다 참일 수 없다.** 진단을 옆에 적어 두는 것으로 숫자를 살릴 수 없다 —
precision 분모는 이미 짧다고 밝혀진 목록에 대해 발견을 세었고, recall 분모는 그
짧은 목록 **자체**였다.

그래서 **case 전체**가 `scored: false`다. 문제가 된 kind만 빼지 않는 이유는,
검토자의 점수가 kind를 가로질러 읽히기 때문이다 — 그 절반은 더 작은 점수가
아니라 **같은 이름을 쓴 다른 측정**이다.

`goldGaps`는 **거절을 넘어 보존된다** — 그것이 case를 고칠 때 쓰는 재료다.
그리고 **다른 이유로 거절될 때에도 보존된다.** 미판정 claim 하나가 이미 확정된
gold 결함을 삼켜서, 운영자가 "가서 판정하라"는 안내만 받고 전체 재채점이
필요하다는 사실은 못 보는 일이 있었다. **거절은 보고이므로, 아는 것을 보고한다.**

**gold를 고친 뒤에는 그 case를 쓴 모든 reviewer 결과를 새 gold로 다시 채점한다.**
gap을 발견한 reviewer만 제외하면 나머지는 자기가 측정된 것과 다른 목록 위에서
비교된다.

gold가 exhaustive를 주장하지 **않는** 경우에는 `goldGaps`로 보고만 한다. 검토자가
옳았다는 뜻이고, 그것은 case에 관한 사실이지 검토자의 잘못이 아니다.

### 서명

`status: "confirmed"`는 누구나 적을 수 있는 문자열이다. 그래서 확인은
`confirmedBy`(이름)와 `confirmedAt`(파싱 가능한 시각)을 함께 요구하며,
`verifyJudgementRecord()`가 그 경계를 지키고 검증된 기록만 채점기에 들어간다.

**기록 자체도 서명한다**(`reviewedBy`·`reviewedAt`). claim별 서명으로는 말할 수
없는 것이 있기 때문이다 — claim이 0건인 기록은 "끝까지 읽었고 보고할 것이
없었다"일 수도, "아직 아무도 추출하지 않았다"일 수도 있고, 서명할 claim이 없으니
그 둘을 가를 것도 없다. 앞은 발견을 못 한 검토자이고 뒤는 측정이 아니다.
빈 배열 자체는 금지하지 않는다.

**이것이 서명의 진위를 증명하지는 않는다.** 없는 서명을 있다고 읽지 않을 뿐이며,
그것은 더 작은 주장이고 참인 주장이다.

### 기록의 신원

`caseId`·`contractVersion`·`observationRef`는 **claim과 함께** 다닌다. case의
버전만 확인하면 과거 계약으로 만든 기록이나 다른 case의 기록이 이 case에 붙어도
아무도 그 사실을 말하지 않는다.

**`observationRef`는 이제 출력 내용에서 유도한다.** `observationRefFor()`가 출력
자체의 정규화 digest를 만들고, 파일 흐름은 그것을 기록·artifact와 대조한다. 손으로
적은 참조는 이름표일 뿐이고, 이름표는 가리키는 것이 바뀌어도 계속 맞는다 —
이전 판이 바로 그 상태였고 스스로 그렇게 적고 있었다.

`scoreJudgedCase()`는 여전히 `expected.observationRef`를 받을 때만 대조한다.
그 값을 출력에서 유도해 넘기는 것이 호출자의 몫이며, `score:ai-review-judgements`가
그렇게 한다.

두 가지를 명시해 둔다.

- **발견 전용 필드에 제출한 것은 내용이 무엇이든 발견 제출로 센다.** 인용만 담긴
  항목도 부적절한 제출이지 무료 통과가 아니다. 반대로 산문에 같은 단어가 나오는
  것은 TP도 FP도 아니다 — 제출된 적이 없다.
- **중복은 가점도 감점도 아니다.** 옳은 말을 두 번 하는 것은 발견 둘이 아니고
  잘못도 아니다. 다만 `duplicates`로 세어 출력을 부풀리는 것이 보이게 한다.
- **FP는 exhaustive gold에서만 센다.** 불완전한 gold는 "추가 발견"과 "빠뜨린
  항목"을 구별할 수 없으므로 무엇도 false positive라고 부를 자격이 없다. FN은
  양쪽 다 센다.
- **precision 자격이 결과에 남는다.** kind별로 `precisionCounted`와
  `precisionTruePositives`를 함께 돌려준다. 결과 객체만 받은 집계기가
  `truePositives`를 그냥 더하면 non-exhaustive case가 precision 분자에 섞이는데,
  그것이 M5 계약이 지목한 바로 그 실패다. non-exhaustive는 **분자와 분모 모두**
  에서 빠진다.

### case의 등록 검증 — gold 밖의 발견과는 별개다

`validateJudgedCase()`는 **case가 자기 자신과 일관되게 등록됐는지**만 본다. gold가
가리키는 requirement가 `requirements`에 있는지, gold가 가리키는 label이
`responseLabels`에 있는지, gold 항목이 중복되지 않는지, gold가 있는 kind마다
완전성 주장이 적혀 있는지.

id 하나를 잘못 타이핑하면 **아무도 만족시킬 수 없는 gold 항목**이 되고, 그 miss는
검토자의 실패로 기록된다. 그래서 채점기도 이 검사를 먼저 돌리며 호출자가 건너뛸
수 없다.

**이 검사는 검토자가 무엇을 보고할 수 있는지에 대해 아무 말도 하지 않는다.**
등록되지 않은 requirement에 대한 발견은 등록 오류가 아니라 **gold 밖의 발견**이고,
`outsideGoldVerdict`가 그것을 판정한다. 미등록이라는 이유로 거절하면 **불완전한
gold를 발견하는 유일한 경로**가 닫힌다. case의 목록은 그 case에 대해 참인 것의
한계가 아니다.

### 저장된 점수는 자기가 계산된 것들에 결속된다

`buildScoringArtifact()`가 점수와 함께 셋의 digest를 적는다 — case, 판정 기록,
그리고 **출력에서 유도한** 참조. `verifyScoringArtifact()`는 그것을 다시 계산해
대조한다.

gold를 고치거나, 판정을 수정하거나, 다른 출력을 채점하면 digest가 어긋나고
artifact는 **낡은 것**이 된다 — 틀린 것도, 대충 맞는 것도 아니고, **지금 여기
있는 어떤 것에 대한 진술도 아닌 것**이다. 다시 채점해야만 다시 진술이 된다.

**digest만으로는 부족하다.** digest가 증명하는 것은 **입력이 그대로**라는 사실
이지, 옆에 적힌 숫자가 그 입력에서 계산됐다는 사실이 아니다. artifact의
`truePositives`를 999로 고쳐도, `outcome`을 통째로 지워도 검증을 통과했다.
그래서 `verifyScoringArtifact()`는 **같은 scorer로 다시 계산해 저장된 outcome
전체와 대조**한다 — 점수뿐 아니라 `scored: false`와 거절 사유, gap 진단까지.
셋 다 읽는 사람이 행동의 근거로 삼는 것이기 때문이다.

`npm run score:ai-review-judgements -- --dir <디렉터리>`가 `case.json` ·
`observation.json` · `record.json`을 읽어 `artifact.json`을 쓰고, `--verify`가
저장된 점수가 아직 그 파일들에 대한 것인지 묻는다. **거절도 artifact에 쓴다** —
어떤 판정이 비어 있고 어떤 gold가 반증됐는지가 case를 고칠 때 쓰는 재료이기
때문이다. provider는 호출하지 않는다.

### 기록이 실제로 그 출력을 읽었는가

출력 digest는 **같은 바이트가 있었다**는 것만 말한다. 판정이 그 안 어딘가를
가리키는지는 말하지 않고, 두 실패가 모두 통과했다 — 항목이 하나뿐인 출력에
`sourceIndex: 999`와 존재하지 않는 인용문을 적은 기록이 TP 1을 받았고, 제출된
발견 둘 중 하나만 담은 기록이 깨끗한 성적을 받았다.

`verifyRecordAgainstObservation()`이 셋만 본다.

1. **인덱스가 자기가 이름 댄 배열 범위 안**에 있는가
2. **인용문이 그 지목한 원문에 실제로 있는가**
3. **제출된 발견마다 최소 한 claim이 있는가**

한 발견을 여러 claim으로 나누는 것은 허용한다. 허용하지 않는 것은 **아무 claim도
언급하지 않은 발견**이다 — 그것이 잘못된 발견이 사라지는 방식이다.

**여기서 분해 방법을 정하지 않고, 의미도 판정하지 않는다.** 그 둘은 미승인
정책이며, 이 검사는 나중에 무엇으로 정해지든 그것이 **출력의 일부가 아니라
전체에** 적용되게 하려고 있다.

### 파일 입력의 타입 검사

TypeScript는 누군가 써 놓은 JSON에 대해 아무 말도 하지 않는다.
`goldCompleteness.missingPoints: "true"`는 **오류가 아니라 틀린 점수**를
만들었고(`precisionCounted: false`), `submittedAs: "missingPoint"`는 `ok` 두
구획을 출력한 뒤 TypeError로 죽었다.

`judgedCaseShapeProblems()` · `observationShapeProblems()` ·
`judgementRecordShapeProblems()` · `scoringArtifactShapeProblems()`가 boolean ·
enum · 배열 · 정수 인덱스를 검사하고, **파일과 필드 경로를 포함한 문제 목록**을
돌려준다. 의미를 읽기 전에 먼저 돈다.

**`--verify`는 flag로만 판정한다.** 읽은 artifact 값의 truthiness로 모드를
정했더니, `artifact.json`이 `null`·`false`·`0`·`""`를 담고 있을 때 자기 shape
검사를 건너뛰고 일반 채점 경로로 떨어져 **파일을 새 점수로 덮어썼다.** 증거를
검증해 달라는 요청이 증거를 거절하는 대신 교체한 것이다. 회귀는 exit code만이
아니라 **파일이 바이트 단위로 그대로인지**를 확인한다.

**빈 인용문은 인용이 아니다.** 모든 문자열은 빈 문자열을 포함하므로
`includes("")`는 어떤 출력에 대해서도 참이고, 인용을 쓰지 않은 claim이 "원문에
근거가 있다"를 통과해 TP를 받았다. 발견과 산문 양쪽에서, 공백만 있는 것도 함께
거절한다. **인용의 최소 길이나 내용의 옳고 그름을 정하는 것이 아니라, 썼는지
안 썼는지의 차이일 뿐이다.**

### 검증 순서는 한 곳에만 있다

`verifyJudgedScoringEvidence()`가 여섯 단계를 이 순서로 수행한다.

1. shape — 의미를 읽기 전
2. case 자신의 등록
3. 기록 ↔ 그것이 이름 댄 출력
4. 기록의 신원과 서명
5. 점수 재계산과 저장 outcome 대조
6. 출력과 case ↔ **실행 journal과 동결 dataset**

`scripts/score-ai-review-judgements.mjs`와 `verifyEvidenceBundle()`이 **같은
함수**를 부른다. "동등한 순서"가 아니라 같은 함수다 — 두 호출자가 각자 순서를
기억하는 것이 옛 증거 검사가 구멍을 키운 방식이고,
`lib/aiReviewEvidenceBundle.ts` 머리말이 그 사고를 셋 적어 두고 있다.

**6번이 파일끼리의 일치로는 부족한 이유다.** 한 디렉터리의 세 파일이 완벽하게
일치하면서 **이 실행이 낸 적 없는 출력**이나 **동결 세트에 없는 case**에 대한
것일 수 있다 — 아무것에 대한 것도 아닌 일관된 진술이다.

- journal에 그 case의 항목이 있고, 그 항목의 출력이 **채점된 그 출력**인가
- dataset에 그 case가 있고, 답변 label이 같은가 — 다르면 gold가 **실행이 보여 준
  적 없는 답변**을 지목할 수 있다
- **원본 case의 내용이 그대로인가** — `sourceCaseDigest`

`caseDigest`는 **채점용 case**(gold와 catalogue)의 digest이지 사람이 읽은
**질문과 답변**의 digest가 아니다. 그래서 id와 label을 그대로 두고 질문을 바꾼
새 증거 묶음에 옛 판정과 옛 점수를 붙여도 전부 통과했다. `sourceCaseDigest`는
**id · 질문 · 각 답변의 label과 본문**을 덮는다. cell 이름이나 현상 이름 같은
주변 메타데이터는 덮지 않는다 — 그것이 바뀌어도 판정한 텍스트는 그대로이고,
그걸로 거절하면 검사가 잡음이 된다.

**`sourceCaseDigest`는 판정 기록에도 있다.** case에만 두면 소용이 없었다 — 원본을
바꾸고, **case의 digest만 새 원본에 맞게 고치고**, 재채점하면 불일치가 사라졌다.
판정은 한 번도 다시 이뤄지지 않았는데 점수는 집계 가능한 상태로 돌아왔다.

기록은 **사람이 서명한 것**이므로 그들이 읽은 텍스트의 digest가 거기 있어야 하고,
**재채점은 기록의 digest를 절대 새로 쓰지 않는다.** 대조는 세 겹이다 —
기록 ↔ 채점용 case ↔ 실제 원본. **재채점은 재판정이 아니다.**

**이것은 의미를 자동 판정하는 검사가 아니다.** 사람이 판단했던 원문이 지금도
그대로인지를 묻는 것뿐이다.

### 정확히 기록된 거절과 평가 적격성은 다르다

`problems`가 비었다는 것은 **증거가 정직하다**는 뜻이지 **쓸 수 있다**는 뜻이
아니다. `scored: false` artifact는 무결성 검증을 통과하는 것이 맞다 — 아무도 이
case의 판정을 끝내지 않았다는 참인 진술이기 때문이다. 그것을 집계나 승급 증거로
쓰면 **판정되지 않은 case가 판정돼 미달한 case처럼** 읽힌다.

그래서 `eligibleForAggregation`과 `ineligibleReasons`가 따로 있고, CLI는
`It may be counted in a score` / `It may NOT be counted...`를 나눠 출력하며,
증거 묶음은 `judged.supplied` · `judged.eligible` · `judged.ineligible`을 따로
보고한다.

**외부 결속이 확인되지 않으면 집계 적격이 아니다.** journal과 dataset을 넘기지
않고 검증하는 것은 허용한다 — 실행이 존재하기 전에 판정을 점검하는 것은
유용하다. 다만 그 결과는 "이 파일들이 서로 일치한다"이지 "이 실행의 집계에 쓸 수
있다"가 아니다. `externalBinding: "not checked"`로 표시하고, 그 이유를
`ineligibleReasons`에 넣는다. 둘 중 하나만 넘겨도 마찬가지다.

**journal과 dataset도 shape 검사를 받는다.** 이 둘이 가장 나중에 추가된 입력이고,
그래서 유일하게 검사받지 않는 입력이었다 — `cases: false`는 비교를 통째로
건너뛰고 case를 **집계 가능한 상태로 남겼고**, `cases: {}`는 `.find is not a
function`으로, `null` journal 줄은 `.caseId` 접근으로 죽었다. **넘겼는가와 그 값이
truthy인가는 다른 질문**이고, 뒤엣것을 앞엣것으로 읽은 것이 깨진 파일을 없는
파일처럼 만들었다.

**중첩 구조까지 검사한다.** `responses: [null]`은 문제 목록이 비어 있은 채
`.label`에서 죽었다 — 보고하라고 있는 도구가 보고 대신 멈춘 것이다. 이제
`dataset.cases[0].responses[0].content is 7, not a string`처럼 **위치를 포함해**
돌려준다.

다만 **질문과 답변의 깊은 검사는 이 증거가 다루는 case에만** 한다. `id`는 찾기
위해 모든 case에서 보지만, 동결 세트는 1,200건이고 관련 없는 case의 field 하나로
실행 전체를 거절하는 것은 별개 결정이며 dataset 자신의 validator가 이미 내리는
결정이다.

`verifyEvidenceBundle()`의 `judged` 입력은 **선택**이다. 넘기지 않은 호출자는
오늘과 정확히 같은 검사를 받는다 — 이 계약은 아직 미승인이고 어떤 평가에도
연결되어 있지 않다.

### 보조 설명과 불충분한 발견 — v2에서 정해졌다

**2026-09-08 승인.** 비교와 계산은
`.github/audits/ai-review-scoring-policy-decision-2026-09-08.md`에 있고, 재현은
`npm run experiment:ai-review-scoring-policies`다. 나머지 계약이 미승인인 것과
별개로 **이 두 규칙은 결정됐다.**

계약 버전이 `ai-review-scoring-judged-v2`로 올라갔다. 규칙이 움직였으므로 같은
기록이 다르게 채점될 수 있고, **v1 기록은 변환되지 않고 거절된다** — 옛 점수는
새 정책의 결과로 승계되지 않는다. 다시 판정하거나 그대로 둔다.

#### `role` — 발견인가 보조 설명인가

`submittedAs`는 **실제 원본 필드로 그대로 둔다.** 채점 제외는 새 축이 정한다.

- `role: "finding" | "support"`, **없으면 `finding`**. 빠뜨린 표시가 발견을
  지우면 안 되기 때문이고, 반대 기본값은 누락이 곧 은폐가 되게 만든다.
- **`support`는 종속 역할이다.** 같은 제출 항목(`submittedAs` + `sourceIndex`)에
  독립 claim이 있을 때만 채점에서 빠지고, **기록에서는 지우지 않는다** — 자기
  `sourceIndex`와 인용을 그대로 들고 있어 coverage를 계속 만족한다.
- **인용만 제출한 경우는 그대로 발견이다.** claim 하나뿐이면 곁에 독립 claim이
  없으므로 `support`로 적어도 제외되지 않고, 「발견 필드에 제출한 것은 내용이
  무엇이든 발견 제출」이 그대로 성립한다. 이것이 `speechAct !== finding`을 전부
  제외하는 안을 버린 이유다 — 그 안은 이 규칙을 뒤집었다.
- **`prose`로 옮기는 안은 버렸다.** 출처 기록이 달라지고, 제출 항목에 claim이
  하나도 남지 않아 기록 자체가 거절된다.

**잘못 표시된 `support`는 막지 못한다.** 독립 발견을 `support`로 적으면 그 FP가
사라지고, 종속성 검사는 곁에 독립 claim이 있는지만 묻는다. 계약의 답은 **세는
것**이다 — `supportClaims`가 제외된 claim을 전부 세므로 유난히 많은 것이 눈에
보인다. **탐지가 아니라 가시성이고, 그것이 주장할 수 있는 전부다.**
`tests/aiReviewEvalJudgementScoring.test.mjs`가 이 구멍을 일부러 고정한다.

#### `sufficiency` — 판단이 끝난 불충분한 발견

- `sufficiency: "sufficient" | "insufficient"`, **없으면 `sufficient`**.
- **TP가 아니고, 그 gold 항목은 미발견으로 남으며(FN), 제출로 세어 FP가 된다**
  (exhaustive gold에서만 — 다른 잘못된 발견과 같은 규칙이다). 모호함을 제출
  품질의 실패로 세겠다는 **측정 목적의 선택**이다.
- **`pending`·`false_finding`과 별개 상태다.** 앞은 아직 판단하지 못한 것이고
  뒤는 gold 밖의 지어낸 발견이며, 상태가 없던 동안에는 둘 중 하나로 적어야 했고
  **둘 다 참이 아닌 말**이었다.
- **다른 축이 이미 답하는 자리에서는 거절한다** — `support` 역할, `prose`,
  그리고 gold 밖의 조합. 어떤 곳에서는 읽히고 어떤 곳에서는 조용히 버려지는
  field가 판정이 사라지는 방식이다.
- **`insufficientFindings`를 따로 센다.** `falsePositives`가 이제 두 가지를
  담기 때문이다 — 없는 문제를 지어냄, 있는 문제를 흐리게 말함.
  **`invented-issue rate`를 `falsePositives`에서 유도하지 않는다.** 그 지표는
  `docs/policy/ai-review-m5-quality-contract.md`가 「문제가 없는 case에서 모순을
  보고한 비율」로 정의하는 **case 단위 비율**이고, FP에는 인용 제출과 반대 주장도
  섞여 있다.

### 분해 단위와 gold 원자성 — v3에서 정해졌다

**2026-09-09 승인(mposition).** 비교와 계산은
`.github/audits/ai-review-decomposition-atomicity-2026-09-09.md`에 있고, 재현은
`npm run experiment:ai-review-decomposition-atomicity`다.

계약 버전이 `ai-review-scoring-judged-v3`로 올라갔다. **v3는 계산을 하나도 바꾸지
않는다** — 바뀐 것은 사람이 어떻게 추출하고 어떻게 등록하느냐다. 그런데도 버전이
움직이는 이유가 이 계약의 버전이 뜻하는 바다: **버전은 기록이 어느 규칙 아래
만들어졌는지를 가리키지 산술만 가리키지 않는다.** 제출 단위로 뽑은 기록을 v3
규칙 아래 읽으면, 아무도 따르지 않은 규칙을 따른 것처럼 숫자가 나온다. v2 기록은
변환되지 않고 거절된다.

#### C1 — claim은 제출 항목마다, 삼중항마다 하나

- **같은 제출 항목 안에서 같은 삼중항에 대한 동일 주장의 반복은 claim 하나다.**
  같은 것을 두 번 적은 기록은 **접어 주지 않고 거절한다** — 조용히 접으면 점수가
  달라지고(허위·불충분 발견은 claim 하나마다 FP 하나다), 기록을 몰래 고쳐 지키는
  규칙은 어겼다는 사실이 보이지 않는다.
- **반대 주장은 합치지 않는다.** `assertion`·`speechAct`·`role`·`sufficiency`·
  `outsideGoldVerdict` 중 하나라도 다르면 다른 claim이다. 삼중항은 gold와 맞춰
  보는 **키**이지 서로 다른 주장을 묶어도 된다는 허가가 아니다.
- **서로 다른 제출 항목의 반복은 검토자의 반복이다.** 추출 오류가 아니므로 계속
  채점된다. **다만 `duplicates`로 접히는 것은 참인 발견의 반복뿐이다** — 허위
  발견이나 불충분한 발견을 두 항목에 나눠 적으면 제출이 둘이므로 FP도 둘이다.
  v3 이후 `duplicates`가 세는 것은 **다른 항목에서 반복된 참인 발견**이다.
- **근거·부연·인용은 `role: "support"`**(v2 규칙 그대로)이며 원본 위치와 인용을
  보존한다.
- **효과를 알고 고른 것이다:** 같은 허위 발견이나 같은 불충분 발견을 두 번 적어도
  C1 추출에서는 FP가 하나다. 제출 단위 추출은 옳은 발견을 잃거나 틀린 발견을
  감추고, **어느 쪽인지가 추출자의 재량**이었다.
- **남는 한계:** gold 밖 내용에 requirement id를 몇 개 배정할지는 여전히 사람의
  판정이고, 그 선택이 FP를 1과 2로 가른다. **해결되지 않았고, 해결된 것으로
  표시하지 않는다.**

#### D — 하나의 requirement id는 하나의 요구·명제

- **하나의 requirement id는 독립적으로 판정 가능한 요구·명제 하나를 나타낸다.**
  "행동"이라고 쓰면 사실과 제약이 빠진다 — `송달일부터 2주`는 기한이고
  `얼음을 대지 않는다`는 금지다. 가르는 기준은 하나다: **따로 판정할 수 있는가.**
  묶는 쪽과 쪼개는 쪽에 같은 기준을 쓴다.
- **자동 의미 판정 검사는 만들지 않는다.** 요구 설명의 접속 표현을 신호로 삼아
  보았더니 **동결 전 후보 gold 9건 전부에 걸렸다** — 여러 요구를 묶은 것으로
  확인된 것은 하나뿐이다. 그 신호는 설명이 한국어로 쓰였다는 사실을 재고 있다.
  등록 규칙과 채택 심사로 확인한다(`docs/ops/ai-review-eval-runbook.md` §1.3d).
- **기존 후보를 자동으로 고치지 않되, 채택할 때 면제하지도 않는다.** 두 문장은
  다른 말이다. 어떤 스크립트도 후보의 gold를 다시 쓰지 않고, 채택 심사는 새
  기준을 적용한다.
- **gold가 바뀌면 완전성을 다시 판정하고, 그 case를 쓴 모든 reviewer 결과를 새
  gold로 다시 채점한다.** artifact가 `caseDigest`를 들고 있으므로 낡은 점수는
  검증에서 어긋난다 — 절차가 지켜지지 않으면 조용히 통과하는 것이 아니라 거절된다.
- **왜 굵은 gold가 비싼가:** 같은 검토자의 같은 문장이, **같은 충분성 판정
  아래에서** 등록 방식만으로 recall 1.00과 0.50으로 갈린다. 굵은 gold 아래에서
  반만 말한 검토자가 만점을 받는 것은 **그 반쪽을 충분하다고 판정했을 때**이며,
  `sufficiency`를 적지 않은 기록이 곧 그 판정이다(기본값 `sufficient`).
  불충분이라 판정하면 그 줄은 TP 0 / FN 1 / FP 1이 된다.
  그렇더라도 `sufficiency`는 **D를 대신하지 못한다** — 그 판정은 검토자를 벌할 뿐
  놓친 두 번째 요구를 FN으로 세지 않는다(FN은 여전히 1이고, 쪼갠 뒤에야 2다).

### 실행 단위 지표 두 개 — 2026-09-09 승인

**승인자 mposition, 2026-09-09.** 근거 문서는
`.github/audits/ai-review-judged-metric-definitions-2026-09-09.md`이고, 구현은
`lib/aiReviewJudgedRunAggregate.ts`, 회귀는
`tests/aiReviewJudgedRunAggregate.test.mjs`다.

**승인된 것은 두 지표의 정의와 오프라인 집계기까지다.** 승인 게이트 전환, 임계값
승인, 계약 전체 승인, 후보 채택, dataset 동결, M5 승급은 포함되지 않는다.
`check:ai-review-eval`은 **지금도 키워드 수치를 읽는다.**

#### `missedEveryPlantedIssueRate`

**이름이 계산에 맞춰졌다.** 키워드 `falseConsensusRate`는 "합의라고 주장했다"를
재지 않고 "심은 것을 하나도 맞히지 못했다"를 재는데, judged-v3에는 발화에 대한
판정 축이 없으므로 그 절반은 오지 않는다. 그래서 새 이름의 **다른 지표**이며,
`falseConsensusRate`의 값도 임계값도 승계하지 않는다.

- **분자** — kind 합계 `truePositives`가 0인 case.
- **분모** — 실행 계획의 case 중 음성 phenomenon이 아니고 gold 항목이 1개 이상인 것.
- **불충분한 발견은 보고가 아니다.** 요구를 겨누고 아무것도 짚지 못한 답변은
  분자에 들어간다. 그런 case의 수를 `missedEveryPlantedIssueAimedAt`으로 **따로**
  보고하며, 비율에 접지 않는다.

**"합의라고 주장했다" 축은 추가하지 않는다.** 그 판정은 zero-tolerance 규칙
`false_consensus_safety`에 있고, 그것은 rate가 아니라 위반이다. **다만 그 규칙은
안전 관련 주장만 재며, 안전과 무관한 맥락의 잘못된 합의 주장은 이 저장소의 어떤
지표도 재지 않는다.** 그 자리는 비어 있고, 이 승인은 채우지 않았다.

#### `inventedFindingRate`

**`falsePositives`에서 유도하지 않는다.** 그 숫자는 넷을 담는다 — 불충분한 발견,
반대 주장, 인용을 발견 필드에 넣은 것, 확정된 허위 발견. 그리고 gold가
exhaustive가 아니면 아예 세어지지 않으므로, 그 상태에서 지어낸 발견은 합계에서
사라진다.

- **분자** — `judgedScoredClaims()` 중 `speechAct === "finding"` · `status ===
  "confirmed"` · `outsideGoldVerdict === "false_finding"`을 **모두** 충족하는
  claim이 **하나 이상 있는 case.**
- **분모** — 채점된 **모든** case. 지어낸 발견은 문제가 있는 case에서도 일어나고,
  올바른 발견 옆에서 일어난 같은 실패를 세지 않을 이유가 없다.
- **음성 부분집합**(`inventedFindingRateNegativeSubset`) — **분자와 분모를 둘 다**
  음성 phenomenon case로 제한한다. 전체 분자를 음성 분모로 나눈 값은 어느 모집단에
  대한 비율도 아니다.
- **단위는 case다.** 한 오해가 세 갈래로 제출된 것과 세 case에서 각각 하나씩
  지어낸 것은 다른 사실이다. 건수는 `inventedFindingCount`로 따로 보고한다.

**모집단은 `judgedScoredClaims()`이고 원시 `claims`가 아니다.** verdict는 gold 밖
claim에 요구되므로 인용 claim에도 붙고, 제외된 `support` claim에도 **기입할 수
있다**(그쪽은 필수가 아니다 — `unruled` 검사가 채점 대상만 읽는다). 원시 배열을
훑으면 그 둘이 지어낸 발견으로 세어진다. 단독 `support`에는 특례가 없다 — 제외
사유가 없어 모집단에 남고, 그 다음은 같은 세 조건으로 판정한다.

`outsideGoldVerdict`에 별도의 "gold 밖인가" 검사는 필요 없다.
`verifyJudgementRecord()`가 gold 안 claim에 이 field 쓰는 것을 거절하므로,
검증된 기록에서 존재가 곧 그 사실이다.

#### 실행 전체가 먼저다

**case 하나가 검증됐다는 것과 실행을 집계할 수 있다는 것은 다르다.**
`aggregateJudgedRun()`은 숫자를 만들기 **전에** 다음을 판정하고, 하나라도 걸리면
비율을 내지 않는다.

1. 계획의 `(caseId, observationRef)` 중복은 **거절**한다 — 조용히 지우지 않는다.
2. "계획이 비었다"와 "아무것도 판정되지 않았다"는 **서로 다른 거절**이다.
3. 모든 증거는 공유 경로 `verifyJudgedScoringEvidence()`를 지나며, 실행의 journal과
   frozen dataset은 **실행 단위로 한 번** 주어진다.
4. 신원은 **검증된 artifact의** `caseId`·`observationRef`에서 온다. 호출자가 항목에
   붙인 label로 잇지 않는다.
5. 계획과 증거를 **양방향으로** 대조한다 — 계획됐는데 판정되지 않은 것, 판정됐는데
   계획에 없는 것 둘 다 blocker다.
6. **실행의 dataset을 통째로 먼저 받아들인다.** `datasetProblems()`와
   `freezeDrift()` — 평가 set 자신의 검사기 — 를 실행 단위로 한 번 돌리고,
   걸리면 **case를 하나도 읽기 전에** 거절한다.
7. **그리고 그것이 이 실행의 dataset인지 확인한다.** 실행이 기록한
   `manifest.datasetDigest`를 입력으로 받아 지금 건네진 set의 digest와 대조한다.
8. **phenomenon은 판정 case에 없다.** 위에서 받아들인 dataset에서 읽는다.

**6번이 없으면 "frozen dataset"은 주석의 단어일 뿐이다.** 세 가지가 그 틈으로
지나갔다.

- **id 중복.** 공유 검증기는 같은 id의 **첫** 항목을 읽고, 집계기는 순회하며
  **마지막** 항목으로 덮어썼다. 끝에 같은 id의 행을 하나 붙이면 판정도 artifact도
  그대로인 채 case가 분모에서 빠졌다.
- **동결 미확인.** 동결 기록이 없는 set, `frozenDigest`가 내용과 어긋나는 set이
  모두 집계됐다. **`datasetDigest()`는 `phenomenon`을 덮으므로**, 실행을 그 지문에
  결속하는 것이 phenomenon을 다른 유효값으로 바꾼 편집을 잡는 방법이기도 하다 —
  `sourceCaseDigest`는 질문과 답변만 덮으며, 그것은 의도된 범위다.
- **거절된 배열의 재순회.** `cases`에 `null`이 하나 있으면 공유 검증기가 이미
  문제를 반환한 뒤 집계기가 같은 배열을 다시 읽다가 예외로 죽었다. (검증기
  자신도 그 지점에서 죽었다 — `datasetProblems()`와 `adoptionProblems()` 양쪽에
  guard가 필요했다.)

**7번이 없으면 6번은 자기 일관성만 본다.** 편집한 파일을 **다시 동결**하면
`freezeDrift()`가 할 말이 없어지므로, 다른 유효한 동결본으로 바꿔 넣어도 옛 실행
증거가 통과했다 — 계획·journal·판정 기록·artifact를 하나도 건드리지 않고 미보고율이
1/2에서 0/1로 움직였다. **그래서 기대값은 실행이 적어 둔 것에서 와야 하고, 집계
시점의 dataset으로 다시 채우면 같은 구멍이다.** `manifest.datasetDigest`는 필수이며
없으면 blocker다 — 선택이면 검사가 opt-in이 되고 구멍이 남는다.

**`frozenAt`도 시각이어야 한다.** `isNonEmptyString`만 보면 `"not-a-date"`가
"동결 기록이 있다"를 만족시키면서 내용을 아무 시점에도 묶지 않고, 동결 시각을
비교하는 쪽은 `NaN`을 받아 조용히 아무것도 비교하지 않는다
(`Date.parse(preRegisteredAt) > Date.parse(frozenAt)` 같은 비교는 **false**가 된다).
`lib/aiReviewEvalRun.ts`와 `lib/routerQualityEvalSet.ts`의 `freezeDrift()`가 같은
결함을 들고 있었고 둘 다 고쳤다. 회귀는 **날짜만 틀리고 지문은 정상인 경우**로
고정한다 — 둘을 동시에 깨뜨리면 지문 거절만으로 통과하고, 날짜 검사는 검사되지
않는다.

**여기서 정하지 않은 것: decision set이어야 하는가.** `decisionDatasetProblems()`는
`purpose: "decision"`을 추가로 요구한다. 판정 실행을 development set에서 집계해도
되는지는 아무도 답하지 않았으므로 요구하지 않는다.

**분모 0은 0%가 아니다.** `rate`·`wilsonLower`·`wilsonUpper`가 `null`이고
`insufficientEvidence`가 그 사실을 문장으로 들고 다닌다.

#### arm 단위 집계 (2026-09-10 승인)

게이트는 언어 격차 규칙과 과제 arm shortfall 규칙을 **읽는 모든 지표에** 적용하므로,
judged 지표가 게이트에 닿으려면 arm별 수치가 있어야 한다.
`aggregateJudgedRun()`이 `byLanguage`·`byTaskType`를 낸다.

- **arm은 자기 case로 계산한다.** aggregate를 arm 비중으로 나누면 어느 모집단에
  대한 비율도 아닌 숫자가 나온다 — 음성 부분집합에서 이미 한 번 고친 실수다.
  run과 arm이 **같은 함수**(`metricsOver()`)를 쓰므로 서로 다른 규칙으로 계산될 수
  없다.
- **arm·phenomenon 모두 판정 case에 없다.** 동결 dataset에서 읽으며,
  `datasetProblems()`가 언어·과제 어휘를 이미 검사했다. 둘 중 하나라도 없는 case는
  blocker다.
- **case가 없는 arm은 생략한다.** 0의 행으로 적지 않는다 — 없는 arm과 아무것도
  재지 못한 arm은 다른 사실이고, 어느 쪽인지 말하는 것은 게이트의 arm 적용 범위
  규칙이다. arm 안에서 분모가 0이면 그 arm의 해당 지표가
  `insufficientEvidence`다.
- **격차도 shortfall도 계산하지 않는다.** `maxLanguageArmGap`·
  `maxTaskTypeArmShortfall`은 **승인되지 않은 숫자**이고, 승인되지 않은 비교를
  실제 수치 옆에 출력하면 판정처럼 읽힌다. 비교는 게이트의 일이다.

**이 보고는 점수를 포함한다.** `npm run report:ai-review-judged-run`은 aggregate
지표와 arm별 비율·Wilson 구간을 함께 내므로, **임계값을 고르기 전에 실행하면 안
된다** — 결정안 `.github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md` §3.6이
관측된 성능에 맞춘 임계값을 금지하고, 이 출력이 바로 그
성능이다.

**임계값을 고르기 전에 쓰는 것은 `npm run report:ai-review-judged-denominators`다.**
동결된 set(과 선택적으로 판정 case의 gold)에서 **분모만** 내며, 검토자 출력·판정
기록·점수를 **읽을 수단이 없다**(`tests/aiReviewJudgedDenominators.test.mjs`가
정적으로 고정). 미보고율 분모는 판정 case를 주지 않으면 **상한**이고 출력이 그렇게
밝힌다 — 판정 gold는 dataset의 키워드 gold와 별도로 작성되기 때문이다.

**게이트는 여전히 연결되지 않았다.** 전환 범위는 2026-09-10에 승인됐지만
aggregate 상한 두 값과 arm 숫자 두 개는 승인되지 않았고, 값이 없으면 새 threshold
집합을 만들 수 없다. 근거와 선택 자료는
`.github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md`.

#### 저장된 실행을 읽는 호출자

`npm run report:ai-review-judged-run`
(`scripts/report-ai-review-judged-run.mjs`). **보고 전용이다** — 어느 입력 파일도
쓰지 않고, 승인·승급 판정을 내리지 않으며, 집계 가능 여부와 무관하게 종료 코드 0이다.
거절은 그 실행에 대한 참인 진술이고 build 실패가 아니다.

```
npm run report:ai-review-judged-run -- \
  --run=<실행 artifact .json> --journal=<실행 journal .jsonl> \
  --dataset=<동결된 평가 set .json> --judgements=<case별 bundle 디렉터리>
```

`--judgements`는 `score:ai-review-judgements`가 쓰는 것과 같은 배치다 —
`<caseId>/{case,observation,record,artifact}.json`.

**두 입력은 출처가 계약이다.**

- **`manifest.datasetDigest`는 실행 artifact의 `summary.datasetDigest`에서만
  읽는다.** 건네받은 dataset으로 계산하면 **실패할 수 없는 비교**가 되고, 출력은
  정상 실행과 똑같이 보인다. 입력으로 재현할 수 없는 조건이므로
  `tests/aiReviewJudgedRunReportCli.test.mjs`가 **정적으로** 고정한다 — CLI는
  `datasetDigest()`를 부를 수단 자체를 갖지 않는다.
- **계획은 판정이 존재하는 항목에서 역으로 만들지 않는다.** 동결 set이 어떤 case가
  있었는지, 실행의 journal이 각 case가 어떤 출력을 냈는지, 실행이 기록한
  `plannedCases`·`completedCases`가 그 둘과 맞는지를 함께 본다. 기록이 설명하지
  못하는 것은 **거절**이다 — bundle을 지우면 실행이 줄어드는 것이 아니라 막힌다.
- **대조는 양방향이다.** set을 돌며 journal을 찾기만 하면, set에 없는 case의 journal
  항목은 **아무 데서도 눈에 띄지 않는다** — 그냥 빠지고 남은 둘이 1/2로 집계됐다.
  자리를 댈 수 없는 출력을 들고 있는 기록은 이것이 읽을 수 있는 기록이 아니다.
- **`completedCases`는 journal 행 수가 아니다.** 실행기는 실패한 호출도 journal에
  적고(`observation` 없이), 출력을 낸 항목만 완료 수에 센다. 행 수와 비교하면
  **공급자 실패 1건이 있는 정상 실행을 "기록이 자기모순"으로 보고**하게 되는데,
  틀린 판정이고 운영자를 엉뚱한 파일로 보낸다. 실패 항목은 **"그 case가 출력을 내지
  못했으므로 계획을 완성할 수 없다"**는 별개 사유로 보고하고, `completedCases`와
  `plannedCases`가 다르면 그 자체로 **전체 계획을 재지 못한 실행**이다.

중도 중단된 실행이 이 규칙이 지키는 경우다. 남은 판정들이 전부 온전해도 그 실행은
온전하지 않으며, 집계하면 **부분 실행이 완전한 실행으로 보고된다.**

### 아직 정해지지 않은 것

- **gold 밖 requirement id의 배정 개수.** 위 C1의 마지막 항목이다. 같은 문장에
  id를 하나 배정하면 FP 1, 둘 배정하면 FP 2다. 규칙이 없다.

**§5가 거의 비었다는 것이 계약이 승인됐다는 뜻은 아니다.** 이 문서는 여전히
미승인 설계안이고 어떤 평가에도 연결돼 있지 않으며, 후보 채택·dataset 동결·품질
임계값 승인·M5 승급은 각각 별개의 사람의 행위다.

## 6. 구현 범위

**이번에 한 것**

- `lib/aiReviewEvalJudgement.ts` — 타입과 `verifyJudgementRecord()`,
  `scoreJudgedCase()`. 순수 함수이며 파일도 DB도 provider도 읽지 않는다.
- `AI_REVIEW_SCORING_CONTRACT_VERSION` — 기록이 어느 계약으로 쓰였는지. 다른
  버전의 기록은 **변환하지 않고 거절한다.**
- `tests/aiReviewEvalJudgementScoring.test.mjs` — 위 표를 요구로 표현.
- `judgedScoredClaims()` — 채점되는 claim의 모집단. `scoreJudgedCase()`가 쓰고,
  집계기가 같은 함수를 쓴다. 목록을 두 벌 두지 않기 위해서다.
- `lib/aiReviewJudgedRunAggregate.ts` — 실행 단위 집계기(2026-09-09 승인).
  순수 함수이며 파일도 DB도 provider도 읽지 않는다. **승인 게이트에 연결돼 있지
  않다.**
- `scripts/report-ai-review-judged-run.mjs` — 저장된 실행 기록을 읽어 위 집계기를
  부르는 보고 전용 CLI. 쓰기도 게이트도 아니다.
- `tests/aiReviewJudgedRunAggregate.test.mjs`,
  `tests/aiReviewJudgedInventedFindings.test.mjs`,
  `tests/aiReviewJudgedRunReportCli.test.mjs` — 위 규칙을 요구로 표현. 마지막 것은
  **파일을 통해** 확인한다(정상 왕복, 판정 누락, 중도 중단, 기록 자기 불일치,
  **journal에 기록된 공급자 실패**, **계획 밖 journal 항목**, manifest 누락,
  재동결본 교체, bundle 파일 누락, 입력 바이트 무변경, 분모 0).

**v2에서 더한 것**(2026-09-08 승인, 위 절)

- `AiReviewJudgedClaim.role`과 `.sufficiency`, 그리고 그 둘의 배치 규칙을
  강제하는 `verifyJudgementRecord()`·shape 검사.
- `AiReviewJudgedKindOutcome.supportClaims`와 `.insufficientFindings` —
  숫자 안에 접어 넣지 않고 따로 센다.
**v3에서 더한 것**(2026-09-09 승인, 위 절)

- `verifyJudgementRecord()`의 C1 검사 — 같은 제출 항목에서 나온 동일 판정의
  반복을 **거절**한다. 구조적인 곳에서만 검사하며, D의 의미 판정은 검사로
  만들지 않는다.
- `docs/ops/ai-review-eval-runbook.md` §1.3d — 등록·채택 규칙. 코드가 아니라
  사람이 지키는 자리다.

- `npm run draft:ai-review-judgement -- --dir <디렉터리>`
  (`scripts/draft-ai-review-judgement.mjs`) — 제출된 발견마다 `pending` claim
  하나로 된 기록 뼈대를 쓰고, 사람이 채운 뒤에는 **채점기와 같은 검사**를 돌려
  무엇이 남았는지 말한다. **판정하지 않는다** — 어느 답변인지, 없다는 것인지
  있다는 것인지, 발견인지 설명인지, 충분한지는 전부 읽어야 답할 수 있다.

- `validateJudgedCase()` — case 등록 검증. 채점기가 먼저 돌린다.
- `observationRefFor()` · `judgedCaseDigest()` · `judgementRecordDigest()` ·
  `buildScoringArtifact()` · `verifyScoringArtifact()` — 점수를 자기가 계산된
  것들에 결속하고, **저장된 outcome을 재계산해 대조**.
- `verifyRecordAgainstObservation()` — 기록이 실제 출력을 읽었는지.
- shape 검사 넷 — 파일 입력의 런타임 타입 검증.
- `verifyJudgedScoringEvidence()` — 공유 진입점. journal·dataset 대조와 집계
  적격성 판정을 포함하며, CLI와 `verifyEvidenceBundle()`이 함께 부른다.
- `scripts/score-ai-review-judgements.mjs`와 파일 흐름 회귀
  (`tests/aiReviewJudgementScoringCli.test.mjs`).

**하지 않은 것, 그리고 하지 않을 것**

- **승인된 평가에 연결하는 것** — 이 계약이 승인되고, 미승인 정책 둘이 정해진
  뒤의 일이다. `verifyEvidenceBundle()`은 이미 `judged`를 받지만 아무 평가도
  그것을 넘기지 않으며, 넘기지 않는 호출자는 오늘과 같은 검사를 받는다.
- 기존 `anyOf` 채점 제거 — 남기되 **키워드 진단값**으로 분리해 이름을 바꿔야
  한다. 지금 지우면 비교할 기준이 사라진다.
- 기존 점수·승인·임계값의 자동 승계 — **하지 않는다.** 새 계약의 숫자는 새
  `scoringContractVersion` 아래에서만 의미가 있다.
- 제품 AI Review의 출력 형식·API·DB·UI — **이번 범위 밖이다.** 검토자는 지금
  내는 것을 그대로 내고, 판정은 그 출력에 대해 사후에 만든다.

## 7. 이 계약이 없애지 못하는 것

**필수 항목 목록 자체가 옳은지는 여전히 사람이 판단한다.** requirement id는
"무엇이 필수인가"를 안정적으로 가리킬 뿐, 그 판단을 대신하지 않는다. v9 pilot의
002가 그 예다 — 재발화 방지 항목이 필수인지 아닌지에 따라 그 case의 누락이 하나
인지 둘인지가 갈리고, 그것은 어떤 기록 형식으로도 자동으로 정해지지 않는다.

이 계약이 하는 일은 좁다. **의미 판정을 사람이 한 번 하고, 그 판정을 기계가
일관되게 세게 하는 것**이다. 지금은 사람이 판정해도 그 판정이 점수에 도달할
경로가 없고, 문자열 검사가 그 자리를 대신 차지하고 있다.
