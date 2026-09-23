# 7차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

6차 P2 5건 대응입니다. 지적하신 반례를 전부 직접 재현한 뒤 고쳤고, 네 건은 회귀
테스트로 고정했습니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **요율 tier를 모양으로 인식합니다.** 허용 목록만으로는 볼 수 없다는 지적이
   맞았습니다 — 가격표의 preamble은 언제나 "Prices per 1M tokens"라서 heading이
   무엇이든 통과했습니다. `RATE_TIER_SECTION`이 `단어 + processing|tier|lane|queue`
   모양을 heading에서 찾고, 그 단어가 `standard`가 아니면 거절합니다. 아직 아무도
   만들지 않은 tier 이름도 잡힙니다. `STANDARD_SECTION`에는 시작 단어 경계를 넣어
   `Accelerated`의 `rate`가 더는 걸리지 않습니다.
2. **영문 통화명을 외화로 봅니다.** `euros`, `yen`, `yuan`, `won`, `rupees`,
   `Canadian dollars`, `pounds sterling` 등을 `FOREIGN_CURRENCY`에 넣었습니다. 페이지
   `All prices are in USD.` + 표 preamble `in euros.` 조합은 이제 `not_usd`입니다.
3. **combined 셀도 다중 가격을 거절합니다.** `matchAll`로 `$N input` / `$N output`
   후보 수를 세고, 어느 쪽이든 둘 이상이면 `ambiguous_value`입니다.
   `~~$0.15 input~~ $0.10 input $0.60 output`은 파싱되지 않습니다.
4. **파생 모델은 다른 모델입니다.** 문장 안의 모델 토큰 판정을 완전 일치로 바꿨습니다.
   한쪽이 다른 쪽을 포함해도 다른 모델입니다. `glm-5.3` 페이지의
   `GLM-5.3-Flash has a 128K-token context window.`는 이제 아무것도 주지 않습니다.
5. **승인이 프로모션 표식을 지우지 않습니다.** 모델 페이지도 공유 페이지와 같은
   회계(`noteModelPageNotices()`)를 지나며, 승인 여부와 무관하게 그 페이지의 모든
   프로모션 문장이 **그 모델에** 귀속됩니다. 모델의 자기 페이지이므로 공급자의 다른
   모델로 새지 않고, 과잉 귀속은 fail-closed(가격 거절) 방향입니다.

실제 픽스처는 그대로 정확히 파싱됩니다: GLM-5.3 $1.4/$4.4·1M·128K, Flash $0.15/$0.5,
FlashX $0.37/$1.25, grok-4.6 $2/$6·500k, groq gpt-oss-120b $0.15/$0.6·131,072/65,536.

검증: 표 리더 30건, 타입체크·정적 게이트 통과.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 특히 (a) 새 tier 모양 규칙이 실제 공급자 heading을 과잉 차단하는 경우,
(b) 모델 페이지 프로모션 귀속이 지나치게 넓어 정상 가격을 막는 경우를 봐 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
