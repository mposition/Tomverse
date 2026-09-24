# AMUX intake

상태: **승인됨.** 운영자 `mposition`이 2026-09-24에 v1 설계를 승인했다.
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 1

이 승인은 설계 권고 16개를 승인한다. 법적 보존 기간은 정하지 않는다. USD 상한 숫자는 정하지 않는다. production backlog 등록은 2026-09-24에 mposition이 단계 8로 승인했다. 코드 래치 `AMUX_INTAKE_APPLY_CODE_LATCH`는 그 승인으로 켜진다. 환경 값이 `TOMVERSE_AMUX_INTAKE_APPLY=enabled`가 아니면 writer는 열리지 않는다.

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-09-24 mposition | 수동 Codex draft를 owner Admin이 확인하는 intake. 앱은 LLM을 호출하지 않고, Codex는 앱에 직접 쓰지 않는다. |
| 1 | 2026-09-24 mposition | 단계 8 production backlog write를 승인한다. 코드 래치를 켠다. 법적 보존 기간과 USD 상한은 정하지 않는다. |

실행 제어는 `docs/policy/development-agent-orchestration.md`가 정한다. 두 문서가 충돌하면 적용 범위가 좁은 쪽이 이긴다.

## 조합

v1이 조합하는 것은 셋뿐이다.

- 운영자가 명시적으로 선택한 등록 요청
- work id, version, digest와 짧은 제안. 비공개 상세 원문은 받지 않는다
- AMUX Admin preview와, 래치가 켜진 뒤의 deterministic writer

Chat, Message, Memory, 결제, 사용자 credit 테이블은 읽거나 쓰지 않는다. 앱 route가 모놀리스 DB 자격증명을 가진다는 사실을 물리적 격리라고 말하지 않는다. 외부 생성기는 그 자격증명을 받지 않고, 앱 안 writer는 코드, 테스트, DB 불변식으로 제한한다.

## 식별자와 권한

- `agentId`는 `amux-intake`다
- `sourceSystem`은 `codex-conversation`이다
- `sourceKey`는 Codex task id의 HMAC이다. 원문 id는 저장하지 않는다
- system actor `tomverse-amux-orchestrator`는 자동 만료와 reconciliation에만 쓴다
- 등록, 승인, 승격의 행위자는 사람이다

`platformProductKey`는 v1에서 쓰지 않는다. 현재 닫힌 값에 없는 이름을 다른 값으로 대체하지 않는다. 앱이 LLM을 호출하게 되면 그 전에 별도 값을 계약에 추가한다.

v1의 화면은 owner 전용이다. 위임은 하지 않는다. `ops:write`를 intake 승인 권한으로 확대하지 않는다.

## 하지 않는 것

v1에서 하지 않는 것은 다음이다.

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

backlog 등록은 실행이 아니지만 canonical write다. 그 write는 owner의 최근 step-up과 이 문서의 코드 래치, 환경 래치가 함께 있어야 한다. 환경 값은 `TOMVERSE_AMUX_INTAKE_APPLY=enabled`뿐이다.

## Guard

Guard의 결과는 `reject`, `approval_required`, `allow` 셋이다.

- `reject`: 명시적 등록이 아님, 완료 단위가 하나가 아님, 필수 metadata 누락, secret이나 경로, schema나 digest 불일치, 같은 identity의 다른 digest
- `approval_required`: 제안은 유효하고, 확인 digest가 아직 없음
- `allow`: 확인 digest와 현재 payload의 draft digest가 같고, backlog 한 건만 가능한 상태

서버가 schema, 완료 단위 수, source identity, digest, 중복을 다시 계산한다. 제안의 title, scope, completion과 work item id, version은 카탈로그 내용 스캐너를 통과해야 한다. work item digest는 SHA-256 64자 hex만 허용하고 자유 문장으로 스캔하지 않는다. 요청 JSON 전체를 한 문자열로 스캔하지 않는다. 원문 task id는 저장하지 않으므로 스캐너 대상이 아니다. 길이, 제어 문자, 경로 구분자를 거절한다. 제안 안에 Codex task id가 다시 나타나면 거절한다.

## 저장

raw 대화 원문은 앱 DB에 두지 않는다. 승인 전 draft의 기술적 상한은 24시간이다. 이것은 법적 보존 기간이 아니다. 결정 뒤에는 본문을 지우고 digest와 결정 metadata만 남긴다. 카드에는 opaque reference, version, digest만 남긴다. 승인 창은 15분이다.

같은 `(sourceSystem, sourceKey)`에 다른 digest가 오면 덮어쓰지 않고 conflict다.

카드는 `backlog`, kind `unknown`, owner 없음으로만 만든다. 우선순위는 확인된 제안의 `p0`에서 `p3`다. attempt, delivery, route decision, claim을 만들지 않는다.

감사 metadata에는 approval id, digest, count, policy version, scanner version만 넣는다. 원문, 제목, secret finding은 넣지 않는다.

Preview는 DB에 쓰지 않는다. 응답을 잃으면 즉시 재시도하지 않고 read-back한다. 일부만 있으면 `outcome_unknown`이고 자동 재시도를 멈춘다. card 생성, approval consume, audit는 한 트랜잭션이다.

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

미리보기는 DB에 쓰지 않는다. 공개 route는 코드 래치가 켜져 있고 환경 값이 `enabled`일 때만 트랜잭션을 연다. 그 한 트랜잭션이 backlog 카드, 본문이 비어 있는 draft, consumed approval, human audit를 함께 쓴다. 그 트랜잭션은 todo, owner, claim, attempt, delivery, route decision, provider 비용, 사용자 credit를 늘리지 않는다. 같은 source key의 동시 등록이 유니크 제약에 걸리면 conflict다. 응답이 끊기면 `outcome_unknown`이고 자동 재시도를 멈춘다.

저장하는 `sourceKey`는 HMAC의 대문자 hex다. 기존 카드의 source key 검사에 맞추기 위한 형태이고, 원문 task id는 저장하지 않는다.
