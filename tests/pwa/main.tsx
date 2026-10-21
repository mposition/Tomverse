import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatPwaControls } from "../../components/chat/ChatPwaControls";
function Fixture() {
  const [text, setText] = useState("");
  return <><ChatPwaControls onRestore={setText} /><textarea aria-label="Recovered draft" value={text} onChange={(event) => setText(event.target.value)} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
