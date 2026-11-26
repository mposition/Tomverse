import type { Language } from "../../../../lib/language";
import { desktopCodeBrowserCopy } from "../../../../locales/desktopCodeBrowser";
import type { Snapshot } from "../contract";

/**
 * Settings > Execution and limits: the switch for the agent's use of the browser panel and, under it, the one for public https sites.
 * The panel itself does not depend on either. Both are off by default.
 */
export function CodeBrowserSettings({ snapshot, language, act }: {
  snapshot: Snapshot | null; language: Language; act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const copy = desktopCodeBrowserCopy[language];
  return <>
  <div className="execution-setting-row" data-testid="code-browser-agent-setting">
    <div>
      <label htmlFor="code-browser-agent">{copy.agentSetting}</label>
      <small id="code-browser-agent-info">{copy.agentSettingDetail}</small>
    </div>
    <div className="execution-setting-control">
      <select id="code-browser-agent" aria-describedby="code-browser-agent-info" value={snapshot?.codeBrowserAgent ? "on" : "off"}
        disabled={!snapshot} onChange={(event) => {
          const enabled = event.currentTarget.value === "on";
          void act(() => window.desktop.codeBrowser({ type: "agent-tools", enabled }));
        }}>
        <option value="off">{copy.agentOff}</option><option value="on">{copy.agentOn}</option>
      </select>
    </div>
  </div>
  <div className="execution-setting-row" data-testid="code-browser-web-setting">
    <div>
      <label htmlFor="code-browser-web">{copy.webAgentSetting}</label>
      <small id="code-browser-web-info">{copy.webAgentSettingDetail}</small>
    </div>
    <div className="execution-setting-control">
      <select id="code-browser-web" aria-describedby="code-browser-web-info" value={snapshot?.codeBrowserWeb ? "on" : "off"}
        disabled={!snapshot || !snapshot.codeBrowserAgent} onChange={(event) => {
          const enabled = event.currentTarget.value === "on";
          void act(() => window.desktop.codeBrowser({ type: "agent-web", enabled }));
        }}>
        <option value="off">{copy.agentOff}</option><option value="on">{copy.agentOn}</option>
      </select>
    </div>
  </div>
  </>;
}
