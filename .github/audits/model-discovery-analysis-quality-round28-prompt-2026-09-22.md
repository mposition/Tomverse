# 28차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

27차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

공유 페이지에서 제목 SKU가 둘 이상 나오는 문장은, 그 수치가 문장에 한 번만
있을 때 그 SKU들이 같은 값을 가진 것으로 읽습니다.
`GLM-5.3-Flash and GLM-5.3-FlashX support a 128K-token context window.`는
양쪽 128K입니다.
`GLM-5.3-Flash has a 128K-token context window and GLM-5.3-FlashX has a
1M-token context window.`는 수치가 두 번이므로 어느 쪽에도 주지 않습니다.
무명칭 문장과, 제목 밖 모델이 섞인 문장은 이전과 같습니다.

문단에서 요율로 읽는 것은 가격 명사 **앞**에 있는 요율 단어입니다.
`Batch API prices`, `Flex API prices`, `Turbo API rates`,
`Discounted rates`는 tier입니다.
`Image prices`, `Video prices`, `Search prices`, `Tool prices`,
`Transparent pricing`, `Current prices`는 tier가 아닙니다.
`image`·`video`·`search`·`tool`은 무엇의 값인지를 말하는 말이라 문단
요율 목록에 없습니다. 제목이 그 단어를 말하면 비표준 구간 검사는 그대로입니다.

제목의 `cache writes`도 비표준입니다. 파서 버전은 `2026-09-22.3`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
