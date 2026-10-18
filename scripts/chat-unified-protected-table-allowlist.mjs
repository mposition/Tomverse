/** Exact-count unified SQL exceptions and protected tables for the imported U21 backend.
 * Existing reviewed reasons are preserved; writer permissions are limited to files in this release.
 * Source: unified stage a7e63153d0341b693e65b1627fb6d5c3c637e40c.
 */
export const CHAT_UNIFIED_RAW_SQL_ALLOWLIST = [
  {
    "path": "prisma/migrations/20261016180000_chat_unified_router_refiner_receipts/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 8,
    "writeVerbs": 18,
    "reason": "Additive U13 DDL creates only the two content-free immutable receipt tables and binding/append-only guards, and tightens the prior consume audit target. It seeds no row and writes no audit, attempt or result row."
  },
  {
    "path": "prisma/migrations/20261016180000_chat_unified_router_refiner_receipts/migration.sql",
    "table": "PromptRefinerProductAttempt",
    "tableMentions": 2,
    "writeVerbs": 18,
    "reason": "Additive U13 DDL creates only the two content-free immutable receipt tables and binding/append-only guards, and tightens the prior consume audit target. It seeds no row and writes no audit, attempt or result row."
  },
  {
    "path": "prisma/migrations/20261016180000_chat_unified_router_refiner_receipts/migration.sql",
    "table": "ChatUnifiedRouterRefinerResult",
    "tableMentions": 5,
    "writeVerbs": 18,
    "reason": "Additive U13 DDL creates only the two content-free immutable receipt tables and binding/append-only guards, and tightens the prior consume audit target. It seeds no row and writes no audit, attempt or result row."
  },
  {
    "path": "prisma/migrations/20261016180000_chat_unified_router_refiner_receipts/migration.sql",
    "table": "ChatUnifiedExecutionReceipt",
    "tableMentions": 14,
    "writeVerbs": 18,
    "reason": "Additive U13 DDL creates only the two content-free immutable receipt tables and binding/append-only guards, and tightens the prior consume audit target. It seeds no row and writes no audit, attempt or result row."
  },
  {
    "path": "prisma/migrations/20261016180000_chat_unified_router_refiner_receipts/migration.sql",
    "table": "ChatUnifiedRoutingReceipt",
    "tableMentions": 13,
    "writeVerbs": 18,
    "reason": "Additive U13 DDL creates only the two content-free immutable receipt tables and binding/append-only guards, and tightens the prior consume audit target. It seeds no row and writes no audit, attempt or result row."
  },
  {
    "path": "lib/chatUnifiedOptimizerLedgerStore.ts",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 10,
    "writeVerbs": 17,
    "reason": "The registered ledger writer uses fixed raw SQL for provider-free registration, role claims, terminal evidence, queued closure, and its durable first-attempt intent. Writes use the canonical audit and optimizer locks; no body, paid dispatch, promotion or runtime authority is stored (docs/policy/chat-unified-router-refiner-v1.md §§7,12)."
  },
  {
    "path": "lib/chatUnifiedOptimizerLedgerStore.ts",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 7,
    "writeVerbs": 17,
    "reason": "The registered ledger writer uses fixed raw SQL for provider-free registration, role claims, terminal evidence, queued closure, and its durable first-attempt intent. Writes use the canonical audit and optimizer locks; no body, paid dispatch, promotion or runtime authority is stored (docs/policy/chat-unified-router-refiner-v1.md §§7,12)."
  },
  {
    "path": "lib/chatUnifiedOptimizerLedgerStore.ts",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 10,
    "writeVerbs": 17,
    "reason": "The registered ledger writer uses fixed raw SQL for provider-free registration, role claims, terminal evidence, queued closure, and its durable first-attempt intent. Writes use the canonical audit and optimizer locks; no body, paid dispatch, promotion or runtime authority is stored (docs/policy/chat-unified-router-refiner-v1.md §§7,12)."
  },
  {
    "path": "lib/chatUnifiedOptimizerLedgerStore.ts",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 17,
    "writeVerbs": 17,
    "reason": "The registered ledger writer uses fixed raw SQL for provider-free registration, role claims, terminal evidence, queued closure, and its durable first-attempt intent. Writes use the canonical audit and optimizer locks; no body, paid dispatch, promotion or runtime authority is stored (docs/policy/chat-unified-router-refiner-v1.md §§7,12)."
  },
  {
    "path": "lib/chatUnifiedOptimizerLedgerStore.ts",
    "table": "ChatUnifiedOptimizerEvidence",
    "tableMentions": 5,
    "writeVerbs": 17,
    "reason": "The registered ledger writer uses fixed raw SQL for provider-free registration, role claims, terminal evidence, queued closure, and its durable first-attempt intent. Writes use the canonical audit and optimizer locks; no body, paid dispatch, promotion or runtime authority is stored (docs/policy/chat-unified-router-refiner-v1.md §§7,12)."
  },
  {
    "path": "lib/chatUnifiedOptimizerLedgerStore.ts",
    "table": "ChatUnifiedOptimizerQueuedCloseIntent",
    "tableMentions": 3,
    "writeVerbs": 17,
    "reason": "The registered ledger writer uses fixed raw SQL for provider-free registration, role claims, terminal evidence, queued closure, and its durable first-attempt intent. Writes use the canonical audit and optimizer locks; no body, paid dispatch, promotion or runtime authority is stored (docs/policy/chat-unified-router-refiner-v1.md §§7,12)."
  },
  {
    "path": "lib/chatUnifiedOptimizerLedgerStore.ts",
    "table": "AdminAuditLog",
    "tableMentions": 2,
    "writeVerbs": 17,
    "reason": "The U18 queued-closure readback joins its immutable terminal audit row to verify exact replay. Audit writes still go only through writeSystemAuditLog under the canonical audit lock (docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12)."
  },
  {
    "path": "prisma/migrations/20261016200000_chat_unified_optimizer_ledger/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 11,
    "writeVerbs": 66,
    "reason": "Additive U18 DDL creates only the content-free provider-free optimizer metadata ledger, its exact same-transaction audit/FK bindings, immutable evidence and lifecycle/CAS guards. It seeds no row and never writes AdminAuditLog, paid authority, external dispatch authority, promotion authority or product runtime state."
  },
  {
    "path": "prisma/migrations/20261016200000_chat_unified_optimizer_ledger/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 13,
    "writeVerbs": 66,
    "reason": "Additive U18 DDL creates only the content-free provider-free optimizer metadata ledger, its exact same-transaction audit/FK bindings, immutable evidence and lifecycle/CAS guards. It seeds no row and never writes AdminAuditLog, paid authority, external dispatch authority, promotion authority or product runtime state."
  },
  {
    "path": "prisma/migrations/20261016200000_chat_unified_optimizer_ledger/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 13,
    "writeVerbs": 66,
    "reason": "Additive U18 DDL creates only the content-free provider-free optimizer metadata ledger, its exact same-transaction audit/FK bindings, immutable evidence and lifecycle/CAS guards. It seeds no row and never writes AdminAuditLog, paid authority, external dispatch authority, promotion authority or product runtime state."
  },
  {
    "path": "prisma/migrations/20261016200000_chat_unified_optimizer_ledger/migration.sql",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 20,
    "writeVerbs": 66,
    "reason": "Additive U18 DDL creates only the content-free provider-free optimizer metadata ledger, its exact same-transaction audit/FK bindings, immutable evidence and lifecycle/CAS guards. It seeds no row and never writes AdminAuditLog, paid authority, external dispatch authority, promotion authority or product runtime state."
  },
  {
    "path": "prisma/migrations/20261016200000_chat_unified_optimizer_ledger/migration.sql",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 25,
    "writeVerbs": 66,
    "reason": "Additive U18 DDL creates only the content-free provider-free optimizer metadata ledger, its exact same-transaction audit/FK bindings, immutable evidence and lifecycle/CAS guards. It seeds no row and never writes AdminAuditLog, paid authority, external dispatch authority, promotion authority or product runtime state."
  },
  {
    "path": "prisma/migrations/20261016200000_chat_unified_optimizer_ledger/migration.sql",
    "table": "ChatUnifiedOptimizerEvidence",
    "tableMentions": 16,
    "writeVerbs": 66,
    "reason": "Additive U18 DDL creates only the content-free provider-free optimizer metadata ledger, its exact same-transaction audit/FK bindings, immutable evidence and lifecycle/CAS guards. It seeds no row and never writes AdminAuditLog, paid authority, external dispatch authority, promotion authority or product runtime state."
  },
  {
    "path": "prisma/migrations/20261016201000_chat_unified_optimizer_deadline_guard/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 3,
    "writeVerbs": 6,
    "reason": "Additive U18 deadline-guard DDL installs only deferred database-clock checks on the existing optimizer lifecycle tables. It writes no ledger or audit row and grants no provider, paid, promotion or product-runtime authority."
  },
  {
    "path": "prisma/migrations/20261016201000_chat_unified_optimizer_deadline_guard/migration.sql",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 3,
    "writeVerbs": 6,
    "reason": "Additive U18 deadline-guard DDL installs only deferred database-clock checks on the existing optimizer lifecycle tables. It writes no ledger or audit row and grants no provider, paid, promotion or product-runtime authority."
  },
  {
    "path": "prisma/migrations/20261016201000_chat_unified_optimizer_deadline_guard/migration.sql",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 1,
    "writeVerbs": 6,
    "reason": "Additive U18 deadline-guard DDL installs only deferred database-clock checks on the existing optimizer lifecycle tables. It writes no ledger or audit row and grants no provider, paid, promotion or product-runtime authority."
  },
  {
    "path": "prisma/migrations/20261016203000_chat_unified_optimizer_queued_closure/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 9,
    "writeVerbs": 5,
    "reason": "Additive U18 repair DDL permits only same-transaction audited queued-before-dispatch cancellation or expiry, requires exact evidence and aggregate closure at deferred commit, and leaves claimed outcomes latched for readback. It writes no ledger or audit row itself and grants no provider, paid, promotion or runtime authority (docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12)."
  },
  {
    "path": "prisma/migrations/20261016203000_chat_unified_optimizer_queued_closure/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 3,
    "writeVerbs": 5,
    "reason": "Additive U18 repair DDL permits only same-transaction audited queued-before-dispatch cancellation or expiry, requires exact evidence and aggregate closure at deferred commit, and leaves claimed outcomes latched for readback. It writes no ledger or audit row itself and grants no provider, paid, promotion or runtime authority (docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12)."
  },
  {
    "path": "prisma/migrations/20261016203000_chat_unified_optimizer_queued_closure/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 2,
    "writeVerbs": 5,
    "reason": "Additive U18 repair DDL permits only same-transaction audited queued-before-dispatch cancellation or expiry, requires exact evidence and aggregate closure at deferred commit, and leaves claimed outcomes latched for readback. It writes no ledger or audit row itself and grants no provider, paid, promotion or runtime authority (docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12)."
  },
  {
    "path": "prisma/migrations/20261016203000_chat_unified_optimizer_queued_closure/migration.sql",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 5,
    "writeVerbs": 5,
    "reason": "Additive U18 repair DDL permits only same-transaction audited queued-before-dispatch cancellation or expiry, requires exact evidence and aggregate closure at deferred commit, and leaves claimed outcomes latched for readback. It writes no ledger or audit row itself and grants no provider, paid, promotion or runtime authority (docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12)."
  },
  {
    "path": "prisma/migrations/20261016203000_chat_unified_optimizer_queued_closure/migration.sql",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 13,
    "writeVerbs": 5,
    "reason": "Additive U18 repair DDL permits only same-transaction audited queued-before-dispatch cancellation or expiry, requires exact evidence and aggregate closure at deferred commit, and leaves claimed outcomes latched for readback. It writes no ledger or audit row itself and grants no provider, paid, promotion or runtime authority (docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12)."
  },
  {
    "path": "prisma/migrations/20261016203000_chat_unified_optimizer_queued_closure/migration.sql",
    "table": "ChatUnifiedOptimizerEvidence",
    "tableMentions": 3,
    "writeVerbs": 5,
    "reason": "Additive U18 repair DDL permits only same-transaction audited queued-before-dispatch cancellation or expiry, requires exact evidence and aggregate closure at deferred commit, and leaves claimed outcomes latched for readback. It writes no ledger or audit row itself and grants no provider, paid, promotion or runtime authority (docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12)."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed U18 system-actor predicate names this content-free provider-free ledger audit target. It executes no SQL and grants no paid call, external dispatch, promotion or product-runtime authority."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed U18 system-actor predicate names this content-free provider-free ledger audit target. It executes no SQL and grants no paid call, external dispatch, promotion or product-runtime authority."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerProtectedHandoff",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed optimizer system-actor predicate names only the content-free protected handoff audit target; it executes no SQL or vendor process."
  },
  {
    "path": "prisma/migrations/20261016211000_chat_unified_optimizer_source_pin/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 2,
    "writeVerbs": 2,
    "reason": "Additive source-pin DDL adds nullable public-source identity fields and a completeness check; it seeds no candidate or audit row."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 5,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 1,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 1,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerCostPlan",
    "tableMentions": 1,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerCostRun",
    "tableMentions": 1,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerQuotaContract",
    "tableMentions": 1,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerCostCall",
    "tableMentions": 1,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerDispatchHold",
    "tableMentions": 4,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016212000_chat_unified_optimizer_protected_handoff/migration.sql",
    "table": "ChatUnifiedOptimizerProtectedHandoff",
    "tableMentions": 6,
    "writeVerbs": 14,
    "reason": "Additive protected-handoff DDL creates one content-free append-only nonce table, same-transaction audit and commit-time freshness guards; it seeds no row or vendor authority."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 15,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 3,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 3,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 3,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerCostPlan",
    "tableMentions": 27,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerCostRun",
    "tableMentions": 24,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerQuotaContract",
    "tableMentions": 14,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerCostCall",
    "tableMentions": 23,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerCostWindow",
    "tableMentions": 8,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016202000_chat_unified_optimizer_cost_budget/migration.sql",
    "table": "ChatUnifiedOptimizerDispatchHold",
    "tableMentions": 40,
    "writeVerbs": 98,
    "reason": "Additive U19 DDL creates only the content-free internal optimizer cost/quota ledger and its exact audit, immutable identity, state-machine, cap, aggregate and PostgreSQL 17 late-success guards. It seeds no row, grants no vendor dispatch and never changes product/user credit budgets."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 4,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 1,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 1,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "ChatUnifiedOptimizerCostPlan",
    "tableMentions": 1,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "ChatUnifiedOptimizerCostRun",
    "tableMentions": 1,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "ChatUnifiedOptimizerQuotaContract",
    "tableMentions": 1,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "ChatUnifiedOptimizerCostCall",
    "tableMentions": 1,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "prisma/migrations/20261016204000_chat_unified_optimizer_payload_manifest/migration.sql",
    "table": "ChatUnifiedOptimizerDispatchHold",
    "tableMentions": 7,
    "writeVerbs": 6,
    "reason": "Additive U19 DDL binds each new reservation to its same-transaction audit payload manifest and refuses a newly stale intent at deferred commit. It inserts no ledger or audit row, permits terminal fact closure after expiry, grants no paid call or vendor dispatch authority, and leaves the frozen 20261016202000 migration unchanged."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerCostPlan",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed U19 predicate names only exact cost-plan or cost-call ledger audit actions. It performs no SQL and grants no owner activation, payment, provider call or external dispatch authority."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerDispatchHold",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed U19 predicate names only exact cost-plan or cost-call ledger audit actions. It performs no SQL and grants no owner activation, payment, provider call or external dispatch authority."
  },
  {
    "path": "prisma/migrations/20261016214000_chat_unified_optimizer_canary_rollout/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 2,
    "writeVerbs": 9,
    "reason": "U28 additive DDL creates a promotion-bound canary rollout table with an inert prepared phase. Protected audit, candidate and promotion rows are foreign-key references only; it seeds no row and grants no serving authority."
  },
  {
    "path": "prisma/migrations/20261016214000_chat_unified_optimizer_canary_rollout/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 1,
    "writeVerbs": 9,
    "reason": "U28 additive DDL creates a promotion-bound canary rollout table with an inert prepared phase. Protected audit, candidate and promotion rows are foreign-key references only; it seeds no row and grants no serving authority."
  },
  {
    "path": "prisma/migrations/20261016214000_chat_unified_optimizer_canary_rollout/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 1,
    "writeVerbs": 9,
    "reason": "U28 additive DDL creates a promotion-bound canary rollout table with an inert prepared phase. Protected audit, candidate and promotion rows are foreign-key references only; it seeds no row and grants no serving authority."
  },
  {
    "path": "prisma/migrations/20261016214000_chat_unified_optimizer_canary_rollout/migration.sql",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 4,
    "writeVerbs": 9,
    "reason": "U28 additive DDL creates a promotion-bound canary rollout table with an inert prepared phase. Protected audit, candidate and promotion rows are foreign-key references only; it seeds no row and grants no serving authority."
  },
  {
    "path": "prisma/migrations/20261016215000_chat_unified_optimizer_canary_rollout_guard/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 2,
    "writeVerbs": 10,
    "reason": "U28 additive guards read exact promotion/candidate/pointer/audit identity, forbid prepared rollout UPDATE or DELETE, and require a same-transaction rollout for each new promotion receipt at commit. Protected source tables are not mutated; no runtime phase or serving authority is granted."
  },
  {
    "path": "prisma/migrations/20261016215000_chat_unified_optimizer_canary_rollout_guard/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 10,
    "reason": "U28 additive guards read exact promotion/candidate/pointer/audit identity, forbid prepared rollout UPDATE or DELETE, and require a same-transaction rollout for each new promotion receipt at commit. Protected source tables are not mutated; no runtime phase or serving authority is granted."
  },
  {
    "path": "prisma/migrations/20261016215000_chat_unified_optimizer_canary_rollout_guard/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 2,
    "writeVerbs": 10,
    "reason": "U28 additive guards read exact promotion/candidate/pointer/audit identity, forbid prepared rollout UPDATE or DELETE, and require a same-transaction rollout for each new promotion receipt at commit. Protected source tables are not mutated; no runtime phase or serving authority is granted."
  },
  {
    "path": "prisma/migrations/20261016215000_chat_unified_optimizer_canary_rollout_guard/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 2,
    "writeVerbs": 10,
    "reason": "U28 additive guards read exact promotion/candidate/pointer/audit identity, forbid prepared rollout UPDATE or DELETE, and require a same-transaction rollout for each new promotion receipt at commit. Protected source tables are not mutated; no runtime phase or serving authority is granted."
  },
  {
    "path": "prisma/migrations/20261016215000_chat_unified_optimizer_canary_rollout_guard/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 4,
    "writeVerbs": 10,
    "reason": "U28 additive guards read exact promotion/candidate/pointer/audit identity, forbid prepared rollout UPDATE or DELETE, and require a same-transaction rollout for each new promotion receipt at commit. Protected source tables are not mutated; no runtime phase or serving authority is granted."
  },
  {
    "path": "prisma/migrations/20261016215000_chat_unified_optimizer_canary_rollout_guard/migration.sql",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 6,
    "writeVerbs": 10,
    "reason": "U28 additive guards read exact promotion/candidate/pointer/audit identity, forbid prepared rollout UPDATE or DELETE, and require a same-transaction rollout for each new promotion receipt at commit. Protected source tables are not mutated; no runtime phase or serving authority is granted."
  },
  {
    "path": "prisma/migrations/20261017070000_chat_unified_optimizer_canary_prepared_shape/migration.sql",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 2,
    "writeVerbs": 2,
    "reason": "U28 additive DDL rejects non-prepared rollout INSERT and TRUNCATE. It creates no row, does not change the promotion writer, and grants no product routing authority."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 3,
    "writeVerbs": 2,
    "reason": "The closed U28 actor predicate names only inert preparation, exact first-phase activation and sequential phase-advance audit actions for the same rollout target. It executes no SQL or product dispatch."
  },
  {
    "path": "prisma/migrations/20261017071000_chat_unified_optimizer_canary_start/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 4,
    "writeVerbs": 17,
    "reason": "U28 additive DDL allows only the audited prepared-to-5% rollout plus same-revision pointer activation, with deferred all-or-nothing binding. It preserves immutable snapshots and the previous promotion and prepared-rollback guards; no data row is changed by migration."
  },
  {
    "path": "prisma/migrations/20261017071000_chat_unified_optimizer_canary_start/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 17,
    "reason": "U28 additive DDL allows only the audited prepared-to-5% rollout plus same-revision pointer activation, with deferred all-or-nothing binding. It preserves immutable snapshots and the previous promotion and prepared-rollback guards; no data row is changed by migration."
  },
  {
    "path": "prisma/migrations/20261017071000_chat_unified_optimizer_canary_start/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 14,
    "writeVerbs": 17,
    "reason": "U28 additive DDL allows only the audited prepared-to-5% rollout plus same-revision pointer activation, with deferred all-or-nothing binding. It preserves immutable snapshots and the previous promotion and prepared-rollback guards; no data row is changed by migration."
  },
  {
    "path": "prisma/migrations/20261017071000_chat_unified_optimizer_canary_start/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 6,
    "writeVerbs": 17,
    "reason": "U28 additive DDL allows only the audited prepared-to-5% rollout plus same-revision pointer activation, with deferred all-or-nothing binding. It preserves immutable snapshots and the previous promotion and prepared-rollback guards; no data row is changed by migration."
  },
  {
    "path": "prisma/migrations/20261017071000_chat_unified_optimizer_canary_start/migration.sql",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 9,
    "writeVerbs": 17,
    "reason": "U28 additive DDL allows only the audited prepared-to-5% rollout plus same-revision pointer activation, with deferred all-or-nothing binding. It preserves immutable snapshots and the previous promotion and prepared-rollback guards; no data row is changed by migration."
  },
  {
    "path": "prisma/migrations/20261017072000_chat_unified_optimizer_live_legacy_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 4,
    "writeVerbs": 2,
    "reason": "U28 guard-only replacement reads the exact failed promotion and live rollout before allowing an audited rollback to the immutable legacy snapshot. It changes no row during migration and keeps active-to-frozen restoration closed."
  },
  {
    "path": "prisma/migrations/20261017072000_chat_unified_optimizer_live_legacy_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 3,
    "writeVerbs": 2,
    "reason": "U28 guard-only replacement reads the exact failed promotion and live rollout before allowing an audited rollback to the immutable legacy snapshot. It changes no row during migration and keeps active-to-frozen restoration closed."
  },
  {
    "path": "prisma/migrations/20261017075000_chat_unified_optimizer_later_atomic_start/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 3,
    "reason": "U28 guard-only replacement permits a later promotion only when its exact prior active-100 incumbent is bound and the replacement reaches 5% in the same transaction. It changes no row during migration and retains the closed active-bundle rollback path."
  },
  {
    "path": "prisma/migrations/20261017075000_chat_unified_optimizer_later_atomic_start/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 2,
    "writeVerbs": 3,
    "reason": "U28 guard-only replacement permits a later promotion only when its exact prior active-100 incumbent is bound and the replacement reaches 5% in the same transaction. It changes no row during migration and retains the closed active-bundle rollback path."
  },
  {
    "path": "prisma/migrations/20261017075000_chat_unified_optimizer_later_atomic_start/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 7,
    "writeVerbs": 3,
    "reason": "U28 guard-only replacement permits a later promotion only when its exact prior active-100 incumbent is bound and the replacement reaches 5% in the same transaction. It changes no row during migration and retains the closed active-bundle rollback path."
  },
  {
    "path": "prisma/migrations/20261017075000_chat_unified_optimizer_later_atomic_start/migration.sql",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 8,
    "writeVerbs": 3,
    "reason": "U28 guard-only replacement permits a later promotion only when its exact prior active-100 incumbent is bound and the replacement reaches 5% in the same transaction. It changes no row during migration and retains the closed active-bundle rollback path."
  },
  {
    "path": "prisma/migrations/20261017076000_chat_unified_optimizer_frozen_rollback/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 3,
    "writeVerbs": 5,
    "reason": "U28 guard-only replacement permits a signed known-failure rollback to restore the exact prior active-100 bundle after verifying the failed and prior rollout, cycle, latch, immutable snapshot and audit. It changes no row during migration and grants no owner release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017076000_chat_unified_optimizer_frozen_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 2,
    "writeVerbs": 5,
    "reason": "U28 guard-only replacement permits a signed known-failure rollback to restore the exact prior active-100 bundle after verifying the failed and prior rollout, cycle, latch, immutable snapshot and audit. It changes no row during migration and grants no owner release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017076000_chat_unified_optimizer_frozen_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 2,
    "writeVerbs": 5,
    "reason": "U28 guard-only replacement permits a signed known-failure rollback to restore the exact prior active-100 bundle after verifying the failed and prior rollout, cycle, latch, immutable snapshot and audit. It changes no row during migration and grants no owner release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017076000_chat_unified_optimizer_frozen_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 4,
    "writeVerbs": 5,
    "reason": "U28 guard-only replacement permits a signed known-failure rollback to restore the exact prior active-100 bundle after verifying the failed and prior rollout, cycle, latch, immutable snapshot and audit. It changes no row during migration and grants no owner release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017076000_chat_unified_optimizer_frozen_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 11,
    "writeVerbs": 5,
    "reason": "U28 guard-only replacement permits a signed known-failure rollback to restore the exact prior active-100 bundle after verifying the failed and prior rollout, cycle, latch, immutable snapshot and audit. It changes no row during migration and grants no owner release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017076000_chat_unified_optimizer_frozen_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 6,
    "writeVerbs": 5,
    "reason": "U28 guard-only replacement permits a signed known-failure rollback to restore the exact prior active-100 bundle after verifying the failed and prior rollout, cycle, latch, immutable snapshot and audit. It changes no row during migration and grants no owner release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017080000_chat_unified_optimizer_recurring_frozen_origin/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 3,
    "writeVerbs": 2,
    "reason": "Guard-only U27/U28 replacement follows immutable rollback snapshots to the original active-100 promotion and checks audit, cycle and latch before recurring graduation or restoration. Historical deferred receipts bind to exact immutable snapshots after a later pointer revision. This migration writes no rows and grants no release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017080000_chat_unified_optimizer_recurring_frozen_origin/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 2,
    "writeVerbs": 2,
    "reason": "Guard-only U27/U28 replacement follows immutable rollback snapshots to the original active-100 promotion and checks audit, cycle and latch before recurring graduation or restoration. Historical deferred receipts bind to exact immutable snapshots after a later pointer revision. This migration writes no rows and grants no release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017080000_chat_unified_optimizer_recurring_frozen_origin/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 4,
    "writeVerbs": 2,
    "reason": "Guard-only U27/U28 replacement follows immutable rollback snapshots to the original active-100 promotion and checks audit, cycle and latch before recurring graduation or restoration. Historical deferred receipts bind to exact immutable snapshots after a later pointer revision. This migration writes no rows and grants no release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017080000_chat_unified_optimizer_recurring_frozen_origin/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 4,
    "writeVerbs": 2,
    "reason": "Guard-only U27/U28 replacement follows immutable rollback snapshots to the original active-100 promotion and checks audit, cycle and latch before recurring graduation or restoration. Historical deferred receipts bind to exact immutable snapshots after a later pointer revision. This migration writes no rows and grants no release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017080000_chat_unified_optimizer_recurring_frozen_origin/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 17,
    "writeVerbs": 2,
    "reason": "Guard-only U27/U28 replacement follows immutable rollback snapshots to the original active-100 promotion and checks audit, cycle and latch before recurring graduation or restoration. Historical deferred receipts bind to exact immutable snapshots after a later pointer revision. This migration writes no rows and grants no release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017080000_chat_unified_optimizer_recurring_frozen_origin/migration.sql",
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "tableMentions": 10,
    "writeVerbs": 2,
    "reason": "Guard-only U27/U28 replacement follows immutable rollback snapshots to the original active-100 promotion and checks audit, cycle and latch before recurring graduation or restoration. Historical deferred receipts bind to exact immutable snapshots after a later pointer revision. This migration writes no rows and grants no release or vendor authority."
  },
  {
    "path": "prisma/migrations/20261017078000_chat_unified_optimizer_frozen_restore_release_guard/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 2,
    "writeVerbs": 1,
    "reason": "U28 additive guard reads the exact owner release setting and activation audit before a frozen-bundle rollback can leave runtime authority live. Its only write verb is the protected pointer UPDATE trigger event; the migration writes no audit or pointer row."
  },
  {
    "path": "prisma/migrations/20261017078000_chat_unified_optimizer_frozen_restore_release_guard/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 1,
    "writeVerbs": 1,
    "reason": "U28 additive guard reads the exact owner release setting and activation audit before a frozen-bundle rollback can leave runtime authority live. Its only write verb is the protected pointer UPDATE trigger event; the migration writes no audit or pointer row."
  },
  {
    "path": "prisma/migrations/20261016206000_chat_unified_optimizer_promotion/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 3,
    "writeVerbs": 20,
    "reason": "Additive U27 DDL creates only a runtime-disabled candidate pointer and immutable content-free promotion receipt, with exact candidate, audit, CAS and deferred same-transaction guards. It seeds no row, bootstraps no operational pointer and grants no provider, paid, deployment or product-runtime authority (docs/policy/chat-unified-router-refiner-v1.md §11)."
  },
  {
    "path": "prisma/migrations/20261016206000_chat_unified_optimizer_promotion/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 4,
    "writeVerbs": 20,
    "reason": "Additive U27 DDL creates only a runtime-disabled candidate pointer and immutable content-free promotion receipt, with exact candidate, audit, CAS and deferred same-transaction guards. It seeds no row, bootstraps no operational pointer and grants no provider, paid, deployment or product-runtime authority (docs/policy/chat-unified-router-refiner-v1.md §11)."
  },
  {
    "path": "prisma/migrations/20261016206000_chat_unified_optimizer_promotion/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 10,
    "writeVerbs": 20,
    "reason": "Additive U27 DDL creates only a runtime-disabled candidate pointer and immutable content-free promotion receipt, with exact candidate, audit, CAS and deferred same-transaction guards. It seeds no row, bootstraps no operational pointer and grants no provider, paid, deployment or product-runtime authority (docs/policy/chat-unified-router-refiner-v1.md §11)."
  },
  {
    "path": "prisma/migrations/20261016206000_chat_unified_optimizer_promotion/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 14,
    "writeVerbs": 20,
    "reason": "Additive U27 DDL creates only a runtime-disabled candidate pointer and immutable content-free promotion receipt, with exact candidate, audit, CAS and deferred same-transaction guards. It seeds no row, bootstraps no operational pointer and grants no provider, paid, deployment or product-runtime authority (docs/policy/chat-unified-router-refiner-v1.md §11)."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed U27 actor predicate names only the runtime-disabled pointer-preparation receipt action. It executes no SQL and grants no approval, serving or product-runtime authority (docs/policy/chat-unified-router-refiner-v1.md §11)."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerComparisonVerdict",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed U29 actor predicate names one case-blind aggregate verdict audit target. It executes no SQL and grants no promotion, product or publisher authority."
  },
  {
    "path": "prisma/migrations/20261017081000_chat_unified_optimizer_comparison_verdict/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 1,
    "writeVerbs": 9,
    "reason": "Additive U29 DDL creates one immutable content-free aggregate verdict table and FKs to the existing cycle, candidate and canonical audit. It seeds no row and grants no paid, promotion, product or publisher authority."
  },
  {
    "path": "prisma/migrations/20261017081000_chat_unified_optimizer_comparison_verdict/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 9,
    "reason": "Additive U29 DDL creates one immutable content-free aggregate verdict table and FKs to the existing cycle, candidate and canonical audit. It seeds no row and grants no paid, promotion, product or publisher authority."
  },
  {
    "path": "prisma/migrations/20261017081000_chat_unified_optimizer_comparison_verdict/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 1,
    "writeVerbs": 9,
    "reason": "Additive U29 DDL creates one immutable content-free aggregate verdict table and FKs to the existing cycle, candidate and canonical audit. It seeds no row and grants no paid, promotion, product or publisher authority."
  },
  {
    "path": "prisma/migrations/20261017081000_chat_unified_optimizer_comparison_verdict/migration.sql",
    "table": "ChatUnifiedOptimizerComparisonVerdict",
    "tableMentions": 4,
    "writeVerbs": 9,
    "reason": "Additive U29 DDL creates one immutable content-free aggregate verdict table and FKs to the existing cycle, candidate and canonical audit. It seeds no row and grants no paid, promotion, product or publisher authority."
  },
  {
    "path": "prisma/migrations/20261017090000_chat_unified_optimizer_engineering_draft/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 1,
    "writeVerbs": 9,
    "reason": "Additive U29 DDL creates one immutable case-blind draft with restrictive verdict, cycle and canonical-audit foreign keys. It seeds no row and grants no AMUX registration, model call or Publisher authority."
  },
  {
    "path": "prisma/migrations/20261017090000_chat_unified_optimizer_engineering_draft/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 9,
    "reason": "Additive U29 DDL creates one immutable case-blind draft with restrictive verdict, cycle and canonical-audit foreign keys. It seeds no row and grants no AMUX registration, model call or Publisher authority."
  },
  {
    "path": "prisma/migrations/20261017090000_chat_unified_optimizer_engineering_draft/migration.sql",
    "table": "ChatUnifiedOptimizerComparisonVerdict",
    "tableMentions": 1,
    "writeVerbs": 9,
    "reason": "Additive U29 DDL creates one immutable case-blind draft with restrictive verdict, cycle and canonical-audit foreign keys. It seeds no row and grants no AMUX registration, model call or Publisher authority."
  },
  {
    "path": "prisma/migrations/20261017090000_chat_unified_optimizer_engineering_draft/migration.sql",
    "table": "ChatUnifiedOptimizerEngineeringDraft",
    "tableMentions": 4,
    "writeVerbs": 9,
    "reason": "Additive U29 DDL creates one immutable case-blind draft with restrictive verdict, cycle and canonical-audit foreign keys. It seeds no row and grants no AMUX registration, model call or Publisher authority."
  },
  {
    "path": "prisma/migrations/20261017091000_chat_unified_optimizer_queued_close_intent/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 3,
    "writeVerbs": 12,
    "reason": "Additive U26 DDL creates one immutable, content-free first-attempt fence with an exact same-transaction system audit. It seeds no row and grants no paid call, provider dispatch, promotion or product runtime authority."
  },
  {
    "path": "prisma/migrations/20261017091000_chat_unified_optimizer_queued_close_intent/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 3,
    "writeVerbs": 12,
    "reason": "Additive U26 DDL creates one immutable, content-free first-attempt fence with an exact same-transaction system audit. It seeds no row and grants no paid call, provider dispatch, promotion or product runtime authority."
  },
  {
    "path": "prisma/migrations/20261017091000_chat_unified_optimizer_queued_close_intent/migration.sql",
    "table": "ChatUnifiedOptimizerRun",
    "tableMentions": 2,
    "writeVerbs": 12,
    "reason": "Additive U26 DDL creates one immutable, content-free first-attempt fence with an exact same-transaction system audit. It seeds no row and grants no paid call, provider dispatch, promotion or product runtime authority."
  },
  {
    "path": "prisma/migrations/20261017091000_chat_unified_optimizer_queued_close_intent/migration.sql",
    "table": "ChatUnifiedOptimizerRoleJob",
    "tableMentions": 2,
    "writeVerbs": 12,
    "reason": "Additive U26 DDL creates one immutable, content-free first-attempt fence with an exact same-transaction system audit. It seeds no row and grants no paid call, provider dispatch, promotion or product runtime authority."
  },
  {
    "path": "prisma/migrations/20261017091000_chat_unified_optimizer_queued_close_intent/migration.sql",
    "table": "ChatUnifiedOptimizerQueuedCloseIntent",
    "tableMentions": 8,
    "writeVerbs": 12,
    "reason": "Additive U26 DDL creates one immutable, content-free first-attempt fence with an exact same-transaction system audit. It seeds no row and grants no paid call, provider dispatch, promotion or product runtime authority."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerQueuedCloseIntent",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed U26 actor predicate names only the content-free queued closure intent audit target; it executes no SQL."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedOptimizerEngineeringDraft",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "The closed U29 predicate names only the content-free draft audit target; it executes no SQL or AMUX registration."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedRouterRefinerResult",
    "tableMentions": 2,
    "writeVerbs": 2,
    "reason": "Exact unified consumption/receipt audit action-target literals only. This predicate executes no SQL and grants no approval, rollout or provider authority."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedExecutionReceipt",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "Exact unified consumption/receipt audit action-target literals only. This predicate executes no SQL and grants no approval, rollout or provider authority."
  },
  {
    "path": "lib/adminAuditSystemActors.ts",
    "table": "ChatUnifiedRoutingReceipt",
    "tableMentions": 1,
    "writeVerbs": 2,
    "reason": "Exact unified consumption/receipt audit action-target literals only. This predicate executes no SQL and grants no approval, rollout or provider authority."
  },
  {
    "path": "prisma/migrations/20261016130000_chat_unified_router_refiner_result/migration.sql",
    "table": "PromptRefinerChatScope",
    "tableMentions": 5,
    "writeVerbs": 36,
    "reason": "Additive U06 result DDL and exact authority/stale/body-purge guards. It seeds no row; its fixed-table dynamic ALTER only replaces the identified prior held constraint."
  },
  {
    "path": "prisma/migrations/20261016130000_chat_unified_router_refiner_result/migration.sql",
    "table": "PromptRefinerProductAttempt",
    "tableMentions": 8,
    "writeVerbs": 36,
    "reason": "Additive U06 result DDL and exact authority/stale/body-purge guards. It seeds no row; its fixed-table dynamic ALTER only replaces the identified prior held constraint."
  },
  {
    "path": "prisma/migrations/20261016130000_chat_unified_router_refiner_result/migration.sql",
    "table": "ChatUnifiedRouterRefinerResult",
    "tableMentions": 16,
    "writeVerbs": 36,
    "reason": "Additive U06 result DDL and exact authority/stale/body-purge guards. It seeds no row; its fixed-table dynamic ALTER only replaces the identified prior held constraint."
  },
  {
    "path": "prisma/migrations/20261016130000_chat_unified_router_refiner_result/migration.sql",
    "table": "PromptRefinerChatSuggestion",
    "tableMentions": 3,
    "writeVerbs": 36,
    "reason": "Additive U06 result DDL and exact authority/stale/body-purge guards. It seeds no row; its fixed-table dynamic ALTER only replaces the identified prior held constraint."
  },
  {
    "path": "prisma/migrations/20261016130000_chat_unified_router_refiner_result/migration.sql",
    "table": "PromptRefinerAutoBudgetHold",
    "tableMentions": 3,
    "writeVerbs": 36,
    "reason": "Additive U06 result DDL and exact authority/stale/body-purge guards. It seeds no row; its fixed-table dynamic ALTER only replaces the identified prior held constraint."
  },
  {
    "path": "prisma/migrations/20261016170000_chat_unified_router_refiner_consume/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 3,
    "writeVerbs": 19,
    "reason": "Additive U11 consume DDL binds one result CAS to canonical audit and preserves ready authority only for the exact authored Message. It seeds no row and writes no audit, scope or attempt row."
  },
  {
    "path": "prisma/migrations/20261016170000_chat_unified_router_refiner_consume/migration.sql",
    "table": "PromptRefinerChatScope",
    "tableMentions": 1,
    "writeVerbs": 19,
    "reason": "Additive U11 consume DDL binds one result CAS to canonical audit and preserves ready authority only for the exact authored Message. It seeds no row and writes no audit, scope or attempt row."
  },
  {
    "path": "prisma/migrations/20261016170000_chat_unified_router_refiner_consume/migration.sql",
    "table": "PromptRefinerProductAttempt",
    "tableMentions": 2,
    "writeVerbs": 19,
    "reason": "Additive U11 consume DDL binds one result CAS to canonical audit and preserves ready authority only for the exact authored Message. It seeds no row and writes no audit, scope or attempt row."
  },
  {
    "path": "prisma/migrations/20261016170000_chat_unified_router_refiner_consume/migration.sql",
    "table": "ChatUnifiedRouterRefinerResult",
    "tableMentions": 9,
    "writeVerbs": 19,
    "reason": "Additive U11 consume DDL binds one result CAS to canonical audit and preserves ready authority only for the exact authored Message. It seeds no row and writes no audit, scope or attempt row."
  },
  {
    "path": "prisma/migrations/20261016207000_chat_unified_optimizer_prepared_rollback/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 5,
    "writeVerbs": 33,
    "reason": "U28 additive DDL creates immutable pointer snapshots, rollback receipts and cycle latches, replaces pointer guards, and seeds only a snapshot of any existing pointer. Protected audit/cycle/candidate/promotion rows are read only; active-pointer mentions are trigger definitions and reads, with no migration row update."
  },
  {
    "path": "prisma/migrations/20261016207000_chat_unified_optimizer_prepared_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 33,
    "reason": "U28 additive DDL creates immutable pointer snapshots, rollback receipts and cycle latches, replaces pointer guards, and seeds only a snapshot of any existing pointer. Protected audit/cycle/candidate/promotion rows are read only; active-pointer mentions are trigger definitions and reads, with no migration row update."
  },
  {
    "path": "prisma/migrations/20261016207000_chat_unified_optimizer_prepared_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 3,
    "writeVerbs": 33,
    "reason": "U28 additive DDL creates immutable pointer snapshots, rollback receipts and cycle latches, replaces pointer guards, and seeds only a snapshot of any existing pointer. Protected audit/cycle/candidate/promotion rows are read only; active-pointer mentions are trigger definitions and reads, with no migration row update."
  },
  {
    "path": "prisma/migrations/20261016207000_chat_unified_optimizer_prepared_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 8,
    "writeVerbs": 33,
    "reason": "U28 additive DDL creates immutable pointer snapshots, rollback receipts and cycle latches, replaces pointer guards, and seeds only a snapshot of any existing pointer. Protected audit/cycle/candidate/promotion rows are read only; active-pointer mentions are trigger definitions and reads, with no migration row update."
  },
  {
    "path": "prisma/migrations/20261016207000_chat_unified_optimizer_prepared_rollback/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 9,
    "writeVerbs": 33,
    "reason": "U28 additive DDL creates immutable pointer snapshots, rollback receipts and cycle latches, replaces pointer guards, and seeds only a snapshot of any existing pointer. Protected audit/cycle/candidate/promotion rows are read only; active-pointer mentions are trigger definitions and reads, with no migration row update."
  },
  {
    "path": "prisma/migrations/20261016208000_chat_unified_optimizer_candidate_payload/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 2,
    "writeVerbs": 6,
    "reason": "U28 additive payload DDL binds each body to an immutable candidate with a restrictive foreign key and one candidate digest SELECT in the insert guard. It writes no candidate row."
  },
  {
    "path": "prisma/migrations/20261016209000_chat_unified_optimizer_promotion_payload_guard/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 1,
    "writeVerbs": 1,
    "reason": "U28 promotion-payload trigger checks candidate identity and exact stored body before a prepared promotion receipt can be inserted. The migration replaces no protected row and grants no runtime authority."
  },
  {
    "path": "prisma/migrations/20261016209000_chat_unified_optimizer_promotion_payload_guard/migration.sql",
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "tableMentions": 1,
    "writeVerbs": 1,
    "reason": "U28 promotion-payload trigger checks candidate identity and exact stored body before a prepared promotion receipt can be inserted. The migration replaces no protected row and grants no runtime authority."
  },
  {
    "path": "prisma/migrations/20261016210000_chat_unified_optimizer_candidate_retention_guard/migration.sql",
    "table": "AdminAuditLog",
    "tableMentions": 4,
    "writeVerbs": 21,
    "reason": "U28 retention DDL reads canonical audit, terminal cycle, candidate and current pointer in the payload deletion guard, then inserts only a retention receipt. It updates no protected row; current and prior pointer references veto deletion."
  },
  {
    "path": "prisma/migrations/20261016210000_chat_unified_optimizer_candidate_retention_guard/migration.sql",
    "table": "ChatUnifiedOptimizerCycle",
    "tableMentions": 1,
    "writeVerbs": 21,
    "reason": "U28 retention DDL reads canonical audit, terminal cycle, candidate and current pointer in the payload deletion guard, then inserts only a retention receipt. It updates no protected row; current and prior pointer references veto deletion."
  },
  {
    "path": "prisma/migrations/20261016210000_chat_unified_optimizer_candidate_retention_guard/migration.sql",
    "table": "ChatUnifiedOptimizerCandidate",
    "tableMentions": 6,
    "writeVerbs": 21,
    "reason": "U28 retention DDL reads canonical audit, terminal cycle, candidate and current pointer in the payload deletion guard, then inserts only a retention receipt. It updates no protected row; current and prior pointer references veto deletion."
  },
  {
    "path": "prisma/migrations/20261016210000_chat_unified_optimizer_candidate_retention_guard/migration.sql",
    "table": "ChatUnifiedOptimizerActivePointer",
    "tableMentions": 2,
    "writeVerbs": 21,
    "reason": "U28 retention DDL reads canonical audit, terminal cycle, candidate and current pointer in the payload deletion guard, then inserts only a retention receipt. It updates no protected row; current and prior pointer references veto deletion."
  }
];

export const CHAT_UNIFIED_RUNTIME_SQL_ALLOWLIST = [
  {
    "path": "prisma/migrations/20261016130000_chat_unified_router_refiner_result/migration.sql",
    "count": 1,
    "reason": "One fixed-table ALTER drops exactly the single prior PromptRefinerProductAttempt check whose conkey is state plus suggestionId. The catalog-derived name is quoted with %I; no caller input, row DML or other table can enter the statement."
  }
];

export const CHAT_UNIFIED_PROTECTED_TABLES = [
  {
    "table": "ChatUnifiedRouterRefinerResult",
    "delegate": "chatUnifiedRouterRefinerResult",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §4 and docs/policy/chat-unified-router-refiner-v1.md §6"
  },
  {
    "table": "ChatUnifiedExecutionReceipt",
    "delegate": "chatUnifiedExecutionReceipt",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §6 and docs/policy/chat-unified-router-refiner-v1.md §10"
  },
  {
    "table": "ChatUnifiedRoutingReceipt",
    "delegate": "chatUnifiedRoutingReceipt",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §6 and docs/policy/chat-unified-router-refiner-v1.md §10"
  },
  {
    "table": "ChatUnifiedOptimizerCycle",
    "delegate": "chatUnifiedOptimizerCycle",
    "writers": [
      "lib/chatUnifiedOptimizerLedgerStore.ts"
    ],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12"
  },
  {
    "table": "ChatUnifiedOptimizerCandidate",
    "delegate": "chatUnifiedOptimizerCandidate",
    "writers": [
      "lib/chatUnifiedOptimizerLedgerStore.ts"
    ],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12"
  },
  {
    "table": "ChatUnifiedOptimizerRun",
    "delegate": "chatUnifiedOptimizerRun",
    "writers": [
      "lib/chatUnifiedOptimizerLedgerStore.ts"
    ],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12"
  },
  {
    "table": "ChatUnifiedOptimizerRoleJob",
    "delegate": "chatUnifiedOptimizerRoleJob",
    "writers": [
      "lib/chatUnifiedOptimizerLedgerStore.ts"
    ],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12"
  },
  {
    "table": "ChatUnifiedOptimizerEvidence",
    "delegate": "chatUnifiedOptimizerEvidence",
    "writers": [
      "lib/chatUnifiedOptimizerLedgerStore.ts"
    ],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12"
  },
  {
    "table": "ChatUnifiedOptimizerQueuedCloseIntent",
    "delegate": "chatUnifiedOptimizerQueuedCloseIntent",
    "writers": [
      "lib/chatUnifiedOptimizerLedgerStore.ts"
    ],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §7 and docs/policy/chat-unified-router-refiner-v1.md §12"
  },
  {
    "table": "ChatUnifiedOptimizerCostPlan",
    "delegate": "chatUnifiedOptimizerCostPlan",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §8"
  },
  {
    "table": "ChatUnifiedOptimizerCostRun",
    "delegate": "chatUnifiedOptimizerCostRun",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §8"
  },
  {
    "table": "ChatUnifiedOptimizerQuotaContract",
    "delegate": "chatUnifiedOptimizerQuotaContract",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §8"
  },
  {
    "table": "ChatUnifiedOptimizerCostCall",
    "delegate": "chatUnifiedOptimizerCostCall",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §8"
  },
  {
    "table": "ChatUnifiedOptimizerCostWindow",
    "delegate": "chatUnifiedOptimizerCostWindow",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §8"
  },
  {
    "table": "ChatUnifiedOptimizerDispatchHold",
    "delegate": "chatUnifiedOptimizerDispatchHold",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §8"
  },
  {
    "table": "ChatUnifiedOptimizerComparisonVerdict",
    "delegate": "chatUnifiedOptimizerComparisonVerdict",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §10.2 and §12"
  },
  {
    "table": "ChatUnifiedOptimizerEngineeringDraft",
    "delegate": "chatUnifiedOptimizerEngineeringDraft",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §10.1 and §12"
  },
  {
    "table": "ChatUnifiedOptimizerProtectedHandoff",
    "delegate": "chatUnifiedOptimizerProtectedHandoff",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §7–9"
  },
  {
    "table": "ChatUnifiedOptimizerActivePointer",
    "delegate": "chatUnifiedOptimizerActivePointer",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §11"
  },
  {
    "table": "ChatUnifiedOptimizerPromotionReceipt",
    "delegate": "chatUnifiedOptimizerPromotionReceipt",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §11"
  },
  {
    "table": "ChatUnifiedOptimizerCanaryRollout",
    "delegate": "chatUnifiedOptimizerCanaryRollout",
    "writers": [],
    "contract": "docs/policy/chat-unified-router-refiner-v1.md §11"
  }
];

export const CHAT_UNIFIED_APPEND_ONLY_TABLES = [
  "ChatUnifiedOptimizerPromotionReceipt",
  "ChatUnifiedOptimizerComparisonVerdict",
  "ChatUnifiedOptimizerEngineeringDraft",
  "ChatUnifiedOptimizerQueuedCloseIntent",
  "ChatUnifiedOptimizerProtectedHandoff"
];
