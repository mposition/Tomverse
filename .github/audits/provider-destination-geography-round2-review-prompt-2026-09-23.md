# 독립 검토 요청 — 공급자 데이터 목적지, 2라운드

- 브랜치: `claude/to-develop/provider-destination-geography`
- 1라운드: `f6314b812`, 판정 **approve_with_changes**, major 4 · minor 8.

## 1라운드 지적과 대응

**major 1 — `UK`·`EL`이 macroRegions로 통과.** 거절 목록을 둘로 나눴습니다.
`MISWRITTEN_COUNTRY_CODES`(`UK`, `EL`)는 어느 필드에서든 거절, `GROUPING_CODES`
(`EU`)는 countryCodes에서만 거절하고 macroRegions에서는 받습니다. 빈 macro
region도 거절합니다.

**major 2 — `NOT_PINNED`·`NOT_SPECIFIED`가 위치를 가질 수 있음.** 위치를 가질
수 있는 mode를 `COMMITTED_LOCATIONS`와 `DISCLOSED_POSSIBLE_LOCATIONS` 둘로
한정했습니다(allowlist).

**major 3 — 수신 법인·국가가 근거 없이 녹색.** 둘 중 하나라도 적혀 있고 행의
`evidenceRef`가 없으면 status와 무관하게 모양 오류입니다.

**major 4 — 설계가 DB 컬럼을 저장 alias로 읽으라고 함.** 그 문장을 철회했습니다.
`ProviderEndpoint.destinationRegions`는 schema 주석대로 "endpoint가 닿는
region"인 다른 필드이고, 분리는 별도 migration 결정이며 그때까지 eligibility가
읽지 않는다고 적었습니다.

**minor**
- 국가 코드 검사는 모양 검사(`^[A-Z]{2}$`)이지 ISO 목록 대조가 아니라고 주석과
  오류 문구에 적었습니다("is not a two-letter country code").
- `evidenceRef` 주석: proven의 필요조건이지 충분조건이 아님.
- 설계 문서: 행은 `status: unproven`, 각 사실은 `UNKNOWN`/`null`에서 시작.
- report: "May serve a residency-constrained request"를
  "Disclosable, and so open to a residency approval"로 바꾸고 개수를
  `destinationIsDisclosable()`로 셉니다.
- 테스트 머리글, `providerDestinationIsEstablished()` 주석을 본문과 맞췄습니다.
- **반영하지 않은 것**: ZDR이 `ZDR`인데 저장 mode가 `COMMITTED_LOCATIONS`인
  조합. ZDR은 content 보관에 관한 답이고 저장 지리는 그 밖의 저장(안전 로그,
  system metadata 등)을 포함할 수 있어 모순이 아니라고 판단했습니다. 틀렸다면
  지적해 주십시오.

## 이번에 봐 주셨으면 하는 것

1. 네 major가 닫혔습니까? 특히 `countryCodeProblem()`과 macroRegions 분기가
   `EU`·`UK`·`EL`·빈 문자열·`"SG"`를 각각 어떻게 다루는지.
2. 수신 근거 규칙이 unproven 행에 적용되는 것이 과합니까? (report가 모양 오류로
   종료 코드 1을 냅니다.)
3. 위 ZDR 판단.
4. 주장이 코드보다 큰 곳이 남았습니까?

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
