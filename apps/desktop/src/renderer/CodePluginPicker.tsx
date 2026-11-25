import { useEffect, useState } from "react";
import { Puzzle } from "lucide-react";
import type { Language } from "../../../../lib/language";
import type { DesktopPluginInventory } from "../plugin-contract";

export function CodePluginPicker({ language, value, disabled, select }: {
  language: Language; value: string; disabled: boolean; select: (id: string) => void;
}) {
  const [connections, setConnections] = useState<DesktopPluginInventory["connections"]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void window.desktop.pluginInventory().then(inventory => {
      if (active && inventory.enabled) setConnections(inventory.connections.filter(row => row.status === "connected" && row.granted > 0));
    }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  const ko = language === "ko";
  const label = ko ? "이번 작업의 플러그인" : "Plugin for this task";
  return <details className="model-menu">
    <summary className="icon" aria-label={label}><Puzzle size={18} /></summary>
    <div className="model-popover">
      <label>{label}
        <select aria-label={label} value={value} disabled={disabled || !connections.length} onChange={event => select(event.currentTarget.value)}>
          <option value="">{ko ? "사용 안 함" : "None"}</option>
          {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
        </select>
      </label>
      <small>{failed ? (ko ? "연결을 불러올 수 없습니다." : "Could not load connections.") : ko
        ? "플러그인 읽기 결과가 Code 모델에 전달됩니다. 이 작업은 저장하거나 재개할 수 없습니다."
        : "Read results are shared with the Code model. This task cannot be saved or resumed."}</small>
    </div>
  </details>;
}
