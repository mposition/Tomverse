# 24차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

23차 P2 8건 대응입니다. 두 건이 문서 리더 밖(A2·A3)에서 나온 첫 회차였고, 둘 다
실제 결함이었습니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 분석 본체 2건

- **sibling wave의 비결정적 순서.** 지적대로 `waveRows.findMany()`에 정렬이 없어
  DB가 돌려주는 순서가 그대로 분석 문구가 됐고, 화면과 제외 재계산이 다른 순서를
  받으면 정상 제외가 `ANALYSIS_CHANGED`로 막혔습니다. **질의에 `orderBy`를 넣고
  계산(`sameWaveSiblings`)에서도 정렬**했습니다 — 다른 호출자가 어디서 읽어오든
  같은 항목이 자기 자신을 같은 문장으로 설명하도록.
- **복합 tier ID.** `modelGenerationFamily()`가 tier 단어를 **전부** 제거합니다.
  `gemini-3.5-flash`와 `gemini-3.5-flash-lite`가 이제 같은 family(`gemini`)입니다.

## 문서 리더 6건 — 개념적으로 둘

**범위 한정은 두 종류입니다.**

- `in the table below` → 그 표를 가리킴 → 표 자리에서 선언이 됨
- `in the table above` · `for regional customers` · `for input` → 이 표에 대해
  아무 말도 하지 않음 → **귀속 불가**

`TABLE_SCOPE_FORWARD` / `TABLE_SCOPE_BACKWARD` / `OTHER_SCOPE_WORD`로 나눴고,
`for …` 꼬리가 열을 일부만 이름 대면(`for input`) 귀속 불가, 양쪽을 다 대면
(`for input and output`) 통과입니다. 통화 뒤의 부정
(`but cached input prices are not`)도 같은 취급입니다.

**절의 경계는 문장을 넘지 않고 주절이 재개되는 곳까지입니다.**
`including taxes. Batch prices…`가 다음 문장을 삼키던 것과
`including text, image, and tool prices,`가 첫 쉼표에서 끊기던 것이 같은 원인이었습니다.

나머지: `blocked`가 `usd`를 이기도록 했고(같은 prose 안에서도),
셀 단어 허용 목록에 `dollars?`·`united`·`states`·`american`을 넣었습니다.

## 행렬

corpus를 27 → 33문장으로 늘렸습니다(세 자리 99판정). 이번 지적 중 여섯이 corpus
항목으로 들어가 세 자리 모두에서 고정됩니다.

검증: 표 리더 90건, triage 46건, unit 10,084건(실패 0), `tsc` 무출력, 정적 게이트
9종 통과. 실제 픽스처는 그대로 읽힙니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 각 항목에 **방향(우회 / 과잉 차단)**, **자리**, **실제 공급자 문서에서
가능한 표기인지**를 표시해 주십시오.

23차처럼 **문서 리더 밖도 함께 봐 주시면 좋겠습니다** — A1(판정 우선 구조),
A2(포트폴리오 관계), A3(파동), A4(화면·locale), B1(출처 표), B3(수집기 예산·
라운드로빈). 반례는 수집기가 실제로 읽는 `.md` 구조를 기준으로 삼아 주시고,
코드를 수정하지 말고 한국어로 답해 주세요.
