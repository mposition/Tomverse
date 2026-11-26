import { useEffect, useRef, useState } from "react";
import { Microscope, X } from "lucide-react";
import { LanguageProvider, useLanguage } from "@/components/LanguageProvider";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { DEEP_RESEARCH_DEFAULT_DEPTH, DEEP_RESEARCH_DEPTHS } from "../../../../lib/deepResearchModel";
import type { Language } from "../../../../lib/language";
import type { DeepResearchDepth } from "../chat-contract";

type Props = { model: string; credits: number; locked: boolean; ready: boolean;
  onClose: () => void; onStart: (depth: DeepResearchDepth) => void };

export function DesktopResearchSetup({ language, ...props }: Props & { language: Language }) {
  return <LanguageProvider initialLang={language} forceInitialLang><ResearchDialog {...props} /></LanguageProvider>;
}

const depthLabels = { quick: "Quick", standard: "Standard", deep: "Deep" } as const;

function ResearchDialog({ model, credits, locked, ready, onClose, onStart }: Props) {
  const { t } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [depth, setDepth] = useState<DeepResearchDepth>(DEEP_RESEARCH_DEFAULT_DEPTH);
  useEffect(() => {
    const panel = dialog.current;
    panel?.showModal();
    return () => panel?.close();
  }, []);
  return <dialog className="task-github-dialog desktop-research-dialog" ref={dialog}
    aria-labelledby="desktop-research-title" onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div>
      <header><h2 id="desktop-research-title"><Microscope size={19} />{t("chat.deepResearchSetupTitle")}</h2>
        <button type="button" className="icon" aria-label={t("auth.cancel")} onClick={onClose}><X size={18} /></button>
      </header>
      {locked ? <p>{t("chat.deepResearchUpgradeRequired")}</p> : <>
        <section className="desktop-research-summary"><strong>{t("chat.deepResearchEngineLabel")}</strong><span>{model}</span></section>
        <fieldset>
          <legend>{t("chat.deepResearchDepthLabel")}</legend>
          {DEEP_RESEARCH_DEPTHS.map((value) => <button key={value} type="button" aria-pressed={depth === value} onClick={() => setDepth(value)}>
            <strong>{t(`chat.deepResearchDepth${depthLabels[value]}`)}</strong>
            <small>{t(`chat.deepResearchDepth${depthLabels[value]}Description`)}</small>
          </button>)}
        </fieldset>
        <dl>
          <div><dt>{t("chat.deepResearchEstimatedTime")}</dt><dd>{t("chat.deepResearchEstimatedTimeValue")}</dd></div>
          <div><dt>{t("chat.deepResearchEstimatedCost")}</dt><dd><CreditCostBadge credits={credits} approximate size="xs" /></dd></div>
        </dl>
        <footer>
          <button type="button" className="soft" onClick={onClose}>{t("auth.cancel")}</button>
          <button type="button" className="primary" disabled={!ready} onClick={() => onStart(depth)}>{t("chat.deepResearchStart")}</button>
        </footer>
      </>}
    </div>
  </dialog>;
}
