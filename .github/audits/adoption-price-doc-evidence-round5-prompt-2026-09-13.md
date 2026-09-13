# 5차 검토 요청 — 공급자 문서 기반 가격·능력 증거

4차 P1 4건, P2 3건에 대한 대응입니다. `git diff`(intent-to-add 포함), parser 버전
`2026-09-13.5`.

## P1-3에 대한 입장 — 통제를 키워드에서 운영자 확인으로 옮김

"임시 가격" 표현은 키워드 목록으로 완전히 잡을 수 없습니다(`temporary pricing`을
넣으면 `short-term rate`가 남습니다). 그래서 **키워드 탐지를 통제에서 조기 경고로
내리고, 통제를 운영자 확인으로 옮겼습니다.**

- 문서에서 가격을 채우면 초안이 `suggestions.price: true`를 줍니다. 패널은 가격 칸 위에
  "출처 문서와 대조했습니다" 확인을 요구하고, **확인 전에는 저장 버튼이 비활성**입니다
  (reasoning 확정과 같은 방식). 운영자가 가격 칸을 직접 고치면 확인한 것으로 봅니다.
  pair가 바뀌거나, id 변경으로 손대지 않은 가격이 다시 채워지면 확인이 초기화됩니다.
- 그 위에 기존 통제가 그대로 있습니다: 채택된 모델은 `coming-soon`·비공개이고, lifecycle의
  `pricing` 검증을 사람이 완료해야 rollout이 됩니다.
- 키워드는 넓혔습니다: `temporar`, `special (launch) rate/price`, `launch rate/price`,
  `(through|until|ends|expires) <Month> <d>, <yyyy>`. 실제 fixture에서 새로 걸리는 문장은
  없음을 확인했습니다. `discount`는 제외했습니다 — Anthropic 페이지에서 batch·볼륨·private
  offer 문장 15개가 걸려, 인정 목록이 매 문서 수정마다 깨지고 prefill이 사실상 불가능해집니다.

이 계층 구조로 P1-3을 **잔여 위험(P2)** 로 판정할 수 있는지, 아니면 여전히 P1인지와 그
근거를 명시해 주세요.

## P1-1 — pair 변경 핸들러에서 즉시 초기화

`startNewPair()`를 Provider select와 API model 입력의 onChange에서 **변경 즉시** 호출합니다.
followed 필드 전체·touched·reasoning 확정·가격 확정을 그 자리에서 초기화하므로, 이후
타이머는 id-only 분기만 가집니다. debounce 중 새 pair에 입력한 값은 보존됩니다.

## P1-2 — profile의 pair 귀속

draft 라우트와 save 라우트 모두 profile을 **정확한 pair(`provider`, `apiModelId`)가 맞을 때만**
상속으로 봅니다. id의 profile이 다른 pair면 draft는 unknown("이 ID로는 저장되지 않습니다")을
내고, save preflight(`profileForOtherPair`)는 409로 거절합니다.

## P1-4 — 폭이 다른 행

OpenAI 가격표·Anthropic 표준 표는 행 폭이 다르면 **표 전체를 거부**(`rows: null`),
Anthropic batch 표는 페이지 problem(`batch_table_row_malformed`)으로 모든 행을 막습니다.

## P2

1. 빈 ID에서는 guidance를 current로 보지 않고 "Registry ID를 입력하면 초안을 다시 불러옵니다"를 표시.
2. 문단 정규화에서 줄 앞 `- `, `* `, `+ `, `1. `, `> ` 제거. bullet로 옮긴 인정 문장 테스트 추가.
   약어로 쪼갠 뒤 suffix가 인정 문장과 같아지는 경우는 인정 문장이 그 앞 한정 문구를 잃는
   형태인데, 이것은 새 확인 게이트로 덮인다고 봅니다.
3. reasoning "이 값으로 확정" 버튼이 touched를 기록.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
