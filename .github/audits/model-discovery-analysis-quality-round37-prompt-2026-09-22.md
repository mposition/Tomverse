# 37차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

36차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

절 경계는 별칭의 짧은 글자가 아니라 그 글자가 가리키는 전체 이름으로
제목과 대조합니다. 숫자까지의 거리는 페이지에 적힌 글자 길이입니다.
`# GLM-5.3-Flash/FlashX` 아래
`Flash and FlashX are multimodal, and the second supports a 1M-token
context window.`는 어느 SKU도 1M을 받지 않습니다.

마지막 이름과 수치 사이에 새 주어가 있으면 그 수치는 그 이름들의 것이
아닙니다. 쉼표가 없어도 같습니다.
`GLM-5.3-Flash and GLM-5.3-FlashX are multimodal and the second supports
a 1M-token context window.`는 어느 쪽도 1M을 받지 않습니다.
`… support a 1M-token context window, and the first token arrives in
under 200 ms`는 이전과 같이 양쪽이 1,000,000을 받습니다.
`… currently support text-only inputs, with a 1M-token context window
and a maximum output length of 128K tokens`도 이전과 같이 양쪽이 둘 다
받습니다.

파서 버전은 `2026-09-22.12`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
