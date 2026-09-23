# 16차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

15차 P2 4건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **부정문은 선언이 아닙니다.** `NEGATED_DECLARATION`(`not`·`never`·`no longer`·
   `used to`·`previously`·`formerly`·`until`)이 있으면 그 문장을 건너뜁니다.
   `Prices are not in USD.` 아래 표는 `currency_unstated`입니다.
2. **범위가 한정된 선언은 페이지의 통화를 세우지 못합니다.** `SCOPED_DECLARATION`
   (`table`·`section`·`below`·`tool`·`image` 등)이 있으면 `usd`로 승격하지 않습니다.
   **다만 한정된 외화 선언은 그대로 거절합니다** — 비대칭이지만 두 방향 모두
   fail-closed입니다(잘못 거절해도 사람이 채우고, 잘못 통과하면 틀린 숫자가 남습니다).
3. **id 앞에 올 수 있는 것은 둘뿐입니다.** 표시명을 끝내는 **대문자·숫자**이거나,
   알려진 **배지 단어**(`Enterprise`·`Preview`·`Beta`·`New`·`Deprecated`·
   `Production`·`Featured`)입니다. `pretendtarget-1`은 이제 `target-1`이 아니고,
   groq의 두 실제 형태(`Enterprisetarget-1`, `…120Bopenai/gpt-oss-120b`)는 읽힙니다.
4. **강조 문법은 내용이 아닙니다.** `**All prices are in USD.**`가 통화구를
   `USD.**`로 만들어 **정상 문서를 거절**하던 결함이었습니다. `*`·`_`·`` ` ``를
   먼저 제거합니다.

이번 회차에는 제 수정이 픽스처를 깨뜨리지 않았습니다.

검증: 표 리더 68건, unit 10,062건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.
세 픽스처의 페이지 판정은 zhipu·xai `usd`, groq `null` 그대로입니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요.

지금까지 열다섯 회차에서 P2 65건이 나왔고 P1은 없었습니다. 6차 이후 지적은 전부
이 범용 리더에 몰려 있습니다. 반례를 계속 찾아 주시되, **남은 것이 실제 공급자
문서에서 발생할 수 있는 형태인지, 이론적으로만 가능한 형태인지** 각 항목에 표시해
주십시오. 반례는 수집기가 실제로 읽는 `.md` 문서 구조를 기준으로 삼아 주시고,
코드를 수정하지 말고 한국어로 답해 주세요.
