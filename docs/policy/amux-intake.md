# AMUX intake

상태: **v1~v4 설계 승인됨.** 운영자 `mposition`이 2026-09-24에 v1, 2026-09-28에 v2, 2026-09-29에 v3를 승인하고, 2026-09-30에 v3 등록 래치 활성화와 v4 새 경로의 설계를 승인했다. v4 구현·라이브 모델 호출·환경 값은 이 승인으로 열리지 않는다.
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 1
approvedBy: mposition · approvedAt: 2026-09-28 · 정책 버전: 2
approvedBy: mposition · approvedAt: 2026-09-29 · 정책 버전: 3
approvedBy: mposition · approvedAt: 2026-09-30 · 정책 버전: 4

v1~v3의 기록에 있는 `USD 상한 미정`은 그 이전 원천의 사실이다. **v4 분석 Agent의 API 월 USD 50은 2026-09-30 운영자가 이 버전에서 새로 승인한 값**이며, 구독형 CLI의 실제 청구액이라고 주장하지 않는다. 법적 보존 기간은 여전히 미정이다.

v1 승인은 설계 권고 16개를 승인했고 그때 법적 보존 기간과 USD 상한 숫자는 정하지 않았다. 그 원천의 production backlog 등록은 2026-09-24에 mposition이 단계 8로 승인했다. 코드 래치 `AMUX_INTAKE_APPLY_CODE_LATCH`는 그 승인으로 켜진다. 환경 값이 `TOMVERSE_AMUX_INTAKE_APPLY=enabled`가 아니면 writer는 열리지 않는다. 이 환경 값과 코드 래치는 사람이 확인하는 `codex-conversation` 원천의 writer에만 걸린다. 에이전트 등록 원천의 writer는 이 값으로 열리지 않는다. v4 Agent의 월 USD 50 결정은 아래 v4 절에만 적용한다.

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-09-24 mposition | 수동 Codex draft를 owner Admin이 확인하는 intake. 앱은 LLM을 호출하지 않고, Codex는 앱에 직접 쓰지 않는다. |
| 1 | 2026-09-24 mposition | 단계 8 production backlog write를 승인한다. 코드 래치를 켠다. 법적 보존 기간과 USD 상한은 정하지 않는다. |
| 2 | 2026-09-28 mposition | 에이전트 등록 원천. 사람이 확인하는 원천의 규칙을 그 원천으로 한정하는 범위 문장을 더하고, 엔지니어링 Agent의 등록 원천 절을 추가한다. 새 원천의 코드 래치는 끈 채로 둔다. 승격과 사람 경로 규칙은 바꾸지 않는다. |
| 3 | 2026-09-29 mposition | 로컬 분석 원천. 운영자 PC의 Frontier 분석 package를 Admin에서 카드마다 확인한다. 코드 래치는 끈 채로 둔다. 환경 값은 설정하지 않는다. |
| 3 | 2026-09-30 mposition | 로컬 분석 원천의 production 등록을 연다. 코드 래치 `LOCAL_INTAKE_APPLY_CODE_LATCH`를 켠다. writer는 `TOMVERSE_AMUX_INTAKE_LOCAL_APPLY=enabled`일 때만 열린다. 법적 보존 기간, DPA, 라이브 모델 호출은 이 승인이 정하지 않는다. |
| 4 | 2026-09-30 mposition | Admin 아이디어 입력부터 계층·카드 승인까지의 새 분석 경로, 로컬 Ubuntu CLI Agent, 카드 수에 따른 거절 폐기, 포트폴리오 평가와 결과 환류의 계약을 승인한다. 분석 Agent의 API 월 USD 50은 이 버전에서 승인한다. 구현·migration·모델 호출·운영 스위치 활성화는 이 승인에 포함하지 않는다. |

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
