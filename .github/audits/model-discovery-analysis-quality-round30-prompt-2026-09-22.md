# 30차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

29차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

공유 페이지에서 두 SKU가 한 주어로 나올 때, 그 문장의 토큰 수치가 통틀어
한 번일 때만 그 수치를 나눕니다. 패턴이 알아본 횟수가 아닙니다.
`GLM-5.3-Flash and GLM-5.3-FlashX support a 128K-token context window.`는
양쪽 128K입니다.
`GLM-5.3-Flash and GLM-5.3-FlashX support 128K- and 1M-token context windows,
respectively.`는 수치가 두 번이므로 어느 쪽에도 주지 않습니다.

`cache`가 문장 앞에 있다는 이유만으로 표를 버리지 않습니다.
`cache`·`caching`·`cache write(s)`·`cache storage`가 가격 명사를 최대 두
단어 안에서 수식할 때만 tier입니다. 가격 명사 바로 뒤의 같은 말도 같습니다.
`Caching prices`와 `Prices for cache writes`는 tier입니다.
`Cache hits are billed at 10% of the input rate.`와 `Cached input prices
are listed below.`는 tier가 아닙니다.

파서 버전은 `2026-09-22.5`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
