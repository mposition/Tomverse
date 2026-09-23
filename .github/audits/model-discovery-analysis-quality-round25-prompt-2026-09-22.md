# 25차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

24차 Codex 세션은 판정문을 쓰기 전에 끊겼습니다. 끊기기 직전 프로브가 재현한
5건을 고친 뒤의 `git diff`(intent-to-add 포함)를 검토해 주세요. 코드를
수정하지 말고 한국어로 답해 주세요.

## 문서 리더 4건

`for` 꼬리는 이제 두 경우만 선언입니다.

- `for input and output` → 양쪽 열 → 통과
- `for the table below` → 그 표 → 표 자리에서만 선언
- 그 외(`for cache reads`, `for pay-as-you-go usage`, `for input`) → 귀속 불가

예외가 열 이름(`cached input`)을 대면 `prices`라는 단어가 없어도 귀속 불가입니다.
`excluding taxes`는 그대로 선언입니다.

포함 절이 가격을 부정하면(`including input but not output prices`) 그 절을
지우기 전에 귀속 불가로 둡니다. `including image and tool prices`처럼 부정이
없는 포함은 그대로 넓힙니다.

셀이 `United States dollars` · `American dollars` · `U.S. dollars`라고 쓰면
USD로 읽습니다. 맨 `dollars`는 읽지 않습니다.

## 분석 본체 · 출처

`modelTier()`가 연속 tier 단어를 한 자리로 묶습니다. `gemini-3.5-flash-lite`의
단어는 `flash-lite`이고, 서비스 중인 `gemini-3.5-flash`와 같은 세대·다른
자리입니다. family는 둘 다 `gemini`입니다.

Zhipu Flash·FlashX의 모델 페이지는 `llms.txt`가 가리키는
`https://docs.z.ai/guides/vlm/glm-5.3-flash.md` 하나입니다. 제목
`GLM-5.3-Flash/FlashX`는 두 SKU를 모두 가리키고, `glm-5.3`은 가리키지 않습니다.
`model_page*` 문제는 가격표가 이미 읽은 가격을 지우지 않습니다. 가격 자체의
문제는 그대로 지웁니다.

## 행렬

corpus는 37문장, 세 자리 111판정입니다. 이번 우회 세 종류가 corpus에 있습니다.

검증: 표 리더·triage·문서 prefill 테스트를 함께 186건 통과했습니다. 실제
픽스처(glm-5.3 · flash · flashx, grok-4.7 · grok-4.3, openai/gpt-oss-120b)를
읽는 기존 테스트도 그 실행에 포함됩니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고
명시해 주세요. 각 항목에 **방향(우회 / 과잉 차단)**, **자리**, **실제 공급자
문서에서 가능한 표기인지**를 표시해 주십시오.

문서 리더 밖도 함께 봐 주세요 — A1(판정 우선 구조), A2(포트폴리오 관계),
A3(파동), A4(화면·locale), B1(출처 표), B3(수집기 예산·라운드로빈). 반례는
수집기가 실제로 읽는 `.md` 구조를 기준으로 삼아 주세요.
