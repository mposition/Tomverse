# Assistant profile 응답의 교차 대화 오염 — production 노출 감사 (2026-08-16)

`handleAssistantProfileChange`의 PATCH 응답이 다른 대화의 `selectedModels`를
덮어쓴 결함(#632, 수정 #633)에 대해, **production에서 실제로 노출된 기간과
영향 식별 가능 여부**를 판정합니다.

**이 감사는 아직 종결되지 않았습니다.** 저장소·배포 이력으로 확정 가능한
항목은 모두 채웠고, production DB를 읽어야 하는 두 항목(§4 플래그 이력,
§5 감사 로그 완전성)은 **미확인**입니다. 그 두 항목이 채워지기 전까지
결론은 "노출 없음"이 아니라 **판정 불가**입니다.

| | |
|---|---|
| 감사 시각 | 2026-08-16 |
| 대상 결함 | #632 (High/P1, 데이터 무결성) |
| 수정 | #633 |
| 후속 제품 결정 | #643 (§14 — 이 감사의 대상 아님) |
| 상위 정책 | `docs/policy/external-conversation-import-and-memory.md` §14 |
| 관련 | `docs/policy/chat-concurrency-and-identity.md` §5 |

## 1. 노출 window는 교집합이다

플래그가 켜져 있던 기간만으로는 노출 기간이 아닙니다. 세 조건이 동시에
성립한 구간만 노출입니다.

```
노출 window =
      취약 코드가 production에 배포돼 있던 기간          (§2, §3 — 확정)
    ∩ feature.assistantProfilesEnabled 가 ON 인 기간      (§4 — 미확인)
    ∩ assistant profile 기능을 실제로 쓸 수 있던 기간      (§4 — 미확인)
```

세 번째 항이 두 번째와 별개인 이유: 플래그가 켜져 있어도 발행된 profile이
하나도 없으면 `GET /api/assistant-profiles`가 빈 목록을 돌려주고, 그러면
`assistantProfileOptions`가 비어 컨트롤이 렌더되지 않습니다. 이 결함은
**사용자가 profile을 고르는 행위**에서만 시작되므로, 고를 것이 없으면 노출도
없습니다.

## 2. 취약 코드의 생애 (확정)

취약한 문장은 profile PATCH 응답을 무조건 적용하던
`if (models.length > 0) setSelectedModels(models);` 입니다.

| | 커밋 | 시각 (UTC) |
|---|---|---|
| 도입 | `ef0b353` "Let a conversation choose the assistant it runs under (C4b)" | 2026-08-14T10:09:39Z |
| 제거 | `407f0b6` (#633) | 2026-08-16T03:59:42Z |

확인:

```
git log -S 'if (models.length > 0) setSelectedModels(models);' \
  -- 'app/(site)/(application)/chat/ChatPageClient.tsx'
```

## 3. production 배포 구간 (확정)

Railway production 환경(service `Tomverse`)의 배포 이력에서, 각 배포 커밋이
`ef0b353`(취약 코드)과 `0e72b5b`(#633 수정)을 포함하는지 조상 관계로
판정했습니다.

| 배포 커밋 | 취약 코드 | 수정 | 비고 |
|---|---|---|---|
| `4db1c61` 이전 전부 | 없음 | 없음 | 취약 코드 도입 전 |
| `851598e` | **포함** | 없음 | **취약 코드의 첫 production 배포** |
| `de441b9` … `50f1ae0` | 포함 | 없음 | 20건 연속 |
| `0e72b5b` (#633) | 포함 | **포함** | 가드 적용 |
| `e7d48c1` (#640) | 포함 | 포함 | 현재 production |

**취약 코드가 production에서 살아 있던 구간**

| | 시각 (UTC) | 근거 |
|---|---|---|
| 시작 | **2026-08-15T01:17:06Z** | 직전 배포 `4db1c61`이 이 시각에 `REMOVED` → 후속 `851598e`가 이때 인계 |
| 종료 | **2026-08-16T05:48:36Z** | `0e72b5b` 배포의 `deployedAt`. `GET /api/build-info`가 같은 값을 반환해 교차 확인 |
| 길이 | 약 **28시간 31분** | |

시작 시각은 배포 인계 시점에서 **추정**한 값입니다(Railway가 `REMOVED` 행에
성공 시각을 남기지 않음). 보수적 경계는 `851598e` 배포 생성
2026-08-15T01:10:21Z ~ 자신이 제거된 2026-08-15T01:40:41Z 사이이며, 어느
경계를 택해도 §4 결론은 달라지지 않습니다.

종료 시각은 추정이 아닙니다.

```
$ curl -sS https://tomverse.app/api/build-info
{"environment":"production","commitSha":"0e72b5b31dba1688d2728188f89e62bdf9e621f2",
 "builtAt":"2026-08-16T05:46:51.080Z","deployedAt":"2026-08-16T05:48:36.994Z",
 "deploymentId":"ed3265df-1b73-4ed4-87c0-181e92c33c98","deploymentStatus":"success"}
```

## 4. 플래그 이력과 현재값 — **미확인**

`feature.assistantProfilesEnabled`는 fail-closed이며 기본 OFF입니다
(`lib/assistantProfileAccess.ts`). 행이 없으면 OFF이고, 이 플래그를 seed하는
마이그레이션은 없습니다.

아래를 production DB에서 실행해 채워야 합니다.

```sql
-- 4.1 현재값과 마지막 쓰기 시각. 행이 없으면 어떤 경로로도 켜진 적 없음.
SELECT key, value, "createdAt", "updatedAt"
FROM "AppSetting"
WHERE key = 'feature.assistantProfilesEnabled';

-- 4.2 ON/OFF 타임라인. 관리자 콘솔은 설정 body 전체를 감사에 남기므로
--     매 변경의 제출값이 시각·행위자와 함께 남는다.
SELECT "createdAt", "actorEmail", action,
       metadata->>'assistantProfilesEnabled' AS profiles_enabled
FROM "AdminAuditLog"
WHERE action IN ('app_settings.update_started',
                 'app_settings.guest_default_model.updated')
ORDER BY "createdAt";

-- 4.3 §1의 세 번째 항: 그 기간에 고를 수 있는 profile이 있었는가.
SELECT count(*) FILTER (WHERE "currentVersionId" IS NOT NULL) AS publishable,
       min("createdAt") AS first_created
FROM "AssistantProfile";
```

기록 대상: 4.1의 값과 두 timestamp, 4.2의 전체 행(또는 "행 없음"), 4.3의
결과.

## 5. 감사 로그의 완전성 — **미확인 (도구는 있음)**

"ON 기록이 없다"를 "켜진 적 없다"로 바꾸려면 감사 로그가 §3의 시작 시각까지
완전해야 합니다. 저장소에서 확인한 사실은 다음과 같습니다.

**(a) 이 플래그를 쓰는 코드 경로는 하나뿐입니다.** `setAssistantProfilesEnabled()`의
호출처는 `app/api/admin/app-settings/route.ts` 단 한 곳이고, 이 라우트는
쓰기 전후로 `writeAdminAuditLog`를 두 번 호출합니다. 저장소 전체에서 다른
`AppSetting` 쓰기는 `lib/billingPriceCatalog.ts`(다른 key)와
`scripts/run-default-model-reconciliation.mjs`(key `guestDefaultModelId`
고정)뿐이며, 둘 다 이 플래그를 건드리지 않습니다.

**(b) 감사 행은 삭제되지 않습니다.** `lib/retentionPolicyCore.ts`의
`auditLogs` 항목은 `action: "keep"`, `maintenanceStep: null`이고 정책 문구가
"Nothing deletes them"입니다. 저장소 어디에도 `adminAuditLog.delete*` 호출이
없습니다. `/api/admin/retention`은 365일 floor를 넘는 행 수를 **세기만** 합니다.

**(c) 중간 삭제는 탐지 가능합니다.** 각 행은 `previousHash`/`entryHash`
해시 체인을 갖고, `verifyAdminAuditIntegrity()`가 행별 해시와 **링크까지**
검증합니다. 중간에서 행이 사라지면 링크가 끊어집니다.

```
GET /api/admin/audit-integrity     →  { integrity: { configured, valid,
                                                     checkedEntries,
                                                     firstInvalidId } }
```

**남은 확인 사항 (사람이 해야 함)**

- [ ] `/api/admin/audit-integrity`가 `valid: true`인가.
- [ ] 체인의 가장 오래된 행이 §3 시작(2026-08-15T01:17Z)보다 앞서는가.
      (`SELECT min("createdAt") FROM "AdminAuditLog";`)
- [ ] production DB에 대한 직접 SQL 수정 이력이 없는가. 이것은 저장소가
      증명할 수 없으며 인프라 접근 기록으로만 답할 수 있습니다.
- [ ] `AppSetting."updatedAt"`(4.1)이 4.2의 마지막 감사 시각보다 뒤인가.
      뒤라면 콘솔 밖에서 쓴 것이므로 이력이 불완전합니다.

위 넷 중 하나라도 증명하지 못하면 결론은 **"ON 이력 미발견, 로그 완전성
한계로 확정 불가"** 이며, "노출 없음"으로 적지 않습니다.

## 6. 개별 영향 식별·복원 가능 여부 (확정 — 불가)

노출 window가 확인되더라도 **어떤 대화가 덮어써졌는지 특정할 수 없고, 원래
값을 복원할 수도 없습니다.**

- `Conversation.selectedModels`는 현재값만 보관하며 변경 이력 테이블이
  없습니다. 현재값만으로는 덮어써진 대화와 사용자가 스스로 그 조합을 고른
  대화를 구별할 수 없습니다.
- 대화 PATCH를 남기는 구조화 로그가 없습니다. `AdminAuditLog`는 관리자
  행위만 담고 사용자 요청은 담지 않습니다.
- 따라서 해당 기간의 **API 접근 로그·클라이언트 telemetry·DB 백업** 중
  profile PATCH와 뒤이은 다른 대화의 모델 설정 PATCH를 연결할 자료가 있어야만
  개별 식별이 가능합니다. 그런 자료가 없다면 식별은 불가능합니다.

**일괄 복구를 시도하지 않습니다.** 원래 모델 구성을 알 수 없으므로 추정값으로
되돌리면 영향받지 않은 대화까지 손상시킵니다. 사용자가 스스로 다시 선택하는
것이 유일하게 안전한 복구입니다.

## 7. 결론

| 항목 | 상태 |
|---|---|
| 취약 코드 최초 production 배포 | 2026-08-15T01:17:06Z (`851598e`, 추정 — §3) |
| 수정 코드 production 배포 | 2026-08-16T05:48:36Z, `0e72b5b` (#633) |
| 취약 코드 노출 구간 | 약 28시간 31분 |
| 플래그 변경 이력·현재값 | **미확인** (§4) |
| 감사 로그 보존 범위·완전성 | **미확인** (§5, 검증 도구 존재) |
| 노출 window | **판정 불가** — §4·§5 필요 |
| 개별 영향 식별 | **불가** (§6) |
| 개별 복원 | **불가**, 일괄 복구 금지 (§6) |

현재 production(`e7d48c1`)은 수정을 포함하므로 **추가 노출은 발생하지
않습니다.** 남은 것은 과거 구간에 대한 사후 판정뿐이며, 그 판정을 위해
기능을 다시 끌 필요는 없습니다.

§4·§5가 채워지면 이 문서의 7절을 갱신해 종결합니다.
