# AMUX intake

상태: **승인됨.** 운영자 `mposition`이 2026-09-24에 v1 설계를 승인했다. 같은 운영자가 2026-09-28에 v2로 에이전트 등록 원천을 승인했다. 그 승인은 새 원천의 코드 래치를 끈 채로 두고 환경 변수를 설정하지 않는다.
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 1
approvedBy: mposition · approvedAt: 2026-09-28 · 정책 버전: 2

이 승인은 설계 권고 16개를 승인한다. 법적 보존 기간은 정하지 않는다. USD 상한 숫자는 정하지 않는다. production backlog 등록은 2026-09-24에 mposition이 단계 8로 승인했다. 코드 래치 `AMUX_INTAKE_APPLY_CODE_LATCH`는 그 승인으로 켜진다. 환경 값이 `TOMVERSE_AMUX_INTAKE_APPLY=enabled`가 아니면 writer는 열리지 않는다. 이 환경 값과 코드 래치는 사람이 확인하는 `codex-conversation` 원천의 writer에만 걸린다. 에이전트 등록 원천의 writer는 이 값으로 열리지 않는다.

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-09-24 mposition | 수동 Codex draft를 owner Admin이 확인하는 intake. 앱은 LLM을 호출하지 않고, Codex는 앱에 직접 쓰지 않는다. |
| 1 | 2026-09-24 mposition | 단계 8 production backlog write를 승인한다. 코드 래치를 켠다. 법적 보존 기간과 USD 상한은 정하지 않는다. |
| 2 | 2026-09-28 mposition | 에이전트 등록 원천. 사람이 확인하는 원천의 규칙을 그 원천으로 한정하는 범위 문장을 더하고, 엔지니어링 Agent의 등록 원천 절을 추가한다. 새 원천의 코드 래치는 끈 채로 둔다. 승격과 사람 경로 규칙은 바꾸지 않는다. |

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

다음은 단계 8과 별개로 닫혀 있다.

- 법적 보존 기간
- S0 실측 뒤의 USD 상한
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
