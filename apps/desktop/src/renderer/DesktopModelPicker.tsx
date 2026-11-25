import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ModelPickerPanel } from "@/components/chat/ModelPickerPanel";
import { ModelLogoAssets } from "@/components/chat/ModelLogo";
import { WebSearchBackendReadinessProvider } from "@/components/chat/WebSearchBackendReadinessProvider";
import { AvailableCreditsProvider } from "@/components/credits/UsageMeter";
import { IMAGE_MODEL_REGISTRY } from "@/lib/imageModelRegistry";
import { ImageModelCatalogProvider } from "@/components/images/ImageModelCatalogProvider";
import { canUseModelWithPlan, getModelUsageCredits, type AiModel, type ModelTier } from "@/lib/models";
import { isLanguage, type Language } from "@/lib/language";
import type { ImageCapability } from "../images-contract";
import "./desktop-model-picker.css";

const images = import.meta.glob<string>("../../../../public/model-icons/*.png", { eager: true, import: "default", query: "?url&no-inline" });
const modelAsset = (path: string) => images[`../../../../public${path}`];
const emptyStatuses = {};
type Mode = "auto" | "manual";

function readIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function DesktopModelPicker({ account, language, label, children, models, choices, limit, plan, disabled,
  mode, autoOffered, onModeChange, onChoose, effort, hasImageAttachments, imageCapability, onImage, searchReadiness, singleModel = false }: {
  account?: string; language: Language; label: string; children: ReactNode;
  models: AiModel[]; choices: string[]; limit: number; plan: ModelTier; disabled: boolean;
  mode?: Mode; autoOffered?: boolean; onModeChange?(mode: Mode): void; onChoose(ids: string[]): void;
  effort?: ReactNode; hasImageAttachments?: boolean;
  imageCapability?: ImageCapability | null; onImage?(id: string): void;
  searchReadiness?: { brave: boolean }; singleModel?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const escape = useRef<(() => boolean) | null>(null);
  const outsideDown = useRef(false);
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [swap, setSwap] = useState<AiModel>();
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const key = `desktop.model-picker.${account ?? "local"}`;
  const imageModels = IMAGE_MODEL_REGISTRY.flatMap((model) => {
    const entry = imageCapability?.models.find(({ id }) => id === model.id);
    return entry ? [{ ...model, name: entry.name, disabledReason: null, prices: entry.prices.map((price) => ({
      ...model.prices.find((candidate) => candidate.size === price.size && candidate.quality === price.quality)!, ...price,
    })) }] : [];
  });
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      search.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!open || !account) return;
    let active = true;
    void window.desktop.accountSettings<"usage">({ action: "usage" }).then(({ balances }) => {
      const planLeft = balances.planRemainingCredits ?? 0;
      const available = (balances.dailyRemainingCredits === null ? planLeft : Math.min(planLeft, balances.dailyRemainingCredits))
        + balances.purchasedRemainingCredits;
      if (active) setCredits(available);
    }).catch(() => {});
    return () => { active = false; };
  }, [open, account]);
  function remember(kind: "favorites" | "recent", id: string) {
    const current = kind === "favorites" ? favorites : recent;
    const rest = current.filter((item) => item !== id);
    const next = kind === "favorites" && current.includes(id) ? rest : [id, ...rest].slice(0, 100);
    (kind === "favorites" ? setFavorites : setRecent)(next);
    try { localStorage.setItem(`${key}.${kind}`, JSON.stringify(next)); } catch {}
  }
  function select(id: string) {
    const model = models.find((entry) => entry.id === id);
    if (!model || !canUseModelWithPlan(plan, model) || disabled) return false;
    onChoose(singleModel ? [id] : choices.includes(id) ? choices.filter((item) => item !== id) : [...choices, id]);
    return true;
  }
  function close() { dialog.current?.close(); }
  return <>
    <button className="desktop-model-trigger" type="button" ref={trigger} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
      disabled={disabled || !models.length} onClick={() => {
        setFavorites(readIds(`${key}.favorites`)); setRecent(readIds(`${key}.recent`)); setCredits(null); setOpen(true);
      }}>{children}<ChevronDown size={15} /></button>
    <dialog ref={dialog} className="desktop-model-dialog" aria-label={label}
      onPointerDown={(event) => { outsideDown.current = event.target === event.currentTarget; }}
      onClick={(event) => { if (outsideDown.current && event.target === event.currentTarget) close(); }}
      onCancel={(event) => {
        if (swap || escape.current?.()) { event.preventDefault(); if (swap) setSwap(undefined); }
      }}
      onClose={() => { setOpen(false); setSwap(undefined); trigger.current?.focus(); }}>
      {open && <div className="desktop-model-panel">
        <LanguageProvider initialLang={isLanguage(language) ? language : "en"} forceInitialLang>
          <ModelLogoAssets.Provider value={modelAsset}>
            <AvailableCreditsProvider value={credits}>
              <ImageModelCatalogProvider models={imageModels}>
                <WebSearchBackendReadinessProvider readiness={searchReadiness}>
                <ModelPickerPanel models={models} singleModelSelection={singleModel} selectedModelIds={choices}
                  maxSelectableModels={limit} currentPlan={plan} isGuestMode={false} isMobileShell={false}
                  isCompactLayout={false} isKeyboardCompact={false} modelStatuses={emptyStatuses}
                  hasImageAttachments={hasImageAttachments ?? false} favoriteModelIds={favorites} recentModelIds={recent}
                  personalizedModelIds={[]} activeSelectedCount={choices.length}
                  selectedBaseCredits={choices.reduce((total, id) => {
                    const model = models.find((entry) => entry.id === id);
                    return total + (model ? getModelUsageCredits(model) : 0);
                  }, 0)}
                  searchInputRef={search} escapeHandlerRef={escape} onToggleModel={select}
                  onRequestSwap={(model) => setSwap(model)} onToggleFavorite={(id) => remember("favorites", id)}
                  onRememberRecentModel={(id) => remember("recent", id)} onBackToActions={close} onDone={close}
                  onTrackEvent={() => {}} autoSelectionOffered={autoOffered} selectionMode={mode} selectionModePending={disabled}
                  onSelectionModeChange={onModeChange && (async (next) => { onModeChange(next ? "auto" : "manual"); return true; })}
                  reasoningEffortSlot={effort}
                  onSelectImageModel={imageModels.length && onImage ? (id) => { close(); onImage(id); } : undefined} />
                </WebSearchBackendReadinessProvider>
              </ImageModelCatalogProvider>
            </AvailableCreditsProvider>
          </ModelLogoAssets.Provider>
        </LanguageProvider>
        {effort && mode !== "auto" && <div className="desktop-model-effort">{effort}</div>}
        {swap && <div className="desktop-model-swap" role="group" aria-label={swap.name}>
          <strong>{swap.name}</strong>
          {choices.map((id) => <button className="soft" type="button" key={id} onClick={() => {
            onChoose(choices.map((choice) => choice === id ? swap.id : choice)); setSwap(undefined);
          }}>{models.find((model) => model.id === id)?.name ?? id} → {swap.name}</button>)}
        </div>}
      </div>}
    </dialog>
  </>;
}
