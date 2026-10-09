---
status: proposed_exact_approval_pending
policyVersion: 1
workId: CHAT-01
scope: PROMPT_REFINER_VNEXT_FULL_USER_AUTO_RELEASE_EXCEPTION
scopeRequestedBy: mposition
scopeRequestedAt: 2026-10-09
scopeApprovedBy: mposition
scopeApprovedAt: 2026-10-09
dailyCostCapUsd: 100
monthlyCostCapUsd: 3000
perRequestCeilingMicroUsd: 29918
refinerDeadlineMs: 13000
approvedBy: null
approvedAt: null
activationAuthority: none
---

# Prompt Refiner vNext 전면 Auto 출시 예외 v1

## 1. 결정의 범위

운영자는 2026-10-09에 B08 품질 gate 통과 없이 **전체 사용자**의 Chat Auto
경로에 Refiner 제안을 **자동 적용**하는 출시 예외를 요청했다. 운영자는 지연 외
품질·안전 실패와 제한 감사의 미해결 위반이 없다고 확인했다. 이 대화상 확인은
서명된 판정·감사 receipt가 아니며, 이 초안만으로 출시 권한이 생기지 않는다.
전체 사용자는 기존 Chat Auto 이용 자격이 있는 모든 사용자를 뜻하며, 이
예외로 요금제·지역·연령·콘텐츠 또는 기존 Chat release gate를 우회하지 않는다.

이 정책은 승인된 [단회 평가 v2](prompt-refiner-quality-evaluation-vnext-one-shot-v2.md),
[수치 계약](../ops/prompt-refiner-quality-evaluation-vnext-numeric-spec-draft.md),
과거 평가·감사를 고치지 않는다. 기존 B07의 관측 최대 지연 12,599ms는 사전
승인된 12,000ms를 초과한다. 해당 회차를 `pass`, `partial pass` 또는 13,000ms
기준의 소급 `pass`로 표시하지 않는다. **이 문서가 허용할 수 있는 예외는 제품
출시 결정뿐**이며, 다른 품질·안전·비용 조건이나 실행 승인에 대한 예외가 아니다.

## 2. 활성화 전 필수 증거

다음 중 하나라도 없거나 불명확하면 전면 Auto 적용은 꺼진 상태로 남는다.

1. 기존 80슬롯·후보·root·runner·가격·배포에 결속한 B03G 결정적 판정의
   내용 없는 결과와 운영자 제한 감사 receipt. 승인된 12,000ms 기준으로
   지연 실패를 그대로 기록하고, 지연 **외** 모든 분모·셀·challenge·방향·안전·
   비용·사용량·실행 완결성 조건은 충족하며 미해결 감사 위반이 0건임을
   기계적으로 확인한다. 구두 확인, 자체 보고 boolean, 일부 슬롯의 결과는
   대체 증거가 아니다. `unknown` 또는 필수 증거 누락이 있으면 예외를 거부한다.
2. 제품에 들어갈 후보 model·adapter·parser·Refiner 출력 검증기와 source
   closure가 위 평가에서 판정한 것과 동일하거나, 변경된 부분에 대해 별도
   검증·승인을 받는다. 평가 당시의 stage/run 승인을 제품 요청의 비용 권한으로
   재사용하지 않는다. 원문·정답·rubric·반례와 그 digest를 제품 로그·PR·공개
   receipt로 옮기지 않는다.
3. 전면 Auto의 추가 Refiner provider 지출은 운영자가 지정한 **US$100/일,
   US$3,000/월**을 별도 namespace에서 강제한다. 기간은
   `Australia/Brisbane` 달력의 날짜·월로 고정하고, 요청당 최대 예약액은
   **29,918 microUSD**다. 이 요청 상한은 평가 후보와 모델·입출력 상한·가격
   pin이 동일하고 그 최악액을 앱이 재계산할 때만 재사용한다. 다른 모델·요율·
   상한이면 호출을 막고 새 수치 승인을 받는다. 앱은 dispatch 전에 예상
   최악액을 durable 예약하고, 확정 비용과 미확정 예약을 합쳐 어느 기간의
   상한도 넘지 않게 한다. 사용량·청구가 불명확하면 최악 예약을 유지한다.
   상한 소진·예약 실패 시 추가 Refiner 호출 없이 **원문 그대로** Chat에
   전송한다. Refiner 운영비는 사용자 Chat 크레딧에서 조용히 차감하지 않는다.
   평가용 US$2.393440은 이 운영 예산에 더하거나 재사용하지 않는다.
4. 제품 어댑터·서버 admission·감사·kill switch가 구현되어 관련 합성/통합
   테스트와 독립 검토를 통과한다. 제품 활성 배포의 정확한 commit·deployment,
   feature flag 기본 꺼짐, 가격 pin 및 예산을 서버가 직접 확인한다. staging에서
   원문 fallback·동시 요청·오류·재접속·비용 소진·kill switch의 전체 Chat 흐름을
   검증한 뒤 운영자가 그 배포와 증거를 명시적으로 활성화한다.
5. 기존 [제안형 UI 계약](../ui-contracts/prompt-refiner-suggestion.md)과 저장소
   `AGENTS.md`의 명시적 사용자 채택 불변식은 이 문서만으로 바뀌지 않는다.
   자동 적용을 그 계약의 **Chat Auto 전용 예외**로 명시해 관련 코드·회귀
   테스트와 함께 개정하기 전에는 제품 요청에 자동 적용하지 않는다. 기존의
   수동 제안·거절 경로 및 원문 Message 보존 불변식은 유지한다.

## 3. 제품 실행 경계

- 적용 대상은 사용자가 선택한 **Chat Auto** 요청뿐이다. 수동 모델 선택,
  시스템/개발자 지시, 첨부·검색·도구 결과, 저장된 과거 메시지를 자동 수정하지
  않는다. 자동 적용은 사용자가 전송한 현재 요청의 내부 실행 입력에만 적용하며
  메시지를 스스로 전송하지 않는다. 저장되는 사용자 Message는 원문 그대로다.
  서버가 최종 적용 여부를 결정하며 client flag나 runner의 자기 보고를
  권한으로 취급하지 않는다.
- Refiner의 제품 요청 deadline은 **13,000ms 이하**, retry는 0이다. 이 값은
  기존 B08의 12,000ms 판정을 소급 변경하지 않는다. 정해진 시간 내에 검증된
  제안이 없거나, 승인된 서버 검사에서 구조·명시 제약·안전 상태가 실패 또는
  미확인이거나,
  가격·사용량·배포·source·감사 결속이 어긋나면 **원래 사용자 입력**으로 계속한다.
  Refiner 오류 때문에 사용자의 Chat 전송을 재시도하거나 Refiner를 다시 호출하지
  않는다. fallback도 기존 Chat 안전·비용 gate를 우회하지 않는다.
- 적용 여부, fallback 이유, 비용·지연, 사용자가 원문으로 되돌렸는지를 내용 없는
  receipt로 기록한다. 사용자에게 자동 변경 사실과 원문 복원 방법을 보여 준다.
  원문·제안문은 이 예외의 새로운 감사 payload가 아니다.
- 중대 안전 위반 1건, 원인 불명 dispatch/비용, 원문 fallback 실패, 승인 밖 모델·
  가격·source·배포, 예산 강제 실패, 감사 기록 실패가 확인되면 즉시 kill switch를
  걸고 Auto 적용을 중지한다. 결과 불명 시 재호출하지 않고 read-back 후 사람이
  해제한다. 단순 지연 초과 요청은 원문 fallback으로 처리한다. 최근 완료된
  Refiner 요청 100건의 p90이 6,000ms를 넘거나 원문 fallback 비율이 5%를
  넘으면 Auto 적용을 중지하고 운영자가 원인을 확인한 뒤에만 재개한다.

## 4. 승인과 표시

이 초안의 사용자 범위 승인과 실제 제품 활성화는 별개다. 운영자가 이 문서의
정확한 commit·SHA-256, §2의 내용 없는 증거, 운영 예산과 정지 수치,
최종 제품 deployment를 확인해 `approvedBy`·`approvedAt`이 있는 별도 승인
기록을 남길 때만 예외가 효력을 얻는다. 그전에는 flag·변수 변경, 제품 연결,
실사용 Auto 적용, 추가 유료 호출을 하지 않는다.

운영·UI 보고에는 `B08 pass` 대신 `B08 지연 gate 미통과 / 별도 출시 예외`를
표시한다. 이 예외를 합성 집합의 일반 의미 개선 인증이나 전체 CHAT-01 완료로
표현하지 않는다. 이후 정식 gate가 통과하더라도 이 회차의 실패 기록은 보존한다.
