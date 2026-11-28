import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, Crosshair, MousePointer2, Plus, RotateCw, Square, Trash2, Wrench, X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopCodeBrowserCopy } from "../../../../locales/desktopCodeBrowser";
import { mobileCopy } from "../../../../locales/mobile";
import { classifyBrowserAddress, MAX_CODE_BROWSER_TABS, type BrowserCommand, type BrowserState } from "../browser-contract";
import { MAX_ELEMENT_COMMENTS } from "../element-comment";
import { ElementComments, type Pin } from "./ElementComments";

const copy: Record<Language, readonly [string, string, string, string, string, string, string, string]> = {
  en: ["Browser", "Address", "Back", "Forward", "Reload", "Stop loading", "Enter a public https address, or an address on this computer or your network.", "The page could not load."],
  ko: ["브라우저", "주소", "뒤로", "앞으로", "새로고침", "로딩 중지", "공개 https 주소나 이 컴퓨터·내 네트워크의 주소를 입력하세요.", "페이지를 불러오지 못했습니다."],
  zh: ["浏览器", "地址", "后退", "前进", "刷新", "停止加载", "请输入公开的 https 地址，或本机、本地网络上的地址。", "无法加载页面。"],
  "zh-Hant": ["瀏覽器", "網址", "返回", "前進", "重新整理", "停止載入", "請輸入公開的 https 位址，或本機、區域網路上的位址。", "無法載入頁面。"],
  fr: ["Navigateur", "Adresse", "Précédent", "Suivant", "Actualiser", "Arrêter le chargement", "Saisissez une adresse https publique, ou une adresse de cet ordinateur ou de votre réseau.", "La page n’a pas pu être chargée."],
  de: ["Browser", "Adresse", "Zurück", "Vor", "Neu laden", "Laden stoppen", "Eine öffentliche https-Adresse oder eine Adresse dieses Computers oder Ihres Netzwerks eingeben.", "Die Seite konnte nicht geladen werden."],
  es: ["Navegador", "Dirección", "Atrás", "Adelante", "Recargar", "Detener carga", "Introduce una dirección https pública o una dirección de este equipo o de tu red.", "La página no se pudo cargar."],
  pt: ["Navegador", "Endereço", "Voltar", "Avançar", "Recarregar", "Parar carregamento", "Insira um endereço https público ou um endereço deste computador ou da sua rede.", "A página não pôde ser carregada."],
};
const tabControls: Record<Language, readonly [string, string, string, string]> = {
  en: ["Tabs", "New tab", "Close tab", "Focus web page"], ko: ["탭", "새 탭", "탭 닫기", "웹페이지에 포커스"],
  zh: ["标签页", "新建标签页", "关闭标签页", "聚焦网页"], "zh-Hant": ["分頁", "新增分頁", "關閉分頁", "聚焦網頁"],
  fr: ["Onglets", "Nouvel onglet", "Fermer l’onglet", "Accéder à la page"], de: ["Tabs", "Neuer Tab", "Tab schließen", "Webseite fokussieren"],
  es: ["Pestañas", "Nueva pestaña", "Cerrar pestaña", "Enfocar página web"], pt: ["Guias", "Nova guia", "Fechar guia", "Focar página"],
};
export const codeBrowserLabel = (language: Language) => copy[language][0];

export function CodeBrowser({ language, hidden, occluded, canShare, agentLive = false, agentTools = false, onAttachComments, onClose }: {
  language: Language;
  hidden: boolean;
  occluded: boolean;
  canShare: boolean;
  /** The task of this panel is running: a tab the agent opened shows who holds it. */
  agentLive?: boolean;
  /** The agent has the browser tools, so it can read the picture of a picked element. */
  agentTools?: boolean;
  /** Puts the picked elements and their comments into the next message. */
  onAttachComments?: (block: string) => void;
  onClose: () => void;
}) {
  const pickCopy = desktopCodeBrowserCopy[language];
  const [pins, setPins] = useState<Pin[]>([]);
  const [label, address, back, forward, reload, stop, invalid, failed] = copy[language];
  const common = mobileCopy[language];
  const slot = useRef<HTMLDivElement>(null);
  const [tabList, setTabList] = useState<string[]>(() => [crypto.randomUUID()]);
  const [selected, setSelected] = useState<string>();
  const tab = selected && tabList.includes(selected) ? selected : tabList[0];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, BrowserState>>({});
  const [invalidTab, setInvalidTab] = useState<string>();
  const statesRef = useRef<Record<string, BrowserState>>({});
  const [width, setWidth] = useState(46);
  const [shared, setShared] = useState<{ tab: string; url: string }>();
  const draft = drafts[tab] ?? "";
  const state = states[tab];
  const invalidUrl = invalidTab === tab;
  const sharing = canShare && !hidden && !occluded && shared?.tab === tab && shared.url === state?.url && !state?.loading;
  const [share, unshare] = language === "ko" ? ["이 페이지를 Code에 공유", "Code 공유 중지"]
    : ["Share this page with Code", "Stop sharing with Code"];
  const [tabsLabel, addTab, closeTab, focusPage] = tabControls[language];
  function changeAddress(value: string) { setDrafts((previous) => ({ ...previous, [tab]: value })); }
  function send(command: BrowserCommand) { void window.desktop.codeBrowser(command).catch(() => setInvalidTab(tab)); }
  useEffect(() => { statesRef.current = states; }, [states]);
  useEffect(() => {
    const addresses = new Map<string, string>();
    const adopted = new Set<string>();
    const unsubscribePick = window.desktop.subscribeCodeBrowserPick((pick) => {
      setPins((previous) => previous.length >= MAX_ELEMENT_COMMENTS ? previous : [...previous, { pick, comment: "" }]);
    });
    const unsubscribe = window.desktop.subscribeCodeBrowser((next) => {
      // The main process closed the tab: it leaves the list (the last tab stays, empty).
      if (next.closed) {
        adopted.delete(next.tab);
        addresses.delete(next.tab);
        const without = <Value,>(previous: Record<string, Value>) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== next.tab));
        setTabList((previous) => previous.length > 1 ? previous.filter((id) => id !== next.tab) : previous);
        setStates(without);
        setDrafts(without);
        setShared((previous) => previous?.tab === next.tab ? undefined : previous);
        return;
      }
      // A tab the agent opened, or a page opened from a link or window.open, is new to this panel: show it, once, and bring it forward.
      if ((next.agent || next.opener) && !adopted.has(next.tab)) {
        adopted.add(next.tab);
        setTabList((previous) => {
          if (previous.includes(next.tab)) return previous;
          const list = [...previous, next.tab];
          // A full list gives up a tab that holds no page before one that does.
          while (list.length > MAX_CODE_BROWSER_TABS) {
            const blank = list.findIndex((id) => id !== next.tab && !statesRef.current[id]);
            list.splice(blank >= 0 ? blank : 0, 1);
          }
          return list;
        });
        setSelected(next.tab);
      }
      setStates((previous) => ({ ...previous, [next.tab]: next }));
      setShared((previous) => previous?.tab === next.tab && (previous.url !== next.url || next.loading || next.failed) ? undefined : previous);
      if (next.url && next.url !== addresses.get(next.tab)) {
        addresses.set(next.tab, next.url);
        setDrafts((previous) => ({ ...previous, [next.tab]: next.url }));
      }
    });
    // Tabs the agent opened while this panel was closed.
    void window.desktop.codeBrowser({ type: "sync" }).catch(() => {});
    return () => { unsubscribe(); unsubscribePick(); void window.desktop.codeBrowser({ type: "close" }).catch(() => {}); };
  }, []);
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    const update = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const bounds = hidden || occluded ? null : { x: Math.max(0, x), y: Math.max(0, y), width, height };
      void window.desktop.codeBrowser({ type: "layout", tab, bounds }).catch(() => {});
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [hidden, occluded, state?.url, tab]);
  return <aside id="code-browser-panel" className="code-browser" aria-label={label} hidden={hidden}
    style={{ "--browser-width": width + "%" } as CSSProperties}>
    <div className="code-browser-resize" role="separator" aria-label={label} aria-orientation="vertical"
      aria-valuemin={28} aria-valuemax={66} aria-valuenow={width} tabIndex={0} onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setWidth((value) => Math.min(66, Math.max(28, value + (event.key === "ArrowLeft" ? 2 : -2))));
      }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const box = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
        if (box?.width) setWidth(Math.min(66, Math.max(28, Math.round((box.right - event.clientX) * 100 / box.width))));
      }} />
    <div className="code-browser-heading">
      <strong>{label}</strong>
      <button type="button" className="icon" aria-label={pickCopy.clearData} title={pickCopy.clearData}
        onClick={() => void window.desktop.codeBrowser({ type: "clear-data", tab }).catch(() => {})}><Trash2 size={14} /></button>
      <button type="button" className="soft" onClick={onClose}>{common.close}</button>
    </div>
    <div className="code-browser-tabs">
      <div role="tablist" className="code-browser-tabs" aria-label={tabsLabel}>
        {tabList.map((id, index) => <button key={id} id={"code-browser-tab-" + id} type="button" className="soft" role="tab"
          aria-selected={tab === id} aria-controls={tab === id ? "code-browser-tab-content" : undefined}
          tabIndex={tab === id ? 0 : -1} onClick={() => { setShared(undefined); setSelected(id); }} onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = tabList[(index + tabList.length + (event.key === "ArrowRight" ? 1 : -1)) % tabList.length];
            setShared(undefined);
            setSelected(next);
            document.getElementById("code-browser-tab-" + next)?.focus();
          }}>{tabsLabel} {index + 1}</button>)}
      </div>
      <button type="button" className="icon" aria-label={addTab} disabled={tabList.length >= MAX_CODE_BROWSER_TABS} onClick={() => {
        const id = crypto.randomUUID();
        setShared(undefined);
        setTabList([...tabList, id]);
        setSelected(id);
      }}><Plus size={15} /></button>
      <button type="button" className="icon" aria-label={closeTab} disabled={tabList.length === 1} onClick={() => {
        const next = tabList.filter((id) => id !== tab);
        setShared(undefined);
        send({ type: "close-tab", tab });
        setTabList(next);
        setSelected(next[Math.max(0, tabList.indexOf(tab) - 1)]);
        setStates((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== tab)));
        setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== tab)));
      }}><X size={15} /></button>
    </div>
    <div className="code-browser-toolbar">
      <button type="button" className="icon" aria-label={back} disabled={!state?.back}
        onClick={() => send({ type: "back", tab })}><ArrowLeft size={15} /></button>
      <button type="button" className="icon" aria-label={forward} disabled={!state?.forward}
        onClick={() => send({ type: "forward", tab })}><ArrowRight size={15} /></button>
      <button type="button" className="icon" aria-label={state?.loading ? stop : reload} disabled={!state?.url}
        onClick={() => send({ type: state?.loading ? "stop" : "reload", tab })}>
        {state?.loading ? <Square size={14} /> : <RotateCw size={15} />}
      </button>
      <form onSubmit={(event) => {
        event.preventDefault();
        const address = classifyBrowserAddress(draft);
        setInvalidTab(address ? undefined : tab);
        if (address) {
          const { url, kind } = address;
          changeAddress(url.href);
          setStates((previous) => ({ ...previous, [tab]: { tab, kind, url: url.href, loading: true, failed: false, back: false, forward: false } }));
          // A refused address (a name that is not on this computer or network, a public name over http) ends the loading it showed.
          void window.desktop.codeBrowser({ type: "open", url: url.href, tab }).catch(() => {
            setInvalidTab(tab);
            setStates((previous) => previous[tab] ? { ...previous, [tab]: { ...previous[tab], loading: false, failed: false } } : previous);
          });
        }
      }}>
        <input type="text" inputMode="url" autoCapitalize="off" autoComplete="off" spellCheck={false} aria-label={address} placeholder="https://example.com, localhost:3000, 192.168.0.5:8080" value={draft}
          aria-invalid={invalidUrl || undefined} onChange={(event) => { changeAddress(event.currentTarget.value); setInvalidTab(undefined); }} />
      </form>
      <button type="button" className="icon" aria-label={focusPage} disabled={!state?.url || state?.failed}
        onClick={() => send({ type: "focus", tab })}><MousePointer2 size={14} /></button>
      <button type="button" className="icon" aria-label={pickCopy.devtools} title={pickCopy.devtools} disabled={!state?.url}
        onClick={() => send({ type: "devtools", tab })}><Wrench size={14} /></button>
      {onAttachComments && <button type="button" className="icon" aria-label={state?.picking ? pickCopy.pickCancel : pickCopy.pick} aria-pressed={Boolean(state?.picking)}
        disabled={!state?.url || state.failed || state.loading || pins.length >= MAX_ELEMENT_COMMENTS}
        onClick={() => void window.desktop.codeBrowser({ type: "pick", tab, enabled: !state?.picking }).catch(() => {})}><Crosshair size={14} /></button>}
    </div>
    {state?.tomverse && <p className="code-browser-note" data-testid="code-browser-account-notice">{pickCopy.accountNotice}</p>}
    {state?.download && <p className="code-browser-note code-browser-download" role="status" data-state={state.download.state}>
      {(state.download.state === "progressing" ? pickCopy.downloading : state.download.state === "completed" ? pickCopy.downloaded
        : state.download.state === "cancelled" ? pickCopy.downloadCancelled : pickCopy.downloadFailed).replace("{name}", state.download.name)}
      {state.download.state === "progressing" && state.download.total > 0 ? " " + Math.min(100, Math.floor(state.download.received * 100 / state.download.total)) + "%" : ""}
    </p>}
    {agentLive && state?.agent && <p className="code-browser-agent" role="status" data-state={state.agent}>
      <span>{state.agent === "stopped" ? pickCopy.agentStopped : pickCopy.agentUsing}{state.kind === "web" && state.agent !== "stopped" ? " " + pickCopy.webLoginNote : ""}</span>
      <button type="button" className="soft" onClick={() => send({ type: state.agent === "stopped" ? "agent-resume" : "agent-stop", tab })}>
        {state.agent === "stopped" ? pickCopy.resumeAgent : pickCopy.stopAgent}</button>
    </p>}
    {state?.picking && <p className="code-browser-hint" role="status">{pickCopy.pickHint}</p>}
    <ElementComments language={language} pins={pins} picture={agentTools} onChange={setPins} onAttach={(block) => onAttachComments?.(block)} />
    {canShare && (!state?.kind || state.kind === "local") && <button type="button" className="soft" aria-pressed={Boolean(sharing)}
      disabled={!state?.url || state.loading || state.failed} onClick={() => {
        void window.desktop.codeBrowser({ type: sharing ? "unshare" : "share", tab }).then((allowed) => {
          setShared(allowed && state ? { tab, url: state.url } : undefined);
        }).catch(() => setShared(undefined));
      }}>{sharing ? unshare : share}</button>}
    <div className="code-browser-target" ref={slot} role="tabpanel" id="code-browser-tab-content" aria-labelledby={"code-browser-tab-" + tab} />
    <p className="code-browser-status" role="status">{invalidUrl ? invalid : state?.failed ? failed : state?.loading ? common.loading : ""}</p>
  </aside>;
}
