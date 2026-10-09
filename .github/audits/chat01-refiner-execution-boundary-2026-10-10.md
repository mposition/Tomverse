# CHAT-01 Refiner Chat execution 경계 — 2026-10-10

상태: **default-off 서버 경계 구현·로컬 검증. 제품 연결 완료 아님.**

## 구현

- 서버 capture/hold seam은 현재 저장된 Chat draft의 id·revision·정확한 text,
  사용자·대화·surface·mount epoch·history recovery epoch에 제안을 결속한다.
  직렬화한 snapshot은 server-captured 객체가 아니므로 hold할 수 없다.
- public Chat decision은 suggestionId·scopeId·epoch·명시적 선택만 받는다.
  서버 보관 행과 durable source를 검증하고 row lock/CAS·DB clock과 canonical
  audit를 한 transaction에 묶어 소비한다. replay·stale·cross-account·결속 실패는
  추가 전송 없이 거부한다.
- 소비 성공 시 현재 사용자 text만 execution view로 바꾼다. Auto profiling,
  예약 input-token 추정, shadow와 provider formatting이 같은 view를 쓴다.
  저장된 Message와 source 검증, 기존 signed Memory/profile preflight는 원문이다.
- draft UPDATE는 같은 text나 첨부 변경도 무효화한다. DELETE는 Message 저장
  COMMIT에서 각 제안의 source를 확인한다. scope epoch는 동일 값으로 돌아와도
  증가한다. 소비/무효화에서 본문을 즉시 지우고 maintenance는 DB clock으로
  만료 본문을 최대 100개씩 지운다. 5분은 유효 수명이며 물리 삭제 완료 SLA가 아니다.
- 계정/대화 삭제 cascade와 사용자별 filtered export를 등록했다. execution
  provenance나 audit에 원문·제안문을 넣지 않는다.

## 로컬 검증

- `test:prompt-refiner-chat-execution`: 47 unit/API 사례 통과. 기존 제안형 계약,
  원문/실행 projection, 수동 채택/자동 authority 구분, 원문 유지, epoch/replay,
  Unicode·음성 전사형 text·첨부 reference 보존과 default-off HTTP 거부 포함.
- 격리 loopback PostgreSQL 17: 14 store/DDL 시나리오 통과. 동시 1회 소비,
  audit 실패 rollback, draft 첨부/동일 text 변경, scope ABA, kill, 만료, 계정 cascade.
- 별도 loopback DB에 267개 실제 migration 적용. 실제 draft consume → 원문
  Message 저장 → Refiner 소비/본문 purge와 canonical hash chain 검증, durable
  attempt exact reattach 3개 시나리오 통과. 이 테스트는 provider를 호출하지 않는다.
- 관련 export/protected-writer/DB test inventory 50개 통과. 기존 synthetic Auto와
  suggestion 회귀는 같은 관련 실행에서 실패가 없었다.
- 기존 제안 panel client render 12개 통과. desktop/mobile Chromium fixture E2E
  43개 통과, 19개는 해당 spec의 project 조건으로 건너뛰었다. mobile geometry를
  desktop Chromium에서 touch/viewport로 한 번 측정하는 기존 조건을 바꾸지 않았다.
  이는 제품 adapter/provider 또는 staging 통합 검증이 아니다.
- 기존 E05 budget unit/PG 회귀 6개 통과. Brisbane 일/월 경계, 두 window의
  원자 예약과 상한 거부를 확인했다. dispatch/settlement 권한은 여전히 없다.
- security regression 196개, one-shot source gate, accent/pricing/enum/starter/
  shared/readiness/encoding/data registry/document references 검사 통과.
- 공유 Prisma 생성물로 실행한 초기 타입 검사와 기본 4GB heap의 OOM은 통과로
  기록하지 않는다. 독립 `npm ci`와 생성된 client로 full lint, 8GB typecheck와
  production build가 통과했다.

## 출시 경계와 미완료

예외 v1의 별도 승인 기록은 `approved_policy_not_activated`이고
`productActivationAuthority: none`이다. 기존 AGENTS의 명시적 채택 규칙과 fixture
dispatch 차단을 유지했다. explicit/auto execution release authority는 모두 false다.
브라우저 boolean이나 rollout AppSetting으로 이 release 경계를 열 수 없다.

제품 proposal/composer caller, 유료 adapter admission과 provider 실행·비용 정산,
execution/disposition receipt는 이 변경에 없다. 기존 E05의 US$100/일·US$3,000/월
예약 ledger는 보존했으며 `dispatchAuthorized: false`다. 그 예약만으로 실제 정산·
예산 초과 원문 fallback이 동작한다고 주장하지 않는다.

Router의 `shadow_report`, `offline_quality_evaluation`, `attempt_manifest_boundary`
판정은 모두 pending이다. 독립 검토, CI, PR 병합, staging 통합, 정확한 배포·flag
readback, 유료 실사용 회귀는 각각 별도 단계다. 이 기록은 사람의 출시 판정,
그 판정의 예외나 활성화 승인, staging 증거를 대신하지 않는다. 실제 holdout
원문·정답·rubric·반례는 요청하거나 열람하지 않았다.
