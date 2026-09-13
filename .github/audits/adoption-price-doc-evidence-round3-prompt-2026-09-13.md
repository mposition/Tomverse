# 3차 검토 요청 — 공급자 문서 기반 가격·능력 증거

2차에서 제기하신 P1 6건, P2 3건에 대한 대응입니다. `git diff`(intent-to-add 포함)로
확인해 주세요. parser 버전은 `2026-09-13.3`으로 올렸습니다.

## P1

1. **pair 변경 시 capability·reasoning 이동** — `DRAFT_FOLLOWED_FIELDS`에
   `contextWindowTokens`, `supportsImage`, `supportsNativePdf`, `reasoning`을 추가했습니다.
   빈 값은 `DRAFT_FIELD_BLANK`(숫자 null, 불리언 false, reasoning "none"). 각 입력의
   onChange가 touched를 기록합니다. key가 바뀌면 이전 key의 notes·unknowns·profile
   제안을 즉시 지우고 "다시 불러오는 중"을 표시하며, reasoning을 손대지 않았다면 제안·
   확정 상태도 초기화합니다. 조회 성공 시 새 초안의 suggestions로 reasoning 제안을
   다시 세웁니다. 실패 시 unknowns는 "불러오지 못했다" 한 줄입니다.
2. **profile 제안 id** — `buildAdoptionDraft`에 `registryModelId`를 추가해 제안이
   폼의 id(`requestedModelId || proposedId`)로 생성됩니다.
3. **Anthropic 출력 단가** — 같은 페이지 Batch 표를 독립 진술로 씁니다. 섹션의
   "50% discount on both input and output tokens" 문장을 확인하고, 표준 입력·출력이
   batch의 정확히 2배인지 검사합니다. 문장을 못 읽거나 표 모양이 바뀌면 페이지 전체
   problem, 모델이 batch 표에 없으면 행 problem. 재현하신 `$5 / MTok` 변형을 테스트로
   고정했습니다.
4. **각주 번호** — cache hits 외 모든 가격 열에서 `MTok<숫자>` 접미사는
   `footnote_unreadable:<열>` problem입니다.
5. **줄바꿈된 프로모션** — 페이지를 빈 줄 기준 문단으로 나누고 soft line break를
   이어 붙인 뒤(`paragraphs`) 프로모션 단어와 모델명을 문단 단위로 매칭합니다. OpenAI
   모델 페이지, OpenAI 가격표, Anthropic 페이지 세 곳 모두. 재현하신 두 변형을 테스트로
   고정했습니다.
6. **longContext 혼합 키** — 저장 행의 `fields` 최상위, `longContext`의 각 kind,
   `promotional`에 **정확한 키 집합**을 요구합니다. 여분 키나 누락 키는 행 전체 거부.

## P2

1. `Input modalities`가 `단어(, 단어)*` 형태가 아니면 `input_modalities_unreadable`
   problem, `imageInput`은 null.
2. 이메일: `docEvidenceProviderNote`가 OpenAI/Anthropic 공급자 행의 기존 `note`에 문서
   결과(실패·degraded 최대 3개, 미수집 수, 수집 자체 실패)를 붙입니다. 템플릿 변경 없음.
3. 제안의 `effectiveDate`는 `EFFECTIVE_DATE_TO_DECIDE`(컴파일 안 됨)이고, 주석에 읽은
   날(verified)을 적습니다.

## 특히 봐 주셨으면 하는 것

- 문단 매칭이 **넓어진 만큼** 다른 모델까지 프로모션으로 걸 수 있습니다(채우지 않는
  방향). 반대로 여전히 **놓치는** 형태가 있는지.
- Anthropic batch 교차 검증이 표준 표의 한 행과 batch 표의 한 행을 같은 이름으로
  잇는데, 이름 정규화가 두 표에서 달라 조용히 통과하거나 전부 막히는 경우가 있는지.
- 패널: key 변경 즉시 notes·unknowns를 지우는 것이 초기 로드 직후의 재조회(같은 key)에서
  잘못 일어나지 않는지, reasoning 확정 게이트가 pair 변경 뒤 확정 없이 풀리는
  경로가 없는지.

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
