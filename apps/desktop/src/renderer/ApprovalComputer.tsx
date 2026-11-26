import type { Language } from "../../../../lib/language";
import { desktopCodeComputerCopy } from "../../../../locales/desktopCodeComputer";
import type { ApprovalRequest } from "../contract";

/** What the agent would do in the desktop window the person chose: the window, the program and the exact action. */
export function ApprovalComputer({ computer, language }: { computer: NonNullable<ApprovalRequest["computer"]>; language: Language }) {
  const copy = desktopCodeComputerCopy[language];
  const heading = computer.action === "click" ? copy.approvalClick : computer.action === "type" ? copy.approvalType : computer.action === "key" ? copy.approvalKey : copy.approvalScroll;
  return <section aria-label={heading}>
    <h2>{heading}</h2>
    <dl>
      <dt>{copy.approvalWindow}</dt><dd><code>{computer.window.title}</code></dd>
      <dt>{copy.approvalApp}</dt><dd><code>{computer.window.app}</code></dd>
      {computer.x !== undefined && <><dt>{copy.approvalPoint}</dt><dd><code>{computer.x}, {computer.y}</code></dd></>}
      {computer.action === "click" && <><dt>{copy.approvalButton}</dt><dd>{computer.button ?? "left"}{computer.double ? ` (${copy.approvalDouble})` : ""}</dd></>}
      {computer.text !== undefined && <><dt>{copy.approvalText}</dt><dd><pre>{computer.text}</pre></dd></>}
      {computer.key !== undefined && <><dt>{copy.approvalKeyName}</dt><dd><code>{computer.key}</code></dd></>}
      {computer.action === "scroll" && <><dt>{copy.approvalScrollBy}</dt><dd><code>{computer.dx ?? 0}, {computer.dy ?? 0}</code></dd></>}
    </dl>
    <p role="note">{copy.approvalNote}</p>
  </section>;
}
