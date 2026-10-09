# CHAT-01 Refiner Chat execution 경계 — 2026-10-10

상태: **default-off 제품 코드 구현·로컬 통합 검증. 독립 검토·활성 배포 미완료.**

## 제품 연결 코드 확장

아래 초기 경계 구현에 제품 scope/proposal/prepare API와 composer를 연결했다.
서버는 정확한 draft revision·scope epoch·mode별 durable attempt를 비용 예약 전에
선점한다. 응답 유실은 같은 저장 제안 ID만 반환하고 preparing/terminal/unknown
재요청은 재호출하지 않는다. Message 저장 transaction은 held draft id/revision과
source Message를 결속한다. draft를 삭제해도 attempt tombstone은 남고 같은 바이트
revision ABA는 거부된다. 브라우저는 identifier-only 결정을 보낸다.

수동 제안은 채택 또는 원문 유지 후 통상 Send로 전송한다. 자동 적용은 이미 Auto인
stored Chat 대화에서 승인된 release를 읽은 통상 Send 준비만 허용한다. 제안 API,
브라우저 boolean, fixture나 flag 하나가 provider/Auto 권한을 만들지 않는다.
AGENTS와 UI 계약에 이 좁은 예외 및 서버 경계를 정식 변경으로 포함했으며, 이 변경도
필수 독립 검토 대상이다.

제품 adapter는 기존 평가의 prompt/parser/validator/model/price pin을 재사용하고
별도 13초 전체 요청 deadline과 retry 0을 적용한다. 늦은 admission은 dispatch하지
않고, 늦은 provider/정산 결과는 held 제안으로 publish하지 않는다. one-shot 평가의
15초 계약·slot·기존 migration은 변경하지 않았다.

Brisbane 일 US$100·월 US$3,000의 공통 운영 예산에서 explicit/auto 비용을 별도
mode로 기록한다. 사용자 credits와 분리해 최악 비용 29,918 microUSD를 예약하고,
신뢰한 adapter intent 후 verified billed만 정산한다. 미사용 차액은 환급하고,
confirmed undispatched만 release하며, unknown은 전액 hold와 terminal로 보존한다.
execution/disposition receipt는 content-free이며 UPDATE/DELETE/TRUNCATE를 막는다.
상태·예산 전이와 canonical audit는 각각 같은 transaction에 묶인다.

최신 로컬 검증:

- Chat execution 75/75: 기존 71 + 파일 있는 explicit 채택/원문 유지/Auto 3 + 검색
  Auto 1. 실제 route에서 Router text/estimate, shadow text/profile, provider text와
  단일 전송을 관측했다. 과거 authored Message와 첨부는 보존했다.
- 제품 adapter/API/release/service와 owner release API 17/17, client 23/23.
- 빈 loopback PostgreSQL 17 DB에 269개 migration 적용 및 Prisma schema drift 없음.
  제품/예산 DB 통합 24/24. exact source bind, same-bytes revision ABA, canonical
  hash chain, immutable receipts, 재접속/동시 소비, 예산 정산·unknown hold를 포함한다.
- audit/protected writer 35/35, security regression 196개 통과.
- strict lint와 독립 생성 Prisma client의 8GB typecheck, 최종 production build 통과.
  build의 기존 broad filesystem 탐색 경고 8건은 남아 있다.
- fixture 브라우저 회귀 96건 통과, 기존 project 조건으로 74건 건너뜀. Windows용
  기준 이미지가 없는 mobile composer 시각 비교 2건은 실패로 기록하며 golden을
  생성하거나 통과로 처리하지 않았다. canonical CI 비교는 별도다.
- 새 검증 쿼리를 반영한 기존 maintenance/attachment mock 회귀 34/34 통과.
  전체 server contract 재검증과 drawer/재접속 브라우저 회귀는 별도 기록한다.

실제 staging readback(2026-10-09T17:39:23Z)은 READ ONLY transaction에서 내용 없는
카운트와 boolean만 읽었다. v4/v5 각각 공식 B03G gate 0, owner disposition 0,
limited audit 0이다. `feature.promptRefinerEnabled=false`, kill switch는 꺼져 있다.
이것은 실제 제품 동작의 통과 기록이 아니다. signed 품질·제한 감사·exact deployment
activation이 없으면 release는 explicit/auto 모두 닫힌다. 활성화 API도 별도 owner
인증·recent authentication·origin·쓰기 off switch와 정확한 증거 결속을 요구한다.

독립 검토는 초기 head의 첫 vendor만 accept이고 두 번째 vendor는 대기 중이다.
위 제품 코드 확장은 새 최종 head로 검토해야 한다. 아직 자체 PR/push/병합/배포,
활성 flag readback, 실사용 회귀는 없다. Auto Router 세 출시 판정도 모두 pending이다.
예외 정책 승인을 서버 연결 완료나 Router 출시 판정으로 대체하지 않는다.
실제 holdout 원문·정답·rubric·반례는 요청하거나 열람하지 않았다.

## 초기 서버 경계 검증 기록

아래는 제품 caller를 붙이기 전 단계의 기록이다. 위 확장이 구현 범위와 현재 상태를
갱신하며, 아래 검증 수치를 최신 테스트 합계에 다시 더하지 않는다.

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

- `test:prompt-refiner-chat-execution`: 71 unit/API 사례 통과. 기존 제안형 계약,
  원문/실행 projection, 수동 채택/자동 authority 구분, 원문 유지, epoch/replay,
  Unicode·음성 전사형 text·첨부 reference 보존과 default-off HTTP 거부 포함.
  추가 HTTP 회귀는 소비 뒤 access 실패가 나도 재소비/추가 provider로 진행하지
  않음을 확인한다. source validation이 content string을 요구하므로 첨부가 있어도
  authored profile text는 비지 않는다. 실패 시 소비한 제안을 되살리거나 원문을
  자동 재전송하지 않으며, attempt가 이미 존재할 때의 exact reattach는 별도다.
- 실제 Chat route의 Router selector에 넘긴 text·예약 토큰 추정 입력, shadow
  profile과 `streamText()`의 현재 사용자 text를 합성 stream으로 관측했다.
  수동 채택·원문 유지·자동 모드 3개가 각 기대한 공통 execution prompt를 받으며
  과거 메시지와 authored transcript는 보존되고 provider dispatch는 한 번이다.
  store의 release/소비 결과는 테스트 seam이고 DB 소비는 아래 PostgreSQL 테스트가 검증한다.
  실제 Router readiness는 pending이라 이 관측을 전면 Auto 출시 증거로 쓰지 않는다.
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
