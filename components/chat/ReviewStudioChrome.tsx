"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSession } from "next-auth/react";
import { useUserUsage } from "./useUserUsage";
import { usagePercent } from "./UsagePercentGauge";
import { chatProductUiCopy, localizedProductHref, type ChatWorkspaceProduct } from "@/lib/chatProductUiCopy";
import { ArrowRight, BarChart3, Check, ChevronDown, Moon, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { ModelLogo } from "@/components/chat/ModelLogo";
import type { ReviewWorkspaceControls, WorkspaceAppearanceControls } from "./useReviewWorkspace";
import { reviewWorkspaceCopy } from "@/lib/reviewWorkspaceCopy";
import { storeAndApplyThemePreference } from "@/lib/theme";
import { openAccountSettings } from "@/lib/accountSettingsEvents";
import { openChatModelPicker } from "@/lib/chatModelPickerEvents";
import { useKeyboardInset } from "./useVisualViewport";
import { reviewProviderPreferencesCopy } from "@/lib/reviewProviderPreferencesCopy";
import type { VisibleStarterCard } from "@/lib/chatStarterAvailability";

const names: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "xAI", deepseek: "DeepSeek", meta: "Meta", mistral: "Mistral", perplexity: "Perplexity" };
export const reviewProviderName = (provider: string) => names[provider] ?? provider;
function Icon({ file }: { file: string }) {
  // The approved Figma assets are local, including their intrinsic dimensions.
  return <Image loading="eager" unoptimized width={22} height={22} src={`/review-studio/${file}.svg`} alt="" aria-hidden="true" />;
}

export function ReviewModeSwitcher({ review, locked = false, composer = false }: {
  review: ReviewWorkspaceControls; locked?: boolean; composer?: boolean;
}) {
  const { lang } = useLanguage();
  const c = reviewWorkspaceCopy[lang];
  return <div className={`review-mode${composer ? " review-composer-mode" : ""}`} data-testid={composer ? "composer-review-mode" : undefined} role="group" aria-label={c.mode}>
    {(["easy", "professional"] as const).map(mode => <button key={mode} type="button" aria-pressed={review.mode === mode} disabled={locked || review.pending || review.ready === false || (mode === "easy" && !review.easyAvailable)} title={mode === "easy" && !review.easyAvailable ? c.unavailable : undefined} onClick={() => review.setMode(mode)}>{mode === "easy" ? "Easy" : "Professional"}</button>)}
  </div>;
}

export function ReviewCommandBar({ review, locked = false, view, setView, showModeSwitcher = true }: {
  review: ReviewWorkspaceControls; locked?: boolean; view?: "write" | "results"; setView?: (view: "write" | "results") => void; showModeSwitcher?: boolean;
}) {
  const { lang } = useLanguage();
  const c = reviewWorkspaceCopy[lang];
  return <header className="review-command-bar" data-testid="review-command-bar">
    <div className="review-brand"><Image loading="eager" unoptimized src="/tomverse-logo.png" width={34} height={34} alt="Tomverse" /><strong>Review</strong><span>/ {c.newTask}</span></div>
    {showModeSwitcher && <ReviewModeSwitcher review={review} locked={locked} />}
    {setView && <div className="review-view-switch" role="group" aria-label={c.results}>
      <button type="button" aria-pressed={view === "write"} onClick={() => setView("write")}>{c.write}</button>
      <button type="button" aria-pressed={view === "results"} onClick={() => setView("results")}>{c.results}</button>
    </div>}
    <WorkspaceAppearanceActions workspace={review} disabled={locked || review.pending} testId="review-appearance" />
  </header>;
}

function WorkspaceAppearanceActions({ workspace, disabled, testId }: { workspace: WorkspaceAppearanceControls; disabled: boolean; testId: string }) {
  const { lang } = useLanguage();
  const c = reviewWorkspaceCopy[lang];
  const { data: session } = useSession();
  const usage = useUserUsage(Boolean(session?.user));
  const percent = usage ? usagePercent(usage.usage.creditsMonth, usage.limits.creditsMonth) : null;
  return <>
    <button type="button" className="review-credit-button" onClick={() => openAccountSettings("plan")} aria-label={`${c.settings}${percent === null ? "" : ` · ${percent}%`}`}><BarChart3 size={17} /><span>{percent === null ? "—" : `${percent}%`}</span></button>
    <button type="button" className="review-icon-button" aria-label={c.color} onClick={() => {
      const dark = document.documentElement.classList.contains("dark") || (!document.documentElement.classList.contains("light") && matchMedia("(prefers-color-scheme: dark)").matches);
      storeAndApplyThemePreference(dark ? "light" : "dark");
    }}><Moon size={17} /></button>
    <select disabled={disabled} data-testid={testId} aria-label={c.appearance} value={workspace.appearance} onChange={event => workspace.setAppearance(event.target.value === "classic" ? "classic" : "studio")}><option value="studio">Studio</option><option value="classic">Classic</option></select>
  </>;
}

export function ChatCommandBar({ workspace, locked = false }: { workspace: WorkspaceAppearanceControls; locked?: boolean }) {
  const { lang, t } = useLanguage();
  return <header className="review-command-bar chat-command-bar" data-testid="chat-command-bar">
    <div className="review-brand"><Image loading="eager" unoptimized src="/tomverse-logo.png" width={34} height={34} alt="Tomverse" /><strong>Chat</strong><span>/ {t("sidebar.newChat")}</span></div>
    <span className="chat-studio-description">{chatProductUiCopy[lang].chat.description}</span>
    <WorkspaceAppearanceActions workspace={workspace} disabled={locked} testId="chat-appearance" />
  </header>;
}

export function ReviewNavigation({ sidebar, onNewChat, onChat, onReview, product = "review", locked = false }: { sidebar: ReactNode; onNewChat: () => void; onChat?: () => boolean; onReview?: () => boolean; product?: ChatWorkspaceProduct; locked?: boolean }) {
  const { lang } = useLanguage(); const c = reviewWorkspaceCopy[lang];
  const [open, setOpen] = useState(false);
  const keyboardInset = useKeyboardInset();
  const trigger = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key === "Tab") {
        const items = Array.from(drawer.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input,select,[tabindex="0"]') ?? []).filter(node => node.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    drawer.current?.querySelector<HTMLElement>("button")?.focus();
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("keydown", close); previous?.focus({ preventScroll: true }); };
  }, [open]);
  const settings = (tab: "account" | "preferences") => { setOpen(true); openAccountSettings(tab); };
  return <>
    <nav className="review-navigation" aria-label="Tomverse">
      <Image loading="eager" unoptimized className="review-nav-logo" src="/tomverse-logo.png" alt="Tomverse" width={44} height={44} />
      <button type="button" className="review-new-task" disabled={locked} onClick={onNewChat}><Icon file="5d798" /><span>{c.newTask}</span></button>
      {product === "review" ? <button type="button" aria-current="page" onClick={() => setOpen(false)}><Icon file="96fdd" /><span>Review</span></button>
        : <Link className="review-navigation-chat" aria-disabled={locked} href={localizedProductHref("review", lang)} onClick={event => { if (locked || (onReview && !onReview())) event.preventDefault(); }}><Icon file="96fdd" /><span>Review</span></Link>}
      {product === "chat" ? <button type="button" aria-current="page" onClick={() => setOpen(false)}><Icon file="63e9a" /><span>Chat</span></button>
        : <Link className="review-navigation-chat" aria-disabled={locked} href={localizedProductHref("chat", lang)} onClick={event => { if (locked || (onChat && !onChat())) event.preventDefault(); }}><Icon file="63e9a" /><span>Chat</span></Link>}
      <button className="review-navigation-history" ref={trigger} type="button" onClick={() => setOpen(true)} aria-expanded={open}><Icon file="c8527" /><span>{c.history}</span></button>
      <div className="review-nav-spacer" />
      <Link href="/help"><Icon file="2b087" /><span>{c.help}</span></Link>
      <button type="button" onClick={() => settings("preferences")}><Icon file="f3fe6" /><span>{c.settings}</span></button>
      <button type="button" className="review-avatar" onClick={() => settings("account")} aria-label={c.settings}>T</button>
    </nav>
    {open && <div className="review-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div ref={drawer} className="review-history-drawer" style={{ bottom: 16 + keyboardInset }} role="dialog" aria-modal="true" aria-label={c.history}>
        <button type="button" className="review-drawer-close" aria-label={c.close} onClick={() => setOpen(false)}><X size={20} /></button>
        {sidebar}
      </div>
    </div>}
  </>;
}

export function ReviewParticipants({ review, selectedModels, canSelectModel, initialExpanded = false }: { initialExpanded?: boolean; review: ReviewWorkspaceControls; selectedModels: string[]; canSelectModel?: (id: string) => boolean }) {
  const { lang } = useLanguage(); const c = reviewWorkspaceCopy[lang];
  const { models } = useModelCatalog();
  const [expanded, setExpanded] = useState(initialExpanded);
  const options = [...new Set(models.filter(model => model.enabled && !model.catalogDeleted && model.publiclyListed !== false && (!canSelectModel || canSelectModel(model.id))).map(model => model.provider))];
  const providers = review.providersConfigured || review.providers.length ? review.providers : [...new Set(selectedModels.map(id => models.find(m => m.id === id)?.provider).filter((p): p is NonNullable<typeof p> => Boolean(p)))];
  return <div className="review-participants" data-testid="review-participants">
    <button type="button" data-testid={review.mode === "professional" ? "composer-model-select" : undefined} className="review-participants-heading" onClick={event => review.mode === "easy" ? setExpanded(!expanded) : openChatModelPicker(event.currentTarget)} aria-haspopup={review.mode === "professional" ? "dialog" : undefined} aria-expanded={review.mode === "easy" ? expanded : undefined}>
      <span>{review.mode === "easy" ? c.providers : c.models}</span><span>{review.mode === "easy" ? providers.length : selectedModels.length} / {review.maxProviders}<ChevronDown size={14} /></span>
    </button>
    <div className="review-participant-list">
      {(review.mode === "easy" ? expanded ? options : providers : selectedModels).map(id => {
        const model = review.mode === "easy" ? models.find(m => m.provider === id) : models.find(m => m.id === id);
        const selected = providers.includes(id);
        return <button type="button" key={id} aria-pressed={review.mode === "easy" ? selected : undefined} disabled={review.pending || review.ready === false || (review.mode === "easy" && !selected && providers.length >= review.maxProviders)} onClick={event => {
          if (review.mode === "professional") { openChatModelPicker(event.currentTarget); return; }
          if (selected && providers.length <= 1) return;
          review.setProviders(selected ? providers.filter(p => p !== id) : [...providers, id]);
        }}><ModelLogo model={model} size="md" /><span><strong>{review.mode === "easy" ? reviewProviderName(id) : model?.name ?? id}</strong><small>{review.mode === "easy" ? c.automatic : model ? reviewProviderName(model.provider) : ""}</small></span><Check size={14} className={!selected && review.mode === "easy" ? "invisible" : ""} /></button>;
      })}
    </div>
    {review.mode === "easy" && !providers.length && <p role="status">{reviewProviderPreferencesCopy(lang).unavailable}</p>}
    {review.mode === "easy" && !review.easyAvailable && <p role="status">{c.unavailable}</p>}
    {review.pending && <p role="status" data-testid="review-routing-pending">{c.routing}</p>}
    {review.error && <p role="alert" data-testid="review-routing-error">{review.error}</p>}
  </div>;
}

export function ReviewUnsupportedProviders({ providers }: { providers: string[] }) {
  const { lang } = useLanguage(); const c = reviewWorkspaceCopy[lang];
  return <div className="review-unsupported-providers">{providers.map(provider => <div key={provider} role="status" data-testid="review-image-unsupported"><strong>{reviewProviderName(provider)}</strong><p>{c.unsupported}</p></div>)}</div>;
}

export function ReviewStudioWelcome({ starterGallery, onSeed, onHistory, cards, onStarter }: {
  starterGallery?: ReactNode; onSeed: (text: string) => void; onHistory?: () => void;
  cards?: readonly VisibleStarterCard[]; onStarter?: (id: string) => void;
}) {
  const { lang, t } = useLanguage(); const c = reviewWorkspaceCopy[lang];
  const available = (id: string) => !cards || cards.some(card => card.entry.id === id);
  const lockLabel = (id: string) => {
    const availability = cards?.find(card => card.entry.id === id)?.availability;
    if (availability?.state !== "locked") return "";
    return availability.reason === "sign_in_required" ? t("chatStarter.lockedSignInShort")
      : t("chatStarter.lockedPlanShort").replaceAll("{plan}", availability.minimumPlan);
  };
  const seed = (id: string, key: string) => onStarter ? onStarter(id) : onSeed(t(key));
  return <div className="review-studio-welcome" data-testid="review-studio-welcome">
    <div className="review-canvas-intro"><span>{c.newReview}</span><small>{c.automatic}</small></div>
    <div className="review-editorial-intro"><div><h1>{c.welcome}</h1><p>{c.intro}</p></div>
      <div className="review-perspectives" aria-hidden="true">{["openai", "anthropic", "google"].map((provider, index) => <div className={`review-perspective review-perspective-${index}`} key={provider}><div><Image loading="eager" unoptimized src={`/model-icons/${["chatgpt", "claude", "gemini"][index]}.png`} width={24} height={24} alt="" /><span>{reviewProviderName(provider)}</span><Check size={14} /></div><strong>{[c.documents.split("\n")[0], c.focus, c.results][index]}</strong><i /><i /></div>)}</div>
    </div>
    <div className="review-starter-heading"><strong>{c.start}</strong><small>{c.seedHint}</small></div>
    <div className="review-starter-grid">
      {available("document-questions") && <button type="button" className="review-document-starter" onClick={() => seed("document-questions", "chatStarter.cards.documentQuestions.seed")}><Icon file="f7df8" /><strong data-label={c.documentHint}>{c.documents}</strong><span>{c.documentHint}<ArrowRight size={20} /></span></button>}
      {available("compare-image-models") && <button type="button" className="review-image-starter" onClick={() => seed("compare-image-models", "chatStarter.cards.compareImageModels.seed")}><Icon file="196ae" /><span><strong>{c.images}</strong><small>{c.imageHint}{lockLabel("compare-image-models") && <b className="ml-2">{lockLabel("compare-image-models")}</b>}</small></span><ArrowRight size={17} /></button>}
      {available("sourced-answer") && <button type="button" className="review-research-starter" onClick={() => seed("sourced-answer", "chatStarter.cards.sourcedAnswer.seed")}><Icon file="f161b" /><span><strong>{c.research}</strong><small>{c.researchHint}</small></span><ArrowRight size={17} /></button>}
    </div>
    <div className="review-extra-starters">{available("debug-stack-trace") && <button type="button" onClick={() => seed("debug-stack-trace", "chatStarter.cards.debugStackTrace.seed")}><Icon file="7048e" />{c.code}</button>}{available("spreadsheet-from-answer") && <button type="button" onClick={() => seed("spreadsheet-from-answer", "chatStarter.cards.spreadsheetFromAnswer.seed")}><Icon file="1c9ae" />{c.files}</button>}{onHistory && <button type="button" onClick={onHistory}>{c.history}</button>}</div>
    {starterGallery}
  </div>;
}
