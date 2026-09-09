# memory-eval vNext — IB 최초 독립 검토 후속 처리방침·계보 보완 초안

## 1. 상태와 요청 범위

**DRAFT — BI-F1–F5 처리방침 제안, 검토 결과 전사, IB의 B20 결속 및 계보 설명 보완.**
작성자 Codex, 작성일 2026-09-09, Australia/Brisbane.
새 설계 승인 패키지·authoritative human approval receipt·독립 검토 결과가 아니다.

사용자 지시:

> 네 초안 작성하셔서 커밋 및 푸시후 SHA 고정 후 독립 검토 프롬프트 주세요.

이 지시는 후속 초안 작성·한정 검사·commit/push·고정 SHA의 검토 프롬프트 작성 권한이다.
초안 내용의 최종 사람 승인·BI 경고의 외부 closure·PR/병합/운영 지시는 아니다.
source/test/fixture는 수정하지 않는다. 새 commit의 delta는 이 Markdown과
[증거 JSON](evidence/memory-eval-vnext-oi-f3-b-implementation-review-followup-2026-09-09.json) 두 파일뿐이다.
원 보고서·E0/E1·기존 PB/receipt의 bytes와 과거 상태는 보존한다.

quality-documentation-manager의 지적별 처리방침·원문 보존·변경 이력 원칙만 적용했다.
의료 QMS·새 승인 체계·전자서명/암호학적 receipt·새 실행 gate를 도입하지 않는다.

~~~yaml
recordKind: oi_f3_b_implementation_review_followup_draft
recordLabel: BF
recordStatus: draft_pending_independent_review
preparedBy: Codex
preparedDate: "2026-09-09"
preparedTimezone: Australia/Brisbane
reviewedImplementationCommit: e0a8c743695fce278592c29e85d32279fa1f2b85
implementationBasis: 75b8d9a7a5464c5d36843331a39161c3fba71fda
originalReviewReportSha256: fe678fb0e77531ce799ec3986a6d0c317da21702b29e11b83e80710f26938221
originalReviewVerdict: PASS_WITH_WARNINGS
originalFindingCounts: {P0: 0, P1: 0, P2: 0, P3: 5}
findingIds: [BI-F1, BI-F2, BI-F3, BI-F4, BI-F5]
thisDraftIndependentlyReviewed: false
isHumanApprovalReceipt: false
newHumanApproval: false
approvedBy: null
approvedAt: null
externalFindingClosureDeclared: false
sourceChangeAuthorizedByThisRecord: false
fullF07DeclaredByThisRecord: false
activationAuthorized: false
currentInstructionAllowsCommitAndPush: true
prOrMergeAuthorizedByCurrentInstruction: false
recordCommitAtPreparation: null
~~~

이 후속 두 파일의 검토 단위는 BF다. 후속 commit SHA를 이 원고에 미리 넣지 않는다.
commit 이후 Git object와 전달 프롬프트에서
이 두 파일의 path/blob/raw SHA 및 실제 reviewCommit을 고정한다.
위 pending/null은 작성 시점의 사실로 남으며, commit/push 성공이 초안 승인으로 바뀌지 않는다.

## 2. 검토 대상과 원 보고서 결속

| 역할 | 40자 identity |
|---|---|
| 최초 검토된 구현 IB / 작성 HEAD | e0a8c743695fce278592c29e85d32279fa1f2b85 |
| IB의 유일 parent / 고정 착수 tip N | 75b8d9a7a5464c5d36843331a39161c3fba71fda |
| IB tree | bae6975801c70d053ae6a8c636b4fd1a2f817728 |
| 승인된 PB R1 | f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b |
| PB 최종 승인 receipt commit | 11eac3f29b432ab721fe40ef6acb68918a1758d2 |
| 과거 offline subset 구현 I | 54ad04e29aa3390f4d342d152127e99928b4268e |

작성 branch는 codex/memory-eval-vnext-oi-f3-b-implementation이다.
작성 전 tracked/index clean이며, N..IB는 아래 5파일 M만 있다.
이는 **IB의 구현 범위**이고, IB 이후 이번 후속 기록 두 파일 추가와 구분한다.

| ID | 구현 path | IB blob OID | IB Git raw SHA-256 |
|---|---|---|---|
| C01 | lib/memoryEvalVnext/protocol/canonicalJson.ts | 4cb9e43963c6b364170794d26590a39e9404b4ac | 47075898aebb4670cdb82ba2a1593f114c11d68bd61a58e5aa1a3cd008460e8c |
| C03 | lib/memoryEvalVnext/protocol/signatures.ts | 61a6c623bf42451cfe2f22b8c76501dd271a21a5 | 839d3e35b354a375e627877067e51b1d8f8a10b9ecf315547b98784aebcdbab3 |
| C04 | lib/memoryEvalVnext/protocol/trust.ts | 0639a5010bce96c05953f0bcee336635ab7d14a1 | 8dfb79f68efc4311f2adb1cde4de3e1a96a1e35416fc0fc0fe83442248487963 |
| T01 | tests/memoryEvalVnextWire.test.mjs | b1d9ffa5b28b121f02c25e3d975cc98e30f9ea7e | d5ebde9455852b22d0334ec68d99d13653cc00ba7373df951f6d8027a8283310 |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json | 006e6efc8f170a2b5d7ad4e40f29b70b86934f22 | 136469c95aeeeacdeb0069e457476a273036e5d73964f336f2fbc6f6d4dcc70f |

C02 lib/memoryEvalVnext/protocol/wire.ts의 N/IB raw SHA-256은
f2cd8e85f3215a8b67ed23b515e83ea790c67486aac76eb02977cbd05079bb31로 동일하다.

사용자가 전달한 Claude IB 최초 독립 검토 보고서:

- 로컬 locator: C:/Users/Vyper/.codex/attachments/0a3af837-b687-4ca5-8096-b73e0398a8c8/pasted-text.txt
- raw SHA-256: fe678fb0e77531ce799ec3986a6d0c317da21702b29e11b83e80710f26938221
- raw bytes: 11,999; LF count: 137.
- 판정: PASS_WITH_WARNINGS. P0/P1/P2 각각 0, P3 5.
- 이 보고서가 검토한 대상은 IB이며 이 후속 초안이 아니다.
- 이번에는 보고서를 원문 그대로 Git에 추가하거나 편집하지 않았다.
  locator/hash는 원문 식별이며 장기 보관·검토자 인증·암호학적 서명 증명이 아니다.

아래 작성자 증거도 원 bytes 그대로 유지한다.
두 파일의 공통 디렉터리는
C:/Users/Vyper/.codex/visualizations/2026/09/06/01a074fa-17b7-7470-b0c9-e90e8234d99f/ 이다.

| 이름 | 파일명 | raw SHA-256 | bytes |
|---|---|---|---|
| E0: pre-commit 구현 증거 | memory-eval-oi-f3-b-implementation-evidence-2026-09-09.json | 41f4a3ee036be156f14714287f2b79b6a4ebec38bae3208e3ced8050784ae508 | 189585 |
| E1: 별도 IB commit 결속 | memory-eval-oi-f3-b-implementation-commit-binding-2026-09-09.json | 3e992df070cd0e6dd2069cc8f025a0a8a3b03f785bfe3c4d98aabc7116d2304a | 57237 |

세 로컬 원자료가 Git clone에 포함된다고 주장하지 않는다.
동반 JSON은 원자료 locator/hash와 필요한 관측을 결속하되 원자료 전문/검토자 로그를 대체하지 않는다.
JSON의 document는 이 Markdown raw SHA에 일방향 결속한다. 자기 hash/미래 commit을 포함하지 않는다.

## 3. 검토자가 보고한 결과 — 이번 재실행 아님

다음은 원 보고서에 귀속한다. 작성자가 이번 문서 작업에서 실행한 시험으로 복사하지 않는다.

- AC-1–AC-12 충족 판정. AC-9는 IB 직접 정적 감사, AC-10은 B21/B22 및 잔여를 함께 언급했다.
- N 격리 기준선 40/40, IB 기존40+신규19=59/59; 시나리오 이름 보존, fail/skip 0.
- 기존 external F40/F42/F43/F44 4건과 B20–B24 5건은 unit 수에 포함하지 않았다.
- package 검사7개, lint, 한정 타입 검사(TypeScript 6.0.3/진단0), diff --check 통과.
- N의 Admin run 34298297550 및 Credit run 34298297644를 직접 조회해
  headSha=N/event=push/branch=develop, 실제 job 성공을 보고했다.
  이 결과는 N CI이며 IB CI가 아니다.
- 검토 전후 tracked/index 변경0, untracked28·일반 파일25개 hash 보존을 보고했다.
  해당 검토자의 과거 파일 보존/실행/정리 행위는 보고서 관측에 귀속한다.

| 검토자 mutant | 보고된 변형 | 보고된 결과 |
|---|---|---|
| m1 | serializer isProxy 제거 | 관련 B 7개 실패 |
| m2 | copy 대신 caller 반환 | 관련 B 7개 실패 |
| m3 | new ByteArray(input) | 59/59 생존 |
| m4 | 길이0에서 set 생략 | B15/B19 실패 |
| m5 | caller.length 사용 | B12/B13/B19 실패 |
| m6 | copyByteInput의 isProxy 제거 | 59/59 생존 |
| m7 | guard를 getPrototypeOf 뒤로 이동 | m1과 같은 7개 실패 |
| m8 | 대조군 | 59/59 |

m3/m6 생존을 숨기거나 “모든 금지 편집을 행동 시험이 검출한다”고 표현하지 않는다.
특정 Node의 대체 경로가 같은 행동 결과를 보인다는 검토자 설명을 근거로 승인 알고리즘을 바꾸지 않는다.
이번 기록은 공식 API/표준을 새로 검증하거나 mutant를 다시 실행한 보고서가 아니다.

## 4. BI-F1–F5 처리방침 제안

각 행은 작성자의 **처리방침 제안/현재 사실 구분**이다.
초안 제출 지시를 최종 수용 서명으로 읽지 않으며, BI 지적을 외부 closed로 전환하지 않는다.

| ID | 성격 | 처리방침 | 이번에 하지 않는 것 |
|---|---|---|---|
| BI-F1 (P3) | 정확한 copy 알고리즘의 지속적 정적 강제 부재 | 승인된 intrinsic length → 숫자 allocation → intrinsic set을 유지. 행동 시험만으로 모든 편집 이탈을 잡지 못함을 잔여로 명시 | new ByteArray(caller) 치환, 승인 밖 새 checker/CI gate 도입 |
| BI-F2 (P3) | 선행 isProxy가 행동 시험에 고정되지 않음 | 현재 isProxy → isUint8Array 순서를 유지. m6 생존을 guard 제거 허가로 해석하지 않음 | 중복 방어라는 이유의 정리 편집, 순서 완화 |
| BI-F3 (P3) | E0의 pre-commit B20 상태 | E0를 보존하고 §5 및 JSON에서 exact IB의 commit-bound 정적 관측을 별도 결속 | E0의 null/pending 소급 수정, 문서 수정만으로 외부 closure 선언 |
| BI-F4 (P3) | 작성자 소유 Temp 사본 잔존 | 원 기록·이번 존재 확인을 구분하여 잔존 유지. cleanup 제한 우회 없음 | 삭제·이동·재사용, 검토자 소유 Temp 손대기 |
| BI-F5 (P3) | IB CI 부재와 발행 상태 | 원 검토/작성 시 미발행과 이후 명시 지시의 push를 분리. 실제 대상별 CI 관측은 그 SHA에만 귀속 | push 성공=CI 성공, N 또는 후속 SHA CI=IB CI로 치환 |

BI-F1/F2에 대한 미래 자동 정적 강제 도입은 별도 작업 범위로 판단할 수 있으나,
이번 기록이 그 설계·file/runner/CI 변경 권한을 만들지 않는다.
PB의 exact 알고리즘을 따르는 현재 IB를 유지하며, 이번 문서 작업으로 구현을 고치지 않는다.
한 번의 정적 감사는 이후 모든 편집을 막는 상시 gate가 아니다.

## 5. BI-F3 — E0 보존과 exact IB의 B20 별도 결속

E0 /staticAndExternal/B20의 status는 working_tree_static_pass_commit_binding_pending,
formalImplementationCommit은 null이다. E0 작성 당시 사실이므로 수정하지 않는다.
E1은 E0 raw hash·IB/parent/tree·다섯 blob·commit 후 검증을 이미 별도로 결속했다.
Claude도 IB에서 정적 감사를 재현해 실질적인 공백이 없다고 보고했다.

작성자는 2026-09-09T07:23:34.888Z에 exact IB Git blob을 읽어 다음을 다시 확인했다.
이는 독립 검토자의 추가 확인 검토가 아니라 **작성자의 현행 commit-bound 한정 정적 관측**이다.

- N..IB 5파일 M, 추가/삭제/rename0, IB의 유일 parent=N과 tree 확인.
- C02 raw hash 불변, 신규 runtime export는 copyByteInput 하나뿐.
- C01 신규 import node:util/types, C03/C04 추가 import copyByteInput,
  T01 상수 cross-realm 시료용 runInNewContext import.
- serializer 첫 statement는 isProxy(input) 거절.
- copy helper의 try statements는 순서대로 아래 다섯 개.
- 기존 T01 body는 신규 vm import를 제외하면 N 원문 prefix 그대로다.
- T11 원 top-level14개 값·순서 불변, proxySafety24개만 추가.
  원 fixture JSON.stringify 값 digest는
  1d286a257c44d3444de99b945a8276cd680b8b30adc41bf0fc5df32a5f4123ca다.

~~~typescript
if (isProxy(input) || !isUint8Array(input)) return invalid();
const length = applyIntrinsic(storageLength, input, []) as number;
const copy = new ByteArray(length);
applyIntrinsic(storageSet, copy, [input, 0]);
return componentValue(copy);
~~~

위 코드는 IB에 존재하는 문장의 전사이지 이번에 새로 구현한 코드가 아니다.
검사는 설치된 TypeScript parser로 Git text를 읽었으며 protocol module을 실행하지 않았다.
JSON authorObservations.staticB20에 imports/exports/순서·기존 값 대조 결과를 담는다.

B20의 **한정 정적·identity 결속 관측은 완료**로 기록할 수 있으나,
BI-F1/F2의 지속적 강제 부재가 해소된 것은 아니다.
이번 기록으로 AC 전체·F07 전체·full P·사람 승인 또는 BI-F3의 외부 closure를 새로 선언하지 않는다.
IB의 전체 AC 충족은 §3의 Claude 판정에 별도 귀속한다.

## 6. 보고서 계보 설명 보완

### 6.1 15/15 보고와 요청된 19개 구분

원 보고서 §1은 계보15/15라고 보고했다. 요청 프롬프트와 E1의
supportingSources.ancestryInN에는 19개가 있다.
15라는 보고만으로 19개 전체가 검토됐다고 전사할 수 없다.
검토자가 실제로 나머지4개를 실행하지 않았다고 추정하는 것도 아니다.

작성자가 2026-09-09T07:22:16.214Z에 **19개 각각**을 N 및 IB에 대해
git merge-base --is-ancestor로 재계산했고, 모두 exit0이었다.

| # | 재계산 대상 40자 commit | N의 조상 | IB의 조상 |
|---|---|---|---|
| 1 | 6263ecdcc1e69585498c19c0a294fef5202f5218 | true | true |
| 2 | 3f14afb29eddc243640fdb0a5a4f604646ade9f0 | true | true |
| 3 | 80842e62925c05af9450e6acc6ceb70b56f67655 | true | true |
| 4 | 159267a80acee97da3a297c637343ea15de725f9 | true | true |
| 5 | 6b2465e921c6e8b99ff032a36be8ada61c0ad599 | true | true |
| 6 | a19ae39d0da61295eb17e1545c74bc5b7e702c1a | true | true |
| 7 | 7e5491f5fa24295912d5da7a6cc5e86ddb637f43 | true | true |
| 8 | bd69a817006fb45ee88aa399940acec3d4e36470 | true | true |
| 9 | 54ad04e29aa3390f4d342d152127e99928b4268e | true | true |
| 10 | 42a99c4c5721a25b13894b99533b9800f4fb437b | true | true |
| 11 | 65b82d5670e086ca77f39050ad48e68f56433f0e | true | true |
| 12 | 60486e971c94a189ab418c4743f48428a402ea52 | true | true |
| 13 | f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b | true | true |
| 14 | 11eac3f29b432ab721fe40ef6acb68918a1758d2 | true | true |
| 15 | 38568f0cf8f88a6803bfedb76184232bef7312a6 | true | true |
| 16 | 15dd94f7f9e96aa815cca1034f1c1abf24d993a8 | true | true |
| 17 | bb9e1cd4638b01a731a145da373d40dd3391f9d0 | true | true |
| 18 | aac943b839392764224906057040282a6e78faeb | true | true |
| 19 | 8b5168e1fa0c370774784093cb73d5415a57322d | true | true |

이 19/19는 이번 작성자 관측이며 Claude의 15/15를 원 보고서 안에서 바꾸지 않는다.
보고서의 명시적 계보 나열에서 보완할 네 identity는
6263ecdcc1e69585498c19c0a294fef5202f5218,
38568f0cf8f88a6803bfedb76184232bef7312a6,
15dd94f7f9e96aa815cca1034f1c1abf24d993a8,
8b5168e1fa0c370774784093cb73d5415a57322d다.

### 6.2 N/V/W 순서와 publication branch

원 보고서 §2의 “N → V → W → 구현 IB” 나열은 조상 순서로 읽으면 잘못된다.
실제는 **V → W → N → IB**다. 여기서 화살표는 조상 관계이며 모두 직접 parent edge라는 뜻은 아니다.

- V = bb9e1cd4638b01a731a145da373d40dd3391f9d0.
- W = aac943b839392764224906057040282a6e78faeb.
- N = 75b8d9a7a5464c5d36843331a39161c3fba71fda.
- IB = e0a8c743695fce278592c29e85d32279fa1f2b85.
- V ancestor W, W ancestor N, N ancestor IB를 각각 재계산했다.
- N이 V의 조상은 아니다. branch·원문·commit bytes를 바꾸는 정정이 아니다.

N 환경 수정·사전검증 기록 publication commit
f3eb735d625f19243ebb8d26e2d78c1e181ac83c와 그 merge
8134ce445eab58f2180550eed65b17c6e871eb65는 **별도 publication 이력**이다.
IB의 조상이라고 주장하지 않으며 N/IB tree에 그 네 기록이 없는 것도 기존 고정 N 설계와 같다.
필요한 원문은 publication commit의 Git blob에서 읽는다.
PB R1·최종 approval receipt가 N/IB의 조상인 사실과 publication 기록의 위치를 혼동하지 않는다.

## 7. BI-F4/BI-F5 — 잔존·발행·CI의 시간 구분

작성자 소유 Temp locator:
C:/Users/Vyper/AppData/Local/Temp/memory-eval-oi-f3-b-8164dc5e53014b9590d70b1ed3f17dcb

E0는 복원된6 사본의 cleanup 명령이 도구 정책에 의해 실행 전 거절됐다고 기록한다.
Claude는 같은 폴더의 존재를 보고했으며, 이번에도 존재 여부만 확인했다.
이번에는 폴더 내부를 읽거나 재검증·삭제·이동하지 않았다.
사본 내용이 지금도 전부 같은지는 이번 관측 범위 밖이며, 존재 확인을 내용 무결성 확인으로 읽지 않는다.
Claude 소유 C:/Users/Vyper/AppData/Local/Temp/ib에도 손대지 않았다.
코드 정합성 판단은 Temp 사본이 아니라 IB Git blob에 귀속한다.

BI-F5의 시점은 다음처럼 분리한다.

| 시점 | 관측/권한 | 한계 |
|---|---|---|
| IB 최초 독립 검토 | 보고서: IB local-only, upstream 없음, exact IB workflow0 | 보고서 당시 상태 |
| 이번 초안 작성 전 | exact branch 원격 ref 부재, IB exact workflow 조회0 | 이번 읽기 전용 관측; CI 통과 아님 |
| 현재 명시 지시 | 초안 commit/push와 SHA 고정 프롬프트 작성 허용 | PR/merge/CI dispatch 권한 없음 |
| 이후 발행 | IB를 parent로 하는 두 문서 commit을 만들고 해당 branch를 push할 예정 | 실제 SHA/원격 일치는 발행 후 외부 기록에서 확인; 미리 성공 선언하지 않음 |

현재 branch에는 to-develop 경로 조각이 없고 기존 auto-PR 정책상 자동 PR 대상이 아니다.
PR Fast Gate는 pull_request, Admin/Credit의 push는 develop/main 대상이다.
따라서 이번 feature branch push만으로 해당 필수 검사들이 실행된다고 가정하지 않는다.
BI-F5를 없애려고 workflow를 바꾸거나 CI를 수동 dispatch하지 않는다.

후속 문서 commit의 CI가 존재하더라도 그 headSha·event·실제 실행 범위를 별도로 기록해야 한다.
IB와 구현5파일 bytes가 같다는 사실을 함께 설명할 수 있으나, 다른 SHA의 CI를 IB CI라고 부를 수 없다.
PR이 필요하면 별도 지시를 받고 생성한다. future PR merge ref/후속 merge/develop CI도 각각 구분한다.

## 8. 기존 승인·보류와 금지 범위 보존

[PB R1 원문](memory-eval-vnext-oi-f3-b-approval-package-draft-2026-09-08.md)의 raw SHA는
a2241c6f48dc79d43ebf159494bdeadbf06c0e86de6db05fdcff4f00a77be9a9,
[PB JSON](evidence/memory-eval-vnext-oi-f3-b-approval-package-2026-09-08.json)은
3e400844dbdda306b5697f40328e673f7d037a5e84cf2124b1193f301a703399다.
[PB 최종 receipt](memory-eval-vnext-oi-f3-b-approval-2026-09-08.md)의 raw SHA는
03286ef63c1cba204254592535d1ab7fa7e2e47665fd0eee215e6e910ba0ad32다.
기존 mposition/2026-09-08/decision=yes는 **R1 두 bytes**에 대한 승인이지
IB·검토 보고서·E0/E1·이 초안의 hash에 대한 새 승인으로 전사하지 않는다.

- 원 decision 400줄/§13 공란, SHA
  355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da 보존.
- 기존 S2 approvalCommit=3f14afb29eddc243640fdb0a5a4f604646ade9f0를 IB/BF/PB receipt로 치환하지 않음.
- OI-F1 timing gap accepted residual/closure=false, OI-F2 별도 ID/path,
  OI-F4 별도 runner 범위, ODR-F1 외부 closure 없음 유지.
- 상위54 AC partial9/deferred45/fullySatisfied0 유지.
- PB R1 문서 확인 검토1/1 소진. IB 최초 구현 검토와 이번 후속 기록 최초 독립 검토는 별도 대상.
  기존 회차를 초기화하거나 후속 수정/재검토를 자동 승인하지 않음.
- runtime/intrinsics 신뢰 전제, 동시 storage 원자 snapshot 및 일반 JavaScript sandbox 보장 없음.
- C02 또는 구현 source/test/fixture 추가 변경, dependency/package/lock/config/runner/workflow 변경 없음.
- scorer/ledger/full P/resolver/controller/운영 adapter, key/signature/trust 등록·폐기·
  genesis/root/journal/checkpoint/backup 운영 없음.
- S2 purpose/activationApprovalCommit/C, dataset/manifest/register, holdout 작성/seal/open,
  S5/v9 prompt, pair/예산/dispatch/provider·DB·Railway·production·배포·release gate,
  memoryExtractionEnabled/memoryInjectionEnabled 변경 없음. 운영 flag 값은 조회하지 않음.

## 9. 이번 문서 작성의 한정 검증

작성 시작 2026-09-09T07:22:16.214Z에 HEAD=IB, tracked/index clean을 확인했다.
IB5개 blob/working raw, 원문36개(C02 포함), support9, E0/E1/보고서3개,
기존 일반 untracked를 합친 보호78개 raw hash를 기록했다.
기존 untracked status는28개이며 .claude/·.codex/·human-review-ai-output/ 내부 전수 수집은 하지 않았다.
지원파일·node_modules hidden lock hash는 기존 결속과 동일하며 설치·설정은 바꾸지 않았다.

로컬 PC PowerShell, H:/Project/ai-chat-hub, 기존 Node v22.22.2/V8
12.4.254.21-node.39/win32 x64에서 production 자격증명 없이 실행했다.
OS/PATH/TEMP/user-cache 변수만 child에 allowlist로 전달하고, 부재 확인한
.os-f4-absent-env-file을 DOTENV_CONFIG_PATH로 지정했다.
DOTENV_CONFIG_QUIET=true/NEXT_TELEMETRY_DISABLED=1도 child에만 적용했다.
원 창 환경·.env·token/비밀값은 읽거나 바꾸지 않았다.

작성 전 clean IB 기준 다음 package script7개가 전부 exit0이었다.
명령은 package.json의 npm run <script>를 그대로 사용했다.

| script | 작성 전 exit | 작성 전 stdout 뒤 stderr raw SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | 977d7445bb324592e78c28046fc18cbf6b2bd96adaa6f42daea9ad27f313ba67 |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | bd319f6811e95143ff00576ed7b9996c71b667332b76e5149e9fe64460745ca6 |

두 파일 작성 후 같은7개 script를 재실행해 모두 exit0, 작성 전후 출력 SHA 7/7 동일을 확인했다.
기준선 실패·작성 후 실패·신규 실패 이름은 모두0이다. 실제 출력·시각은 동반 JSON
validation.afterWriting에 별도로 결속한다. 결과 전사 뒤에도 fatal UTF-8/JSON/YAML·상대 링크·
raw hash·Git 범위/whitespace·보호 파일 검사를 재확인한다.
audit 문서는 일반 doc-reference/policy 검사에서 제외되는 등 한계가 있어 수동 결속 검사가 필요하다.
원 JSON 자체 hash나 미래 commit을 본문에 넣지 않아 자기참조를 만들지 않는다.

이번 작업에서 T01/전체 unit/lint/typecheck/build/E2E/Proxy probe/민감도 시험/
Node 공식 API 검증을 새로 실행하지 않았다. §3 결과는 Claude의 과거 검토에 귀속한다.
GitHub 조회는 exact IB workflow 목록과 원격 ref 읽기만이며 운영/CI dispatch는 하지 않았다.
검증 완료 후 현재 지시에 따라 두 파일만 stage/commit/push하고 원 SHA를 보존한다.
새 후속 commit에 대한 독립 검토는 이 초안 두 파일·근거 전사·처리방침·계보 보완 한정으로 요청한다.
이 기록 자체가 구현 수정·PR/merge·activation의 시작 명령이 되지 않게 한다.
