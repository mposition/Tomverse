# 독립 검토 요청 — 공급자 데이터 목적지: 저장·처리 지리 분리

- 브랜치: `claude/to-develop/provider-destination-geography` (base: develop `c20f2d0f7`)
- 작성: Claude. 검토: 독립 검토자.
- 범위: 코드 레지스트리와 문서뿐입니다. migration·route·UI·dispatch 변경 없음.

## 배경

`lib/providerDataDestinations.ts`는 Privacy 고지와 routing residency gate가 함께
읽는 단일 목록입니다. 12개 공급자 전부 `unproven`이고 사용자에게 렌더링되는 곳이
없습니다.

외부에서 작성된 공급자 개인정보 검토 인수본(v2.0)을 검토하다 두 가지를
발견했습니다.

1. 기존 필드 `destinationRegions`의 주석은 "The regions the data is
   **processed** in"이었습니다. 인수본 §3은 같은 이름을 **저장 지리의 호환
   alias**로 정의하고, 저장 위치로 처리 위치를 채우는 것을 금지된 추론으로
   명시합니다. 한 필드가 두 뜻을 가진 상태였습니다.
2. 고지가 인쇄해야 하는 항목(§15) — 저장·처리 지리, 학습, 보관, 제3자의
   독자적 상업 이용 — 을 담을 자리가 없었습니다.

## 변경

- `ProviderDataDestination`에 필드 추가(전부 `UNKNOWN`/`null`로 시작):
  `recipientCountryCodes`, `customerContentStorage`, `processing`
  (각각 `mode` 6값 · `countryCodes` · `macroRegions` · `evidenceRef`),
  `trainsOnCustomerContent`, `retention`(다섯 항목), `zeroDataRetention`,
  `independentCommercialUseProhibited`. enum은 인수본 schema의 값을 그대로
  씁니다.
- `destinationShapeProblems()` 신설 — status와 무관한 모순: 저장 alias 불일치,
  location mode인데 위치 없음, `UNKNOWN`인데 위치 있음,
  처리에 `NO_PERSISTENT_CONTENT_STORAGE`, ISO 3166-1이 아닌 국가 코드(`UK`,
  `EU`, 혼합 문자열), macroRegions에 국가 코드, 근거 없는 답.
- `provenDestinationProblems()` 강화 — proven이면 수신 국가, 저장·처리 mode
  (`UNKNOWN` 불가), 학습 답, 보관 다섯 항목, 상업 이용 답이 있어야 합니다.
  **ZDR은 요구하지 않습니다** — strict route의 조건이지 고지의 조건이 아니라고
  판단했습니다. 기존의 "destinationRegion 필수"는 삭제했습니다. 저장이
  `NO_PERSISTENT_CONTENT_STORAGE`나 `NOT_PINNED`이면 위치가 비는 것이 맞기
  때문입니다.
- `destinationIsDisclosable()` — `providerDestinationIsEstablished()`와
  `disclosableDataDestinations()`가 status만이 아니라 두 검사를 모두 거칩니다.
- report가 질문별 검토 현황을 출력하고 모양 오류에서도 실패합니다.
- 설계 문서 §4.5 필드 표 갱신.

## 의도적으로 하지 않은 것

- **인수본의 V1 공급자별 참고값을 옮기지 않았습니다.** 인수본 스스로
  `IMPORTED_NOT_REVERIFIED`, `forRuntime: false`로 표시했고, 내부 법무 권고
  (`BLOCK_UNTIL_…` 등)를 함께 담고 있습니다. 이 저장소는 public입니다.
- `ProviderEndpoint.destinationRegions` DB 컬럼 분리 — migration이 필요해
  별도 단계로 남겼습니다.
- 다른 서비스(OpenRouter·Duck.ai·Poe)의 공개 정책을 근거로 쓰는 경로는 두지
  않았습니다. 그 정책은 그 서비스의 계약을 설명합니다.

## 봐 주셨으면 하는 것

1. **proven의 문턱이 맞습니까?** 특히 ZDR을 요구하지 않은 판단, 그리고
   `NOT_SPECIFIED`/`NOT_PINNED`을 고지 가능한 답으로 받는 판단.
2. **`destinationRegions` alias 검사가 기존 의미를 가진 데이터를 조용히
   깨뜨립니까?** 이 필드를 읽는 코드가 이 모듈 밖에 있습니까?
   (`ProviderEndpoint.destinationRegions` DB 컬럼은 별개 필드입니다.)
3. **국가 코드 검사**: `^[A-Z]{2}$` + 거절 목록(`UK`, `EU`, `EL`). 거절 목록이
   부족하거나 과합니까? macroRegions가 자유 문자열인 것이 문제입니까?
4. **null과 거짓**: `ReviewedAnswer.value: boolean | null`에서 `null`을 거짓으로
   읽는 경로가 남았습니까?
5. **주장이 코드보다 큰 곳**: 주석·테스트 이름·설계 문서가 코드가 하는 것보다
   많이 말하는 곳.
6. `providerDestinationIsEstablished()`가 이제 모양 검사까지 합니다. 이 함수의
   기존 계약("routing permission이 아니다")과 충돌합니까?

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
