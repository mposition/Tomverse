# 13차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

12차 P2 5건 중 4건을 고쳤고, 1건은 사실관계를 정정합니다.
`git diff`(intent-to-add 포함)를 검토해 주세요.

## 정정 — xAI 라이브 표

지적하신 `Model | Context | Short context | Long context` 그룹 표는 **렌더링된 HTML
페이지**(`https://docs.x.ai/developers/pricing`)의 모습입니다. 수집기가 읽는 것은
`https://docs.x.ai/developers/pricing.md`이고, 2026-09-22에 다시 받아 픽스처와 바이트
단위로 대조했습니다 — `### Text API Pricing` 아래 평면 5열
(`Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens`)
그대로였습니다. 과잉 차단은 발생하지 않습니다.

**다만 같은 지적의 뒷부분은 정확했고 이 회차에서 가장 중요한 발견이었습니다.**
테스트 helper가 `expectedHeaders`를 넘기지 않아 세 픽스처가 생산 경로의 새 계약을
한 번도 지나지 않고 있었습니다. helper를 고쳐 이제 픽스처는 각 공급자의 기록된 표
구조를 통과해야만 읽히고, 전 항목이 그대로 통과합니다.

## P2 4건

2. **가격 자리 통화.** combined 경로도 **원문 셀**로 판정합니다. 기호는 열거 대신
   `ALLOWED_PRICE_CHARACTER`(가격에 올 수 있는 문자 전체)를 두고 벗어나면 거절하며,
   `SHORT_CURRENCY_MARK`가 `R$`·`SR` 같은 약칭을 잡습니다. `R$ 1.40`, `₽1.40`,
   `1.40 SR`은 `not_usd`이고 `1.40`·`$1.40`은 읽힙니다.
3. **비표준 표.** `markdownTables()`가 heading 계보(`ancestry`)를 level 스택으로
   추적하고, tier 판정이 heading·preamble·계보를 모두 읽습니다.
   `## Pricing` + `Fast mode pricing`과 `## Batch API Pricing` > `### Text Models`
   둘 다 거절됩니다.
4. **모델 열.** id는 `MODEL_COLUMN`에서만 찾습니다. groq는 링크 평탄화로 id 앞
   경계가 사라지므로 **평탄화 전 원문 셀**(`rawRows`)로 대조합니다.
   `| other-1 | 9.99 | target-1 | - | 19.99 |`에서 `target-1`은 이제 `not_found`입니다.
5. **파생 페이지.** `titleNamesModel()`이 페이지 제목을 **동등 비교**합니다.
   `# GLM-5.3-Flash`는 `glm-5.3`이 아니고, `# DeepSeek V3.2`는 `deepseek-v3.2`입니다.

자체 검증에 남아 있던 타입 오류 하나도 고쳤습니다.

검증: 표 리더 59건, unit 10,053건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요.

반례를 만드실 때 **수집기가 실제로 읽는 문서**(각 공급자의 `pricingUrl`, 대부분
`.md`)를 기준으로 삼아 주시고, 렌더링 HTML과 다르면 그 점을 적어 주십시오.
코드를 수정하지 말고 한국어로 답해 주세요.
