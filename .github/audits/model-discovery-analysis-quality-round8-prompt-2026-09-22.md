# 8차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

7차 P2 4건 대응입니다. 3·4번은 같은 병(열거 목록은 닫히지 않는다)으로 보고 구조를
뒤집었습니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **xAI 이동은 실측으로 확인했습니다.** 2026-09-22 기준
   `https://docs.x.ai/docs/models.md`는 `308 -> /developers/models.md`이고,
   `redirect: "error"`이므로 지적대로 **현재 xAI 읽기가 전부 실패**하고 있었습니다.
   `pricingUrl`을 `https://docs.x.ai/developers/pricing.md`,
   `humanUrl`을 `https://docs.x.ai/developers/pricing`으로 갱신하고, 새 페이지를
   픽스처(`xai-pricing-2026-09-22.md`)로 저장했습니다. 옛 픽스처는 삭제했습니다.
   새 페이지에서 `grok-4.7` $2/$6·500k, `grok-4.3` $1.25/$2.5·1M, 200k 경계 ×2 tier가
   그대로 읽힙니다.
2. **모델 토큰 인식기.** 버전 뒤 영문자 접미사를 허용했습니다
   (`-\d+(?:\.\d+)*[a-z]*(?:-[a-z0-9.]+)*`). `gpt-4o`, `glm-4.6v`, `gpt-oss-120b`,
   `qwen3.8-27b`가 모두 하나의 식별자로 잡힙니다. `GPT-4o` 문장은 이제 귀속되지 않고,
   `glm-4.6v`는 자기 자신으로 인식됩니다.
3. **tier 판정을 수식어 검사로 바꿨습니다.** 명사는 넓히고
   (`processing|tier|lane|queue|mode|pricing|price|rate|cost|fee`), 그 앞 **수식어**가
   `STANDARD_PRICE_QUALIFIER`(standard/model/token/text/chat/llm/api/language/list/
   usage/base/input/output/latest/all)가 아니면 거절합니다. 수식어는 *무엇이 값
   매겨지는지*를 말해야 하고, *어떻게 제공되는지*를 말하면 표준 요율이 아닙니다.
   `## Fast mode pricing`, `## Priority Processing Pricing`, `## Grok 4.7 Fast pricing`,
   `### Flex pricing data`는 거절되고, `### Text API Pricing`,
   `### Standard pricing data`, `## Model pricing`은 읽힙니다.
4. **통화 판정의 질문을 뒤집었습니다.** 통화를 말하는 문장이 표 컨텍스트에 있으면
   그 문장이 USD를 말해야 합니다(`CURRENCY_STATEMENT` → `USD_PHRASE`). 열거에 없는
   `New Taiwan dollars`, `UAE dirhams`, `Saudi riyals`가 전부 `not_usd`입니다.
   `in the table below` 같은 비통화 구는 `NOT_A_CURRENCY`로 무시하고,
   `U.S. dollars`가 마침표에서 잘리던 결함은 `SENTENCE_END`로 고쳤습니다.

검증: 표 리더 34건, unit 10,028건(실패 0), 타입체크, 정적 게이트 9종 통과.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 특히 (a) `STANDARD_PRICE_QUALIFIER`가 실제 공급자의 표준 표를 막는 경우,
(b) `CURRENCY_STATEMENT`가 정상 문장을 외화로 오판하는 경우,
(c) 넓힌 토큰 패턴이 모델이 아닌 문자열을 모델로 잡는 경우를 봐 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
