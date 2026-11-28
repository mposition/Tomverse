import { useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopPermissionsCopy } from "../../../../locales/desktopPermissions";
import { permissionModes, type PermissionModeId, type PermissionRuleInput, type PermissionsView } from "../permission-contract";
import "./permission-settings.css";

type Copy = (typeof desktopPermissionsCopy)[Language];
type ToolKind = "apply_patch" | "run_command" | "web_fetch" | "mcp";

const modeText = (copy: Copy, mode: PermissionModeId) => ({
  read_only: [copy.readOnly, copy.readOnlyDetail],
  ask: [copy.ask, copy.askDetail],
  auto_review: [copy.autoReview, copy.autoReviewDetail],
  allow_all: [copy.allowAll, copy.allowAllDetail],
} as const)[mode];

const toolText = (copy: Copy, tool: string) =>
  tool === "apply_patch" ? copy.toolEdit : tool === "run_command" ? copy.toolCommand : tool === "web_fetch" ? copy.toolWeb : tool;

const effectText = (copy: Copy, effect: PermissionRuleInput["effect"]) => effect === "allow" ? copy.effectAllow : effect === "ask" ? copy.effectAsk : copy.effectDeny;

export const ruleText = (copy: Copy, rule: PermissionRuleInput) =>
  `${effectText(copy, rule.effect)} · ${toolText(copy, rule.tool)}${rule.pattern ? ` · ${rule.pattern}` : ""}${rule.exact ? ` · ${copy.exact}` : ""}`;

function RuleList({ title, rules, scope, copy, empty, run }: {
  title: string; rules: PermissionRuleInput[]; scope: "user" | "project"; copy: Copy; empty: string | null;
  run: (command: { action: "remove-rule"; scope: "user" | "project"; rule: PermissionRuleInput }) => void;
}) {
  return <section aria-label={title} className="permission-rules">
    <h4>{title}</h4>
    {empty ? <p className="permission-muted">{empty}</p> : rules.length === 0 ? <p className="permission-muted">{copy.noRules}</p> : <ul>
      {rules.map((rule) => {
        const text = ruleText(copy, rule);
        return <li key={JSON.stringify(rule)} data-effect={rule.effect}>
          <span>{text}</span>
          <button className="soft" type="button" aria-label={copy.removeRule.replace("{rule}", () => text)}
            onClick={() => run({ action: "remove-rule", scope, rule })}>×</button>
        </li>;
      })}
    </ul>}
  </section>;
}

export function PermissionSettings({ view, language, act }: {
  view: PermissionsView | undefined;
  language: Language;
  act: (operation: () => Promise<unknown>) => Promise<unknown>;
}) {
  const copy = desktopPermissionsCopy[language];
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const [effect, setEffect] = useState<PermissionRuleInput["effect"]>("allow");
  const [tool, setTool] = useState<ToolKind>("run_command");
  const [mcpName, setMcpName] = useState("");
  const [pattern, setPattern] = useState("");
  const [exact, setExact] = useState(false);
  const [scope, setScope] = useState<"user" | "project">("user");
  if (!view) return null;
  const { rules } = view;

  async function send(command: Parameters<typeof window.desktop.permissions>[0]) {
    setFailed(false);
    await act(async () => {
      const result = await window.desktop.permissions(command);
      if (!result.ok) setFailed(true);
    });
  }

  function choose(mode: PermissionModeId) {
    if (mode === view!.mode) { setConfirming(false); return; }
    if (mode === "allow_all") { setConfirming(true); return; }
    setConfirming(false);
    void send({ action: "set-mode", mode });
  }

  const toolName = tool === "mcp" ? mcpName.trim() : tool;
  const needsPattern = tool !== "mcp" && effect === "allow";
  const canAdd = toolName.length > 0 && (tool === "mcp" ? true : needsPattern ? pattern.trim().length > 0 : true) && (scope === "user" || rules.hasProject);
  function addRule() {
    const rule: PermissionRuleInput = { effect, tool: toolName,
      ...(tool !== "mcp" && pattern.trim() ? { pattern: pattern.trim() } : {}), ...(tool === "run_command" && exact ? { exact: true } : {}) };
    void send({ action: "add-rule", scope, rule });
    setPattern("");
  }
  const placeholder = tool === "apply_patch" ? copy.patternEdit : tool === "run_command" ? copy.patternCommand : copy.patternWeb;
  const projectAllow = rules.project.filter((rule) => rule.effect === "allow");

  return <div className="permission-settings desktop-setting-section">
    <h3>{copy.modeHeading}</h3>
    <div role="radiogroup" aria-label={copy.modeHeading} className="permission-modes">
      {permissionModes.map((mode) => {
        const [label, detail] = modeText(copy, mode);
        return <label key={mode} className={`permission-mode-option${view.mode === mode ? " selected" : ""}`}>
          <input type="radio" name="permission-mode" value={mode} checked={view.mode === mode} onChange={() => choose(mode)} />
          <span><strong>{label}</strong><small>{detail}</small></span>
        </label>;
      })}
    </div>
    {view.mode === "auto_review" && <p className="permission-muted" role="note">{copy.autoReviewCost}</p>}
    {confirming && <div className="permission-confirm" role="alertdialog" aria-labelledby="permission-allow-all-title" aria-describedby="permission-allow-all-body">
      <strong id="permission-allow-all-title">{copy.allowAllConfirmTitle}</strong>
      <p id="permission-allow-all-body">{copy.allowAllConfirmBody}</p>
      <button className="soft" type="button" onClick={() => setConfirming(false)}>{copy.cancel}</button>
      <button className="soft danger" type="button" onClick={() => { setConfirming(false); void send({ action: "set-mode", mode: "allow_all", confirmed: true }); }}>{copy.allowAllConfirm}</button>
    </div>}

    <h3>{copy.rulesHeading}</h3>
    <p className="permission-muted">{copy.rulesDetail}</p>
    {(rules.trust === "untrusted" || rules.trust === "changed") && <div className="permission-trust" role="group" aria-label={copy.trustTitle}>
      <strong>{copy.trustTitle}</strong>
      <p>{rules.trust === "changed" ? copy.trustChanged : copy.trustBody}</p>
      <ul>{projectAllow.map((rule) => <li key={JSON.stringify(rule)}>{ruleText(copy, rule)}</li>)}</ul>
      <button className="soft" type="button" onClick={() => void send({ action: "trust-project" })}>{copy.trustApply}</button>
    </div>}
    {rules.trust === "trusted" && <button className="soft" type="button" onClick={() => void send({ action: "revoke-trust" })}>{copy.trustRevoke}</button>}
    {rules.problems.map((problem) => <p key={problem} className="permission-problem" role="alert">{copy.problems}: {problem}</p>)}
    <RuleList title={copy.userRules} rules={rules.user} scope="user" copy={copy} empty={null} run={(command) => void send(command)} />
    <RuleList title={copy.projectRules} rules={rules.project} scope="project" copy={copy} empty={rules.hasProject ? null : copy.noProject} run={(command) => void send(command)} />
    {rules.hasProject && <p className="permission-muted">{copy.projectFile}</p>}

    <form className="permission-add" aria-label={copy.newRule} onSubmit={(event) => { event.preventDefault(); if (canAdd) addRule(); }}>
      <select aria-label={copy.effect} value={effect} onChange={(event) => setEffect(event.currentTarget.value as PermissionRuleInput["effect"])}>
        <option value="allow">{copy.effectAllow}</option><option value="ask">{copy.effectAsk}</option><option value="deny">{copy.effectDeny}</option>
      </select>
      <select aria-label={copy.tool} value={tool} onChange={(event) => setTool(event.currentTarget.value as ToolKind)}>
        <option value="apply_patch">{copy.toolEdit}</option><option value="run_command">{copy.toolCommand}</option>
        <option value="web_fetch">{copy.toolWeb}</option><option value="mcp">{copy.toolMcp}</option>
      </select>
      {tool === "mcp"
        ? <input aria-label={copy.toolMcp} placeholder={copy.mcpName} value={mcpName} maxLength={160} onChange={(event) => setMcpName(event.currentTarget.value)} />
        : <input aria-label={copy.pattern} placeholder={placeholder} value={pattern} maxLength={500} onChange={(event) => setPattern(event.currentTarget.value)} />}
      {tool === "run_command" && <label className="permission-exact"><input type="checkbox" checked={exact} onChange={(event) => setExact(event.currentTarget.checked)} /> {copy.exact}</label>}
      <select aria-label={copy.scope} value={scope} onChange={(event) => setScope(event.currentTarget.value as "user" | "project")}>
        <option value="user">{copy.scopeUser}</option><option value="project" disabled={!rules.hasProject}>{copy.scopeProject}</option>
      </select>
      <button className="soft" type="submit" disabled={!canAdd}>{copy.add}</button>
    </form>
    {failed && <p className="permission-problem" role="alert">{copy.saveFailed}</p>}
  </div>;
}
