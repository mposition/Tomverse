import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileWorkspaceCopy } from "../../../locales/mobileWorkspace";

export type MobileProduct = "chat" | "review";

export function WorkspaceNavigation({ product, language, disabled, loading, onChange }: {
  product: MobileProduct; language: MobileLanguage; disabled?: boolean; loading?: boolean;
  onChange: (product: MobileProduct) => void;
}) {
  return <nav className="workspace-navigation" aria-label={mobileWorkspaceCopy[language].product} data-loading={loading || undefined}>
    <div className="workspace-product-links">
      {(["chat", "review"] as const).map(value => <button key={value} type="button" aria-current={value === product ? "page" : undefined} disabled={disabled} onClick={() => onChange(value)}>{value === "chat" ? "Chat" : "Review"}</button>)}
    </div>
    {loading && <span className="workspace-loading" role="status"><span className="sr-only">{mobileCopy[language].loading}</span></span>}
  </nav>;
}
