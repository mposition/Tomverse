#!/usr/bin/env bash
# Operator-approved installation only. Never enable/start timers or overwrite
# an existing environment file, binary or unit. No credentials are transferred.
set -euo pipefail
test "$(id -un)" = tommy
test "$HOME" = /home/tommy
test "$#" = 1
src=$(realpath -- "$1")
case "$src" in /home/tommy/amux-v4-install.*) ;; *) exit 2 ;; esac
test -d "$src"
test "$(stat -c %U "$src")" = tommy
test "$(stat -c %a "$src")" = 700
config="$HOME/.config/tomverse-amux-v4"
lib="$HOME/.local/lib/tomverse-amux-v4"
units="$HOME/.config/systemd/user"
for dir in "$config" "$lib" "$units"; do test ! -L "$dir"; done
for file in analysis-agent-once.mjs content-retention-once.mjs; do
  test -f "$src/$file" && test ! -L "$src/$file"
  test ! -e "$lib/$file" && test ! -L "$lib/$file"
done
for file in amux-v4-analysis-agent.service amux-v4-analysis-agent.timer \
  amux-v4-content-retention.service amux-v4-content-retention.timer; do
  test -f "$src/$file" && test ! -L "$src/$file"
  test ! -e "$units/$file" && test ! -L "$units/$file"
done
for name in analysis-agent content-retention; do
  test -f "$src/amux-v4-$name.env.example"
  test ! -L "$src/amux-v4-$name.env.example"
  test ! -L "$config/$name.env"
done
install -d -m 700 "$config" "$lib" "$units" \
  "$HOME/.local/state/tomverse-amux-v4-analysis" \
  "$HOME/.local/state/tomverse-amux-v4-content-retention"
install -m 600 "$src/analysis-agent-once.mjs" "$lib/analysis-agent-once.mjs"
install -m 600 "$src/content-retention-once.mjs" "$lib/content-retention-once.mjs"
for file in amux-v4-analysis-agent.service amux-v4-analysis-agent.timer \
  amux-v4-content-retention.service amux-v4-content-retention.timer; do
  install -m 600 "$src/$file" "$units/$file"
done
for name in analysis-agent content-retention; do
  test ! -L "$config/$name.env"
  if test ! -e "$config/$name.env"; then
    install -m 600 "$src/amux-v4-$name.env.example" "$config/$name.env"
  fi
done
systemd-analyze --user verify "$units/amux-v4-analysis-agent.service" \
  "$units/amux-v4-analysis-agent.timer" "$units/amux-v4-content-retention.service" \
  "$units/amux-v4-content-retention.timer"
systemctl --user daemon-reload
for name in amux-v4-analysis-agent.timer amux-v4-content-retention.timer; do
  test "$(systemctl --user is-enabled "$name" || true)" = disabled
  test "$(systemctl --user is-active "$name" || true)" = inactive
done
printf 'AMUX_V4_SERVICES_INSTALLED_DISABLED\n'
