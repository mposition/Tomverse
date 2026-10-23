import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatPwaControls } from "../../components/chat/ChatPwaControls";
import { PwaInstallMenuItem } from "../../components/chat/PwaInstallMenuItem";
import { PwaInstallListener, usePwaInstall } from "../../components/chat/usePwaInstall";
function AccountMenu({ language }: { language: string }) {
  const install = usePwaInstall();
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen((value) => !value)}>Account menu</button>
    {open && <div role="group" aria-label="Account menu">
      <PwaInstallMenuItem install={install} language={language} onPrompt={() => setOpen(false)} />
    </div>}</>;
}
function Fixture() {
  const [text, setText] = useState("");
  const [owner, setOwner] = useState(() => new URL(location.href).searchParams.get("owner") ?? "guest");
  const [language, setLanguage] = useState(() => new URL(location.href).searchParams.get("lang") ?? "en");
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(() => new URL(location.href).searchParams.get("drawer") !== "closed");
  return <><PwaInstallListener /><ChatPwaControls onRestore={setText} ownerKey={owner} language={language} />
    {drawerOpen && <AccountMenu key={String(collapsed)} language={language} />}
    <button onClick={() => setDrawerOpen(true)}>Open mobile drawer</button>
    <button onClick={() => setCollapsed((value) => !value)}>Toggle sidebar</button>
    <label>Language<select value={language} onChange={(event) => setLanguage(event.target.value)}>
      {["en", "ko", "zh", "de", "fr", "es", "pt"].map((lang) => <option key={lang}>{lang}</option>)}
    </select></label>
    <button onClick={() => setOwner("account:other")}>Switch account</button><textarea aria-label="Recovered draft" value={text} onChange={(event) => setText(event.target.value)} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
