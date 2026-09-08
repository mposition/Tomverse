# Memory eval vNext S2 명확화 — D 승인 요청 초안 (2026-09-07)

**상태: DRAFT / UNSIGNED — 사람의 문서·정책·잔여 판정 대기, 승인 효력 없음.**
작성자: Codex. 작성일은 승인일이 아니다. 이 문서는 K도 activation approval receipt도 아니다.

사용자의 이번 “네 진행해주세요”는 **검토된 문서 D의 commit 및 승인 요청 초안 작성**에 대한
지시다. 아래 D 문서 승인, F-2 정책 네 항목, N-1~N-3 잔여 수용으로 전사하지 않는다.
기존 mposition / 2026-09-07 승인도 이번 새로운 판정의 승인자·승인일로 복사하지 않는다.

## 1. 사람이 판정할 대상과 현재 상태

다음 YAML은 **승인 요청용 상태표**이며 D의 closed ClarificationApproval wire object가 아니다.
pending/null/빈 accepted 목록은 실제 미판정을 뜻한다. 미래 승인 JSON을 미리 만든 것이 아니다.

```yaml
recordStatus: draft_unsigned
recordKind: s2_activation_clarification_approval_request
decision: pending
approvedBy: null
approvedAt: null
repositoryId: "1289709524"
repositoryBasis: "75c667054dd6fd1b6adff1e813cf23e3ef43ca00"
approvalScope: s2_activation_clarification_contract_only
document:
  commit: "159267a80acee97da3a297c637343ea15de725f9"
  path: ".github/audits/memory-eval-vnext-s2-activation-clarification-revised-draft-2026-09-07.md"
  rawSha256: "7ce66bb7386c5b55509b054170c1fdedc65cb505b40512823ddb282c83c3ca98"
documentGitBlobOid: "69aac932970fc0950cef1fedbf45bb51acab4220"
documentBytes: 56169
documentLines: 820
decisionApprovalCommit: "3f14afb29eddc243640fdb0a5a4f604646ade9f0"
contractApprovalCommit: "80842e62925c05af9450e6acc6ceb70b56f67655"
clarificationApprovalCommit: null
activationApprovalCommit: null
policyAcceptance:
  activationApproverSignature: null
  trustBootstrapBeforeActivation: null
  sourceEvidenceProfile: null
  clarificationApprovalLayer: null
residualNamespace: s2_clarification_confirmation_2026_09_07
requiredResidualIds: ["N-1", "N-2", "N-3"]
acceptedResidualIds: []
reviewAndLimitationsAcknowledged: null
upstreamApprovalsAndConditionsPreserved: null
implementationAuthorized: false
activationAuthorized: false
paidExecutionAuthorized: false
```

D는 이번에 고정한 **문서 commit**이다. parent는 repositoryBasis이며 basis 대비 변경은
document.path 한 파일의 추가뿐이다. 문서 raw SHA-256은 Claude 확인 검토 대상과 정확히 같다.
Git blob OID는 commit SHA가 아니며 raw SHA-256과도 다른 식별자다.

원문의 Draft·확인 검토 예정·정책 승인 대기·미커밋 표시는 작성 시점의 문구로 보존한다.
D commit을 만들었다는 사실 때문에 그 문구를 수정하지 않는다. 문서 고정과 후속 사실은
별도 기록으로 읽는다. D가 생겼어도 K·activationApprovalCommit은 아직 없다.

## 2. 독립 검토와 D의 bytes 연결

| 구분 | 고정 대상 / 결과 |
|---|---|
| 최초 검토 대상 | 최초 명확화 초안 raw SHA-256 ccb1af8d606cc27fb30b1654712f9e61065b8a2d2e8123d25dd64c91f0c07f65, 33,376 bytes / 500 LF lines |
| 최초 결과 | PASS_WITH_WARNINGS, 0 P1 / 2 P2 / 4 P3 |
| 확인 검토 모드 | sha256_pinned_draft; reviewCommit=null; confirmation_1_of_1 |
| 확인 대상 | D에 저장한 동일 raw SHA-256 7ce66bb7386c5b55509b054170c1fdedc65cb505b40512823ddb282c83c3ca98 |
| 확인 결과 | CONFIRMED_WITH_WARNINGS — F-1~F-6 기술적 closure yes, 수정 회귀 없음; F-2 사람 정책 승인 pending 및 N-1~N-3 잔여 |
| 확인 보고서 원문 | C:/Users/Vyper/.codex/attachments/5d2cea28-1d56-4419-b431-045d1348aeba/pasted-text.txt |
| 확인 보고서 raw SHA-256 | 52ea1b94d745142eef9347aff9e831e0c8364cc83014ec1773571471d1f14b38 |
| 확인 보고서 길이 | 10032 bytes |
| 최초 보고서 원문 | C:/Users/Vyper/.codex/attachments/2beaf1df-8e13-4785-8966-d998da35292c/pasted-text.txt |
| 최초 보고서 raw SHA-256 | 51f1bef7622ad50cc42ee6ac00e28f085d10bfbd10f39c2b8c43cafa4cb73209 |

확인 검토 때에는 D가 없었다. 따라서 **reviewCommit을 D로 소급 기입하지 않는다.**
고정 초안 raw bytes = D의 Git blob raw bytes라는 별도 대조로 문서 commit과 검토를 연결한다.
확인 보고서는 사용자 제공 Claude 결과이며, 이번 전사를 새 독립 검토라고 부르지 않는다.
확인 검토 1회는 소진됐다. 추가 자동 수정·확인 검토 루프는 시작하지 않는다.

원 보고서는 위 로컬 첨부에 있고 D commit에 포함되지 않았다. D commit message는 확인 결과와
보고서 SHA를 기록하지만 보고서 원문 자체나 사람 승인 receipt를 대신하지 않는다.
이 승인 요청 초안도 Claude의 검토 대상이 아니다.

보고서가 밝힌 미검증 범위는 그대로 유지한다: 122 closure 재실행, 1,150 case 재구성,
준비 JSON의 identity/frozen/genesis/transition digest 재계산, GitHub run 전체 재수집,
실제 proof·서명. 기술적 closure를 activation_complete나 운영 검증 완료로 승격하지 않는다.

## 3. F-2 — 네 정책의 명시적 수용 요청

**모두 현재 pending이다.** 아래 값은 D가 요구하는 승인 시의 선택값이며 실제 수용 기록이 아니다.
문서의 일반 승인만으로 네 항목을 자동 채우지 않는다. 한 사람이 여러 역할을 맡더라도
S3/S4의 역할별 등록·권한·epoch 및 key 보관 조건은 계속 필요하다.

| 정책 field | D가 제안한 값 | 사람이 판단할 내용 | 현재 판정 |
|---|---|---|---|
| activationApproverSignature | ed25519_required | 실제 activation 사람 approver가 등록 Ed25519 key/epoch로 ActivationAuthorization을 서명한다. plain 사람 receipt만 있던 S2보다 강화된 새 정책이며 key 보관·등록 책임이 선행된다. | pending |
| trustBootstrapBeforeActivation | true | 새 purpose 세 개·D/K·signer 역할을 승인된 bootstrap 및 S4 trust root에 activation 전에 결속한다. 지금 key/TrustAnchor를 만들거나 검증했다는 뜻은 아니다. | pending |
| sourceEvidenceProfile | exact_15_roles_with_closed_proofs | exact 15-role, 네 SourceProof kind와 역할별 필수 증거, register 교차 검증, historical checker 재현 요구를 수용한다. 실제 증거 보존·재현 비용이 남는다. | pending |
| clarificationApprovalLayer | separate_K | 기존 A/CA를 바꾸지 않고 D의 bytes를 승인한 별도 K를 둔다. K는 activation 승인 commit과 분리된다. | pending |

사람이 plain receipt + importer 서명만을 선택하면 D의 다른 유효 입력을 고른 것이 아니라
D와 다른 설계를 요구한 것이다. wrapper·approvalReceiptDigest·role·수용 기준에 대한 별도
계약 변경 지시가 필요하며, 이 요청 초안을 통해 대안을 자동 채택하거나 구현하지 않는다.

## 4. N-1~N-3 — 잔여 수용 요청 (수정·완료·면제 아님)

아래 ID는 **이번 S2 명확화 확인 보고서의 N-1~N-3**이다. 과거 S3/S4 승인에서 사용한
동명 N-1/N-2와 다르며 §2의 확인 보고서 SHA 및 residualNamespace로 구분한다.

| ID / 심각도 | 보고된 잔여 | 수용하더라도 유지되는 경계 | 현재 판정 |
|---|---|---|---|
| N-1 / P3 | S4 ApiCapture에는 요청 header가 없다. D의 wrapper.apiVersion이 요청 값의 증거 자체인지, 별도 관측을 요구하는지 문언상 두 해석이 남는다. | 요청 사실을 지어내거나 응답 header를 독립 요청 증거로 승격하지 않는다. 검토자의 importer attest 문구 제안은 D에 반영되지 않았고 이 잔여 수용으로 자동 채택되지 않는다. | pending |
| N-2 / P3 | V checker 8개 rule 중 하나는 discards:false이므로 일반적으로 NOTE가 될 수 있다. D는 전부 OK를 요구하며 이번 exact subject는 그 조건을 만족할 수 있다고 검토됐다. | D의 전부 OK 요구를 exit 0만으로 완화하지 않는다. STOP 0·NOTE 0 표기 제안은 아직 원문 변경이 아니며 다른 subject로 예외를 확장하지 않는다. | pending |
| N-3 / P3 | ReplayEnvironment 세 field는 network 차단의 실제 관측 증거를 담지 않는다. runtime record는 hermetic image·무접촉 인증이 아니다. | 실제 차단 환경 요구는 유지된다. EnvironmentAttestation 등 보완 형식을 이번에 만들거나 채택하지 않았으며 자기 선언만으로 차단·무접촉을 인증하지 않는다. | pending |

여기서 요청하는 것은 **이 한계를 인지한 상태에서 D의 exact bytes를 부속 계약으로 승인할지**
판단하는 일이다. 잔여 수용은 경고 해결, 실행 전 검증 면제, 덜 엄격한 해석의 선택 또는
실제 network/provenance 검증 완료가 아니다. 향후 실행 판단에 영향을 주는 모호성이 남거나
필수 조건을 입증하지 못하면 실행을 멈추고 별도 사람 지시를 구한다.

D를 고쳐야 한다고 판단하면 현재 bytes의 승인을 보류한다. 이 작업에서 임의 수정·D amend·
확인 검토 2회차를 하지 않는다. 승인 요청은 해결되지 않은 경고를 숨기지 않고 넘기는 절차다.

## 5. 기존 승인과 실행 범위는 유지

S2 approvalCommit은 A, contractApprovalCommit은 CA 그대로다. D/K로 치환하지 않는다.

| 기존 근거 | documentCommit | raw SHA-256 |
|---|---|---|
| 원결정 | 3f14afb29eddc243640fdb0a5a4f604646ade9f0 | 355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da |
| 원결정 approval receipt | 3f14afb29eddc243640fdb0a5a4f604646ade9f0 | 838af4d1fee11122b5a2ec6b72d5ed905a59b2b370ec2d7b88e87bdd193291f5 |
| S1 | fa682cc2209fc5b0a9ebd994aa626d00997b0359 | 393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7 |
| S2 | fa682cc2209fc5b0a9ebd994aa626d00997b0359 | e9a6a086be32e4d12df776015959c7c95be5185af7dc635403e8cd6689f4baa5 |
| S3 | 4d8a7c317b570e0c30fc5a05438cb7cc78354039 | 66a29c01dd5e2d099817ee799afc960f090e93f900be53b546b8b73f4d3b3d05 |
| S4 | 4d8a7c317b570e0c30fc5a05438cb7cc78354039 | e7bc98a98a6e03b31403061312e5c6abab10e7e27456f1077d3a68362ede67bb |
| S1–S4 통합 receipt (CA) | 80842e62925c05af9450e6acc6ceb70b56f67655 | 63c829366e1315f482e7891ee8c59992215bf949eed3f1d0d34ae224f9c06c77 |

각 파일은 .github/audits/의 기존 원결정·receipt·S1 scoring·S2 purpose·S3 holdout·S4 provenance·
S1–S4 contract approval 원문이다. 정확한 경로는 D의 고정 원문 표와 기존 통합 receipt를 따른다.
원결정 D1–D5 및 §12, S1/S2·S3/S4·통합 승인 전체의 조건·잔여를 면제하거나 소급 변경하지 않는다.
원결정 §13 공란, 역사 @mposition 표기, historical 122/forward 109, v8 FAIL·revoked도 보존한다.

이 부속 계약을 승인하더라도 다음은 이번 승인의 권한이 아니다.

- S2 실제 activation·purpose 전환, resolver/scorer/validator/ledger/controller/custody/importer 구현
- 테스트 코드·workflow·DB·key·암호 서명·TrustAnchor·proof·checkpoint의 실제 생성/운영
- dataset·manifest·register·기존 approval·budget·prompt 변경
- holdout 작성·봉인·개봉, S5/v9 작성·활성화
- pair·예산·dispatch·provider probe·유료 호출, ordinal 2 실행
- release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경
- 운영 자격증명·GitHub protection·production 설정 변경
- push·PR·ready·auto-merge·병합·배포

## 6. 사람이 답할 항목과 후속 K 경계

아래는 **회신용 빈 양식**이며 제출된 승인이나 승인 예시가 아니다. 사람의 실제 응답을 받은 뒤
에이전트가 판정·승인자·승인일·수용 내용을 기록한다. 파일의 승인 칸을 사람이 직접 편집할 필요는 없다.

```text
D 문서 승인 여부: 미회신
대상 D: 159267a80acee97da3a297c637343ea15de725f9
대상 문서 SHA-256: 7ce66bb7386c5b55509b054170c1fdedc65cb505b40512823ddb282c83c3ca98
activationApproverSignature = ed25519_required 수용 여부: 미회신
trustBootstrapBeforeActivation = true 수용 여부: 미회신
sourceEvidenceProfile = exact_15_roles_with_closed_proofs 수용 여부: 미회신
clarificationApprovalLayer = separate_K 수용 여부: 미회신
이번 확인 보고서의 N-1 / N-2 / N-3 잔여 수용 여부: 각각 미회신
기존 승인·조건·실행 제한 유지 및 이 승인 요청 초안 전체 문언 수용 여부: 미회신
승인자: 미회신
승인일: 미회신
```

명시적으로 전부 수용한 사람 회신과 별도 기록/commit 지시가 있어야 K를 만든다.
K의 고정 경로는 .github/audits/evidence/memory-eval-vnext-s2-activation-clarification-approval.json이며
D가 정한 **9개 field의 ClarificationApproval**을 CJSON + LF로 보존해야 한다.
이 요청용 YAML을 복사하거나 N-1~N-3/report/서명 field를 closed JSON에 추가하지 않는다.
실제 사람 발언·이 요청 초안의 승인 당시 raw hash·확인 보고서·잔여 수용은 별도 감사 기록으로
결속할 수 있지만 K schema를 변경하는 근거가 되지 않는다. 이 초안은 authoritative receipt가 아니다.

D는 K의 strict ancestor이고 CA는 K의 ancestor여야 한다. K가 나중 생겨도 실제
activationApprovalCommit과 C는 별개며, K → activationApprovalCommit → C의 선행 순서를 지킨다.
후속 develop 반영은 D/K와 원래 승인 SHA를 보존하는 merge commit 방식이고 squash/rebase를
하지 않는다. develop 반영·CI 확인 뒤 그 tip에서 별도 지시된 activation 패키지 재계산을 시작한다.
이번 D는 아직 push·develop 반영되지 않았으며 원격 CI를 새로 실행·확인한 것으로 보고하지 않는다.

## 7. 이번 기록 작업의 검증 범위

D commit 전 tracked clean basis와 D 한 파일 staging 후 다음 package script를 각각 실행했다.

| 검사 | 기준선 / staged 결과 |
|---|---|
| check:encoding:strict | exit 0 / exit 0 |
| check:policy-section-references | exit 0 / exit 0 |
| check:release-records | exit 0 / exit 0 |
| check:memory-eval-succ9 | exit 0 / exit 0 |
| check:memory-extraction-eval | exit 0 / exit 0 |
| check:memory-eval-freeze | exit 0 / exit 0 |
| check:doc-references | exit 1 / exit 1; 아래 기존 8건 이름 동일, 신규 0 |
| strict UTF-8 / raw hash / staged blob와 working bytes | 직접 검사 통과; D 대상 56,169 bytes / 820 LF lines |
| git diff --check / staged diff --check | 통과; staged 파일은 D 문서 한 개 |

문서 참조의 기존 8건은 app/layout.tsx를 향한 다음 네 missing 및 네 unused historical entry다.

- missing: lib\documentLanguage.ts
- missing: app\[locale]\layout.tsx
- missing: scripts\security-regression-check.mjs
- missing: tests\e2e\ssr-root-language.spec.ts
- unused historical: lib/documentLanguage.ts → app/layout.tsx
- unused historical: app/[locale]/layout.tsx → app/layout.tsx
- unused historical: scripts/security-regression-check.mjs → app/layout.tsx
- unused historical: tests/e2e/ssr-root-language.spec.ts → app/layout.tsx

policy-section-reference 검사는 audits를 제외하므로 통과를 부속 계약 의미 검증으로 부르지 않는다.
원결정·계약·승인 관련 문서 12개의 exact commit blob / basis / working raw SHA와 조상 관계는
별도로 대조했다. 서명·proof·network 차단·GitHub API 사실은 이번에 새로 검증하지 않았다.
D 본문은 수정하지 않았고, 최초 초안·검토 프롬프트·기존 준비안 및 무관한 untracked는 보존한다.
