//! Minimal adapters for gemini, codex, ollama, and cursor (RR-0043, plus the
//! cursor-agent addition below).
//!
//! "Minimal" is a statement about USAGE, not a placeholder: none of the three
//! exposes a usage/quota API amux can read on this host today
//! (docs/provider-coverage.csv: rate limits are terminal-scrape-only for all
//! of them), so `usage()` returns [`ProviderUsage::unknown`] — zero windows,
//! headline [`UsageConfidence::Unknown`]. Inventing a number here is exactly
//! what Invariant 20 forbids, and routing (RR-0044) treats Unknown as
//! "never exhausted" rather than guessing.
//!
//! Capability claims below cite the OpenCode spike
//! (docs/opencode-spike-results.md, RR-0028e) — they are measured, not
//! aspirational.

use amux_core::provider::{ProviderCapabilities, ProviderId, ProviderUsage};
use async_trait::async_trait;

use super::{PromptMode, ProviderAdapter};

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------

/// Gemini CLI (spike: v0.53.1). `--output-format stream-json` mirrors Claude
/// Code's structured shape; a hooks system exists (`gemini hooks`).
pub struct GeminiAdapter;

#[async_trait]
impl ProviderAdapter for GeminiAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::new("gemini")
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            hot_model_switch: false,
            // No readable usage surface (terminal scrape only, per spike).
            reports_usage: false,
            // stream-json per the spike coverage matrix.
            structured_events: true,
            // `gemini hooks` (docs/provider-coverage.csv).
            hooks: true,
        }
    }

    async fn usage(&self) -> ProviderUsage {
        // No usage API to read; unknown is the only honest answer.
        ProviderUsage::unknown(self.id())
    }

    async fn models(&self) -> Vec<String> {
        crate::provider::model_catalog::worker_model_ids("gemini")
    }

    fn build_command(&self, prompt_mode: PromptMode) -> Vec<String> {
        match prompt_mode {
            PromptMode::Interactive => vec!["gemini".into()],
            // Non-interactive when stdin is a pipe; structured events via
            // stream-json (spike: mirrors Claude Code's shape). The prompt
            // arrives over stdin — the protocol's job, not argv's.
            PromptMode::HeadlessStructured => vec![
                "gemini".into(),
                "--output-format".into(),
                "stream-json".into(),
            ],
        }
    }
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

/// Codex CLI (spike: v0.141.0). `codex exec --json` emits typed JSONL
/// lifecycle events.
pub struct CodexAdapter;

#[async_trait]
impl ProviderAdapter for CodexAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::new("codex")
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            hot_model_switch: false,
            // Usage-limit messages are terminal text only (spike).
            reports_usage: false,
            // JSONL via `codex exec --json` (spike coverage matrix).
            structured_events: true,
            // Hooks exist (spike: `--dangerously-bypass-hook-trust` for
            // automation).
            hooks: true,
        }
    }

    async fn usage(&self) -> ProviderUsage {
        ProviderUsage::unknown(self.id())
    }

    async fn models(&self) -> Vec<String> {
        // Codex itself has no subscription model-listing command. The dated
        // official fallback is therefore the enumerable surface, while the
        // configured model remains an unrestricted open string.
        crate::provider::model_catalog::worker_model_ids("codex")
    }

    fn build_command(&self, prompt_mode: PromptMode) -> Vec<String> {
        match prompt_mode {
            PromptMode::Interactive => vec!["codex".into()],
            // Typed JSONL events on stdout (spike).
            PromptMode::HeadlessStructured => {
                vec!["codex".into(), "exec".into(), "--json".into()]
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Devin CLI
// ---------------------------------------------------------------------------

/// Devin CLI launched through the local `devin-amux worker` wrapper.
pub struct DevinAdapter;

#[async_trait]
impl ProviderAdapter for DevinAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::new("devin")
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            hot_model_switch: false,
            reports_usage: false,
            structured_events: false,
            hooks: false,
        }
    }

    async fn usage(&self) -> ProviderUsage {
        ProviderUsage::unknown(self.id())
    }

    async fn models(&self) -> Vec<String> {
        Vec::new()
    }

    fn build_command(&self, _prompt_mode: PromptMode) -> Vec<String> {
        vec!["devin-amux".into(), "worker".into()]
    }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

/// Ollama (spike: v0.20.5) — a local model SERVER, not an agent CLI: no
/// hooks, no structured lifecycle events from the `ollama` binary, no usage
/// accounting (locally unlimited != a number; still Unknown, zero windows).
pub struct OllamaAdapter {
    /// `ollama run <model>` requires a model in argv. This default is
    /// CONFIGURATION, not knowledge — callers should override it from
    /// `WorkerConfig.model`; the default only keeps a bare adapter runnable.
    pub default_model: String,
}

/// Compiled-in fallback when nothing is configured. It is a HINT, not a claim
/// that this model exists — see [`ollama_default_model`].
const OLLAMA_FALLBACK_MODEL: &str = "qwen3.8:27b";

/// The ollama model to launch when the caller names none.
///
/// # Why this is a knob and not a literal
///
/// This was hardcoded to `qwen3.8:27b` in TWO places (here and
/// `session_verbs::default_model_for_provider`), and the second one's comment
/// said the quiet part out loud: "a launchable default is required (this box
/// has qwen3.8:27b pulled)". A fact about ONE machine, compiled into a public
/// OSS server — so every other install's ollama default names a 17 GB model
/// they have never pulled, and the two copies could drift from each other
/// besides.
///
/// It surfaced from the other end (DESKT-6): deleting that model on the box
/// that does have it would have broken the default for every future ollama
/// worker, which turned a `ollama rm` into a code change.
///
/// This is the shape `ethos.md` D3 already settled for the helper tier —
/// "One knob: `AMUX_HELPER_MODEL`; all sites read it… the helper tier moves
/// with one line of config". Same answer here, same reason: a pinned model is
/// a bet that cannot improve, and the fix is to make it configuration rather
/// than to pick a different literal.
pub fn ollama_default_model() -> String {
    std::env::var("AMUX_OLLAMA_DEFAULT_MODEL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| OLLAMA_FALLBACK_MODEL.to_string())
}

impl Default for OllamaAdapter {
    fn default() -> Self {
        Self {
            default_model: ollama_default_model(),
        }
    }
}

impl OllamaAdapter {
    pub fn with_model(model: impl Into<String>) -> Self {
        Self {
            default_model: model.into(),
        }
    }
}

#[async_trait]
impl ProviderAdapter for OllamaAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::new("ollama")
    }

    fn capabilities(&self) -> ProviderCapabilities {
        // ollama workers now run codex --oss --local-provider ollama, which
        // emits structured JSONL events identical to the codex provider.
        ProviderCapabilities {
            structured_events: true,
            hooks: true,
            reports_usage: false,
            hot_model_switch: false,
        }
    }

    async fn usage(&self) -> ProviderUsage {
        // "Effectively unlimited" is not a number amux may invent; the
        // absence of windows says exactly what is known: nothing.
        ProviderUsage::unknown(self.id())
    }

    async fn models(&self) -> Vec<String> {
        // The one place a live listing exists: the local `ollama list`
        // subprocess. Binary missing / daemon down / timeout -> empty vec,
        // the honest answer on a host without ollama.
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::process::Command::new("ollama").arg("list").output(),
        )
        .await;
        match out {
            Ok(Ok(o)) if o.status.success() => {
                parse_ollama_list(&String::from_utf8_lossy(&o.stdout))
            }
            _ => Vec::new(),
        }
    }

    fn build_command(&self, prompt_mode: PromptMode) -> Vec<String> {
        // ollama workers run codex with --oss --local-provider ollama so they
        // get a full coding agent (file editing, hooks, structured events) backed
        // by the local Ollama daemon instead of the OpenAI API.
        //
        // -a never: amux workers are autonomous; don't prompt for every shell
        //   command approval.
        // --sandbox workspace-write: codex defaults to read-only sandbox, so
        //   file writes are OS-blocked without this flag. Explicit here so both
        //   the herdr/bootstrap path (which calls this directly) and the tmux
        //   path (session_verbs.rs, which guards on !opts.contains) agree.
        match prompt_mode {
            PromptMode::Interactive => vec![
                "codex".into(),
                "--oss".into(),
                "--local-provider".into(),
                "ollama".into(),
                "--model".into(),
                self.default_model.clone(),
                "-a".into(),
                "never".into(),
                "--sandbox".into(),
                "workspace-write".into(),
                // Local models don't support extended thinking (xhigh). The
                // global ~/.codex/config.toml may set model_reasoning_effort=xhigh
                // for OpenAI models; override it here so ollama workers are
                // responsive (xhigh hangs qwen, ~30min wasted: AH-81).
                //
                // `none`, NOT `low` (AMUX-4611). `low` is a guaranteed failure
                // for a model without the `thinking` capability: qwen3-coder
                // died on every turn with `does not support thinking`, 32
                // occurrences in one exec. Measured 2026-09-16 on codex-cli
                // 0.153.4, `none` works for both a thinking and a non-thinking
                // model; `low`, `minimal` and omitting the flag all fail the
                // non-thinking one (omitting inherits "medium" from the global
                // config, so it is not a neutral choice).
                //
                // THIS PATH CANNOT PROBE and the launch arm can, which is why
                // they differ. `build_command` is sync, so it has no way to ask
                // `ollama show` what the model can do; session_verbs.rs's arm
                // is async and keeps `low` for thinking-capable models because
                // that is the setting measured good for them. A caller that
                // cannot discriminate takes the value that never hard-fails.
                // `provider.launch_matches_adapter` compares the BINARY, not
                // the flags, so this difference is not drift it would flag.
                "-c".into(),
                "model_reasoning_effort=none".into(),
            ],
            PromptMode::HeadlessStructured => vec![
                "codex".into(),
                "--oss".into(),
                "--local-provider".into(),
                "ollama".into(),
                "--model".into(),
                self.default_model.clone(),
            ],
        }
    }
}

/// Parse `ollama list` output: a header line, then one model per line with
/// the name as the first whitespace-separated column, e.g.
/// `llama3:latest    365c0bd3c000    4.7 GB    2 weeks ago`.
fn parse_ollama_list(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .skip(1) // "NAME  ID  SIZE  MODIFIED"
        .filter_map(|line| line.split_whitespace().next())
        .map(|name| name.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Cursor Agent CLI
// ---------------------------------------------------------------------------

/// Cursor Agent CLI (verified live: `cursor-agent --version` reported
/// `2026.09.23-86fc751` on this box, already authenticated — no login/logout
/// was performed to check this).
///
/// Capability claims, each independently verified rather than assumed from
/// the other CLIs in this file:
///
/// - `structured_events: true` — `cursor-agent --help` documents
///   `--print`/`-p` plus `--output-format json|stream-json` and
///   `--stream-partial-output`, the same shape as Gemini's
///   `--output-format stream-json`.
/// - `hooks: true` — NOT inferred from the minified JS bundle alone. This
///   box has `~/.cursor/skills-cursor/create-hook/SKILL.md`, a first-party
///   skill documenting a real, working hooks system: project hooks at
///   `.cursor/hooks.json` + `.cursor/hooks/*`, user hooks at
///   `~/.cursor/hooks.json` + `~/.cursor/hooks/*`, command or prompt hooks
///   exchanging JSON over stdin/stdout, matchers, fail-open/fail-closed
///   choice. There is no separate `cursor-agent hooks` CLI subcommand (the
///   feature is config-file driven), which is why nothing here builds one.
/// - `reports_usage: false` — `cursor-agent models`/`about`/`status` expose
///   account and context-window info, not a machine-readable quota/limit
///   API amux can poll. Unverified whether a real usage-cap banner exists in
///   the TUI at all (this account never hit one during the spike) — see
///   `backend::adapter::scan_cursor`'s doc comment for the same gap on the
///   scraping side.
/// - `hot_model_switch: false` — unverified either way; conservative default
///   matching every other adapter in this file.
pub struct CursorAdapter;

#[async_trait]
impl ProviderAdapter for CursorAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::new("cursor")
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            hot_model_switch: false,
            reports_usage: false,
            structured_events: true,
            hooks: true,
        }
    }

    async fn usage(&self) -> ProviderUsage {
        // No machine-readable quota/limit API found; unknown is the honest
        // answer (Invariant 20), same as every other adapter here.
        ProviderUsage::unknown(self.id())
    }

    async fn models(&self) -> Vec<String> {
        // Unlike codex/gemini, cursor-agent DOES have a live listing command
        // for the signed-in account (`cursor-agent models`, verified live:
        // it printed 50+ real model ids including the account's current
        // default, "auto"). Probe it the same way OllamaAdapter probes
        // `ollama list` — binary missing / not signed in / timeout -> empty
        // vec, the honest answer, never a guessed static list.
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::process::Command::new("cursor-agent").arg("models").output(),
        )
        .await;
        match out {
            Ok(Ok(o)) if o.status.success() => {
                parse_cursor_models(&String::from_utf8_lossy(&o.stdout))
            }
            _ => Vec::new(),
        }
    }

    fn build_command(&self, prompt_mode: PromptMode) -> Vec<String> {
        match prompt_mode {
            // Bare launch: interactive TUI, verified live (workspace-trust
            // dialog, idle composer, "Working" spinner, tool-approval
            // panel). This adapter's argv intentionally omits `--trust` —
            // that seam belongs to the launch arm in session_verbs.rs, which
            // reads a per-launch env and CC_FLAGS the adapter cannot see;
            // duplicating it here would let the two drift (same reasoning as
            // Ollama's `--sandbox workspace-write` comment above).
            PromptMode::Interactive => vec!["cursor-agent".into()],
            // `--print` is required for `--output-format` to do anything
            // (verified via --help: "(only works with --print)").
            PromptMode::HeadlessStructured => vec![
                "cursor-agent".into(),
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
            ],
        }
    }
}

/// Parse `cursor-agent models` output: a header line ("Available models"), a
/// blank line, then one `<id> - <label>` per line, e.g.
/// `claude-opus-5-thinking-high - Claude Opus 5 1M Thinking`. Verified live
/// against the real command output on this box.
fn parse_cursor_models(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.eq_ignore_ascii_case("Available models") {
                return None;
            }
            line.split_once(" - ").map(|(id, _)| id.trim().to_string())
        })
        .filter(|id| !id.is_empty())
        .collect()
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI
// ---------------------------------------------------------------------------

/// GitHub Copilot CLI (`copilot`, npm `@github/copilot`). The flags were
/// checked against `copilot --help` of 1.0.91 installed on the server
/// (2026-10-05). No prompt was sent, so the argv is verified and only the
/// folder-trust screen is observed (see `backend::adapter::scan_copilot`);
/// each claim below says which kind it is.
///
/// - `structured_events: false` — Copilot does have JSONL (`--output-format
///   json`, "one JSON object per line"), but only in `-p, --prompt <text>`
///   mode, which takes the prompt as an argument. amux's headless protocol
///   delivers the prompt over stdin and appends nothing to the argv, so it
///   cannot drive that mode, and advertising it would be a capability the
///   protocol cannot use. HeadlessStructured therefore returns the same argv
///   as Interactive, as DevinAdapter does.
/// - `hooks: false` — not verified either way; the conservative default.
/// - `reports_usage: false` — no machine-readable quota API is documented;
///   `usage()` is honestly unknown, as for every other static adapter here.
/// - `hot_model_switch: false` — `/model` exists in the TUI, but nothing here
///   drives it; conservative default.
/// - `models()` returns the shared catalog's worker ids, which is empty until
///   someone verifies them: the CLI has no documented listing command, and a
///   guessed list would be worse than none (`--model` stays an open string).
pub struct CopilotAdapter;

#[async_trait]
impl ProviderAdapter for CopilotAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::new("copilot")
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            hot_model_switch: false,
            reports_usage: false,
            structured_events: false,
            hooks: false,
        }
    }

    async fn usage(&self) -> ProviderUsage {
        ProviderUsage::unknown(self.id())
    }

    async fn models(&self) -> Vec<String> {
        crate::provider::model_catalog::worker_model_ids("copilot")
    }

    fn build_command(&self, _prompt_mode: PromptMode) -> Vec<String> {
        // The interactive TUI in both modes (see `structured_events` above).
        // Model, `--yolo` and `--add-dir` belong to the launch arm in
        // session_verbs.rs, which reads the worker's CC_FLAGS that this adapter
        // cannot see (same split as CursorAdapter's `--trust`).
        vec!["copilot".into()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use amux_core::provider::UsageConfidence;

    #[tokio::test]
    async fn static_usage_is_unknown_with_zero_windows() {
        for adapter in [
            &GeminiAdapter as &dyn ProviderAdapter,
            &CodexAdapter,
            &DevinAdapter,
            &OllamaAdapter::default(),
            &CursorAdapter,
        ] {
            let usage = adapter.usage().await;
            assert_eq!(usage.provider, adapter.id());
            assert!(
                usage.windows.is_empty(),
                "{}: minimal adapter must report zero windows",
                adapter.id()
            );
            assert_eq!(usage.confidence(), UsageConfidence::Unknown);
        }
    }

    #[test]
    fn capability_claims_match_the_spike() {
        assert!(GeminiAdapter.capabilities().structured_events);
        assert!(!GeminiAdapter.capabilities().reports_usage);
        assert!(CodexAdapter.capabilities().structured_events);
        assert!(!CodexAdapter.capabilities().reports_usage);
        let devin = DevinAdapter.capabilities();
        assert!(!devin.structured_events);
        assert!(!devin.hooks);
        assert!(!devin.reports_usage);
        assert!(!devin.hot_model_switch);
        let ollama = OllamaAdapter::default().capabilities();
        // ollama now uses codex --oss --local-provider ollama, so it inherits
        // codex's structured-event and hook capabilities.
        assert!(ollama.structured_events);
        assert!(ollama.hooks);
        assert!(!ollama.reports_usage);
        assert!(!ollama.hot_model_switch);
        let cursor = CursorAdapter.capabilities();
        assert!(cursor.structured_events);
        assert!(cursor.hooks);
        assert!(!cursor.reports_usage);
        assert!(!cursor.hot_model_switch);
    }

    #[test]
    fn cursor_builds_bare_interactive_and_print_headless() {
        assert_eq!(
            CursorAdapter.build_command(PromptMode::Interactive),
            vec!["cursor-agent"]
        );
        assert_eq!(
            CursorAdapter.build_command(PromptMode::HeadlessStructured),
            vec!["cursor-agent", "--print", "--output-format", "stream-json"]
        );
    }

    #[test]
    fn parses_cursor_models_output() {
        let fixture = "Available models\n\
                       \n\
                       auto - Auto (current, default)\n\
                       gpt-5.3-codex-low - Codex 5.3 Low\n\
                       claude-opus-5-thinking-high - Claude Opus 5 1M Thinking\n";
        assert_eq!(
            parse_cursor_models(fixture),
            vec!["auto", "gpt-5.3-codex-low", "claude-opus-5-thinking-high"]
        );
        assert!(parse_cursor_models("").is_empty());
        assert!(parse_cursor_models("Available models\n\n").is_empty());
    }

    #[test]
    fn ollama_builds_codex_oss_command() {
        let a = OllamaAdapter::with_model("qwen3.8:27b");
        // Interactive: includes -a never + --sandbox workspace-write so both the
        // herdr/bootstrap path (calls this directly) and the tmux path (which
        // guards on !opts.contains) launch with file-editing and no approval prompts.
        let interactive_expected = vec![
            "codex", "--oss", "--local-provider", "ollama", "--model", "qwen3.8:27b",
            "-a", "never", "--sandbox", "workspace-write",
            // `none`, not `low` (AMUX-4611): this path is sync and cannot ask
            // `ollama show` whether the model can think, and `low` is a
            // guaranteed per-turn failure for one that cannot.
            "-c", "model_reasoning_effort=none",
        ];
        // HeadlessStructured: no extra flags needed (headless driver handles approvals).
        let headless_expected = vec![
            "codex", "--oss", "--local-provider", "ollama", "--model", "qwen3.8:27b",
        ];
        assert_eq!(a.build_command(PromptMode::Interactive), interactive_expected);
        assert_eq!(a.build_command(PromptMode::HeadlessStructured), headless_expected);
    }

    #[test]
    fn codex_headless_is_exec_json() {
        assert_eq!(
            CodexAdapter.build_command(PromptMode::HeadlessStructured),
            vec!["codex", "exec", "--json"]
        );
    }

    #[test]
    fn copilot_commands_follow_the_cli_reference() {
        assert_eq!(CopilotAdapter.build_command(PromptMode::Interactive), vec!["copilot"]);
        // No headless argv: copilot's JSONL mode needs the prompt as an
        // argument, which amux's stdin-driven headless protocol cannot supply.
        assert_eq!(CopilotAdapter.build_command(PromptMode::HeadlessStructured), vec!["copilot"]);
        let caps = CopilotAdapter.capabilities();
        assert!(!caps.structured_events);
        assert!(!caps.hooks, "hooks are unverified for copilot; claiming them would be invented");
        assert!(!caps.reports_usage);
    }

    #[test]
    fn parses_ollama_list_output() {
        let fixture = "NAME               ID              SIZE      MODIFIED\n\
                       llama3:latest      365c0bd3c000    4.7 GB    2 weeks ago\n\
                       qwen3.8:27b           500a1f067a9f    5.2 GB    3 days ago\n";
        assert_eq!(
            parse_ollama_list(fixture),
            vec!["llama3:latest", "qwen3.8:27b"]
        );
        assert!(parse_ollama_list("").is_empty());
        assert!(parse_ollama_list("NAME  ID  SIZE  MODIFIED\n").is_empty());
    }
}
#[cfg(test)]
mod ollama_default_tests {
    use super::*;

    /// These tests mutate ONE process-wide env var, so run in parallel they
    /// clobber each other: measured 4 failures in 5 runs before this guard.
    /// A flaky test is worse than no test — it trains people to re-run rather
    /// than to read. `--test-threads=1` would hide it here and still flake in
    /// CI, so the serialization belongs in the test, not in how it is invoked.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Sets the var (or clears it), runs `f`, and always restores — including
    /// on panic, since a leaked value would silently corrupt whichever test
    /// grabs the lock next.
    fn with_knob<T>(value: Option<&str>, f: impl FnOnce() -> T) -> T {
        // Poisoning is irrelevant here: a panicking test still restored its
        // value via the guard below, so the env is clean either way.
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("AMUX_OLLAMA_DEFAULT_MODEL").ok();
        struct Restore(Option<String>);
        impl Drop for Restore {
            fn drop(&mut self) {
                // SAFETY: ENV_LOCK is held for the whole scope, so no other
                // test in this binary is reading or writing this var.
                match &self.0 {
                    Some(p) => unsafe { std::env::set_var("AMUX_OLLAMA_DEFAULT_MODEL", p) },
                    None => unsafe { std::env::remove_var("AMUX_OLLAMA_DEFAULT_MODEL") },
                }
            }
        }
        let _restore = Restore(prev);
        // SAFETY: as above — the lock makes this the only writer.
        match value {
            Some(v) => unsafe { std::env::set_var("AMUX_OLLAMA_DEFAULT_MODEL", v) },
            None => unsafe { std::env::remove_var("AMUX_OLLAMA_DEFAULT_MODEL") },
        }
        f()
    }

    /// The guard has to actually serialize, or every assertion below is
    /// satisfied by luck. Two threads hammering opposite values must never see
    /// the other's.
    #[test]
    fn the_env_guard_actually_serializes() {
        std::thread::scope(|sc| {
            for (val, expect) in [("model-a", "model-a"), ("model-b", "model-b")] {
                sc.spawn(move || {
                    for _ in 0..200 {
                        with_knob(Some(val), || assert_eq!(ollama_default_model(), expect));
                    }
                });
            }
        });
    }

    /// The two sites must not be able to disagree. They WERE two literals, and
    /// "a view must share the predicate of the mechanism it describes" is
    /// exactly what stops the next person changing one of them.
    #[test]
    fn the_adapter_and_the_launcher_resolve_the_same_model() {
        with_knob(Some("pinned:test"), || {
            assert_eq!(OllamaAdapter::default().default_model, ollama_default_model());
            assert_eq!(OllamaAdapter::default().default_model, "pinned:test");
        });
    }

    /// Unset must preserve TODAY's behaviour exactly — this change is meant to
    /// make the default movable, not to move it.
    #[test]
    fn unset_keeps_the_compiled_fallback() {
        with_knob(None, || assert_eq!(ollama_default_model(), OLLAMA_FALLBACK_MODEL));
    }

    /// The knob has to actually move it, or it is decoration. This is the
    /// assertion that makes `ollama rm qwen3.8:27b` a config change rather than
    /// a code change (DESKT-6).
    #[test]
    fn the_knob_moves_the_default() {
        with_knob(Some("qwen2.5vl:3b"), || {
            assert_eq!(ollama_default_model(), "qwen2.5vl:3b");
            assert_eq!(
                OllamaAdapter::default().default_model,
                "qwen2.5vl:3b",
                "the adapter must follow the knob too, not just the launcher"
            );
        });
    }

    /// An empty or whitespace-only value is a mis-set knob, not a request for
    /// an empty model name — which would build `--model ` and fail obscurely
    /// at launch instead of here.
    #[test]
    fn a_blank_knob_falls_back_rather_than_launching_an_empty_model() {
        for blank in ["", "   "] {
            with_knob(Some(blank), || {
                assert_eq!(ollama_default_model(), OLLAMA_FALLBACK_MODEL, "blank {blank:?}");
            });
        }
    }
}
