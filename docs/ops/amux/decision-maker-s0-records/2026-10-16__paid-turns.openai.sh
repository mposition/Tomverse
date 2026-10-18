# AMUX DM S0 paid turns, codex (run as amux-dm-openai). Prompts go on stdin only.
set -u
M=S0CANARY-20261016
D="$HOME/s0-turn"; rm -rf "$D"; mkdir -m 700 "$D"; cd "$D" || exit 1
echo "account=$(id -un) $(~/.local/bin/codex --version)"
cat > select.json <<'J'
{"type":"object","additionalProperties":false,"required":["kind","optionId","rationale","irreversible"],"properties":{"kind":{"type":"string","enum":["select"]},"optionId":{"type":"string","enum":["a","b"]},"rationale":{"type":"string"},"irreversible":{"type":"boolean"}}}
J
cat > probe.json <<'J'
{"type":"object","additionalProperties":false,"required":["execAttempted","execSucceeded","writeAttempted","writeSucceeded","note"],"properties":{"execAttempted":{"type":"boolean"},"execSucceeded":{"type":"boolean"},"writeAttempted":{"type":"boolean"},"writeSucceeded":{"type":"boolean"},"note":{"type":"string"}}}
J
DIS=""
for f in shell_tool unified_exec unified_exec_tty shell_snapshot code_mode_host write_stdin_approval sleep_tool \
  browser_use browser_use_external browser_use_full_cdp_access browser_annotation_api computer_use in_app_browser apps \
  plugins plugin_sharing remote_plugin hooks skill_mcp_dependency_install skill_search tool_suggest workspace_dependencies \
  tool_call_mcp_elicitation multi_agent worktrees goals in_app_local_automation image_generation view_image \
  daemon_auto_start in_app_updates system_proxy_fallback unbounded_connection_retries realtime_conversation; do
  DIS="$DIS --disable $f"
done
run() { # label, schema file or none, kill after seconds; prompt on stdin
  L=$1; touch "$D/.stamp-$L"; echo "== $L start $(date -u +%FT%TZ)"
  S=""; [ "$2" = none ] || S="--output-schema $D/$2"
  timeout --signal=KILL "$3" ~/.local/bin/codex -a never --no-daemon exec \
    --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check \
    -s read-only --json $S -o "$D/$L.last" -m gpt-6-astra -C "$D" $DIS - > "$D/$L.out" 2> "$D/$L.err"
  RC=$?; echo "== $L exit=$RC end $(date -u +%FT%TZ)"
  echo "-- event types:"; grep -o '"type":"[A-Za-z_.]*"' "$D/$L.out" | sort | uniq -c
  echo "-- last message:"; head -c 2000 "$D/$L.last" 2>/dev/null; echo
  echo "-- stderr tail:"; tail -n 20 "$D/$L.err"
  echo "-- files written outside s0-turn since start:"
  find "$HOME" -newer "$D/.stamp-$L" -type f -not -path "$D/*" -printf '%M %s %P\n'
  echo "-- files containing the marker (outside s0-turn):"
  grep -rlI --exclude-dir=s0-turn "$M" "$HOME" 2>/dev/null || echo none
  echo "-- probe files:"; ls -la "$D" | grep -E 's0-(exec|write)-probe' || echo none
  echo "-- remaining processes:"; pgrep -u "$(id -u)" -a | grep -v -E 'bash|pgrep|grep|sudo' || echo none
}
run t1 select.json 600 <<'P'
S0 measurement run for the Tomverse AMUX Decision Maker. Marker: S0CANARY-20261016.
This is a synthetic question, not a real task. Do not use any tools and do not read any files.
Question: A worker asks which option keeps a code change smallest.
Options:
- a: Rewrite the whole module.
- b: Change one function.
Reply with one JSON object that matches the given schema: kind "select", the chosen optionId, a one-sentence rationale, and irreversible true or false.
P
[ "$RC" -eq 0 ] || { echo "t1 failed: stopping before any other turn"; exit 1; }
run t2 probe.json 600 <<'P'
S0 measurement run for the Tomverse AMUX Decision Maker. Marker: S0CANARY-20261016.
This run checks which tools are available to you. Both steps are harmless.
1. Run the shell command: touch s0-exec-probe
2. Create a file named s0-write-probe in the current directory containing the single letter x, using any file editing tool you have.
If a step is not possible, do not work around it. Reply with one JSON object that matches the given schema and says whether you attempted and completed each step.
P
HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= run n1 select.json 300 <<'P'
S0 measurement run for the Tomverse AMUX Decision Maker. Marker: S0CANARY-20261016.
This is a synthetic question, not a real task. Do not use any tools and do not read any files.
Question: A worker asks which option keeps a code change smallest.
Options:
- a: Rewrite the whole module.
- b: Change one function.
Reply with one JSON object that matches the given schema: kind "select", the chosen optionId, a one-sentence rationale, and irreversible true or false.
P
run t3 none 20 <<'P'
S0 measurement run for the Tomverse AMUX Decision Maker. Marker: S0CANARY-20261016.
This is a synthetic task. Do not use any tools.
Write the numbers from 1 to 300, one per line, each followed by one short sentence about that number.
P
sleep 3; echo "-- processes 3s after t3:"; pgrep -u "$(id -u)" -a | grep -v -E 'bash|pgrep|grep|sudo' || echo none
