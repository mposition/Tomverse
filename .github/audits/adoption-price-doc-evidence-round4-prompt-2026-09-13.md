# 4차 검토 요청 — 공급자 문서 기반 가격·능력 증거

3차의 P1 3건, P2 2건에 대한 대응입니다. `git diff`(intent-to-add 포함)로 확인해
주세요. parser 버전 `2026-09-13.4`.

## 방향 전환 — 프로모션 판정 (P1-2, P2-2)

3라운드에 걸쳐 "프로모션 문장이 어느 모델에 적용되는가"를 줄·문단으로 연결하려다
매번 빈틈이 나왔습니다(다른 문단, 제목 아래, 계열 단위 공지). 이것은 산문 해석이라
규칙으로 닫히지 않는다고 판단해 **fail-closed 규칙으로 바꿨습니다.**

- 가격 페이지(Anthropic 가격 페이지, OpenAI 가격표)의 **모든 프로모션 문장**(문단을
  soft-break로 잇고 문장 단위로 분리)이 `ACKNOWLEDGED_PROMOTION_SENTENCES`에 **정확한
  텍스트**로 없으면 → 그 페이지가 공급하는 **모든 가격을 막음**(Anthropic 페이지 problem
  `unacknowledged_promotion_notice`, OpenAI 모델마다 `unacknowledged_promotion_notice_on_pricing_page`).
- 목록에 있는 문장은 `appliesTo`에 적힌 모델만 promotional로 표시.
  - Anthropic Sonnet 5 introductory → 정가가 됐다는 공지, `appliesTo: []`(AGENTS.md와 일치)
  - OpenAI "GPT-5.6 Sol’s promotional pricing ..." → `appliesTo: ["gpt-5.6-sol"]`.
    실제 가격표에서 이 문장이 무관한 공지 문단 안에 섞여 있어 문장 단위로 인정합니다.
- OpenAI **모델 페이지**는 한 모델만 다루므로 그 페이지의 프로모션 문장은 곧 그 모델의
  것(목록 불필요).
- 인정되지 않은 문장은 요약 `unacknowledgedNotices`로 Slack 줄과 이메일 공급자 행 노트에
  문장 원문과 함께 인쇄됩니다.

이 방향이 타당한지, 그리고 **문장 분리·정규화가 인정 목록 매칭을 조용히 통과시키거나
(다른 문장이 인정 문장으로 오인) 불필요하게 막는 경우**가 있는지 봐 주세요.

## P1-1 — touched·reasoning 확정의 pair 귀속

`draftPairRef`(provider, apiModel)를 따로 둡니다. 조회 타이머에서 **pair가 바뀌었으면**
손으로 입력한 값까지 followed 필드 전체를 비우고 touched를 초기화하며 reasoning 제안·확정도
초기화합니다. **id만 바뀌었으면** 기존대로 손대지 않은 prefill만 따라갑니다(같은 모델에 대해
입력한 값이므로). 성공 시 `draftPairRef`를 요청 pair로 갱신합니다.

## P1-3 — 중복 행

Anthropic 표준 표·batch 표, OpenAI 가격표에서 같은 정규화 이름이 두 번 나오면 해당
모델에 problem(`model_pricing_duplicate_row`, `batch_table_duplicate_row`,
`pricing_table_duplicate_row`).

## P2-1 — 이전 key의 안내 즉시 숨김

`guidanceKey` state를 두고, notes·unknowns·profile 제안은 `guidanceKey === lookupKey`일
때만 렌더합니다. 아니면 "다시 불러오는 중" 또는 실패 시 "불러오지 못했습니다" 한 줄.
debounce를 기다리지 않습니다(렌더 시점 파생).

## 특히 봐 주셨으면 하는 것

- pair 변경 후 400ms 안에 운영자가 새 pair에 대해 입력한 값이 타이머의 전체 초기화에
  지워지는 경우가 있습니다. 수용 가능한지, 더 안전한 대안이 있는지.
- 문장 분리 정규식 `(?<=[.!?])\s+`가 "US$2.50." 같은 소수점·약어에서 문장을 잘못 쪼개
  인정 문장이 매칭되지 않거나, 반대로 인정 문장과 같은 텍스트를 우연히 만드는 경우.
- 이 네 번의 라운드를 거친 뒤에도 **과소 과금 override로 이어지는 경로**가 남았는지.

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
