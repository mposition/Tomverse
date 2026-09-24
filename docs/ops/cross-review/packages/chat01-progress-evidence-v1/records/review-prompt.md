# Independent review — task chat01-progress-evidence-v1, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

CHAT-01 진행 문서에 #1673 병합·정확한 staging deployment·desktop/mobile focused E2E·로그인된 기존 test conversation reload 관측과 안전한 interactive staging seam 부재를 과장 없이 기록한다. confirmatory v4가 이미 strict case evidence와 token·cost·latency receipt를 저장하고 content-free aggregate를 재구성한다는 완료 사실과, 남은 retention/privacy 및 store가 suggestion/product caller의 제품 request/execution·사용자 disposition receipt에만 적용된다는 경계를 분리한다. 전체 기술 구현, release/activation readiness, Prompt Refiner 제품 연결, confirmatory infrastructure의 백분율은 launch 승인이나 품질 gate가 아닌 추정으로 표시하고, 다음 순서는 제품 receipt 결정과 content-free product receipt store 뒤 Cursor/CI, 별도 승인 paid confirmatory, 사람 disposition, product suggestion, Router/Auto shadow로 유지한다.

## Completion criteria

- #1673 merge SHA, staging deployment ID·SUCCESS·완료 시각과 focused E2E 38/38이 제공된 증거와 정확히 일치하고 구현·회귀·병합·배포를 서로 대신하지 않는다.
- signed-in staging 관측은 기존 전용 test conversation의 질문 1개·답변 1개와 reload 보존, 중복·recovery 오류 없음, 새 메시지·provider 호출·credit 사용 0으로 한정한다.
- saved-but-undispatched의 interactive staging 재현은 loopback-only deterministic gate와 accidental dispatch 위험 때문에 시도하지 않았음을 밝히고, 이를 pass/fail이 아닌 safe interactive staging seam 부재로 분류한다.
- confirmatory v4의 strict case evidence, token·cost·latency receipt 저장과 content-free aggregate 재구성을 완료된 기반으로 기록하며 product receipt 보존 공백과 혼동하지 않는다.
- 남은 retention/privacy 및 writer/store/collection은 suggestion/product caller의 product request/execution receipt와 user disposition receipt에만 적용된다.
- 79%·65%·40%·95%는 서로 다른 축의 대략적 추정이고 품질 gate, traffic activation 또는 launch 승인으로 제시되지 않는다.
- 권장 순서는 product receipt retention/privacy, content-free product request/execution+disposition store, Cursor/CI, separately approved paid confirmatory, human disposition, product suggestion, Router/Auto shadow다.
- Cursor verdict는 exact package digest에 결속하고 각 finding에 location, severity, evidence와 reproduction을 제공하며 source edit, provider API call, paid call, push, PR, merge 또는 deploy를 하지 않는다.

## Change under review — digest sha256:2323f916ee23b78b7ef2e0d255211698715b485d558ae79bc97e595ead2ce47c, commit 60c6b291adcb42483557416c9f3a11ed461174e2

```diff
diff --git a/docs/ops/cross-review/packages/chat01-progress-evidence-v1/authorization.md b/docs/ops/cross-review/packages/chat01-progress-evidence-v1/authorization.md
new file mode 100644
index 000000000..0007be323
--- /dev/null
+++ b/docs/ops/cross-review/packages/chat01-progress-evidence-v1/authorization.md
@@ -0,0 +1,21 @@
+# CHAT-01 진행 증거 문서 독립 검토 승인 기록
+
+- approvedBy: `mposition`
+- approvedAt: `2026-09-25` (Australia/Brisbane)
+- author: `codex`
+- independentReviewer: `cursor-cli`
+- maximumRevisionRounds: `2`
+- sourceCommit: `beb32ec7c179e791966838138059be8aa6f6baac`
+- baseCommit: `90380a7bd5b1589531741dd02fb2c88c041cc1df`
+- task: [task.json](./task.json)
+
+## 검토 경계
+
+검토 대상은 CHAT-01 진행 문서의 이번 50줄 추가와 이 패키지뿐이다. 제품 source,
+운영 설정, flag, traffic, provider, Railway, database, 배포 및 비공개 작업 현황은
+대상이 아니다.
+
+사용자가 승인한 `--skip-preflight` 예외 아래 Cursor CLI 구독 로그인을 사용한다.
+Cursor는 `grok-4.7-xhigh`, plan/read-only mode로 실행하고 외부 provider API key
+환경을 제거한다. Windows에서 sandbox를 활성화할 수 없는 제한은 provenance에
+기록한다. source 수정, provider/API/paid call, push, PR, merge 및 deploy는 금지한다.
diff --git a/docs/ops/cross-review/packages/chat01-progress-evidence-v1/task.json b/docs/ops/cross-review/packages/chat01-progress-evidence-v1/task.json
new file mode 100644
index 000000000..de842c251
--- /dev/null
+++ b/docs/ops/cross-review/packages/chat01-progress-evidence-v1/task.json
@@ -0,0 +1,20 @@
+{
+  "taskId": "chat01-progress-evidence-v1",
+  "requirement": "CHAT-01 진행 문서에 #1673 병합·정확한 staging deployment·desktop/mobile focused E2E·로그인된 기존 test conversation reload 관측과 안전한 interactive staging seam 부재를 과장 없이 기록한다. confirmatory v4가 이미 strict case evidence와 token·cost·latency receipt를 저장하고 content-free aggregate를 재구성한다는 완료 사실과, 남은 retention/privacy 및 store가 suggestion/product caller의 제품 request/execution·사용자 disposition receipt에만 적용된다는 경계를 분리한다. 전체 기술 구현, release/activation readiness, Prompt Refiner 제품 연결, confirmatory infrastructure의 백분율은 launch 승인이나 품질 gate가 아닌 추정으로 표시하고, 다음 순서는 제품 receipt 결정과 content-free product receipt store 뒤 Cursor/CI, 별도 승인 paid confirmatory, 사람 disposition, product suggestion, Router/Auto shadow로 유지한다.",
+  "completionCriteria": [
+    "#1673 merge SHA, staging deployment ID·SUCCESS·완료 시각과 focused E2E 38/38이 제공된 증거와 정확히 일치하고 구현·회귀·병합·배포를 서로 대신하지 않는다.",
+    "signed-in staging 관측은 기존 전용 test conversation의 질문 1개·답변 1개와 reload 보존, 중복·recovery 오류 없음, 새 메시지·provider 호출·credit 사용 0으로 한정한다.",
+    "saved-but-undispatched의 interactive staging 재현은 loopback-only deterministic gate와 accidental dispatch 위험 때문에 시도하지 않았음을 밝히고, 이를 pass/fail이 아닌 safe interactive staging seam 부재로 분류한다.",
+    "confirmatory v4의 strict case evidence, token·cost·latency receipt 저장과 content-free aggregate 재구성을 완료된 기반으로 기록하며 product receipt 보존 공백과 혼동하지 않는다.",
+    "남은 retention/privacy 및 writer/store/collection은 suggestion/product caller의 product request/execution receipt와 user disposition receipt에만 적용된다.",
+    "79%·65%·40%·95%는 서로 다른 축의 대략적 추정이고 품질 gate, traffic activation 또는 launch 승인으로 제시되지 않는다.",
+    "권장 순서는 product receipt retention/privacy, content-free product request/execution+disposition store, Cursor/CI, separately approved paid confirmatory, human disposition, product suggestion, Router/Auto shadow다.",
+    "Cursor verdict는 exact package digest에 결속하고 각 finding에 location, severity, evidence와 reproduction을 제공하며 source edit, provider API call, paid call, push, PR, merge 또는 deploy를 하지 않는다."
+  ],
+  "baseCommit": "90380a7bd5b1589531741dd02fb2c88c041cc1df",
+  "writableScope": [
+    "docs/ops/tomverse-chat-progress.md",
+    "docs/ops/cross-review/packages/chat01-progress-evidence-v1"
+  ],
+  "generatedPaths": []
+}
diff --git a/docs/ops/tomverse-chat-progress.md b/docs/ops/tomverse-chat-progress.md
index 1df8f7bc9..f6f0a087c 100644
--- a/docs/ops/tomverse-chat-progress.md
+++ b/docs/ops/tomverse-chat-progress.md
@@ -1452,3 +1452,78 @@ reliability·cost·latency의 탐색 증거일 뿐 의미 보존이나 prompt-in
    evidence를 수집한다.
 5. 그 증거 뒤 Refiner→Router 결합을 ROUTE-03 지연 계약 아래 실험하고 full-catalog
    모델 선택 개선으로 진행한다.
+
+## 2026-09-25 saved-but-undispatched 경계 배포·staging 확인 회차
+
+PR #1673은 merge commit `79fc743e163101935d7f68695b61628b62e76fb4`로
+병합됐고, 이 변경을 포함한 staging deployment
+`5e3d9861-f1c1-46a3-a6a4-7972bd358c14`는 `SUCCESS`로 종료됐다. 완료 시각은
+`2026-09-24T13:34:34.181Z`다. desktop/mobile의 deterministic focused E2E는
+**38/38** 통과했다. 이 증거는 saved-but-undispatched departure boundary의 구현과
+회귀 검증, 병합 및 staging 배포를 각각 확인한다.
+
+로그인된 staging Chat에서는 기존 전용 test conversation을 열어 확인했다. 화면은
+기존 사용자 질문 1개와 답변 1개를 불러왔고 reload 뒤에도 같은 한 쌍만 유지했다.
+중복 메시지나 recovery 오류는 없었다. 이 확인에서는 새 메시지를 전송하지 않았고
+provider 호출과 credit 사용도 발생시키지 않았다.
+
+saved-but-undispatched 경계를 staging에서 대화형으로 재현하는 시도는 의도적으로
+하지 않았다. 현재 내장된 deterministic gate는 loopback 전용이고, 실제 화면에서
+click race를 만들면 검증하려던 미전송 turn이 provider로 dispatch될 수 있다. 따라서
+이 항목은 통과나 실패가 아니라 **안전한 interactive staging seam 부재**로 분류한다.
+이는 이미 통과한 구현·회귀 증거를 무효화하지 않지만, 실제 staging 상호작용 증거로
+대체해서도 안 된다.
+
+### 한눈에 보는 전체 Chat 진척
+
+이 회차부터 아래 네 축은 **`chat-scope-readiness-v1`** 방법으로 처음 산정한다.
+직전 `planning-estimate-v2`의 전체 웹 Chat 약 72%(주관적 범위 62–82%)와
+C19–C20 제품 연결/검증·운영 기반 약 30%/약 95%는 분모와 증거 분류가 다르다.
+따라서 아래 79/65/40/95는 그 수치의 증분이나 갱신이 아니며 직접 비교하지 않는다.
+향후 변화량은 이 네 축과 아래 정의를 그대로 유지한 기록끼리만 비교한다.
+
+- **전체 기술 구현**은 승인된 CHAT-01 기술 범위에서 source 구현, 회귀 검증,
+  병합과 staging 배포까지 확인된 작업량의 가중 추정이다. 품질·활성화 승인은 세지
+  않으며, 기능별 크기 차이 때문에 불확실성은 약 ±10%p다.
+- **release/activation readiness**는 실제 traffic 전에 필요한 품질·안전 gate,
+  staging 증거, 사람 disposition과 명시적 활성화 승인의 충족도를 추정한다. 코드가
+  존재한다는 사실만으로는 올리지 않으며 불확실성은 약 ±10%p다.
+- **Prompt Refiner 제품 연결**은 제품 execution/disposition receipt, server-owned
+  caller와 offered 결정, 사용자 선택 증거 및 Router/Auto shadow까지를 분모로 한다.
+  fixture-only seam은 인터페이스 증거로만 일부 반영하며 불확실성은 약 ±10%p다.
+- **Prompt Refiner confirmatory infrastructure**는 v4 실행 계약, source 결속,
+  content-free evidence 저장·재구성, 관리자 read-back과 runner를 분모로 한다.
+  별도 승인된 실행과 사람 disposition은 남은 gate로 표시하며 불확실성은 약 ±5%p다.
+
+| 항목 | 이번 판단 |
+| --- | --- |
+| 전체 기술 구현 | **약 79%** — saved-but-undispatched 경계 구현·회귀·병합·staging 배포와 기존 대화 reload 보존을 반영한 작업량 추정 |
+| release/activation readiness | **약 65%** — staging 기본 읽기 흐름은 확인했지만 안전한 interactive seam, confirmatory 판정과 후속 활성화 승인이 남음 |
+| Prompt Refiner 제품 연결 | **약 40%** — 제안형 제품 흐름과 사용자 선택 증거, Router/Auto shadow 결합은 아직 후속 |
+| Prompt Refiner confirmatory infrastructure | **약 95%** — v4가 strict case evidence와 token·cost·latency receipt를 이미 저장하고 content-free aggregate를 재구성함. 별도 승인된 실행과 사람 disposition은 후속 |
+| 이번 직접 관측 | signed-in staging의 기존 전용 test conversation에서 질문 1개·답변 1개가 reload 뒤에도 중복·recovery 오류 없이 유지됨. 새 메시지·provider 호출·credit 사용 0 |
+
+남은 retention/privacy 결정과 writer/store/collection은 confirmatory v4 case receipt를
+새로 만드는 일이 아니다. suggestion/product caller가 만들 제품 request/execution
+receipt와 사용자의 disposition receipt에만 적용하며, confirmatory pass와 사람의
+release disposition 뒤에만 진행한다.
+
+위 백분율은 같은 CHAT-01 범위의 대략적인 작업량·준비도 **추정**이다. 품질 gate
+통과, 실제 사용자 traffic 활성화 또는 launch 승인이 아니며 네 축은 서로를 대신하지
+않는다.
+
+### 이 Cycle 다음 권장 순서
+
+1. 별도 비용·stage·run 승인을 받은 뒤에만 bounded v4 confirmatory를 정확히 한 번
+   실행하고, content-free 결과를 동결된 deterministic gate로 판정한다. 불명 결과는
+   확인 전 재실행하지 않는다.
+2. 그 품질·비용·지연 결과를 사람이 release disposition한다.
+3. gate pass와 사람 승인 뒤에만 제품 request/execution receipt와 사용자 disposition
+   receipt의 retention, privacy, 사용자 권리와 audit 결정을 동결한다.
+4. 그 결정에 맞춰 제품 adapter와 server-owned content-free receipt writer/store를
+   구현하되 caller는 default-off로 유지하고 사용자에게 노출하지 않는다.
+5. exact diff를 Cursor 읽기 전용 독립 검토와 Linux 통합 CI에 제출한다.
+6. 통과한 구현에 한해 default-off pre-send suggestion UI와 disposition collection을
+   연결한다.
+7. accept/keep/stale 증거 뒤에만 Router/Auto shadow 결합을 ROUTE-03 아래 별도
+   실험으로 진행한다.

```

## Test results (run by the control program)

- PASS `npm run check:doc-references` (1622ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 921 referenced path(s) across 124 instruction document(s), and 1066 path(s) named by comments across 3356 source file(s), all present.

## Guard results (run by the control program)

- PASS `npm run check:policy-section-references` (1143ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4666 citation(s) against 43 policy document(s). 3098 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1334 and 234 predate this change).
- PASS `npm run check:encoding` (1482ms)
  > ai-chat-hub@0.1.0 check:encoding
  > node scripts/check-text-encoding.mjs
  
  Text encoding check passed. No mojibake markers found.
- PASS `git diff --check 90380a7bd5b1589531741dd02fb2c88c041cc1df -- docs/ops/tomverse-chat-progress.md` (50ms)

## Findings from the previous round (check each was addressed)

- [error/evidence] docs/ops/tomverse-chat-progress.md:1517: 이 Cycle 다음 권장 순서가 paid confirmatory, 사람 disposition, retention/privacy, store, Cursor/CI, suggestion, Router로 적혀 완료 기준의 retention/privacy, content-free store, Cursor/CI, 별도 승인 paid confirmatory, 사람 disposition, product suggestion, Router/Auto shadow와 어긋난다.

## Author's account (read last; a claim, not a finding)

Summary: Preserve the policy-correct evidence order while asking the reviewer to disposition the stale task contract that incorrectly requires product receipt storage before confirmatory evidence and human approval.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "chat01-progress-evidence-v1",
  "round": 2,
  "reviewedDigest": "sha256:2323f916ee23b78b7ef2e0d255211698715b485d558ae79bc97e595ead2ce47c",
  "conclusion": "approve | request_changes | blocked",
  "findings": [
    {
      "location": "path:line or symbol",
      "severity": "error | warning | nit",
      "basis": "evidence | preference | judgement",
      "claim": "what is wrong, in one sentence",
      "reproduction": "how to see it: a command, or an input and its expected output (required for the finding to be acted on)"
    }
  ],
  "nextAction": "one sentence"
}
```

`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; any other finding is acted on only with a reproduction, and without one it is recorded and the current version stands.
