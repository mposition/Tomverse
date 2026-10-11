# Standalone AMUX server workspace

This is an independent Cargo workspace for the Ubuntu AMUX server. It is not a
member of the Tomverse root workspace. `crates/amux-core` here is the server's
own sibling crate, separate from the product integration at
`/crates/amux-core`. The four original Cargo members (`amux-core`,
`amux-server`, `amux-dashboard`, and `amux-cli`) and their lockfile stay
together. The copied cloud Dockerfile is a build-input reference; this import
does not deploy a cloud image.

The WSL `tomverse/cursor-provider` source at
`8ad716bf983274a9f86733be17b5f608bdcca67b` contributed Cursor commits
`0cb02264`, `c7947c20`, and `8ad716bf`. These were ported onto the Ubuntu
server's existing `9e4be636f6656c4c49391ac1fc089d2bbd6eb34f` source so
later server fixes and Devin support remain present. The imported tree is the
tested port at `1765cbf98f0201501388dfb2cdcb266db1d76fb8`, including a
small fix for the pre-existing missing Devin usage row. The original remote
is `https://github.com/mixpeek/amux.git`; its Git history was not merged into
Tomverse. `LICENSE` retains the upstream MIT + Commons Clause terms. The clause
restricts selling a product or service whose value derives entirely or
substantially from AMUX. This source import does not grant separate
commercial rights. The Tomverse operator confirmed on 2026-10-02 that
this server is solely an internal development and operations tool: its
functionality is not offered to customers or sold as a service. A change
to that use requires a license review and any needed permission before
customer exposure or paid provision.

Subsequent Tomverse commits harden the imported dashboard and local iOS test
transport; the vendored tree is therefore no longer byte-identical to that
port commit.

`GET /api/usage` and task routing share the same cached account readings,
including Cursor and GitHub Copilot. Cursor reads the server user's saved CLI
OAuth token and `GetCurrentPeriodUsage`; included plan pools, not on-demand
spending, supply the quota windows. A different `CURSOR_API_KEY` account or an
expired token is reported as unavailable. Copilot starts a fresh headless
runtime, performs only `connect` (or legacy `ping`) and `account.getQuota`, then
terminates it. It respects `AMUX_COPILOT_CMD` and the CLI token environment,
falling back to the server user's saved CLI login. No session or model request
is created, and no token or account identity is returned by the usage API.

Copilot defaults to the `premium_interactions` entitlement snapshot;
`AMUX_COPILOT_QUOTA_KEY` selects another reported quota key. Its percentage and
request counts are not a conversion to AI Credits or currency. Any exhausted
included window feeds the existing provider-exhaustion routing exclusion;
unknown or stale readings retain the existing routing behavior. Both probes
use the shared `AMUX_USAGE_TTL_S` cache (60 seconds by default), with bounded
responses and a 12-second request deadline. Cursor's CLI RPC can change, and
unsupported responses are unavailable rather than guessed. These readings
describe the server account, not separate credentials overridden in a group
or worker scope. Live account compatibility must be checked before rollout.

Build and focused test from this directory:

```bash
cargo check -p amux-server --locked
cargo test -p amux-server --lib cursor --locked
cargo test -p amux-server --test dockerfile_build_inputs --locked
```

The running Ubuntu service is not changed by this source import. Compare its
current build and preserve its later fixes before deploying a binary from this
workspace. Product verified-provider admission and bridge/claim switches are
separate decisions.
