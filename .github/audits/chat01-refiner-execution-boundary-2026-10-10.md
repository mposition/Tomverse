# CHAT-01 Refiner Chat execution 경계 — 2026-10-10

상태: **default-off 제품 코드 구현·로컬 통합 검증. 독립 검토·활성 배포 미완료.**

전체 Chat 진행률은 승인된 전체 기능 분모를 이번 회차에서 재검증하지 않아 산정을
보류한다. CHAT-01의 구현·검증과 독립 검토·병합·활성 배포를 구분하며, pending인
Router 출시 판정을 미구현 0%로 환산하지 않는다.

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

제품 운영 중단 경계도 구현했다. 최근 완료 100건의 p90 > 6,000ms
또는 원문 fallback > 5건과 중대 불확실성을 content-free DB latch로 기록하며,
새 성공·rolling window·재배포가 이를 지우지 않는다. owner의 recent authentication,
정확한 중단 감사 ID·generation·원인 검토 확인에 결속한 별도 재개만 허용한다.
중단 이후 Auto 소비와 수동 채택을 구분하며, 기존 conversation/audit 잠금 순서를
보존하는 동시성 회귀를 검증했다. DB/audit 자체가 쓰기를 거부하면 durable latch를
만들었다고 주장하지 않고 해당 요청을 닫으며, 다음 요청도 현재 사실을 재검증한다.

`2e534f5db` 제품 head의 전체 로컬 검증(재검토 보강 결과는 다음 절에 구분):

- Chat execution 78/78: 기존 71 + 파일 있는 explicit 채택/원문 유지/Auto 3 + 검색
  Auto 1 + pinned 성공 응답의 세 모드 안내 3. 실제 route에서 Router text/estimate, shadow text/profile, provider text와
  단일 전송을 관측했다. 과거 authored Message와 첨부는 보존했다.
- 제품 adapter/API/release/service/deadline과 owner release API 25/25, client 23/23.
  기본 비활성 release는 auth/body/capture 전에 닫고 서비스의 최종 재검증도 유지한다.
- 빈 loopback PostgreSQL 17 DB에 270개 migration 적용 및 Prisma schema drift 없음.
  추가 migration 네 개의 실제 적용 checksum과 source checksum도 모두 일치한다.
  제품/예산/운영 latch DB 통합 33/33. exact source bind, same-bytes revision ABA,
  canonical hash chain, immutable receipts, 재접속/동시 소비, 예산 정산·unknown hold,
  sticky pause와 owner generation-bound resume를 포함한다. DB는 정상 종료 후 보존했다.
- audit/protected writer 35/35, security regression 196개 통과.
- 최종 source closure/pre-admission 수정까지 strict lint와 독립 생성 Prisma client의
  8GB typecheck 및 production build가 통과했다. 기본 4GB typecheck의 OOM은 성공으로
  처리하지 않았다. build의 기존 filesystem 탐색 경고 8건은 남았다. 자격증명 없는
  로컬 prerender에서 auth MissingSecret/landing destination 진단이 출력되었으며,
  실제 인증·staging 통과 기록으로 사용하지 않는다.
- fixture 브라우저 회귀 96건 통과, 기존 project 조건으로 74건 건너뜀. Windows용
  기준 이미지가 없는 mobile composer 시각 비교 2건은 실패로 기록하며 golden을
  생성하거나 통과로 처리하지 않았다. canonical CI 비교는 별도다.
- 새 검증 쿼리를 반영한 기존 maintenance/attachment mock 회귀 34/34 통과.
  최종 entry pre-admission 변경을 포함한 전체 server contract는 970개 통과,
  기존 TODO 1개로 실패 0이다(전체 971건).
- 첫 전체 unit 실행은 14,293건 중 14,263 통과·7 실패·23 skip이었다. 신규 파일의
  git index 누락, 공유 Marketing fingerprint, 정책 section reference, 기본-off proposal
  경로와 기존 Refiner source closure 회귀를 수정했다. PDF parser file-level 실패는
  격리 재실행 4/4 통과했으나 원인 판정이나 기존 실패 삭제 없이 전체를 재실행했다.
  Windows 기본 순차 실행 결과 전체 14,430건 중 14,407 통과·실패 0·기존 skip 23이다.
  server lane 14,296건(14,273 pass/23 skip), working-tree serial 20/20,
  client lane 114/114이며 최초 실패 기록도 보존했다.
- 기존 Refiner closure 178개 local/190개 total, computed access 228개와 위치 제외
  digest를 유지했다. 동일 strict decision schema를 기존 pure module에 공유하고
  실제 변경 위치에 대한 digest만 provenance와 함께 갱신했다. 관련 46/46 통과다.
- 공유 audit actor/schema를 포함하는 Marketing source fingerprint만 실제 closure에
  맞춰 갱신했다. 기존 signed staging evidence는 stale이며 권한·서명·정책·activation은
  변경하지 않았다.
- drawer·draft·재접속 브라우저 회귀 43건 통과, 기존 project 조건 31건 건너뜀.
- 별도로 실행한 기존 runner-candidate verifier는 pinned source에 failure-code 파일이
  없어 실패했다. 해당 builder/manifest/source는 develop과 동일하며 수정하지 않았다.
  공식 gate-source verifier는 통과했다. 이 결과를 candidate closure 또는 품질 통과로
  인용하지 않는다.

실제 staging readback(2026-10-09T18:58:19Z)은 READ ONLY transaction에서 내용 없는
카운트와 boolean만 읽었다. v4/v5 각각 공식 B03G gate 0, owner disposition 0,
limited audit 0이다. `feature.promptRefinerEnabled=false`, kill switch는 꺼져 있다.
해당 시점의 Railway 배포 readback에서 staging은 `e66f91973ede615ebcb9053e5d7812a5fad16300`,
deployment `7ac2d5a6-f003-489c-8c00-5b50c18e6574`의 SUCCESS이며 이번 제품 코드가 아니다.
이것은 실제 제품 동작의 통과 기록이 아니다. signed 품질·제한 감사·exact deployment
activation이 없으면 release는 explicit/auto 모두 닫힌다. 활성화 API도 별도 owner
인증·recent authentication·origin·쓰기 off switch와 정확한 증거 결속을 요구한다.

제품 head `2e534f5db`의 전체 검토 `r-20261009-191201-ba33cf`는 첫 vendor의
coverage-limit nit와 accept만 있고 두 번째 vendor는 대기 중이다. 운영자가 요청한
Copilot 재검토 결과와 후속 수정은 다음 절에 따로 기록한다. 아직 자체 PR/push/병합/배포,
활성 flag readback, 실사용 회귀는 없다. Auto Router 세 출시 판정도 모두 pending이다.
예외 정책 승인을 서버 연결 완료나 Router 출시 판정으로 대체하지 않는다.
실제 holdout 원문·정답·rubric·반례는 요청하거나 열람하지 않았다.

## Copilot 재검토 보강

운영자의 명시적 요청으로 같은 제품 head를 Copilot에 전체 재검토했다
(`r-20261009-225742-5c89b9`, base `e66f91973`, head `2e534f5db`).
첫 Copilot/Moonshot 판정은 accept와 minor 세 건이며 두 번째 다른 공급사 검토는
대기 중이다. 이 결과를 두 명의 aggregate accept로 처리하지 않는다.

- adapter execute 전에 trusted intent의 DB 전이를 시작하지 않은 throw는
  closure-owned confirmed-undispatched proof로 예약을 한 번 해제한다.
  생성 실패도 해제 성공 여부를 확인한다. 정상 감사로 거부가 기록되면
  `unavailable`, 해제 또는 감사 결과가 확인되지 않으면 `audit_unavailable`이다.
  intent 전이 시작 후 결과 불명은 전액 hold·운영 latch를 유지하며 provider
  재호출이나 묵시적 재시도가 없다.
- 운영 latch는 UTC wall clock으로 저장하는 `TIMESTAMP(3)` attempt를 동일한
  UTC-naive clock·baseline과 비교한다. 실제 DDL과 같은 PostgreSQL fixture로
  Brisbane session의 fresh attempt가 잘못 중단되지 않고 Los Angeles session의
  14초 stale attempt가 감사 실패로 중단되는 것을 검증했다.
- 정산 상한 지적은 오탐이다. 기존 base migration의 validated
  `PromptRefinerAutoBudgetHold_amount_check`가 이미
  `0 <= settledMicroUsd <= reservedMicroUsd`를 강제한다. 270개 migration을 적용한
  실제 DB에서도 제약을 확인했고, 직접 SQL 초과 정산이 `23514`와 정확한 제약
  이름으로 거부되며 hold와 일·월 창이 모두 불변임을 검증했다. 상한과 같은
  정산은 허용되고 unknown/null은 전액 hold를 유지한다. 중복 migration을
  추가하거나 기존 migration bytes를 변경하지 않았다.

수정 후 관련 검증은 Chat execution 78/78, 제품 server/admin 29/29와 client 23/23,
PostgreSQL 제품·예산·운영 latch 33/33이다. 이전 head의 전체 unit·server suite
수치를 이번 수정 head의 전체 재실행으로 바꾸어 주장하지 않는다. 필수 독립 검토는
수정 commit 이후의 focused round로 계속하며, source/price pin·출시 승인·권한·
kill switch와 기본 비활성 상태는 유지한다.

## 지정 공급사 전체 재검토의 후속 검증

운영자가 두 번째 공급사를 Claude로 지정해 `b269bf563` 전체 75개 파일을
Copilot와 Claude에 요청했다(`r-20261009-233101-ecc539`). Copilot 판정은
major 2건·minor 4건·nit 3건으로 **reject**다. 앞선 focused accept로 이번
reject를 대체하지 않는다. Claude 슬롯은 지정이 확인됐으나 quota unknown으로
대기 중이며, 지정 또는 대기 상태를 검토 완료로 처리하지 않는다.

- 정산 상한 major는 별도 validated `amount_check`를 status constraint와
  혼동한 오탐이다. 기존 `20261009044000` migration의 amount constraint는
  settlement migration에서 삭제되지 않는다. 직접 SQL의 초과 정산뿐 아니라
  음수 정산도 `23514`와 정확한 amount constraint 이름으로 거부되는 회귀를
  보강했다. 적용된 migration byte는 변경하지 않았다.
- Fallback major는 실행 실패와 사용자 선택의 분모를 혼동했다.
  `docs/policy/prompt-refiner-observability.md` §1·§4·§5는 execution fallback과
  `kept_original` disposition을 분리한다. 서비스의 `failed` 또는
  `refused_before_dispatch`는 실제 `original_fallback` 반환이고,
  `kept_original`은 successful suggestion 뒤 명시적 사용자 선택이다.
  PostgreSQL에서 suggested 100건 중 kept-original 6건은 active를 유지하고,
  다음 정확한 100건 중 execution fallback 6건은 pause함을 검증했다.
- 표본 99건은 active, 100번째는 승인된 p90/fallback 판정을 수행한다.
  소표본 규칙을 새로 추가하지 않는다. critical·unknown·감사 실패의 즉시 중단은
  이 표본 수와 무관하게 유지한다. 유일한 attempt INSERT의 UTC default와
  UTC expiry expression을 실제 non-UTC PostgreSQL session에서 검증했다.
- scope 인증은 durable-attempt admission 전에, admission은 single-use consume
  전에 수행하도록 보강했다. rate 제한에 막힌 요청이 유효한 결정을 먼저 소비하지
  않으며, 인증된 stale/replay consume 시도는 계속 rate 제한을 받는다.
- 중복 예약은 typed `duplicate_request` 거부로 정규화한다. 기존 예약을 새
  dispatch 권한으로 반환하거나 다시 예약·호출하는 idempotent retry를 만들지 않는다.
- authorize 성공 뒤 deadline 만료는 provider 0회이며, captured intent/config에
  결속된 dispatching hold를 정확히 한 번 해제한다. adapter와 service 양쪽의
  회귀로 이 연결을 관측했다.

수정 commit `d51057b0f`를 최신 develop `c7166fc71446bb3dfb0fbc7e8016fa719febe089`에
충돌 없이 통합했다(`4f4475a580a23ba61433e8b8aaf4c8a46ea407bc`). 이 트리에서
Chat execution 80/80, 제품 server/admin 30/30와 client 23/23,
실제 PostgreSQL 제품·예산·운영 latch 33/33, full lint, 8GB typecheck,
production build와 security regression 196개가 통과했다. 이전 head의 전체
unit·server suite 합계는 이번 트리의 전체 재실행으로 주장하지 않는다.
기존 실제 ChatInput fixture의 desktop/mobile Chromium 회귀는 29개 통과,
19개 project 조건 skip이다. 제품 provider 또는 staging 통합 증거는 아니다.

실제 local PostgreSQL 17.10에 최신 upstream migration까지 271개를 적용했다.
별도 빈 scratch DB에 같은 migration을 적용한 스키마 비교는 columns 3,964,
indexes 1,139, constraints 1,704, routines 244, triggers 268, extensions 1개가
모두 동일했다. 이번 제품 migration 4개의 적용 checksum도 소스 SHA-256과
일치한다. 운영·staging DB migration 증거로 사용하지 않는다.

필수 accent/pricing/enum/default/starter/shared/protected-writer/data-domain/
policy-section/doc-reference/strict-encoding 검사 11개를 통과했다. 예산 writer의
추가 두 table mention은 Prisma 오류의 modelName 및 cause.table 비교 문자열이다.
검사 pin만 11에서 13으로 갱신했고 writer·경로·write verb 6개는 유지했다.
정책 참조 주석도 각 문서 경로와 section을 명시했다. DB test inventory 218개와
Auto rollout readiness 검사도 통과했지만, Router의 세 판정은 여전히 pending이다.

보조 검사 실패는 보존했다. `check:marketing-admission-code`의 네 source manifest
불일치는 깨끗한 develop `c7166fc`에서도 동일했다. `check:dark-tables`도 그 base의
기존 16건이 실패한다. 이번 release store의 추가 한 파일은 exact signed release
검증을 위해 stage를 읽는다. 예외 정책 §2와 UI 계약의 exact B03G 결속 요구를
따르는 이 reader만 Stage의 제한 허용 목록에 추가했다. Slot·전역 해제나 다른
파일 접근은 추가하지 않았다. deployment identity 15개와 protected writer 28개
회귀가 통과하며 추가 지적이 사라져 기존 base의 16건과 일치한다. 기존 검사 실패를
통과로 표시하지 않았고 source manifest를 새 승인으로 재생성하지 않았다.

수정 commit의 독립 재검토, PR·병합·정확한 staging 배포·제품 활성화는 별도로
확인해야 한다. 최신 develop base는 이전 review head의 후손이 아니므로 그 head를
focus로 쓰면 서버의 `focus_not_in_range`에 해당한다. 다음 검토는 자동 선택된
최신 base부터 전체 제품 diff를 대상으로 하며 `--base`를 강제하지 않는다.
quota 조회를 우회하거나 검토 서버 설정·권한을 변경하지 않았다. 운영자가 직접
수행한 내용 없는 진단 결과는 Claude의 저장 인증 만료였고, 인증 갱신은 직접
로그인을 수행해야 하는 별도 사용자 작업이었다. 운영자가 review 계정에서 로그인을
완료한 뒤 실제 서버 readback은 quota available, 기존 Claude 검토 3건 running이었다.
이 인증 복구를 검토 verdict나 제품 활성화 승인으로 처리하지 않는다.

## 실제 Claude 검토 후 인증·운영 감시 보강

제품 head `0cdfedb342a9d9049ddd62af4ee06dc8a48a670e`의 실제 서버 검토
`r-20261010-001125-6ae218`는 Copilot/Moonshot ACCEPT,
Claude/Anthropic REJECT로 종료했다. Claude의 major는 인증 전 무거운 release
검증과 drift 상태에서 전역 audit lock을 반복 취득하는 동작이었다. preparing
요청의 13초 경과를 audit 실패로 오인하는 것과 전체 receipt 이력을 매번 검사하는
비용도 minor로 보고했다. 인증 복구 또는 한 vendor의 ACCEPT를 독립 검토 완료로
표시하지 않았으며, 아래 실제 코드 변경을 다음 두 vendor 검토에 보낸다.

- proposal/prepare는 route 진입 시점부터 13초 deadline을 잡되 session과 origin
  검증 뒤에 product handler를 호출한다. handler는 rate-limit 뒤에 mode별 view를
  읽고 closed면 body·draft capture를 건너뛴다. anonymous/invalid-origin은
  handler·release 호출 0회, 429는 release·body·capture 0회다.
- UI는 signed-in Chat에서만 side-effect-free DB view를 읽고 두 capability
  boolean만 넘긴다. guest·Review·loopback fixture는 product release를 읽지
  않는다. UI view는 source·price·승인 감사 검증이나 drift latch를 실행하지 않는다.
  product service와 Chat decision consume은 별도의 fresh exact admission으로
  source·price·배포·승인 감사를 매번 재검증한다. positive cache는 없다.
- 이미 paused인 guard는 전역 audit lock을 다시 취득하지 않는다. 활성 상태의
  전이는 audit→guard 잠금 순서와 같은 transaction의 canonical audit를 유지한다.
  최근 완료 100건의 품질 분모와 execution/disposition 감사 조회를 제한하되,
  현재 writer가 기록한 정확한 receipt ID는 별도로 확인한다. provider 완료 시각이
  오래되어 최근 100건 밖인 late receipt의 critical/unknown/감사 누락도 즉시
  중단한다. 동일 transaction의 execution 및 disposition writer가 이 ID를 넘긴다.
- preparing 상태와 13초 경과만으로 감사 실패를 만들지 않는다. 확정 settlement
  후 receipt cleanup을 기다리는 상태는 이를 근거로 중단하지 않는다. 미확정
  dispatching hold가 13초 execution 상한을 넘으면 unknown dispatch/cost로
  중단하고, 기존 unknown hold와 현재 receipt의 unknown도 그대로 중단한다.
  새로운 grace 기간·재호출·예산 release 예외는 추가하지 않았다.
- Copilot의 비차단 minor인 intent 전이 결과 불명 시 full hold 유지 동작은 보존했다.
  DB 전이 시작 후 결과를 모른다는 사실은 undispatched 증거가 아니므로 release,
  blind retry 또는 자동 sweep으로 바꾸지 않았다.

관련 실제 검증은 execution 80/80, product server 42/42 및 client 23/23,
loopback PostgreSQL 33/33, protected writer/deployment/legacy proposal 45/45다.
현재 receipt ID 전달, late receipt 및 125개 후발 receipt, 확정 정산 후 cleanup,
미확정 dispatch, already-paused lock 0회, owner generation-bound resume를 포함한다.
중간 guard 파라미터 이름 충돌로 실패한 로컬 실행은 보존한 뒤 수정해 재실행했다.
보호 table writer의 정확한 read mention pin만 갱신했으며 writer 경로·write verb
허용 범위·migration bytes는 늘리거나 바꾸지 않았다.

이 보강 소스의 full lint, 독립 8GB typecheck, production build,
security regression 196개와 필수/readiness 정적 검사 13개도 통과했다.
전체 unit/server 재실행은 앞 회차의 별도 기록이며 이 관련 검사 합계에 합치지 않는다.

수정 commit의 두 vendor 재검토와 CI·PR·병합·정확한 배포·실사용 검증은 아직
별도 단계다. Auto Router 세 출시 판정은 pending이며 실제 holdout 자료는 읽지
않았다. 예외 정책·UI view·로컬 합성 통과를 제품 활성화 또는 전면 출시 판정으로
승격하지 않는다.

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
