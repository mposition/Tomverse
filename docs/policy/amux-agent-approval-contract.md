# AMUX Agent 승인 계약

상태: **v1.3 정책 승인됨; 구현·staging 검증·활성화는 별도.**
작성·원안 승인 2026-09-21.
approvedBy: mposition · approvedAt: 2026-09-21 · 정책 버전: 1.3

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-09-21 mposition | 작업 검토 원안과 §7의 여섯 운영 결정 승인. 외부 행위 승인은 제외. |
| 1.1 | 2026-09-21 mposition (v1.3에 포함) | Claude 독립 검토의 escalation lifecycle·감사·노출·CAS 보강. |
| 1.2 | 2026-09-21 mposition (v1.3에 포함) | GitHub PR base SHA·head SHA·diff를 `review → done` 검토 원문으로 결속. |
| 1.3 | 2026-09-21 mposition | 모호한 결정 응답은 ID·대상 digest 조회 전 재시도 금지, 복구 가능한 block 후 명시적 후속 escalation, PR base SHA 추가 결속. |

이 문서는 `docs/policy/development-agent-orchestration.md` §Approval의 작업 검토
계약과 검토 보강안을 확정한다. **정책 승인만으로 실행 승인이 생기지 않는다.**
구현·staging 검증을 마칠 때까지 `/api/admin/amux/escalations`의 `resolve`는
`AMUX_AGENT_APPROVAL_UNAVAILABLE`을 반환해야 한다. `AdminActionApproval`이나
sole-approver 예외 목록을 대용하지 않는다.

## 1. 서로 다른 두 승인

| 종류 | 이 계약의 효과 | 허용하지 않는 해석 |
|---|---|---|
| 작업 검토 | 이미 끝난 시도의 `review`를 `done`으로 확정하거나 `blocked`를 유지·조건부 재큐한다. 승인 트랜잭션 안에서 새 실행을 시작하지 않는다. | 외부 변경·배포의 승인 또는 다음 claim의 hard gate 면제 |
| 외부 행위 | 별도 유형의 정확한 행위 제안과 일회성 승인 증거를 그 행위 경계에서 소비한다. | 작업 검토 버튼 하나로 모든 후속 행위를 포괄 승인 |

첫 단계의 구현 범위는 **작업 검토**다. 외부 행위별 제안 형식·검증 가능한 실행
경계가 없으면 두 번째 종류는 계속 불가하다. 작업 검토가 통과해도 Agent의 외부
시스템 쓰기·PR 병합·배포·이메일 발송 권한은 생기지 않는다. 개별 Agent 정책이
금지하거나 아직 승인하지 않은 작업은 이 계약으로 허용되지 않는다.

## 2. 사람·권한·표시

승인자는 관리자 한 명의 `ops:write`와 최근 재인증(step-up)을 갖는다. 요청 Agent나
시스템 actor는 승인자가 될 수 없고, 관리자 2인 승인을 요구하거나 그 승인 행을
차용하지 않는다. 관리자 세션·권한·step-up은 Admin 진입점에서 검사하고,
승인·상태 전이·감사는 승인된 `/api/internal/amux/*` 경계를 통과한다. 내부
경계는 서버가 결속한 사람 actor와 제안·권한 증거를 다시 검증하며, 브라우저가
내부 자격증명을 받거나 직접 호출하지 않는다. 세션 상실·권한 변경·검사 실패는
쓰기 전에 거절한다. 기존 Admin `acknowledge`의 상태 변경도 이 경계로 정리한
뒤 활성화한다. 알림 링크와 `acknowledge`는 승인이 아니다.

Admin Console은 결정 전에 task·escalation ID, 상태·revision, specialty, 마지막
시도 결과, 원래 차단 사유, 기한 파싱 상태, 재시도 잔여량, 적용될 전이와 위험 경고를
보여 준다. review 대상 내용이 사람이 읽을 수 없거나 출처가 불명확하면 승인
버튼을 제공하지 않는다. 비밀값·전체 prompt·사용자 데이터는 감사·알림·일반
routing 근거 응답에 넣지 않는다. 사람이 검토해야 하는 원문은 별도 인증된 검토
표면에서만 읽고, 화면이 실제로 보여 준 대상의 digest를 승인 요청에 결속한다.
원문은 이 승인 경로에 저장하지 않는다. 승인 원장은 ID·digest·결정만 보관하고
보유기간은 기존 Admin 감사 정책을 따른다. 승인 원장은 계정 통합 내보내기에서
제외하고, 관리자 본인의 열람 요청은 수동 `PrivacyRequest` 심사로 제공한다.
보호된 검토 원문 **조회 자체**도 actor·task/escalation ID·대상 digest만 감사하고,
본문은 감사하지 않는다. task 자유 텍스트와 PR의 base/head/diff 식별자는 화면에서
서로 다른 구획에 표시해 자유 텍스트가 출처 필드를 가장하지 못하게 한다.

`review → done`의 권위 있는 결과물은 **GitHub PR의 현재 base SHA·head SHA와 전체 diff**다.
task snapshot이 `reviewPrNumber`를 명시해야 하며, 서버는 고정된
`mposition/Tomverse` 저장소의 그 PR을 읽기 전용 자격증명으로 조회한다. PR은
실행 완료 뒤 만들어질 수 있으므로, `review`로 settle할 때 worker의 task owner·
claim을 해제하고 그 뒤의 task snapshot sync로 PR 번호를 붙일 수 있어야 한다.
이 메타데이터 동기화가 task revision을 올려도 마지막 terminal 성공 attempt가
해당 review의 최신 attempt이면 승인 가능하다. 단, 제안 이후의 revision 변경은
기존 제안을 무효화하고 다시 검토하게 한다.
열려 있고 미병합이며 head가 같은 저장소, base가 `develop`이어야 한다. 서버는
PR 번호·40자리 base SHA·40자리 head SHA·원시 diff 바이트의 SHA-256을 검토 화면과 제안에
결속한다. 관리자에게 보이는 diff는 크기·인코딩 상한과 표시를 뒤집거나 숨길 수
있는 제어문자 검사를 통과한 원문만 안전한
텍스트로 표시하며, DB·감사·로그에는 diff 본문을 남기지 않는다. PR이 없거나,
조회·검증이 실패하거나, base·head 또는 diff digest가 제안 이후 달라지면
`approve`는 거절한다. task 설명의 50,000자 입력 상한은 UTF-8 바이트 상한이
아니다. 보호 화면은 그 전체가 보이는 한도를 사용하며, 과거 초과 행을 잘라
표시한 경우 `approve`·`retry`를 금지하고 잘림을 명시한다. `block`은 안전한 중지
결정으로 남긴다. GitHub 조회와 DB 트랜잭션은 분리돼 있으므로 마지막 조회
직후부터 결정 commit까지 짧은 TOCTOU 창은 남는다. 승인 증거는 그때 읽은 **특정**
base/head/diff에 결속하며, 이후 움직인 PR의 최신 상태나 병합·배포를 승인하지
않는다. `block`·`retry`는 이 결과물 출처가 없어도 별도 상태 조건으로
허용할 수 있다. 검토 PR을 task에 잘못 결속하는 입력은 자동으로 증명할 수 없으므로,
작업 계획의 PR 번호 지정과 화면의 PR 식별자 확인을 운영 책임으로 남긴다.

검토 원문 조회도 `ops:write`와 최근 step-up이 필요하다. 기존 routing·escalation
일반 GET에서는 자유 텍스트 `reason`·description·prompt·결과물 원문을 반환하지
않고 enum·ID·길이 제한된 안전한 제목과 상태만 돌려준다. 기존 행도 이 규칙으로
가린다. worker가 쓴 사유는 신뢰하지 않는 데이터다. 새 worker 자유 텍스트 사유는
실행 제어 평면에 저장하거나 새 prompt에 재주입하지 않고 고정 코드로 치환한다.
과거 DB 사유를 인증된 Admin 검토 화면에서 읽어야 한다면 결정적으로 길이 제한·
제어문자 제거 후 escape해 표시하며 명령으로 해석하지 않는다. 외부 텍스트 원문을
상한 없는 제어 평면 컬럼이나 감사 metadata에 저장하지 않는다.
settle API의 기존 `reason` 입력은 하위 호환을 위해 받을 수 있지만 신규 시도
기록·감사·prompt에는 저장하지 않는다. 운영자는 그 값을 보존된 실패 진단으로
오인해서는 안 되며, 새 승인 판단은 고정 결과 코드와 PR 원문을 근거로 한다.

## 3. 결속·유효기간·감사

승인 의도는 서버가 만든 불변 제안으로 저장한다. 최소 결속 필드는
`escalationId`, `taskId`, task `revision`, 제안 결과(`approve`·`retry`·`block`),
검토 대상 SHA-256 digest(소문자 hex), approve의 PR 번호·base SHA·head SHA·diff SHA-256,
제안된 상태 전이, 생성 시각, 만료 시각이다. 제안값은 **24시간
유효**하다. 대상 필드·결과·revision 중 하나라도 바뀌면 기존 제안은
무효다. 요청이 전송되기 전에 만료되어도 거절한다.

제안 생성도 `ops:write`·최근 step-up을 요구하고 같은 트랜잭션에서 사람 actor와
대상 digest를 감사한다. digest는 화면이 보낸 문자열을 신뢰하지 않고 서버가 현재
검토 대상에서 다시 계산한다. 사람의 실행 요청에는 서버가 발급한 제안 ID와
클라이언트 idempotency key를 넣는다. 원장에는 key 원문이 아닌 SHA-256
digest(소문자 hex)를 저장한다. key는 **제안별**로 유일하며 DB unique가
강제한다. 같은 key·같은 digest의 재전송은 저장된 같은 결과만 돌려주고, 같은
key의 다른 내용은 충돌로 거절한다. 다른 key로 같은 제안을 두 번 소비할 수도
없다. 재전송 결과는 감사 원장과 함께 기존 Admin 감사 보유기간 동안 보관한다. 승인
제안은 고유한 결정 ID를 미리 발급한다. Admin 화면이 결정 호출 뒤 timeout·전송
오류·불명확한 응답을 받으면 **미확인 상태**로 표시하고, 제안의 결정 ID와 검토 대상
digest로 원장을 읽어 확정 여부를 확인한다. 미확인 상태에서는 동일 key를 포함한
어떤 결정 재전송이나 새 제안도 허용하지 않는다. 조회에서 아직 결정 행이 없다는
사실은 원래 요청이 나중에 도착하지 않는다는 증명이 아니므로 자동 재시도를 열지
않는다. 화면은 이 상태에서 원문과 결정 식별자를 유지하고, 실패를 "기록 안 됨"으로
단언하지 않는다. 상태 조회는 읽기 전용으로, 승인 기능 스위치가 다시 꺼진 뒤에도
`ops:write`와 최근 step-up을 갖춘 관리자에게 제공한다.

기록은 별도 AMUX 계약·테이블에 두고, `AdminActionApproval`을 참조하거나
`lib/adminSoleApproverCore.ts`의 예외를 추가하지 않는다.

단일 DB 트랜잭션에서 (1) `retry`라면 resource policy를 먼저 잠그고,
task → escalation → 제안 순으로 잠그며, (2) 현재
revision·상태·마지막 시도·만료·digest·권한을 재검사하고, (3) 조건부 전이에서
task revision을 한 번 올리고 escalation을 `resolved`로 닫으며, (4) 제안을
소비 처리하고, (5) 별도 원장에 기계가 읽을 수 있는 `approve`·`retry`·`block`
outcome을 저장하고, (6) 기존 `writeAdminAuditLog()`의 해시 체인에 사람 actor·
결정·대상 revision·제안 digest·결과를 기록한다. attempt·delivery 행과 incident
상태는 승인 트랜잭션에서 별도 잠금을 잡지 않고 task revision·유효 receipt·다음
claim의 admission으로 fence한다. 감사 체인 잠금은 마지막에 잡는다. 실패한
트랜잭션은 승인 기록도 남기지 않는다. 거절·revision 충돌·정책 hard gate 실패는
구조화된 거절 코드와 감사 가능한 measured/verdict를 남기되, 성공 승인으로
기록하지 않는다. 과거 승인·거절의 원장은 덮어쓰거나 삭제하지 않는다.

성공 결정은 escalation의 `resolvedById`·`resolvedAt`·제한된 `resolution`을
같은 트랜잭션에서 채우고, 결과 enum은 별도 컬럼/원장에 보존한다. `retry` 후 다시
실패하면 이전 escalation은 이미 종결됐으므로 새 escalation을 열 수 있다.
`blocked`의 `block`은 **현재 미종결 escalation**에만 적용하고, 새 사유는 그
escalation의 제한된 `resolution`과 감사 체인에 남긴다. 불변 결정 원장에는
사유 원문 대신 결정 ID·대상 digest·outcome만 남긴다. 이미 `resolved`인 escalation을 다시 쓰지
않는다. `block` 결정은 현재 escalation을 닫되, 시도 상한이 남아 복구 가능한 task에는
**같은 트랜잭션에서 후속 미종결 escalation을 새로 연다.** 후속 건은 별도 ID·열린
revision·안전한 reason code를 갖고, 이전 결정과 사유는 원래 건에 남는다. 이 후속
건을 통해 이미 blocked인 task에 사유를 더하거나 유계 `retry`를 제안할 수 있다.
후속 보호 검토는 직전 사람의 차단 사유를 길이·제어문자 제한 후 별도 표시하며,
그 표시값도 제안 대상 digest에 결속한다. 일반 routing GET에는 이 사유를 넣지 않는다.
상한 5회를 소진한 task에는 후속 재시도 건을 만들지 않고 terminal blocked로 남기며,
계속 필요하면 새 task를 발행한다. planning-review의 후속 건은 새 열린 revision 이후
기한 교정·동기화를 다시 증명해야 한다. escalation 생성 자체도 사람에게 보여 주는 raw reason 없이 ID·specialty·
reason digest를 시스템 감사에 남긴다.

## 4. 작업 검토 상태 전이

| 현재 상태·조건 | 사람의 결정 | 제안하는 전이 |
|---|---|---|
| `review`, 마지막 시도 terminal `succeeded`이고 `toStatus=review`, 해당 revision 일치 | `approve` | `done`; 새 Agent 실행이나 외부 행위는 없음 |
| `review`, 같은 조건 | `block` | `blocked`; 사유·actor·시각 기록 |
| `blocked`, 마지막 시도 terminal, 재시도 상한 미소진, 원인 교정됨 | `retry` | owner·claim fence를 정리한 `todo`; 다음 claim은 모든 admission을 다시 검사 |
| `blocked`, `planning-review`가 실행 전 invalid/ambiguous due로 열렸고 원천 기한이 교정·동기화됨 | `retry` | 시도 기록을 만들지 않고 `todo`; 다음 claim은 모든 admission을 다시 검사 |
| 이미 `blocked` | `block` | 상태 유지, 새 결정의 사유를 append-only 기록 |

그 밖의 조합은 거절한다. `open` 또는 `acknowledged` escalation에만 제안을 만들고,
`acknowledge`는 승인의 선행 조건이 아니다. 특히 `review`의 `retry`, `blocked`의 `approve`, 이미
종결된 escalation의 재처리, 실행 중인 attempt·유효 delivery receipt가 남은
작업은 자동 전이하지 않는다. 마지막 시도는 최대 `taskRevision`, 그다음
`startedAt`·ID 순으로 판정하며, terminal이면 `endedAt`과 outcome·toStatus가
모두 있어야 한다. `retry`는 task의 `owner`·`claimedAt`만 비우고 revision을
올린다. 기존 attempt ID, worker instance/generation, delivery receipt는
수정하지 않으며, 증가한 revision이 과거 fence를 무효화한다. `retry`는 기존 시도 기록을 지우거나
`AMUX_MAX_EXECUTION_ATTEMPTS`를 초기화하지 않는다. 상한을 소진한 작업은 새
승인만으로 다시 실행할 수 없다. `blocked`로 종결하고 계속 필요하면 새 task를
발행한다. 기존 task를 다시 `todo`로 바꾸거나 기록·상한을 리셋하지 않는다.

`retry`는 시도 5회 상한을 절대 초기화하지 않으며, 직전 attempt의 terminal 상태·
delivery fence와 현재 project/team 비용 상한을 **재큐 결정 직전** 다시 확인한다.
재큐는 비용을 예약하거나 집행할 권한이 아니므로, WIP·비용·quota·incident
admission은 다음 claim에서 다시 확인한다. 과거 attempt와 receipt를 수정하지 않고 증가한 task revision으로 이전
fence를 무효화한다.

`planning-review`의 invalid/ambiguous due는 **원천 task의 canonical 기한이
수정되고 새 revision으로 동기화되기 전까지** 재큐·승인할 수 없다. 이 경우
마지막 시도가 없을 수 있으므로 일반 실행 실패와 분리하지만, 과거 시도가 있다면
그 시도도 terminal이어야 하고 재시도 상한을 넘지 않아야 한다. 새 escalation은
열릴 때의 task revision을 보존하며, 현재 revision이 그보다 높고 파싱 상태가
`valid`일 때만 기한 교정을 인정한다. 기존 escalation에 열릴 때의 revision이
없다면 추정하지 않고 재큐를 거절한다. 비용·WIP·
quota·incident 동결·specialty 부족 같은 hard gate도 승인으로 면제되지 않는다.
`retry`가 `todo`로 옮겨져도 다음 claim이 서버 권위의 현재 사실로 다시 거절할 수
있다. `blocked → todo`의 유일한 경로는 이 승인 전이이며, task snapshot sync는
반대 방향의 기한 차단만 할 수 있다. 사람이 누른 승인과 실제 재실행·완료는
별개 상태로 표시한다.

## 5. 외부 행위의 미래 경계

이 계약의 작업 검토는 외부 행위 승인의 기반이 아니다. 외부 행위 지원을 추가할
때에는 행위 종류·대상 시스템·대상 식별자·정확한 payload 또는 변경 diff의
digest·허용 범위·만료·실행자·결과 조회/중복 방지 방법을 유형별로 승인해야 한다.
승인 전후의 내용이 다르거나 결과가 불명확하면 실행하지 않고 사람에게 올린다.
쓰기 가능 자격증명과 그 Agent의 개별 정책이 허용한 경계 밖으로 권한을 늘리지
않는다. 이 절만으로 외부 행위 기능을 켜지 않는다.

## 6. 활성화와 검증

새 승인 경로는 기본 꺼짐이다. 승인된 정책 버전, DB migration, 권한·step-up
route, Admin 검토 화면, audit integrity, 일회성 CAS와 회귀 테스트가 배포된 뒤
staging에서 사람이 판정·서명한 증거로만 켠다. 필수 반례는 권한 없는 actor,
요청 Agent의 자체 승인, 재인증 만료, 다른 task/revision/digest, 두 관리자 동시
클릭, 같은 key 재전송·다른 내용, 만료 직전/후, 트랜잭션 rollback, incident
동결, 유효 attempt/receipt, 재시도 상한, 미수정 기한, 비용/WIP/quota 게이트다.
GitHub PR이 없거나 닫힘·병합·다른 저장소·다른 base·변경된 base SHA/head/diff·초과 크기·
잘못된 인코딩인 경우에도 `approve`가 닫히는지 확인한다.
승인·거절의 감사 해시 체인을 검증하고, 검토 화면·로그·증거 파일이 prompt나
비밀값을 노출하지 않는지도 확인한다. 운영값·staging 관측을 합성하지 않는다.
활성화 스위치는 `TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED=true`만 켜짐이며
미설정·읽기 실패·다른 값은 꺼짐이다. 기존 차용 금지 회귀 테스트는 삭제하지 않고
새 계약 검증으로 강화한다. `AdminActionApproval`·sole-approver 재사용과 외부 행위
승인은 계속 거절해야 한다. step-up 거절 UI에는 재인증 링크를 제공하고,
rate limit·본문 상한도 반례로 검증한다.

## 7. 승인된 운영 결정

1. 작업 검토 승인자는 `ops:write`와 최근 step-up을 갖춘 관리자 **한 명**이다.
2. 제안은 생성부터 **24시간** 유효하다. 만료된 화면의 결정은 거절하고 새
   제안을 받아야 한다.
3. 이미 `blocked`인 작업에 `block`으로 새 사유를 append-only로 추가할 수 있다.
4. 원문은 인증된 Admin 검토 화면에서만 보여 주고 승인 경로에는 저장하지 않는다.
   승인 원장은 ID·digest·결정만 담으며 보유기간은 기존 Admin 감사 정책을 따른다.
5. 외부 행위 승인은 **이번 구현 범위에서 전부 제외**한다. 도입하려면 유형별
   별도 계약·승인을 받는다.
6. 시도 상한 5회를 소진한 `blocked` 작업은 그 task에서 종결한다. 계속할 작업은
   새 task를 발행하고, 기존 task의 시도 기록·상한·revision을 리셋하지 않는다.
7. 승인 원장은 계정 통합 내보내기에서 제외한다. 관리자 본인의 열람 요청은
   수동 `PrivacyRequest` 심사로 처리한다(2026-09-21 승인).
