# 14차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

13차 P2 3건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **페이지가 선언한 통화를 보존합니다.** `documentUnits()`가 `foreignCurrency`를
   함께 돌려주고 `tableUnits()`가 그것을 잇습니다. 판정은 **페이지 전체를 두고 하는
   선언**만 읽습니다(`PAGE_CURRENCY_DECLARATION`: `All prices|amounts|rates|fees … in X`).
   `All prices are in Canadian dollars.` 아래의 `$1.40`은 `not_usd`이고,
   `All prices are in USD.` + `charge a $0.05 usage fee`는 그대로 읽힙니다.
2. **제목이 있으면 제목이 판정합니다.** `namesModel`은 제목이 있을 때
   `titleNamesModel()`만 쓰고, 제목이 없을 때만 본문으로 후퇴합니다.
   `# GLM-5.3-Flash` + 본문의 `Compared with GLM-5.3, …`는 `glm-5.3`이 아닙니다.
3. **링크 목적지는 모델 id가 아닙니다.** `cellNamesModel()`이 `](…)`를 먼저 제거한
   뒤 표시값에 대해 경계 일치 또는 셀 끝 일치를 요구합니다.
   `[Other](/docs/model/target-1)other-1`은 `target-1`의 행이 아니고, groq의 실제
   형태(`…](/docs/model/target-1)target-1`)는 그대로 자기 모델을 찾습니다.

## 이 회차에 제 수정이 만든 두 결함 (픽스처가 잡음)

1. `charge a $0.05 fee`의 **관사 "a"가 `A$`로 오인**됐습니다. 통화 접두는 기호에
   붙여 쓰므로 공백을 허용하지 않도록 고쳤습니다. 이 오탐은 전부터 있었지만 표
   범위에서만 쓰일 때는 드러나지 않았고, 페이지 전역으로 올리자 드러났습니다.
2. 페이지 전역에 통화 **문장** 스캔을 그대로 돌린 것이 과했습니다. 위 1번의
   선언 전용 패턴으로 좁혔습니다.

12차에서 지적하신 대로 helper에 구조 계약을 연결해 두지 않았다면 첫 번째는
통과했을 것입니다.

검증: 표 리더 62건, unit 10,056건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 반례는 수집기가 실제로 읽는 `.md` 문서 구조를 기준으로 삼아 주십시오.
코드를 수정하지 말고 한국어로 답해 주세요.
