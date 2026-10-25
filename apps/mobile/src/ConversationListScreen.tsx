import type { ReactNode } from "react";

export function ConversationListScreen({ title, newLabel, disabled, onNew, footer, children }: {
  title: string; newLabel: string; disabled: boolean; onNew: () => void; footer?: ReactNode; children: ReactNode;
}) {
  return <section className="conversation-list"><div className="history-scroll">
    <div className="list-heading"><h1>{title}</h1><button className="primary" disabled={disabled} onClick={onNew}>{newLabel} <span aria-hidden="true">+</span></button></div>
    {children}
  </div>{footer}</section>;
}
