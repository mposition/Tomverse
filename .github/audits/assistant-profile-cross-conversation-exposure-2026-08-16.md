# Assistant profile 응답의 교차 대화 오염 — production 노출 감사 (2026-08-16)

`handleAssistantProfileChange`의 PATCH 응답이 다른 대화의 `selectedModels`를
덮어쓴 결함(#632, 수정 #633)에 대해, **production에서 실제로 노출된 기간과
영향 식별 가능 여부**를 판정합니다.

**종결 (2026-08-16).** 결론은 **노출 없음**입니다. 취약 코드가 production에
있던 28시간 31분 동안 `feature.assistantProfilesEnabled`는 한 번도 켜진 적이
없고, 그 사실이 감사 로그·행 타임스탬프·해시 체인 세 가지로 서로 맞물려
확인됩니다(§4·§5). 노출 window는 공집합이므로 §6의 복구 논의는 적용 대상이
없습니다.

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
    ∩ feature.assistantProfilesEnabled 가 ON 인 기간      (§4 — 확정: 없음)
    ∩ assistant profile 기능을 실제로 쓸 수 있던 기간      (§4.4 — 판정 불요)
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

## 4. 플래그 이력과 현재값 — **확인 완료: 한 번도 켜진 적 없음**

`feature.assistantProfilesEnabled`는 fail-closed이며 기본 OFF입니다
(`lib/assistantProfileAccess.ts`). 행이 없으면 OFF이고, 이 플래그를 seed하는
마이그레이션은 없습니다.

### 4.1 현재 행

```sql
SELECT key, value, "createdAt", "updatedAt"
FROM "AppSetting"
WHERE key = 'feature.assistantProfilesEnabled';
```

| key | createdAt | updatedAt | value |
|---|---|---|---|
| `feature.assistantProfilesEnabled` | 2026-08-15T08:19:30.050Z | 2026-08-16T07:00:49.223Z | `false` |

`createdAt`이 §3 구간 시작(01:17:06Z)보다 **7시간 2분 뒤**입니다. 그 이전에는
행 자체가 없었으므로 구간 앞부분은 행 부재로 OFF가 확정됩니다.

`updatedAt`이 `createdAt`과 다르므로 생성 이후 최소 한 번의 쓰기가 있었고,
이 행만으로는 그 사이의 값을 알 수 없습니다. 그 판정은 4.2가 합니다.

### 4.2 설정 저장 이력 (`AdminAuditLog`)

`app_settings.*` 항목 전체입니다. 저장 1회가 2행(전·후)을 남깁니다.

사용한 쿼리:

```sql
SELECT "createdAt", "actorEmail", action,
       metadata->>'assistantProfilesEnabled' AS profiles_enabled
FROM "AdminAuditLog"
WHERE action IN ('app_settings.update_started',
                 'app_settings.guest_default_model.updated')
ORDER BY "createdAt";
```

| createdAt | action | `assistantProfilesEnabled` |
|---|---|---|
| 2026-08-15T08:19:29.974Z | `update_started` | `false` |
| 2026-08-15T08:19:30.074Z | `guest_default_model.updated` | `false` |
| 2026-08-15T10:06:17.357Z / .430Z | 전 / 후 | `false` |
| 2026-08-15T10:07:51.466Z / .516Z | 전 / 후 | `false` |
| 2026-08-16T00:26:07.614Z / .684Z | 전 / 후 | `false` |
| 2026-08-16T01:20:39.859Z / .953Z | 전 / 후 | `false` |
| 2026-08-16T07:00:49.160Z / .244Z | 전 / 후 | `false` |

행위자는 전 구간 단일 관리자 계정입니다. **6회 저장이 모두 `false`를
제출했고, `true`를 제출한 저장은 존재하지 않습니다.**

### 4.3 세 개의 타임스탬프가 맞물린다

| 확인 | 결과 |
|---|---|
| 최초 감사 항목 08:19:29.974Z vs 행 생성 08:19:30.050Z | 감사가 **76ms 앞섬**. 라우트가 `update_started`를 쓴 뒤 setter를 실행하는 순서와 일치 — 이 행을 만든 것이 그 저장이다. |
| 행 `updatedAt` 07:00:49.223Z vs 마지막 저장 07:00:49.160Z ~ .244Z | 쓰기가 두 감사 항목 **사이**에 있음. 콘솔 트랜잭션 안에서 일어났다는 뜻이며, **콘솔 밖 직접 쓰기 없음**. |
| 감사 이력 시작 08:19:29.974Z vs 판정 대상 구간 시작 08:19:30.050Z | 감사가 구간보다 **앞**에서 시작. 구간 전체가 이력으로 덮인다. |

### 4.4 §1 세 번째 항

플래그가 OFF이면 `GET /api/assistant-profiles`가 403이므로
`assistantProfileOptions`가 채워지지 않고 컨트롤이 렌더되지 않습니다. 발행된
profile의 존재 여부는 확인할 필요가 없습니다.

## 5. 감사 로그의 완전성 — **확인 완료**

"ON 기록이 없다"를 "켜진 적 없다"로 바꾸려면 감사 로그가 완전해야 합니다.
저장소에서 확인한 사실과 production에서 확인한 결과입니다.

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

**(c) 중간 삭제가 없었음을 확인했습니다.** 각 행은 `previousHash`/`entryHash`
해시 체인을 갖고, `verifyAdminAuditIntegrity()`가 행별 해시와 **링크까지**
검증합니다.

```
GET /api/admin/audit-integrity
{"integrity":{"configured":true,"valid":true,"checkedEntries":53,
              "firstInvalidId":null,"message":"The HMAC audit chain is valid."}}
```

이것이 배제하는 시나리오는 구체적입니다 — 4.2의 기록된 저장들 **사이에서**
`true`로 켰다가 다시 끈 저장 쌍이 통째로 삭제된 경우. 링크가 끊기므로
`valid: true`와 양립할 수 없습니다.

**확인 결과**

- [x] `/api/admin/audit-integrity`가 `valid: true` (53개 항목, 무효 없음).
- [x] 체인이 판정 대상 구간 시작보다 앞에서 시작 (§4.3).
- [x] 콘솔 밖 쓰기 없음 — 행 `updatedAt`이 마지막 저장의 감사 항목 사이에
      위치 (§4.3).
- [x] 현재값과 감사 이력을 시간순으로 재구성했을 때 공백 없음 (§4.1–4.2).

**남는 한계 (결론을 바꾸지 않음):** 검증기는 `entryHash`가 있는 행만 셉니다.
해시 체인은 2026-07-18 마이그레이션에서 도입됐으므로 그 이전 행은 검증 대상이
아니지만, 그 시점은 이 감사의 구간(2026-08-15~16)보다 앞서므로 판정에 영향이
없습니다.

## 6. 개별 영향 식별·복원 가능 여부 (적용 대상 없음)

§4·§5로 노출 window가 공집합임이 확인됐으므로 **이 절은 이번 건에 적용되지
않습니다.** 아래는 같은 종류의 결함이 실제 노출 구간을 가졌을 때를 위해
남겨 둔 판단입니다: 그런 경우에도 **어떤 대화가 덮어써졌는지 특정할 수 없고,
원래 값을 복원할 수도 없습니다.**

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

## 7. 결론 — 노출 없음

| 항목 | 결과 |
|---|---|
| 취약 코드 최초 production 배포 | 2026-08-15T01:17:06Z (`851598e`, 추정 — §3) |
| 수정 코드 production 배포 | 2026-08-16T05:48:36Z, `0e72b5b` (#633) |
| 취약 코드 노출 구간 | 약 28시간 31분 |
| 플래그 현재값 | `false` |
| 플래그 ON 이력 | **없음** — 행 생성(2026-08-15T08:19:30.050Z) 이전은 행 부재로 OFF, 이후는 6회 저장이 모두 `false` (§4) |
| 감사 로그 보존 범위·완전성 | **확인** — 체인 `valid: true`(53), 구간을 덮음, 콘솔 밖 쓰기 없음 (§5) |
| **노출 window** | **공집합 (취약 코드 구간 ∩ 플래그 ON 구간 = ∅)** |
| **결론** | **노출 없음** |
| 개별 영향 식별·복원 | 적용 대상 없음 (§6) |

즉 취약 코드는 production에 28시간 31분 존재했지만, 그 기간 내내 assistant
profile 기능이 꺼져 있어 사용자가 profile을 고를 수 없었고, 이 결함은 profile
선택에서만 시작되므로 실제로 발현할 수 없었습니다.

현재 production은 수정을 포함하므로 앞으로도 노출은 발생하지 않습니다. 이
감사는 **종결**합니다.

### 사용한 증거

- 배포 이력: Railway production 배포 24건의 커밋을 `ef0b353`·`0e72b5b` 조상
  판정 (§3), `GET /api/build-info`로 교차 확인.
- `AppSetting` 행 1건 (§4.1).
- `AdminAuditLog`의 `app_settings.*` 12행, 쿼리 포함 (§4.2).
- `GET /api/admin/audit-integrity` 응답 (§5).
