# 35차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

34차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

선택 표현은 `the latter`만이 아닙니다. 비교급(`the faster`)과
`the … model|variant|version|tier|sku|one`도 한 주어가 아닙니다.
`the faster model supports a 1M-token context window`는 어느 SKU도 1M을
받지 않습니다. `the first token arrives in under 200 ms`는 그 문장의
1M을 지우지 않습니다.

별칭은 제목에 적힌 대소문자만 맞습니다. `flash attention`은 Flash가 아닙니다.
`Flash-series`처럼 별칭 뒤에 하이픈이 붙으면 그 SKU만의 이름이 아닙니다.
`all`, `both`, `series`, `family`, `models`가 있고 제목의 SKU 중 일부만
보이면 프로모션은 제목의 모든 SKU에 적용되고, 크기 사실은 어느 쪽에도
주지 않습니다.

OpenAI 모델 페이지의 미검토 프로모션은
`unacknowledged_promotion_notice_on_model_page`로 남고, 일일 리포트에는
다른 공급자와 같이 모델 페이지 문장으로 찍힙니다.

파서 버전은 `2026-09-22.10`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
