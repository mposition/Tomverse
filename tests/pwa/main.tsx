import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatPwaControls } from "../../components/chat/ChatPwaControls";
function Fixture() {
  const [text, setText] = useState("");
  const [owner, setOwner] = useState(() => new URL(location.href).searchParams.get("owner") ?? "guest");
  return <><ChatPwaControls onRestore={setText} ownerKey={owner} /><button onClick={() => setOwner("account:other")}>Switch account</button><textarea aria-label="Recovered draft" value={text} onChange={(event) => setText(event.target.value)} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
