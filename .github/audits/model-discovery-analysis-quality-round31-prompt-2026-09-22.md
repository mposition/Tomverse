# 31차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

30차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

`Compared with GLM-5.3-Flash, GLM-5.3-FlashX supports a 1M-token context
window.`는 한 주어가 아닙니다. 첫 이름 앞에 `Compared with`, `Unlike`,
`Versus`, `Like`, `Besides`, `Apart from`이 있으면 그 문장의 수치는 어느
SKU에도 주지 않습니다.

한 주어 문장에서 토큰 수치가 둘이면, 각각이 서로 다른 사실(컨텍스트 하나,
최대 출력 하나)에 속할 때만 나눕니다.
`GLM-5.3-Flash and GLM-5.3-FlashX currently support text-only inputs, with a
1M-token context window and a maximum output length of 128K tokens.`는
양쪽 모두 컨텍스트 1,000,000, 최대 출력 128,000, 이미지 입력 없음입니다.
`128K- and 1M-token context windows, respectively`는 같은 사실에 수치가
둘이므로 어느 쪽에도 주지 않습니다.

`Prices below include cache write rates`와 `Prices include cache storage
rates`는 표준 표입니다. `include`가 cache 구보다 앞에 있으면 그 구는 요율이
아닙니다. `Caching prices`와 `Prices for cache writes`는 요율입니다.
이 구분은 주석에도 그대로 적혀 있습니다.

파서 버전은 `2026-09-22.6`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
