# CHAT-01 B03G one-shot gate operations

The gate is default off. It receives only signed, content-free counts, reason
codes, cost, latency and slot bindings. Restricted manifest, case IDs, rubrics,
answers and model output stay in the owner environment. The existing B01 final
runner bytes are unchanged by B03G.

| Environment | Setting | Purpose |
| --- | --- | --- |
| Restricted owner process | `PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX` | Verify the existing owner seal. Never set in the app. |
| Restricted owner process | `PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PRIVATE_KEY_B64` | Ed25519 PKCS#8 DER private key for the content-free gate envelope. Never set in the app. |
| App | `PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_B64` | Corresponding Ed25519 SPKI DER public key. |
| App | `PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST` | Lowercase SHA-256 of the exact SPKI DER bytes. Both app key settings must agree before a write. |
| App | `PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED` | Set to `1` only for the separately approved evidence write; otherwise off. |
| App | `PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED` | Set to `1` only for the separate mposition decision; otherwise off. |

The public key and its digest are preserved in the hash-chained gate audit row,
so later readback survives key rotation. A missing or mismatched app signer pin
returns `GATE_SIGNER_PIN_UNAVAILABLE`; it does not reject the owner's evidence as
bad. Source closure verification runs in PR Fast Gate and the restricted owner
entrypoint. The owner entrypoint accepts only six local files: manifest,
binding, seal, result bundle, audit findings and a content-free target. Its
stdout is the content-free signed envelope. Do not send those local files to
the app, Codex or a code reviewer.

The B01 runner currently records the parsed output and cost upper bound but
does not emit the complete per-case usage and intent-to-terminal latency that
this gate requires. B03G synthetic pass is therefore not an operational
80-case pass. Before B08 can produce one, an owner-approved exact runner and
adapter telemetry change is needed. Stop dispatch first; do not reuse the B01
digest, source pin, stage/run approval or a consumed slot after a byte change.
If a stage was not run, recovery needs the separately approved one-shot
replacement path and fresh readback. If any slot was consumed or its outcome
is unknown, preserve its audit and reservation, verify the stop outcome, and
seek a new corpus/run authority rather than replaying that slot. The separate
exact deployment and stage/run approvals remain required.
