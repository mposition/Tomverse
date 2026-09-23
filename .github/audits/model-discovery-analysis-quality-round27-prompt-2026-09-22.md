# 27차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

26차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 4건을 고친 뒤의
`git diff`(커밋되지 않은 워킹 트리)를 검토해 주세요. 코드를 수정하지 말고
한국어로 답해 주세요.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

비표준 구간 단어는 단어 경계로만 맞습니다. `research`는 `search`가 아니고,
`scales`는 `scale`이 아니며, `Flexible`은 `flex`가 아닙니다. 그 검사는
제목과 상위 제목에만 있습니다. 문단의 `built in browser search`,
`models and tools`, `Image and video prices are listed separately.`는
그 표를 비표준으로 만들지 않습니다.

문단에서 가격 명사로 여는 문장은, 수식어가 알려진 요율 단어일 때만 tier입니다.
`Turbo pricing`·`Batch prices`·`Fast pricing`은 tier이고,
`Transparent pricing`·`Current prices`·`New prices`·`Updated pricing`·
`Full pricing`은 아닙니다. 한 단어 제목 `Pricing:`은 `Pricing`과 같습니다.

공유 페이지에서 제목이 가리키는 SKU들만 부르는 문장은 그 SKU 각각의
사실입니다. `GLM-5.3-Flash and GLM-5.3-FlashX support a 128K-token context
window.`는 양쪽 다 128K입니다. 무명칭 문장은 여전히 어느 쪽도 아닙니다.
제목 밖의 모델이 같은 문장에 있으면(`GLM-5.3`과 함께 1M을 말하는 문장) 그
문장은 버립니다. 2026-09-22 `docs.z.ai` Flash 페이지가 그 모양이라,
Flash·FlashX의 컨텍스트와 최대 출력은 null로 남습니다.

`modelTier()`의 kind는 마지막 연속 구간의 첫 단어입니다.
`grok-3-mini-fast`는 `{word:"mini-fast", kind:"economy"}`입니다.
`whisper-large-v3-turbo`는 `{word:"turbo", kind:"speed"}`입니다.
`claude-opus-5-fast`는 세대 숫자에서 구간이 끊겨 `{word:"fast", kind:"speed"}`입니다.

파서 버전은 `2026-09-22.2`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 diff 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
