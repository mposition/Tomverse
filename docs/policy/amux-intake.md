# AMUX intake

상태: **v1~v4 설계 승인, v5 구현 착수·보존 계약, v6~v10 보존·산출 계약, v11 단위별 결정·파생 이력, v12 실행 위치·식별자·권한 경계, v13 분석 호출 상한, v14 코드 전용 활성화 PR 및 v15 순차 live 활성화 승인.** 운영자 `mposition`이 2026-09-24에 v1, 2026-09-28에 v2, 2026-09-29에 v3를 승인하고, 2026-09-30에 v3 등록 래치 활성화와 v4 새 경로의 설계를 승인했다. 2026-10-01 v5는 18개 전체 작업의 정책·계약·코드·migration 파일 작성·로컬 합성 검증 착수를, 같은 날 v6~v12는 아래 계약을 승인했다. 2026-10-04 v13은 호출 시간·횟수만 확정했다. 2026-10-08 v14는 v4 코드 래치 전용 PR 작성을 승인했다. 2026-10-09 v15는 남은 v4 live 활성화를 아래 순서와 독립 gate로 승인했다. v22 자동 승격과 worker 실행은 이 승인에 포함하지 않는다.
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 1
approvedBy: mposition · approvedAt: 2026-09-28 · 정책 버전: 2
approvedBy: mposition · approvedAt: 2026-09-29 · 정책 버전: 3
approvedBy: mposition · approvedAt: 2026-09-30 · 정책 버전: 4
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 5
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 6
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 7
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 8
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 9
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 10
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 11
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 12
approvedBy: mposition · approvedAt: 2026-10-04 · 정책 버전: 13
approvedBy: mposition · approvedAt: 2026-10-08 · 정책 버전: 14
approvedBy: mposition · approvedAt: 2026-10-09 · 정책 버전: 15

v1~v3의 기록에 있는 `USD 상한 미정`은 그 이전 원천의 사실이다. **v4 분석 Agent의 API 월 USD 50은 2026-09-30 운영자가 이 버전에서 새로 승인한 값**이며, 구독형 CLI의 실제 청구액이라고 주장하지 않는다. v4 분석 경로의 **운영상** 보존·삭제 기간은 2026-10-01 v5에서 새로 승인했고, 미종료·미결정 체류와 brief·hold의 세부 수치는 같은 날 v6, 자동 만료 초안 본문 삭제 시점은 v7, 노드·카드 제목·설명의 기간은 v8, 카드 작업 본문의 기간은 v9에서 추가 승인했다. 이것은 법률 의견이 아니며, v1~v3 원천의 법적 보존 기간은 여전히 미정이다. 과거 기록을 소급 수정하지 않는다.

v1 승인은 설계 권고 16개를 승인했고 그때 법적 보존 기간과 USD 상한 숫자는 정하지 않았다. 그 원천의 production backlog 등록은 2026-09-24에 mposition이 단계 8로 승인했다. 코드 래치 `AMUX_INTAKE_APPLY_CODE_LATCH`는 그 승인으로 켜진다. 환경 값이 `TOMVERSE_AMUX_INTAKE_APPLY=enabled`가 아니면 writer는 열리지 않는다. 이 환경 값과 코드 래치는 사람이 확인하는 `codex-conversation` 원천의 writer에만 걸린다. 에이전트 등록 원천의 writer는 이 값으로 열리지 않는다. v4 Agent의 월 USD 50 결정은 아래 v4 절에만 적용한다.

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-09-24 mposition | 수동 Codex draft를 owner Admin이 확인하는 intake. 앱은 LLM을 호출하지 않고, Codex는 앱에 직접 쓰지 않는다. |
| 1 | 2026-09-24 mposition | 단계 8 production backlog write를 승인한다. 코드 래치를 켠다. 법적 보존 기간과 USD 상한은 정하지 않는다. |
| 2 | 2026-09-28 mposition | 에이전트 등록 원천. 사람이 확인하는 원천의 규칙을 그 원천으로 한정하는 범위 문장을 더하고, 엔지니어링 Agent의 등록 원천 절을 추가한다. 새 원천의 코드 래치는 끈 채로 둔다. 승격과 사람 경로 규칙은 바꾸지 않는다. |
| 3 | 2026-09-29 mposition | 로컬 분석 원천. 운영자 PC의 Frontier 분석 package를 Admin에서 카드마다 확인한다. 코드 래치는 끈 채로 둔다. 환경 값은 설정하지 않는다. |
| 3 | 2026-09-30 mposition | 로컬 분석 원천의 production 등록을 연다. 코드 래치 `LOCAL_INTAKE_APPLY_CODE_LATCH`를 켠다. writer는 `TOMVERSE_AMUX_INTAKE_LOCAL_APPLY=enabled`일 때만 열린다. 법적 보존 기간, DPA, 라이브 모델 호출은 이 승인이 정하지 않는다. |
| 4 | 2026-09-30 mposition | Admin 아이디어 입력부터 계층·카드 승인까지의 새 분석 경로, 로컬 Ubuntu CLI Agent, 카드 수에 따른 거절 폐기, 포트폴리오 평가와 결과 환류의 계약을 승인한다. 분석 Agent의 API 월 USD 50은 이 버전에서 승인한다. 구현·migration·모델 호출·운영 스위치 활성화는 이 승인에 포함하지 않는다. |
| 5 | 2026-10-01 mposition | 아래 v5의 **18개 전체 작업에 대한 정책·계약·코드·migration 파일 작성·로컬 합성 검증 착수**와 v4 입력·분석 초안·결정 기록의 보존·삭제 기간 및 legal hold 기본 요건을 승인한다. 최대 hold 기간은 미승인이고 설정 기능은 닫힌다. 비공개 문서의 Claude 독립 검토에 Max 구독 인증 사용을 별도로 승인한다. migration 적용·staging write·라이브 아이디어 분석·production flag·자동 병합/배포 또는 미검증 S0 면제는 아니다. |
| 6 | 2026-10-01 mposition | 입력 뒤 7일에 미종료 분석 자동 취소·24시간 안 원문 삭제, 완료 뒤 30일 미결정 초안 만료, 승인된 실행 brief의 완료·취소 뒤 90일 보존, legal hold 건당 최대 90일·7일 전 알림·owner 재인증과 사유 기록을 거친 수동 연장 계약을 승인한다. **자동 만료 뒤 초안 본문 삭제 시점은 미결정이고 비합성 저장은 차단**한다. v5의 닫힌 구현·운영 gate는 그대로다. |
| 7 | 2026-10-01 mposition | v6에서 열린 결정을 닫는다. 분석 완료 30일 뒤 미결정 초안이 자동 만료되면 미승인 초안 본문은 즉시 삭제 대상이 되며 **만료 후 24시간 이내** 삭제한다. digest·결정 metadata·canonical 감사의 7년 보존 및 v5의 닫힌 운영 gate는 그대로다. |
| 8 | 2026-10-01 mposition | v4에서 생성하는 계층 노드와 카드의 사용자 표시 제목·설명은 활성 상태 동안 보존하고, 완료·취소·보관 후 90일에 본문을 삭제한다. 식별자·keyed digest·결정 감사는 7년 보존한다. 기존 gate와 v1~v3 원천은 바꾸지 않는다. |
| 9 | 2026-10-01 mposition | v4 카드의 문제·포함/제외 범위·완료 기준도 v8과 같은 규칙으로 활성 중 보존하고 카드 완료·취소·보관 후 90일에 본문을 삭제한다. v8 제목·설명 외 범위의 보존 결정을 이 항목에 한해 닫는다. |
| 10 | 2026-10-01 mposition | Task 카드 승인 preview의 예상 실행 경로·비용 상한은 서버가 버전 고정된 worker/model 가격표와 등급별 토큰·시도 상한으로 산출한다. 실행 전 다시 계산해 상한이 높아지면 운영자 재확인을 요구한다. 계산 근거가 없으면 등록·실행을 보류한다. 실제 숫자와 catalog 증거는 별도 구현 gate다. |
| 11 | 2026-10-01 mposition | v4 전용 단위별 사람 결정과 분할·통합 파생 이력을 승인한다. 아래 v11 절의 별도 결정 행·결속·불변식과 부분 등록 경계를 적용하고 v1~v3 승인 행은 재사용하지 않는다. |
| 12 | 2026-10-01 mposition | 공통 기반의 AMUX v4 전용 로컬 Ubuntu 분석 예외와 운영자 확인을 전제로 한 제한 GitHub 원문 전송 허용 범위를 승인하고, 이 원천의 식별자·owner 수동 쓰기·v22 자동 편입 경계를 확정한다. 아래 v12 절의 미완 S0·별도 활성화 gate는 유지한다. |
| 13 | 2026-10-04 mposition | 분석 CLI 호출 1회 hard deadline 10분, Agent 전체 DB UTC 하루 최대 12회, 상한 초과 보류, 자동 재시도 금지를 승인한다. live runner·S0·운영 래치는 열지 않는다. |
| 14 | 2026-10-08 mposition | v4 전용 코드 래치를 준비하는 단일 PR 작성을 승인한다. 분석 queue/result read/claim/result write·라이브 CLI·보존 삭제/hold write 래치는 그대로 닫고, 모든 v4 운영 환경 스위치와 라이브 호출·쓰기·자동 실행은 별도 검증·승인 전까지 열지 않는다. v22와 v1~v3 경로는 바꾸지 않는다. |
| 15 | 2026-10-09 mposition | 남은 v4 live 활성화를 코드 래치 PR → production 합성 key 삭제 증거 → 승인 모델·가격 등록 → 전용 Ubuntu 서비스 연결·검증 순서로 승인한다. 각 단계는 앞 단계의 증거와 별도 환경 스위치를 요구하며 main 병합은 운영자만 한다. v22 자동 승격과 worker 실행은 열지 않는다. |

아래 v3 절은 2026-09-29에 운영자 mposition이 승인했다. 더 세밀한 시각은 없다. 그 설계 승인은 코드 래치를 켜지 않고 환경 값을 설정하지 않는다. 2026-09-30 활성화 승인이 코드 래치를 켜고, 환경 값이 `enabled`일 때만 writer를 연다. v1과 v2의 writer는 바뀌지 않는다.

실행 제어는 `docs/policy/development-agent-orchestration.md`가 정한다. 두 문서가 충돌하면 적용 범위가 좁은 쪽이 이긴다.

## 조합

v1이 조합하는 것은 셋뿐이다. 에이전트 등록 원천은 아래 별도 절이 정한다.

- 운영자가 명시적으로 선택한 등록 요청
- work id, version, digest와 짧은 제안. 비공개 상세 원문은 받지 않는다
- AMUX Admin preview와, 래치가 켜진 뒤의 deterministic writer

Chat, Message, Memory, 결제, 사용자 credit 테이블은 읽거나 쓰지 않는다. 앱 route가 모놀리스 DB 자격증명을 가진다는 사실을 물리적 격리라고 말하지 않는다. 외부 생성기는 그 자격증명을 받지 않고, 앱 안 writer는 코드, 테스트, DB 불변식으로 제한한다.

## 식별자와 권한

이 절의 식별자(`agentId` `amux-intake`, `sourceSystem` `codex-conversation`, `sourceKey`)와 '등록, 승인, 승격의 행위자는 사람이다'는 사람이 확인하는 원천에 적용한다. 에이전트 등록 원천의 식별자와 행위자는 그 절이 정한다. 승인과 승격의 행위자는 어느 원천에서나 사람이다.

- `agentId`는 `amux-intake`다
- `sourceSystem`은 `codex-conversation`이다
- `sourceKey`는 Codex task id의 HMAC이다. 원문 id는 저장하지 않는다
- system actor `tomverse-amux-orchestrator`는 자동 만료와 reconciliation에만 쓴다
- 등록, 승인, 승격의 행위자는 사람이다

`platformProductKey`는 v1에서 쓰지 않는다. 현재 닫힌 값에 없는 이름을 다른 값으로 대체하지 않는다. 앱이 LLM을 호출하게 되면 그 전에 별도 값을 계약에 추가한다.

v1의 화면은 owner 전용이다. 위임은 하지 않는다. `ops:write`를 intake 승인 권한으로 확대하지 않는다.

## 하지 않는 것

v1에서 하지 않는 것은 다음이다. 에이전트 등록 원천에 적용하지 않는 항목은 '별도 Railway Agent'와 'Codex에서 앱으로 가는 direct route' 둘뿐이다 — 그 원천은 제품 DB 자격증명이 없는 Agent 서비스가 Agent 전용 앱 route를 부른다. 나머지 항목은 그 원천에도 적용한다.

- 비공개 원문을 외부 LLM에 보내기
- 원격 Git push
- backlog에서 todo로의 승격
- provider 호출, 외부 게시, 배포
- 사용자 credit 변경
- Codex에서 앱으로 가는 direct route
- 별도 Railway Agent
- Publisher
- `AmuxBoardImportApproval` 행을 intake 승인으로 재사용
- 자율 졸업

backlog 등록은 실행이 아니지만 canonical write다. 그 write는 owner의 최근 step-up과 이 문서의 코드 래치, 환경 래치가 함께 있어야 한다. 환경 값은 `TOMVERSE_AMUX_INTAKE_APPLY=enabled`뿐이다. 이 문단의 owner step-up, `AMUX_INTAKE_APPLY_CODE_LATCH`, `TOMVERSE_AMUX_INTAKE_APPLY`는 사람이 확인하는 원천의 backlog 등록에만 적용한다. 에이전트 등록 원천의 write는 그 절의 래치·환경 값·운영 mode로만 열리고, 사람 step-up을 요구하지 않는다.

## Guard

이 절의 `approval_required`·확인 digest·draft·approval·human audit·15분 승인 창·넷을 읽는 read-back은 사람이 확인하는 원천에 적용한다. 에이전트 등록 원천은 그 절이 정한다.

Guard의 결과는 `reject`, `approval_required`, `allow` 셋이다.

- `reject`: 명시적 등록이 아님, 완료 단위가 하나가 아님, 필수 metadata 누락, secret이나 경로, schema나 digest 불일치, 같은 identity의 다른 digest
- `approval_required`: 제안은 유효하고, 확인 digest가 아직 없음
- `allow`: 확인 digest와 현재 payload의 draft digest가 같고, backlog 한 건만 가능한 상태

서버가 schema, 완료 단위 수, source identity, digest, 중복을 다시 계산한다. 제안의 title, scope, completion과 work item id, version은 카탈로그 내용 스캐너를 통과해야 한다. work item digest는 SHA-256 64자 hex만 허용하고 자유 문장으로 스캔하지 않는다. 요청 JSON 전체를 한 문자열로 스캔하지 않는다. 원문 task id는 저장하지 않으므로 스캐너 대상이 아니다. 길이, 제어 문자, 경로 구분자를 거절한다. 제안 안에 Codex task id가 다시 나타나면 거절한다.

## 저장

이 절의 `approval_required`·확인 digest·draft·approval·human audit·15분 승인 창·넷을 읽는 read-back은 사람이 확인하는 원천에 적용한다. 에이전트 등록 원천은 그 절이 정한다.

raw 대화 원문은 앱 DB에 두지 않는다. 승인 전 draft의 기술적 상한은 24시간이다. 이것은 법적 보존 기간이 아니다. 결정 뒤에는 본문을 지우고 digest와 결정 metadata만 남긴다. 카드에는 opaque reference, version, digest만 남긴다. 승인 창은 15분이다.

같은 `(sourceSystem, sourceKey)`에 다른 digest가 오면 덮어쓰지 않고 conflict다.

카드는 `backlog`, kind `unknown`, owner 없음으로만 만든다. 우선순위는 확인된 제안의 `p0`에서 `p3`다. attempt, delivery, route decision, claim을 만들지 않는다.

감사 metadata에는 approval id, digest, count, policy version, scanner version만 넣는다. 원문, 제목, secret finding은 넣지 않는다.

Preview는 DB에 쓰지 않는다. 등록 트랜잭션의 결과가 불명확하면 카드, draft, approval, audit를 한 번 읽는다. 넷이 같은 digest로 있으면 그 등록은 성공이다. 하나도 없으면 `outcome_unknown`이고 read-back은 `absent`다. 일부만 있으면 `outcome_unknown`이고 read-back은 `partial`이다. 그 읽기는 쓰지 않고 두 번째 트랜잭션을 열지 않는다. 자동 재시도는 없다. card 생성, approval consume, audit는 한 트랜잭션이다.

## 표시와 지역

draft를 등록 완료로, backlog를 실행 중으로, 제안을 검증 완료로 표시하지 않는다. 중국 본토의 접속, 처리 region, 그 지역의 provider는 쓰지 않는다. 이 문장은 언어 코드와 별개다.

## 아직 열지 않는 것

다음은 **v1의 단계 8과 별개로 그 v1 원천에서** 닫혀 있다. v4 신규 경로의 분석 Agent 비용과 등록 뒤 자동 승격 자격은 아래 v4 절이 별도로 정한다.

- 법적 보존 기간
- v1 경로에서 S0 실측 뒤 정할 USD 상한
- 앱이 LLM을 호출하는 경로
- Codex direct connector
- backlog에서 todo로의 승격

production backlog write는 2026-09-24에 mposition이 단계 8로 승인했다.

## 단계

아래 1–8은 사람이 확인하는 원천의 단계다. 에이전트 등록 원천의 단계는 그 원천의 Agent 정책이 정한다.

1. intake 정책 승인. 2026-09-24에 완료.
2. 계약, strict schema, Guard. 코드 래치는 꺼진 채로 둔다.
3. DB schema, 단일 writer, audit. 코드 래치는 꺼진 채로 둔다.
4. 합성 데이터와 fault injection.
5. staging에서 preview만.
6. staging backlog write.
7. production에서 preview만.
8. production backlog write. 2026-09-24에 mposition이 승인했다. 코드 래치와 `TOMVERSE_AMUX_INTAKE_APPLY=enabled`가 함께 있어야 writer가 열린다.

## 책임

상세 문서 갱신, 카드 수정, reconciliation, governance cutover의 책임자는 운영자 `mposition`이다. 역할은 넷이고, 한 사람이 넷을 겸하는 것은 이 조직의 현재 사실이다. intake 등록은 이 넷을 대신하지 않는다.

- 상세 문서: 현황판이 정본인 동안 카드가 상세를 덮어쓰지 않는다.
- 카드 수정: owner의 human audit가 있는 별도 변경이다. 등록은 backlog 한 건만 만든다.
- reconciliation: 별도 run이다. 같은 source key의 다른 digest는 conflict이고, 저장된 digest와 관측된 digest를 둘 다 남긴다.
- governance cutover: 별도 승인이다. 이 문서가 cutover를 수행하지 않는다.

## 등록 트랜잭션

이 절의 `approval_required`·확인 digest·draft·approval·human audit·15분 승인 창·넷을 읽는 read-back은 사람이 확인하는 원천에 적용한다. 에이전트 등록 원천은 그 절이 정한다.

미리보기는 DB에 쓰지 않는다. 공개 route는 코드 래치가 켜져 있고 환경 값이 `enabled`일 때만 트랜잭션을 연다. 그 한 트랜잭션이 backlog 카드, 본문이 비어 있는 draft, consumed approval, human audit를 함께 쓴다. 그 트랜잭션은 todo, owner, claim, attempt, delivery, route decision, provider 비용, 사용자 credit를 늘리지 않는다. 같은 source key의 동시 등록이 유니크 제약에 걸리면 conflict다. 응답이 끊기면 위 read-back을 한 번 하고, 확정되지 않으면 `outcome_unknown`이며 자동 재시도를 멈춘다.

저장하는 `sourceKey`는 HMAC의 대문자 hex다. 기존 카드의 source key 검사에 맞추기 위한 형태이고, 원문 task id는 저장하지 않는다.

## 에이전트 등록 원천

사람이 고른 요청과 별개인 두 번째 등록 원천이다. 개별 Agent 정책이 이름 댄 원천을 그 Agent가 분석해 `backlog` 카드를 등록한다. **등록은 실행이 아니고 승격이 아니다.** `backlog`에서 `todo`로 가는 규칙은 바뀌지 않는다.

**원천.** 승인된 것은 엔지니어링 Agent 하나다(`docs/policy/engineering-agent.md` §2.2의 원천 표). 원천을 더하거나 바꾸는 것은 이 문서와 그 Agent 정책 **둘 다**의 개정이다.

**식별자.**

- `agentId`는 그 Agent의 id다(`engineering-agent`).
- `sourceSystem`은 원천마다 하나인 닫힌 값이다: `engineering-product-backlog`, `engineering-develop-ci`, `engineering-dependabot-ci`.
- `sourceKey`는 원천별 canonical identity의 HMAC 대문자 hex다. `engineering-product-backlog`는 backlog 항목 key, `engineering-develop-ci`는 `develop` head SHA와 check-run id, `engineering-dependabot-ci`는 PR 번호와 head SHA이며, 각 tuple은 순서와 구분자가 고정된 형태로 canonicalize한다. 원문 tuple은 저장하지 않는다.
- 행위자는 system actor `engineering-agent-registrar`다. 이 actor는 닫힌 system audit actor 목록에 추가되고 canonical system audit 함수로만 쓴다. 사람 승인 행과 step-up은 없다. v1의 draft·approval 행을 만들거나 재사용하지 않는다.

**모델.** 앱은 LLM을 호출하지 않는다. 분석은 제품 DB 자격증명이 없는 그 Agent의 서비스가 하고, 모델에 가는 것은 공개 저장소와 공개 CI의 원문뿐이다. 모델 출력은 제안이며 등록 여부를 정하지 않는다.

**Guard.** 결과는 `reject`와 `allow` 둘뿐이다. `approval_required`, 확인 digest, 사람 step-up, "운영자가 명시적으로 고른 요청"은 이 원천에 쓰지 않는다. `reject`는 완료 단위가 하나가 아님, 필수 필드 누락, 내용 스캐너, 경로·제어 문자·길이, digest 불일치, 같은 identity의 다른 digest(conflict), 그리고 그 Agent 정책의 결정적 Guard(원천 identity가 고정 commit에 실제로 있는지, 항목 digest를 그 commit에서 다시 계산해 같은지, secret 패턴, 중복, 상한)다. 어느 것에도 해당하지 않을 때만 `allow`다.

**카드.** v1과 같다 — `backlog`, kind `unknown`, owner 없음. 우선순위는 원천에 결정적으로 읽히는 값, 없으면 `p3`다. owner, claim, attempt, delivery, route decision을 만들지 않는다. 화면은 에이전트 등록 카드를 사람 등록과 구분해 표시한다.

**상한.** 회차당 3건, UTC 하루 10건, 이 원천으로 등록되고 아직 승격되지 않은 카드 20장. 앱 DB가 강제하고 모델 출력이 닿지 않는다. 상한을 바꾸는 것은 두 문서의 개정이다.

**트랜잭션.** 사람 원천의 writer를 재사용하지 않는 별도 writer가, 카드·그 Agent의 등록 기록·system audit을 한 트랜잭션으로 쓴다. 응답이 끊기면 셋을 한 번 읽는다. 셋이 같은 digest로 있으면 성공, 하나도 없으면 `outcome_unknown`(`absent`), 일부만 있으면 `outcome_unknown`(`partial`)이다. 자동 재시도는 없다. 감사 metadata는 v1과 같은 허용 값(식별자, digest, 개수, 정책 버전, 스캐너 버전)뿐이다.

**스위치.** 이 원천 전용 코드 래치(출고 값 false)와 환경 값 `TOMVERSE_AMUX_INTAKE_AGENT_APPLY=enabled`, 그리고 그 Agent 정책의 운영 mode가 함께 있어야 writer가 열린다. v1의 래치와 `TOMVERSE_AMUX_INTAKE_APPLY`와는 독립이다 — 한쪽을 켜도 다른 쪽은 열리지 않는다. 그 Agent의 정지나 이 환경 값의 해제는 다음 등록부터 막는다.

**이 절이 열지 않는 것.** 승격, 카드 수정, 비공개 원문의 외부 전송, `platformProductKey`, 사람 경로 규칙의 완화, 그리고 "하지 않는 것" 목록에서 위 두 항목을 뺀 나머지 전부(원격 Git push, provider 호출·외부 게시·배포, 사용자 credit, Publisher, 자율 졸업, `AmuxBoardImportApproval` 재사용 포함).

## 로컬 분석 원천

approvedBy: mposition · approvedAt: 2026-09-29 · 정책 버전: 3

이 절은 2026-09-29에 운영자 mposition이 승인했다. 더 세밀한 시각은 없다. 그 설계 승인의 코드 래치 출고 값은 false였고, `TOMVERSE_AMUX_INTAKE_LOCAL_APPLY`는 그 승인이 설정하지 않았다. 2026-09-30에 같은 운영자가 production 등록을 승인했다. 코드 래치는 그 승인으로 켜진다. v1의 `codex-conversation` writer와 v2의 에이전트 등록 writer는 이 절이 바꾸지 않는다.

이 원천은 사람이 확인하는 세 번째 등록 원천이다. 운영자 PC의 로컬 도구가 Frontier 모델로 분석 package를 만들고, 운영자가 Admin에서 package를 가져와 카드마다 확인한 뒤 `backlog`로 등록한다. 앱, Railway service, API route, 브라우저는 LLM을 호출하지 않는다.

**원천의 성격.** 기존 AMUX Intake의 새 source다. 로컬 화면이 등록을 대신하지 않는다. `codex-conversation`이나 v2의 세 `sourceSystem`에 이 분석을 넣지 않는다. 그 식별자는 다른 입력과 다른 행위자에 묶여 있다.

**식별자.**

- `agentId`는 `amux-intake`다. 로컬 도구는 그 agent의 초안 작성기고, 등록 행위자는 아니다.
- `sourceSystem`은 `local-agent-intake`다.
- `sourceKey`는 `analysisId`, 카드 `localId`, normalized digest를 묶은 HMAC의 대문자 hex다. 원문 입력, analysis id, 로컬 경로는 저장하지 않는다.
- 등록의 행위자는 사람이다. system actor는 자동 만료와 reconciliation에만 기존 `tomverse-amux-orchestrator`를 쓴다. v2의 `engineering-agent-registrar`는 이 원천에 쓰지 않는다.
- `platformProductKey`는 쓰지 않는다. 앱이 LLM을 호출하지 않으므로 새 값을 추가하지 않는다.

**모델.** 호출은 운영자 PC에서만 일어난다. 모델 id와 reasoning effort는 로컬 adapter 설정이다. 코드에 모델 이름을 고정하지 않는다. v1 허용 목록의 제안은 `gpt-6-astra`와 effort `high` 또는 `xhigh`뿐이다. 설치된 CLI의 카탈로그에 그 모델이 없거나, 설정이 허용 목록 밖이면 `frontier_model_unavailable`로 멈추고 더 작은 모델로 바꾸지 않는다. receipt에는 실제로 쓰인 model id와 effort를 남긴다. 요청한 값과 다르면 package는 거절한다.

**저장하는 것과 저장하지 않는 것.**

저장하지 않는다.

- 운영자 원문 입력
- LLM의 자유 형식 전체 응답
- `executionBrief`와 `executionBriefDigest`. 등록은 backlog이고 실행 승격이 아니다
- `description`. catalog import와 사람 원천이 null로 두는 컬럼이며, due 해석 입력이 될 수 있다
- `classification`, `projectKey`, `teamKey`. 등록 트랜잭션은 이 컬럼을 채우지 않는다
- `AmuxWorkDependency` 행. 선행 카드 id는 normalized 본문의 참조로만 둔다. edge를 만드는 것은 별도 승인이다

저장한다. 사람이 확인한 bounded normalized 객체 하나와 그 digest다. 제안 위치는 `AmuxWorkItem`의 기존 컬럼이 아니라, 그 카드와 같은 트랜잭션에 쓰는 전용 행이다. catalog 카드와 `codex-conversation` 카드는 그 행이 없다. v1이 소비된 draft의 `title`, `scope`, `completion`을 null로 두는 계약은 유지한다.

normalized 객체의 필드와 상한은 다음이다. 바이트는 UTF-8이다.

| 필드 | 상한 |
|---|---|
| `title` | 200바이트. 카드 `title`과 같은 값 |
| `problem`, `rationale`, `priorityRationale` | 각 2,000바이트 |
| `scopeIn`, `scopeOut`, `acceptanceCriteria`, `evidence`, `risks` | 각 최대 12개, 항목 500바이트 |
| `repositoryPaths` | 최대 32개, 항목 200바이트. 저장소 루트 기준 상대 경로. `..`와 절대 경로는 거절 |
| `dependencyIds` | 최대 16개. 등록 시점에 존재하는 카드 id만 |
| `duplicateCandidateIds` | 최대 8개 |
| `priority` | `p0` `p1` `p2` `p3` |
| `kindProposal` | 기존 `AmuxWorkItem.kind` 허용값. 카드에 쓰는 `kind`는 계속 `unknown` |
| `estimatedSize` | `small` `medium` `large` |

package 전체는 65,536바이트를 넘기면 거절한다. 카드 수 상한은 8이다. 근거는 한 번의 사람 검토에서 카드별 확인을 유지하는 단위이고, v2의 회차당 3건은 사람 확인이 없는 자동 등록의 상한이라 여기 복사하지 않는다. 9장 이상은 `card_cap_exceeded`로 package 전체를 거절한다. 잘라서 등록하지 않는다. 운영자 입력의 상한은 8,192바이트다.

canonical JSON은 기존 AMUX canonicalizer의 정렬 규칙을 쓴다. package digest와 카드 digest는 서로 다른 도메인 접두사를 가진 SHA-256이다. 카드 필드를 고치면 그 카드의 digest만 바뀌고, 그 카드의 확인은 무효다. 이미 등록된 다른 카드의 digest는 유지한다.

**분석 결과.** package의 `recommendation`은 `new_cards`, `possible_duplicate`, `extend_existing`, `needs_information`, `rejected` 중 하나다. `possible_duplicate`와 `needs_information`과 `rejected`는 등록 0이다. `extend_existing`은 기존 카드를 자동으로 고치지 않고, 운영자에게 대상 id와 차이만 보여 준다. 새 카드 등록은 `new_cards`에서 운영자가 고른 카드만이다.

**snapshot.** Admin이 최소화한 read-only snapshot을 파일로 내려 준다. production 페이지가 localhost를 호출하지 않는다. snapshot 필드는 카드 id, title, status, priority, kind, bounded summary, dependency id, source digest, 생성 시각, snapshot digest다. digest는 카드 목록만 덮고 생성 시각은 package의 `snapshotGeneratedAt`으로 따로 둔다. 그래야 서버가 현재 카드로 digest를 다시 계산할 수 있다. 사용자 데이터, audit 원문, credential, 비공개 문서 원문, 실행 산출물, 대화, execution brief는 넣지 않는다. 생성 시각이 24시간을 넘기거나 package의 snapshot digest가 그 내려받기와 다르면, 중복·확장 판단은 무효이고 재분석 전 등록은 거절한다. 서버는 등록 직전에 현재 보드로 identity, digest, 중복, dependency 존재와 cycle을 다시 계산한다. LLM의 유사도 판단은 그 검사를 대신하지 않는다.

**한 카드, 한 결정, 한 트랜잭션.** package는 여러 카드를 보여줄 수 있다. 등록은 카드마다 별도의 확인 digest, step-up이 유효한 동안의 사람 승인, 트랜잭션이다. 한 번의 승인으로 여러 카드를 쓰지 않는다. 중간 카드가 `outcome_unknown`이면 같은 package의 다음 카드를 자동으로 진행하지 않는다. read-back은 v1과 같다. 넷이 아니라, 이 원천의 읽기 집합은 카드, normalized 행, consumed approval, human audit이다. 넷이 같은 digest면 성공, 없으면 `absent`, 일부면 `partial`이다. 그 읽기는 쓰지 않는다.

**감사.** human audit metadata는 approval id, card digest, package digest, card count, policy version, schema version, scanner version, actor, source identity뿐이다. 원문, 제목, 본문, secret finding은 넣지 않는다. 기존 hash-chained audit writer만 쓴다.

**스위치.** 2026-09-30 승인으로 이 원천 전용 코드 래치는 켜져 있다. 환경 값은 `TOMVERSE_AMUX_INTAKE_LOCAL_APPLY=enabled`뿐이다. 둘 중 하나라도 빠지면 writer는 열리지 않는다. v1의 `TOMVERSE_AMUX_INTAKE_APPLY`와 v2의 `TOMVERSE_AMUX_INTAKE_AGENT_APPLY`와는 독립이다. 환경 값을 바꾸는 것은 사람이다. 모델과 system actor는 바꾸지 못한다. 로컬 도구에는 자동 실행이 없다. 운영자의 분석 요청 한 번에 프로세스 한 번이고, 자동 retry는 없다.

**비용.** 로컬 호출 비용은 운영자의 Frontier 구독이다. 사용자 credit, 플랜, Chat provider budget을 읽거나 쓰지 않는다. 서버 경로의 provider 호출은 0이다. USD 상한 숫자는 이 승인이 정하지 않는다. 서버가 LLM을 호출하지 않으므로 그 숫자는 이 원천의 writer를 여는 조건이 아니다. 법적 보존 기간도 2026-09-30 활성화 승인이 정하지 않는다. 레지스트리의 보존 기간은 계속 TBD다.

**지역.** 중국 본토의 접속, 처리 region, 그 지역의 provider는 쓰지 않는다. 운영자 입력과 snapshot을 로컬 도구 밖의 모델로 보내는 것은 국외 처리가 될 수 있다. 개인정보로 보이는 입력은 모델 호출 전에 거절한다. DPA와 처리 지역을 확인하기 전의 실제 모델 호출은 이 승인이 허용하지 않는다.

**아직 열지 않는 것.** 법적 보존 기간의 확정, DPA와 처리 지역 확인 전의 라이브 모델 호출, `executionBrief` 작성, dependency edge, `todo` 승격, owner claim, worker 실행, 원격 push, PR, 배포.

## v4 — Admin 아이디어 분석과 계층 등록

승인자 `mposition`, 승인일 2026-09-30. 이 절은 **새 Admin 분석 경로의 설계 승인**이다. v1~v3의 source identity, 래치, 승인 기록, 보존·등록 동작을 소급 변경하지 않는다. v3의 package당 8장 상한은 새 v4 경로에 적용하지 않지만, 기존 v3 경로에서 코드를 바꾸기 전까지 계속 강제된다. 이 문서만으로 migration, 라이브 CLI 호출, production 활성화, backlog→todo, worker 실행, Git push·PR·병합·배포를 허용하지 않는다. v1~v3의 `todo 승격을 열지 않는다`는 **등록 트랜잭션의 금지**이고, 등록을 마친 뒤 v22 별도 Guard가 `backlog→todo`로 옮기는 것을 영구 금지하는 문장은 아니다. v4 카드의 자동 승격은 `development-agent-orchestration.md` v22가 정하되, 기존 v1~v3 카드는 별도 opt-in·재검증 전까지 그 경로에 넣지 않는다.

### 운영자 입력과 분석 실행

1. 운영자는 Admin Console에서 아이디어를 직접 입력하고, 모델로 보낼 **정확한 입력 범위**와 분석 모델을 회차마다 확인한다. Admin은 입력·분석 요청·상태·결과·승인의 창구다. 브라우저와 앱 route는 LLM을 호출하지 않는다.
2. 제품 DB 자격증명이 없는 **운영자 PC의 로컬 Ubuntu Agent**가 기존 outbound WSL bridge 패턴으로 앱의 분석 대기열을 가져와 Codex CLI 또는 Claude CLI를 실행한다. 앱은 요청·결과의 단일 DB writer이고, 로컬 Agent는 DB에 직접 접속하거나 브라우저의 localhost 요청을 기다리지 않는다. 이 실행 위치는 공통 Agent 기반의 Railway 기본 원칙에 대한 좁은 개발-Agent 예외이므로, 구현 전에 그 원문 §6과 별도 정합성 개정·독립 검토가 필요하다.
3. 적격 공급자는 현재 OpenAI와 Anthropic뿐이다. 모델 이름을 정책의 영구 허용 목록으로 고정하지 않는다. 운영자가 공급자별 Frontier 적격 모델을 승인·철회하며, 매 실행에서 적격 모델 하나를 직접 선택한다. 선택 모델을 쓸 수 없으면 작은 모델이나 다른 공급자로 조용히 대체하지 않는다. xAI·GLM 등은 별도 정책 개정 전에는 후보가 아니다.
4. 기존 상업용 **API 계정**의 계약·지역 확인 기록을 CLI 구독 인증의 허가로 간주하지 않는다. 로컬 CLI의 실제 인증 방식, 약관·DPA·처리 지역, 모델과 전송 범위는 합성 입력으로 S0 실측하고 라이브 호출 직전 결정적 검사에 연결한다. 특정 처리 지역을 보장한다고 표시하지 않는다. 중국 본토 접속·처리 지역·해당 지역 공급자는 제외한다.
5. Agent의 GitHub 접근은 운영자가 권한을 가진 Tomverse 관련 **모든 저장소·PR·check의 읽기 전용** 범위다. 단, 읽기 자격증명을 가진 수집 경계가 필요한 repository/PR을 조회하고 크기·secret·개인정보 검사를 통과한 최소 발췌와 구조화 metadata로 전송 preview를 만든다. **이번 회차의 전송 preview에 없던 GitHub 발췌는 보내지 않는다.** 이어지는 분석 분량에서 새 발췌가 필요하면 별도 preview와 운영자 확인을 받는다. CLI 자식 프로세스는 **GitHub 읽기·쓰기 자격증명, 저장소 checkout, preview 밖 파일에 접근하지 못하고**, 비어 있는 격리 작업 디렉터리에서 확인된 preview payload만 입력받으며, 네트워크는 승인된 CLI 인증·모델 endpoint만 허용한다. 제품 DB·결제·사용자 credit·Chat provider 키도 CLI 환경·파일·credential helper·로그에 닿지 않아야 한다. 파일·도구·네트워크 격리를 합성 S0에서 실측하고 **매 호출 직전 환경·mount·도구·네트워크 허용 목록을 검사**하기 전에는 live runner를 열지 않는다.

### 계층, 분해, 승인

1. 분석은 입력의 규모·성격을 먼저 판단하고, 기존 Initiative(Project)→Epic→Feature 경로에 배치 가능한지 제안한다. 이 세 계층은 **영구 저장되는 비실행 노드**다. 맞는 경로가 없으면 새 노드를 제안할 수 있지만, **새 노드 각각의 생성**과 기존 경로 선택·변경은 운영자가 확인한다. 계층 분석 화면에 보이는 것만으로 노드나 카드는 저장되지 않는다.
2. 하위 카드는 User Story 또는 Task다. Story는 범위·완료 조건을 집계하는 카드이고, **worker 실행 후보는 Task**다. Bug는 Story의 문제 해결 subtype으로 표시하고, Error는 관측·재현 증거로 Bug/Story에 연결한다. Error가 바로 실행 후보가 되지는 않는다. Story의 Task는 설계·구현·테스트·독립 리뷰·검증 등 **한 완료 단위씩** 분리하고 선행 edge를 명시한다. `parentStoryCardId`는 선택적이어서 Task는 Story 아래 또는 Feature 바로 아래에 놓일 수 있다. Task에는 역할과 모델명이 아닌 실행 등급을 제안한다.
3. 한 아이디어가 큰 프로젝트라면 필요한 수의 Story·Task를 제안한다. **8장/9장 package 전체 거절 규칙은 새 경로에서 폐기한다.** 한 분석 분량은 최대 8개 카드 제안·64 KiB 정규화 출력·8 KiB 입력 발췌로 제한하고, 분량마다 CLI 호출은 한 번이며 자동 재시도하지 않는다. 이는 **분량 크기**이지 아이디어당 총 카드 수의 상한이 아니다. 넘는 입력/출력은 같은 package의 다음 분량으로 이어가고, 월 예산·시간/호출 상한에 닿으면 `분석 일시중지`와 남은 범위를 표시한다. 전체 아이디어를 거절하거나 일부를 조용히 누락하지 않는다. 프로세스 hard deadline과 하루 호출 상한은 합성 S0 후 구현 전에 수치로 확정하며, 미정이면 live 호출을 열지 않는다.
4. 운영자가 승인한 계층 경로와 독립적으로 검증 가능한 **각 카드의** 범위·완료 조건·근거·의존성·중복 후보·source digest를 preview한다. **Task의 실행 brief 원문과 digest, 작업 역할·실행 등급·예상 경로·비용 상한도 같은 카드 preview와 확인 digest에 포함**한다. brief가 없거나 운영자가 확인한 digest와 저장한 값이 다르면 카드는 `backlog`에 남아도 `ready`가 아니며 자동 승격할 수 없다. 새 상위 노드 승인과 카드 등록 승인은 별개의 행위다. 카드별 확인 digest, 최근 step-up, 결정적 Guard, 한 번 소비되는 승인이 일치할 때만 해당 카드 하나를 `backlog`로 등록한다. 다른 카드가 미완성이어도 검증된 카드만 부분 등록할 수 있으나, 미분석 범위와 미승인 노드를 숨기지 않는다. 카드 등록만으로 `todo`·claim·실행은 생기지 않는다.
5. 기존 Epic/Story와 일부 겹치면 새 항목 강행 대신 분할·통합·기존 항목 연결을 차이와 함께 제안한다. 운영자가 선택하고, 원 제안·이전 연결·새 revision·결정 이유를 append-only 이력과 canonical 감사에 남긴다. 같은 identity의 다른 digest는 자동 덮어쓰지 않는다.

### 전략 평가와 화면 계약

- 모델은 Initiative/Epic의 전략적 가치와 하위 카드의 기여·긴급성·의존성·예상 노력·가용 worker를 **근거와 불확실성**과 함께 평가한다. 점수 계산과 자격·용량 Guard는 버전 있는 결정적 코드가 맡고, 모델 출력만으로 SEV1 선언·승격·worker claim을 결정하지 않는다. 운영자의 수정·거절도 근거를 남긴다. 활성 포트폴리오는 7일, 전체 기준선은 28일마다 재평가하고 중대 사건에서는 조건부 조기 검토한다. 저장된 근거의 결정적 재계산은 예약 실행할 수 있지만 **근거 수집 시각은 갱신하지 않으며**, 해당 범위의 마지막 확인 근거가 7일 또는 28일을 넘으면 stale이다. **새 외부 자료를 모델에 보내는 재평가**는 이번 회차 전송 preview·모델 선택과 `agent/amux-intake` 예산 검사를 다시 거친다. 운영자 확인을 못 받아 새 근거가 만료되면 자동 승격을 보류한다. 승인된 `backlog` 카드의 점수와 실행 후보 선정은 별개다.
- 포트폴리오 점수 v1의 승인 기록: `mposition`, 2026-10-05. 각 0~5 평가에 Initiative 최대 20, Epic 15, Feature 10, Story 영향 10, Task 기여 20, 긴급성 10, 의존성 해소 5, worker 적합도 5를 배분한다. Story 없는 Feature 직속 Task에는 Story 10점을 Task 기여 가중치로 옮긴다. 예상 노력·실행 위험·불확실성은 감점한다. 모델의 수치는 출처가 제한된 제안일 뿐이며, 운영자 근거 확인과 결정적 재계산 없이는 저장 점수로 쓰지 않는다. 이 승인만으로 라이브 쓰기·승격·SEV1·worker claim을 열지 않는다.
- Admin은 아이디어 입력, 분석 진행·입력 범위·토큰, 계층/중복 제안, **노드별 승인**, **카드별 승인**, 포트폴리오 점수 근거, Kanban, DevOps형 계층 목록, 카드 상세/실행/PR 근거, 운영자 주의, 완료 판정, 결과 환류를 하나의 연결 흐름으로 제공한다. 미확인·미분석·`outcome_unknown`을 완료처럼 표시하지 않는다. 목록과 Kanban은 같은 앱 DB의 두 projection이며, 큰 계층을 위해 서버 페이지네이션과 지연 로딩을 사용한다.

### 비용·실패·보존

- 이 분석 Agent의 원가 namespace는 `agent/amux-intake`이며 사용자 credit·플랜·Chat provider 예산과 분리한다. **월 USD 50은 이 v4에서 승인한 API 모드의 실제 상한**이다. 구독형 CLI에서는 토큰으로 계산한 금액이 실제 청구가 아닌 **버전 있는 API 전환 예상액**임을 표시한다. 이를 실제 USD 청구 차단으로 주장하지 않는다. 호출 전에는 강제 가능한 최대 입력·출력 사용량과 남은 shadow 예산을 검사하고, **당월 기소비·예약액과 이번 호출의 최악 API 환산액의 합**이 USD 50을 넘거나 상한을 강제할 수 없으면 라이브 호출을 보류한다. 호출 뒤 사용량이 `unknown`이면 0으로 계산하거나 계속 진행하지 않고 다음 호출을 보류해 read-back/운영자 확인을 기다린다. 확인으로도 복구되지 않아 운영자가 해제하면 **호출 전에 예약한 최악 환산액을 shadow 원장에 소비한 채** 재개하며 unknown을 0이나 실제 청구액으로 바꾸지 않는다. 회차 수·실행 시간·토큰 상한은 별도 강제하며, 실패한 호출도 사용량에 포함한다.
- 분석 Agent **전체**에서 실제 실행 시도 3회 연속 실패하면 새 호출을 멈춘다. 호출 전 거절과 운영자 취소는 세지 않는다. 검증된 정상 완료만 연속 실패 수를 초기화한다. `outcome_unknown`은 횟수와 관계없이 즉시 멈추고 source key·digest·요청 id로 read-back한 뒤 사람에게 넘기며 blind retry하지 않는다. 정지 해제는 운영자와 최근 step-up·canonical human audit가 필요하다.
- 입력 원문과 자유 형식 모델 응답은 카드·감사에 복제하지 않는다. strict normalized package와 digest, 계층/카드별 결정·revision만 앱 DB의 전용 writer에 둔다. 원문·초안·결정 기록의 기술적/법적 보존 기간, 암호화, 상한, 삭제·legal hold 계약은 **구현 및 live 입력 전** 별도 승인한다. 기존 v3의 24시간 기술적 권고를 법적 기간으로 전용하지 않는다.
- 입력·비공개 MD·GitHub 텍스트는 모델에 대한 **데이터**다. 그 안의 지시·도구 호출은 실행하지 않는다. preflight의 secret/개인정보 scan이 실패하거나 계약·비용·모델 적격성·kill switch를 확인할 수 없으면 호출하지 않는다. 카드·노드 생성, 승인 소비, 감사는 각 행위의 같은 트랜잭션에 기록한다.

### 구현 전 고정할 계약과 공통 Agent 체크리스트

새 `sourceSystem`, package/노드/카드 ID·version·digest, 계층 FK와 cycle·삭제 불변식, 부분 등록 멱등성, strict schema·크기·보존, GitHub 읽기 범위, CLI 격리·계정 계약, 비용 가격표/누적 방식, 실패·중지·재개, 새 전용 래치와 Admin 권한/step-up을 구현 전에 정한다. 기존 세 원천의 래치·writer를 재사용해 우연히 열지 않는다. 이 정책은 다음 16개 설계 질문에 대한 현재 답을 함께 고정한다.

| # | 답 또는 구현 전 증거 |
|---|---|
| 1 조합·비접촉 | Admin 입력, AMUX 구조화 snapshot, 읽기 전용 GitHub만 조합. Chat·Memory·금융·사용자 credit 비접촉을 route·query 테스트로 입증. |
| 2 식별자·권한 | 새 source namespace와 Agent/system actor를 별도 등록. 입력·노드·카드·해제는 owner 권한과 최근 step-up, 자동 만료만 system. `platformProductKey`를 다른 값으로 대체하지 않고 필요하면 enum을 선행 개정. |
| 3 비가역 | 외부 CLI 전송은 범위 preview 뒤 운영자 제출, canonical 노드/카드 등록은 별도 승인. Git push·main 병합·production 배포는 이 원천의 권한 밖. 자율 카드 등록 졸업 없음. |
| 4 Guard | 요청·모델·전송범위·schema·digest·중복·계층·비용·switch에 `reject / approval_required / allow`; LLM은 제안만. |
| 5 외부 텍스트 | 최소 발췌를 typed data로 전달, instruction으로 실행 금지; 대화 전체·비공개 MD 전체 자동 수집 금지. |
| 6 자격증명 | GitHub 읽기 토큰은 수집 경계에만 두고, CLI의 읽기·쓰기 GitHub 토큰, checkout, preview 밖 파일, 미승인 네트워크 접근을 S0에서 거절·실측. 제품 DB·결제·사용자 credit·Chat provider 키의 env·파일·helper·child process·로그 접근도 검사. |
| 7 스키마·보존 | strict package, 단일 앱 writer, append-only revision, 계층 FK/cycle와 상태 trigger. 구체 보존 기간은 live 입력 전 별도 승인. |
| 8 비용 | `agent/amux-intake`, API 월 USD 50, CLI는 실제 청구와 환산 예상액 분리; 초과/불명은 보류, 사용자 원장 비접촉. |
| 9 스위치 | 입력 읽기·CLI 호출·노드/카드 쓰기·승격을 독립 fail-closed로 두고 kill switch는 새 호출/쓰기를 멈춤. 사람만 감사 후 해제. |
| 10 결과 불명 | source/request/package/card digest 멱등 lookup; read-back 전 재호출·재등록 금지. |
| 11 외부 연동 | CLI 인증/약관·지역·토큰 형식, GitHub 읽기 범위/철회, 앱 route 응답 유실·중복·복구를 합성 S0로 실측. API 계정 DPA를 CLI에 전용하지 않음. |
| 12 감사 | 입력 확인·노드 승인·카드 승인·거절·통합·해제는 human, 만료·복구 관측은 system. 상태 변경과 같은 canonical chain 트랜잭션. |
| 13 법규·지역 | ACL상 제안/저장/실행을 구별, APP 최소화·국외 처리 표시, 중국 본토 제외. |
| 14 단계·차단 | 정책/계약 → 합성 S0 → schema/Guard → staging preview → staging write → 별도 production 승인. 유출·무승인 write/승격·credential 노출·감사 누락은 차단. |
| 15 실행 위치 | 로컬 Ubuntu Agent의 좁은 예외는 공통 기반 §6 정합성 개정 후 사용. 앱은 DB writer/Guard, CLI는 격리된 생성; 양쪽 timeout, DB credential 없음, Publisher 없음. |
| 16 상태·승인 | queue/package/node/card/approval/usage는 앱 DB/Admin. 승인 digest·source version에 결속, 크기/secret scan 선행. 코드 PR 예외는 카드 등록에 적용하지 않음. |

## v5 — 구현 착수와 v4 분석 자료 보존 [결정, 운영자 mposition 2026-10-01]

v4의 보존 미결정은 이 절에서 **v4 신규 분석 경로에 한하여** 아래처럼 해소한다. v1~v3 당시의 역사 기록·writer·스위치를 소급 변경하지 않는다. v4 승인표의 `카드 수에 따른 거절 폐기`는 **카드 수만으로 패키지 전체를 거절하던 규칙을 폐기한다**는 뜻이며, 과거 승인 문구와 의미는 바꾸지 않는다. 운영자는 같은 날 **18개 전체 작업에 대한 정책·계약·코드·migration 파일 작성·로컬 합성 검증 착수**를 승인했다. 이 범위는 이 문서의 v4와 [`development-agent-orchestration.md`](./development-agent-orchestration.md)의 2026-09-30 운영자 `mposition` 승인 v22 설계를 함께 구현하는 작업이다. v22 자체는 설계 승인에 그쳤고, v5가 그 구현 착수를 기록한다. migration 적용이나 staging write는 해당 단계의 독립 검토·검증을 거친 뒤에도 운영자 `mposition`의 **별도 명시 승인 전에는** 하지 않는다. 운영자의 앞선 `S0 검증` 요청으로 이미 수행한 합성 S0는 고정 비민감 문자열 `S0_OK`를 구독형 Codex·Claude CLI에 각 한 번 요청한 시험이었고, 실제 추가 청구 여부는 청구서와 대조하지 않아 미확인이다. 비공개 S0·독립 검토 전송 이력의 기록 ID는 `AMUX-V4-LOCAL-CLI-S0-20261001`이며, 공개 저장소에는 그 경로·본문을 복제하지 않는다. 그 두 호출과 승인된 Claude 독립 검토 외에, 이 절은 새 분석 Agent의 실사용자 입력을 쓰는 모델 호출 또는 월 USD 50 API 예산 소비를 허용하지 않는다. 추가 합성 호출의 회차·비용·입력 범위는 운영자 `mposition`의 **사전 명시 승인**이 필요하다. 미완 S0, 독립 검토, staging 결과와 별도 운영 활성화 판정은 이 승인으로 통과하지 않는다.

구현 범위의 18개 완료 단위는 순서대로 (1) 정책·결정 gate, (2) 합성 S0, (3) v4/v22 데이터·권한 계약, (4) additive DB migration·불변식, (5) Admin 아이디어 입력·전송 preview, (6) 로컬 Ubuntu 분석 Agent, (7) 분석·분량 engine, (8) 중복·계층 결정, (9) 카드별 승인·backlog 등록, (10) 전략 포트폴리오 점수, (11) Task DAG·ready, (12) backlog→AMUX todo 자동 배정, (13) todo→worker claim·용량, (14) 전체 worker CLI 사용량 원장, (15) 실행·실패 복구, (16) Git/PR/배포 권한 경계, (17) Admin 실행 화면, (18) 결과 환류·단계별 활성화다. 이 목록은 착수 범위이지 각 단계의 운영 전환 승인이나 완료 판정이 아니다.

| 자료 | 보존·삭제 계약 |
|---|---|
| 운영자 아이디어 원문, 모델 전송 payload, 자유형 모델 응답 | 해당 분석의 **종료 또는 취소 뒤 24시간 안에 본문 삭제**. 카드·감사에 본문 복제 금지. 종료하지 않은 실행의 최대 체류 시간과 결과 불명 시 기산점은 live 전 별도 결정·테스트가 필요하며, 무기한 보존을 허용한다는 뜻이 아니다. 백업까지 포함해 이 기한을 만족할 수 있는지 live 전에 검증해야 한다. |
| strict 정규화 분석 초안 | 해당 초안의 **최종 결정 뒤 30일**에 본문 삭제. 운영자의 명시적 승인·거절·취소가 최종 결정이다. v4는 카드 수만으로 제안을 폐기하지 않는다. 결정 전 무기한 체류를 허용한다는 뜻이 아니며 미결정 만료 규칙은 live 전 고정한다. 승인된 카드에 복사하는 최소 실행 brief는 초안과 별개의 AMUX 운영 기록으로 분류하고, 그 보존·삭제 계약을 live 전에 확정한다. |
| digest, 결정 metadata, canonical 관리 감사 | 기존 관리 감사 기준인 **7년** 보존. 삭제된 원문·자유형 응답을 digest 또는 metadata에서 재구성할 수 없어야 한다. 짧고 예측 가능한 원문의 평문 SHA-256은 이 기준을 만족하지 못하므로 retained digest 설계에 비밀키 결속 등 사전 대입 방어와 별도 검증이 필요하다. 원문을 직접 해시한 값은 방어 검증 전에는 24시간 이후 보존 계층에 넣지 않는다. 비밀키의 회전·파기·장기 검증 계약도 live 전 고정한다. 기존 canonical digest의 의미를 이 절만으로 변경하지 않는다. |

legal hold는 이 정책의 **owner Admin 역할**(현재 운영자 `mposition`; `ops:write` 아님)이 최근 step-up으로 **사유·대상 범위·만료일**을 확인하고 동일 트랜잭션의 canonical 감사에 남긴 경우에만 지정된 본문·metadata·감사 계층의 해당 삭제를 일시 정지한다. 이미 삭제된 원문을 복원하는 hold는 없으며, hold는 대상의 원래 삭제 기한 전에 설정해야 한다. 해제 또는 만료 시 **원래 만료 기준**으로 정리하고 이미 그 시점이 지났다면 즉시 삭제 대기열에 올린다. 기간 없는 hold나 자동 연장은 허용하지 않는다. **최대 hold 기간·만료 전 알림·연장 절차를 운영자 `mposition`이 별도로 승인하기 전에는 legal hold 설정 기능 자체를 열지 않는다.** hold 중 접근도 기존 owner 권한과 감사 대상이다. 삭제 작업이 실패하거나 완료 여부가 불명이면 성공으로 표시하지 않고 read-back 후 정지·재시도 판정을 한다. 백업·암호화·물리 삭제의 구현 가능 범위는 live 전 검증한다.

2026-10-01 운영자는 **비공개 문서의 Claude 독립 검토에 Max 구독 인증 사용**을 별도로 승인했다. 범위는 해당 검토에 필요한 정책·S0 기록의 최소 diff 또는 전체 본문이며, 후자는 diff만으로 문서 내부 일관성을 판정할 수 없을 때 쓴다. S0 기록 전체 본문에는 합성 실행 관측과 호스트 경로·운영자 handle·commit SHA가 있었지만 실사용자 아이디어·자격증명은 없었고, 전송 범위·결과를 별도 기록했다. Max 인증을 상업용 API DPA 또는 실사용자 아이디어의 자동 전송 허가로 간주하지 않는다. 검토 실행은 도구 목록을 비우고 세션 보존을 끄며, 실제 전송 범위·모델·CLI 결과를 검토 기록에 남긴다. 운영자는 Max의 모델 개선 사용 설정이 꺼져 있음을 **후속 시점에** 직접 확인했으나, 초기 전송 전 설정 상태를 소급 증명하지는 않는다.

## v6 — 미완료·미결정 자료와 실행 brief·legal hold [결정, 운영자 mposition 2026-10-01]

이 절은 v5의 live 차단·별도 운영 승인 요구를 면제하지 않고, v5에서 미정으로 남긴 **기간 수치**만 추가한다. 승인된 자동 정리는 카드·완료 판정의 자동 승인이나 임의 삭제 권한이 아니다. 정리 실행은 닫힌 system actor, 조건부 상태 전이, 같은 트랜잭션의 canonical 감사, 결과 불명 read-back을 요구한다.

1. 운영자 아이디어 입력 시점부터 **절대 7일** 안에 분석이 끝나지 않으면 새 모델 호출을 막고 해당 분석을 자동 취소한다. 중간 활동·worker 재시작으로 7일을 연장하지 않는다. 이 취소는 노드·카드를 등록하지 않으며, 원문·전송 payload·자유형 응답 본문을 **취소 뒤 24시간 안에** 삭제한다. 정상 완료·사람의 취소·거절에도 같은 v5의 24시간 삭제 규칙을 적용한다. 실패는 자유형 오류 문자열을 7년 metadata에 복제하지 않고, 비본문 오류 코드를 v5의 결정 metadata로 분류해 digest·canonical 감사와 함께 기존 7년 기준으로 남긴다. 취소된 분석을 이어 쓰지 않고 새 요청·새 preview로 다시 시작한다.
2. 분석이 끝난 뒤 **30일** 동안 운영자가 승인·거절·취소하지 않은 초안은 자동 만료한다. 만료는 승인이 아니며 그 초안에서 신규 노드·카드를 등록하지 않는다. 이미 별도 승인·등록된 부분은 기존 카드·등록 규칙에 따르고, 결정 이력은 v5의 7년 감사 기준을 따른다. **자동 만료 뒤 미승인 초안 본문을 언제 삭제할지는 별도 운영자 결정 대기**다. v5의 명시적 사람 최종 결정 뒤 30일 규칙을 자동 만료에 조용히 확장하지 않으며, 그 기간이 확정되기 전에는 비합성 초안의 staging/live 저장을 열지 않는다.
3. 승인돼 저장된 Task 실행 brief 본문은 작업 진행 중 유지하고, 운영자가 **완료 또는 취소**로 판정한 뒤 **90일**에 삭제한다. brief digest·결정 metadata·canonical 감사는 v5의 7년 기준을 따른다. `blocked` 상태의 장기 체류와 노드/카드 제목·설명 보존은 별도 검증·정책 전에 live 입력을 열지 않는다. brief 본문을 감사나 사용량 원장에 복제하지 않는다.
4. legal hold는 **한 승인 건당 최대 90일**이다. 만료 **7일 전** owner Admin에게 알린다. 7일보다 짧은 건은 생성 직후 알림으로 대체하는 구현 해석을 검증한다. 연장은 기존 건이 만료되기 전에 owner가 다시 인증하고 새 사유·범위·만료일을 확인해 canonical human 감사와 함께 **수동 승인**할 때만 가능하며, 새 건도 90일을 넘지 않는다. 자동·무기한 연장은 없다. 해제·만료 때는 원래 삭제 만료 시각으로 되돌아가고 이미 지났으면 즉시 삭제 대기열에 넣는다. 알림 전달 실패나 hold 설정 결과 불명은 성공으로 추정하지 않는다.

24시간·7일·30일·90일은 DB 시계와 불변의 기준 시각에 묶고, 보존 정리는 백업·암호화·키 수명·삭제 확인까지 증명해야 한다. 정책 수치 승인만으로 legal hold UI나 정리 worker를 활성화하지 않는다.

v5 표와 본문에서 최대 hold 기간·미종료/미결정 체류를 미승인으로 적은 문장은 **그 시점의 역사 기록**이다. 이 수치는 v6에서 승인됐지만, 설정·정리 기능의 운영 활성화는 여전히 별도 gate다.

## v7 — 자동 만료된 미결정 초안 본문 삭제 [결정, 운영자 mposition 2026-10-01]

v6에서 열린 결정은 다음과 같이 닫는다. 분석 완료 시각에서 30일이 되는 절대 시각에 미결정 초안이 자동 만료되면, **미승인 초안 본문은 그 시각부터 즉시 삭제 대상이며 만료 후 24시간 이내 삭제**한다. 부분 승인된 초안에서는 미승인 본문 범위를 승인된 범위와 분리해 이 시계를 적용한다. 정리 작업이 늦게 만료 상태를 기록해도 삭제 기준 시각과 최종 기한은 연장되지 않는다. 만료된 초안은 카드·노드 등록에 재사용할 수 없다. 이미 별도 승인·등록된 카드·노드와 그 실행 brief는 각자의 보존 계약을 따른다. digest·결정 metadata·canonical 감사는 v5의 기존 7년 기준으로 남긴다.

유효한 legal hold는 v5·v6의 대상·권한·기간·감사 조건을 충족할 때만 해당 삭제를 일시 정지한다. 해제·만료 시 원래 기한을 다시 계산하지 않고 기한이 지났다면 즉시 정리한다. 이 결정은 비합성 자료 보존의 **정책 수치**를 확정한 것이며, 백업 포함 삭제 증거·키 수명·기타 미결정 gate나 migration 적용·staging/live write·운영 스위치 활성화를 승인하지 않는다.

## v8 — 계층 노드·카드 표시 본문 보존 [결정, 운영자 mposition 2026-10-01]

운영자가 승인한 v4 신규 경로의 Initiative/Epic/Feature 노드와 Story/Task 카드에 한정한다. 사용자에게 표시하는 **제목·설명**은 노드/카드가 활성인 동안 보존한다. 현재 v4 노드 schema의 상태는 `active`·`archived`뿐이므로 노드의 종료는 `archived`다. 카드는 완료·취소·보관을 종료로 본다. 각 종료 상태가 처음 확정된 DB 시각을 삭제 기준으로 잡아 **90일 뒤 해당 제목·설명 본문을 삭제**한다. 상태 변경을 되풀이하거나 정리 작업이 늦어져도 최초 종료 시각을 조용히 다시 시작하지 않는다. 카드의 Task 실행 brief는 별도 v6 계약을 따른다. 문제·범위·완료 기준처럼 제목·설명 외의 본문은 이 승인에 포함하지 않으며, 별도 보존 계약 없이는 비합성 카드 필드로 옮기지 않는다.

제목·설명 본문은 암호화된 전용 필드에만 두고, 일반 카드 필드·source snapshot·승인 receipt·canonical 감사·7년 이력에 복제하지 않는다. 현행 v4 카드의 일반 `title`은 비본문 placeholder이고 `description`은 `NULL`이다. 삭제 뒤에도 계층/카드의 식별자·revision **번호·ID만**·keyed digest·결정 metadata·canonical 감사는 기존 **7년** 기준으로 남긴다. revision snapshot에 제목·설명 본문을 넣지 않는다. 따라서 삭제된 항목은 본문이 없는 상태로 명확히 표시하며, digest에서 제목을 복구하거나 빈 제목을 원래 제목처럼 표시하지 않는다. 유효한 legal hold만 v5·v6 조건으로 삭제를 일시 정지할 수 있다.

현행 노드 schema에는 보관 시각과 본문 정리 상태가 없고, 카드의 표시 설명을 암호화해 보존·삭제하는 경로도 완성되지 않았다. 종료 뒤 재활성화와 이미 삭제된 본문의 복원·새 revision 절차를 별도 계약으로 정하기 전에는 그 전이를 허용하지 않는다. 이 수치 승인은 구현·migration **파일 작성**의 근거일 뿐, migration 적용·비합성 쓰기·정리 worker·staging/live 전환을 열지 않는다. 백업과 키 수명까지 포함한 삭제 증거를 별도 gate로 확인한다.

## v9 — 카드 작업 본문 보존 [결정, 운영자 mposition 2026-10-01]

v8이 제목·설명 이외의 본문을 명시적으로 제외한 뒤, 운영자는 v4 **카드의 문제, 포함·제외 범위, 완료 기준**에 한해 같은 기간을 별도로 승인했다. 현행 v4 카드 타입은 `story`·`task`뿐이다. 카드가 활성인 동안 해당 본문을 보존하고, 완료·취소·보관 후 **v8과 동일한 기산점에서 90일 뒤 삭제**한다. Task 실행 brief는 v6의 별도 계약이며, 오래 `blocked`인 brief의 추가 처리도 이 승인에 포함하지 않는다.

이 본문은 삭제 가능한 암호화 카드 필드에만 둔다. source snapshot·승인 receipt·canonical 감사·7년 이력·revision snapshot에 원문을 복제하지 않고, 식별자·revision 번호/ID·keyed digest·결정 metadata·canonical 감사만 기존 7년 기준으로 남긴다. 삭제 뒤에는 본문이 없는 상태로 표시하며 digest에서 원문을 복구하지 않는다. 유효한 legal hold는 v5·v6의 권한·기간·감사 조건에서만 삭제를 일시 정지한다. 현재 카드 schema에는 이 작업 본문의 암호화·기산·삭제 경로가 없으므로, 별도 additive migration·Guard·백업 포함 삭제 증거와 운영자 단계별 활성화 승인 전까지 비합성 카드 등록은 닫힌다. 기존 v1~v3 카드와 v4의 다른 자료 보존 기간은 바꾸지 않는다.

## v10 — Task 실행 경로와 비용 상한 산출 [결정, 운영자 mposition 2026-10-01]

v4의 **Task 카드** 승인 화면은 제안된 실행 역할·등급만 보여 주는 데 그치지 않고, 서버가 계산한 예상 실행 경로와 **강제 가능한 비용 상한**을 함께 보여 준다. 이 상한은 아이디어 분석 Agent의 별도 `agent/amux-intake` 월 US$50 예산이나 사용자 credit이 아니라, 해당 Task의 개발 worker 실행 경계에 속한다. 구독형 CLI의 토큰을 API 가격으로 환산한 금액은 **미래 API 사용 시의 예상액**이지 현재 구독료 또는 실제 청구액이 아니다.

1. 서버는 버전이 고정된 worker/model catalog와 공급자별 가격표, Task의 실행 등급별 입력·출력·캐시 토큰 및 최대 시도 횟수, 허용된 역할·도구·경로를 근거로 최악 허용 경로의 비용 상한을 계산한다. 선택 가능한 경로가 여러 개라면 실제로 허용할 경로 집합에서 가장 높은 상한을 사용한다. 계산 receipt에는 가격·catalog·등급 규칙의 버전/digest, 허용 경로, 토큰·시도 한도, 계산식과 산출 시각을 담고 Task의 확인 digest에 결속한다. 모델이 적어 낸 비용 숫자는 계산 입력이나 승인 근거가 아니다.
2. 근거 가격, 호출별 토큰 상한, 시도 상한 또는 해당 등급을 실행할 worker 경로 중 하나라도 검증되지 않으면 상한을 `0`으로 추정하지 않는다. **해당 Task의 신규 카드 등록과 실행을 보류**하고 누락 사유를 보여 준다. v4의 카드별 부분 등록 원칙에 따라, 한 분석 패키지의 다른 독립 카드가 같은 결함을 공유하지 않으면 그 카드의 별도 승인·등록은 막지 않는다.
3. 등록 전에 운영자는 계산 receipt와 Task의 실행 brief·역할·등급을 한 화면에서 확인한다. 승인된 상한·근거 버전과 해당 화면의 확인 digest는 변경 불가능한 승인 receipt로 남기며, 일반 `AmuxWorkItem.estimatedCostMicrousd` 하나를 이 승인된 상한처럼 해석하지 않는다. 그 컬럼의 기존 추정·guardrail 의미와 기존 카드 경로는 이 결정으로 바뀌지 않는다.
4. `ready`·claim·새 attempt 및 실제 호출 **직전** 서버는 현재 worker/model catalog와 가격·등급 규칙으로 경로·상한을 다시 계산한다. 승인된 경로 밖으로 바뀌거나 재계산 상한이 승인된 상한보다 높으면 실행을 멈추고 운영자의 새 preview·확인 digest·승인을 받는다. 상한이 같거나 낮아도 해당 경로가 승인 범위에 있는지, 호출 전 최악 비용을 예약하고 누적액이 승인 상한 안인지 결정적 Guard가 검사한다. 계산 실패·사용량 불명·예약 불능은 [`development-agent-orchestration.md`](./development-agent-orchestration.md) v22의 정지·read-back 규칙을 따른다. 승인 상한을 넘긴 뒤 사후 debt로 정산하거나 기존 `3×` 추정 비용 guardrail을 상한의 대체물로 쓰지 않는다.

운영자가 승인한 것은 **산출·재확인 방식**이다. 실제 catalog 항목, 가격 출처/버전, 등급별 숫자, 캐시·reasoning 계산, 예약·누적 ledger, 경로 변경 판정의 코드·테스트는 별도 구현 gate다. 이 절만으로 worker 실행, 외부 호출, migration 적용, staging/live write, 자동 승격 또는 배포를 열지 않는다.

## v11 — 아이디어 단위별 결정·파생 이력 [결정, 운영자 mposition 2026-10-01]

운영자는 v4 아이디어가 여러 분량과 계층 노드·Story·Task로 분해될 때 **노드와 카드 제안마다 별도 사람 결정을 남기는 방식**을 승인했다. 기존 v1~v3의 `AmuxIntakeApproval`·`AmuxLocalIntakeApproval`을 v4 승인으로 재사용하지 않는다. 아이디어 전체를 한 번에 승인하거나 모델이 등록·승격을 결정하지 않는다. 이 결정은 v4 신규 원천에만 적용하고 기존 등록·이관 이력은 변환하거나 덮어쓰지 않는다.

1. 분석 청크의 node/card/evidence 단위에는 아이디어 안에서 고유한 `localRef`와 불변 version·keyed digest를 둔다. 2026-10-01 승인에 따라 **청크 한 회차의 검토 상한 8장**은 아이디어 전체의 카드 수 상한이 아니다. 한 아이디어가 크면 청크를 나눠 이어가고, 아직 분석되지 않은 범위를 명시한다. 다른 청크의 단위는 이미 저장된 같은 아이디어의 ID·digest·사람 결정으로만 참조한다. 모델 텍스트가 기존 단위나 등록 카드를 임의로 선택하지 못한다.
2. Initiative/Epic/Feature 제안마다 `create_node` 또는 `select_existing_node`를, Story/Task 제안마다 `register_card` 또는 명시적 기존 대상 연결을 운영자가 **각각** 확인한다. `create_node`는 실행 작업이 아닌 비실행 계층 노드를 만든다. 거절도 `reject_unit` 결정이다. 카드 한 장의 승인으로 아직 만들지 않은 부모 노드를 묶어 승인하지 않는다. 승인한 독립 카드만 별도 트랜잭션에서 `backlog`로 등록할 수 있고, 등록만으로 `ready`·`todo`·claim·attempt·worker 실행은 일어나지 않는다. Bug는 Story subtype, Error는 그에 연결된 관측 증거이며 독립 실행 카드가 아니다.
3. 준비 receipt는 owner Admin의 최근 step-up·같은 브라우저 session·same-origin/CSRF를 확인한 뒤 **15분** 유효하게 만든다. service/API/Agent token은 준비와 소비에 사용할 수 없다. 단위 ID/version/keyed digest, 모델 전송 preview와 실제 확인한 source 범위, 선택한 계층·중복 대상의 ID/revision/keyed digest, Task의 brief·역할·등급과 v10 계산 receipt, 종속 관계와 정규화 본문 keyed digest를 한 확인 digest에 묶는다. receipt·감사·일반 카드 컬럼에는 아이디어 원문·모델 자유형 답·비공개 경로·secret·preview 본문을 복제하지 않는다. 운영자가 본문을 수정하면 원본을 덮지 않고 새 파생 단위와 새 확인을 요구하며, 그 새 본문도 v5~v7의 삭제 가능한 초안 보존 시계를 따른다.
4. 준비·소비·취소·무효화·만료는 v4 전용 앱 DB 결정 행의 단방향 상태 전이다. 한 단위의 활성 준비 행과 소비된 행은 각각 최대 하나다. 카드·노드 생성 또는 기존 대상 연결, 초안 상태, 결정 소비, canonical human 감사는 **같은 DB 트랜잭션**이다. 실행 결과가 사라져 COMMIT 여부를 모르면 같은 request ID·결정 ID로 읽어 확인하고 자동 재시도하지 않는다. 미해결 `outcome_unknown`은 **해당 결정 행·receipt의** 소비·만료 전이·재준비를 멈추되, 아이디어·초안 본문의 v5~v7 절대 삭제 기한은 연장하지 않는다. 운영자가 read-back과 새 확인으로 `no_commit`을 확정한 뒤에도 **같은 준비 행을 다시 소비하지 않고**, 이를 무효화/만료한 다음 새 preview·새 결정을 만든다. 적용된 카드/노드가 관측되면 `no_commit` 처리나 중복 등록은 거절한다.
5. 기존 Epic/Story와 일부 겹치면 운영자에게 연결·분할·통합·재제안의 차이를 보여 준다. 기존 카드나 노드의 제목·상태·source·revision을 조용히 바꾸지 않는다. `link_existing_card/node`는 새 카드/노드를 만들지 않고 승인된 대상의 ID/revision/digest에 결속된 불변 link만 추가한다. 첫 버전은 타입을 증명할 수 있는 v4 대상만 허용한다. 분할·통합은 원 단위를 덮지 않고 별도의 사람 승인 derivation group과 append-only edge로 남긴다. **새 파생 Story/Task 본문은 운영자가 직접 작성하고, 파생 그룹 승인과 카드별 backlog 등록 승인은 별개다**(2026-10-05, `mposition`). 승인된 원본은 상태를 되돌리지 않는다. 파생 단위와 뒤 청크에서 처음 제안한 단위 모두의 만료 기준은 원 아이디어의 **첫 청크 분석 완료 시각 +30일**이며 청크 추가·파생으로 다시 시작하지 않는다. 7년 기록에는 원문이나 자유형 사유 대신 ID·version·keyed digest·사유 keyed digest만 둔다.

이 절은 **단위별 결정 행과 별도 파생 이력의 설계 승인**이다. 실제 비용 catalog·숫자, 계층/중복 대상의 소비 시 재검증, DB 교차 행 불변식과 권한, 보존·백업 삭제 증거, canonical 감사·동시성·결과 불명 DB 테스트, 독립 검토, 단계별 운영자 승인이 갖춰지기 전에는 v4 비합성 등록 writer를 열지 않는다. 스키마 파일 작성이나 draft PR은 migration 적용·staging/live write·모델 실사용 호출·자동 승격·배포 승인이 아니다.

## v12 — 로컬 분석 실행·식별자·수동 권한 [결정, 운영자 mposition 2026-10-01]

운영자는 공통 Agent 기반의 Railway 기본 실행 위치에 대해 **AMUX v4 운영자 아이디어 분석 한 능력만** 로컬 Ubuntu CLI 예외로 승인했다. 운영자가 preview에서 실제 GitHub 발췌와 모델·전송 범위·digest를 확인한 경우에 한해 제한된 원문을 격리된 분석 CLI에 typed data로 전달할 수 있다. 자동 수집, 발췌 안 지시 실행, child CLI의 GitHub 도구·checkout·credential 접근은 허용하지 않는다. 이 두 정책 결정은 **라이브 호출 승인과 다르다**. 앱 DB 단일 writer, 제품 DB 자격증명 없는 Agent, 미완 S0, 일회용 확인, 비용·실패·kill switch, 단계별 운영 승인 요구를 유지한다.

- 신규 Admin 아이디어 원천의 `sourceSystem`은 `admin-idea-v4`, 분석 Agent의 `agentId`는 `amux-intake`, 이 원천의 자동 만료·분석 상태 기록용 닫힌 system actor는 `amux-v4-intake`다. 기존 `codex-conversation`, `local-agent-intake`, 엔지니어링 등록 원천의 식별자·승인 행·스위치를 재사용하지 않는다. 새 actor는 canonical system audit의 닫힌 목록에 등록·검증되기 전에는 시스템 쓰기를 열지 않는다.
- 아이디어 입력의 전송 확인, 노드·카드 등록과 승인, 수동 승격·예외 조작은 owner Admin과 최근 step-up으로만 허용한다. `ops:write`, Agent secret, CLI receipt, 모델 출력은 이 사람 권한을 대체하지 않는다. 등록·승인·수동 승격의 canonical human audit는 그 상태 변경과 같은 트랜잭션에 쓴다.
- 앞 문장의 **수동** 승격 권한은 v22의 조건부 `backlog→todo` **자동 편입을 취소하지 않는다**. 운영자가 이미 승인한 source·hierarchy·Task brief에 결속된 `ready` 카드만 v22 졸업·점수·용량·결정적 Guard·off switch·canonical system audit를 통과해 카드별 새 사람 승인 없이 자동 편입될 수 있다. `amux-v4-intake`는 그 편입 actor가 아니며, 자동 편입은 별도 v22 actor·영수증을 사용한다. 기존 v1~v3 카드는 명시적 opt-in·재검증 전까지 이 경로에 넣지 않는다.
- Gateway 도입 전 이 원천은 `platformProductKey`를 사용하지 않는다. 현재 허용 enum의 다른 값을 빌려 쓰거나 새 값을 암묵적으로 추가하지 않는다. Gateway 결합이 필요해지면 명시적 정책·스키마 선행 개정 뒤에만 도입한다.

이 승인으로 migration 적용, staging/live write, 라이브 아이디어·GitHub 원문 전송, 자동 편입 활성화, worker claim, PR 병합·배포는 열리지 않는다. 각 전환은 해당 S0·DB/권한/감사 검증과 별도 운영자 승인을 요구한다.

## v13 — 분석 호출 시간·일일 상한 [결정, 운영자 mposition 2026-10-04]

AMUX v4 아이디어 분석 Agent `amux-intake`의 CLI 호출 1회는 시작부터 강제 종료까지 **10분(600,000ms) hard deadline**이다. 제한 시각까지 종료·결과·사용량을 확인하지 못하면 성공이나 0원으로 추정하지 않고 `outcome_unknown`으로 멈춘다. 자동 재시도는 없다. 현재 실제 CLI runner와 격리 S0가 완성되지 않아 이 시간 제한은 아직 실제 호출에 적용된 것으로 보고하지 않으며, 강제 종료와 결과 불명 read-back을 증명하기 전에는 live 호출을 계속 차단한다.

Agent 전체 호출 접수는 **DB UTC 00:00~다음 날 00:00에 최대 12회**다. 같은 트랜잭션의 canonical claim audit에 DB UTC 날짜를 결속하고, audit-chain 잠금 아래 그 날짜의 기존 claim 12건을 확인하면 13번째를 호출 전에 보류한다. 확인 응답이 끊기거나 CLI가 시작되지 않았어도 이미 소비된 claim 슬롯을 자동 환급·재시도하지 않는다. UTC 날짜가 바뀐 뒤에도 원래 결과 불명 claim을 재전송하지 않고 새 운영자 확인·새 preview의 기존 경계를 따른다. 이 상한은 사용자 credit이나 `agent/amux-intake`의 월 US$50 예약 상한을 대체하지 않는다.

이 결정은 합성 코드·DB 검사 수치를 고정할 뿐, v12의 로컬 호스트 격리·CLI 계정 적격성·처리 계약·S0 및 별도 live 활성화 승인 요구를 면제하지 않는다. 분석 claim/result 쓰기 래치는 그대로 닫는다.

구현 검토에서 확인한 **미충족 활성화 전제**: 결과 불명 claim을 운영자가 read-back 후 닫는 경로가 없어 `in_flight` 예약이 Agent 전체의 다음 claim을 막을 수 있다. 보존 key 삭제는 현재 객체의 `HEAD 404`만으로 충분하지 않고 이전 버전·delete marker도 없어야 한다. 전용 key 저장소가 완전한 버전 목록 조회를 지원한다는 실측이 필요하다. 또한 단위별 외부 key 도입 전 전역 key로 봉인한 v4 본문 행이 0건인지 운영 DB에서 확인하거나 별도 보존·재봉인 절차를 마련해야 한다. 이 조건의 미확인 상태를 성공으로 간주하거나 live/retention 래치를 켜지 않는다. 이 문장은 새 승인이나 운영 활성화 기록이 아니다.

결과 불명 claim의 비용 종료 기준은 운영자 mposition이 2026-10-05에 결정했다. 운영자가 read-back과 로컬 실행 증거를 확인해 **CLI가 실행되지 않았음이 입증되면 0으로 예약을 해제**한다. 그 증거가 불충분하면 **예약 상한 전액을 내부 Agent 비용으로 처리**한다. 어느 경우도 사용자 크레딧을 청구하거나 같은 claim을 자동 재시도하지 않는다. 이 결정을 실행할 owner 전용 정산 경로와 감사 기록은 아직 구현되지 않았으므로, 현재 `in_flight` 예약과 로컬 중단 표식을 수동으로 해제하거나 live 래치를 열지 않는다.

## v14 — v4 코드 전용 활성화 PR [결정, 운영자 mposition 2026-10-08]

운영자는 v4 활성화 전용 PR 작성을 요청했다. 이 단계에서는 v4 Admin 입력·미리보기·단위 결정 등의 코드 래치만 준비하고, 분석 queue·결과 본문 read·claim/result write·라이브 CLI·보존 삭제·retention hold write의 코드 래치는 v13의 미충족 조건을 닫을 때까지 **false**로 둔다. 각 경로의 기존 전용 환경 스위치·owner 재인증·비용·감사·격리·read-back Guard는 유지한다. 단위별 `no_commit` 복구 쓰기에는 일반 unit write와 별도로 기본 꺼짐인 `TOMVERSE_AMUX_V4_UNIT_RECOVERY_WRITE`를 요구한다. 코드 래치를 켰다는 사실만으로 운영 환경에서 쓰기나 라이브 CLI가 허용되지 않는다. 배포 전에는 모든 v4 환경 스위치의 실제 값을 확인하고, 미검증 경로가 `enabled`라면 배포를 중단한다. 이 PR은 환경 값 변경, migration 적용, 운영 스위치 활성화, 실제 아이디어 분석, v22 자동 편입·worker claim, 병합 또는 배포를 승인하지 않는다.

## v15 — v4 live 순차 활성화 [결정, 운영자 mposition 2026-10-09]

운영자는 recovery halt 해제를 확인했으며, 나머지 선행 조건을 각 단계에서 검증해 성공으로 확인하면서 남은 v4 live 활성화를 다음 순서로 진행하도록 승인했다. **(1)** 분석 queue·owner 결과 본문 read·월 비용 예약·claim/result write·격리 CLI 실행·v4 lifecycle 보존 삭제·owner retention hold write의 v4 전용 코드 래치만 켜는 좁은 PR, **(2)** production 전용 합성 단위 key의 생성·전체 버전 삭제·부재 증명, **(3)** 승인된 분석 모델과 가격 version 등록, **(4)** 전용 Ubuntu timer/service 연결과 end-to-end 검증. 각 단계는 앞 단계가 성공으로 확인된 뒤에만 진행하며, 결과가 불명하면 멈추고 read-back한다. main 병합은 운영자만 한다.

현재 production의 v4 본문 13개 열 관측값은 encrypted 0건·legacy 0건이며, 앱 전용 content key 환경 값 다섯 개의 loader 검증과 S3 호환 저장소의 완전한 version/delete-marker 목록 지원이 확인됐다. owner 결과 불명 claim 정산 migration도 적용됐다. staging 합성 key 삭제 canary에 이어 production 합성 key 삭제 canary도 `VERIFIED`로 통과했고, 후자는 legacy 0건·`runtimeActivated=false`를 함께 확인했다. v4 runtime 환경 스위치는 계속 없고, 분석 모델·가격 행은 없으며, Ubuntu 분석·보존 timer는 비활성 상태다. 그러므로 코드 래치 PR만으로 production 호출·본문 read/write·비용 예약·삭제·hold 변경은 시작되지 않는다.

production canary는 기존 자료를 조회하지 않고 이번 실행이 만든 난수 namespace의 합성 단위 key 하나만 생성·목록·삭제·부재 확인해야 한다. 기존 staging 경로와 호환되어야 하고, production 실행마다 별도의 명시적 승인 환경 값이 필요하다. script는 승인 값을 저장하지 않으며, 운영 helper는 해당 호출의 child process 환경에만 값을 넣고 프로세스 종료와 함께 폐기한다. 출력과 오류에는 bucket·object key·암호문·자격증명·기존 자료 식별자를 남기지 않는다. cleanup은 그 합성 단위 key 밖으로 확장하지 않으며, 삭제 결과가 불명하면 성공으로 표시하거나 다른 key를 정리하지 않는다.

v1~v14의 owner 확인, 최근 재인증, same-origin/CSRF, 전용 secret, 단위별 외부 content key와 암호화, `agent/amux-intake` 월 **US$50**, DB UTC 하루 **12회**, 호출 hard deadline **600,000ms**, Agent 전체 실제 실행 **3회 연속 실패 정지**, 자동 재시도 금지, 결과 불명 즉시 정지·read-back·사람 인계, canonical 감사 및 사용자 credit 비접촉 조건은 모두 유지한다. 전용 환경 값 하나만 빠지거나 `enabled`가 아니면 해당 경로는 계속 닫힌다. 공유 retention route가 알고 있는 `AmuxV22TaskResult`·`AmuxV22TaskPatch` 본문의 90일 정리 경로는 v4 lifecycle 정리와 별도의 기본 꺼짐 코드·환경 gate 뒤에 두며 v15에서 켜지 않는다. 그 보존 구현을 폐기하는 것이 아니라 정확한 v22 retention 활성화 승인을 뒤에 받는다. 이 승인은 v22 자동 승격·worker claim·Task 실행·Git publication의 코드 또는 환경 래치를 켜지 않는다. 또한 코드 래치 변경만으로 운영 설정·호출·등록·서비스 시작·병합이 자동 승인된 것으로 간주하지 않으며, 해당 단계는 별도 운영 검증과 기존 승인 경계를 따른다. main 병합은 운영자 전용이다.
