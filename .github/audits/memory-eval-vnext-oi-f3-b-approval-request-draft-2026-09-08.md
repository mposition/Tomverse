# memory-eval vNext — PB-R1 exact 승인 요청 초안

**DRAFT / UNSIGNED — 사람 exact 판정 대기. 승인 receipt가 아니다.**
작성자: Codex. 작성일: 2026-09-08. 작성일은 승인일이 아니다.
요청 식별자: oi_f3_b_exact_approval_request_2026_09_08

사용자의 “네 준비해주세요”는 승인 요청문과 별도 승인 기록 **초안 작성** 지시다.
PB-D1–PB-D5 사람 승인, 구현·새 builtin 사용·Git publication 허가로 전사하지 않는다.
과거 승인자의 이름·날짜를 이번 승인 칸에 복사하지 않는다.

## 1. 사람이 판단할 대상

승인 요청 대상은 R1 **f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b**의 아래 두 파일이다.
이 요청문은 고정 패키지의 승인 경계를 전사하며 새 계약·예외·구현 범위를 추가하지 않는다.

| 대상 | 정확한 저장소 상대 path | Raw SHA-256 | bytes / LF |
|---|---|---|---|
| PB-R1 Markdown | .github/audits/memory-eval-vnext-oi-f3-b-approval-package-draft-2026-09-08.md | a2241c6f48dc79d43ebf159494bdeadbf06c0e86de6db05fdcff4f00a77be9a9 | 43955 / 578 |
| PB-R1 JSON | .github/audits/evidence/memory-eval-vnext-oi-f3-b-approval-package-2026-09-08.json | 3e400844dbdda306b5697f40328e673f7d037a5e84cf2124b1193f301a703399 | 114420 / 2037 |

[패키지 원문](memory-eval-vnext-oi-f3-b-approval-package-draft-2026-09-08.md)과
[근거 JSON](evidence/memory-eval-vnext-oi-f3-b-approval-package-2026-09-08.json)의 Git blob raw bytes를
대조했다. JSON document는 위 Markdown을 일방향 결속한다. 각 hash는 그 행의 파일만
식별하며 보고서 hash·원 R hash·이 요청문 hash를 승인 대상 두 hash로 대용하지 않는다.

R1의 유일 parent R은 60486e971c94a189ab418c4743f48428a402ea52다.
R의 parent/패키지 참조 basis M은 65b82d5670e086ca77f39050ad48e68f56433f0e다.
R..R1은 두 파일 M(수정)만인 1 commit이며, 원 R을 amend/rebase/squash하지 않았다.
B 방향 receipt AOD=42a99c4c5721a25b13894b99533b9800f4fb437b,
구현 I=54ad04e29aa3390f4d342d152127e99928b4268e와 구별한다.
현재 요청 작성 HEAD는 R1이고, 그 자체가 미래 실제 구현 착수 tip은 아니다.

패키지의 pending/null 및 “확인 검토 commit이 아직 없다”는 문언은 **작성 당시 사실**로
보존한다. 이후 확인 검토와 미래 사람 승인은 별도 기록에 결속하며 원 bytes를 채워 넣지 않는다.
이 요청문/승인 기록 초안도 아직 Git commit이 없고, R1에 포함됐다고 주장하지 않는다.

## 2. 검토 결과 — 사람 승인이 아닌 증거

| 회차 | 검토 대상 commit | 보고서 raw SHA-256 | bytes | 보고된 판정 |
|---|---|---|---:|---|
| 최초 독립 검토 | R 60486e971c94a189ab418c4743f48428a402ea52 | 76989963726c2a1a0b0334269af46588fadd23cbb7a9debfaf1e384149b0b1a7 | 12668 | PASS_WITH_WARNINGS; P1 0/P2 1/P3 3, 차단 0 |
| 유일 한정 확인 검토 | R1 f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b | ac97a495be66615ea2ff3896d5b0dc78dca3b2c250ed97cee1073661deb84a34 | 7678 | CONFIRMED; PB-F1–PB-F4 확인, 수정 회귀·새 finding 없음 |

최초 보고서 locator:
C:/Users/Vyper/.codex/attachments/e7f117bd-75ae-4fcf-b48a-dfce11806a92/pasted-text.txt
확인 보고서 locator:
C:/Users/Vyper/.codex/attachments/6e1f7561-d2be-4d39-84a1-cc012340a147/pasted-text.txt

locator는 로컬 수신 파일 위치이며 공개 URL·Git 보관·영구 보관을 뜻하지 않는다.
보고서 hash는 실제 수신 bytes를 식별할 뿐 암호 서명이나 작성자 인증을 주장하지 않는다.
미래 제출 시 첨부 원문 보존 범위는 별도로 정하며 지금 보고서를 이동·복사·commit하지 않는다.

확인 검토의 범위는 D2/D3 불가분 승인, 이름별 hook/trap 기대값, V8 보조 근거,
AOD/R 검증 관측 분리 및 수정 회귀다. 검토자는 7개 package 검사 통과를 보고했다.
R clean-tree 자체 재실행은 하지 않았고, R1 결과 동등성은 추론이라고 밝혔다.
ES2024 본문은 도구로 직접 인용하지 못해 버전 고정 V8 source로 보조 확인했다.
T01/suite/lint/typecheck/probe/CI·운영 검증은 수행하지 않았다는 한계도 수용 판단에 포함한다.

CONFIRMED는 **R1의 문서 대응**에만 귀속한다. 이 새 요청문·기록 초안이 Claude 검토를
받았다는 뜻도, 구현·F07 전체 충족·사람 exact 승인·activation 완료라는 뜻도 아니다.
PB 확인 검토는 1/1 소진됐다. 기존 OD-R1/D 회차도 초기화하지 않는다.
새 실질 정책·범위 변경이 필요하면 단순 receipt 전사로 처리하지 않고 별도 지시를 구한다.

## 3. PB-D1–PB-D5 전체 승인 요청

다섯 결정과 R1의 전체 제한·잔여·Gate를 **함께 수용할지** 요청한다. 현재 전부 pending이다.

| 결정 | 승인받을 한정 내용 | 현재 |
|---|---|---|
| PB-D1 | C01/C03/C04/T01/T11 5파일의 R1 지정 책임만 미래 수정; C02와 6파일 밖 불변 | pending |
| PB-D2 | R1의 한정 node:util predicates·intrinsic copy·내부 helper 및 test-only node:vm; PB-D3와 불가분 | pending |
| PB-D3 | genuine Uint8Array raw-storage/private copy 경계와 명시된 호환성 예외, genuine cross-realm 수용; PB-D2와 불가분 | pending |
| PB-D4 | B01–B24/AC-1–AC-12, trap 13개·hook 8개 각각 0, 회귀·정적 감사·민감도/누락 검사 | pending |
| PB-D5 | 기존 잔여·비운영 경계·실제 착수 Gate·향후 검증 SHA에만 효력; 비소급 조건 | pending |

**D2·D3는 불가분 승인 묶음**이다. 하나만 수용하거나 어느 하나를 거절·보류하면
전체 exact 승인은 미완료이며 구현·새 builtin 사용 권한이 생기지 않는다.
D1·D4·D5도 전부 명시적으로 수용해야 한다. 일부 승인으로 AC를 삭제하거나 범위를 바꾸지 않는다.
cross-realm 수용을 거절하려면 별도 대체 설계·범위·시험을 정의하여 검토·exact 승인받아야 한다.
임의 realm/prototype equality 검사로 subclass/Proxy-prototype genuine view를 거절하도록
바꾸는 권한은 없다. 새 대안 구현을 이번 답변에서 자동 선택하지 않는다.

### 승인 후에도 Gate가 선행하는 exact 파일 범위

| ID | path | R1의 책임 한정 |
|---|---|---|
| C01 | lib/memoryEvalVnext/protocol/canonicalJson.ts | 재귀 Proxy guard, copyByteInput, decode/raw-hash bytes adapter |
| C03 | lib/memoryEvalVnext/protocol/signatures.ts | verifyPureEd25519의 message private-copy 경계 |
| C04 | lib/memoryEvalVnext/protocol/trust.ts | compareBlobRef/compareGitFileRef bytes snapshot·hash/길이 결속 |
| T01 | tests/memoryEvalVnextWire.test.mjs | B 음성·회귀 및 별도 inventory; R1 시험 전제 |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json | 기존 subtree 불변 + 선언형 proxySafety 구획 |

C02 lib/memoryEvalVnext/protocol/wire.ts는 **읽기 전용**이다. 신규 구현 파일은 0개다.
C01의 새 node:util은 types.isProxy/types.isUint8Array 두 참조만, 내부 export는
copyByteInput 하나만이다. C03/C04는 그 helper만 추가 import한다.
trusted Uint8Array constructor/TypedArray length getter·set/Reflect.apply와
module 초기화 시 trusted builtins의 prototype/descriptor 확보는 R1 목록에 한정한다.
T01의 node:vm runInNewContext는 상수 cross-realm Uint8Array 시료 전용이며 sandbox가 아니다.
test-only structuredClone transfer도 자체 소유 ArrayBuffer detach 시료에 한정한다.
기존 OS-F3 volatile 합성 서명 시험 권한을 확대하거나 operational key를 만들지 않는다.

root·nested·revoked Proxy, bytes 경계, 거절 전 trap 0회, 기존 정상 결과 보존과
명시된 호환성 예외를 함께 수용한다. private copy 전에 관측 후 catch하는 우회는 허용하지 않는다.
trusted runtime/intrinsics와 안정적인 shared/resizable storage 전제를 유지하며,
동시 변경 원자 snapshot·임의 JavaScript 전체 sandbox·OOM/process 격리를 보장하지 않는다.
이 요약은 R1의 상세 API/알고리즘/FR/NFR/AC를 대체하거나 축소하지 않는다.

## 4. 그대로 남는 잔여와 미승인 범위

OI-F1 과거 착수 시점 공백은 accepted residual이며 historicalPreStartTimingProven=false,
oiF1ClosureDeclared=false다. OI-F2 ID/path는 별도 exact 결정, OI-F4 runner는 별도 범위로
보류한다. ODR-F1 외부 closure는 없다. PB-F1–PB-F4 확인으로 이 잔여를 닫지 않는다.
상위 54 AC는 partial 9/deferred 45/fullySatisfied 0, 기존 F01–F44는 unit 40/external 4다.
새 B01–B19는 unit 구획, B20–B24는 external/gate 구획이며 현재 전건 not_run이다.

원 decision/승인 bytes·기존 승인 계보·S1–S4 잔여와 AOD/RC 조건을 보존한다.
이번 receipt는 기존 S2 approvalCommit A, contract approval, D/K/activationApprovalCommit을
치환하지 않는다. I 당시 F07을 소급 통과시키거나 전체 P/full conformance를 선언하지 않는다.

다음은 이 exact 승인의 허용 범위가 아니다.

- C02·5파일 밖 구현, 새 API/barrel/dependency/package/lock/config/runner/workflow 변경.
- scorer/ledger/full P/resolver/controller/운영 adapter, 등록 parser·trust digest 생성·권한 승격.
- 실제 key/signature/TrustAnchor·정책 등록/폐기, EnvironmentApproval/ClockPolicy/genesis/root/
  journal/checkpoint·백업/복구 운영.
- S2 purpose 전환·activationApprovalCommit/C, dataset/manifest/register 변경.
- holdout 작성/검수/seal/open, S5/v9 prompt 작성·활성화.
- pair 승인·예산·dispatch/re-run/provider 호출·유료 turn.
- production/Railway/DB 접속·설정·배포, release gate,
  memoryExtractionEnabled/memoryInjectionEnabled 변경.
- commit/push/PR/ready/auto-merge/병합/CI dispatch. publication은 별도 지시 대상이다.

## 5. 승인과 구현 착수의 순서

1. 사람이 R1·두 path/hash·PB-D1–PB-D5 전체(D2/D3 불가분) 및 위 제한·잔여·검토 한계를 판단한다.
2. 실제 명시 회신 뒤 별도 authoritative human approval receipt에 decision/approvedBy/approvedAt과
   R1·두 hash·보고서 identity를 결속한다. 현재 초안은 authoritative receipt가 아니다.
3. 별도 제출/병합 지시로 R/R1 및 receipt의 **원 SHA를 보존하는 merge commit 방식**으로
   develop에 반영한다. squash/rebase로 approval ancestry를 끊지 않는다.
4. 실제 착수 tip의 40자 SHA·해당 develop CI·승인 원문 hash/receipt ancestry를 확인한다.
5. RC의 support 9개(AGENTS.md, package.json, package-lock.json, tsconfig.json,
   scripts/run-unit-tests.mjs, scripts/check-text-encoding.mjs, scripts/check-doc-references.mjs,
   scripts/check-policy-section-references.mjs, scripts/check-release-records.mjs)를 그 tip에 재결속한다.
   M→tip diff·Node/V8/tsx·설치 dependency/lock·실제 script flags/test discovery를 별도
   사전 기록으로 검증한다. R1의 로컬 pass나 과거 OS-F4 기록을 미래 착수 증명으로 대신하지 않는다.
6. 위 조건을 충족한 tip에서 새 codex/ branch를 만들고 **별도 구현 착수 지시** 뒤 5파일만 고친다.
7. 실제 구현 commit과 AC 전건의 검증 evidence를 결속한 뒤에만 보강된 F07을 판정한다.
   그 효력은 검증된 구현 SHA 및 별도 재검증된 후속 SHA에 한정하며 I를 소급 판정하지 않는다.

하위 verifier 동결→실제 정책 등록→trustPolicyDigest→전체 P 채택→genesis/root,
D<K<activationApprovalCommit<C, S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch
순서도 그대로다. 문서 승인 완료·구현 착수 허가·구현 완료·activation은 서로 다른 상태다.

## 6. 사람 회신 양식 — 미회신

파일을 편집할 필요 없이 대화로 답하면 된다. 아래는 미회신 양식이며 실제 서명이 아니다.
전체 승인은 PB-D1–PB-D5와 D2/D3 불가분 조건, R1 전체 및 이 요청의 검토 한계·잔여·Gate를
수용한다는 의미다. 다른 범위라면 그 차이를 명시하며, 모호한 회신을 전체 승인으로 추정하지 않는다.

```text
reviewCommit: f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b
대상: 이 요청 §1의 두 path와 raw SHA-256
PB-D1–PB-D5 전체(D2·D3 불가분) 및 제한·잔여·Gate 수용 여부: 미회신
decision: pending
approvedBy: 미회신
approvedAt: 미회신
```

[승인 기록 초안](memory-eval-vnext-oi-f3-b-approval-record-draft-2026-09-08.md)은 이 요청문과
두 패키지·검토 보고서 identity를 결속하되 모든 사람 승인 칸을 미정으로 둔다.
사람이 답한 뒤 에이전트가 실제 회신만 옮겨 별도 최종 receipt를 준비한다.
초안 작성 동의·CONFIRMED·Git commit/CI·PR 병합을 decision=yes로 전사하지 않는다.
이 요청문은 자기 hash나 미래 receipt commit을 자기 본문에 넣지 않는다.

## 7. 이번 작성의 관측·검증

작성 시작 관측 2026-09-08T11:17:45.558Z, HEAD=R1, branch=codex/memory-eval-vnext-oi-f3-b-approval-package,
tracked/index clean이었다. R1 두 파일·보고서 2개, 원문/support 45파일과 기존 일반 untracked
23개·ignored 3개 raw hash를 고정했다. .claude/·.codex/는 건드리지 않으며 내부 전수 hash를
주장하지 않는다. 새 산출물은 요청문/승인 기록 초안 2개뿐이다.

로컬 PC PowerShell, H:/Project/ai-chat-hub clone, 기존 Node v22.22.2/V8
12.4.254.21-node.39/win32 x64로 수행한다. production 자격증명 없이 OS/PATH/TEMP 등만
allowlisted child에 전달한다. 부재를 확인한 .os-f4-absent-env-file을 DOTENV_CONFIG_PATH로,
DOTENV_CONFIG_QUIET=true/NEXT_TELEMETRY_DISABLED=1을 child에만 전달한다.
.env·원 창 설정·운영 환경을 변경하지 않는다. 다음은 npm run <script>의 **이번 작성 전** 결과다.

| package script | 작성 전 exit | stdout 뒤 stderr raw SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | d0a05f454dbd4dcf0dee7b7063a040f139b439245ce6846a25685ed2886df703 |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | f0c574a06149cbd6be1e8701576fcb3a4cf108ee319f89b99ced64be4d059ef4 |

작성 후 같은 7개 script를 2026-09-08T11:22:59.500Z–2026-09-08T11:23:00.832Z에 실행했다.
전부 exit 0이고 작성 전과 exit·출력 SHA가 7/7 동일하다. 실패 이름과 신규 실패는 0건이다.
이는 R1 HEAD+새 미추적 초안 두 파일의 로컬 검사이며 clean R 재실행이나 develop CI가 아니다.
이 결과 문단·요청 hash를 기록한 뒤에도 최종 bytes/hash·형식·보존을 재확인한다.
독립 검토자의 7개 실행은 §2의 보고서에, 위 새 실행은 이 작성에 각각 귀속한다.
기존 AOD/R 검증 기록은 덮어쓰지 않는다. 이번 작업에서 T01/suite/lint/typecheck/probe/
keygen/signing/provider·DB/설치/Git publication/CI 조회·재실행은 수행하지 않는다.
