# memory-eval vNext — 사후 기록·처리방침 승인 기록

## 1. 사람 승인과 기록의 효력

**decision: yes — 사후 증거·잔여 처리방침 및 OI-F3 B 방향의 한정 승인.**
승인자: mposition. 승인일: 2026-09-08.
기록 작성자: Codex. 작성일: 2026-09-08.
작성 시작 관측: 2026-09-08T08:23:23.684Z (작성자 관측 시각, 사람 승인 시각이 아님).

이 문서는 아래 두 사람 회신을 [승인 요청 초안](memory-eval-vnext-offline-subset-disposition-approval-request-draft-2026-09-08.md)
및 검토된 OD-R1 두 raw bytes에 결속하는 **별도 authoritative human approval receipt**다.
암호학적 SignatureReceipt·운영 wire·새 signer/권한 객체가 아니며 아직 Git commit은 없다.

1. 승인 요청에 대한 사람 회신:
   “승인합니다. 승인자: mposition, 승인일: 2026-09-08.”
2. 미선택 OI-F3의 후속 명시 회신:
   selectedOiF3Option: B, selectedBy: mposition.
   별도 승인 패키지에서 root·nested·revoked Proxy, bytes 입력 경계,
   거절 전 trap 실행 0회, 기존 정상 입력의 결과 보존을 명확히 하며,
   임의 JavaScript 전체를 격리하는 sandbox 보장으로 확대하지 않는다는 조건을 명시했다.

첫 승인만으로 B를 추정하지 않았다. B는 두 번째 회신으로 확정됐다.
위는 대화의 내용 전사이며 채팅 원시 bytes의 hash나 전자서명 검증이라는 주장이 아니다.
approvedAt은 첫 승인 회신의 명시 날짜다. 두 번째 선택 회신은 별도의 날짜/시각을 제공하지
않았으므로 selectedAt을 지어내지 않는다.

```yaml
recordStatus: approved_limited_disposition
recordKind: offline_subset_posthoc_disposition_approval_receipt
requestId: offline_subset_posthoc_disposition_approval_request_2026_09_08
decision: "yes"
approvedBy: mposition
approvedAt: "2026-09-08"
selectedOiF3Option: B
selectedBy: mposition
selectedAt: null
selectionDateProvidedSeparately: false
approvalScope: posthoc_evidence_residuals_and_future_direction_only
recordCommitAtPreparation: null
reviewedDocumentCommitAtPreparation: null
requestDocumentCommitAtPreparation: null
implementationReferenceCommit: "54ad04e29aa3390f4d342d152127e99928b4268e"
implementationBasis: "718aaf974e254e32bcb010ff2c1170a06011eed5"
acceptedDispositionIds: [OI-F1, OI-F2, OI-F3, OI-F4, ODR-F1]
reviewedRawBytesAndReviewLimitsAccepted: true
oiF1CurrentPosthocEvidenceAccepted: true
oiF1HistoricalTimingGap: accepted_residual
historicalPreStartTimingProven: false
oiF1ClosureDeclared: false
odrF1SupplementAcceptedWithLimits: true
odrF1ExternalClosure: null
oiF2Disposition: deferred_separate_exact_id_path_decision
oiF3Disposition: B_direction_selected_exact_package_pending
oiF4Disposition: deferred_separate_runner_scope
upstreamConditionsPreserved: true
oiF3ExactContractChangeApproved: false
oiF3ExactImplementationPackageApproved: false
newBuiltinAuthorized: false
implementationChangeAuthorized: false
gitPublicationAuthorized: false
mergeAuthorized: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
```

acceptedDispositionIds는 **아래 항목별 처리방침의 수용**이다. finding 수정 완료·과거 시점
증명·F07 전체 충족·ODR-F1의 외부 closure를 일괄 선언하는 목록이 아니다.
direction_selected는 exact 설계/구현 승인과 다르다. 이 기록으로 다음 패키지 작성이나 코드를
자동 시작하지 않는다. 구체적인 후속 작업은 별도 지시에 따른다.

## 2. 승인 대상의 exact bytes

| 대상 | path | Raw SHA-256 | Bytes / LF lines | 문서 commit |
|---|---|---|---|---|
| 승인 요청 | .github/audits/memory-eval-vnext-offline-subset-disposition-approval-request-draft-2026-09-08.md | f3d459e032cffc3a72de2e1af9f235f0c52b3a5155eeaf43e944fcc0b467b0c8 | 23617 / 349 | 없음, untracked |
| OD-R1 문서 | .github/audits/memory-eval-vnext-offline-subset-review-disposition-draft-2026-09-08.md | aaf16425e8ff5ead15d3e25e71bce809ff15e481717a20f1ad6f08a64eab082a | 41175 / 572 | 없음, untracked |
| OD-R1 근거 JSON | .github/audits/evidence/memory-eval-vnext-offline-subset-review-disposition-2026-09-08.json | 90e55c1f13471b5040103972d8476b8a10b51f67eaadd815a65fe42686693b11 | 173045 / 3022 | 없음, untracked |

[OD-R1 문서](memory-eval-vnext-offline-subset-review-disposition-draft-2026-09-08.md)와
[OD-R1 JSON](evidence/memory-eval-vnext-offline-subset-review-disposition-2026-09-08.json)은
CONFIRMED 대상 bytes 그대로다. 현재 JSON hash는 90e55c1f…이며 원 JSON 0400f445…나
검토 보고서 hash를 대신 승인한 것이 아니다. 요청 문서는 별도로 f3d459e0…에 결속한다.

승인 요청/OD-R1의 pending·null·selectedOption=null은 **각 문서 작성 시점의 상태**로 남긴다.
지금의 사람 승인과 B 선택은 이 별도 기록에만 적는다. 승인 받은 원 bytes의 YAML이나
본문을 채워 넣어 SHA를 바꾸지 않는다.

I=54ad04e29aa3390f4d342d152127e99928b4268e는 구현 참조 commit이다.
그 유일 parent T=718aaf974e254e32bcb010ff2c1170a06011eed5와 구별하며, I/T/branch tip을
위 미commit 문서나 이 receipt의 commit으로 대용하지 않는다. 이 receipt는 자기 최종 hash나
미래 commit SHA를 자기 본문에 넣지 않는다.

## 3. 독립 검토의 귀속과 잔여

| 회차 / 대상 | 보고서 locator | 보고서 raw SHA-256 / bytes | 보고된 결과 |
|---|---|---|---|
| 원 OD 초안 최초 검토 | C:/Users/Vyper/.codex/attachments/8c91b016-4cd6-401a-8e32-0790a509163e/pasted-text.txt | 63373d6b845a439908661bec3eb356ce6b885c650f59e28fb68da625fc9edb84 / 10830 | PASS_WITH_WARNINGS, P1 0/P2 0/P3 4 |
| OD-R1 한정 확인 검토 1회 | C:/Users/Vyper/.codex/attachments/4038bda6-12ab-4427-8c6a-a21e7cd5b135/pasted-text.txt | 573b386a8434cec8f9b63b9f6454532e8cff62b8b525f4ef162efe2ba66dd202 / 9294 | CONFIRMED, OD-F1–OD-F4 해결; 새 ODR-F1 P3 유지 |

원 초안은 Markdown 7041f7f5898ca333ae1d54f3656644d26c736011b32d8e4ad121009406fa233b,
JSON 0400f4455f620038c990e82872d724ec6a6233ca8c7be6976b772c10d56eee72였다.
OD-R1 §12의 원 snapshot은 수정 전 bytes이며 로컬 임시 보존임을 유지한다.

CONFIRMED의 대상은 §2의 OD-R1 두 파일이지 승인 요청, 이 receipt, B 구현 또는 새 exact
승인 패키지가 아니다. 검토자의 전수 대조·검사·재현 결과는 그 보고서에 귀속한다.
기존 I 구현 최초 검토 및 Q/D 검토와 회차를 섞지 않는다.
OD-R1 확인 검토 1회와 D 확인 검토 1/1 상태를 초기화하거나 자동 재요청하지 않는다.

### ODR-F1 보완의 한정 수용

확인 검토자는 원 JSON의 일반 untracked 19개+ignored 3개에 대해 hash 22/22 일치를
보고했지만, 20번째 일반 파일인 원 OD 최초 검토 prompt는 기준 hash 누락으로 존재만
확인했다고 보고했다. 그 사실을 이 receipt로 소급 교정하지 않는다.

| 항목 | 결속 값 |
|---|---|
| 파일 | .github/audits/memory-eval-vnext-offline-subset-disposition-independent-review-prompt-2026-09-08.md |
| raw SHA-256 | 7ed8131932280fbd5962c1bc8489b02499494c1ee1d8af65afb58b305c0569e0 |
| bytes / LF lines | 24477 / 338 |
| 승인 요청 §3의 현재 관측 | 2026-09-08T08:05:55.297Z, binary Buffer hash |
| 이번 재확인 | 2026-09-08T08:23:23.684Z, 같은 raw SHA |
| 사람 수용 | 작성자 보완과 명시된 과거 관측 한계 수용 |
| 외부 closure | 없음. 기존 CONFIRMED 대상으로 소급하지 않음 |

[원 OD 최초 검토 prompt](memory-eval-vnext-offline-subset-disposition-independent-review-prompt-2026-09-08.md)의
현재 identity는 직접 재계산할 수 있다. 과거 수정 시작 때 동일 hash였다는 도구 관측은
작성자 귀속이며 baseline 로그 전체가 요청/receipt에 포함되지 않아 이 문서만으로 독립
검증할 수 없다는 한계를 함께 수용한다. 현재 hash 기록을 과거 시점 증명으로 쓰지 않는다.
따라서 ODR-F1은 **보완·한계의 사람 수용**이지 검토자의 새 해결 판정이 아니다.

## 4. 승인된 처리방침의 정확한 범위

### OI-F1 — 현재 사후 기록 수용, 시점 공백은 잔여

OD-R1 §1의 한정 관측 범위와 그 검토 한계를 사후 증거 보완 자료로 수용한다.
원문 26개·지원 9개·구현 6개, 계보/diff·환경·T CI·한정 검사 기록은 그 기록 시점의
관측이지 미래 tip이나 운영 proof로 확대되지 않는다.

실제 착수 전에 별도 T 기록이 있었다는 사실은 입증되지 않았다는 공백을
accepted residual로 수용한다. historicalPreStartTimingProven=false와
oiF1ClosureDeclared=false를 유지한다. receipt §7.4가 과거에 충족됐다고 소급 선언하거나
미기록 사실을 삭제하지 않는다. 원 I/원문을 amend/rebase/squash하여 과거를 바꾸지 않는다.

### OI-F2 — ID/path 별도 exact 결정 보류 유지

현재 Q/S3 규범과 I bytes를 유지하며 입력 허용집합 축소는 별도 결정으로 남긴다.
비공백 ASCII 0x21–0x7e 후보를 path에 자동 적용해 Unicode/space를 함께 배제하지 않는다.
normalize/trim/case-fold·validator 수정·과거 값 전환은 승인하지 않는다.

### OI-F3 — B 방향 선택, exact 패키지와 구현은 미승인

**selectedOiF3Option: B / selectedBy: mposition.**
기존 F07 보장을 유지하면서 Proxy 거절 강화를 다룰 별도 exact 승인 패키지의 방향을 선택했다.
A의 실질 보장 축소는 선택하지 않았다. 현재 I가 F07을 이미 충족했다는 승인도 아니다.

사용자가 B에 결속한 조건은 다음 다섯 가지다.

1. root·nested·revoked Proxy를 별도 승인 패키지에서 명확히 다룬다.
2. bytes 입력 경계를 명확히 한다.
3. 거절 전 trap 실행 0회를 명확히 한다.
4. 기존 정상 입력의 결과 보존을 명확히 한다.
5. 임의 JavaScript 전체를 격리하는 sandbox 보장으로 확대하지 않는다.

이 조건은 **후속 패키지의 필수 명세/검증 항목**이며 현재 달성/시험 통과의 선언이 아니다.
OD-R1의 세-trap 재현이나 앞선 선택 상담의 native 판별 시험도 전체 F07 증명이 아니다.

후속 패키지는 이 조건에 더해 영향받는 C01/C02 진입점·재귀/거절 순서·입력/실행 환경 전제,
허용 builtin/import/helper·exact 파일 allowlist·T01/T11 음성 case·회귀 기준·효력 대상 SHA와
완료 판정 방법을 정해야 한다. 기존 builtin 허용 범위가 자동 확대되지 않는다.
특히 node:util의 types.isProxy 같은 후보는 **아직 채택/허용되지 않은 새 builtin 후보**다.
같은 6개 path 안에서 고치는 경우에도 새 범위 승인을 생략하지 않는다.

현재 상태는 B_direction_selected_exact_package_pending이다.
별도 패키지 작성 지시 → exact 설계·범위·시험 승인 → 별도 구현 착수 지시 전에는
code/helper/test/fixture를 변경하지 않는다. 구현·검증 전 보장 충족을 선언하지 않는다.

### OI-F4 — runner는 범위 밖 별도 작업으로 유지

Windows runner의 ENAMETOOLONG 문제는 기존 6파일 밖 후속 범위로 남기는 처리방침을 수용한다.
runner 수정·issue 생성·package/lock/config 변경을 승인하지 않는다.
후속 범위에서 package 진입점·discovery·server/client 분리·flags·누락/중복·실패 집계/exit를
보존해야 한다는 조건은 유지한다.

## 5. 기존 승인·잔여·권한 경계의 보존

S2 approvalCommit A=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
통합 승인 CA=80842e62925c05af9450e6acc6ceb70b56f67655,
D=159267a80acee97da3a297c637343ea15de725f9,
K=6b2465e921c6e8b99ff032a36be8ada61c0ad599,
H=a19ae39d0da61295eb17e1545c74bc5b7e702c1a,
Q=7e5491f5fa24295912d5da7a6cc5e86ddb637f43,
원 scope receipt commit RC=bd69a817006fb45ee88aa399940acec3d4e36470을 보존한다.
이 receipt/I/향후 B 문서는 A/CA/K/activationApprovalCommit을 치환하지 않는다.

원 decision의 400줄·§13 공란 및 승인 raw SHA
355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da,
D1–D5/§12, S1/S2 P2-N1·C-COORD-1/R-*, S3/S4 N-1/N-2 및 별도 D namespace 잔여,
HD-1–HD-8 pending/null, OP 7개, 상위 54 AC partial 9/deferred 45/fullySatisfied 0을 유지한다.

이 승인으로 새로 허용하지 않는 것은 다음과 같다.

- 기존 6파일 변경, scorer/ledger/full P/resolver/controller/운영 adapter 구현.
- 새 builtin/helper/dependency/package/lock/config/runner 또는 API 채택·수정.
- 실제 key/signature/TrustAnchor 등록, registration parser·trust digest·폐기 이력 운영.
- EnvironmentApproval/ClockPolicy/genesis/root/journal/checkpoint/proof·백업 복구 운영.
- S2 purpose 전환·activationApprovalCommit/C, dataset/manifest/register 변경.
- holdout 작성·검수·seal/open, S5/v9 prompt 작성·활성화.
- pair/예산/dispatch/re-run/provider 호출·유료 turn.
- production/Railway/DB 접속·설정·배포, release gate 또는
  memoryExtractionEnabled/memoryInjectionEnabled 변경.
- commit/push/PR/ready/auto-merge/병합/배포.

하위 verifier 동결→실제 정책 등록→trustPolicyDigest→전체 P 채택→genesis/root,
D<K<activationApprovalCommit<C, S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch
순서를 면제하지 않는다. 미래 실제 착수 tip의 승인 원문·support·환경·CI 사전 재결속과
명시적 착수 지시도 그대로 필요하다.

## 6. 제출·후속 단계 — 별도 지시 대기

이 기록은 사람 회신을 전사한 한정 receipt이며 아직 untracked다.
다음 감사 기록 commit/push/PR 요청이 오면 그 지시에 맞는 exact 파일 allowlist를 확인한다.
기존 untracked 전체나 로컬 보고서/임시 snapshot/전달 prompt를 자동 stage하지 않는다.
필요한 감사 자료의 장기 보존 범위도 제출 지시 안에서 정한다.
현재 로컬 locator/hash는 외부 첨부·임시 사본의 영구 보관이나 이미 존재하는 Git blob을 뜻하지 않는다.

허가된 제출/병합에서도 원 I 및 승인 문서 commit SHA를 보존한다.
squash/rebase/amend로 과거 승인 계보를 바꾸지 않는다.
develop의 SHA 보존 merge commit과 정확한 tip CI 확인은 별도 지시로 수행한다.
감사 기록 제출만으로 미해결 F07이나 B 구현이 승인되는 것은 아니다.
이번에는 B exact 패키지 작성·구현·Git publication을 시작하지 않았다.

## 7. 기록 작성 검증

시작 HEAD=I, branch=codex/memory-eval-vnext-offline-subset-implementation,
tracked/index clean이었다. 승인 대상 3문서, 검토 보고서·prompt·원 snapshot을 다시 읽어
raw SHA를 대조했다. 승인 대상의 pending/null도 변경하지 않았다.

기존 일반 untracked 24개와 ignored 문서 3개, 합계 **27개**의 raw hash를 보존 기준으로 삼았다.
추가 대상은 이 receipt 한 파일뿐이다. 작성 후 일반 untracked는 25개가 되며
.claude/·.codex/ directory 2개는 별도로 남긴다. 그 내부를 재귀 수집/해시했다고 하지 않는다.
승인 원문 26개·지원 9개·구현 6개의 Git/working bytes도 보존 검사한다.

로컬 PC PowerShell, H:\Project\ai-chat-hub clone 안, 기존 Node 22/dependencies로 실행했다.
production 자격증명 없이 필요한 OS/PATH/TEMP만 전달한 allowlisted child에서
기존 package script를 사용했다. 부재를 확인한 H:/Project/ai-chat-hub/.os-f4-absent-env-file을
DOTENV_CONFIG_PATH로, DOTENV_CONFIG_QUIET=true와 NEXT_TELEMETRY_DISABLED=1을
child에만 전달했다. .env/비밀값을 읽거나 원 창 환경·설정을 바꾸지 않았다.

| package script | 작성 전 exit | 작성 전 stdout+stderr SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | a023c1b4064b51f38930616299cf1b1cd344d1d96ff41f3b32025f9f9398682e |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 1 | a71fe18e693b1d3bd8a77f83701bf950e0d8cef5635c3330ba9e85d466d2ac6a |

출력 hash는 UTF-8 stdout 다음 stderr를 그대로 연결한 bytes에 대해 계산했다.
trim/개행 추가는 없으며 철회된 npm ls identifier나 과거 미제공 로그를 기준선으로 쓰지 않는다.
작성 후 같은 7개 script를 다시 실행했고 6개 exit 0, doc-references exit 1/기존 8건으로
작성 전과 exit·전체 출력 bytes·hash 7/7이 같다. 신규 실패는 0건이다.
이는 I checkout의 문서 작성 전후 대조이지 T clean-tree 전체 suite나 최신 develop CI 결과가 아니다.

doc-references의 기존 8건은 app/layout.tsx를 향한 lib/documentLanguage.ts,
app/[locale]/layout.tsx, scripts/security-regression-check.mjs,
tests/e2e/ssr-root-language.spec.ts의 Windows missing 4건과 POSIX historical unused 4건이다.
이름·내용·출력 hash로 대조하며 개수만 같다고 동일 기준선으로 보지 않는다.

strict UTF-8·YAML/JSON parse·raw SHA 결속·상대 링크·B 조건·권한 상태·BOM/CR/후행 공백·
끝 LF·diff --check·파일 보존을 별도로 확인한다.
untracked 파일별 no-index --check의 exit 1/진단 0건은 추가 diff이지 공백 실패가 아니다.
최종 metadata 전사 후에도 bytes/hash/보존을 재확인한다.

이번에는 T01/전체 suite/lint/typecheck/88-case harness, Proxy/native 판별 재현,
설치 inventory·npm ls·GitHub/CI/develop 상태를 재실행/재조회하지 않았다.
기존 구현이 그대로인 승인 회신 기록 단계이기 때문이다. 과거 보고서 실행을 이번 실행으로
복사하지 않으며, keygen/signing·provider/DB/운영 호출·dependency 설치·CI dispatch는 없다.
