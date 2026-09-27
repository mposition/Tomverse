# 38차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

37차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

모달리티도 수치와 같은 새 주어 규칙을 탑니다.
`GLM-5.3-Flash and GLM-5.3-FlashX are generally available, and the second
accepts images.`는 어느 SKU도 이미지 입력을 받지 않습니다.

새 주어는 한정사 뒤에 그 한정사의 동사가 있을 때입니다.
`support the same 1M-token context window`는 양쪽이 1,000,000을 받습니다.
`and the second supports a 1M-token context window`는 어느 쪽도 받지 않습니다.

한 문장에 같은 종류의 수치가 둘이면 공유 페이지가 아니어도 어느 쪽도
받지 않습니다.
`Where the previous generation offered a 128K-token context window,
GLM-5.3-Flash offers a 1M-token context window.`는 컨텍스트가 비어 있습니다.

파서 버전은 `2026-09-22.13`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
