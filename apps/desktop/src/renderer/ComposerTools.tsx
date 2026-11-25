import { useRef, useState, type ReactNode } from "react";
import { BookOpen, Bot, Globe2, Plus } from "lucide-react";
import { LanguageProvider, useLanguage } from "@/components/LanguageProvider";
import type { Language } from "@/lib/language";
import type { ComposerOptions } from "../chat-contract";

type Props = { children: ReactNode; options?: ComposerOptions; setOptions?: (patch: ComposerOptions) => void; disabled?: boolean };

export function ComposerTools({ language, ...props }: Props & { language: Language }) {
  return <LanguageProvider initialLang={language} forceInitialLang>
    <ToolsMenu {...props} />
  </LanguageProvider>;
}

function ToolsMenu({ children, options, setOptions, disabled }: Props) {
  const { t } = useLanguage();
  const trigger = useRef<HTMLElement>(null);
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>();
  const webSearch = options?.webSearchMode === "always";
  return <details className="model-menu composer-tools" onToggle={(event) => {
    if (event.currentTarget.open && options) void window.desktop.accountSettings<"assistants">({ action: "assistants" })
      .then(({ profiles }) => setProfiles(profiles.filter(({ published }) => published)), () => setProfiles(undefined));
  }} onKeyDown={(event) => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; trigger.current?.focus();
  }}>
    <summary className="icon" ref={trigger} aria-label={t("chat.addAndTools")}><Plus size={18} /></summary>
    <div className="composer-tools-panel">
      {children}
      {options && <><button className="composer-tool-row" type="button" role="switch" aria-checked={webSearch}
        disabled={disabled} onClick={() => setOptions?.({ webSearchMode: webSearch ? "off" : "always" })}>
        <span className="composer-tool-icon"><Globe2 size={18} /></span>
        <span><strong>{t("chat.toolsWebSearch")}</strong><small>{t(webSearch ? "chat.toolsWebSearchOnDescription" : "chat.toolsWebSearchOffDescription")}</small></span>
        <span className="composer-tool-switch" />
      </button>
      <div className="composer-tool-secondary">
        <label className="composer-tool-row"><span className="composer-tool-icon"><Bot size={18} /></span>
          <span><strong>{t("chat.toolsAssistant")}</strong>
            <select value={options.assistantProfileId ?? ""} disabled={disabled || !profiles}
              onChange={(event) => setOptions?.({ assistantProfileId: event.currentTarget.value || null })}>
              <option value="">{t("chat.toolsAssistantNone")}</option>
              {options.assistantProfileId && !profiles?.some(({ id }) => id === options.assistantProfileId) &&
                <option value={options.assistantProfileId}>{t("chat.toolsAssistant")}</option>}
              {profiles?.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
            </select>
          </span>
        </label>
        <label className="composer-tool-row"><span className="composer-tool-icon"><BookOpen size={18} /></span>
          <span><strong>{t("chat.toolsMemory")}</strong>
            <select value={options.memoryMode ?? "inherit"} disabled={disabled}
              onChange={(event) => setOptions?.({ memoryMode: event.currentTarget.value as ComposerOptions["memoryMode"] })}>
              <option value="inherit">{t("chat.toolsMemoryInherit")}</option>
              <option value="on">{t("chat.toolsMemoryOn")}</option>
              <option value="off">{t("chat.toolsMemoryOff")}</option>
            </select>
          </span>
        </label>
      </div></>}
    </div>
  </details>;
}
