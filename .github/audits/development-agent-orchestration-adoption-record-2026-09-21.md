# 개발 Agent 오케스트레이션 정책 채택 승인 기록 (초안)

## 0. 이 문서의 성격

- **초안입니다. 이 문서가 있다는 사실은 승인이 아닙니다.** 채택은 운영자가
  `docs/policy/development-agent-orchestration.md`에 `approvedBy`·`approvedAt`·버전을
  적고 그 변경을 직접 병합할 때 성립합니다.
- **Agent는 그 세 칸을 채우지 않습니다.** 이 문서도 채우지 않았습니다. 빈 칸이
  남은 정책 문서는 승인된 것이 아니며, 판정 절차는 §6에 있습니다.
- 작성: Claude, 2026-09-21. 기준 commit: `origin/develop` = `66247d35`.
- 근거 규칙: 공통 기반 `agent-common-foundation.md` §0 원칙 1·4·11·12, §2 거버넌스.
  (공통 기반은 비공개 저장소에 있으므로 이 공개 문서는 경로를 인용하지 않고
  조항 번호만 적습니다.)

## 1. 채택 대상

| 항목 | 값 |
|---|---|
| 정책 문서 | `docs/policy/development-agent-orchestration.md` |
| 제안 버전 | 1 |
| 적용 범위 | AMUX 개발 Agent 오케스트레이션의 **실행 제어**: task claim, 상태 전이, lease·attempt, 전달(delivery), settle, 감사 귀속, scheduler 우선순위 |
| 적용되지 않는 범위 | 각 Agent 팀(엔지니어링·QA·SRE·고객지원·과금·신뢰안전·제품리서치)의 **판단 계층**. intake, 위험 등급, push 금지 경로, 자격증명 도달, Publisher, 병합 관측, 소유자 대기열은 이 정책이 정하지 않으며 각 팀 설계와 정책이 따로 승인받습니다 |

## 2. 저장소 사실 (확인 2026-09-21)

- **병합 이력:** PR #1570 `amux/to-develop/c65b196b-r3 -> develop`, 병합 commit
  `1c5266aacfd53fbd8fa3e16b58b54bbbd7d6b131`, 2026-09-20T23:36:05Z, 병합자 `mposition`.
- **코드 표면:**
  - 내부 route 13개 — `app/api/internal/amux/**` (claim, queue, owned-queue,
    routing-snapshot, delivery/pull, delivery/ack, execution/start, heartbeat,
    settle, recover, workers/register, workers/heartbeat, health)
  - `lib/amux/**` 8개 모듈 (store, execution, delivery, routing, approvals, audit,
    workerRouterCore, workerRuntime)
  - Rust `crates/amux-core`, `apps/tomverse-orchestrator`
  - Prisma 모델 6개 — `AmuxWorkerRuntime`, `AmuxWorkItem`, `AmuxWorkDependency`,
    `AmuxExecutionAttempt`, `AmuxWorkDelivery`, `AmuxRouteDecision`
  - 통합 테스트 `tests/integration/amux-orchestration.db.test.ts`
  - 운영 문서 `docs/ops/amux/` (executor-protocol, staging-readiness,
    staging-checklist, 검증 기록 template)
- **내부 route 인증:** `lib/amux/guard.ts` — `TOMVERSE_AMUX_SYNC_SECRET` 32자 이상,
  Bearer, SHA-256 후 `timingSafeEqual`. 공통 기반 §6.3이 요구하는 형태와 같습니다.
- **실행 API 기본 꺼짐:** `TOMVERSE_AMUX_EXECUTION_API_ENABLED`가 unset이거나 `1`이
  아니면 실행 mutation이 열리지 않습니다(`docs/ops/amux/staging-readiness.md`).
- **시스템 actor:** `lib/adminAuditSystemActors.ts`에 `tomverse-amux-orchestrator`
  등록. 감사는 사람·시스템이 같은 해시 체인을 지납니다(공통 기반 §0-4).

## 3. 공통 기반과의 대조

| 조항 | 상태 | 근거 |
|---|---|---|
| §0-1 정책 문서 먼저 | **미충족 → 이 승인으로 충족 예정** | 정책 파일에 `approvedBy`·`approvedAt`·버전 칸이 아직 없습니다 |
| §0-4 감사 같은 체인 | 충족 | 시스템 actor 등록, 감사 event에 measured/verdict 포함 |
| §0-11 실행 위치·자격증명 | 충족(설계 수준) | worker는 제품 DB를 직접 고치지 않고 `/api/internal/amux/*`만 지납니다 |
| §0-12 상태·승인 기록 위치 | 충족(설계 수준) | 작업 상태의 authority는 본 앱, GitHub는 상태 저장소가 아닙니다 |
| §2 승인 모델(2인 승인 아님) | **PR #1583에서 정정 중** | 현재 본문은 "Tomverse approval policy를 통과"라고만 적어 2인 승인 경로로 읽힐 수 있습니다 |

## 4. 이 승인이 허용하는 것과 허용하지 않는 것

**허용하는 것**
- 이 정책이 적은 실행 제어 계약을 기준으로 AMUX 관련 구현·수정을 진행하는 것.
- staging에서 `docs/ops/amux/staging-checklist.md`에 따라 검증하는 것.

**허용하지 않는 것**
- production에서 실행 API를 켜는 것. 그것은 별도 결정이며 검증 기록이 선행합니다.
- Agent가 승인이 필요한 action(외부 변경·배포·발송)을 수행하는 것. 별도 승인 계약이
  아직 없습니다(§5-1).
- 각 Agent 팀의 판단 계층 구현. 팀별 설계 승인과 팀별 정책이 따로 필요합니다.
- 이 정책을 Agent가 스스로 고치는 것. `docs/policy/**`는 어떤 Agent의 쓰기 허용
  목록에도 들어가지 않습니다(공통 기반 §0-6).

## 5. 승인 전에 정리할 것

1. **PR #1583을 먼저 병합하십시오.** Approval 절을 "사람의 승인", "2인 승인 아님",
   "별도 계약이 생기기 전까지 AMUX의 어떤 경로도 승인을 기록하지 않고 승인이 필요한
   action을 수행하지 않는다"로 정정합니다. 정정 전 본문을 버전 1로 승인하면 이미
   틀린 것으로 확인된 문장을 승인하게 됩니다.
2. 나머지 열린 AMUX PR(#1582 저장소 이전 종료 기록, #1585 worker lane 빈 환경)은
   이 승인의 선행 조건이 아닙니다. 정책 본문을 바꾸지 않기 때문입니다.

## 6. 운영자가 할 일 (정확한 절차)

정책 승인은 **기록으로 판정 가능해야** 합니다. 아래 순서를 지키면 §7의 판정이
통과합니다.

1. PR #1583을 병합합니다.
2. `docs/policy/development-agent-orchestration.md` 맨 위(제목 다음 줄)에 §8의
   블록을 넣고 값을 채웁니다. `approvedBy`는 GitHub 계정, `approvedAt`은 3번에서
   병합하는 UTC 날짜입니다.
3. 그 변경을 **브랜치 이름에 `to-develop` 조각이 없는 브랜치**로 올리고 PR을 연 뒤
   **본인이 직접 병합**합니다. `to-develop`이 들어가면 자동 PR과 auto-merge가 붙어
   사람의 병합이라는 증거가 사라집니다.
4. 그 PR은 정책 파일 하나만 바꿉니다. 다른 변경을 함께 담지 않습니다.

## 7. 승인 여부 판정 (결정적)

읽기 전용 GitHub 조회와 git 이력만으로 판정합니다. 하나라도 어긋나면 "승인되지 않음"
입니다.

1. 정책 파일을 마지막으로 바꾼 commit을 찾습니다.
2. 그 commit을 develop에 넣은 PR이 정확히 하나입니다.
3. 그 PR의 브랜치 이름에 `to-develop` 경로 조각이 없습니다.
4. 병합자가 사람이고, 정책의 `approvedBy`와 같은 계정입니다.
5. `approvedAt`이 그 병합의 UTC 날짜와 같습니다.
6. 그 PR이 정책 파일 하나만 바꾸고, 모든 commit의 작성자가 `approvedBy`이며
   bot이 아닙니다.
7. 그 뒤에 정책 파일이 다시 바뀌면 1번부터 다시 판정합니다.

**한계:** 이 저장소의 Agent 세션은 운영자와 같은 git 신원으로 commit합니다. 그래서
규칙을 어기고 운영자 자격증명으로 만든 commit은 기록만으로 구별되지 않습니다. 이
한계는 공통 기반의 판정 절차에도 그대로 있습니다.

## 8. 정책 문서에 넣을 헤더 블록 (값은 운영자가 채웁니다)

```markdown
상태: **승인됨 — production 실행 미활성.** 작성 2026-09-20, 승인 <YYYY-MM-DD>.
approvedBy: <GitHub 계정> · approvedAt: <YYYY-MM-DD> · 정책 버전: 1

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | <YYYY-MM-DD> <계정> | 최초 승인. AMUX 실행 제어 계약(authority, scheduling, concurrency, execution boundary, approval, audit). 판단 계층과 production 활성화는 범위 밖 |
```

## 9. 남은 것

- 각 Agent 팀 정책(`docs/policy/<agent>.md`)은 이 정책과 별개이며 아직 없습니다.
- 승인이 필요한 action을 위한 **Agent 승인 별도 계약**이 없습니다. 생기기 전까지
  AMUX는 그 action을 수행하지 않습니다(#1583이 명시).
- production 활성화 판단에는 `docs/ops/amux/staging-checklist.md` 기록이 선행합니다.
