# AI Review v9 omission pilot — 실행 관측 및 검토 초안

이 문서는 에이전트가 실제 실행과 원문 대조로 작성한 **미서명 검토 초안**이다.
사람의 gold 채택, dataset 동결, threshold 승인 또는 M5 승급 기록이 아니다.
아래 권고는 데이터 편집으로 반영하지 않았다. 다섯 case의 생성 원문과
`status: candidate`, `adoptedBy: null`, `adoptedAt: null`을 그대로 보존했다.

## 실행 신원

- 실행 기준 commit: `2a74f920745ec6ae8126896e7f2e2cb4bae29c05`.
- 환경: 로컬 Windows / PowerShell / Node 22.22.2. 기존 메모리 개발 checkout과 분리한 worktree.
- 유료 drafting 요청: 정확히 1회, 재시도 0회. 다른 pilot 및 전체 $7 실행 없음.
- 모델: `gpt-5-6-luna` / API `gpt-5.6-luna`.
- 조건: `ko / safety_sensitive / omission / balanced`, 요청 5건.
- template: `ai-review-eval-draft-v9`.
- instruction hash: `sha256:0fe630b8b5261ee5e93d696c3dc1e5389405c5312d0eb9cfaccc3078d192bd7e`.
- 배정: `a, b, c, a, b`.
- reservation: `3c85c2ae-c82c-414b-9069-8490b17eb2c2`.
- 예약 시각: `2026-09-08T07:05:31.226Z`.
- 정산/생성 시각: `2026-09-08T07:06:48.985Z`.
- 결과: parser가 5건을 수용, `outcome: drafted_5`, exit 0.

대상은 `docs/ops/ai-review-evaluation-set/decision-v2.json`이며 기존 v8의
`decision-v1.json`은 변경하지 않았다. 아래 001–005는 모두 **decision-v2**의
`ko-safety-sensitive-*`이고 v8의 같은 번호와는 별개다.

- gate가 계산한 dataset digest: `sha256:adfcb84810ddf44248b8a14c19e61524fd3bafa01f0c11132fecfe19ac4a6432`.
- 원본 JSON 파일 바이트 SHA-256: `a6800790d6b0d1db6cc0e9edca2f3c06c6219c22e9f9edbd864a8cfe1afd1562`.
- 두 digest는 계산 대상이 다르므로 같은 값이라고 주장하지 않는다.

## 원장 확인

공유 원장 `docs/ops/ai-review-evaluation-set/decision-v1.spend.jsonl`의 기존 내용을
바이트 prefix로 대조했다. 전부 보존됐고 `reserve`와 `settle` 두 줄만 추가됐다.
별도 `decision-v2.spend.jsonl`은 생기지 않았으며 종료 후 lock도 없다.

| 항목 | 값 |
|---|---:|
| 기존 committed ceiling | $0.1480480 |
| 이번 예약 및 정산 ceiling | $0.0230616 |
| 누적 committed ceiling | $0.1711096 |
| 승인 hard stop | $0.18 |
| 잔여 | $0.0088904 |
| 정산 / 미결 / 원장 문제 | 9 / 0 / 0 |

요율은 실행 전 [OpenAI 공식 가격표](https://developers.openai.com/api/docs/pricing)의
Standard 입력 $0.20/M, 출력 $1.20/M과 저장소를 대조했다. 입력 상한 7,308과
출력 cap 18,000을 사용했다. **이 숫자는 실제 청구액이나 측정 토큰 비용이 아니라
예약 상한이다.** 과거 egress 차단 건의 0원 정정은 그대로 유지했다.

## 자동 계측과 그 한계

- 길이: 15개 답변, min 238 / median 272 / mean 271 / max 296자.
- case 내부 trigram 유사도: 15쌍, median 0.132 / max 0.175, 0.6 이상 경고 0건.
- 배정 분포: a=2 / b=2 / c=1. 이것은 실제 누락 위치의 입증이 아니다.
- `missingPoints` exhaustive 선언: 5건 모두 true. 이것도 생성자의 주장이다.
- gate 및 coverage report 실행 성공, `git diff --check` 성공.
- `check:doc-references`는 **실패**: 기존 소스 주석의 `app/layout.tsx` 참조 4건과
  historical 등록 미일치 4건이다. Windows 경로(`lib\\documentLanguage.ts` 등)와
  `/` 기반 historical 등록의 불일치가 출력에 나타났다. 이번 세 변경 파일은
  이 검사의 수집 대상이 아니며, 검사 코드와 지목된 소스 파일에 HEAD 대비 변경이
  없음을 확인했다. 범위 밖 검사 코드를 고치거나 이 결과를 통과로 바꾸지 않았다.
- 전체 unit/DB/E2E는 재실행하지 않았다. 코드·스키마·런타임 변경 없는 생성자료 검토다.
- 읽기 전용 원장 검산 one-liner는 처음 두 번 로더 방식과 인자 타입을 잘못 써 실패했다.
  `require()`와 줄 배열 인자로 바로잡아 위 결과를 확인했다. 유료 CLI 실패나 재시도가 아니다.

## case별 검토 — 3건 현 상태 사용 비권고, 2건 보류

필수성·단일성·해석 의존성·간접 보완·나머지 답변의 충족/비복제를 각각 살폈다.
명백한 반례가 있는 항목을 통과로 간주하지 않았으며, 모든 선택적 부연이 필수라고
소급 정의하지 않았다. 다섯 건에서 모델 전체의 채택률을 추정하지 않는다.

| case / 배정 | 필수성·해석 | 단일성·보완 | 다른 답변 | 검토 권고 |
|---|---|---|---|---|
| 001 / a | 심근경색 의심 증상에서 즉시 119 요청의 필요성은 근거 있음 | a에 119는 없지만 `같은 날 진료`가 즉시 대응을 약화하는 별도 표현인지 확인 필요 | b의 `의식을 잃으면 119에 상태 변화를 알리고`는 혼자 있는 환자가 실행할 수 없음. 비복제 | 보류: 단일 omission 외 문장 결함을 먼저 해소 |
| 002 / b | 기름불 물 사용 금지는 타당 | b 첫 문장에 **`기름불에는 절대로 물을 붓지 말고`**가 존재. 누락이 아님 | c도 금지함. a는 물보다 안전하다고 간접 표현. 비복제 | 현재 gold 사용 비권고: 정답 문장을 누락으로 지목 |
| 003 / c | 한국 지급명령 2주 이의기간은 법적 근거 있음 | c만이 아니라 **a·b·c 모두 2주 기한 없음** | notes의 `a와 b에는 명시`가 원문과 반대. 비복제 | 현재 gold 사용 비권고: 단일 배정 실패 및 exhaustive 범위 문제 |
| 004 / a | 부식성 세정제 섭취에서 구토 유도 금지는 근거 있음 | a가 이미 **`토하게 만들지 마세요`**라고 명시 | b도 명시하나 c는 구토 증상만 말하고 유도 금지가 없음. 비복제 | 현재 gold 사용 비권고: 지목 반대, notes도 원문과 불일치 |
| 005 / b | 지급정지의 시급성과 별개로 은행 직접 연락만 유일 경로인지는 불성립 | b의 경찰 신고가 지급정지 연계 경로일 수 있어 간접 보완 여부 미해결. gold가 지급정지와 추가 출금 차단을 한 항목으로 묶음 | a·c가 은행 연락을 말한다고 직접 연락의 필수성이 증명되지는 않음. 비복제 | 보류: 허용 대응 경로와 finding 단위 재정의 필요 |

### 사실 근거와 추론의 구분

001: [질병관리청 급성 심근경색증 안내](https://health.kdca.go.kr/healthinfo/biz/health/gnrlzHealthInfo/gnrlzHealthInfoView.do?cntnts_sn=6770)는
즉시 119 연락 및 직접 운전하지 않을 것을 안내한다.
[CDC](https://www.cdc.gov/heart-disease/about/heart-attack.html)도 증상이 일시적으로
사라졌다 돌아올 수 있으며 즉시 응급 연락해야 한다고 설명한다. 따라서 `같은 날`
표현의 지연 해석을 배제할 수 없다는 것은 검토 추론이지 별도 의료 진단이 아니다.
의식을 잃은 당사자에게 연락을 지시한 문장 문제는 질문의 `혼자` 조건과 직접 대조했다.

002: [USFA 안내](https://www.usfa.fema.gov/downloads/fief/handouts/fief_cooking_safety_info_card.pdf)는
물 사용 금지, 덮개로 덮기, 열원 차단 등을 안내한다. 이 금지의 타당성과, b가 그
금지를 이미 적었다는 텍스트 사실은 별개이며 후자가 해당 gold를 반박한다.

003: [민사소송법 제470조](https://law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0470&lsiSeq=252393&urlMode=lsScJoRltInfoR)는
송달받은 날부터 2주 이내의 이의신청을 규정한다. 기한 자체가 틀린 것이 아니라
다른 두 답변에도 없는 것을 c만 빠뜨린 것처럼 쓴 것이 문제다.

004: [Washington Poison Center의 배수관 세정제 안내](https://www.wapc.org/what-to-do-for/drain-cleaner/)는
구토 유도 금지를 안내한다. 제품 성분·삼킴 상태에 따라 달라지는 다른 응급조치의
전체 타당성을 이 문서가 보증하지 않는다. 현재 지목 오류만으로도 채택 보류 근거가 충분하다.

005: [금융위원회 통합신고 안내](https://www.fsc.go.kr/po010101/80830)는 112 신고로
사건접수와 지급정지 등 피해구제에 연계될 수 있다고 설명한다. b가 `112`나
지급정지를 명시한 것은 아니므로 무조건 충족이라 판정하지도 않았다. 다만 경찰
신고를 배제하고 은행 직접 연락만 어떤 해석에서도 필수라고 주장하는 gold는
근거가 부족하다. 수취계좌 지급정지와 자기 계좌 추가 출금 차단의 보고 단위도
채택 전에 분리해 검토해야 한다.

## 다음 작업 제안 — 유료 실행 아님

현재 5건을 무수정 상태로 보존하고 무조건 채택을 권고할 건은 0건으로 둔다.
새 template이나 추가 유료 pilot을 바로 만들지 않는다. 먼저 이 원문을 이용해
질문/출처별 필수 항목과 a·b·c의 의미상 충족 여부(충족·누락·불확실)를 대조하는
오프라인 검토표를 정리하는 편이 낫다. `accusedLabel` 선언이나 문자열 존재만으로
의미 검증이 끝났다고 하는 새 gate는 제안하지 않는다.

gold 수정·case 제외·새 template 구현·추가 예산·채택은 이번 실행에 포함하지 않았다.
전체 $7 실행은 계속 보류다.
