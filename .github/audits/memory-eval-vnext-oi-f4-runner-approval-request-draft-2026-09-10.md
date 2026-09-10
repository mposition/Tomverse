# memory-eval vNext — WR-1 Windows unit runner 승인 요청 초안

**DRAFT / UNSIGNED — 사람 판정 대기. 승인 receipt가 아니다.**
작성자: Codex. 작성일: 2026-09-10. 작성일은 승인일이 아니다.
요청 식별자: oi_f4_runner_wr1_exact_approval_request_2026_09_10.

사용자의 “네 그렇게 해주세요. 독립검토는 따로 필요없을까요?”는 WR-F1 보완과 승인 요청
초안 작성 지시다. WR-D1–WR-D5 승인이나 추가 독립 검토 부재의 수용 판정으로 전사하지 않는다.
과거 승인자의 이름·날짜를 이번 승인 칸에 채우지 않는다.

## 1. 정확한 승인 대상

대상은 아래 **WR-1 수정본의 working raw bytes**다. 두 수정 파일은 아직 commit하지 않았다.
HEAD의 R=3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9는 검토받은 원본을 가리키며
이번 수정본이 아니다. R을 수정본의 documentCommit/reviewCommit으로 대용하지 않는다.

| 승인 요청 대상 path | raw SHA-256 | bytes / LF |
|---|---|---|
| .github/audits/memory-eval-vnext-oi-f4-runner-approval-package-draft-2026-09-10.md | 420f8876d9e6e472345ff5a953ea446db16a862b48b28242fa460de14ac80381 | 31888 / 399 |
| .github/audits/evidence/memory-eval-vnext-oi-f4-runner-approval-package-2026-09-10.json | ccc42634c68571878572eb24c4b6b6890fd334712f3c88050eb318ba2fc5ece5 | 128509 / 2702 |

[수정 패키지 Markdown](memory-eval-vnext-oi-f4-runner-approval-package-draft-2026-09-10.md)과
[수정 evidence JSON](evidence/memory-eval-vnext-oi-f4-runner-approval-package-2026-09-10.json)의
전체 문언·범위·잔여가 대상이다. JSON.document.rawSha256은 위 Markdown만 결속한다.
보고서 hash, 원본 R의 hash, 이 요청문 hash를 승인 대상 hash로 바꾸어 쓰지 않는다.

향후 commit할 때 두 blob raw SHA가 이 표와 같아야 한다. 승인 후 bytes가 달라지면
그 변경을 숨겨 같은 승인으로 처리하지 않는다. 별도 authoritative receipt는 이 exact 대상과
사람 메시지를 결속하며, 이 초안 자체에 서명을 채워 원문을 변경하지 않는 방식을 따른다.

~~~yaml
recordKind: oi_f4_runner_wr1_exact_approval_request
recordStatus: pending_human_approval
approvalTargetKind: exact_working_file_bytes
packageRevision: WR-1
repository: mposition/Tomverse
repositoryBasis: 7bce6df0e2ff55d50d24e23c172aa831b09e7c15
reviewedOriginalCommit: 3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9
revisedPackageCommit: null
revisionIndependentReviewCommit: null
requestCommit: null
decision: pending
approvedBy: null
approvedAt: null
requiredDecisionIds: [WR-D1, WR-D2, WR-D3, WR-D4, WR-D5]
acceptedDecisionIds: []
acceptWrF1AuthorDisposition: pending
acceptNoAdditionalIndependentReview: pending
acceptDisclosedConfigProvenanceLimit: pending
implementationChangeAuthorizedNow: false
implementationStartAuthorizedNow: false
publicationAuthorizedNow: false
activationAuthorized: false
paidExecutionAuthorized: false
oiF4ClosureDeclared: false
~~~

## 2. 최초 검토와 WR-F1 처리 — 판정 귀속을 분리

Claude의 최초 독립 검토는 원본 R에 대해 PASS_WITH_WARNINGS였다.
승인 차단 0건, P3 경고 WR-F1 한 건이며 원문 대상은 다음과 같다.

| R의 검토 대상 | 당시 raw SHA-256 |
|---|---|
| 패키지 Markdown | 7bdc313a124faec6daad5b030faf75f7adb79f1c7cb679f255edb303051f890b |
| evidence JSON | 686ad8eda4ba266be3e9ebf8f78a17da3a838cdfb740411b70f99c4b1a2c26e5 |

사용자 제공 보고서 raw SHA-256:
d0ea75c475e42e9ca41434547731b9a4a9e1a0e0fa31ab8b7160e16d9f7418a8.
크기 23,214 bytes, LF 191.
locator: C:/Users/Vyper/.codex/attachments/b937844e-b232-4b75-a44b-69c1bd47bb16/pasted-text.txt.
locator는 로컬 수신 위치이며 영구/Git 보관을 뜻하지 않는다. hash는 원문 식별이지 작성자 암호 인증이 아니다.

WR-F1의 지적은 “현행 status 전달과 제안의 범위 밖 status 처리 차이를 승인자에게 명시”하는 것이다.
작성자는 이를 다음처럼 반영했다.

- 패키지 §6: 현행 result.status ?? 1 / clientResult.status ?? 1의 범위 검사 없는 전달과,
  제안의 비정상 중단·최초 nonzero 보존/없으면 1을 비교했다.
- POSIX 종료 status의 하위 8비트 경계를 이유로 설명하고, 이미 status 0으로 잘려 전달된
  원래 값을 복원하는 보장은 없다고 한계를 밝혔다.
- WR13의 Markdown/JSON expected를 같은 문구로 보완하고 Markdown raw SHA를 재결속했다.
- WR-D1–WR-D5의 값·분류·16,000 budget·3파일 범위·20개 검증 그룹·금지 영역은 바꾸지 않았다.
  특히 앞의 nonzero를 나중의 1로 무조건 덮어쓰는 새 규칙을 만들지 않았다.

처리 상태는 **author_addressed_pending_human_acceptance**다.
WR-1에 대한 추가 독립 검토는 없고, CONFIRMED 또는 외부 finding closure를 주장하지 않는다.
최초 검토 1회, 변경분 확인 검토 0회다. 원본 R은 amend/rebase 없이 Git 이력에 보존한다.

## 3. 추가 독립 검토에 대한 판단 요청

작성자 권고는 **이 설명 보완 때문에 전체 독립 검토를 반복하지 않는 것**이다.
WR-F1은 P3·비차단이고 기존 제안의 동작을 바꾼 것이 아니며, 직접 diff/JSON 구조 대조로
실행 정책·budget·범위가 그대로인 것을 확인했다. 이 요청문은 그 exact 범위를 전사한다.

그러나 추가 검토를 하지 않아도 된다는 작성자의 권고는 사람 판정이 아니다.
사람에게는 **수정 차이, WR-1의 추가 독립 검토 부재, 원본 R 판정의 한정 귀속**을
함께 수용할지 요청한다. 기존 PASS_WITH_WARNINGS를 WR-1이나 이 요청문의 PASS로 소급하지 않는다.
원하면 WR-F1 변경분 확인 검토를 요청할 수 있다. 새로운 정책·값·범위 변경이나 차단점이
발견되면 이 간단한 보완에 섞지 않고 별도 범위로 다룬다.

## 4. WR-D1–WR-D5 전체 승인 요청

아래 다섯 결정과 패키지 전체 제한·잔여를 함께 승인할지 요청한다. 현재 전부 pending이다.

| 결정 | 승인 요청 내용 |
|---|---|
| WR-D1 | Windows 16,000 UTF-16 보수 예산·최대 prefix 분할·양쪽 lane 사전 검사·파일 skip/retry 금지 |
| WR-D2 | 원 discovery·server/client 경계·flags·순차 실행·비-Windows 단일 spawn 및 명시한 한계 |
| WR-D3 | 일반 실패 누적, 최초 nonzero 보존, 비정상 중단/정규화 및 WR-F1로 설명한 현행과의 차이 |
| WR-D4 | 아래 R01–R03 세 파일, 정확한 import/export·안전한 임시 fixture 범위만 향후 구현 |
| WR-D5 | WR01–WR20 명세, 실제 Windows/Linux 검증과 기존 실패 대조, 결과 수용/closure 경계 |

향후 구현 범위는 scripts/run-unit-tests.mjs 수정,
scripts/run-unit-tests-core.mjs 신규, tests/unitTestRunner.test.mjs 신규의 세 파일뿐이다.
실제 구현은 없고 두 신규 경로도 아직 없다. 세 파일의 세부 책임은 수정 패키지 §7 그대로다.

승인하더라도 **즉시 구현 착수 지시가 아니다.** exact 승인 receipt의 Git 결속,
원 SHA를 보존한 develop merge commit 반영·CI 확인, 실제 착수 tip의 지원 파일 9개·
발견 목록·실행 환경·승인 ancestry 재검증, 새 codex/ branch와 별도 명시적 착수 지시가 선행한다.
이번 초안 작성 지시에는 commit/push/PR/병합도 포함되지 않았다.

package/lock/설치/tsconfig/workflow/release gate, 기존 승인 bytes,
scorer/ledger/protocol/M3/M6·기존 시험/fixture, dataset/manifest/register/purpose activation,
holdout/S5/v9·pair·key/운영 서명·full P 동결·예산/dispatch/provider·운영 DB,
memoryExtractionEnabled/memoryInjectionEnabled 변경은 승인 범위가 아니다.
Git config·stash·기존 untracked·.env 변경도 허용하지 않는다.

## 5. 검증 결과와 남는 한계

수정 전 clean R과 수정 후의 같은 npm script를 이름별로 대조했다.
check:encoding:strict, check:policy-section-references, check:release-records,
check:memory-eval-succ9, check:memory-extraction-eval, check:memory-eval-freeze,
check:doc-references **7개 모두 exit 0이며 출력 SHA도 동일**했다.
test:unit은 두 경우 모두 exit 1이고 native ENAMETOOLONG/status null/출력 0이 같다.
새 검사 실패는 없다. 설치 불일치나 전체 unit PASS로 바꾸어 표현하지 않는다.

원본 JSON과 기계 대조하여 현재 상태·Markdown hash·WR13 expected·처리 이력 구획 외 의미가
바뀌지 않았음을 확인했다. 실행 정책·예산·3파일 allowlist·다른 19개 expected와
과거 baseline/provenance/documentationValidation은 불변이다.
strict UTF-8/BOM 없음/LF/후행 공백·MD hash binding·20개 case mapping·상대 링크·
diff --check 및 보호 파일 65개를 검사했다. 세부 관측은 JSON.revisionReviewDisposition에 있다.

이 작업에서는 WR01–WR20/T01·새 runner·POSIX exit 또는 Windows crash probe를 실행하지 않았다.
미래 시험은 not_run이다. 문서 검증은 구현 완료·전체 unit 통과·OI-F4 closure를 뜻하지 않는다.

.git/config의 과거 4b07f53f…→74daa333… 변경 주체와 정확한 내용 차이는 여전히 미확인이다.
수정 착수 시 현재 값은 기록된 이후 hash와 같았고, 작성자가 덮어쓰거나 해소했다고 주장하지 않는다.
이 한계는 수정 패키지 §11과 JSON.preservationException의 전체 문언대로 수용 여부를 판단한다.
원문/승인 계보의 불일치를 발견했다는 뜻도 아니며, 과거 보존 PASS로 바꿀 근거도 아니다.

## 6. 사람에게 남은 판정

이 요청문과 위 두 exact 수정 파일을 확인한 뒤 다음을 함께 수용할지 판단한다.

1. WR-D1–WR-D5 및 패키지의 전체 범위·조건·잔여.
2. WR-F1의 작성자 보완과 **WR-1 추가 독립 검토 없음**.
3. config provenance 미확인 및 구현/전체 unit/closure 미완료의 구분.
4. 승인 후에도 Git 계보·CI·실제 착수 재검증·별도 착수 지시가 선행한다는 조건.

decision/approvedBy/approvedAt은 실제 사람 메시지로만 별도 receipt에 기록한다.
이 초안의 작성·검증·“준비해 주세요” 지시는 그 서명을 대신하지 않는다.
