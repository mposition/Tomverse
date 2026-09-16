# 잠긴 원문의 메모리 추출 거부 — 설계안 (2026-09-16)

배경: CONT-SEARCH-01 검토 중 Codex가 찾은 기존 잠금 우회 두 건 가운데 하나입니다.
사용자 결정으로 별도 과제로 분리됐습니다(`task_c3a7aa47`). 나머지 한 건(가져온
데이터 JSON 내보내기)은 이 문서의 범위가 아닙니다.

## 1. 결함

`docs/policy/external-conversation-import-and-memory.md` §7.1은 잠금 상태에서
"evidence 원문을 열람하거나 새 chat에서 우회 노출할 수 없다"고 정합니다. 메모리
추출은 snapshot의 제목과 모든 메시지 본문을 외부 provider에 보내므로 그 우회
노출에 해당하는데, 세 지점 모두 잠금을 보지 않습니다.

| 지점 | 파일 | 현재 |
|---|---|---|
| 선택 목록 | `components/memory/MemoryExtractionLauncher.tsx:60` | 서버가 `locked`를 이미 보내는데 client 타입이 버립니다 |
| 견적·생성 | `lib/memoryExtractionService.ts:176` | `where: { id: { in }, userId, finalized: true }` — `password`를 보지 않습니다 |
| 워커 | `lib/memoryExtractionWorker.ts:172` | `title`과 메시지 `content`를 읽으면서 `password`·`finalized`를 다시 보지 않습니다 |

§7.1이 명시적으로 남긴 반대 사례가 판단을 굳힙니다 — "**삭제는 잠금으로 막지
않습니다**. lock이 지키는 것은 내용 노출이고 삭제는 내용을 드러내지 않습니다."
추출은 내용을 드러내므로 같은 논리가 반대 방향으로 적용됩니다.

또 §7.1은 잠금이 그 원문만을 근거로 가진 기존 메모리를 `suspended_by_source_lock`
으로 바꾸고 즉시 검색에서 제외합니다. 기존 메모리는 정지시키면서 같은 원문에서
새 메모리를 뽑는 것은 자기모순입니다.

## 2. 정책이 아직 답하지 않은 것

§11.1의 chunk 경계 재검사 목록(:765)은 닫힌 목록입니다 — "feature flag, 승인
pair와 revocation, 사용자 plan, provider 예산". **source lock은 없습니다.**
:767은 "취소·flag off·revocation은 즉시 정지 사유"라고만 적습니다.

즉 실행 중 원문이 잠긴 run을 어떻게 할지에 대한 규칙이 **존재하지 않습니다.**
이 설계가 새로 정해야 하는 부분이고, 나머지는 §7.1의 적용입니다.

## 3. 제안

### 3.1 선택 단계 — 고를 수 없습니다

`/api/external-conversations`가 이미 `locked`를 반환하므로 서버 변경이 없습니다.
`ConversationRow`에 `locked: boolean`을 추가하고,

- checkbox `disabled`
- 제목 옆 잠김 배지(목록에서 이미 `titleWithheld`로 제목이 가려진 행입니다)
- "보이는 항목 모두 선택"이 잠긴 행을 건너뜀
- `lib/memoryExtractionLaunch.ts`의 `LaunchBlockReason`에 `locked_selection` 추가

잠긴 행을 숨기지 않고 **비활성으로 보여 주는** 이유는, 이 목록이 기능 카탈로그가
아니라 사용자가 가진 imported source의 목록이기 때문입니다. 숨기면 대화가 왜
없는지 설명할 수 없고 pagination total과도 어긋납니다.

비활성만으로는 행동할 수 없으므로 함께 필요한 것:

- 행에서 `/settings/imports/conversations/{id}`의 잠금 해제 화면으로 갈 수 있어야
  합니다. 막기만 하고 푸는 길을 주지 않는 것은 고장으로 읽힙니다.
- **이미 선택된 행이 나중에 잠긴 경우** `disabled + checked`로 남기면 개별 해제가
  불가능합니다. 목록 갱신 때 자동 deselect하거나, 선택된 행은 deselect만 허용합니다.
- "보이는 항목 모두 선택"과 summary뿐 아니라 실제 `selectedIds`에서도 잠긴 항목이
  빠졌는지 검증합니다.

### 3.2 견적·생성 — 거부합니다

`estimateMemoryExtraction`의 선택 검증 쿼리에 `password: true`를 추가하고, 잠긴
항목이 하나라도 있으면 거부합니다. **`where`에 `password: null`을 넣지 않습니다**
— 그러면 :184의 all-or-nothing 검사에 걸려 `404 NOT_FOUND`가 나가고, "당신 것이
아님"과 구분되지 않습니다. 존재하지 않음·비소유·미확정 판정을 **먼저** 끝내
404를 유지한 뒤에 잠금을 봅니다.

거부 코드는 **기존 `423 CONVERSATION_LOCKED`를 재사용합니다.** §21(:1779)이 잠긴
snapshot 접근은 새 코드를 만들지 말고 이것으로 답하라고 이미 정했고, 요청이 여러
resource를 담아도 "요청 집합에 잠긴 것이 있어 all-or-nothing으로 거부됨"이라는
뜻은 유지됩니다. **응답에 잠긴 id 목록을 싣지 않습니다.**

client는 이 423을 전용 문구로 옮겨야 합니다. 현재
`MemoryExtractionLauncher.tsx:108`의 `failureToError`는 generic 오류로
떨어뜨리므로, 서버 경쟁으로 뒤늦게 받은 423이 "알 수 없는 오류"로 보입니다.

**생성 경로에도 판정이 필요합니다(초판의 오류).** 초판은
`createMemoryExtractionRun`이 `estimateMemoryExtraction`을 다시 부르므로(:352)
자동 상속된다고 적었지만, 그 호출은 **run 생성 트랜잭션 밖**입니다. 확인 직후
잠기면 run과 예약이 생깁니다. 판정을 복제하지 않되, transaction client를 받는
공용 validator를 트랜잭션 **안에서** 다시 부르고 snapshot 행을 id 순서로 잠급니다.
그래야 "거부가 예약보다 먼저"가 동시 실행에서도 참이 됩니다.

### 3.3 실행 중 잠긴 경우 — source를 빼고, 빈 chunk는 무과금 skip

`loadChunkConversations`의 `where`에 `password: null`을 추가해 잠긴 snapshot이
provider에 닿지 않게 합니다. **일부만 잠긴 chunk는 남은 unlocked source로 한 번
호출합니다** — run 전체 취소도, chunk 전체 포기도 아닙니다. 500개 중 하나를
잠갔다고 승인된 나머지 499개의 작업과 결과를 버릴 이유가 없습니다.

`memory delete-all`이 진행 중 run을 통째로 취소하는 선례(§13.1 :1036)는 여기로
옮겨오지 않습니다. 그쪽은 추출이 계속되면 방금 비운 memory store를 다시 채우므로
run 전체가 무의미해지지만, source lock은 그 source만 무효화합니다.

#### 과금 — `skipped` chunk 상태를 새로 만듭니다 (초판에서 뒤집힌 결정)

초판은 빈 chunk가 `completed`로 세어져 과금되는 것을 "삭제 경로에 이미 있는
동작"이라며 범위 밖으로 미뤘습니다. **그 논거는 틀렸습니다.** §13.1은 삭제 source의
과금 방식을 정한 적이 없고, worker의 기존 주석은 "없는 원문 때문에 run을 영구
실패시키지 않는다"만 정당화합니다(`memoryExtractionWorker.ts:273`). 반대로 정산
계약은 명시적입니다 —

> **Settlement charges for chunks that completed.** … the two really did call
> the provider. (`lib/memoryExtractionCredits.ts:33`)

같은 문장이 호출 지점에도 있습니다(`memoryExtractionService.ts:845`). 즉 빈 chunk를
`completed`로 세는 것은 받아들여진 특이사항이 아니라 **적힌 계약을 어기는 것**이고,
삭제 경로에 잠복해 있던 같은 결함입니다. 잠금은 정상적이고 반복 가능한 사용자
동작이므로, 이 변경이 그 결함에 새 경로를 연결하면서 미루는 것은 맞지 않습니다.

- chunk에 durable `skipped` 상태 추가 (migration 필요)
- 종료 판정: `completed + skipped >= chunkTotal`
- 진행 표시: 둘 다 처리 완료로 계산
- `chunksCharged`: **`completed`만**
- provider 호출이 이미 발행된 뒤 잠긴 경우는 `skipped`가 **아닙니다** — 그 비용은
  실제로 발생했으므로 `completed`이고, 결과 persistence 규칙은 아래 검증 4번이
  고정합니다.

부수 효과로 삭제된 source의 기존 무호출 과금도 함께 바로잡힙니다.

#### 잠금 순서

새 cross-path 잠금을 만들지 않습니다. §13.1(:1021)이 고정한 두 순서 — source lock은
`snapshot row → memory lock`, extraction은
`run → chunk → memory lock` — 는 그대로입니다. 특히 **memory lock을 잡은 뒤
snapshot row lock을 새로 잡지 않습니다**(§13.1의 순서를 뒤집습니다). memory lock
아래에서 잠금 상태가 필요하면 일반 read로 재검증합니다. 생성 경로에서 snapshot
행을 잠그는 것은 memory lock보다 앞이므로 이 순서를 어기지 않습니다.

### 3.4 정책 개정

무엇이 새 결정이고 무엇이 명시화인지 구분합니다.

- **§7.1 — 명시화입니다, 새 결정이 아닙니다.** 잠금이 막는 것에 메모리 추출을
  적는 것은 기존 confidentiality 계약을 적용한 결과입니다. §19 위협모델 :1564의
  "lock 우회 (evidence·retrieval·share 경유)"에 extraction을 네 번째로 추가.
- **§11.1 (:765) — 여기만 새 결정입니다.** chunk 경계 재검사 목록은 닫힌 열거이고
  source lock이 없습니다. 실행 중 잠긴 run을 어떻게 다루는지도 정해진 바가
  없으므로, 위 §3.3의 규칙을 이 절에 씁니다.
- **§11/§13.1 — 정산 계약을 chunk 상태로 다시 씁니다.** 과금 대상은
  `completed`이며 `skipped`는 과금하지 않는다는 것, 그리고 종료 판정이
  `completed + skipped`라는 것.

## 4. 검증

선형화(linearisation) 케이스 넷이 이 설계의 핵심입니다.

1. **lock이 run 생성보다 먼저 이기면** run 0건, reservation 0건
2. **lock이 provider source-admission보다 먼저 이기면** provider 호출 0, 과금 0
3. **한 chunk에서 일부만 잠기면** provider 입력에 unlocked source만 들어가고,
   그 chunk는 `completed`이며 과금됩니다
4. **provider admission 이후에 lock이 이기면** 결과 persistence와 과금이 어떻게
   되는지 — 비용은 이미 발생했으므로 과금하되, 잠긴 source에서 나온 메모리가
   저장되는지 여부를 이 테스트가 고정합니다

파일별:

- 단위 `tests/memoryExtractionLaunch.test.mjs` — `locked_selection` gate, 요약과
  `selectedIds` 양쪽에서 잠긴 행 제외
- 단위 `tests/memoryExtractionCore.test.mjs` — `completed + skipped` 종료 판정
- DB `tests/integration/memory-extraction.db.test.ts` — `:218`의 형제로 423, 그리고
  1번
- DB `tests/integration/memory-extraction-worker.db.test.ts` — `:227`의 형제로
  2·3번
- DB `tests/integration/memory-extraction-credits.db.test.ts` — `skipped`가
  `chunksCharged`에서 빠지는 것, 그리고 4번

## 5. 운영 사실

`feature.memoryExtractionEnabled`는 기본 OFF이고
(`lib/appSettings.ts:543`, `lib/memoryExtractionService.ts:945`가
`feature_disabled`로 즉시 반환), production 활성 여부는 이 저장소가 답할 수 없는
운영 DB 사실입니다. 그러므로 **이 결함이 지금 production에서 도달 가능한지는
미확인**이며, 그 확인은 사람이 합니다. 도달 불가라 해도 flag를 켜는 것이 곧
활성화이므로 켜기 전에 고쳐 두는 것이 맞습니다.

## 6. 4번 케이스의 제안 답 (검토 필요)

provider 호출이 나간 뒤 잠금이 이긴 경우, 노출은 이미 일어났으므로 되돌릴 수
없습니다. 남는 질문은 **그 결과로 나온 메모리를 저장할 것인가**입니다.

제안: **저장하되 `suspended_by_source_lock`으로 저장합니다.** §7.1이 이미 "잠긴
원문만을 근거로 가진 메모리는 정지되고 검색에서 제외된다"고 정했고, 그 상태가
정확히 이 메모리의 상태입니다. 버리면 사용자가 크레딧을 치른 작업이 사라지고,
`active`로 저장하면 §7.1을 어깁니다.

주의할 점 하나: 잠금 시점의 일괄 정지는 **그때 존재한 메모리**만 봅니다. 잠금
이후에 커밋되는 이 메모리들은 그 일괄 처리가 지나간 뒤에 생기므로,
`commitExtractionChunk`가 evidence의 잠금 상태를 보고 status를 정해야 합니다.
reconciliation이 나중에 고쳐 주기를 기대하면 그 사이에 검색에 노출됩니다.

## 7. 개정 이력

- **v1** (2026-09-16) — 초판.
- **v2** (2026-09-16, Codex 독립 검토 REVISE 반영) — 네 가지가 바뀌었습니다.
  1. **생성 경로에 판정을 추가.** 초판은 `createMemoryExtractionRun`이 estimate를
     다시 부르므로 자동 상속된다고 했지만 그 호출은 트랜잭션 밖입니다. 동시
     실행에서 "거부가 예약보다 먼저"가 거짓이었습니다.
  2. **과금을 이 변경에서 고치는 것으로 뒤집음.** 초판은 "삭제 경로에 이미 있는
     동작"이라며 미뤘으나, 정산 계약이 completed = provider 호출됨을 명시하므로
     선례가 아니라 잠복 결함이었습니다. `skipped` chunk 상태를 새로 만듭니다.
  3. **일부만 잠긴 chunk는 남은 source로 호출.** 초판은 chunk 단위 전부/전무만
     생각했습니다.
  4. **문서 표현 정정.** §7.1 적용은 명시화이지 새 결정이 아니며, "§13.1이 삭제
     source의 과금을 승인했다"는 주장은 근거가 없어 삭제했습니다.

## 8. v3 — 두 개로 쪼갭니다 (Codex 2차 검토 반영)

2차 검토에서 여섯 지적 중 다섯은 반영됐다고 확인받았고, 남은 것은 범위입니다.
한 변경으로 묶기에 크고, **seam이 분명합니다** — "provider를 부르지 않은 chunk의
정산"은 잠금과 무관한 일반 결함이고, "source lock 적용"은 그 위에 얹힙니다.

### 8.1 먼저 랜딩: `skipped` chunk 상태와 정산 (잠금과 무관)

- `MemoryExtractionChunk.status`의 DB CHECK migration에 `skipped` 추가
- handler와 `completeExtractionChunk` 결과 union에 `skipped` 추가
- **`skipped`는 terminal**이며 `chunkFailureDisposition`을 거치지 않고 재시도하지
  않습니다. claim에서 오른 `attemptCount`는 그대로 두고, `completedAt`은
  `completed`와 동일하게 기록합니다
- `chunkCompleted`의 의미를 **provider 성공 수에서 처리 완료 수(`completed +
  skipped`)로** 바꿉니다. run 종료 판정도 같습니다
- `chunksCharged`는 settlement·cancel·delete-all 모두에서 계속 **`completed`만**
- **기존 deleted/missing-source 경로를 `completed`에서 `skipped`로 고칩니다**
  (`memoryExtractionWorker.ts:273`) — 이것이 이 랜딩이 실제로 고치는 결함입니다
- `lib/memoryExtractionMetricsCore.ts:315`는 지금 `completed`와 `failed`만 셉니다.
  `skipped`를 추가하고, **정상 skip이 `partiallySettled`를 올리게 되는 의미 변화**를
  문서화하거나 지표를 분리합니다
- lease fence는 `running + leaseGeneration` 조건을 그대로 쓰므로 깨지지 않지만,
  **stale generation이 `skipped`를 기록하거나 정산하지 못한다**는 테스트를 추가합니다

### 8.2 그다음 랜딩: locked source

§3.1~§3.4와 §6. 위 랜딩 없이 이것이 먼저 배포되면 **locked-only chunk가 예전처럼
provider 호출 없이 `completed`로 과금**되고, 반대로 DB CHECK가 `skipped`를 허용하기
전에 애플리케이션이 그 값을 쓰면 write가 실패합니다. **순서가 계약입니다.**

### 8.3 §3.2의 행 잠금 표현 정정

"id 순서로 잠근다"는 **DB의 `ORDER BY id ASC … FOR UPDATE`여야 합니다.**
JavaScript `sort()`나 Prisma `orderBy`는 결과 정렬을 말할 뿐 행 잠금 획득 순서를
보장하지 않습니다. `reconcileExpiredMemoryExtractionRuns`가 이미 쓰는 형태입니다.

기존 순서와 충돌하지 않음도 확인받았습니다 — `credit lock → run advisory lock`
뒤에 snapshot을 잠가도 memory lock 역순은 생기지 않습니다.

### 8.4 §6의 정정 — commit 시점 검사만으로는 부족합니다

§6은 "`commitExtractionChunk`가 evidence의 잠금 상태를 보고 status를 정한다"고
적었지만, 그것만으로는 한쪽 순서를 놓칩니다.

- source-lock 트랜잭션이 snapshot 행을 갱신한 뒤 memory lock을 기다리고, commit이
  memory lock을 먼저 얻으면, **commit의 일반 read는 아직 커밋되지 않은 잠금을 보지
  못합니다.** 그 순서에서는 뒤따르는 source-lock 일괄 전이가 새로 생긴 메모리를
  후보로 처리해야 합니다.
- 즉 **양쪽 경로가 같은 상태 전이를 알아야 합니다.** commit 쪽 검사와 lock 쪽 일괄
  전이 중 하나만 있으면 순서에 따라 구멍이 남습니다.

그리고 provider 호출의 선형화점은 **최초 unlocked 읽기**입니다. 그 판정이 먼저였다면
이미 승인된 호출은 lock 응답 뒤에도 나갈 수 있습니다. 다만 **lock commit 이후에는
아직 발행되지 않은 호출이 나가서는 안 되므로**, `onCallIssued` 직전에 재검사하고
prompt를 다시 구성해야 합니다.

## 9. v4 — §6과 §8.4를 뒤집습니다 (구현 중 코드로 확인)

§6은 "provider 호출 후 잠금이 이기면 결과 메모리를 `suspended_by_source_lock`으로
저장한다"고 했고, §8.4는 "commit 쪽 검사와 잠금 쪽 일괄 전이가 **둘 다** 그 상태를
알아야 한다"고 했습니다. 구현하려고 코드를 따라가 보니 **둘 다 틀렸고, §6은
해롭기까지 했습니다.**

### 9.1 §6이 해로운 이유

추출은 메모리를 `active`가 아니라 `candidate` 또는 `manual_review_required`로
씁니다(`lib/memoryExtractionPersistence.ts`의 `statusFor`, `approvedAt: null`).

그리고 `lib/memorySourceLock.ts`는 **`active`만** 정지시키고, 해제 시 정지된 것을
**`active`로 복원**합니다. 그 파일 머리 주석이 이유를 적고 있습니다 —
`suspended_by_source_lock`은 이 경로만 쓰고 `active` 위에만 쓰므로 상태 자체가
"무엇으로 돌아갈지"의 기록이고, 그래서 "사용자가 승인한 적 없는 candidate를 복원이
승격시킬 수 없다"는 것입니다.

§6대로 후보를 `suspended_by_source_lock`으로 저장하면 정확히 그 불변식이 깨집니다.
**잠금을 풀면 사용자가 검토한 적 없는 후보가 `active`가 되어 채팅에 주입됩니다.**

### 9.2 §8.4가 불필요한 이유

§8.4의 걱정은 "commit이 아직 커밋되지 않은 잠금을 못 보고 후보를 저장하면, 그 후보가
잠긴 원문에서 나온 채로 남는다"였습니다. 사실이지만 그것이 누출로 이어지지 않습니다.

`lib/memoryRetrievalService.ts`의 **`reachableEvidenceFilter`**가 채팅 주입 쿼리에서
잠긴 원문만을 근거로 가진 메모리를 **읽는 시점에** 제외합니다. 그 주석은 바로 이
상황을 위해 존재한다고 적습니다 —

> It is here for the window where the database is *not* consistent — evidence
> added to a memory after its source was locked, a reconciliation sweep that has
> not run yet — because the two halves fail in opposite directions: the status
> transition is what the user sees on their review screen, and this is what
> decides whether a locked conversation's content can shape an answer. Only one
> of those is worth being lazy about.

즉 보장은 상태 전이가 아니라 읽기 필터에 있고, 커밋 순서와 무관하게 성립합니다.
후보를 나중에 승인해 `active`가 되더라도 원문이 잠겨 있는 동안은 주입되지 않습니다.

### 9.3 그래서 case 4의 답

**평소대로 `candidate`/`manual_review_required`로 저장하고, 특별한 처리를 하지
않습니다.** commit 경로에 잠금 검사를 넣지 않고, 잠금 쪽 일괄 전이도 바꾸지 않습니다.

- provider 노출은 이미 일어났고 되돌릴 수 없습니다. 이 설계가 막을 수 있는 노출은
  §3.2(견적·생성), §3.3(워커 필터), 그리고 호출 직전 재검사까지입니다.
- 결과 후보는 채팅에 주입되지 않습니다(읽기 필터).
- 검토 화면에는 보입니다. 이는 잠금 후 정지된 `active` 메모리가 이미 목록에 보이는
  기존 설계와 같은 수준이며, 목록은 증거 원문(메시지 본문)을 싣지 않습니다.
- 사용자가 크레딧을 치른 결과를 버리지 않습니다.

### 9.4 호출 직전 재검사 (§8.4 후반부는 유효)

§8.4의 두 번째 절반 — "lock commit 이후에는 아직 발행되지 않은 호출이 나가서는 안
된다" — 은 맞고 구현했습니다. `onCallIssued`에서 `callIssued`를 세우기 **전에**
잠금을 다시 읽고, 잠겼으면 전용 오류를 던져 요청을 막습니다. provider 입장권은
발행되지 않았으므로 정산이 아니라 해제되고, chunk는 `source_locked`로 재시도됩니다.
프롬프트는 adapter 안에서 고칠 수 없으므로 "다시 구성"은 재시도의 재로드가
담당합니다 — 그 재로드의 필터가 잠긴 원문을 빼고, 전부 잠겼으면 `skipped`가 됩니다.

닫을 수 없는 창은 "재검사 이후 요청 바이트가 나가기 전"에 커밋된 잠금입니다. 그것을
닫으려면 네트워크 호출 동안 행 잠금을 쥐어야 합니다. 재검사가 선형화점이고, 그 뒤에
이긴 잠금은 9.3이 다룹니다.

### 9.5 검증 목록 개정 (§4)

§4의 4번 케이스는 "잠긴 원문에서 나온 메모리를 저장하는지"를 고정한다고 했습니다.
개정: **저장한다, 그리고 그 메모리는 원문이 잠긴 동안 검색 결과에 나오지 않는다.**
검증 대상은 상태가 아니라 `reachableEvidenceFilter`가 그것을 거르는 사실입니다.
