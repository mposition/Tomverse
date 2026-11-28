import { useMemo, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { autoRoutingCopy } from "@/lib/autoRoutingCopy";
import type { Language } from "@/lib/language";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { SMART_ADAPTIVE_MODEL_ID, codePickerModels, creditFreeModelIds } from "../code-model-catalog";
import type { Model } from "../contract";
import { DesktopModelPicker } from "./DesktopModelPicker";

/**
 * Code's model control: the Chat model picker over the coding catalogue.
 * Smart Adaptive is the picker's own switch above the list, as in Chat, and
 * selects the catalogue's `smart-adaptive` entry; the control then names it
 * as Chat's does. `name` is the selected model's catalogue name.
 */
export function CodeModelPicker({ account, language, label, models, selectedId, name, detail, disabled, onSelect, effort }: {
  account?: string; language: Language; label: string; models: Model[]; selectedId: string; name: string; detail?: string;
  disabled: boolean; onSelect(id: string): void; effort: ReactNode;
}) {
  const contextCopy = desktopShellCopy[language].codeModelContext;
  const manual = useMemo(() => codePickerModels(models, contextCopy), [models, contextCopy]);
  // A provider CLI runs on the person's own subscription, so its rows show no Tomverse credit usage.
  const creditFree = useMemo(() => creditFreeModelIds(models), [models]);
  const [lastManual, setLastManual] = useState<string>();
  const auto = selectedId === SMART_ADAPTIVE_MODEL_ID;
  const offered = manual.length > 0 && models.some(({ id }) => id === SMART_ADAPTIVE_MODEL_ID);
  return <DesktopModelPicker account={account} language={language} label={label} models={manual} catalogueOnly creditFreeModelIds={creditFree} scope=".code"
    choices={!auto && manual.some(({ id }) => id === selectedId) ? [selectedId] : []} limit={1} singleModel plan="Max" disabled={disabled}
    mode={offered ? (auto ? "auto" : "manual") : undefined} autoOffered={offered}
    onModeChange={offered ? (next) => {
      if (next === "auto") { if (!auto) setLastManual(selectedId); onSelect(SMART_ADAPTIVE_MODEL_ID); }
      else if (auto) onSelect(manual.find(({ id }) => id === lastManual)?.id ?? manual[0]!.id);
    } : undefined}
    onChoose={([id]) => { if (id) { setLastManual(id); onSelect(id); } }} effort={effort}>
    {auto && <Sparkles size={15} />}{auto ? autoRoutingCopy[language].label : name}{detail}
  </DesktopModelPicker>;
}
