<!--
  GENERATED FILE -- DO NOT EDIT.
  Source: docs/release-gates/tomverse-chat-v1.yaml
  Regenerate: npm run generate:tomverse-chat-release-gate-view
  CI check:   npm run check:tomverse-chat-release-gate-view
  Thresholds change only in the registry YAML, never here.
-->

# tomverse-chat v1 release gates

- Registry status: draft
- Registry last updated: 2026-08-05
- Gates: 40 total, 40 blocking, 4 conditional
- Threshold changes require: product-owner, independent-reviewer
- Validator: `npm run verify:tomverse-chat-release-gates`

Canonical release-gate registry for Tomverse Chat v1. Human-readable tables must be generated from this file and must not be edited independently.

## Owner roles

| Role | Scope |
| --- | --- |
| `backend-ai` | Router, Planner, provider adapters, billing integration, and auth server |
| `web-ui` | shared chat UI, mobile web, PWA, and accessibility |
| `mobile-release` | native shell, deep links, store submission, and review operations |
| `product-qa` | evaluation sets, release evidence, regression, and gate sign-off |
| `security-privacy` | threat tests, privacy workflows, and data-domain registry |
| `finance-ops` | credit ledger reconciliation and refund policy |

## Threshold summary

| Gate | Title | Owner | Blocking | Criteria | Status |
| --- | --- | --- | --- | --- | --- |
| `ROUTE-01` | Auto Router quality is non-inferior to the fixed-model baseline | backend-ai | yes | `evaluation_win_rate_delta_ci95_lower_pp` >= -2 | pending |
| `ROUTE-02` | Fast-path routing latency remains within budget | backend-ai | yes | `fast_path_routing_latency_p95_ms` <= 300 | pending |
| `ROUTE-03` | Model-assisted routing latency and TTFT overhead remain within budget | backend-ai | yes | `assisted_routing_latency_p95_ms` <= 800; `end_to_end_ttft_increase_percent` <= 10 | pending |
| `ROUTE-04` | Pass 2 context rerouting is exceptional rather than routine | backend-ai | yes | `pass_2_occurrence_percent` <= 5 | pending |
| `ROUTE-05` | Context-limit rerouting never exceeds one escape-hatch pass | backend-ai | yes | `context_reroute_count_max` <= 1 | pending |
| `ROUTE-06` | Every dispatched provider attempt references its own finalized manifest | backend-ai | yes | `dispatched_attempt_manifest_coverage_percent` = 100 | pending |
| `ROUTE-07` | RoutingRun observability is complete enough for evaluation and audit | backend-ai | yes | `routing_run_recording_percent` >= 99.9 | pending |
| `ESTIMATE-01` | Context token estimate median error remains within budget | backend-ai | yes | `absolute_token_estimate_error_percent_p50` <= 5 | pending |
| `ESTIMATE-02` | Context token estimate tail error remains within budget | backend-ai | yes | `absolute_token_estimate_error_percent_p95` <= 15 | pending |
| `ESTIMATE-03` | No over-limit context request reaches a provider | backend-ai | yes | `provider_dispatches_over_model_context_limit` = 0 | pending |
| `FALLBACK-01` | Eligible pre-token provider failures recover automatically | backend-ai | yes | `eligible_pre_token_fallback_success_percent` >= 95 | pending |
| `FALLBACK-02` | Automatic fallback never starts after a visible token | backend-ai | yes | `automatic_fallbacks_after_visible_token` = 0 | pending |
| `FALLBACK-03` | Successful fallbacks use candidate-specific rebuilt context | backend-ai | yes | `successful_fallbacks_with_candidate_manifest_percent` = 100 | pending |
| `PLANNER-01` | Prompt Planner quality is non-inferior to pass-through | backend-ai | yes | `planner_win_rate_delta_ci95_lower_pp` >= -2 | pending |
| `PLANNER-02` | Planner cost growth requires approved quality evidence | backend-ai | yes | `responses_with_cost_increase_gte_10_percent_without_approved_quality_evidence` = 0 | pending |
| `PLANNER-03` | Untrusted memory and retrieved content cannot override instruction precedence | security-privacy | yes | `adversarial_retrieved_content_instruction_precedence_violations` = 0 | pending |
| `BILLING-01` | A logical response cannot charge credits more than once | finance-ops | yes | `duplicate_user_credit_charges` = 0 | pending |
| `BILLING-02` | Credit reservations reconcile after completion, failure, or cancellation | finance-ops | yes | `unreconciled_credit_reservations_after_reconciliation_window` = 0 | pending |
| `BILLING-03` | Credit-ledger invariants never produce unintended negative balances | finance-ops | yes | `unintended_negative_ledger_invariant_errors` = 0 | pending |
| `BILLING-04` | Goodwill refunds remain idempotent | finance-ops | yes | `duplicate_goodwill_refunds` = 0 | pending |
| `ABUSE-01` | Plan, model, quota, and rate-limit policy cannot be bypassed | security-privacy | yes | `unauthorized_or_over_quota_model_dispatches_in_adversarial_tests` = 0 | pending |
| `MODERATION-01` | Every request covered by moderation policy receives the required checks | security-privacy | yes | `policy_covered_requests_dispatched_without_required_moderation` = 0 | pending |
| `MEMORY-01` | Korean memory retrieval reaches the target recall | backend-ai | yes (when `memory-release-b-enabled`) | `korean_memory_recall_at_5_percent` >= 85 | pending |
| `MEMORY-02` | Irrelevant memory injection remains below the safety threshold | backend-ai | yes (when `memory-release-b-enabled`) | `incorrect_or_irrelevant_memory_injection_percent` <= 2 | pending |
| `MEMORY-03` | Sensitive data and credentials are never injected from memory | security-privacy | yes (when `memory-release-b-enabled`) | `sensitive_or_credential_memory_injections` = 0 | pending |
| `MEMORY-04` | Deleted or superseded memory is never reused | security-privacy | yes (when `memory-release-b-enabled`) | `deleted_or_superseded_memory_reuse_events` = 0 | pending |
| `UI-01` | Tomverse Review behavior remains stable after headless extraction | web-ui | yes | `required_review_regression_e2e_pass_percent` = 100 | pending |
| `UI-02` | Fallback status, cancellation, IME, streaming, and accessibility work end to end | web-ui | yes | `critical_chat_interaction_e2e_pass_percent` = 100 | pending |
| `PACKAGE-01` | Shared chat packages remain framework-neutral | web-ui | yes | `forbidden_nextjs_imports_in_shared_packages` = 0 | approved |
| `AUTH-01` | Sign in with Apple and identity lifecycle work end to end | mobile-release | yes | `apple_login_link_unlink_delete_revoke_e2e_pass_percent` = 100 | pending |
| `AUTH-02` | Email OTP, magic link, and the isolated review code work through the mobile token path | backend-ai | yes | `email_otp_magic_link_lockout_turnstile_e2e_pass_percent` = 100; `submission_scoped_review_code_isolation_e2e_pass_percent` = 100 | pending |
| `AUTH-03` | Mobile bearer-token lifecycle resists replay and supports revocation | backend-ai | yes | `refresh_rotation_reuse_logout_device_revoke_e2e_pass_percent` = 100 | pending |
| `AUTH-04` | CORS bypass and deep-link hijacking attack tests pass | security-privacy | yes | `unresolved_high_or_critical_cors_or_deep_link_findings` = 0 | pending |
| `PRIVACY-01` | Account deletion is complete inside the app | security-privacy | yes | `in_app_account_deletion_e2e_pass_percent` = 100; `data_domains_with_unverified_deletion_action_count` = 0; `data_domains_with_planned_deletion_action_count` = 0; `identifier_sentinels_surviving_account_deletion_count` = 0 | pending |
| `PRIVACY-02` | Account data export covers every registered Tomverse data domain | security-privacy | yes | `data_domains_with_undecided_export_state_count` = 0; `account_export_wiring_problem_count` = 0; `withheld_field_sentinels_present_in_export_count` = 0; `account_export_download_security_e2e_pass_percent` = 100; `concurrent_export_ticket_double_redemption_count` = 0 | pending |
| `STORE-01` | A new Free account can complete a useful flow without purchase | mobile-release | yes | `purchase_free_signup_chat_response_and_history_save_e2e_pass_percent` = 100 | pending |
| `STORE-02` | Review credentials remain usable throughout an active submission | mobile-release | yes | `daily_review_credential_synthetic_login_success_percent` = 100 | pending |
| `MANIFEST-01` | Delta manifests cannot form unbounded reconstruction chains | backend-ai | yes | `context_manifest_delta_depth_max` <= 20 | pending |
| `MANIFEST-02` | Manifest retention honors deletion first and compacts aged detail | security-privacy | yes | `deletion_and_aged_manifest_compaction_job_success_percent` = 100; `detailed_manifest_retention_days_max` <= 90 | pending |
| `PUSH-01` | Push-notification infrastructure remains out of v1 until a use case is approved | product-qa | yes | `unapproved_push_infrastructure_components_in_v1` = 0 | pending |

## Release-mode approval rules

- Every applicable blocking gate must have status approved.
- approvedBy must contain an accountable gate-owner approval and an independent-reviewer approval. Whether those two roles may be held by the same subject is decided by soleApproverAllowed below.
- approvedAt must be a non-null RFC 3339 timestamp.
- evidenceRefs must contain immutable links or artifact identifiers.
- not-applicable is allowed only when appliesWhen evaluates false and the decision has independent approval and an applicability evidence reference.
- The independent reviewer must be a person who did not produce the referenced evidence. Co-implementers of a feature may approve as gate-owner but may not serve as the independent reviewer for gates whose evidence they produced. Where soleApproverAllowed is true, "did not produce the evidence" is read against the actual author of the artefacts -- automation, in most cases -- rather than against the other human, of whom there is none.

## Gate detail

### Category: routing

#### ROUTE-01 -- Auto Router quality is non-inferior to the fixed-model baseline

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: A 95% confidence-interval lower bound prevents a noisy point estimate from approving a Router that may be materially worse than the fixed-model baseline.

Criteria:

- `evaluation_win_rate_delta_ci95_lower_pp` >= -2

Required evidence:

- Versioned decision-grade evaluation report with fixed-model baseline, sample size, paired evaluation unit, confidence-interval method, seed, point estimate, and 95% confidence-interval bounds.
- NOT the shadow report. Shadow records the model the Router would have chosen; it never generated that model's answer, so there is no pair to compare and no win rate to compute. A Router that echoed the user would agree with every shadow row and be worth nothing, and one that is right where the user was wrong appears there as disagreement. The shadow agreement rate measures how much would change if Auto were switched on -- the blast radius -- and nothing about whether the change would be an improvement. npm run report:routing-shadow prints that distinction beside its own numbers so the two cannot be read as one result.
- Produced by npm run eval:router-quality -- --mode=decision, which makes real billed calls and emits the report above. npm run check:router-quality-eval validates a report before it may be cited: it refuses a pilot or judge-bias run, a run against the development set, a run that stopped at its cost ceiling, a second use of an already-used decision set, a baseline pre-registered after the run started, and a routable judge whose cited calibration is not a calibration of that judge, over development-set answers from a run that finished, against an independent judge that wrote none of them. The procedure the harness implements is docs/ops/tomverse-chat-router-evaluation-set.md; a passing check means the report is citable, not that the gate is approved.

Evidence references: none recorded

#### ROUTE-02 -- Fast-path routing latency remains within budget

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Deterministic routing must preserve mobile chat responsiveness and must not consume a material share of time to first token.

Criteria:

- `fast_path_routing_latency_p95_ms` <= 300

Required evidence:

- production-like load-test trace grouped by router version

Evidence references: none recorded

#### ROUTE-03 -- Model-assisted routing latency and TTFT overhead remain within budget

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Model-assisted routing is acceptable only when both its own tail latency and the resulting end-to-end TTFT overhead remain bounded.

Criteria:

- `assisted_routing_latency_p95_ms` <= 800
- `end_to_end_ttft_increase_percent` <= 10

Required evidence:

- production-like load-test trace with assisted-routing cohort

Evidence references: none recorded

#### ROUTE-04 -- Pass 2 context rerouting is exceptional rather than routine

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Pass 2 is an escape hatch; frequent use indicates an inaccurate Estimator or an unsuitable Pass 1 model decision and doubles context work.

Criteria:

- `pass_2_occurrence_percent` <= 5
  - Denominator: Auto-mode RoutingRuns that complete an initial Context Builder fit check, excluding user cancellation before that check.

Required evidence:

- RoutingRun report segmented by model and estimator version

Evidence references: none recorded

#### ROUTE-05 -- Context-limit rerouting never exceeds one escape-hatch pass

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: A hard reroute bound prevents routing and context construction from forming an unbounded retry loop.

Criteria:

- `context_reroute_count_max` <= 1

Required evidence:

- RoutingRun invariant query and adversarial context tests

Evidence references: none recorded

#### ROUTE-06 -- Every dispatched provider attempt references its own finalized manifest

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Attempt-scoped finalized manifests are required because fallback models can receive different context, tokenization, planning, and adapter output.

Criteria:

- `dispatched_attempt_manifest_coverage_percent` = 100

Required evidence:

- RoutingAttempt-to-ContextManifest integrity query

Evidence references: none recorded

#### ROUTE-07 -- RoutingRun observability is complete enough for evaluation and audit

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Routing quality, cost, regeneration, and model-switch analysis is trustworthy only when nearly every accepted logical execution has a RoutingRun.

Criteria:

- `routing_run_recording_percent` >= 99.9
  - Denominator: Logical assistant-response executions accepted into Chat Orchestrator after authentication and idempotency validation, including terminal not_dispatched outcomes; excludes requests rejected before that boundary.

Required evidence:

- sampled Message-to-RoutingRun reconciliation report

Evidence references: none recorded

### Category: context-estimation

#### ESTIMATE-01 -- Context token estimate median error remains within budget

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Low median token-estimate error keeps normal routing efficient and reduces unnecessary context rebuilds.

Criteria:

- `absolute_token_estimate_error_percent_p50` <= 5

Required evidence:

- tokenizer-stratified estimate-versus-actual report

Evidence references: none recorded

#### ESTIMATE-02 -- Context token estimate tail error remains within budget

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: A bounded tail error protects long, attachment-heavy, and multilingual conversations that median accuracy can hide.

Criteria:

- `absolute_token_estimate_error_percent_p95` <= 15

Required evidence:

- tokenizer-stratified estimate-versus-actual report

Evidence references: none recorded

#### ESTIMATE-03 -- No over-limit context request reaches a provider

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: The final actual-token guard is a zero-tolerance safety boundary even when estimation and rerouting metrics otherwise pass.

Criteria:

- `provider_dispatches_over_model_context_limit` = 0

Required evidence:

- provider-dispatch guard invariant test
- production RoutingAttempt audit comparing actualTokens with model limit

Evidence references: none recorded

### Category: fallback

#### FALLBACK-01 -- Eligible pre-token provider failures recover automatically

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Pre-token fallback must recover most eligible transient provider failures to justify its added execution complexity.

Criteria:

- `eligible_pre_token_fallback_success_percent` >= 95
  - Denominator: Primary attempts that fail before any visible token, have at least one healthy compatible candidate, and are not cancelled by the user.

Required evidence:

- injected-failure evaluation report with denominator breakdown

Evidence references: none recorded

#### FALLBACK-02 -- Automatic fallback never starts after a visible token

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Switching models after visible output risks duplicated or contradictory answers and ambiguous billing, so it is prohibited.

Criteria:

- `automatic_fallbacks_after_visible_token` = 0

Required evidence:

- stream-state invariant test and production audit

Evidence references: none recorded

#### FALLBACK-03 -- Successful fallbacks use candidate-specific rebuilt context

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: A fallback is safe only when the selected candidate receives context validated for its own tokenizer, capabilities, and limits.

Criteria:

- `successful_fallbacks_with_candidate_manifest_percent` = 100

Required evidence:

- RoutingAttempt manifest and tokenizer compatibility query

Evidence references: none recorded

### Category: prompt-planner

#### PLANNER-01 -- Prompt Planner quality is non-inferior to pass-through

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: A 95% confidence-interval lower bound ensures Planner rollout is supported by evidence rather than a favorable but uncertain point estimate.

Criteria:

- `planner_win_rate_delta_ci95_lower_pp` >= -2

Required evidence:

- Blinded planner-versus-pass-through evaluation report with sample size, paired evaluation unit, confidence-interval method, seed, point estimate, and 95% confidence-interval bounds.

Evidence references: none recorded

#### PLANNER-02 -- Planner cost growth requires approved quality evidence

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Planner latency and token expansion are justified only by approved quality evidence when response cost rises materially.

Criteria:

- `responses_with_cost_increase_gte_10_percent_without_approved_quality_evidence` = 0

Required evidence:

- planner cohort cost report linked to evaluation approval

Evidence references: none recorded

#### PLANNER-03 -- Untrusted memory and retrieved content cannot override instruction precedence

- Owner: security-privacy
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Memory and retrieved content cross a trust boundary and must remain data rather than instructions capable of overriding system policy.

Criteria:

- `adversarial_retrieved_content_instruction_precedence_violations` = 0

Required evidence:

- memory, attachment, import, and project-content prompt-injection test report

Evidence references: none recorded

### Category: billing

#### BILLING-01 -- A logical response cannot charge credits more than once

- Owner: finance-ops
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Retries, fallback, and idempotent client replays must never turn one logical response into multiple user charges.

Criteria:

- `duplicate_user_credit_charges` = 0

Required evidence:

- reservation and settlement idempotency test

Evidence references: none recorded

#### BILLING-02 -- Credit reservations reconcile after completion, failure, or cancellation

- Owner: finance-ops
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Every reservation must reach a terminal settlement or release state so credits cannot remain indefinitely locked.

Criteria:

- `unreconciled_credit_reservations_after_reconciliation_window` = 0

Required evidence:

- reservation reconciliation job report

Evidence references: none recorded

#### BILLING-03 -- Credit-ledger invariants never produce unintended negative balances

- Owner: finance-ops
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Unexpected negative balances signal ledger corruption or unsafe refund recovery and are a zero-tolerance financial invariant.

Criteria:

- `unintended_negative_ledger_invariant_errors` = 0

Required evidence:

- ledger invariant test and reconciliation report

Evidence references: none recorded

#### BILLING-04 -- Goodwill refunds remain idempotent

- Owner: finance-ops
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Goodwill refunds can be retried operationally, so they require their own idempotency guarantee.

Criteria:

- `duplicate_goodwill_refunds` = 0

Required evidence:

- refund idempotency and early-failure threshold tests

Evidence references: none recorded

### Category: abuse-prevention

#### ABUSE-01 -- Plan, model, quota, and rate-limit policy cannot be bypassed

- Owner: security-privacy
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Auto routing and fallback must not become a path around plan entitlements, model limits, quotas, or server rate limits.

Criteria:

- `unauthorized_or_over_quota_model_dispatches_in_adversarial_tests` = 0

Required evidence:

- guest and Free account concurrency, replay, device, account, and IP abuse tests

Evidence references: none recorded

### Category: moderation

#### MODERATION-01 -- Every request covered by moderation policy receives the required checks

- Owner: security-privacy
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Every dispatch path, including pass-through and fallback, must preserve the same required content-policy enforcement.

Criteria:

- `policy_covered_requests_dispatched_without_required_moderation` = 0

Required evidence:

- pre-dispatch policy enforcement coverage report

Evidence references: none recorded

### Category: memory

#### MEMORY-01 -- Korean memory retrieval reaches the target recall

- Owner: backend-ai
- Blocking: yes
- Applies when: `memory-release-b-enabled`
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Korean-first retrieval requires measured recall because PostgreSQL language tooling does not provide equivalent morphology out of the box.

Criteria:

- `korean_memory_recall_at_5_percent` >= 85

Required evidence:

- Korean-first retrieval set using NFC normalization and bigram ranking

Evidence references: none recorded

#### MEMORY-02 -- Irrelevant memory injection remains below the safety threshold

- Owner: backend-ai
- Blocking: yes
- Applies when: `memory-release-b-enabled`
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Incorrect memory can silently distort every later answer, so relevance errors require an explicit quality ceiling.

Criteria:

- `incorrect_or_irrelevant_memory_injection_percent` <= 2

Required evidence:

- adjudicated memory injection evaluation report

Evidence references: `docs/release-gates/evidence/memory-extraction-instrument-2026-08-28.md`, `commit:0540e0be6b5da4dbd0ebd9cf0259d0f9f58a3e9d`, `commit:fc57ccf4d6b38e1c87c6d7dbbf2f03ae0032f9a4`, `dataset:mem-eval-succ-5@0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0`, `scoring-contract:mem-score-v3.4@a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd`, `superseded-dataset:mem-eval-succ-4@0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0`, `superseded-scoring-contract:mem-score-v3.3@19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777`, `https://github.com/mposition/Tomverse/actions/runs/33154411698`, `https://github.com/mposition/Tomverse/actions/runs/33151805896`

#### MEMORY-03 -- Sensitive data and credentials are never injected from memory

- Owner: security-privacy
- Blocking: yes
- Applies when: `memory-release-b-enabled`
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Credential or sensitive-data injection from long-term memory is a zero-tolerance privacy and security failure.

Criteria:

- `sensitive_or_credential_memory_injections` = 0

Required evidence:

- adversarial sensitive-memory evaluation report

Evidence references: `docs/release-gates/evidence/memory-extraction-instrument-2026-08-28.md`, `commit:0540e0be6b5da4dbd0ebd9cf0259d0f9f58a3e9d`, `commit:fc57ccf4d6b38e1c87c6d7dbbf2f03ae0032f9a4`, `dataset:mem-eval-succ-5@0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0`, `scoring-contract:mem-score-v3.4@a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd`, `superseded-dataset:mem-eval-succ-4@0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0`, `superseded-scoring-contract:mem-score-v3.3@19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777`, `https://github.com/mposition/Tomverse/actions/runs/33154411698`, `https://github.com/mposition/Tomverse/actions/runs/33151805896`

#### MEMORY-04 -- Deleted or superseded memory is never reused

- Owner: security-privacy
- Blocking: yes
- Applies when: `memory-release-b-enabled`
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Deletion and supersession promises are meaningful only when obsolete memory can never re-enter model context.

Criteria:

- `deleted_or_superseded_memory_reuse_events` = 0

Required evidence:

- deletion-priority and supersession invariant tests

Evidence references: none recorded

### Category: shared-chat-ui

#### UI-01 -- Tomverse Review behavior remains stable after headless extraction

- Owner: web-ui
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Shared-core and shared-UI extraction is allowed only when existing Tomverse Review behavior and critical visuals remain stable.

Criteria:

- `required_review_regression_e2e_pass_percent` = 100

Required evidence:

- frozen Review regression suite on web and shared packages
- approved visual snapshot comparison for critical Review chat states

Evidence references: none recorded

#### UI-02 -- Fallback status, cancellation, IME, streaming, and accessibility work end to end

- Owner: web-ui
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Streaming, retry, cancellation, IME, and accessible fallback status are one user-visible state machine and must pass together.

Criteria:

- `critical_chat_interaction_e2e_pass_percent` = 100

Required evidence:

- mobile viewport and native-shell E2E report

Evidence references: none recorded

### Category: shared-packages

#### PACKAGE-01 -- Shared chat packages remain framework-neutral

- Owner: web-ui
- Blocking: yes
- Status: approved
- Approved by: @mposition (gate-owner), @mposition (independent-reviewer)
- Approved at: 2026-08-12T23:21:58Z

Why this gate exists: Framework-neutral packages are the mechanism that prevents Next.js and Capacitor clients from becoming duplicated products.

Criteria:

- `forbidden_nextjs_imports_in_shared_packages` = 0

Required evidence:

- ESLint no-restricted-imports report
- Next.js and Vite build matrix

Evidence references: `docs/release-gates/evidence/PACKAGE-01-2026-08-12.md`, `commit:b786a97db24b0177eddbc79efcb17df29205d03f`, `https://github.com/mposition/Tomverse/actions/runs/31604472342`, `https://github.com/mposition/Tomverse/actions/runs/31604472342/job/94139773729`, `https://github.com/mposition/Tomverse/actions/runs/31604472342/job/94139773711`

### Category: authentication

#### AUTH-01 -- Sign in with Apple and identity lifecycle work end to end

- Owner: mobile-release
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Store-compliant identity lifecycle requires Apple or equivalent login to work with linking, unlinking, deletion, and revocation.

Criteria:

- `apple_login_link_unlink_delete_revoke_e2e_pass_percent` = 100

Required evidence:

- physical-device authentication E2E report

Evidence references: none recorded

#### AUTH-02 -- Email OTP, magic link, and the isolated review code work through the mobile token path

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: The mobile bearer path must preserve the abuse resistance and expiry guarantees of the existing email OTP and magic-link policy.

Criteria:

- `email_otp_magic_link_lockout_turnstile_e2e_pass_percent` = 100
- `submission_scoped_review_code_isolation_e2e_pass_percent` = 100

Required evidence:

- Abuse, expiry, lockout, cross-account, cross-submission/build, rotation, terminal-revoke, and ordinary-account regression E2E report.

Evidence references: none recorded

#### AUTH-03 -- Mobile bearer-token lifecycle resists replay and supports revocation

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Rotating refresh tokens, reuse detection, logout, and device revoke are required to contain stolen mobile credentials.

Criteria:

- `refresh_rotation_reuse_logout_device_revoke_e2e_pass_percent` = 100

Required evidence:

- token rotation and reuse-detection security test report

Evidence references: none recorded

#### AUTH-04 -- CORS bypass and deep-link hijacking attack tests pass

- Owner: security-privacy
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: CORS bypass and deep-link hijacking are primary attack surfaces introduced by mobile bearer authentication and external browser return flows.

Criteria:

- `unresolved_high_or_critical_cors_or_deep_link_findings` = 0

Required evidence:

- hostile-origin CORS test report
- universal-link and app-link hijacking test report on physical devices

Evidence references: none recorded

### Category: privacy

#### PRIVACY-01 -- Account deletion is complete inside the app

- Owner: security-privacy
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Users and store reviewers must be able to complete account deletion inside the app without an external support workflow, and every table holding their data needs a traced and implemented deletion path rather than a decided one.

Criteria:

- `in_app_account_deletion_e2e_pass_percent` = 100
- `data_domains_with_unverified_deletion_action_count` = 0
- `data_domains_with_planned_deletion_action_count` = 0
- `identifier_sentinels_surviving_account_deletion_count` = 0

Required evidence:

- deletion E2E covering reauthentication, completion, and token revocation
- two-axis data-domain registry passing scripts/check-data-domain-registry.mjs, with every anonymise row carrying a re-identification review and every retain row a legal basis, period, owner and review date
- tests/integration/account-anonymisation.db.test.ts planting a sentinel in every column the registry says is anonymised, deleting the account for real, and asserting none survives
- tests/accountDataAnonymisation.test.mjs pinning the implemented column list and replacements against the registry field for field, so neither side can drift

Evidence references: none recorded

#### PRIVACY-02 -- Account data export covers every registered Tomverse data domain

- Owner: security-privacy
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: A versioned data-domain registry prevents new product tables from silently escaping the shared account export, and the export tells the user what it withheld instead of presenting a projection as the whole answer.

Criteria:

- `data_domains_with_undecided_export_state_count` = 0
- `account_export_wiring_problem_count` = 0
- `withheld_field_sentinels_present_in_export_count` = 0
- `account_export_download_security_e2e_pass_percent` = 100
- `concurrent_export_ticket_double_redemption_count` = 0

Required evidence:

- versioned data-domain registry and export coverage test
- tests/integration/account-data-export.db.test.ts planting a sentinel in every withheld column and asserting none survives JSON.stringify of the export
- export manifest recording schemaVersion, generatedAt, and the included, filtered, excluded, undecided and truncated domains with their reasons
- tests/integration/account-data-export-ticket.db.test.ts covering single-use redemption under concurrency, refusal of a link presented by another account, expiry, and the ninety-day audit retention
- tests/accountDataExportTicket.test.mjs pinning the keyed token hash, the no-store and no-referrer download headers, and the single refusal message shared by every refusal reason

Evidence references: none recorded

### Category: store-review

#### STORE-01 -- A new Free account can complete a useful flow without purchase

- Owner: mobile-release
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: A consumption-only app still needs a complete purchase-free Free-tier experience for new users and store reviewers.

Criteria:

- `purchase_free_signup_chat_response_and_history_save_e2e_pass_percent` = 100

Required evidence:

- clean-device review-path E2E with abuse limits enabled

Evidence references: none recorded

#### STORE-02 -- Review credentials remain usable throughout an active submission

- Owner: mobile-release
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Submission review can last for weeks, so review credentials require continuous synthetic verification and state-linked expiry management.

Criteria:

- `daily_review_credential_synthetic_login_success_percent` = 100
  - Measurement window: active-submission

Required evidence:

- daily synthetic-login history with alert acknowledgements
- credential state and rolling-expiration audit

Evidence references: none recorded

### Category: context-manifest

#### MANIFEST-01 -- Delta manifests cannot form unbounded reconstruction chains

- Owner: backend-ai
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Bounded delta depth preserves deterministic reconstruction cost and prevents long conversations from creating unbounded chains.

Criteria:

- `context_manifest_delta_depth_max` <= 20

Required evidence:

- reconstruction and checkpoint invariant test

Evidence references: none recorded

#### MANIFEST-02 -- Manifest retention honors deletion first and compacts aged detail

- Owner: security-privacy
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Audit detail must not override deletion rights or create indefinite retention growth.

Criteria:

- `deletion_and_aged_manifest_compaction_job_success_percent` = 100
- `detailed_manifest_retention_days_max` <= 90

Required evidence:

- deletion propagation and retention-job audit

Evidence references: none recorded

### Category: scope-control

#### PUSH-01 -- Push-notification infrastructure remains out of v1 until a use case is approved

- Owner: product-qa
- Blocking: yes
- Status: pending
- Approved by: not yet approved
- Approved at: not yet approved

Why this gate exists: Push infrastructure adds native and backend lifecycle cost and remains out of scope until a concrete approved use case exists.

Criteria:

- `unapproved_push_infrastructure_components_in_v1` = 0

Required evidence:

- release bill of materials and scope review

Evidence references: none recorded
