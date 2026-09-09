# Full-catalogue routing diagnostic — router-eval-development-v0 (adopted items)

Diagnostic router-full-catalog-diagnostic-v1; Router {"decision":"router-decision-v1","taskProfile":"task-profile-v2","candidates":"router-candidates-v1","selection":"router-selection-v2","scorePolicy":"router-score-policy-v2"}.
Catalogue: 42 models, 31 enabled (lib/models.ts (static catalogue, not the runtime registry)). Plan Pro; routed under gpt-5-6-luna's cap of 128000 output tokens; no sticky state; signals supplied: none (cost derived from the pricing registry); fallback flag off.
Tie-break order: quality_band > health_degraded > expected_total_cost > recent_success_rate > ttft_p95 > model_id.

## Summary

| | |
|---|---|
| items | 210 |
| items whose explanation disagrees with the product decision | 0 |
| (model, kind) cells with approved quality evidence | 0 of 186 |
| items where dispatch's output cap differs from the Router's | 165 |
| pairwise inversions against the primary | 0 |
| enabled models never eligible on any item | 16 |
| models eligible at least once and never primary | 13 |

### Primary by model

| model | items | share |
|---|---|---|
| deepseek-v4-flash | 165 | 78.6% |
| gpt-5-6-luna | 45 | 21.4% |

### Primary by ranking kind

| kind | items | primaries |
|---|---|---|
| coding | 13 | deepseek-v4-flash 9, gpt-5-6-luna 4 |
| documents | 8 | deepseek-v4-flash 6, gpt-5-6-luna 2 |
| general | 155 | deepseek-v4-flash 123, gpt-5-6-luna 32 |
| multilingual | 15 | deepseek-v4-flash 13, gpt-5-6-luna 2 |
| research | 1 | gpt-5-6-luna 1 |
| writing | 18 | deepseek-v4-flash 14, gpt-5-6-luna 4 |

### What decided the top two

| criterion | items |
|---|---|
| expected_total_cost | 210 |

### Rejections, summed over items

| reason | model-items |
|---|---|
| context_window_undeclared | 2955 |
| disabled | 2310 |
| web_search_unsupported | 630 |
| web_search_cost_unbounded | 180 |
| web_search_unverified | 45 |

### Never eligible

| model | enabled | reasons |
|---|---|---|
| gpt-5-5 | yes | context_window_undeclared |
| gpt-5-5-thinking | yes | context_window_undeclared |
| claude-sonnet-5 | yes | context_window_undeclared |
| claude-haiku-4-5 | yes | context_window_undeclared |
| gemini-3-5-flash | no | disabled |
| gemini-3-1-pro | yes | context_window_undeclared, web_search_cost_unbounded |
| gemini-2-5-pro | no | disabled |
| llama-3-1 | no | disabled |
| llama-4-scout | no | disabled |
| llama-3-3 | no | disabled |
| grok-4 | no | disabled |
| grok-4-3 | no | disabled |
| grok-3 | no | disabled |
| grok-3-mini | no | disabled |
| deepseek-r1 | no | disabled |
| mistral-small-4 | yes | context_window_undeclared, web_search_unsupported |
| mistral-large-3 | yes | context_window_undeclared, web_search_unsupported |
| codestral | no | disabled |
| kimi-k2.7-code | yes | context_window_undeclared, web_search_unsupported |
| qwen3.7-max | yes | context_window_undeclared, web_search_unsupported |
| qwen3.7-plus | yes | context_window_undeclared, web_search_unsupported |
| qwen3.6-flash | yes | context_window_undeclared, web_search_unsupported |
| glm-5.2 | yes | context_window_undeclared, web_search_unsupported |
| perplexity/sonar | yes | context_window_undeclared |
| perplexity/sonar-pro | yes | context_window_undeclared |
| perplexity/sonar-reasoning-pro | yes | context_window_undeclared |
| perplexity/sonar-deep-research | yes | context_window_undeclared, web_search_unsupported |

### Eligible at least once, never primary

- claude-fable-5
- claude-opus-4-8
- deepseek-v4-pro
- gemini-2-5-flash
- gemini-3-6-flash
- gemini-3-7-flash
- gpt-5-4-mini
- gpt-5-6-sol
- gpt-5-6-terra
- grok-4-5
- kimi-k3
- minimax-m3
- mistral-medium-3-1

### Fallback scope as deployed

| scope | items |
|---|---|
| flag_off | 210 |

## Improvement and evaluation candidates

Offline work this diagnostic points at. None of it changes routing on its own.

- **context_window_undeclared** (210 item(s); kinds coding, documents, general, multilingual, research, writing): enabled but declares no context window in this catalogue, so the Router refuses it on every item (context_window_undeclared). Declaring the window is what makes it reachable; nothing about its quality is known either way.
  models: gpt-5-5, gpt-5-5-thinking, claude-sonnet-5, claude-haiku-4-5, gemini-3-1-pro, mistral-small-4, mistral-large-3, kimi-k2.7-code, qwen3.7-max, qwen3.7-plus, qwen3.6-flash, glm-5.2, perplexity/sonar, perplexity/sonar-pro, perplexity/sonar-reasoning-pro, perplexity/sonar-deep-research
- **eligible_never_primary** (210 item(s); kinds coding, documents, general, multilingual, research, writing): passed every hard filter on at least one item and was never chosen. With every quality band neutral, the tie-break decides, and these lose it; a comparative evaluation on the kinds they are eligible for is what could change that, and nothing else should.
  models: claude-fable-5, claude-opus-4-8, deepseek-v4-pro, gemini-2-5-flash, gemini-3-6-flash, gemini-3-7-flash, gpt-5-4-mini, gpt-5-6-sol, gpt-5-6-terra, grok-4-5, kimi-k3, minimax-m3, mistral-medium-3-1
- **no_quality_evidence_for_kind** (13 item(s); kinds coding): eligible for coding items with no approved quality evidence for that kind.
  models: claude-fable-5, claude-opus-4-8, deepseek-v4-flash, deepseek-v4-pro, gemini-2-5-flash, gemini-3-6-flash, gemini-3-7-flash, gpt-5-4-mini, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra, grok-4-5, kimi-k3, minimax-m3, mistral-medium-3-1
- **decided_by_tie_break** (13 item(s); kinds coding): coding: the primary was separated from the runner-up by expected_total_cost, not by quality.
  models: deepseek-v4-flash, gpt-5-6-luna
- **no_quality_evidence_for_kind** (8 item(s); kinds documents): eligible for documents items with no approved quality evidence for that kind.
  models: claude-fable-5, claude-opus-4-8, deepseek-v4-flash, deepseek-v4-pro, gemini-2-5-flash, gemini-3-6-flash, gemini-3-7-flash, gpt-5-4-mini, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra, grok-4-5, kimi-k3, minimax-m3, mistral-medium-3-1
- **decided_by_tie_break** (8 item(s); kinds documents): documents: the primary was separated from the runner-up by expected_total_cost, not by quality.
  models: deepseek-v4-flash, gpt-5-6-luna
- **no_quality_evidence_for_kind** (155 item(s); kinds general): eligible for general items with no approved quality evidence for that kind.
  models: claude-fable-5, claude-opus-4-8, deepseek-v4-flash, deepseek-v4-pro, gemini-2-5-flash, gemini-3-6-flash, gemini-3-7-flash, gpt-5-4-mini, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra, grok-4-5, kimi-k3, minimax-m3, mistral-medium-3-1
- **decided_by_tie_break** (155 item(s); kinds general): general: the primary was separated from the runner-up by expected_total_cost, not by quality.
  models: deepseek-v4-flash, gpt-5-6-luna
- **no_quality_evidence_for_kind** (15 item(s); kinds multilingual): eligible for multilingual items with no approved quality evidence for that kind.
  models: claude-fable-5, claude-opus-4-8, deepseek-v4-flash, deepseek-v4-pro, gemini-2-5-flash, gemini-3-6-flash, gemini-3-7-flash, gpt-5-4-mini, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra, grok-4-5, kimi-k3, minimax-m3, mistral-medium-3-1
- **decided_by_tie_break** (15 item(s); kinds multilingual): multilingual: the primary was separated from the runner-up by expected_total_cost, not by quality.
  models: deepseek-v4-flash, gpt-5-6-luna
- **no_quality_evidence_for_kind** (1 item(s); kinds research): eligible for research items with no approved quality evidence for that kind.
  models: claude-fable-5, claude-opus-4-8, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra
- **decided_by_tie_break** (1 item(s); kinds research): research: the primary was separated from the runner-up by expected_total_cost, not by quality.
  models: gpt-5-6-luna
- **no_quality_evidence_for_kind** (18 item(s); kinds writing): eligible for writing items with no approved quality evidence for that kind.
  models: claude-fable-5, claude-opus-4-8, deepseek-v4-flash, deepseek-v4-pro, gemini-2-5-flash, gemini-3-6-flash, gemini-3-7-flash, gpt-5-4-mini, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra, grok-4-5, kimi-k3, minimax-m3, mistral-medium-3-1
- **decided_by_tie_break** (18 item(s); kinds writing): writing: the primary was separated from the runner-up by expected_total_cost, not by quality.
  models: deepseek-v4-flash, gpt-5-6-luna
- **web_search_capability_gap** (45 item(s); kinds coding, documents, general, multilingual, research, writing): refused on current-information items because search support is unverified or its cost cannot be bounded. Verifying the register entry, or a backend credential, is what would admit them.
  models: gemini-2-5-flash, gemini-3-1-pro, gemini-3-6-flash, gemini-3-7-flash, gpt-5-4-mini
- **output_cap_mismatch** (165 item(s); kinds coding, documents, general, multilingual, research, writing): the Router fitted candidates under gpt-5-6-luna's cap (128000) and dispatch will budget the primary under its own. The candidate set was decided under one number and the answer is sized under another.
  models: deepseek-v4-flash

## Per item

| item | kind (conf) | primary | decided by | reason | eligible | rejected | router→dispatch output cap | first fallback |
|---|---|---|---|---|---|---|---|---|
| general-ko-001 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-002 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-003 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-005 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-006 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-009 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-010 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-011 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-012 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-013 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-ko-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-001 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-002 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-003 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-005 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-006 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-009 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-010 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-011 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-012 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-013 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| general-en-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-001 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-002 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-003 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-004 | writing (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| writing-ko-005 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-006 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-009 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-010 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-011 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-012 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| writing-ko-013 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-ko-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-001 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-002 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-003 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-005 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-006 | coding (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| coding-en-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-009 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-010 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-011 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-012 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-013 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-en-014 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-001 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-002 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-003 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-005 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-006 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-009 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-010 | documents (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-011 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-012 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| analysis-ko-013 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-ko-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| current-en-002 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-003 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| current-en-005 | coding (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-006 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| current-en-007 | research (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| current-en-009 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-010 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-011 | documents (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-012 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| current-en-013 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-014 | coding (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-en-015 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| document-ko-001 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-002 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-003 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| document-ko-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-005 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-006 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-009 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-010 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-011 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-012 | documents (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-013 | documents (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-ko-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-016 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-017 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-018 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-019 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-020 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-021 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-022 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-023 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| long-en-024 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-025 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-026 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-027 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| long-en-028 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-en-029 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-001 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-002 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-003 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-004 | multilingual (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| translation-ko-en-005 | multilingual (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| translation-ko-en-006 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-007 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-008 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-009 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-010 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-011 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-012 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-013 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| translation-ko-en-014 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-001 | documents (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-002 | writing (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| writing-en-003 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-004 | writing (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| writing-en-005 | documents (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-006 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-007 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-009 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-010 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-011 | writing (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| writing-en-012 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-013 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| writing-en-014 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-001 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-002 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-003 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-005 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-006 | coding (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| analysis-en-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-009 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-010 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-011 | documents (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-012 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-013 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| analysis-en-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-001 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-002 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-003 | documents (weak) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| document-en-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-005 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-006 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-008 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-009 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-010 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-011 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-012 | multilingual (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| document-en-013 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| document-en-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| current-ko-002 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-003 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| current-ko-004 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-005 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-006 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-007 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-008 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-009 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-010 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-011 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-012 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-013 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| current-ko-014 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| current-ko-015 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| coding-ko-001 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-002 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-003 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-005 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-006 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-008 | writing (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-009 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-010 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| coding-ko-011 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-012 | coding (weak) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| coding-ko-013 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| coding-ko-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-ko-002 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| long-ko-003 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-ko-004 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-ko-005 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-ko-006 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| long-ko-007 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-ko-008 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| long-ko-009 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| long-ko-010 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| long-ko-011 | general (none) | gpt-5-6-luna | expected_total_cost | fallback_order | 5 | 37 | 128000→128000 | gpt-5-6-terra (flag_off) |
| long-ko-012 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-ko-013 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-ko-014 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
| long-ko-015 | general (none) | deepseek-v4-flash | expected_total_cost | fallback_order | 15 | 27 | 128000→384000 (differs) | deepseek-v4-pro (flag_off) |
