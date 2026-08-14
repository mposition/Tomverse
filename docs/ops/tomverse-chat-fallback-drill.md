# Tomverse Chat fallback drill

- Status: **prepared, not run.** No drill has been performed.
- Owner: Backend/AI
- Gate: steps 4 and 5 of `docs/ops/tomverse-chat-auto-router-rollout.md` §9.1,
  which `AUTO_ROUTER_FALLBACK_ENABLED` waits on
- Companion to `docs/policy/tomverse-chat-routing.md` §6–§8

Automatic fallback is written and switched off. Before it is switched on,
staging has to make a provider fail on purpose and show what the database and
the logs did about it. The alternative is learning it from the first real
outage, which arrives without a prepared observer — and the one thing that must
not be discovered then is that the accounting was wrong.

## 1. What the drill proves

Five counts, from §9.1: **one run, one reservation, two attempts, one
settlement, one lease release.** Each has a way of being wrong that is quiet:

| Count | If it is wrong | How it would look otherwise |
| --- | --- | --- |
| 1 `RoutingRun` | the retry opened a second logical response | reroute rate reads zero forever |
| 1 `ChatCreditReservation` | the fallback reserved again | the user is held twice for one answer |
| 2 `RoutingAttempt` | the second attempt was not recorded | a dispatch with no manifest, which ROUTE-06 rests on |
| 1 settlement | the user was charged per attempt | a bill nobody can defend |
| 1 lease release | a slot was never given back | only shows up under load, far from here |

Plus three the drill can see for free: an independent finalized manifest per
attempt (§5), the §8 recovery candidate written only on success, and each
attempt's cost landing on its own provider's budget (§7).

## 2. Arming the injector

`lib/routingFaultInjection.ts`. Three locks, all required:

1. **Not production.** `resolveDeploymentEnvironment` fails closed — an
   unlabelled deployment reads as production and injects nothing. Staging has
   to *say* it is staging.
2. **A configured secret.** `ROUTING_FAULT_INJECTION_SECRET`, at least 16
   characters. Unset means the injector does not exist, so a staging box nobody
   prepared cannot be driven into a drill by a passer-by.
3. **The request asks.** `X-Tomverse-Fault-Injection: <secret>:<fault>`, per
   request. Never a percentage of traffic: a QA session that had nothing to do
   with the drill must not start failing, and "why did staging break" is not a
   question to answer twice.

Every armed request logs `chat_fault_injection_armed` before anything fails, so
a drill is never mistaken for an outage in the record it is about to produce.

Remove `ROUTING_FAULT_INJECTION_SECRET` when the drill is over. A switch that
breaks provider calls is not something to leave configured because it happens
to be off by default.

## 3. Preparing staging

- `APP_ENV=staging` (or Railway's own environment name).
- `ROUTING_FAULT_INJECTION_SECRET=<generated, ≥16 chars>`.
- `AUTO_ROUTER_FALLBACK_ENABLED=on` — the drill is the thing that decides
  whether this may go to production, so it has to be on here.
- Auto has to actually route the turn, so the cohort must include the drill
  account: `AUTO_ROUTER_ROLLOUT_PERCENT`, `AUTO_ROUTER_ELIGIBLE_PLANS`,
  `AUTO_ROUTER_COHORT_SALT`.
- `AUTO_ROUTER_DRILL_SUBJECTS=<the drill account's user id>` — the readiness
  override, and see §2.1 for why it exists at all. Empty means nobody.

An earlier version of this document said to attest the three readiness gates
"in staging only". That was not a thing that could be done, and following it
would have been the rollout boundary failing at exactly the moment it is being
tested. `lib/autoRolloutReadiness.ts` is static code with no environment
dimension: a gate moved to `passed` to make staging route is the same `passed`
in production. §2.1 is what replaced it.

### 2.1 The readiness override, and why it is shaped this way

A fallback only happens on a routed turn, and a turn is only routed when
readiness says ready. So the drill needed one of two things: a false entry in
the readiness register, or a narrow request-scoped hole.

The register is the audit record of a human judgement. A false entry in it is
indistinguishable from a real one forever after, and it would still be there
long after the drill was forgotten. So the hole it is —
`lib/autoDrillOverride.ts`, with four locks:

| Lock | Effect |
| --- | --- |
| Not production | `resolveDeploymentEnvironment` fails closed, so an unlabelled deployment refuses. No combination of the other three opens it |
| The fault-injection credential | the same secret and header the drill already carries, so deleting it closes the override too |
| `AUTO_ROUTER_DRILL_SUBJECTS` | an explicit allowlist. A valid credential alone routes nobody |
| Not a guest | Auto excludes guests structurally, and a drill is not a reason to invent an exception the product does not have |

It bypasses **readiness and nothing else**. The kill switch still outranks it,
the plan allowlist and the cohort percentage still apply, and the guest
exclusion still holds — an operator running a drill still has to put the
account on an eligible plan and set a percentage. Every use logs
`chat_auto_readiness_overridden` and is marked `staging_drill_override` on the
cohort decision, so a turn that routed only because a drill said so is never
mistaken for one that qualified.
- `MANIFEST_HASH_KEYS` / `MANIFEST_HASH_ACTIVE_KEY_ID` — recording a dispatch
  refuses without them, so the drill would fail for the wrong reason.
- A **dedicated account** with an Auto conversation and no other traffic. The
  lease check asks whether any lease survives for that subject, and a released
  lease is deleted rather than marked, so a second concurrent request from the
  same account makes the check meaningless.

## 4. Running it

Send an ordinary chat turn — plain text, no attachments, no web search, no
tools; anything else is outside the first cut's scope and
`lib/autoFallbackGate.ts` will refuse the fallback by name.

```
curl -sS -D headers.txt https://<staging>/api/chat \
  -H 'Content-Type: application/json' \
  -H "X-Tomverse-Fault-Injection: $ROUTING_FAULT_INJECTION_SECRET:attempt_0_pre_token" \
  -H "Cookie: <the drill account's session>" \
  --data '{"conversationId":"<auto conversation>","messages":[{"role":"user","content":"Explain what a context window is."}]}'
```

Keep two things:

- the `X-Request-ID` header from `headers.txt` — that is the traceId;
- the server logs for that request, in a file.

The stream itself should show the answer arriving normally. The retry is
announced out of band and the client strips it, so a user sees one answer from
one model — which is the point of the signal.

## 5. Verifying it

```
DATABASE_URL=<staging> npm run drill:fallback-verify -- \
  --trace <traceId> --scenario fallback_succeeds \
  --subject <subjectKey> --log <logfile>
```

The judgement is `scripts/verify-fallback-drill-core.mjs`, unit-tested in
`tests/verifyFallbackDrill.test.mjs` — the half that decides whether a drill
passed is the half most worth being sure of, and a verifier exercised only by
real drills has its bugs found during one.

Four scenarios:

| Scenario | Produced by | Expects |
| --- | --- | --- |
| `fallback_succeeds` | fault `attempt_0_pre_token` | 2 attempts, second succeeded, §8 recovery recorded |
| `fallback_fails` | fault `attempt_1_pre_token` | 2 attempts, both failed, no third model, no recovery |
| `no_fallback_after_token` | fault `attempt_0_post_token` | 1 attempt, partial answer preserved, nothing substituted |
| `disconnect_during_fallback` | the drill client below | 2 attempts, second cancelled, no third, no recovery |

The first is step 4. The rest are step 5, and all four are run before the flag
goes anywhere near production.

## 6. Step 5: disconnecting mid-fallback

The other three cases are produced by injecting a provider fault. This one
cannot be: what is under test is the *client* going away while the fallback is
streaming, and no provider-side fault reproduces that.

```
npm run drill:fallback-disconnect -- \
  --url https://<staging>/api/chat \
  --secret "$ROUTING_FAULT_INJECTION_SECRET" \
  --cookie "<the drill account's session>" \
  --conversation <auto conversation>
```

The abort point is exact rather than a race. §7 sends
`retrying_with_another_model` before the next model's first token, and the
signal is a NUL-led chunk providers cannot emit — so on a fallback turn the
marker is the first thing on the wire, always. "Abort as soon as the marker
arrives" therefore lands squarely between the fallback being dispatched and its
first token. A timer would sometimes disconnect before the fallback existed and
sometimes after it finished, and a drill that tests a different thing each run
is not a drill.

What the run has to show, beyond the counts: the fallback's provider stream is
**cancelled**, not left open. That is the failure this case exists for, and it
is invisible in the database — check the logs for the absence of a stream that
kept writing after the client had gone, and the provider's own dashboard for a
request that ran to completion with nobody listening.

## 7. Enabling

Only after all four scenarios pass, and it is a decision rather than the last
step of a script:

1. All four drill rows are in §9's table, with traces.
2. `ROUTING_FAULT_INJECTION_SECRET` and `AUTO_ROUTER_DRILL_SUBJECTS` are
   **removed from staging**, and staging is redeployed. A switch that breaks
   provider calls does not stay configured because it is off by default, and
   the readiness override rides on the same credential.
3. **Negative check.** Replay one drill request with the old secret and header
   against the redeployed staging and confirm it neither injects a fault nor
   overrides readiness — `chat_fault_injection_armed` and
   `chat_auto_readiness_overridden` must both be absent. Removing a variable
   and assuming it took effect is how a switch survives its own removal.
4. `AUTO_ROUTER_FALLBACK_ENABLED=on` in production — and nowhere before the
   three readiness gates in `lib/autoRolloutReadiness.ts` are attested for
   production, because a fallback can only happen on a turn Auto routed.
5. Watch `chat_auto_fallback_dispatched` and `chat_auto_fallback_refused` for
   the first day. The refusal reasons are the useful half: a distribution that
   is all `no_candidate` means the Router is offering one model and the feature
   is off in practice.
6. FALLBACK-02's production audit — `automatic_fallbacks_after_visible_token`
   over real traffic — is owed once traffic exists. Until then the count is
   zero for want of traffic, which is not the same as zero for want of the
   invariant holding.

Rolling back is `AUTO_ROUTER_FALLBACK_ENABLED` unset. It takes effect on the
next request; nothing is stored that a disabled fallback would misread.

## 8. What the drill does not cover

- **Real provider outages.** The injected failure is a `read()` that throws
  after the call was made and the dispatch recorded, which is the path a real
  pre-token failure takes. It is not every shape of failure a provider can
  produce, and `lib/routingStreamFailure.ts` is where the shapes are decided.
- **Load.** One drill turn says nothing about what two hundred concurrent
  fallbacks do to the provider budget's row locks.
- **A fallback that also disconnects the primary.** Both streams cancelled in
  one turn is reachable and untested.

## 9. Record

| Scenario | Run by | Date | Trace | Result |
| --- | --- | --- | --- | --- |
| `fallback_succeeds` | | | | |
| `fallback_fails` | | | | |
| `no_fallback_after_token` | | | | |
| `disconnect_during_fallback` | | | | |

A drill that passed and was not written down here did not happen: the gate this
document serves is attested from this table.
