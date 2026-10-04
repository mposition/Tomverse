# Memory eval vNext S4 — dispatch and run provenance

**Author:** Codex
**Date:** 2026-09-07
**Status:** In Review — 미승인 계약 초안; workflow·ledger·provider 호출 없음
**Reviewers:** 독립 검토 대기; 최종 승인자는 사람
**Document ID:** `MEM-EVAL-VNEXT-S4-1`

## Context — 승인 계보와 범위

상위 결정은 `.github/audits/memory-eval-vnext-contract-decision-2026-09-05.md`, raw SHA-256은
`355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da`다. authoritative receipt는
`.github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md`, 원래 A는
`3f14afb29eddc243640fdb0a5a4f604646ade9f0`다. S2 approvalCommit을 merge SHA로 바꾸지 않는다.

S1/S2 승인은 `.github/audits/memory-eval-vnext-s1-s2-contract-approval-2026-09-07.md`와
commit `52caa2cecbd32cab97736993bd57630b1e3e3bc2`가 소유한다(mposition, 2026-09-07).
S1은 `.github/audits/memory-eval-vnext-s1-scoring-contract-2026-09-06.md`, raw SHA-256
`393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7`이고 S2는
`.github/audits/memory-eval-vnext-s2-purpose-contract-2026-09-06.md`, raw SHA-256
`e9a6a086be32e4d12df776015959c7c95be5185af7dc635403e8cd6689f4baa5`다. 이 원문 bytes와
그 역사적 In Review 표시는 수정하지 않는다. 동반 S3는
`.github/audits/memory-eval-vnext-s3-holdout-contract-2026-09-07.md`다.

작성 basis는 원래 A·S1/S2 검토/승인 SHA를 보존한 merge commit
`f5abaecf77ee56d08cdd7e50ca43c0110d03e6b4`다. 그 tip의
[Admin Console E2E](https://github.com/mposition/Tomverse/actions/runs/34074519676)와
[Credit Finance DB Integration](https://github.com/mposition/Tomverse/actions/runs/34074519699)가
attempt 1 success인 것을 확인하고 새 작성 브랜치를 만들었다. 현재 작업은 **계약 문서만**이다.

S4는 D5의 admission 증거·실행 식별·비밀성·spend·재현을 정의한다. S1의 점수 기준,
S2의 세 승인 층/목적 전환, S3의 holdout 소비 규칙을 바꾸지 않는다. 기술적 provenance,
사람 review, 품질 판정, 운영 승인이라는 네 사실을 하나의 CI green으로 합치지 않는다.

## Functional Requirements — 요구사항

- FR-1: S1–S4 승인·S2 activation·scorer freeze·S3 seal·S5·pair 승인을 MUST 검증한다.
- FR-2: 원래 approval ancestry와 신뢰된 현재 protected tip을 완전 DAG로 MUST 검증한다.
- FR-3: execution commit·reservation commit·dispatch ref tip을 구분해 MUST 결속한다.
- FR-4: append-only programme/reservation/state와 외부 checkpoint를 MUST 보존한다.
- FR-5: ordinal별 사람 dispatch·예산 승인과 durable claim을 provider 접촉 전에 MUST 요구한다.
- FR-6: pinned API의 dispatch 결과와 불명 응답을 재시도 없이 MUST reconcile한다.
- FR-7: 관련 run·전 attempt·artifact를 완전 열거하고 unknown contact를 접촉으로 MUST 센다.
- FR-8: 단일 subject를 repository/workflow/run/attempt/commit/reservation/artifact에 MUST 결속한다.
- FR-9: terminal·안정된 cutoff 증거만 technical closure하고 누락은 MUST 거부한다.
- FR-10: duplicate provider contact는 지출 차단 여부와 무관하게 영구 inadmissible로 MUST 처리한다.
- FR-11: 모든 접촉의 priced spend·불명 비용·budget provenance를 MUST 보존한다.
- FR-12: plaintext 및 candidate hash 목록을 hosted artifact/log/cache에 MUST NOT 게시한다.
- FR-13: 만료 후에도 보존 bytes/receipt로 재검증하고 최신 부정 증거를 MUST 반영한다.
- FR-14: 독립 ordinal 2, exact-set review, 최종 판정·소비의 순서를 MUST 검증한다.
- FR-15: GitHub API 동작을 S4 승인 시 공식 문서로 다시 확인하고 차이는 MUST 차단한다.

### 1. 권한·고정 protocol (FR-1, FR-15)

실행 선행 순서는 D4/S3 그대로다: S1–S4 사람 승인 → 별도 S2 activation 승인과 전환 C의
protected develop 반영 → succ-9 development/기존 polarity calibration만으로 scorer 동결 →
격리 새 holdout 작성·검수·seal → 비노출 S5 prompt 동결 → exact pair·programme·budget·
ordinal별 dispatch 승인. 문서 승인과 유료 실행 권한을 분리한다. S1/S2 receipt 하나로
contractApprovalCommit·activationApprovalCommit·S5/pair/dispatch 승인을 대신하지 않는다.

ProtocolDescriptor는 schemaVersion, specifications(S3/S4 순 두 SpecSnapshot),
implementationDigest, apiVersion, workflowPath, trustPolicyDigest다. E의 실행 closure는 넣지 않는다.
SpecSnapshot은 S1과 같은 {role,repositoryPath,documentSha256,utf8Base64} 운반 구조지만
role=S3/S4인 **별도 타입**이다. 원문 bytes를 내장하고 사람이 승인한 hash와 대조한다.
protocolDigest domain은 `mem-protocol-descriptor-1`이다. 아직 미승인인 이 두 파일의 hash나
구현 digest를 본문 자기 field에 미리 채우지 않는다. 실제 descriptor는 승인 뒤 별도 산출물이다.
S1 scoringContractDigest는 S1/S2 snapshot을 가진 descriptorDigest 그대로 유지한다.

implementationDigest는 genesis 이전 commit P의 ProtocolImplementation을
`mem-protocol-implementation-1` domain으로 hash한 값이다. 이는 controller·custodian adapter·
verifier·전용 workflow와 그 transitive code/schema/runtime/action/dependency의 완전한 closure다.
P에는 미래 holdout, seal, S5 prompt, E/Programme/Reservation을 요구하지 않는다. 이들은
고정된 protocol이 나중에 검증하는 입력이며 implementation의 숨은 import가 되어서는 안 된다.
미래 입력을 빼려다 실제 실행 dependency를 누락하면 closure 불완전으로 거부한다.

**protocol 수명은 공통 ledger 하나 전체**다. genesis 후 descriptor/구현/API/policy를
in-place 변경하거나 programme마다 genesis를 새로 만들 수 없다. 변경이 필요하면 실행을
멈추고 별도 migration 계약·검토·사람 승인을 받아야 한다. 이 버전은 migration을 정의하지
않으며 새 ledger 생성만으로 이전 holdout binding·opening·consumption·spend·invalidation·
checkpoint를 초기화하는 우회도 금지한다. 과거 소비 이력 보존이 없는 전환은 허용하지 않는다.

미래 전용 workflow 경로는 `.github/workflows/memory-eval-vnext-decision-grade.yml`로
예약한다. **현재 파일을 만들지 않는다.** 기존
`.github/workflows/memory-eval-decision-grade.yml`은 plaintext 진단·artifact 경로가 있어
vNext privacy protocol을 충족한다고 간주하지 않는다. 기존 workflow를 호출하거나 기존
register에 vNext run을 넣는 것은 이 초안의 효과가 아니다.

API의 작성 시 확인일은 2026-09-07이며 version은 `2026-03-10`으로 고정한다.
모든 REST 요청에 `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10`을
명시한다. 생략 시 과거 default 버전이 적용될 수 있다. [공식 API version 문서](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
최종 S4 승인 receipt에는 그 시점 공식 문서 재확인 결과를 결속한다. 오늘의 확인을 미래
승인 검증으로 소급하지 않는다. API shape 변화/폐기/불명 응답은 fail-closed이고 버전 자동
fallback은 없다. 이후 변경은 위 ledger 수명·migration 제한을 따른다.

### 2. Git trust와 E/R/T 분리 (FR-2, FR-3)

repository numeric ID는 `1289709524`, 현재 locator는 `mposition/Tomverse`, protectedRef는
`refs/heads/develop`이다. 이름이 같아도 ID가 다르면 거부한다. 호출자가 준 origin/develop
또는 `protected:true`만으로 신뢰하지 않는다. GitHub ref 응답, branch protection/effective
rules, 승인된 ProtectionPolicy, 보존한 checkpoint와 complete Git bundle을 함께 검증한다.
protection API는 다음 §API Contracts에 열거한다. 403/404를 보호 없음/빈 결과로 바꾸지 않는다.
GitHub는 권한 부족을 404로 숨길 수 있다. [공식 REST 문제 해결](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource)

shallow/partial missing object, replace ref, graft, 깨진 parent, 누락된 승인 원문, hash 불일치,
checkpoint rollback은 history_unverifiable다. 완전 DAG의 모든 relevant parent edge에서
append-only 규칙을 검사한다. 삭제 후 복원·다른 branch의 덮어쓰기·merge parent에만 남은
위반은 최종 tree가 같아도 지워지지 않는다. 이 검증은 checkpoint에 결속된 신뢰 root부터다.
처음 보는 verifier도 외부 보존 checkpoint 없이 현 tree를 genesis로 채택해서는 안 된다.

S2의 HistoryContext와 activationCheckpoint는 S2 closed schema 그대로 생성한다. 원래 A,
contractApprovalCommit, activationApprovalCommit, 실제 전환 C를 전부 검증하고 current
protected tip의 succ-9 purpose=development를 확인한다. historical 122개 snapshot과 forward
109개+S2 ledger 범위를 혼동하지 않는다. 공유 helper 13개를 새로 전방 동결하지 않는다.
exact v8 legacy receipt만 역사 읽기 예외이며 다른 pre-C run은 unknown이다.

commit self-hash 순환과 control-plane 변경을 피하기 위해 아래 셋을 분리한다.

| 이름 | 의미 | 결속 / 금지 |
|---|---|---|
| E = evaluatedCommit | 실행할 scorer·validator·prompt·runner 의존성의 승인된 commit | protected tip의 조상; S1 RunTuple.evaluatedCommit=E |
| R = reservationCommit | E와 exact programme/ordinal의 예약 event를 처음 넣은 commit | event 안에 자기 R을 넣지 않음; Git inclusion proof가 사후 R을 결속 |
| T = dispatchRefTip | R을 포함해 merge된 dispatch 직전 protected develop tip | GitHub run.head_sha=T; E/R과 같다고 가정하지 않음 |

controller는 Programme.executionClosureDigest로 E의 실행 closure(모든 local transitive import, schema, lockfile, runtime image,
dependency integrity, full-SHA actions, workflow 및 controller/verifier)를 승인 목록으로 고정한다.
목록은 repository-relative POSIX path+raw SHA와 외부 dependency identity/integrity의
정확한 집합이다. glob/움직이는 branch/package tag/현재 작업 tree fallback은 금지다.
E의 전체 ExecutionClosure는 Programme과 pair/DispatchApproval에 결속한다. T의 대응
실행 파일·외부 dependency 집합은 이 승인된 E closure와 같아야 한다. E/T 양쪽의
control-plane 하위 closure는 별도로 P의 ProtocolImplementation과 같아야 한다. ledger/receipt 같은
비실행 기록만 차이날 수 있고 closure 완전성을 증명 못 하면 거부한다. runner는 E를 exact
checkout해서 채점한다. GitHub가 T의 workflow를 실행한다는 사실을 E 실행으로 위장하지 않는다.
scorer freeze commit F는 S5보다 앞이고 최종 E는 S5 prompt를 포함해 나중에 고정할 수 있다.
E의 scorer/validator 하위 closure가 F와 같은지 별도로 증명하며 prompt 추가를 scorer
수정으로 숨기지 않는다. F/E/T의 역할 차이는 scorer 동결을 해제하는 예외가 아니다.

P는 E/T의 조상이어야 한다. R은 E의 조상일 필요가 없지만 E와 R 모두 T의 조상이고, 모든 승인·freeze·seal은 각 사용
event 이전에 유효해야 한다. Programme/Reservation 본문은 E만 담는다. 별도 DispatchApproval은
R/T/E와 inclusion proof를 결속하고 **Git에 들어갈 자기 commit을 요구하지 않는** S3 사람
서명 receipt로 외부 보존한다. S2의 원래 세 승인 commit 의미는 이 방식으로 바뀌지 않는다.

dispatch 직전과 provider key grant 직전에 API에서 protected tip=T를 다시 확인한다.
사이에 tip이 바뀌면 contact 없이 거부한다. 이미 접촉한 뒤 바뀐 tip은 시각·관측을 보존하고
그 접촉 시점 검증을 재현할 수 없으면 inadmissible이다. 보호 설정/admin bypass/API 또는
check→call 사이 TOCTOU가 사라진다고 주장하지 않는다. GitHub run.head_sha와 E를
다르게 쓰는 이 선택은 새 S3/S4 승인에서 명시적으로 수용할 항목이다.

### 3. 공통 ledger와 durable custody journal (FR-4, FR-5)

미래 공통 파일은 `docs/ops/memory-eval-vnext/ledger.jsonl`이다. **지금 만들지 않는다.**
S2의 `docs/ops/memory-eval-purpose/succ-9.jsonl`과 별개이며 S2 chain의 형식을 바꾸지 않는다.
S3 상태·programme·reservation·closure·소비는 이 공통 chain에 append한다. 각 줄은
mem-cjson-1 object+단일 LF, UTF-8 no BOM, 빈 줄/CRLF/추가 key 금지다. seq는 0부터,
prevDigest는 직전 eventDigest이고 첫 줄만 null이다. eventDigest는 self field를 두지 않고
`mem-provenance-event-1` domain의 전체 event body로 계산한다.

public LedgerEvent는 routing IDs와 encrypted evidence hash만 담는다. plaintext manifest/
subject/candidate hash 목록, 비용 세부, review row, private receipt digest를 공개하지 않는다.
payload 내용은 S3 evidence/receipt encrypted object 안이고 importer가 격리 환경에서만 읽는다.
event의 private binding은 public eventId와 eventType을 포함해 다른 event로 갈아 끼울 수 없게
한다. 서명은 public event body의 digest를 별도 SignatureReceipt로 결속하며 body 자체에
자기 서명 digest를 넣지 않는다. signature 보관 유실도 incomplete evidence다.

승인한 genesis는 repositoryId/ref, protocolDigest, workflow ID/등록 시각, trust epoch,
외부 checkpoint root를 결속한다. 외부 journal은 single writer+exclusive lock+atomic append+
fsync+단조 fencing counter를 제공해야 하며 성공 전 provider key를 내주지 않는다. 다중
writer·durability 불명·lost update·checkpoint 불일치는 실행 차단이다. 프로세스 종료 후
사용된 claim을 TTL로 풀지 않는다. Git이 이 live journal의 atomic lock을 제공한다고 보지 않는다.

live journal의 유일 writer와 `provenance_event`/`provenance_checkpoint` signer는
bootstrap에 사람이 등록한 **controller 역할의 해당 key**다. custodian은 서명·journalId·
seq/eventDigest·단조 fencingCounter와 자신이 외부 보존한 최신 checkpoint를 key/credential
발급 전에 독립 검증한다. importer는 같은 증거를 사후 독립 검증한다. custodian의 관측은
controller 서명의 대체나 암묵적 공동 서명이 아니다. checkpoint key 권한·등록·counter
연속성을 증명하지 못하면 멈춘다. checkpoint는 이미 durable한 prefix만 가리키며 자신을
포함하는 event 또는 아직 없는 Git mirror commit을 입력으로 삼지 않는다.

Git mirror는 journal의 확인된 prefix만 담는다. 아직 mirror되지 않은 claim/opening/소비가
있으면 journal checkpoint를 함께 읽고 **더 보수적인 최신 상태**를 적용한다. 서로 다른
두 권위 chain을 운영하지 않는다. 복구는 exact prefix와 서명·counter가 일치할 때만 가능하고,
fork된 journal 중 마음에 드는 쪽을 고르지 않는다. key grant/dispatch 전 journal checkpoint와
Git mirror를 검증하고, custody 승인자·importer가 보존한 외부 checkpoint보다 뒤로 가지 않는다.

reservation은 programmeId+ordinal당 하나다. Programme에는 한 holdout, exact model/prompt,
E, executionClosureDigest, scoringContractDigest, protocolDigest, sealDigest, S5ApprovalDigest, pairApprovalDigest,
허용 ordinal 집합 [1] 또는 [1,2]가 들어간다. ordinal 집합은 이미 bound 후 늘리지 않는다.
별도 budget/dispatch 승인이 없는 ordinal은 예약만으로 호출할 수 없다. 동시성 key는
`mem-vnext-<repositoryId>-<programmeId>` lowercase이며 cancel-in-progress=false다.
[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)는
직렬화 보조일 뿐 idempotency나 API dispatch 순서의 증거가 아니다.

custodian은 contact_claim을 durable 소비한 뒤 한 RunUnit에만 provider credential을 준다.
발급 시도도 CredentialGrantReceipt와 `credential_granted`를 **발급 전에** durable 기록한다.
이 기록 이후 crash/전달 불명은 발급 1건으로 센다. 전용 workflow의 모든 provider credential은
genesis bootstrap이 지정한 이 단일 발급 경계만 통과하며 runner/저장소 secret/다른 broker의
상시 provider credential은 금지다. 발급 경계 완전성을 증명하지 못하면 no-contact도 증명할 수 없다.
claim은 한 evaluation unit 안의 승인된 case별 호출 묶음에 대한 권한이지 무제한 호출 token이
아니다. 실제 API 요청마다 사전 contact_intent와 사후 usage receipt를 journal에 남긴다.
model retry/SDK retry는 0이며 실패 요청을 자동 재전송하지 않는다. 불명 응답도 사용된
claim이다. 독립 ordinal 2는 새 reservation이고 ordinal 1 재시도 권한이 아니다.

### 4. Dispatch와 provider 전 gate (FR-5, FR-6, FR-11, FR-12)

사람 DispatchApproval은 programme/reservation/ordinal, E/R/T, workflow identity,
protocol/holdout/scorer/prompt/execution closure digest, budget receipt, validFrom/validUntil(최대 30분),
approvedBy/approvedAt을 결속한다. 예산은 request 최대수·token 상한·integer microUSD
최대액·pricingVersion·검증된 provider 가격 근거를 포함한다. 별도 승인이 실제 있기 전에는
어떤 placeholder 승인도 통과하지 않는다. 비용 필수 정보가 없으면 provider 호출 0회다.

controller는 fork/untrusted PR/push/re-run이 아닌 workflow_dispatch, repository ID,
head repository, workflow ID/path, T의 승인 closure, exact DispatchApproval을 확인한다.
ref 입력은 `develop` **branch 이름**이고 raw E SHA dispatch를 지원한다고 가정하지 않는다.
inputs는 reservation_id와 dispatch_receipt_cipher_sha256 두 개만 쓰며 사용자 문자열을
shell 코드로 삽입하지 않는다. token 최소 권한, full-SHA third-party action pin, secrets 전
dependency 설치를 요구한다. [공식 secure-use 지침](https://docs.github.com/en/actions/reference/security/secure-use)
trusted 환경/controller/custodian이 이 조건을 증명하지 못하면 secret을 전달하지 않는다.
plaintext 처리·provider 접촉 job은 S3 §4의 **검증된 전용 ephemeral self-hosted runner**만
사용한다. 이 버전에서 GitHub-hosted runner는 그 job에 허용하지 않는다. `self-hosted` label,
일회 등록, job 종료 시 VM 삭제만으로 환경 증명을 대신할 수 없다. S3 EnvironmentApproval과
세션별 EnvironmentAttestation을 검증하고 credential grant에 그 digest를 결속한다.
GitHub의 [ephemeral runner 문서](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)는
단일 job 배정 후 등록 해제를 설명하지만 host 격리 통제 자체의 증명은 아니다. 이 선택은
새 실행 환경의 준비·승인이 필요하다는 뜻이며 현재 workflow/runner 설정을 바꾸지 않는다.

POST `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`는 고정 version에서
성공 시 HTTP 200과 workflow_run_id/run_url/html_url을 반환한다. ref는 branch/tag 이름이다.
[공식 dispatch 문서](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
응답 run ID를 보존하지만 그 하나가 duplicate 부재의 증거는 아니다. GET으로 unit identity를
다시 검증한다. 2022 버전의 204/no-body 설명을 이 계약에 적용하지 않는다.

POST 직전 dispatch_intent를 durable 기록한다. timeout/네트워크 단절/불명 상태면
dispatch_unknown으로 기록하고 **POST를 자동 재시도하지 않는다**. §5의 완전 열거로 관련
run·attempt와 journal을 대조한다. run을 찾지 못했다는 단일 GET만으로 미접촉을 주장하거나
새 reservation을 자동 발급하지 않는다. 불명 상태 해소 전 provider key/후속 ordinal을 차단한다.
예약 유효시간 만료 후 새 run은 거부한다. 같은 ordinal의 reservation 교체·유효창 연장·
dispatch 재전송은 사람의 단순 재개 판단으로도 허용하지 않는다. 이 버전에는 그런 복구 경로가
없다. 창 안에 유효하게 claim된 unit의 증거 복구/closure만 계속할 수 있다. 유효 unit을
확정하지 못한 채 창이 끝나면 provider/ordinal 2를 차단하고 `programme_end`로 소비한다.
나중에 실제 접촉 0건이 밝혀져도 소비를 되돌리지 않는다. API에 run 자체가 없으면 가상의
RunUnit/NoContactReceipt를 만들지 않는다. 이 보수적 holdout 손실은 F-S4-06의 명시적 잔여다.

key grant 직전에 exact tip/protection, 모든 승인/신뢰 epoch, S2 purpose, S3 state,
기존 reservation의 전 run/attempt, pricing/budget, 환경 secret 준비, 신규 durable claim을
전부 확인한다. missing/unknown은 no-contact refusal다. GitHub runAttempt>1은 새 claim을
받지 못한다. bypass로 실제 접촉했으면 검출 후 영구 inadmissible이다. 준비 확인 과정은
provider ping/유료 probe로 하지 않는다. secret 존재·검증된 가격 증거로 판단한다.

### 5. 완전 run/attempt 열거 (FR-7, FR-10, FR-15)

enumeration 범위는 승인된 전용 workflow의 등록 시각부터 명시적 cutoff까지다. subject와
같은 head_sha/status/actor만 필터링하면 잘못 실행된 duplicate를 숨기므로 금지다.
다른 programme이라고 제외하려면 그 unit의 검증된 marker·journal 결속으로 분류해야 한다.
분류 불명 unit은 관련 접촉 가능 unit으로 남겨 해당 programme closure를 차단한다.

GitHub run list는 per_page 최대 100이고 created 등 필터 사용 시 검색 결과가 1,000개로
제한된다. attempt별 run/jobs endpoint가 있지만 run list만으로 전 attempt가 나오지 않는다.
[공식 workflow runs 문서](https://docs.github.com/en/rest/actions/workflow-runs)
다음 알고리즘은 이 계약의 완전성 정책이다.

1. UTC 초 단위 inclusive [등록시각, cutoff] created 범위와 workflow ID로 runs를 읽는다.
   per_page=100이고 Link의 rel=next를 끝까지 따른다. 다른 host/endpoint/filter로 바뀐 Link,
   loop, 빠진 page, 응답 오류, 비정상 total_count는 refusal다. rel=last 부재를 끝으로 보지 않는다.
   [공식 pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
2. 범위 total_count가 1,000 **이상**이면 UTC 초 경계에서 겹치지 않는 하위 범위로 나눈다.
   1초 단위도 1,000 이상이면 완전 열거를 입증할 수 없어 enumeration_incomplete다.
   범위별 unique run ID 수와 total_count가 같아야 한다. 경계 포함/누락을 fixture로 검증한다.
3. 각 run을 GET하여 현재 run_attempt=N을 얻고 1..N의 모든 attempt를 GET한다. 각 attempt의
   jobs도 전 page를 읽는다. 존재하지 않는 중간 attempt/누락 jobs/불명 응답은 거부다.
4. 다시 GET한 N이 바뀌면 그 관측을 버리고 전체 snapshot을 다시 수집한다. 최대 3회 내
   안정되지 않으면 refusal이지 마지막 일부 응답으로 closure가 아니다.
5. failed/cancelled/skipped/timed_out도 제외하지 않는다. run status가 contact 여부를 말하지
   않는다. signed no_contact 증거와 credential 미발급 journal이 **모두** 있을 때만 미접촉이다.
   unit receipt가 없거나 모순이면 contacted_unknown으로 세고 보수적으로 차단한다.

#### 5.1 실행 전 취소된 unit의 외부 no-contact 증명

NoContactReceipt 발급자는 **job 밖의 등록된 custodian**이다. 두 mode만 허용한다.
`runner_gate`는 실행된 controller의 gate 거부 증거와 marker/UploadReceipt가 있는 경우다.
`external_not_executed`는 terminal인 실재 RunUnit의 모든 jobs/steps 관측에서 실행이 없고,
marker를 만들 controller도 시작되지 않은 경우다. 취소 conclusion, 빈 jobs 한 응답 또는
artifact 부재만으로 후자를 인정하지 않는다. 양 mode 모두 아래를 전부 요구한다.

1. 등록된 workflow의 단일 provider credential 발급 경계와 complete journal genesis부터
   현재 prefix까지를 검증한다. 해당 **RunUnit 전체**에서 다른 reservation으로 기록한 것까지
   포함해 credential_granted/contact_intent가 각각 0건이어야 한다. 누락·우회 가능성은 unknown이다.
2. controller가 custodian의 UnitClosureReceipt를 검증해 `unit_closed`를 durable append한다.
   이 event와 이후 key 발급 금지를 같은 journal lock/fencing 경계에서 처리한다. custodian은
   발급 직전 그 상태를 확인하며 closed unit에는 영구히 provider credential을 주지 않는다.
   receipt는 이미 존재하는 terminal 관측을 가리키고 미래 closure event/checkpoint를 포함하지 않는다.
3. custodian은 그 event를 포함한 Checkpoint, terminal attempt/jobs 전 page와 artifact 전 page,
   원 관측 bytes를 NoContactEvidence에 결속한다. external mode는 step 시작/실행 증거 0건,
   해당 unit 소유 artifact 0건이어야 한다. run의 다른 attempt artifact는 기존 UploadReceipt로
   전부 귀속돼야 하며 귀속 불명·반대 증거 하나라도 있으면 인증하지 않는다.
4. 이 입력 뒤 NoContactReceipt를 서명하고 `no_contact`로 append한다. receipt가 참조한
   checkpoint는 unit_closed를 포함하되 **자기 no_contact event 이전**이다. 최종 snapshot은
   그 뒤 새 checkpoint와 receipt digest를 담으므로 자기 snapshot hash 순환이 없다.

외부 인증은 예약 승인이 없는 stray/re-run unit도 unit 자체의 미접촉을 증명할 수 있다.
reservationId=null은 그 경우만 허용하며 어떤 유효 reservation/승인을 새로 부여하지 않는다.
증거 불완전·발급/intent 1건·모순·추후 우회 접촉이면 contacted_unknown/contacted로 처리하고
기존 duplicate 영구 거부 규칙을 적용한다. 이 예외는 API run/attempt 전건 열거를 줄이지 않는다.
NoContactReceipt/evidence는 S3 receipt/evidence의 protocol package binding으로 보관하고
내부 RunUnit을 대조한다. 미실행 unit의 없는 subject/RunTuple을 생성 순서의 입력으로 요구하지 않는다.

run/attempt 집합의 canonical 순서는 decimal ID의 **숫자 순** runId, 정수 runAttempt다.
동일 ID의 다른 body는 중복 제거하지 않고 snapshot_changed다. page의 서버 순서는 digest에
사용하지 않는다. payload marker와 run metadata, custody journal, dispatch receipt를 함께
대조한다. API가 workflow inputs 전부를 run metadata에 제공한다고 가정하지 않는다.

같은 reservation에서 provider-contacted 또는 contacted_unknown unit이 둘 이상이면
duplicate_contact다. 실제 지출을 사전에 막았는지와 무관하게 programme은 영구 inadmissible이며
ordinal 2를 막는다. no-contact duplicate dispatch도 기록하되, 둘 다 검증된 미접촉이라면
그 사실만으로 duplicate **provider contact**라고 오판하지 않는다. 단 하나의 contacted_unknown도
완전 접촉/비용/결과를 증명하지 못하므로 admissible이 아니다.

### 6. Artifact와 attempt의 일대일 결속 (FR-8, FR-12)

GitHub의 run artifacts 목록은 **run 단위**다. artifact.workflow_run에는 run ID/repository/
head SHA 등이 있지만 문서화된 run_attempt field는 없다. metadata.digest는 plaintext
subject가 아닌 artifact archive의 hash로 검증한다. [공식 artifacts 문서](https://docs.github.com/en/rest/actions/artifacts)
따라서 timestamp나 artifact 이름만으로 attempt를 추정하지 않는다.

전용 workflow의 unit은 공개 marker 한 개와 subject archive 한 개를 낸다. 성공적인 subject
archive의 내부 allowlist는 `subject.enc.json`, `review.enc.json` 두 regular file뿐이다.
각각 S3 EncryptedObject이고 private RunTuple이 같아야 한다. review_sheet는 subject에서
재계산한 정확한 S1 target과 source만 가진다. 두 암호문을 하나의 subject archive에 넣으므로
subject result artifact는 unit당 정확히 하나다. runner_gate no-contact unit에는 marker만 허용한다.
§5.1의 external_not_executed 인증 unit에만 marker와 UploadReceipt의 **부재**를 허용한다.
이때는 해당 unit artifact 0개와 외부 NoContactReceipt/NoContactEvidence가 필수다. 일반
unit의 marker/upload 유실을 이 예외로 바꾸지 않으며 run 전체 다른 attempt artifact도 전부 검사한다.

artifact 이름은 `mem-vnext-<reservationId>-<runId>-a<runAttempt>-marker` 또는 같은 prefix의
`-subject`다. marker archive 내부는 `unit-marker.json` 한 파일이며 내용은 아래 UnitMarker의
closed public schema다. 다른 artifact/파일·업로드 중 덮어쓰기·artifact ID 재사용은 거부한다.
로그/artifact에 candidate hash 목록·plaintext digest를 대신 공개하는 것도 금지다.

UploadReceipt는 trusted controller가 Actions upload 결과의 artifact ID/name/archive digest를
정확한 RunUnit, subject/review cipher hash, 공개 marker digest와 함께 서명한 private 기록이다.
artifact 자체가 자기 archive digest를 포함하는 순환은 만들지 않는다. uploader 결과를 얻은
뒤 별도 custody 보관소에 receipt를 저장한다. 별도 receipt를 같은 archive 안에 재삽입하지 않는다.

importer는 run artifacts 전 page를 **name 필터 없이** 읽고, 각 artifact ID를 별도 GET한다.
repository ID/head repository/run ID/head SHA, archive raw SHA, upload receipt, 내부 AEAD
binding, plaintext subject hash를 각각 대조한다. tuple의 subjectArtifactSha256은 압축 archive
hash가 아닌 `subject.json` exact plaintext bytes hash라는 S1 의미 그대로다. public metadata에
그 값을 넣지 않는다. inner payload는 자기 plaintext hash를 포함하지 않고 외부 tuple이 결속한다.

archive 검증은 다운로드 bytes를 먼저 hash한 뒤, 크기 제한 아래 구조를 읽는다. absolute/
drive/UNC/`..`/backslash/NUL/중복·대소문자 충돌 path, symlink/hardlink, 예상 밖 directory,
encrypted ZIP·extra entry를 거부하고 arbitrary filesystem extraction은 하지 않는다.
압축 archive 768 MiB, 풀린 합계 768 MiB, entry 384 MiB를 상한으로 고정한다. S3 plaintext
package 256 MiB/파일 64 MiB 한도도 독립적으로 적용한다. compression ratio >100이면
resource_limit로 거부한다. 한도 변경은 새 protocol 승인이지 truncation 허가가 아니다.

다운로드는 HTTPS와 GitHub가 발급한 일회 archive redirect만 따르며 Authorization header를
외부 redirect host로 전달하지 않는다. URL/token/log 원문을 공개하지 않는다. 만료/410이면
별도 보존된 동일 archive bytes+metadata+receipt가 있을 때만 §8 offline 재현으로 간다.
누락 파일을 현재 소스나 새 artifact로 채워 넣지 않는다.

### 7. 안정된 technical closure, 품질, 비용 (FR-9, FR-11, FR-14)

모든 관련 attempt는 completed와 non-null conclusion, artifact 업로드 완료(§5.1의 증명된
미실행 unit만 artifact 0개 예외), contact/usage
receipt 확정 또는 명시적 unknown 상태여야 한다. unknown은 closure 실패 증거로 남길 수
있지만 positive technical closure로 통과하지 않는다. workflow의 success만으로 admit하지
않고, failure만으로 이미 보존된 완전한 negative quality 결과를 숨기지도 않는다.

reservation dispatch window가 닫히고 새 claim이 불가능한 것을 확인한 뒤 cutoff를 고정한다.
동일 cutoff에 대해 최소 30초 간격의 두 완전 snapshot이 일치해야 한다. 비교 대상은 전
run/attempt ID와 N, 상태·conclusion·head/workflow, artifact ID/name/size/digest, marker와
custody journal checkpoint다. 서버 timestamp 등 비교 제외 항목은 아래 SnapshotProjection에
한정한다. 최대 3회 수집 내 안정되지 않으면 finalise하지 않는다. 새 API run이 뒤늦게 보일
가능성을 이 30초가 없애 주지는 않으며 API/cutoff 잔여로 남긴다.

TechnicalClosure는 관측 API 응답/필요 header, pagination 범위·Link chain, Git bundle,
E/R/T inclusion, trust/protection snapshot, approvals, journal/checkpoint, marker/archive/upload,
S3 seal와 encrypted subject/review, pricing/usage의 exact bytes를 결속한다. 증거 manifest는
private 상대 path 순 BlobRef 배열이다. credential·signed URL 값은 보존 응답에서 제거하되
원 응답 hash와 **정해진 삭제 field 목록**을 기록한다. 내용 증명에 필요한 field를 임의 redact하지
않는다. API response는 정규화 전 bytes와 적법한 비밀 제거가 구별돼야 한다.

이 기술 closure 뒤 S3 redacted opening과 exact-set receipt를 얻고 importer가 S1 score를
같은 pinned bytes로 재계산한다. AdmissionReceipt는 technicalAdmissible, reviewComplete,
qualityVerdict(PASS/FAIL), continuationAllowed를 구별한다. 질적 FAIL은 완전한 평가 결과일 수
있지만 ordinal 2/운영 활성화를 허용하지 않는다. invalid schema/receipt/unknown provenance는
quality FAIL로 덮지 않고 inadmissible이다. 최종 사람이 보는 gold/진단·최종 verdict는 S3의
development 소비 이후에만 보여 준다. redacted review 완료는 자동 최종 verdict가 아니다.
AdmissionReceipt.continuationAllowed는 ordinal 1에서 ordinal 2로 갈 **기술적 적격성**이다.
새 dispatch 승인을 미리 받은 것이라는 뜻이 아니다. controller의 실제 dispatchAllowed는
이 receipt와 최신 state/checkpoint, ordinal 2의 별도 budget/DispatchApproval을 전부 검증한
결과다. 뒤에 받을 승인을 앞 receipt의 입력으로 요구하는 순환은 만들지 않는다. ordinal 2
종료 뒤 continuationAllowed는 false이며 ordinal 3은 없다.

BudgetReceipt는 verified price source/version, provider/model identity, 각 요청 input/output
상한, request 최대수, totalCostMicroUsd 상한을 결속한다. S1의 integer 제한을 지키며 소수
가격/사용량은 scaled integer numerator/denominator로 표현하고 float rounding을 피한다.
UsageReceipt는 requestIndex별 contactIntentDigest/providerRequestId(없으면 null),
reported tokens/cost, conservative reserved cost, outcome, pricingVersion을 담는다.
timeout/누락 usage는 비용 0이 아니라 unknown이며 unknown unit은 decision inadmissible이다.
추정값은 measured로 표기하지 않는다. SpendSummary는 그 reservation에 결속된 모든
contacted unit의 비용을 합산하고 duplicate/실패의 spend도 빠뜨리지 않는다. programme
총액은 서로 다른 reservation의 요청 identity(unit+requestIndex)를 전건 합산하며, 같은
receipt를 여러 evidence package에 보존한 것 때문에 두 번 세지 않는다. 다른 programme으로
검증 분류된 unit을 subject 예산에 섞지 않는다. 총액의 정수 microUSD 반올림은 **각 요청
비용을 위로 올림한 뒤 합계**다.

provider 전 예상 최대 비용을 reserve하고 한도 초과 전에 다음 요청을 차단한다. guardrail이
이미 일어난 실제 과금의 취소/정확 상한을 보장하지 않는다. 가격/usage 정보의 오차나 race로
초과하면 budget_exceeded와 전체 spend를 기록하고 추가 dispatch를 차단한다. 실행 도중
예산을 자동 증액하거나 불리한 case만 건너뛰어 exhaustive 평가처럼 보이게 하지 않는다.

### 8. 보존·재현·사후 invalidation (FR-10, FR-12, FR-13)

TechnicalClosure를 내기 전에 S3의 독립 보관소 두 곳+분리 key backup+복구 검증을 끝낸다.
hosted artifact 만료 뒤에도 보존된 raw ZIP·각 암호문·private evidence·서명/trust epochs·
Git bundle·scorer/runtime dependency bytes로 재현한다. 새 API 호출/새 provider 호출은
offline reimport의 필수 조건이 아니다. hash/키/receipt 하나라도 없으면 evidence_missing이고
기존 CI success를 대체 증거로 삼지 않는다.

offline 재현의 결론은 **기록된 cutoff 시점까지**다. 이후 duplicate·유출·key 침해·approval
취소 증거를 최신 외부 checkpoint에서 발견하면 append-only invalidation을 우선 적용한다.
과거 TechnicalClosure 원문을 고치지 않고 `programme_invalidated`가 그것을 지목한다.
후일 contact 하나를 무시하거나 새 reservation/programme ID로 이름을 바꿔 admissible로
되돌리지 않는다. 현재 decision/release 판단에는 최신 checkpoint를 요구하고 없으면 unknown이다.

hosted log/artifact/cache는 opaque routing marker와 암호문 allowlist만 허용한다. 출력 경로,
stack/error, 파일명, test diff, workflow summary에도 plaintext/source/candidate hash 목록을
노출하지 않는다. provider SDK debug와 automatic retry는 꺼야 한다. grants는 승인 환경의
volatile 처리에만 전달하고 종료·실패 시 S3 CleanupReceipt를 보존한다. 이미 노출됐다면
삭제 성공으로 무노출이 됐다고 주장하지 않는다. 공개에는 승인된 집계 판정만 별도 허용한다.

## Non-Functional Requirements — 비기능 조건

- NFR-1: 인코딩·closed schema·domain digest는 S1 mem-cjson-1과 S3를 MUST 따른다.
  API/GitHub ID는 decimal string, attempt/seq/cost는 safe non-negative integer다.
- NFR-2: API page·attempt·artifact·Git object·신뢰 증거의 결손은 MUST fail-closed다.
  retry 상한 초과를 best-effort complete로 바꾸지 않는다.
- NFR-3: 동일 보존 evidence에서 동일 as-of admission과 spend를 MUST 재현한다.
  mutable runtime/importer나 현재 helper로 역사 bytes를 대체하지 않는다.
- NFR-4: provider-contact 전 모든 gate를 검증하고 plaintext hosted 노출을 MUST 0건으로 한다.
  operational guardrail과 재현성은 exactly-once 지출 보장이 아니다.
- NFR-5: 시간은 UTC 초 단위, controller/custodian clock 오차는 5초 이내 증거를 MUST 요구한다.
  측정만 아래 정수 millisecond 형식을 쓰며 event 시각 형식은 그대로다. 오차 불명은 valid
  window/cutoff 검증을 막는다. 30초 관측 간격은 성능 SLA가 아니다.
- NFR-6: ZIP/resource 한도, API snapshot 최대 3회, dispatch POST 자동 retry 0회를 MUST 지킨다.
  실패가 비싼 provider 요청으로 연결되지 않게 한다.

### Clock evidence — NFR-5의 판정 입력

사람이 bootstrap에서 ClockPolicy의 source identity/인증 방식/공개 신뢰 key 또는 인증 chain,
측정 구현·drift 검증 방법을 승인한다. 이는 source의 UTC 정확도에 대한 외부 신뢰 선택이며
HTTP Date, `timedatectl` 성공, 서명 없는 offset 자기 선언을 5초 증명으로 인정하지 않는다.
정책의 source 및 verifier 구현은 trustPolicyDigest/ProtocolImplementation에 포함한다.
구현 선택·원 측정 증거가 없으면 placeholder를 채워 통과시키지 않는다.
ClockPolicy의 approvalReceipt는 approvalReceipt 한 field를 제외한 body의
`mem-clock-policy-approval-1` digest를 purpose=clock_policy_approval로 사람이 서명한
SignatureReceipt의 BlobRef다. 완성된 ClockPolicy digest와 승인 대상 digest는 서로 구별한다.

각 controller/custodian의 유효창·grant·cutoff 판단마다 ClockEvidence를 보존한다. pinned
verifier가 source 인증/요청 nonce의 freshness, 원 응답의 UTC와 sourceErrorBoundMs,
로컬 receive 시각과 monotonic elapsed, wall-clock jump 부재를 원 측정 bytes에서 재계산한다.
roundTripMs<=1000, ageMs<=60000, sourceErrorBoundMs<=1000, 승인된 maxDriftPpm<=100이며
음수/불명/상한 초과는 거부한다. 보수 오차 bound는 다음 safe integer 계산으로 고정한다.

`B = abs(sourceUtcMs - localReceiveUtcMs) + sourceErrorBoundMs + roundTripMs + ceil(ageMs * maxDriftPpm / 1000000) + 1`

`B<=5000`이어야 한다. sourceUtcMs는 인증된 응답 생성 시각이고 RTT 전부를 가산하므로
전송 지연을 유리하게 추정하지 않는다. ageMs는 측정 수신부터 판단까지의 monotonic 경과다.
정책/measurement는 raw proof를 담는 서명된 strict UTF-8 보고서로 보존하며 알고리즘·trust
anchor·허용 오차가 없거나 drift 상한을 환경에서 입증하지 못하면 실패다. signer는 등록된
custodian이며 자기 clock과 controller clock을 구별해 서명하고 importer가 입력을 재검증한다.
서명은 시간 source의 정확성을 새로 증명하지 않는다. wall/monotonic jump 후에는 새 측정이 필요하다.
localNow는 ClockEvidence.gateUtcMs이며 수신부터 gate까지의 wall-clock 경과가 ageMs와
측정 정밀도 1ms 이내로 일치해야 한다. 초 단위 event 시각은 gateUtcMs를 내림한 운반값이지
millisecond 경계 판정 입력의 대체가 아니다.
validFrom/validUntil은 각각 [localNow-B,localNow+B] 전체가 승인 구간 안에 들어갈 때만 통과한다.
창 종료/cutoff는 now의 하한이 경계를 지난 때만, 30초 간격은 두 관측의 보수 오차를 뺀
간격이 30초 이상일 때만 인정한다. 오차를 허용창 연장이나 관측 간격 단축에 쓰지 않는다.

## Acceptance Criteria — 구현 후 검증할 수용 기준

아래는 미래 구현용 계약 fixture다. 이번 작성에서 API dispatch/provider 호출/ledger 생성을
실행한 결과가 아니다. replay용 합성 API 응답·Git DAG·암호문과 가짜 provider counter를 쓴다.

### AC-1: 승인 층과 원래 SHA (FR-1, FR-2)

**Given** A를 squash한 DAG, S1/S2만 승인된 context, 또는 activation C가 protected tip에 없는 DAG.
**When** reservation/provider gate를 검증한다.
**Then** 각각 history_unverifiable/prerequisite_missing으로 거부하고 접촉은 0회다.
원래 A와 세 승인 층, S3/S5/pair의 exact receipt가 모두 유효한 경우만 다음 gate로 간다.

### AC-2: E/R/T와 self-hash (FR-3, FR-4)

**Given** E 위에서 R이 예약을 추가하고 T가 이를 merge한 정상 DAG.
**When** run.head_sha=T, RunTuple.evaluatedCommit=E를 결속한다.
**Then** closure 동일성을 검증해 허용하고 R 본문에 자기 SHA를 요구하지 않는다. head=E로
잘못 비교하거나 T의 executable 한 file이 바뀌거나 provider 전 tip이 이동하면 거부한다.

### AC-3: rollback·복구·claim (FR-4, FR-5)

**Given** claim fsync 뒤 crash 또는 ledger 삭제 후 복원, 외부 checkpoint보다 이전 Git mirror.
**When** dispatch/key grant를 재개한다.
**Then** claim을 재사용하지 않고 이력 위반/불명을 거부한다. complete DAG의 다른 merge
parent에만 있는 삭제도 발견한다. TTL 만료나 concurrency queue 완료로 claim을 해제하지 않는다.

### AC-4: dispatch 200과 불명 응답 (FR-6, FR-15)

**Given** pinned API의 200 run-ID body 또는 응답 전 timeout.
**When** controller가 dispatch 결과를 처리한다.
**Then** 앞은 ID를 보존하고 다시 GET/열거한다. 뒤는 자동 POST 0회로 unknown을 남긴다.
204/다른 버전/불명 body는 성공으로 파싱하지 않는다. 승인 시 공식 문서 재확인 없으면 차단한다.

### AC-5: pagination와 전 attempt (FR-7, NFR-2)

**Given** 100건 초과 page, 정확히 1,000인 범위, 한 초 1,000인 범위, attempt 1..3 중 2 누락.
**When** complete enumeration을 수행한다.
**Then** 전 page와 숫자순 set을 재현하고 1,000 범위는 나눈다. 더 못 나누는 범위/중간
attempt/Link loop/count 불일치는 refusal다. failed/cancelled attempt도 contact 판정에서 빠지지 않는다.

### AC-6: unknown·duplicate contact (FR-7, FR-10)

**Given** 같은 reservation에 서로 다른 unit 둘이 있고 한쪽 receipt가 없다.
**When** contact를 분류한다.
**Then** 누락은 contacted_unknown, 다른 접촉과 함께 영구 duplicate_contact inadmissible이다.
전부 검증된 no-contact인 duplicate dispatch는 별도 기록이며 provider contact로 계산하지 않는다.

### AC-7: artifact attempt와 hash 계층 (FR-8, FR-12)

**Given** run-level artifact에 run_attempt가 없고 이름만 a1인 artifact 또는 a2의 upload receipt.
**When** unit1의 subject를 import한다.
**Then** 이름 추론을 거부하고 upload/AEAD/metadata/tuple 전부 일치할 때만 결속한다.
archive hash를 plaintext subject hash로 넣거나 extra entry·두 subject·raw candidate hash marker를
주면 거부한다. subject가 자기 raw hash를 포함하는 순환은 만들지 않는다.

### AC-8: terminal/stability/cutoff (FR-9, NFR-5, NFR-6)

**Given** pending attempt, 두 snapshot 사이 증가한 N/artifact, cutoff 뒤 뒤늦게 드러난 duplicate.
**When** finalise한다.
**Then** 앞의 둘은 closure를 거부/재수집한다. 30초 이상 일치한 완전 snapshot만 기술 closure하고,
나중 duplicate는 기존 receipt를 수정하지 않고 invalidation을 append한다.

### AC-9: 비용과 품질 분리 (FR-11, FR-14)

**Given** 완전한 품질 FAIL run과 failed attempt의 spend, timeout usage 불명 또는 예산 초과.
**When** 결과를 import한다.
**Then** FAIL의 비용도 합계에 포함하고 ordinal 2를 막는다. unknown은 0 USD가 아니며
inadmissible이다. 비용 한도 때문에 일부 case를 생략한 결과를 exhaustive로 승인하지 않는다.

### AC-10: redacted review와 ordinal 2 (FR-14)

**Given** ordinal 1 technical closure와 opened holdout, 서명된 exact-set 전건 no_extra_content.
**When** 독립 ordinal 2를 요청한다.
**Then** S1 machine gate·같은 pair·미소비·새 budget/dispatch 승인까지 있어야 허용한다.
gold/diagnostic unblind, row 누락, extra_content 또는 structural fail이면 호출 0회다.

### AC-11: 만료 뒤 재현·현재 판단 (FR-13, NFR-3)

**Given** artifact API가 410이고 별도 보존 bytes·key·receipt·Git bundle이 모두 있다.
**When** offline reimport한다.
**Then** 같은 cutoff의 결과/spend를 재현한다. key/metadata 하나가 없으면 거부하고,
최신 checkpoint가 없으면 현재 decision 승인으로 확장하지 않는다.

### AC-12: secret 경계 (FR-5, FR-12, NFR-4)

**Given** fork/untrusted event, re-run attempt2, 잘못된 repo ID 또는 secret 전 dependency 미설치.
**When** key를 요청한다.
**Then** release와 provider 호출이 모두 0회다. 실패 로그에도 source/statement/candidate hash를
남기지 않고 S3 cleanup 결과를 보존한다.

### AC-13: E 없는 genesis와 ledger 수명 (FR-1, FR-3, FR-4)

**Given** 승인된 S3/S4·bootstrap·P만 있고 holdout/seal/S5/E는 없는 상태.
**When** ProtocolDescriptor, genesis/root를 만들고 S2 전환 뒤 S3 seal 검증을 준비한다.
**Then** 미래 E/ExecutionClosure 없이 unregistered history까지 검증 가능하다. F/작성/seal 뒤
S5/E가 생겨야 Programme.executionClosureDigest를 결속한다. P 하위 closure 불일치,
genesis 뒤 protocol 수정, 새 ledger로 기존 consumption을 지우는 시도는 거부한다.

### AC-14: controller가 시작되지 않은 attempt (FR-7, FR-10, FR-12)

**Given** 접촉 완료 unit U와 실행 전 취소된 attempt V가 같은 예약에 관련된다.
**When** 외부 custodian이 V의 no-contact를 검증한다.
**Then** complete journal의 grant/intent 0건, durable unit_closed, terminal 전 jobs/steps와
artifact 관측·발급 경계 증명이 있을 때만 external_not_executed를 서명한다. V의 marker/upload
부재만 허용하고 U의 archive는 그대로 전부 검사한다. V의 반대 증거/누락/우회 가능성 하나라도
있으면 unknown이며 U와 함께 duplicate_contact다. unit_closed 뒤 발급 race는 거부해야 한다.
receipt 이전 checkpoint와 원 API captures → receipt/event → 최종 snapshot 순으로 재계산한다.

### AC-15: journal/checkpoint 권한 (FR-4, FR-5)

**Given** 미등록 signer, custodian 단독 checkpoint 서명, rollback counter 또는 아직 없는 mirror SHA.
**When** dispatch/credential 발급 전 checkpoint를 검증한다.
**Then** 전부 거부한다. 등록된 controller의 durable prefix 서명과 외부 anchor 연속성이 있고
custodian이 발급 전에 검증한 경우만 다음 gate로 간다. importer 사후 검증도 동일 권한을 요구한다.

### AC-16: clock 증거와 보수 경계 (NFR-5, FR-5, FR-9)

**Given** ClockPolicy와 인증 원 측정에서 |offset|=1000ms, source error=1000ms, RTT=500ms,
age=10000ms, maxDriftPpm=100인 증거 또는 unsigned Date/stale sample/wall jump.
**When** 창/관측 간격을 검증한다.
**Then** 앞의 B=2502ms를 재계산하되 시각 불확실 구간 전체가 창 안이어야 한다. 나머지는
거부한다. B=5000은 오차 gate만 통과하고 B=5001은 거부하며 두 관측 간격에서 오차를 빼지
않은 단순 30초는 안정 조건을 충족하지 않는다. 원 증거 없는 숫자 자기 선언도 거부한다.

### AC-17: dispatch_unknown 만료와 미접촉 손실 (FR-6, FR-14)

**Given** POST 결과 불명이고 창 종료까지 유효한 unit/claim을 확정하지 못한 예약.
**When** 같은 ordinal에 새 예약/창 연장/재전송을 요청한다.
**Then** 모두 거부하고 programme_end를 먼저 기록해 holdout을 소비한다. 나중에 실제 접촉이
없었다고 확인해도 decision 복귀/ordinal 2는 불허하며 run 없는 NoContactReceipt를 만들지 않는다.

## Edge Cases — 경계 사례

- EC-1: run 삭제/API 404 — 권한·삭제·부재를 추정하지 않고 보존 receipt 또는 refusal다.
- EC-2: workflow path는 같지만 numeric workflow ID 변경 — 등록 이력·새 승인 없이 이어 쓰지 않는다.
- EC-3: artifact 이름만 같은 다른 ID/attempt — upload receipt와 authenticated tuple 없으면 거부한다.
- EC-4: workflow failure인데 subject 완전 — technical integrity와 품질/CI conclusion을 따로 판단한다.
- EC-5: no-contact marker만 있는데 credential 발급 기록 존재 — 모순이며 contacted_unknown이다.
- EC-6: ordinal 1이 sealed를 전혀 열지 못하고 종료 — programme_end는 여전히 소비다.
- EC-7: API pagination 중 새 run — 동일 snapshot 가정 금지; 재수집 상한 뒤 refusal다.
- EC-8: artifact 복사본의 ciphertext만 동일 — ID/name/run/attempt의 결속 없는 복사로 대체 불가다.
- EC-9: live journal이 Git mirror보다 앞섬 — 최신 유효 checkpoint를 읽고 소비를 과거로 되돌리지 않는다.
- EC-10: 과거 receipt는 valid, 현재 signer key 침해 확인 — 최신 invalidation 범위에 따라 현재 사용을 차단한다.

## API Contracts — GitHub REST와 순수 importer

모든 endpoint는 `https://api.github.com`, repo locator와 numeric ID를 대조하며 §1의 header를
고정한다. 표의 GET은 관측, POST는 **미래 별도 승인 후 실행**이다. 이번 문서 작업에서
POST/새 workflow/새 artifact를 생성하지 않는다. S4 승인 때 해당 공식 문서를 다시 읽는다.

| Method / path | Purpose | Required response / failure policy |
|---|---|---|
| GET /repos/{owner}/{repo} | repository identity | id 일치; alias만 믿지 않음 |
| GET /repos/{owner}/{repo}/branches/{branch} | protected tip 관측 | commit.sha=T와 protected; policy 증거와 함께 |
| GET /repos/{owner}/{repo}/branches/{branch}/protection | protection 설정 | 승인 ProtectionPolicy의 classic 항목 대조; 404를 빈 보호로 처리하지 않음 |
| GET /repos/{owner}/{repo}/rules/branches/{branch} | effective active rules | 전 page, 승인 rules digest와 대조; caller 추정 금지 |
| GET /repos/{owner}/{repo}/actions/workflows/{workflow_id} | workflow ID/path/state | 등록된 exact workflow, active만 |
| POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches | 승인된 dispatch | {ref:develop,inputs:{reservation_id,dispatch_receipt_cipher_sha256}}; 200+run ID |
| GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs | 전용 workflow runs | per_page=100, created 범위 분할, Link·total_count 검증 |
| GET /repos/{owner}/{repo}/actions/runs/{run_id} | latest N·identity | run_attempt N과 repository/head/workflow 검증 |
| GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number} | 전 attempt | 1..N 전건, status/conclusion/head 결속 |
| GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs | attempt jobs | per_page=100, 전 page와 run_attempt 대조 |
| GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts | run 전체 artifact 집합 | name filter 없음; run_attempt 제공을 가정하지 않음 |
| GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id} | ID별 metadata | digest/size/expired/name/workflow_run 대조 |
| GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip | exact archive | 302 redirect 또는 만료; raw ZIP digest 검증 |

protection/rules의 field 의미는 [branch protection](https://docs.github.com/en/rest/branches/branch-protection)과
[repository rules](https://docs.github.com/en/rest/repos/rules)를 따른다. ProtectionPolicy는 실제 조직의
classic/ruleset 적용 경로를 사람이 승인한 snapshot으로 고정한다. 이 문서는 현재 보호 설정이
미래 요구를 이미 충족한다고 주장하거나 repo protection을 수정하지 않는다.

```ts
type Digest = string; // SHA-256 lowercase 64 hex.
type Commit = string; // Full lowercase 40 hex.
interface RunUnit { repositoryId: string; workflowId: string; runId: string; runAttempt: number }
interface ImportRequest {
  programme: Programme;
  reservation: Reservation;
  evidence: PrivateEvidencePackage;
  trust: ApprovedTrustRoot;
  mode: "as_of_replay" | "current_admission";
}
type Refusal = "prerequisite_missing" | "history_unverifiable" | "protection_unverified"
  | "dispatch_unknown" | "enumeration_incomplete" | "snapshot_changed" | "contact_unknown"
  | "duplicate_contact" | "artifact_mismatch" | "evidence_missing" | "invalid_receipt"
  | "budget_exceeded" | "privacy_incident" | "resource_limit";
type ImportResult = { ok: true; history: VerifiedHistory; receipt: AdmissionReceipt }
  | { ok: false; reasons: Refusal[]; diagnosticCipherSha256: Digest };
interface ProvenanceVerifier {
  verifyHistory(input: PrivateEvidencePackage, trust: ApprovedTrustRoot): VerifiedHistory;
  importRun(input: ImportRequest): ImportResult;
}
```

이 경계는 보존 bytes를 읽는 순수 verifier다. verifyHistory 오류는 Refusal 중 하나로
실패하며 부분 VerifiedHistory를 반환하지 않는다. 실제 HTTP fetch/쓰기/provider/custody
side effect는 controller 경계이고 importRun이 대신 실행하지 않는다.

## Data Models — closed records와 canonical order

아래 명시한 field 외 추가 key는 거부한다. nullable은 명시된 것만 허용한다. Digest/Commit/
opaque ID/Base64/UTC 시각/BlobRef/SignatureReceipt는 S3와 같은 규칙이다. 숫자 GitHub ID는
decimal string이며 lexicographic sorting을 하지 않는다. 금액은 microUSD safe integer,
실수 비율은 {numerator,denominator} 양의 denominator인 정수 구조다. private record는
S3 encrypted object 안에만 보존한다. raw digest와 domain digest를 교환하지 않는다.

| Entity | Fields | Constraints / order |
|---|---|---|
| ProtocolDescriptor | schemaVersion:1,specifications,implementationDigest,apiVersion,workflowPath,trustPolicyDigest | §1; ledger당 하나, E 의존성 없음; S3/S4 두 snapshot 순; mem-protocol-descriptor-1 |
| ProtocolImplementation | implementationCommit,repositoryFiles,externalDependencies | implementationCommit=P; 두 배열 형식/정렬은 ExecutionClosure와 같음; genesis 이전 control-plane 완전 closure; mem-protocol-implementation-1 |
| ExecutionClosure | repositoryFiles,externalDependencies | files={path,rawSha256} path 순; deps={identity,integritySha256} identity 순; 중복 0; mem-execution-closure-1 |
| ProtectionPolicy | repositoryId,protectedRef,classicProtectionRequired,effectiveRulesRequired,classicSnapshot:BlobRef,effectiveRulesSnapshot:BlobRef,bypassDisclosure:BlobRef,approvalReceipt:BlobRef | booleans는 적용 경로 구분일 뿐 임의 면제 아님; effective protection 하나 이상 필수; 승인 snapshot exact 비교 |
| GenesisRecord | repositoryId,protectedRef,protocolDigest,workflowId,registeredAt,trustPolicyDigest,journalId,bootstrapApproval:BlobRef | bootstrap은 bootstrapApproval field를 제외한 tuple을 사전 승인, 자기 receipt/미래 genesis/event/checkpoint hash 없음 |
| ApprovedTrustRoot | repositoryId,protectedRef,genesisEventDigest,checkpoint:Checkpoint,trustAnchors,protectionPolicy:ProtectionPolicy,registrationReceipt:BlobRef | genesis 뒤 별도 사람 등록; trustAnchors S3 타입, signer/key/epoch 순; root를 호출자가 자기 승인 못 함 |
| Checkpoint | journalId,seq,eventDigest,fencingCounter,gitMirrorCommit,observedAt,signatureReceiptDigest | gitMirrorCommit=null은 genesis 준비 전만; mem-provenance-checkpoint-1; 외부 보존 |
| LedgerEvent | schemaVersion:1,seq,prevDigest,eventId,eventType,repositoryId,holdoutId,programmeId,reservationId,occurredAt,evidenceCipherSha256 | ID null은 event 단계상 미배정만; §3 digest; private payload와 eventId/type 결속 |
| PrivateEventPayload | eventId,eventType,record:BlobRef | record schema는 아래 Event map에 의해 닫힘; 임의 JSON type 허용 아님 |
| Programme | programmeId,holdoutId,manifestDigest,sealDigest,model:ModelIdentity,promptRawSha256,evaluatedCommit,executionClosureDigest,scoringContractDigest,protocolDigest,S5ApprovalDigest,pairApprovalDigest,ordinals | 한 pair/holdout만; E의 ExecutionClosure 증거 필수; ordinals=[1] 또는 [1,2]; mem-programme-1 |
| ModelIdentity | provider,modelId,version,requestConfiguration:BlobRef | 움직이는 alias만으로 identity 주장 불가; exact request 설정/응답 identity 보존 |
| Reservation | reservationId,programmeId,ordinal,evaluatedCommit,budgetReceiptDigest,createdAt | ordinal=1/2, Programme 허용 집합; 자기 R 없음; mem-reservation-1 |
| DispatchApproval | reservationDigest,programmeDigest,unitWorkflowId,workflowPath,E,R,T,protocolDigest,executionClosureDigest,manifestDigest,scoringContractDigest,promptRawSha256,budgetReceiptDigest,validFrom,validUntil,approvedBy,approvedAt,signatureReceiptDigest | Programme과 exact 일치; max 30분; mem-dispatch-approval-1 |
| DispatchObservation | reservationId,intentAt,responseAt,httpStatus,workflowRunId,response:BlobRef,outcome,signatureReceiptDigest | null은 응답 불명만; outcome=accepted/unknown/refused; mem-dispatch-observation-1 |
| ContactClaim | reservationId,unit:RunUnit,dispatchApprovalDigest,checkpointDigest,fencingCounter,claimedAt,signatureReceiptDigest | 재사용·TTL 해제 없음; mem-contact-claim-1 |
| ContactIntent | unit:RunUnit,reservationId,requestIndex,claimDigest,requestInputCipherSha256,reservedCostMicroUsd,createdAt,signatureReceiptDigest | index 0부터 연속; request plaintext hash 공개 없음; mem-contact-intent-1 |
| CredentialGrantReceipt | grantId,unit:RunUnit,reservationId,claimDigest,environmentAttestationDigest,checkpointDigest,issuedAt,expiresAt,signatureReceiptDigest | custodian; credential 발급 전 durable; max 30분 및 dispatch 창 안; 값/token은 없음; mem-credential-grant-1 |
| UnitClosureReceipt | unit:RunUnit,terminalEvidence:BlobRef,observedAt,signatureReceiptDigest | custodian; event 뒤 provider grant 영구 금지; 미래 checkpoint/event hash 없음; mem-unit-closure-1 |
| NoContactEvidence | mode,unit:RunUnit,bootstrapApproval:BlobRef,unitClosure:BlobRef,journalPrefix:BlobRef,checkpoint:Checkpoint,terminalCaptures:ApiCapture[] | mode=runner_gate/external_not_executed; captures 요청순, genesis부터 closed prefix까지 완전; 자기 no_contact/snapshot 없음; mem-no-contact-evidence-1 |
| NoContactReceipt | unit:RunUnit,reservationId,mode,gateFailure,evidenceDigest,credentialGrantCount:0,contactIntentCount:0,checkpointDigest,observedAt,signatureReceiptDigest | custodian; mode는 NoContactEvidence와 일치; external mode의 gateFailure=not_executed, runner_gate는 Refusal 또는 expired_dispatch; reservationId=null은 승인 예약 없는 external mode만; mem-no-contact-1 |
| UnitMarker | schemaVersion:1,unit:RunUnit,reservationId,programmeId,E,T,contactState,subjectCipherSha256,reviewCipherSha256 | contactState=no_contact/contacted/contacted_unknown; cipher hash null은 subject 미생성만; private hash/source 금지 |
| UploadReceipt | unit:RunUnit,reservationId,markerArtifact:ArtifactBinding,subjectArtifact:ArtifactBinding,subjectCipherSha256,reviewCipherSha256,uploadedAt,signatureReceiptDigest | subjectArtifact와 cipher는 no-contact만 null; mem-upload-receipt-1 |
| ArtifactBinding | artifactId,name,archiveSha256,archiveByteLength,markerRawSha256 | markerRawSha256은 marker만 값, subject는 null; artifact ID 숫자순 |
| BudgetReceipt | programmeId,ordinal,model:ModelIdentity,pricingVersion,priceEvidence:BlobRef,maxRequests,maxInputTokensPerRequest,maxOutputTokensPerRequest,maxCostMicroUsd,approvedBy,approvedAt,signatureReceiptDigest | 양의 정수 한도; 가격 근거와 exact 결속; mem-budget-receipt-1 |
| UsageReceipt | unit:RunUnit,reservationId,requestIndex,contactIntentDigest,providerRequestId,reportedUsage:BlobRef,reportedCostMicroUsd,reservedCostMicroUsd,outcome,pricingVersion,completedAt,signatureReceiptDigest | providerRequestId/cost=null은 unknown; outcome=complete/failed/unknown; mem-usage-receipt-1 |
| SnapshotProjection | cutoff,units,artifacts,journalCheckpointDigest | units={unit,E,T,event,status,conclusion,latestAttempt,jobsDigest,markerDigest,noContactReceiptDigest} unit 숫자순; artifacts={artifactId,name,sizeInBytes,archiveSha256,runId} 숫자순; null 결론은 pending만; §5.1 external mode만 markerDigest=null 허용, noContactReceiptDigest=null은 미인증 unit만; E=null은 marker/예약 결속 없는 external mode만 |
| ApiCapture | requestMethod,requestPath,query,requestedAt,status,body:BlobRef,bodyRawSha256BeforeRedaction,responseHeaders,redactedFields | header={name,value}, allowlist만 이름순; query ASCII key순; redactedFields JSON pointer ASCII순 |
| PrivateEvidencePackage | schemaVersion:1,apiCaptures:ApiCapture[],files:BlobRef[],gitBundle:BlobRef,checkpoint:Checkpoint,firstSnapshot:SnapshotProjection,secondSnapshot:SnapshotProjection,observationTimes | captures 요청순; files path순; observationTimes 두 UTC 시각; 내용은 S3 PrivatePackage files에 전건 존재 |
| TechnicalClosure | unit:RunUnit,reservationId,programmeDigest,tuple:RunTuple,E,R,T,evidenceManifestDigest,firstSnapshotDigest,secondSnapshotDigest,cutoff,contactClassification,spend:SpendSummary,closedAt,signatureReceiptDigest | tuple는 S1 exact; mem-technical-closure-1; unknown이면 positive closure 없음 |
| SpendSummary | reservationId,pricedMicroUsd,reservedMicroUsd,unknownRequestCount,requestReceiptDigests | 해당 reservation의 unit/requestIndex 순; 모든 실패/중복 포함; unknown>0은 inadmissible |
| AdmissionReceipt | technicalClosureDigest,reviewReceiptDigest,technicalAdmissible,reviewComplete,qualityVerdict,continuationAllowed,decidedAt,signatureReceiptDigest | qualityVerdict=PASS/FAIL, S1 재계산; 자동 최종 사람 승인 아님; mem-admission-receipt-1 |
| VerifiedHistory | s2Context:S2HistoryContext,checkpoint:Checkpoint,holdoutState,programmeDigest,reservationDigest,technicalClosureDigest,latestInvalidationDigest,verifiedAt | state=unregistered/sealed/opened/development; unregistered는 신뢰 genesis는 있으나 해당 holdout seal event 없음이며 실행 불허; digest null은 아직 event 없음만; 검증 결과이지 입력 자기 선언 아님 |
| Invalidation | programmeId,reason,evidence:BlobRef,previousClosureDigest,observedAt,signatureReceiptDigest | reason은 Refusal enum, closure 없음이면 null; mem-invalidation-1 |
| Consumption | holdoutId,programmeId,reason,triggerReceipt:BlobRef,observedAt,signatureReceiptDigest | programme 미배정 때 null; reason=full_unblind/tuning_exposure/programme_end/final_verdict; mem-consumption-1 |
| ClockPolicy | sourceId,sourceTrust:BlobRef,measurementPolicy:BlobRef,verifierImplementationDigest,maxDriftPpm,maxRoundTripMs:1000,maxAgeMs:60000,maxSourceErrorMs:1000,maxErrorMs:5000,approvalReceipt:BlobRef | bootstrap 사람 승인은 approvalReceipt 제외 body를 결속; 완성 record domain=mem-clock-policy-1; drift 0..100 정수, 근거 필수; verifier digest는 S3 Data Models 규칙 |
| ClockEvidence | clockId,policyDigest,sourceUtcMs,localReceiveUtcMs,gateUtcMs,roundTripMs,ageMs,sourceErrorBoundMs,measurement:BlobRef,observedAt,signatureReceiptDigest | UTC epoch ms와 elapsed ms는 safe non-negative integer; NFR-5 식 재계산; clockId는 등록 controller/custodian clock; mem-clock-evidence-1 |

S3의 RunTuple 기반 private package는 plaintext subject를 hash한 **뒤** 그 tuple을 가진
wrapper에 넣는다. subject 자체의 closed SubjectResult는 {schemaVersion:1,unit,reservationId,
programmeId,E,T,manifestDigest,scoringContractDigest,protocolDigest,executionClosureDigest,model,promptRawSha256,
caseResults,completion,usageReceiptDigests}다. caseResults는 S1 입력 candidate raw bytes와
frozen server validation 및 S1 score 결과를 보존한 {caseId,candidates:BlobRef,score:BlobRef}
배열(caseId 순)이며 manifest cases와 exact set이다. completion은 {expectedCaseCount,
completedCaseCount,requestCount,exhaustive}이고 전부 대조한다. malformed output은 숨기지
않고 private failure evidence에 보존하며 완전 subject로 인정하지 않는다. subject는 자신의
raw hash를 포함하지 않아 S1 tuple/hash 순환이 없다.

ReviewSheet는 {schemaVersion:1,tuple,targets}이고 target은 {candidateKey,statementRawBase64,
statementRawSha256,sources}다. sources={conversationId,messageId,messageRawBase64,
quoteRawBase64,quoteRawSha256} 배열이며 S1의 source 순서/중복을 보존한다. candidateKey 순
전건과 S1 ReviewTarget을 대조한다. RunTuple의 subject hash는 이미 만들어진 subject를
가리키므로 review_sheet/subject 어느 쪽도 자기 hash에 의존하지 않는다.

Event map은 genesis→GenesisRecord, holdout_sealed→S3 SealEvidence,
programme_bound→Programme, reservation_created→Reservation, dispatch_intent/dispatch_observed→
DispatchObservation, contact_claimed→ContactClaim, credential_granted→CredentialGrantReceipt,
unit_closed→UnitClosureReceipt, contact_intent→ContactIntent,
no_contact→NoContactReceipt, usage_observed→UsageReceipt, upload_observed→UploadReceipt,
technical_closed→TechnicalClosure, opening_started→S3 OpenIntent, opening_observed→S3 OpenReceipt,
review_completed→S1 ReviewReceipt, opening_recovered→S3 RecoveryReceipt,
admission_recorded→AdmissionReceipt, holdout_consumed→Consumption,
materialised→S3 MaterialisationReceipt, programme_invalidated→Invalidation,
cleanup_recorded→S3 CleanupReceipt다. 다른 eventType은 거부한다. state-changing event의
record 서명은 S3/S4 표의 목적에 맞는 권한을 요구하고, public event도 controller가 서명한다.

서명 body는 S3와 같이 signatureReceiptDigest **한 field만** 제외하고 표의 domain으로
hash한다. SignatureReceipt purpose 추가 목록은 provenance_event, provenance_checkpoint,
dispatch_approval, dispatch_observation, contact_claim, credential_grant, unit_closure, contact_intent, no_contact,
upload_receipt, budget_receipt, usage_receipt, technical_closure, admission_receipt,
invalidation, consumption, clock_evidence, clock_policy_approval이다. 역할 매핑은 다음과 같다. provenance_event와
provenance_checkpoint, dispatch_observation/contact_claim/contact_intent/upload_receipt/
usage_receipt는 controller, credential_grant/unit_closure/no_contact/clock_evidence는 custodian,
technical_closure/admission_receipt/invalidation은 importer, dispatch_approval/budget_receipt/clock_policy_approval은
사람 approver다. consumption은 controller가 사전 사람 intent 또는 검증된 강제 소비 사유를
결속해 기록한다. 관측 서명으로 사람 verdict를 만들 수 없다. 사람이 signer라는 이유만으로
다른 역할 권한이 생기지 않으며 모든 매핑은 bootstrap의 key/epoch 권한과 함께 검사한다.

snapshot domain은 `mem-api-snapshot-1`, private evidence의 files BlobRef[]는
`mem-provenance-evidence-1`이다. apiCaptures의 header allowlist는 date, link, etag,
last-modified, x-github-request-id, x-github-api-version-selected, x-ratelimit-remaining,
x-ratelimit-reset뿐이다. Authorization/Set-Cookie/Location(signed URL)은 보존하지 않는다.
body의 archive_download_url/download_url에서 query credential이 있으면 그 query만
삭제하고 redactedFields에 남긴다. 그 외 내용 변경은 거부하며 access-controlled encrypted
원 응답 보존이 필요한 경우 별도 approved receipt로 원 hash를 검증한다. query는 요청의
비밀 없는 filter만 보존한다. API 신뢰 자체를 서명 하나가 독립 검증으로 바꾸지는 않는다.

DB table/index/migration은 N/A다. 이 초안은 실제 ledger·workflow·custody 저장소를 만들지 않는다.

자기 hash 순환을 막는 생성 순서는 다음과 같다. bootstrap의 신뢰 key/role/policy를 사람이
먼저 등록하고 P의 ProtocolImplementation → ProtocolDescriptor를 만든다. 이때 E/S5/holdout
bytes는 필요하지 않다. GenesisRecord → 암호화 payload → genesis
event와 서명 → genesis prefix의 Git mirror commit → checkpoint → ApprovedTrustRoot의 외부 등록
순이다. checkpoint는 그때 이미 존재하는 mirror commit을 가리킨다. 뒤에 생긴 root를
genesis payload에 다시 넣지 않는다. Programme의 pairApprovalDigest도 사전에 승인한
{programmeId,holdoutId,model,promptRawSha256,E,executionClosureDigest,scoringContractDigest,protocolDigest,ordinals}
tuple의 receipt를 가리키며 미래 Programme 전체 digest를 자기 approval에 요구하지 않는다.
S5 approval은 이미 고정된 prompt·비노출 근거를 가리킨다.
신뢰 root와 S2 전환 검증 뒤 아직 seal되지 않은 holdout은 VerifiedHistory.unregistered로
표현한다. S3 verifySeal은 이 context에서 검사하고 성공한 SealEvidence를 뒤의 holdout_sealed가
결속한다. 순서는 genesis/root → S2 전환 검증 → F → 작성/검수/seal → S5 → E/ExecutionClosure →
pair 승인/Programme이다. unregistered를 sealed로 가정하거나 seal 검증에 미래 seal event를
요구하지 않는다. P를 동결했다는 사실은 F 동결·S1–S4 사람 승인·S2 activation을 면제하지 않는다.

실행 이후는 SubjectResult raw bytes → 그 hash를 가진 RunTuple → S3 private package
암호문 → subject/marker upload → UploadReceipt → 두 API snapshot → input evidence
manifest → TechnicalClosure → S3 ReviewReceipt → AdmissionReceipt 순이다. evidence
manifest는 **그 closure 이전 입력 파일**만 열거하며 자기 manifest/closure/후속 receipt를
포함하지 않는다. full opening/최종 판정의 Consumption.triggerReceipt는 사전 승인 intent를
가리키고, 최종 결과는 consumption event를 사후 참조한다. 소비와 최종 판정의 상호 hash
순환을 만들지 않는다. 각 후속 receipt는 새 보관 object이지 앞선 archive 덮어쓰기가 아니다.

## Review disposition — 미승인 선택과 잔여

S1/S2 승인에서 수용한 P2-N1, C-COORD-1 및 여섯 R-* 조건을 변경하지 않는다. 상위 §12의
TOCTOU/GitHub-importer 신뢰 잔여를 숨기지 않는다. 새 S3/S4 승인 receipt는 아래를 exact
문서 hash와 함께 명시적으로 다뤄야 한다. 최초 독립 검토는 원본 commit
`3f1e1e261951b946e0e066dc510aad160a73d9f8`에 BLOCK을 냈다. 아래 수정은 그 지적에 대한
작성자 대응이며 **확인 검토의 closure 판정과 사람의 최종 bytes 승인은 아직 없다**.

| Finding | 수정/disposition | 확인 검토 대상 |
|---|---|---|
| F-S4-01 (P1) | ledger당 고정 protocol, P와 E closure 분리, migration은 별도 승인·과거 소비 보존 없이는 금지 | §1–§3, Data Models, AC-13 |
| F-S4-02 (P2) | custodian 외부 no-contact는 완전 journal·영구 unit 폐쇄·미실행 증거가 있을 때만 허용 | §5.1, artifact 예외, AC-14 |
| F-S4-03 (P2) | controller 단일 writer/checkpoint signer, custodian 사전·importer 사후 검증 | §3, purpose 매핑, AC-15 |
| F-S3-02 (P2) | 전용 attested ephemeral self-hosted, label만으로 불충분; hosted plaintext job 불허 | §4와 S3 §4/AC-12 |
| F-S4-04 (P3) | 검토자 관측을 아래 잔여로 공시; protection 설정 변경/적합 승인 없음 | ProtectionPolicy/bypassDisclosure, R-S4-PROTECTION |
| F-S4-05 (P3) | closed ClockPolicy/Evidence, 보수 오차 식·경계 처리·누락 거부 | NFR-5, AC-16 |
| F-S4-06 (P3) | unknown/만료 뒤 재예약·창 연장 없음, 유효 unit 없으면 종료 소비 | §4, AC-17, R-S4-LOSS |

- R-S4-CONTROL-PLANE: E/R/T 분리와 dependency closure의 완전성은 importer 검토에 의존한다.
  E/T의 control-plane이 P와 다르게 실행되지 않음을 증명하지 못하면 실행을 포기한다.
  ledger당 protocol 동결을 선택하며 protocol 변경의 별도 migration은 현재 권한 밖이다.
- R-S4-RACE: durable journal·fencing·key custody·concurrency는 contact race를 줄이지만
  GitHub/API/admin/provider 사이 원자 transaction이 아니다. duplicate 검출 뒤 영구 inadmissible로
  만들어도 이미 발생한 지출·노출을 되돌리지 못한다.
- R-S4-API: 1,000 결과 cap 분할·전 attempt·두 snapshot은 API가 제공하는 관측 범위에 의존한다.
  숨겨지거나 나중 나타나는 run은 즉시 증명할 수 없다. unknown의 보수 차단 비용을 수용해야 한다.
- R-S4-CHECKPOINT: single-writer journal, 외부 신뢰 root와 장기 key/receipt 보관이 필수 운영
  의존성이다. 현재 존재·구현됐다고 주장하지 않으며 구성 검증 전에는 provider를 호출하지 않는다.
- R-S4-TIME: protected tip check→call과 5초 clock 오차/30초 안정 관측은 절대 동시성을 보장하지
  않는다. 승인 시 API 재확인·보호 정책 고정·최신 invalidation 확인을 생략할 수 없다.
- R-S4-SPEND: reported usage/가격 버전의 정확성을 신뢰하는 한계가 남는다. unknown 비용을
  성공으로 추정하지 않고 extra spend를 기록한다. 예산 승인과 decision admissibility는 별개다.
- R-S4-PROTECTION: 최초 검토자가 2026-09-07 read-only API에서 보고한 값은 required checks
  2건, enforce_admins=false, required_linear_history=false, active branch rules=[]다. 이는
  검토자 관측이며 이 수정에서 새로 관측한 설정이나 적합 판정이 아니다. 미래 ProtectionPolicy의
  bypassDisclosure에 현재 재조회한 관리자 우회/적용 경로를 반드시 명시하고 사람이 승인해야 한다.
  원래 SHA 보존 merge 정책은 유지하며 linear history 강제나 protection 설정 변경을 하지 않는다.
- R-S4-LOSS: 실행 전 취소를 외부 no-contact로 인증하는 운영 증거가 없으면 unknown 차단 비용을
  치른다. dispatch_unknown/예약 만료 때문에 **실제 provider 접촉이 없어도 holdout을 잃을 수 있다**.
  새 reservation/ledger로 소비를 지우지 않으며 이 비용의 최종 수용은 S3/S4 사람 승인에 남긴다.

## Out of Scope — 이번 작성이 하지 않는 것

- OS-1: workflow/scorer/importer/custody/ledger 구현, source/test code 변경.
- OS-2: 실제 dataset·manifest·holdout·key·register 생성/변경, succ-9 activation.
- OS-3: S5/v9 prompt 작성·활성화, pair/예산/dispatch/provider 호출 승인·실행.
- OS-4: release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경, production 동작 변경.
- OS-5: GitHub protection·secrets·environment·workflow dispatch 설정 변경.
- OS-6: 이번 문서의 commit/push/PR·독립 검토 완료·사람 승인 대행. 후속 명시 지시가 필요하다.
