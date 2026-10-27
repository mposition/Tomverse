/**
 * What each worker CLI says it offers, read on the AMUX host without a model
 * call (owner decision 2026-10-27). Each reader takes the CLI's own output and
 * returns `{ cliModel, displayName }` entries; scripts/amux-cli-models-refresh.mjs
 * runs the CLIs and sends the lists to /api/internal/amux/cli-models. The
 * server checks every name again (lib/amux/cliModelCatalogCore.ts).
 *
 * Claude Code lists no models, so a Claude worker's choices come from the
 * Anthropic entries of Admin › Models instead.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const entry = (cliModel, displayName) => {
  // Cursor pads some names with zero-width characters; they are not part of a name.
  const name = typeof displayName === "string"
    ? displayName.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { cliModel, displayName: name.length > 0 && name !== cliModel ? name : null };
};

const unique = (entries) => {
  const seen = new Set();
  return entries.filter((item) => NAME.test(item.cliModel) && !seen.has(item.cliModel) && seen.add(item.cliModel));
};

/** `agent --list-models`: "name - Display Name" lines; `auto` is not a model. */
export function readCursorModelList(text) {
  return unique(String(text).split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+?)\s*$/.exec(line);
    return match && match[1] !== "auto" ? [entry(match[1], match[2].replace(/\s*\((?:current|default)[^)]*\)\s*$/i, ""))] : [];
  }));
}

/** ~/.codex/models_cache.json: the models Codex shows (`visibility: "list"`). */
export function readCodexModelsCache(json) {
  let parsed;
  try { parsed = JSON.parse(String(json)); } catch { return []; }
  const models = Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];
  return unique(models.flatMap((model) =>
    model && typeof model.slug === "string" && model.visibility === "list" ? [entry(model.slug, model.display_name)] : []));
}

/** `copilot help config`: the quoted values under the `model` setting. */
export function readCopilotHelpConfig(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*`model`:/.test(line));
  if (start < 0) return [];
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*`[A-Za-z]+`:/.test(line)) break;
    const match = /^\s*-\s+"([^"]+)"\s*$/.exec(line);
    if (match) names.push(entry(match[1], null));
  }
  return unique(names);
}
