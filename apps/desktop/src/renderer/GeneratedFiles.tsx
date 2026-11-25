import { useState } from "react";
import { Download, File } from "lucide-react";
import { formatArtifactSize, sanitizeArtifactFilename, type ChatStreamArtifact } from "../../../../lib/generatedArtifactCore";
import type { Language } from "../../../../lib/language";
import { desktopFilesCopy } from "../../../../locales/desktopFiles";
import { saveArtifactInput } from "../chat-contract";

function GeneratedFile({ artifact, language }: { artifact: ChatStreamArtifact; language: Language }) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const copy = desktopFilesCopy[language];
  const filename = sanitizeArtifactFilename(artifact.filename, artifact.format);
  const file = saveArtifactInput.safeParse({
    id: artifact.id, format: artifact.format, filename: artifact.filename, byteSize: artifact.byteSize,
  });
  const ready = artifact.status === "ready" && file.success;
  return <li className="generated-file">
    <File size={16} aria-hidden="true" />
    <div className="generated-file-name"><span title={filename}>{filename}</span>
      <small>{ready ? formatArtifactSize(artifact.byteSize) : copy.fileUnavailable}</small>
    </div>
    {ready && <button type="button" className="soft" disabled={status === "saving"}
      aria-label={copy.saveFile.replace("{file}", () => filename)} onClick={async () => {
        setStatus("saving");
        try {
          setStatus(await window.desktop.saveArtifact(file.data) ? "saved" : "idle");
        } catch {
          setStatus("failed");
        }
      }}><Download size={15} /> {status === "saving" ? copy.saving : copy.save}</button>}
    {status === "saved" && <small role="status">{copy.fileSaved}</small>}
    {status === "failed" && <small role="status">{copy.fileSaveError}</small>}
  </li>;
}

export function GeneratedFiles({ artifacts, language }: { artifacts: ChatStreamArtifact[]; language: Language }) {
  if (!artifacts.length) return null;
  return <ul className="generated-files" aria-label={desktopFilesCopy[language].generatedFiles}>
    {artifacts.map((artifact) => <GeneratedFile key={artifact.id} artifact={artifact} language={language} />)}
  </ul>;
}
