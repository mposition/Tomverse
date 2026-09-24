# AMUX Agent 승인 계약 독립 검토

검토일: 2026-09-21 · 검토자: Claude (읽기 전용, 파일·Git 변경 없음)

대상은 `docs/policy/amux-agent-approval-contract.md`의 승인 전 초안과
`docs/policy/development-agent-orchestration.md` v1, 당시 develop 작업트리의
escalation·execution·Prisma 구현이다. **이 기록은 수정 후 구현이나 staging의
통과 판정이 아니다.**

| 발견 | 판정 | 계약·구현 후속 |
|---|---|---|
| 미종결 escalation을 닫지 않으면 재실패 시 새 escalation이 열리지 않음 | 차단 | 성공 결정과 같은 트랜잭션에서 `resolved`로 닫고, 사유 추가는 append-only 결정 원장에 기록 |
| `approve`·`retry`·`block` 결과를 기계가 읽을 컬럼이 없음 | 차단 | escalation `resolutionOutcome`과 별도 AMUX 제안·결정 원장, DB 제약 추가 |
| worker 자유 텍스트 `reason`의 무상한 저장·prompt 재주입 | 차단 | 입력을 제어 평면 고정 코드로 치환하고 과거 원문도 일반 조회·새 prompt에서 배제 |
| 일반 Admin GET이 권한·step-up 없이 raw 사유를 노출 | 차단 | 일반 조회는 안전 코드만, 검토 원문은 `ops:write`·최근 step-up 전용 |
| 시도 상한 5회 소진 후 출구가 미정 | 차단 | mposition 승인: 기존 task는 `blocked` 종결, 계속할 작업은 새 task 발행 |

그 밖에 Claude는 revision CAS 증가, task/attempt/delivery fence, 제안 생성
권한과 digest 재계산, idempotency 범위, Admin 재인증 링크, 내부 API 경계,
마지막 시도 정렬, lock 순서, 기본 꺼짐 flag와 회귀 테스트를 요구했다. 계약 1.1
제안에 각 조건을 명시하고 코드·DB 테스트에서 따로 검증한다. 검토 당시 실행 기록에는
사람이 검토할 불변 결과물 출처가 없었다. 이후 mposition은 GitHub PR head SHA와
diff를 선택했다. 계약 1.2 제안과 구현은 이를 결속하되, 재검토·staging 서명 전에는
`review → done`의 `approve`를 활성화하지 않는다.

독립 검토 원문은 이 문서와 별도로 작업 세션에 보존돼 있다. 이 표는 발견 사항과
후속을 요약한 것이며, 검토자가 수정본을 재검토했다는 뜻이 아니다.

## 2차 코드 독립 검토 (2026-09-21)

Claude는 수정 중인 `codex/amux-advanced-planning` 워크트리를 읽기 전용으로
검토했다. 우선순위 ③ timeout 불확실성·결정 ID/digest 조회, ② block 후속 경로·
5회 상한·기한·비용·attempt/delivery fence, ① 보호 테이블 writer 검사, PR
base/head/diff 결속과 병합·배포 권한 부재는 코드상 충족으로 판정했다. 이는
PostgreSQL 실행이나 staging 서명 결과가 아니다.

새 차단 지적은 실행 후 `review`에 남은 worker owner가 PR 번호 동기화를
막는다는 것이다. 이에 settle이 `review`의 owner/claim을 해제하고, 이후
메타데이터 sync로 revision이 올라가도 최신 terminal 성공 attempt의 승인
자격이 유지되도록 앱과 DB trigger를 함께 수정했다. 또 50,000자 입력을
50,000바이트에서 잘라 보이던 오류를 200,000바이트 표시 한도와 초과 행의
`approve`·`retry` 거절로 수정했다. 변경 후 DB 테스트는 CI의 전용 PostgreSQL에서
별도 확인해야 한다.

그 밖의 지적 중 worker 자유 텍스트 `reason` 폐기는 위 정책의 prompt-injection
경계로 명시했고, 운영 설정·staging 항목과 정식 정책 파일을 함께 추가했다.
미해결 증거는 실제 DB 통합·브라우저 동결 UX·staging 서명이다. 이 문서는
그 관측을 만들어 낸 것으로 취급하지 않는다.
