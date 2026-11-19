# AMUX v22 실행 결과 전송: 조각 전송과 크기 상한 없음 (운영자 결정 2026-11-18)

운영자 지시(2026-11-18): v22 card 실행 결과에 걸린 크기 상한 가운데 우리가 만든 것은 없애고, 외부 시스템의
한계만 남긴다. 대상은 patch 4 MiB, 한 번의 전송 32 MiB, 그보다 먼저 걸리는 Next.js proxy 10 MiB 요청 본문,
PR diff digest 1 MiB다. 이 문서와 `development-agent-orchestration.md`의 "크기 상한 없음"·"결과 patch의 상한은
하나다" 항목이 다르면 이 문서가 맞다. 승인 digest는 v2로 바꾼다(5절, 운영자 결정 2026-11-18).

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
| publisher·`lib/pullDiffDigestCore.ts`·`lib/engineeringAgentGitHubRead.ts`·`lib/amux/reviewGitHub.ts`·`lib/qaReleaseMergeLaneGithub.ts` | diff 1 MiB, binary 거절, `diff_not_bindable` | 승인 binding v2(5절). 1 MiB는 v1 기록 비교와 review 화면 표시에만 남음 |

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
| Prisma 7의 Bytes 쓰기(base64 문자열 하나, 2.7절 실측: 300 MiB 됨, 420 MiB 거절) | V8 문자열 한도의 base64인 402,653,166바이트(약 384 MiB, `AMUX_V22_PRISMA_BYTES_WRITE_MAX_BYTES`) | 결과·patch·경로 행 INSERT. 봉인한 값이 넘으면 transaction 전에 결과는 409 `exceeds_processing`, patch는 `patchRejected`, 경로는 409 `paths_invalid` |
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
- `AmuxIdeaContentKeyRetirement_purpose_check`에 `task_changed_paths`를 더한다.
- 새 테이블 셋과 CHECK:
  - `AmuxV22TransferPart_part_check`: part 값(`check:enum-constraints`가 `AMUX_V22_TRANSFER_PARTS`와 대조하도록 따로 둔다)
  - `AmuxV22TransferPart_check`: `totalBytes >= 1`, sha256 hex64, `(part='patch') = (baseSha IS NOT NULL)`, baseSha hex40,
    `(part='changed_paths') = (pathCount IS NOT NULL)`, `pathCount >= 1`
  - `AmuxV22TransferChunk_check`: `index >= 0`, `byteLength BETWEEN 1 AND 4194304`(요청 하나에 들어가는 조각 크기이고 내용 상한이 아니다), keyId·keyVersion, digest·digestKeyId 형식
  - `AmuxV22TaskChangedPaths_body_check`: `AmuxV22TaskResult`와 같은 purge 일관성 절
  - `AmuxV22TaskChangedPaths_digest_check`: digest·pathsSha256 hex64, digestKeyId 형식, `pathCount >= 1`, `byteLength >= 2 * pathCount`(경로마다 1바이트 이상과 NUL)
- `ALTER TABLE "AmuxV22TransferChunk" ALTER COLUMN "ciphertext" SET STORAGE EXTERNAL;`
- trigger: staging 두 테이블은 UPDATE를 받지 않는다(쓰고 지울 뿐). `AmuxV22TaskChangedPaths`는 `AmuxV22TaskResult`처럼 purge 한 번 외에는 바뀌지 않는다.
- 이 migration은 새 테이블을 만들어 `prisma migrate diff`에 보이므로 `baseline-check.json`을 두지 않는다. sidecar는 CHECK 교체만 있는 migration의 증명이고, 그 문법 밖의 SQL 옆에 두면 guard가 migration 전체를 선언 없음으로 읽는다(`tests/migrationBaseline.test.mjs`). 상한을 다시 넣는 것은 그 값을 넘는 행이 없을 때만 가능하다.

### 2.6 보관과 정리

- staging은 `app/api/internal/amux/v4/content-retention/route.ts`가 부르는 정리에 `sweepAmuxV22TransferStaging`을 더해 지운다:
  최종 행이 있음, attempt `endedAt`이 1시간 넘게 지남, `createdAt` 7일 넘게 지남 중 하나. 그 purpose에 최종 행이 없으면
  `recordAmuxContentBodyPurge`로 unit key 은퇴를 맡긴다. 이 정리는 content retention 자체의 스위치로 돈다: 지우는 것은 box가
  확인 전까지 원본을 갖고 있는 봉인된 사본뿐이고 기록된 결과가 아니다. v22 결과 purge는 2026-11-18에 코드째 없어졌으므로 맡긴 key는
  은퇴 대기로 남는다. 정리 결과는 retention 답에 싣지 않는다(설치된 box trigger가 답의 필드 7개를 정확히 검사한다).
  commit이 쓰지 않은 part(역할 때문에 남기지 않은 patch 등)도 이 정리가 지운다.
- `AmuxV22TaskChangedPaths`는 결과와 같이 본문을 지우지 않는다(v22 결과 purge가 없다).
- `lib/accountDataExportDomains.ts`에 `amuxTaskChangedPaths`를 더한다. staging은 export 대상이 아니다.

### 2.7 큰 bytea 읽기(3-B)

node-pg/Prisma가 bytea를 hex 문자열로 읽어 값의 2배 문자열이 된다. 먼저 실측하고, 큰 값을 64 MiB씩 `substring`으로 읽는
helper를 만들어 `ciphertext`를 직접 select하는 독자들을 바꾼다. V8 문자열과 앱 메모리는 외부 한계로 받아들인다.

실측(2026-11-18, 로컬 PostgreSQL 17, node-pg 8.23, Prisma 7.10 adapter-pg, 임의 바이트 1 MiB~600 MiB):

| 경로 | 255 MiB | 257·300 MiB | 420 MiB | 600 MiB |
|---|---|---|---|---|
| node-pg 읽기(`SELECT b`) | 됨 | pg-protocol이 행을 문자열로 만들다 `ERR_STRING_TOO_LONG`. 거절된 query가 아니라 socket handler의 잡히지 않은 예외라 **프로세스가 끝난다** | 같음 | 서버가 hex 출력을 못 만듦(`invalid memory alloc request size`, 거절) |
| Prisma 읽기(`$queryRaw`; `findUnique` select는 255 MiB까지만 확인) | 됨 | `$queryRaw` 257 MiB에서 같은 프로세스 종료 | - | - |
| Prisma `create`(select 없음) | 됨 | 쓴 행을 되돌려 읽다 같은 프로세스 종료 | - | - |
| Prisma `create`+`select: {attemptId}`, `createMany` | 됨 | 됨(둘 다 300 MiB) | `createMany`가 `ERR_STRING_TOO_LONG`(거절된 promise, 프로세스는 산다) | - |
| node-pg 쓰기(Buffer 이진 parameter) | 됨 | 됨 | 됨 | 됨 |
| 64 MiB `substring` 조각 읽기 | 됨 | 됨 | 됨 | 됨 |

그래서 큰 본문은 `lib/amux/sealedByteaRead.ts`로 읽고, 큰 행의 `create`는 본문 없는 `select`를 쓰며, 봉인한 값이
`AMUX_V22_PRISMA_BYTES_WRITE_MAX_BYTES`를 넘으면 transaction 전에 결정적으로 답한다. 시간은 이 PC의 느린 디스크에 묶인
값이라 적지 않는다.

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

## 5. 승인 digest v2 (운영자 결정 2026-11-18: v2로 바꾼다)

diff가 1 MiB를 넘거나 binary가 있으면 지금은 승인에 묶을 수 없어 사람에게 넘어간다. 운영자가 v2를 골랐다("v2로 바꾸기"):
승인을 diff 본문 대신 `merge base`·`head commit`·`head tree`에 묶는다. 새 승인은 모두 v2이고, 기존 v1 기록은 비교에만 쓴다.

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
- 구현: `lib/pullDiffDigestCore.ts`(`pullChangeDigest`, `pullDigestHolds`, `readPullChangeDigest`). 저장 형식은 `v2:` + 위
  hex(67자), v1은 접두사 없는 64 hex 그대로. merge base는 compare API(`{base}...{head}`)의 `merge_base_commit`, tree는
  `git/commits/{head}`에서 읽는다. 열린 PR의 base는 PR의 base branch, 합쳐진 PR은 merge commit의 첫 부모. v1 diff는 v1 기록을
  비교할 때만 읽는다. publisher는 claim 답 `appFeatures`에 `change_digest_v2`가 있을 때만 v2로 묶는다(없으면 옛 앱이므로 v1).
  DB CHECK 세 개(binding snapshot, DM 승인, AMUX review 제안)는 migration `20261118120200_pull_change_digest_v2`가 두 형식을 받게 한다.

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

- 내려가는 방향(재개 때 이전 patch 32 MiB, DM workspace 증거 64 MiB)은 10절에서 같은 조각 기법으로 없앴다(2026-11-19).
- 후보 재구성은 바뀐 파일마다 GitHub blob을 읽으므로 아주 큰 patch는 GitHub API 속도 한도(외부)에 걸릴 수 있다.

## 10. 내려가는 방향의 조각 전송 (2026-11-19)

9절에 남겼던 내려가는 방향을 1절과 같은 조각(`AMUX_V22_TRANSFER_CHUNK_BYTES`, `amuxV22TransferChunkRange`)으로 보낸다.
새 테이블과 migration은 없다. 조각을 줄 때마다 앱이 원본 행에서 같은 내용을 다시 만들고, 받는 쪽은 전체 sha256으로 확인한다.

### 10.1 재개 context(card 실행)

크기에 상한이 없는 context 파일은 둘이다. 나머지(brief, 운영자 답, 검토 지적)는 출처에서 크기가 정해진다.

| 파일 | 원본 | 다시 만드는 방법 |
|---|---|---|
| `prior.patch` | 질문한 run의 `AmuxV22TaskPatch` | `readAmuxV22ResumeRows`(DB boundary 안) → `openAmuxV22ResumeContext`의 `previousPatch` |
| `prior-conclusions.md` | 앞선 Task들의 결론 | `readAmuxV22PriorConclusionRows` → `openAmuxV22PriorConclusions` → `buildAmuxV22PriorConclusionSection({budgetBytes:null}).section` |

- **기능 협상:** bridge는 `POST /api/internal/amux/delivery/pull`에 header `x-amux-bridge-features: context_chunks`를 붙인다. 옛 앱은 header를 무시한다.
- **pull 답:** header가 있고 local CLI flow 전달이면(checkout 있음, read-only retry 아님) 위 두 파일을 prompt의 context 묶음에 넣지 않는다. prompt의 안내 목록(`amuxV22ContextPromptSection`)에는 그대로 둔다. delivery에 `context_parts: [{"name","bytes","sha256"}]`를 더한다(비어 있으면 키 없음). bytes는 UTF-8 바이트 수, sha256은 그 바이트의 hex다. header가 없으면 지금처럼 inline이다.
- **조각 route `POST /api/internal/amux/v22/execution/context`:** 요청은 `{"attemptId","worker","name","index"}`(strict, body ≤ 1 KiB)이고, binding 검사는 upload route와 같다.
  - 200 `{"attemptId","name","index","totalBytes","chunkCount","sha256","bytesBase64"}`
  - 404 `{"error":"context_absent"}`: 원본이 없거나 비었음
  - 400: schema 오류, index 범위 밖
  - 409 `binding_mismatch`
  - 503 `outcome_unknown`
  - 다시 만든 내용이 pull 때와 다르면 bridge가 sha256 불일치로 알아채고, 그 전달을 보내지 않는다. 다음 pull이 새로 만든다.
- **sidecar op `put_context`:** `{"op":"put_context","attemptId","name","index","totalBytes","sha256","bytesBase64"}`(키 정확히 이것만).
  - journal 디렉터리의 `<attemptId>.ctx-<name>.part`에 그 범위를 쓴다(0600, `O_NOFOLLOW`, offset = index × 조각 크기). 같은 index를 다시 받으면 같은 자리를 덮어쓴다. 곁의 `<attemptId>.ctx-<name>.part.meta`가 그 part의 `totalBytes`·`sha256`를 기억한다.
  - 앞 조각과 `totalBytes`·`sha256`가 다른 조각이 오면 refused가 아니라 그 파일을 처음부터 다시 시작한다(옛 part·meta를 지우고 새 meta를 쓴 뒤 그 조각을 쓴다). refused로 답하고 옛 part를 그대로 두면 다음 pull도 같은 곳에서 막히기 때문이다. 섞인 내용은 execute의 sha256 확인이 잡는다.
  - 답은 `{"kind":"context_stored","attemptId","name","index"}`. 이름이 허용 목록 밖이거나, 키·범위·base64(정규형만)가 다르거나, attempt가 실행 중이거나 이미 시작·종료됐으면(`<attemptId>.claimed`·`.result` 존재) `{"kind":"refused"}`. 옛 sidecar도 `refused`로 답한다.
  - `*.pending`·`*.result` 이름을 쓰지 않는다. 설치 조건과 readback의 pending·terminal 검사는 정확한 이름으로 찾으므로 `.part`·`.part.meta`는 잡히지 않는다.
- **execute:** 선택 키 `contextParts: [{"name","bytes","sha256"}]`(이름은 한 번씩, 허용 두 이름만, read-only retry와 함께 쓰지 못함)를 받는다. 실행을 시작하기 전에 part 파일이 있고 크기가 같은지 보고(없거나 inline으로도 온 이름이면 `failed`, `cliStarted:false`, `failure:"context_parts_invalid"`), checkout에 둘 때 바이트를 그대로 복사하면서 sha256을 확인해 inline 파일과 같은 자리(`.amux/context/<name>`)에 둔다. 이전 patch 자동 적용은 inline일 때와 같다(implement role). 확인에 실패하면 복사본을 지우고 같은 `context_parts_invalid`로 실행하지 않는다. 옮긴 part·meta는 바로 지우고, attempt가 끝나면 남은 것도 지운다. 시작한 attempt의 것과 retention(30일)을 넘긴 것은 다음 실행 시작 때 지운다.
- **bridge:** `context_parts`가 있으면 execute 전에 part마다 index 0..n-1을 받아 `put_context`로 넘긴다. 다 넘긴 뒤 `contextParts`를 붙여 execute한다.
  - 조각 답을 잃거나 503이면 같은 조각을 다시 요청한다. 횟수 상한은 없고, 1초부터 두 배씩 기다리되 60초에서 멈춘다. `put_context` 교환이 깨져도 같은 조각을 상한 없이 다시 넘기되 앱에는 다시 묻지 않는다.
  - 404·응답의 totalBytes·sha256이 pull과 다름·part 전체 sha256 불일치·`refused`(결정적 거절)이면 그 전달을 보내지 않고 warn 한 줄을 남긴다(halt 없음). attempt는 CLI 시작 전 실패 보고(`code:"context_unavailable"`, `cli_started:false`)를 붙인 unverified로 settle한다. 앱은 이것을 인프라 실패로 읽어 카드 시도로 세지 않고 큐로 돌린다. 다음 pull이 새로 만든다.
  - read-only retry 전달에 `context_parts`가 함께 오면 같은 방식으로 보내지 않는다. `contextParts`는 part가 있을 때만 execute에 넣는다(빈 배열을 보내지 않는다).
  - 전송은 heartbeat를 60초 넘게 막지 않는다: attempt마다 별도 tokio task가 part를 받아 넘기고, 그동안 attempt는 `pending`으로 heartbeat를 받으며 run loop은 끝났는지만 본다. task가 끝나면 loop이 깨어 execute를 한 번 보낸다(그 시각부터 sidecar 응답 대기 15분을 센다). 그 사이 bridge가 halt하면 보내지 않고 unverified로 settle한다.
- **없애는 값:** `parseAmuxV22ContextFiles`의 32 MiB 합계 검사. 큰 파일이 prompt에 실리지 않으므로 prompt 64 MiB 검사는 실제로 걸리지 않는다. 옛 bridge와 옛 sidecar의 경로에서만 쓰인다.

### 10.2 DM workspace 증거

`POST /api/internal/amux/decision-maker/workspace`가 증거 파일 본문을 한 답에 싣던 것(합계 64 MiB, 넘으면 `too_large`로 제외)을 같은 조각으로 바꾼다. 흐름은 앱 → box의 DM relay(`dm_relay/**`) → broker(unix socket)다. 원본은 `openDecisionMakerWorkspaceEvidence(source)`이고 조각을 줄 때마다 다시 열어 같은 파일이 나오는지 sha256으로 확인한다. 새 테이블과 migration은 없다.

바뀌는 점은 둘이다. 증거 파일의 본문은 앱 답에도, broker의 `workspace` 요청에도 실리지 않고(설명만 간다), broker는 조각을 모두 받은 뒤에야 파일을 쓴다.

- **협상(10.1과 다른 점):** header를 쓰지 않는다. DM route를 부르는 relay client(`post_decision_maker`)는 header를 싣지 못하고, route가 있는지가 같은 신호이기 때문이다. relay는 `workspace/parts`를 먼저 묻는다. 옛 앱에는 그 route가 없어 프레임워크의 404(본문에 `found` 키가 없음)가 오고, relay는 그때만 옛 `workspace` route로 간다. 앱 자신의 거절(`{found:false,reason}`, 401, 연결 끊김)은 route 없음이 아니므로 폴백하지 않고 카드를 운영자에게 둔다(`workspace_unreadable`).
- **앱 route ① `POST .../decision-maker/workspace/parts`:** 요청 `{"request_id"}`(strict, body ≤ 1 KiB). 읽기이고 아무것도 쓰지 않는다. 200 `{"found":true,"workspace":null}`(카드만) 또는 `{"found":true,"workspace":{"target_sha":<hex40|null>,"parts":[{"name","bytes","sha256","blob"}],"excluded":{…}}}`. `name`은 닫힌 목록(`PATCH.diff`·`FINDINGS.md`·`CRITERIA.md`·`CONTEXT.md`) 안에서 한 번씩, `bytes ≥ 1`은 UTF-8 바이트 수, `sha256`은 그 바이트의 hex, `blob`은 git blob id(payload가 파일을 이름 짓는 값)다. `excluded`는 옛 route와 같은 사유 집합이고, 비어 있지 않으면 relay는 아무것도 보내지 않는다(`workspace_evidence_refused`). 404 `request_unknown`, 400 `invalid_request`, 401, 503.
- **앱 route ② `POST .../decision-maker/workspace/chunk`:** 요청 `{"request_id","name","index","sha256"}`(strict, body ≤ 1 KiB). 200 `{"found":true,"name","index","total_bytes","chunk_count","sha256","bytes_base64"}`이고 바이트 범위는 `amuxV22TransferChunkRange`(4 MiB, 마지막은 짧다)다. 404 `evidence_absent`(그 이름의 파일이 지금 없거나 아래 검사가 거절), 404 `request_unknown`, 409 `evidence_changed`(다시 연 파일의 sha256이 요청과 다름), 400 `index_out_of_range`·`invalid_request`, 401, 503.
- **비밀 검사는 파일 전체를 대상으로 한다. 약해진 곳이 없다.** 앱은 파일마다 route ①에서 `dmWorkspaceAcceptFiles`(닫힌 이름, 비밀 경로 목록, 텍스트, `detectSecretsInFields`, 패치의 binary 본문 `binaryPatchCarriesSecret`)를 파일 전체에 돌린 것만 설명하고, route ②도 같은 검사를 다시 거친 파일만 조각낸다. 그 검사를 조각마다 되풀이하지 않도록 한 프로세스가 방금 통과시킨 한 파일의 바이트를 2분 동안만 쥔다(요청·이름·sha256이 같을 때만 쓰고, 다른 프로세스·만료·다른 요청은 다시 열어 다시 검사한다). broker는 조각을 다 받은 뒤 그 파일 전체의 크기와 sha256을 설명과 대조하고, 같은 `dmWorkspaceAcceptFiles`를 파일 전체에 다시 돌린 뒤에 통과한 파일만 쓴다. 하나라도 거절되면 workspace 전체가 `workspace_mismatch`다. 이것은 vendor로 나가기 전의 경계이고 조각 경계에서 끊어 읽지 않는다.
- **broker의 `workspace` 요청(intent 전):** `{"v":1,"type":"workspace","requestId","targetSha","parts":[{"name","bytes","sha256","blob"}]}`(키는 정확히 이것만, 옛 inline 요청은 `files`). broker는 이름 검사(닫힌 목록, 한 번씩, 비밀 경로)와 commit 확인만 하고 payload에 들어갈 줄을 답한다. 답의 모양은 옛것과 같다(`lines`, `files`, `excluded`). 바이트를 받지 않으므로 파일이 아무리 커도 이 요청은 작다. relay는 broker가 이름 지은 blob id가 앱이 설명한 것과 같은지 확인하고, 다르면 아무것도 보내지 않는다.
- **launch(intent 뒤):** launch line의 `workspace`가 `{"state","targetSha","parts":[{"name","bytes","sha256"}]}`(`files` 대신 `parts`)이면 본문은 같은 연결로 따라온다. broker는 intent와 payload를 먼저 검사하고(거절이면 첫 답이 `result`이고 조각은 요청하지 않는다) `{"v":1,"type":"send_parts","requestId"}`를 쓴다. relay는 설명한 순서대로 파일마다 index 0..n-1을 한 줄씩 `{"v":1,"type":"part","requestId","name","index","bytesBase64"}`로 보내고, broker는 줄마다 `{"v":1,"type":"part_stored","name","index"}`로 답한 뒤에야 다음 줄을 받는다(한 줄 한 답 규칙 그대로, `trailing_bytes`는 여전히 오류). relay가 조각을 받지 못하면 `{"v":1,"type":"abort","requestId"}`를 보내고, 연결이 끊긴 채로 남지 않게 broker가 거절 `result`로 답한다. 조각은 broker 메모리에 파일마다 한 `Buffer`로 모이고 디스크는 건드리지 않는다. 다 받으면 위 검사를 거쳐 `request.workspace`가 되고, 그 뒤는 옛 경로와 같다(payload 끝이 이 workspace의 줄과 정확히 같아야 하고, 요청 디렉터리를 만들어 쓰고 git을 돌린다). 줄 하나의 상한 `DM_PART_LINE_MAX_BYTES`는 조각 하나가 실리는 크기이지 증거의 상한이 아니다.
- **오류 매핑(broker → `result`, 모두 `transmission: not_started`):** 조각이 설명과 다름(순서·index·길이·base64·요청 id), 파일의 sha256·크기 불일치, 전체 검사 거절, payload가 이 파일들을 이름 짓지 않음 → `workspace_mismatch`. abort, 전송 중단·연결 끊김, workspace 시간 한도 → `workspace_unavailable`. 어느 쪽이든 intent는 이미 기록됐으므로 relay는 옛 launch 거절과 같이 `unavailable` 결과와 미시작 receipt를 기록한다.
- **시간:** 조각을 받는 시간과 그 뒤 build가 `DM_WORKSPACE_TIME_LIMIT_MS` 하나를 나눠 쓴다(broker의 답 deadline `DM_BROKER_RESPONSE_DEADLINE_MS`는 그대로). relay의 `workspace/parts`·`workspace/chunk` 호출은 파일 크기에 비례해 걸리므로 `DM_ROUTE_CLIENT_TIMEOUT`(18 s) 대신 같은 한도까지 기다리고(`AppRoute::client_timeout`), 조각의 답을 잃거나 503이면 같은 조각을 2초 뒤 다시 요청하되 결과 deadline이나 그 한도 중 먼저 오는 때까지만 반복한다(조각은 멱등이다). 거절(404·409·sha256 불일치)은 다시 묻지 않고 abort한다.
- **없애는 값과 남는 값:** `DM_WORKSPACE_EVIDENCE_MAX_BYTES`(합계 64 MiB, 넘으면 `too_large`)는 `DM_WORKSPACE_LEGACY_INLINE_MAX_BYTES`가 되어 옛 `workspace` route와 옛 inline 줄에만 남는다(옛 relay의 메모리 기준이므로 그 relay는 넘으면 지금처럼 카드를 운영자에게 둔다). 새 protocol에는 파일 크기와 합계에 우리가 둔 상한이 없다. `too_large`는 이제 파일을 문자열 하나로 둘 수 없을 때(`DM_WORKSPACE_TEXT_MAX_BYTES` = V8 문자열 한계, 약 512 MiB)만 쓴다. 남는 외부 한계는 그것과 앱·broker의 메모리(파일 하나가 한 `Buffer`와 한 문자열로 있다), 그리고 이번 범위 밖인 box 디스크 `DM_WORKSPACE_DISK_MAX_BYTES`와 시간 한도다. `DM_LAUNCH_LINE_MAX_BYTES`는 payload와 옛 inline 증거의 방 크기이고, 새 protocol의 launch line은 payload와 몇백 바이트다.
- **release:** 새 파일이 없다. broker 묶음(`broker.mjs`)은 import를 따라가므로 `npm run build:amux-decision-maker`가 그대로 새 코드를 싣고, 묶음 목록(`DM_RELEASE_TOP_FILES`)과 manifest 형식은 바뀌지 않는다. relay(Rust)와 broker는 같은 설치 묶음으로 설치한다.

### 10.3 하위 호환

| 앱 | bridge | sidecar | 결과 |
|---|---|---|---|
| 새 | 옛 | 옛 | header가 없으므로 지금처럼 inline |
| 새 | 새 | 옛 | `put_context`가 `refused`이므로 전달하지 않고 기다린다. box는 둘을 함께 설치한다 |
| 옛 | 새 | 새 | 옛 앱은 header를 무시하고 inline으로 보낸다. 새 bridge는 `context_parts`가 없으면 지금처럼 보낸다 |

DM workspace 증거(10.2)는 앱, relay, broker 셋의 조합이다. box에서 relay와 broker는 같은 설치 묶음(DM release)이다.

| 앱 | relay | broker | 결과 |
|---|---|---|---|
| 새 | 새 | 새 | parts protocol: 설명만 오가고 본문은 launch 연결에서 조각으로 간다. 크기 상한 없음 |
| 옛 | 새 | 새 | `workspace/parts`가 프레임워크 404이므로 relay는 옛 `workspace` route와 옛 inline 줄로 간다. 그 route의 64 MiB는 그대로(넘으면 `too_large`로 제외되어 카드는 운영자에게) |
| 새 | 옛 | 옛·새 | 옛 relay는 `workspace` route만 부른다. 앱은 그 route에 64 MiB를 유지하고 새 broker는 옛 inline 요청·launch도 받으므로 지금과 같다 |
| 새 | 새 | 옛 | 옛 broker는 `parts` 요청을 읽지 못해 workspace 없음으로 답하고, relay는 intent 전에 `workspace_unavailable`로 request를 버린다(카드는 운영자에게, 기록·정지 없음). 설치가 둘을 함께 하므로 생기지 않는 조합이다 |
| 옛 | 새 | 옛 | relay가 옛 `workspace` route로 가므로 지금과 같다 |
