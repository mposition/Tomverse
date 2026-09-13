# 2차 검토 요청 — 공급자 문서 기반 가격·능력 증거

1차에서 제기하신 P1 8건, P2 5건에 대한 대응입니다. `git diff`(새 파일·fixture는
intent-to-add로 포함)로 확인해 주세요. 기준은 HEAD(1단계 커밋)입니다.

## P1

1. **증거가 다른 pair로 이동** — 조회 identity를 `(registry id, provider, apiModel)`로
   넓혔습니다(`adoptionLookupKey`). 라우트는 `provider`/`apiModel` 쿼리를 받아 **그
   pair가 work item의 sighting일 때만** observation·증거를 읽고, 아니면 아무것도
   채우지 않은 초안을 줍니다. 패널의 대기·실패·복귀·touched 로직은 id 대신 key를
   씁니다. id만으로 판정하던 `profilePrice.modelId` early return은 제거했습니다(pair가
   바뀌면 profile이 같아도 재조회해야 하므로).
2. **최신성** — `DOC_EVIDENCE_MAX_AGE_MS`(36시간). 오래된 증거는 가격만이 아니라
   **어떤 필드도** 채우지 않고 unknown에 읽은 날짜를 표시합니다. profile 제안도
   만들지 않습니다. 수집 대상은 공급자별로 **증거가 가장 오래된 순**으로 12개를 고르고,
   빠진 것은 `notAttempted`(cap)로 리포트에 인쇄합니다.
3. **OpenAI 교차 검증** — 가격표가 없거나, 모델 행이 없거나, 셀이 `-`도 가격도 아니면
   problem. 입력·캐시·cache write·출력은 **한쪽만 있어도, 값이 달라도** problem. tiered면
   가격표 장문 입력·출력이 `short × 배수`와 같아야 하고, 장문 캐시 셀도 입력 배수로
   맞아야 합니다(맞으면 `cacheTakesInputMultiplier`를 true로 확정). 가격표 이름에 임계값이
   있으면 모델 페이지 임계값과 같아야 합니다. flat은 장문 셀 전부 `-`일 때만.
   1차에서 재현하신 네 변형(행 삭제, `$1.75 / MTok` 셀, 캐시 `$0.0175`, 장문 출력
   $100)을 모두 테스트로 고정했습니다.
4. **프로모션** — 모델 페이지 **전체**에서 `promotional|introductory|limited-time`을 찾고,
   가격표에서 해당 모델 id/표시명을 단어 경계로 언급한 줄도 봅니다. Anthropic은 페이지
   전체에서 표시명을 언급하는 프로모션 줄을 찾습니다(Sonnet 5 introductory 공지가
   걸려 가격을 채우지 않음 — 틀려도 안전한 방향이고, Sonnet 4.6은 걸리지 않음을
   테스트로 고정). 거절 순서는 promotional을 problems보다 앞에 두어 운영자가 볼 사유를
   구체적으로 했습니다.
5. **저장 JSON 형태** — `problems`가 문자열 배열이 아니면, `promotional`이 null도
   `{note:string}`도 아니면, 숫자가 음수·문자열·범위 밖이면, `longContext`가 정확한 모양이
   아니면 **행 전체를 거부**합니다. `sources`는 `docSourcesFromStored`로 https URL과
   64자 hex 또는 null digest만 받고, 어긋나면 증거 전체를 버립니다.
6. **제안이 cap guard 우회** — `buildPricingProfileProposal`은 이제
   `requestOutputCapTokens`(폼 가드가 받아들인 값)만 씁니다. 없으면
   `MAX_OUTPUT_TOKENS_TO_DECIDE`와 "문서 상한 N이 가드를 통과하지 못했다" 주석.
7. **parsed + problems 집계** — `degraded` 카운트, 실패 목록에 `parsed_with_problems`로
   포함, 요약은 `docs clean X/N`.
8. **fixture 미포함** — intent-to-add로 diff에 포함했습니다.

## P2

1. `Content-Length` 선검사 + 스트림 누적 1.5MB 제한(`readLimited`).
2. 출력 상한과 이미지 입력도 API·문서 충돌 시 unknown 표시.
3. Anthropic 행마다 5분 write=1.25×, 1시간 write=2×, cache hit=0.1× 또는 각주가 명시한
   배수를 검사. 각주 번호가 셀에 있는데 각주를 읽지 못하면 problem. fixture 전 행이
   통과함을 테스트로 고정.
4. 제안 주석에 모든 source URL과 digest 앞 16자.
5. 문서 수집 전체에 45초 예산. 넘으면 새 문서를 시작하지 않고 `notAttempted`
   (time_budget)로 리포트.

## 특히 봐 주셨으면 하는 것

- key 기반 패널 effect: deps에서 `form.provider`/`form.apiModel`을 `lookupKey`로만
  받습니다(eslint-disable 한 줄). 실패 재시도가 한 번만 일어나고 루프가 없는지,
  pair만 바꿨을 때 대기·초기화·복원이 id 변경과 똑같이 동작하는지.
- 라우트의 `pairObserved` 판정이 서버 preflight(`observedPairs`)와 같은 기준인지.
- 1차에서 재현하신 변형 외에, 교차 검증을 통과하면서 틀린 숫자가 채워지는 경로가
  남았는지.

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
