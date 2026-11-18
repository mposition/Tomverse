# AMUX v22 실행 결과 전송: 조각 전송과 크기 상한 없음 (운영자 결정 2026-11-18)

운영자 지시(2026-11-18): v22 card 실행 결과에 걸린 크기 상한 가운데 우리가 만든 것은 없애고, 외부 시스템의
한계만 남긴다. 대상은 patch 4 MiB, 한 번의 전송 32 MiB, 그보다 먼저 걸리는 Next.js proxy 10 MiB 요청 본문,
PR diff digest 1 MiB다. 이 문서와 `development-agent-orchestration.md`의 "크기 상한 없음"·"결과 patch의 상한은
하나다" 항목이 다르면 이 문서가 맞다. 승인 digest(5절)는 운영자 결정을 기다린다.

운영자 결정(2026-11-18, 권장안 채택):
- 큰 bytea는 조각으로 읽어 node-pg 읽기 한계를 없앤다(3-B 단계).
- 내려가는 방향(재개 때 이전 patch 32 MiB, DM workspace 64 MiB)은 다음 작업으로 분리하고, 그 전까지는 넘으면
  생략 안내로 내려보낸다.
- 큰 결과를 기록하는 동안 감사 chain lock이 크기에 비례해 잡히는 것을 허용한다(봉인·검사는 transaction 밖).

## 0. 무엇을 없애고 무엇이 남는가

### 없애는 상한

| 지점 | 지금 | 바뀐 뒤 |
|---|---|---|
| `lib/amux/v22PatchCapture.mjs` | git diff maxBuffer 4 MiB+4 KiB, `PATCH_LIMIT_BYTES`, JSON 2배 검사, 경로 목록 JSON 4 MiB | 없음. maxBuffer는 `Infinity`, NUL·UTF-8·비밀 검사는 그대로 |
| `lib/amux/v22OneShotSidecar.mjs` `amuxV22FitReportText`, pending 쓰기 | 보고 32 MiB(가운데 자름), patch pending 4 MiB | 보고를 자르지 않음. pending 크기 검사 없음 |
| `lib/amux/v22OneShotSidecar.mjs` `readResult` | readback마다 본문 전체를 inline으로 돌려줌 | 새 op는 본문을 싣지 않음. 조각 읽기 op를 따로 둠 |
| `lib/amux/v22LocalCliFlowCore.ts` `AMUX_V22_TRANSPORT_MAX_BYTES` | 결과·내려가는 방향 모두 32 MiB | 결과 방향에는 쓰지 않음. 내려가는 방향만 남김(9절) |
| `lib/amux/v22PatchLimit.ts` | `AMUX_V22_PATCH_MAX_BYTES`, `AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES`, `AMUX_V22_PATCH_ENVELOPE_MAX_BYTES` | 없앰. 옛 inline 경로용 `AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES`(4 MiB)·`AMUX_V22_LEGACY_PATCH_ENVELOPE_MAX_BYTES`만 남김 |
| `lib/amux/ideaCrypto.ts` | 봉인 크기 `task_patch` 4 MiB, `task_result` 32 MiB | `task_result`·`task_patch`·새 `task_changed_paths`는 `idea_raw`처럼 크기를 보지 않음 |
| `lib/amux/v22TaskResultStore.ts` | `amuxV22ResultMaxBytes`, patch 4 MiB, statement_timeout 5 s 고정 | 상한 없음. 시간은 크기에 비례(6절) |
| `lib/amux/v22PatchEvidence.ts`, `lib/amux/v22OptionalPatch.ts` | 4 MiB | 텍스트 형식은 상한 없음. 옛 JSON(files) 형식만 4 MiB |
| `app/api/internal/amux/v22/execution/result/route.ts` | body 하나에 결과와 patch | 조각 commit 변형 추가. 옛 inline은 proxy 10 MiB까지 |
| `settle/route.ts`, `v22/review/record/route.ts` | `changed_paths` 배열을 9 MiB body에 | digest 참조로. 배열은 옛 bridge용 |
| DB CHECK `20261115140000_v22_patch_size_bound`, `20261116011100_amux_v22_task_result_report_size` | `byteLength ≤ 4194304`, `≤ 33554432`, `patchBody ≤ 4194304` | 하한만 남김(2.5절, 4절) |
| `apps/tomverse-orchestrator/src/wsl_bridge.rs` | sidecar 응답 73 MiB, patch 4 MiB | 옛 sidecar 경로에서만. 새 경로는 조각 단위 |
| `apps/tomverse-orchestrator/src/tomverse_api.rs` | `V22_PATCH_MAX_BYTES`, `V22_TRANSPORT_MAX_BYTES`, result POST 한 번 | 새 경로는 조각 POST와 commit |
| `lib/engineeringAgentStore.ts` | `ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES` 4 MiB | 없앰. claim의 inline 판정 기준으로만 남김 |
| `lib/engineeringAgentV22CandidateLoad.ts` | `patch_over_limit` | 없앰. 옛 사유 이름은 읽기만 |
| publisher·`lib/pullDiffDigestCore.ts`·`lib/engineeringAgentGitHubRead.ts`·`lib/amux/reviewGitHub.ts`·`lib/qaReleaseMergeLaneGithub.ts` | diff 1 MiB, binary 거절, `diff_not_bindable` | 승인 binding v2(5절, 운영자 결정 대기) |

조사 중 새로 찾은 것:
- `lib/amux/ideaCrypto.ts`의 봉인 크기가 patch를 4 MiB에서 막는다. DB CHECK를 풀어도 여기서 실패한다.
- 복구 점검이 terminal journal(`<attempt>.result`)을 128 KiB까지 읽는다. terminal에서 경로 배열을 빼면 terminal은 늘 작다.
- bridge가 tick마다 `readback`으로 결과 본문과 patch 전체를 다시 받는다. 새 op는 본문을 싣지 않는다.
- 결과 기록은 감사 chain lock 안에서 봉인한다. 무거운 일은 transaction 밖으로 옮긴다(2.2절).
- 게시 이미지(`.github/workflows/engineering-agent-image.yml`)는 main push에서만 만들어지고,
  `docker/engineering-agent.Dockerfile`의 COPY 목록은 닫혀 있다(`tests/engineeringAgentServices.test.mjs`).

### 남는 외부 한계

| 한계 | 값 | 어디에 걸리나 |
|---|---|---|
| GitHub 파일 | 100 MiB, push 2 GB | 게시 |
| GitHub API | 속도 한도, recursive tree 100,000개, PR 파일 목록 3,000개, 큰 `.diff`(406) | 후보 재구성, DM 병합 경로 검사, v1 digest |
| Postgres 값 하나 | 1 GB | 최종 행. 첫 조각에서 `AMUX_V22_STORAGE_MAX_BYTES`로 미리 거절 |
| V8 문자열 하나 | 약 512 MiB | 문자열로 검사하는 곳. 넘으면 결정적 409 |
| 앱 메모리(Railway plan) | 결과 크기의 약 4배 | commit route |
| Next.js proxy 요청 본문 | 10 MiB | 요청 하나. 조각 하나는 6 MiB 안 |
| GitHub App installation token | 1시간 | publisher 한 cycle(40분 마감 그대로) |

## 1. 조각 전송

### 1.1 흐름

```
sidecar 파일(<attempt>.{result,patch,changed_paths}.pending)
  └─ bridge: readback_v2 (본문 없음, parts 설명만)
       └─ read_pending(part, index) ──4 MiB──▶ POST /v22/execution/upload (조각, base64 JSON ≤ 6 MiB)
       └─ 다 보냈으면 POST /v22/execution/result {transfer:"chunked_v1"}         (결과+patch commit)
                      POST /v22/execution/changed-paths {transfer:"chunked_v1"}   (경로 commit)
       └─ GET readback 확인 → sidecar confirm_* → 사용량 기록 → 검토 기록·settle (changed_paths_digest)
```

그대로인 원칙: 결과는 앱이 기록했다고 readback으로 확인한 뒤에만 sidecar에서 지운다. commit은 한 번 보내고,
답을 잃으면 GET readback으로 판정한다. 조각은 멱등이라 다시 보내도 된다.

### 1.2 공통 상수: `lib/amux/v22TransferCore.ts`

순수 TS(`--experimental-strip-types`로 읽힘). 값과 함수는 그 파일이 정본이다. Rust `tomverse_api.rs`는 같은 값의
`V22_TRANSFER_CHUNK_BYTES`, `V22_TRANSFER_BODY_MAX_BYTES`, `V22_EMPTY_SHA256`, `fn v22_size_allowance(bytes: u64) -> Duration`을
두고, `tests/amuxV22PatchLimit.test.mjs`가 두 쪽 값이 같은지 고정한다.

### 1.3 sidecar의 저장

- pending 파일(0600, 원자적 rename): `<attempt>.result.pending`, `<attempt>.patch.pending`, 새 `<attempt>.changed_paths.pending`
  (`encodeAmuxV22ChangedPaths` 형식). 경로가 0개면 파일을 만들지 않는다.
- terminal(`<attempt>.result`)에 새로 쓰는 필드: `resultBytes`, `patchBytes`, `changedPathsSha256`, `changedPathsBytes`,
  `changedPathsCount`, `readRoleChangedPathCount`. `changedPaths`·`readRoleChangedPaths` 배열은 terminal에 쓰지 않는다
  (목록은 보고 본문에 남는다). 목록이 없으면 `changedPathsReason`은 그대로. 빈 목록이면
  `changedPathsSha256 = AMUX_V22_EMPTY_SHA256`, bytes 0, count 0.
- 옛 sidecar가 남긴 terminal도 읽는다. bytes 필드가 없으면 pending 파일 크기(stat)를 쓴다. inline `changedPaths` 배열이
  있으면 처음 `readback_v2` 때 `changed_paths.pending`을 한 번 만든다. terminal 자체는 고치지 않는다.

### 1.4 sidecar op (unix socket, JSON 한 줄, 키 집합은 정확히 이것만)

| op | 요청 | 답 |
|---|---|---|
| `readback_v2` | `{"op":"readback_v2","attemptId"}` | `readback`과 같은 `kind`(`in_progress`·`not_found`·`outcome_unknown`·`succeeded`·`failed`)와 terminal 필드. `resultText`·`patchBody`·`publishFiles`·`changedPaths`는 싣지 않는다. terminal이면 `parts`: `{"result":{"bytes","sha256","pending"},"patch":{"bytes","sha256","baseSha","pending"},"changed_paths":{"bytes","sha256","count","pending"}}`(terminal이 이름 지은 part만). `pending`은 그 bytes의 pending 파일이 있다는 뜻. stat만 하고 본문을 읽거나 hash하지 않는다 |
| `read_pending` | `{"op":"read_pending","attemptId","part","index"}` | `{"kind":"pending_chunk","attemptId","part","index","totalBytes","bytesBase64"}`, 범위는 `amuxV22TransferChunkRange`. 파일이 없으면 `{"kind":"not_found","attemptId"}`, index 범위 밖·키 오류는 `{"kind":"refused"}`. `O_RDONLY\|O_NOFOLLOW` |
| `confirm_changed_paths` | `{"op":"confirm_changed_paths","attemptId","sha256"}` | terminal `changedPathsSha256`과 같으면 pending을 지우고 `{"kind":"confirmed","attemptId"}`, 다르면 `{"kind":"outcome_unknown","attemptId"}` |
| `confirm_result`, `confirm_patch` | 지금과 같음 | terminal digest만 비교(pending 본문을 읽지 않음) |
| `readback`(옛 bridge용) | 지금과 같음 | 옛 한계 안의 part만 inline(결과 ≤ 32 MiB, patch ≤ 4 MiB, 경로 JSON ≤ 4 MiB). 넘는 part는 본문 없이 digest만 |

옛 sidecar는 새 op에 `{"kind":"refused"}`로 답한다. bridge는 이것을 "새 op를 모른다"로 읽는다.

### 1.5 bridge의 흐름

1. pending entry마다 `readback_v2`. `refused`면 그 entry는 옛 경로(`readback` inline, 기존 result POST, `changed_paths` 배열)를
   지금 코드 그대로 쓴다. terminal에 `publishFilesDigest`가 있는 결과(2026-11-15 이전 sidecar)도 옛 경로.
2. 사용량·영수증 검증은 지금과 같다. 그 뒤 part별 전송 방식:
   - result·patch: `result.pending`이고 (patch가 없거나 `patch.pending`)이면 **Upload**. 하나라도 `pending:false`면
     **ReadBack**(지금의 `V22ResultTransfer::ReadBack`). result part가 없으면 **Reject**.
   - changed_paths: count 0이면 업로드·commit 없이 빈 digest로 settle. `pending`이면 Upload. `pending:false`면 GET
     changed-paths readback으로 같은 digest가 기록됐는지 보고, 없으면 경로 없이 settle(`changedPathsReason`과 같은 처리).
3. Upload: 처음엔 index 0..n-1을 `read_pending` → POST `/upload` 후 commit. 재시작 뒤나 답을 모를 때는 commit을 먼저
   보내 `upload_incomplete.missing`에 나온 index만 보낸다. 조각 POST의 답을 잃으면 같은 조각을 다시 보낸다.
4. commit은 한 번 보내고 답을 잃으면 GET으로 판정(지금의 `v22_task_result_record_once` 규칙). 경로 commit도 같다.
5. readback이 Recorded면 `confirm_result`·`confirm_patch`·`confirm_changed_paths`. 사용량 기록·v52 검토 기록·settle은
   지금 순서 그대로이고, 경로는 `changed_paths_digest`·`changed_paths_count`로 보낸다.
6. **heartbeat를 막지 않는다.** 전송과 commit은 attempt마다 별도 tokio task로 돌리고 주 loop는 끝났는지만 본다. 한 tick이
   heartbeat를 60초 넘게 막으면 안 된다(실행 lease 180초).
7. `exceeds_storage`: 결과 본문이면 Reject(미검증 정산, 본문은 box pending에 남김). patch면 patch 없이 결과만 commit하고
   `confirm_patch`는 보내지 않는다. 경로면 경로 없이 settle.
8. optimizer 후보 경로(`TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_CANDIDATE_BRIDGE=enabled`)는 결과 본문을 `read_pending`으로 읽는다
   (64 KiB 계약 그대로).
9. 앱 `/upload`가 404(옛 앱)면 정산하지 않고 결과를 지우지 않은 채 기다린다(warn 한 줄, halt 없음).

### 1.6 앱 route

공통: `isAmuxSyncAuthorized`, `amuxJsonNoStore`, strict schema. binding 검사는 지금 result route와 같다(attempt 있음, worker
같음, `endedAt` null, `v22AssignmentId` 있음, Task `admin-idea-v4`·`doing`·owner=worker·assignment 같음).

**① `POST /api/internal/amux/v22/execution/upload`** (조각 하나, body ≤ `AMUX_V22_TRANSFER_BODY_MAX_BYTES`)

```json
{ "attemptId": "<uuid>", "worker": "<worker>",
  "part": "result" | "patch" | "changed_paths",
  "totalBytes": 1, "sha256": "<hex64 전체>",
  "baseSha": "<hex40>",
  "count": 1,
  "index": 0, "chunkSha256": "<hex64 이 조각>", "bytesBase64": "<정규 base64>" }
```

`baseSha`는 part=patch에서만, 그때 필수. `count`는 part=changed_paths에서만, 그때 필수(≥1).

- 200 `{"attemptId","part","index","duplicate":bool,"received":int,"chunkCount":int}`
- 400 `{"error":"Invalid request."}`: schema 위반, 정규 base64 아님, `chunkSha256` 불일치, index ≥ chunkCount, 길이가 그 index 범위와 다름
- 409 `binding_mismatch`(Reject), `upload_conflict`(같은 attempt·part에 다른 totalBytes·sha256·baseSha·count; Reject),
  `chunk_conflict`(같은 index에 다른 내용; Reject), `already_recorded`(최종 행 있음; commit·readback으로),
  `exceeds_storage`(`totalBytes > AMUX_V22_STORAGE_MAX_BYTES`)
- 503 `outcome_unknown`(다음 tick에 다시)

**② `POST /api/internal/amux/v22/execution/result`**: `transfer` 키가 있으면 조각 commit 변형, `resultText`가 있으면 옛 변형
(body ≤ `AMUX_V22_PROXY_BODY_MAX_BYTES`).

```json
{ "attemptId", "worker", "transfer": "chunked_v1",
  "sourceSha256": "<hex64>", "resultBytes": 1,
  "patch": { "sha256": "<hex64>", "baseSha": "<hex40>", "bytes": 1 } }
```

- 200은 옛것과 같은 모양 `{"attemptId","sourceSha256","patchSha256","filesDigest":null,"patchRejected","duplicate"}`
- 409 `{"error":"upload_incomplete","missing":{"result":[i…],"patch":[i…]}}`(덜 온 part만; 거절이 아니다),
  `{"error":"upload_digest_mismatch","part"}`(앱이 그 part staging을 지움; bridge는 한 번 다시 올리고 또 같으면 Reject),
  `exceeds_processing`(V8 문자열 불가; Reject). 기존 `result_conflict`·`result_expired`·`binding_mismatch`, 400, 503 그대로
- 중복 commit: `sourceSha256`가 같고 patch의 `sha256`·`baseSha`·`bytes`가 `AmuxV22TaskPatch`의 `patchSha256`·`baseSha`·`byteLength`와
  같으면 `duplicate:true`. 기록된 patch가 없는데 body에 patch가 있으면 `patchRejected:true, patchSha256:null`
- patch가 비밀·형식 검사에 걸리거나 문자열로 만들 수 없으면 지금처럼 결과만 기록하고 `patchRejected:true`

**③ `GET /api/internal/amux/v22/execution/result?attemptId=`**: 지금 답에 `resultBytes`와 `patch.bytes`를 더한다. `filesDigest`는
옛 JSON 증거일 수 있는 행(`byteLength ≤ AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES`)에서만 본문을 열어 계산하고, 나머지는 null.

**④ `POST /api/internal/amux/v22/execution/changed-paths`**

```json
{ "attemptId", "worker", "transfer": "chunked_v1", "sha256": "<hex64>", "count": 1, "bytes": 1 }
```

- 200 `{"attemptId","sha256","count","duplicate"}`
- 409 `binding_mismatch`, `upload_incomplete {missing:{changed_paths:[…]}}`, `upload_digest_mismatch {part:"changed_paths"}`,
  `paths_conflict`, `paths_invalid`; 503
- `GET ?attemptId=`: `{"status":"recorded","attemptId","sha256","count","bytes","bodyAvailable"}` | `{"status":"absent"}` | 503

**⑤ settle과 v52 검토 기록**(`settle/route.ts`, `v22/review/record/route.ts`): 선택 필드 `changed_paths_digest`(hex64)·
`changed_paths_count`(int ≥ 0), 둘 다 있거나 없음, `changed_paths`와 함께면 400. digest가 `AMUX_V22_EMPTY_SHA256`이고
count 0이면 `[]`로 읽는다(검토 기록은 지금처럼 `min(1)`이라 빈 목록이면 400). 그 밖에는 route가 DB boundary 밖에서
`AmuxV22TaskChangedPaths`를 열어 sha256·count를 확인하고 배열로 바꿔 지금 함수에 넘긴다. 기록이 없거나 digest가 다르면
409 `{"settled":false,"reason":"changed_paths_unrecorded"}`(검토 기록은 `{"recorded":false,...}`). bridge는 미검증 정산으로
가지 않고 경로를 다시 commit한 뒤 다음 tick에 다시 보낸다. 옛 `changed_paths` 배열도 받는다(body ≤ proxy 값).

### 1.7 결과를 모를 때

| 상황 | bridge | 근거 |
|---|---|---|
| 조각 POST 답을 잃음/503 | 같은 조각 다시 | 같은 index·digest면 `duplicate` |
| commit 답을 잃음 | GET `/result`(또는 `/changed-paths`) | 지금 원칙 |
| bridge 재시작 | `readback_v2` → commit 먼저 → `missing` | 앱 staging이 정본 |
| `already_recorded` | commit → readback | 최종 행 |
| `upload_incomplete` | 빠진 index만 | 거절 아님 |
| sidecar confirm 실패 | 다음 tick에 다시 | 지금과 같음 |

## 2. 저장

### 2.1 staging 테이블

```prisma
model AmuxV22TransferPart {
  attemptId  String
  part       String      // result | patch | changed_paths
  taskId     String
  ideaId     String
  worker     String
  totalBytes Int
  sha256     String
  baseSha    String?     // patch에만
  pathCount  Int?        // changed_paths에만
  createdAt  DateTime @default(now())
  chunks     AmuxV22TransferChunk[]
  attempt    AmuxExecutionAttempt @relation(fields: [attemptId, taskId], references: [id, taskId], onDelete: Restrict, onUpdate: Restrict)
  @@id([attemptId, part])
  @@index([createdAt])
}
model AmuxV22TransferChunk {
  attemptId   String
  part        String
  index       Int
  byteLength  Int
  ciphertext  Bytes
  keyId       String
  keyVersion  Int
  digest      String      // 조각 평문의 HMAC(그 part의 digest key)
  digestKeyId String
  createdAt   DateTime @default(now())
  transfer    AmuxV22TransferPart @relation(fields: [attemptId, part], references: [attemptId, part], onDelete: Cascade, onUpdate: Restrict)
  @@id([attemptId, part, index])
}
```

- 조각도 평문으로 두지 않는다. 그 part의 최종 unit key로 봉인한다: result `task_result`, patch `task_patch`, 경로 새
  `task_changed_paths`, subject는 attemptId.
- key는 첫 조각 때 create-or-load(`createAmuxContentUnitKeys`가 412 `conflict`면 `loadAmuxContentUnitKeys`). 옛 inline
  commit도 같은 helper로 바꾼다.
- 조각 순서 바꾸기·바꿔치기는 commit 때 전체 sha256과 전체 HMAC으로 잡는다. 중복 판정은 조각 HMAC으로 한다.

### 2.2 조립과 기록

1. commit route는 binding을 검사하고 part 행과 body 설명(`sourceSha256`·`resultBytes`·patch)이 같은지, 조각이 다 있는지
   본다. 없으면 `upload_incomplete`.
2. **transaction 밖에서**: key load, 조각 열기, 조각 HMAC 확인, `Buffer.allocUnsafe(totalBytes)`에 붙이기, 전체 sha256 확인,
   텍스트 검사(`v22TaskResultSha256`, `normalizeV22OptionalPatch`/`encodeV22PatchEvidence`, `parseAmuxV22Conclusion`,
   `parseAmuxV22OwnerQuestion`), `sealAmuxContent`.
3. `recordAmuxV22TaskResult`를 순수 `prepareAmuxV22TaskResultRecord(input)`(봉인·파싱)와 `recordAmuxV22TaskResult(tx, prepared)`
   (잠금·검사·INSERT·감사)로 나눈다. 옛 inline route도 같은 두 함수를 쓴다.
4. transaction은 지금 잠금 순서(attempt → 감사 chain → Task)로 INSERT하고, commit된 part의 staging 행을 같은 transaction에서
   지운다(cascade).

### 2.3 바뀐 경로 목록

```prisma
model AmuxV22TaskChangedPaths {
  attemptId    String   @id
  taskId       String
  ideaId       String
  ciphertext   Bytes?
  keyId        String?
  keyVersion   Int?
  digest       String
  digestKeyId  String
  pathsSha256  String    // encodeAmuxV22ChangedPaths 바이트의 sha256
  pathCount    Int
  byteLength   Int
  createdAt    DateTime @default(now())
  bodyPurgedAt DateTime?
  attempt AmuxExecutionAttempt @relation(fields: [attemptId, taskId], references: [id, taskId], onDelete: Restrict, onUpdate: Restrict)
  task    AmuxWorkItem         @relation(fields: [taskId], references: [id], onDelete: Restrict, onUpdate: Restrict)
  idea    AmuxIdeaSubmission   @relation(fields: [ideaId], references: [id], onDelete: Restrict, onUpdate: Restrict)
  @@unique([attemptId, taskId])
  @@index([ideaId, bodyPurgedAt])
}
```

결과가 없는 실패에도 경로는 정산에 필요하므로 결과와 따로 commit한다.

### 2.4 암호화와 digest

- `lib/amux/ideaCrypto.ts`의 `AmuxContentPurpose`·`PURPOSES`에 `task_changed_paths`를 더한다. `contentSizeAccepted`는
  `idea_raw`, `repository_read_manifest`, `task_result`, `task_patch`, `task_changed_paths`의 크기를 보지 않는다.
- 봉인 형식, HMAC digest, key store, purge 기록, key 은퇴(`ideaContentKeyRetirementService`)는 그대로 쓰고 새 purpose·테이블만 등록한다.

### 2.5 migration `20261118120000_amux_v22_result_transfer`

- `AmuxV22TaskPatch_digest_check`, `AmuxV22TaskResult_digest_check`를 상한 없이(`"byteLength" >= 1`) 다시 만든다. 나머지 절은 그대로.
- 새 테이블 셋과 CHECK:
  - `AmuxV22TransferPart_check`: part 값, `totalBytes >= 1`, sha256 hex64, `(part='patch') = (baseSha IS NOT NULL)`, baseSha hex40,
    `(part='changed_paths') = (pathCount IS NOT NULL)`, `pathCount >= 1`
  - `AmuxV22TransferChunk_check`: `index >= 0`, `byteLength BETWEEN 1 AND 4194304`(요청 하나에 들어가는 조각 크기이고 내용 상한이 아니다), digest·digestKeyId 형식
  - `AmuxV22TaskChangedPaths_digest_check`: digest·pathsSha256 hex64, `pathCount >= 1`, `byteLength >= 1`, `AmuxV22TaskResult`와 같은 purge 일관성 절
- `ALTER TABLE "AmuxV22TransferChunk" ALTER COLUMN "ciphertext" SET STORAGE EXTERNAL;`
- CHECK 교체마다 기존 규칙대로 `baseline-check.json`을 둔다. 상한을 다시 넣는 것은 그 값을 넘는 행이 없을 때만 가능하다.

### 2.6 보관과 정리

- staging은 `app/api/internal/amux/v4/content-retention/route.ts`가 부르는 정리에 `sweepAmuxV22TransferStaging`을 더해 지운다:
  최종 행이 있음, attempt `endedAt`이 1시간 넘게 지남, `createdAt` 7일 넘게 지남 중 하나. 그 purpose에 최종 행이 없으면
  `recordAmuxContentBodyPurge`로 unit key 은퇴를 맡긴다.
- `AmuxV22TaskChangedPaths`는 결과와 같은 90일 규칙으로 본문을 지운다.
- `lib/accountDataExportDomains.ts`에 `amuxTaskChangedPaths`를 더한다. staging은 export 대상이 아니다.

### 2.7 큰 bytea 읽기(3-B)

node-pg/Prisma가 bytea를 hex 문자열로 읽어 값의 2배 문자열이 된다. 먼저 실측하고, 큰 값을 64 MiB씩 `substring`으로 읽는
helper를 만들어 `ciphertext`를 직접 select하는 독자들을 바꾼다. V8 문자열과 앱 메모리는 외부 한계로 받아들인다.

## 3. 하위 호환

| 앱 | bridge | sidecar | publisher | 결과 |
|---|---|---|---|---|
| 새 | 옛 | 옛 | 옛 | 지금과 같다(inline 결과, 배열 settle). CHECK를 풀어도 옛 쓰기는 깨지지 않는다 |
| 새 | 새 | 옛 | - | `readback_v2`가 `refused`면 그 entry는 옛 경로 |
| 새 | 옛 | 새 | - | 지원하지 않는다(box는 둘을 함께 설치). 생기면 옛 `readback`이 옛 한계 안의 본문만 싣고, 큰 결과는 미검증 정산이 되며 box pending에 남는다 |
| 옛 | 새 | 새 | - | 앱 롤백 때만. `/upload` 404면 bridge는 정산하지 않고 기다린다. **운영 규칙: 앱을 이 변경 이전으로 되돌릴 때는 box도 함께 되돌린다** |
| 옛 | - | - | 새 | claim에 `appFeatures`가 없으면 publisher는 inline patch를 쓴다 |

## 4. 게시

- `EngineeringAgentWorkItem`에 `"patchBytes" BYTEA`(`SET STORAGE EXTERNAL`)를 더하고 publish 항목을 열 때
  `Buffer.from(patchBody, "utf8")`로 한 번 쓴다. `patchBody`는 다른 독자를 위해 남긴다.
  - CHECK `EngineeringAgentWorkItem_patchBytes_check`: `"patchBytes" IS NULL OR ("patchBody" IS NOT NULL AND octet_length("patchBytes") = octet_length("patchBody"))`
  - 상한만 있던 `EngineeringAgentWorkItem_patchBody_check`는 지운다.
  - guard trigger 함수(`20261116010300_engineering_agent_work_item_guard_uncapped`)를 바꿔 `patchBytes`도 바꿀 수 없게 한다.
  - migration `20261118120100_engineering_agent_patch_bytes`. 보호 테이블 migration이므로 `scripts/check-protected-table-writers-core.mjs`에 등록한다.
- 기능 협상: header `x-engineering-publisher-features`에 `patch_chunks`, claim 답 최상위에 `"appFeatures":["patch_chunks"]`(옛 publisher는 무시).
- claim: `patch_chunks`를 밝힌 publisher의 write claim은 `patchBody`를 빼고 `patchBytes`·`patchChunkCount`를 싣는다(`patchDigest` 그대로).
  밝히지 않은 publisher에게는 patch가 `AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES`를 넘는 항목을 주지 않는다.
- 조각 읽기 `POST /api/internal/engineering-agent/publish/patch`: 요청 `{"workItemId","fencingToken":"<10진 문자열>","index"}`(body ≤ 1 KiB,
  읽기라 idempotency ledger 없음). 200 `{"workItemId","index","totalBytes","chunkCount","bytesBase64"}`(`substring("patchBytes" FROM i*C+1 FOR C)`,
  `patchBytes`가 null인 옛 항목은 `patchBody`를 잘라 줌). 409 `{"refused":"claim_not_live"}`(state `claimed`·claimMode `write`·같은 fencingToken·lease 남음일 때만 읽음). 400, 401.
- publisher: `work.patchBody`가 문자열이면 그대로, 아니면 조각을 순서대로 받아 붙이고 길이와 `sha256 == patchDigest`를 확인한 뒤
  UTF-8(fatal)로 푼다. 그 뒤의 비밀 검사·적용·tree 확인은 그대로.
- `ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES`와 `patch_too_large`를 없앤다. `run/draft` route body 상한은 proxy 값으로.
- publisher가 새 lib 파일을 import하면 Dockerfile COPY, workflow `paths`, `tests/engineeringAgentServices.test.mjs`를 함께 고친다.

## 5. 승인 digest v2 (운영자 결정 대기)

diff가 1 MiB를 넘거나 binary가 있으면 지금은 승인에 묶을 수 없어 사람에게 넘어간다. 권장안은 승인을 diff 본문 대신
`merge base`·`head commit`·`head tree`에 묶는 것이다.

```
pullChangeDigest({ mergeBaseSha, headSha, headTreeSha }) =
  sha256_hex("amux-pull-change-v2\n" + "merge-base " + mergeBaseSha + "\n" +
             "head " + headSha + "\n" + "tree " + headTreeSha + "\n")
```

- 같은 것: 승인은 검증된 head commit 하나에 묶이고, base는 develop, 승인자 목록과 snapshot 뒤 review 조건은 그대로다. merge base를
  넣었으므로 develop이 움직여 같은 head의 diff가 바뀌는 경우도 잡는다. lane의 merge는 `sha`로 head를 고정한다.
- 달라지는 것: hash가 diff 바이트 SHA-256에서 git 객체 id(SHA-1, GitHub의 sha1dc)로 바뀐다. 사람이 본 렌더링 diff 대신 tree
  내용 전체(binary 포함)를 묶는다. 크기·binary 때문에 사람에게 넘기던 경로가 없어져, 큰 diff는 사람이 UI에서 다 보지 못한 채
  승인될 수 있다.
- 비교는 dual: 저장된 digest가 v1이면 v1으로, v2면 v2로 비교한다. 새 binding은 모두 v2.
- 소비자: 게시 snapshot, 승인 관측, DM develop 병합, QA-release merge lane, 합쳐진 PR 관측, AMUX review.

## 6. 시간 상한

모든 비례 시간은 `amuxV22SizeAllowanceMs`(4 MiB당 1초)로만 늘린다(TS·Rust parity test).

| 곳 | 지금 | 바뀐 뒤 |
|---|---|---|
| sidecar 요청 수신 5 s, bridge sidecar 호출 5 s | 고정 | 그대로(요청이 작고 조각 크기 고정, `readback_v2`·confirm은 hash 안 함) |
| 조각 POST | - | 15 s + allowance(body) |
| 결과 commit POST | 15 s + patch 512 KiB당 1 s | 15 s + allowance(resultBytes + patchBytes). 옛 공식은 옛 경로에만 |
| 경로 commit POST | - | 15 s + allowance(bytes) |
| GET readback | 15 s | 15 s(큰 본문을 열지 않음) |
| settle(bridge 27 s, 앱 24 s) | 고정 | bridge 27 s + allowance(patch + paths), 앱은 두 행의 `byteLength`를 먼저 읽고 24 s + 같은 allowance |
| v52 검토 기록 | 27 s | 27 s + allowance(patch + paths) |
| 앱 결과 transaction(10 s, statement 5 s) | 고정 | timeout 10 s + allowance, statement 5 s + allowance(INSERT 바이트) |
| 실행 lease 180 s | - | 그대로. 전송이 heartbeat를 막지 않는다 |

## 7. 영역 사이의 소유

| 파일 | 소유 영역 |
|---|---|
| `lib/amux/v22TransferCore.ts`, `lib/amux/v22PatchLimit.ts`, `lib/amux/ideaCrypto.ts`, `prisma/schema.prisma`의 AMUX 모델, `prisma/migrations/20261118120000_*` | 앱(영역 3) |
| `lib/amux/v22OneShotSidecar.mjs`, `lib/amux/v22PatchCapture.mjs` | sidecar(영역 1) |
| `apps/tomverse-orchestrator/**` | bridge(영역 2) |
| `lib/engineeringAgentCore.ts`, `lib/engineeringAgentStore.ts`, `EngineeringAgentWorkItem`, `prisma/migrations/20261118120100_*`, publisher | 게시(영역 4) |
| `lib/pullDiffDigestCore.ts`와 승인 소비자 | 승인(영역 5) |

## 8. 배포 순서

1. 앱(Railway)과 migration 두 개.
2. box(bridge 바이너리 + sidecar bundle)를 함께 설치. 앱보다 먼저 설치하면 "옛 앱 + 새 bridge"(정산 보류)가 된다. 설치는 sidecar가
   쉬고 state 디렉터리에 `*.pending`이 없을 때. 설치 뒤 경로 0개·조각 1개·조각 2개 이상 실행 하나씩으로 확인한다.
3. publisher 이미지(ghcr, main push에서 빌드)와 Railway publisher 재배포. 앞 단계 없이 배포해도 claim에 `appFeatures`가 없으면 옛 동작이다.

## 9. 범위 밖

- 내려가는 방향: 재개 때 이전 patch를 context로 보내는 묶음 32 MiB(`AMUX_V22_TRANSPORT_MAX_BYTES`, `lib/amux/delivery.ts`),
  DM workspace 증거 64 MiB. 다음 작업에서 같은 조각 기법으로 다룬다. 그 전까지는 넘으면 기존 생략 안내로 내려보낸다.
- 후보 재구성은 바뀐 파일마다 GitHub blob을 읽으므로 아주 큰 patch는 GitHub API 속도 한도(외부)에 걸릴 수 있다.
