"use client";

import { Paperclip } from "lucide-react";
import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";
import { vscodeGuideCopy } from "@/locales/developerTools";

const diffLines = [
    { number: 12, kind: "context", text: "export function sum(xs: number[]) {" },
    { number: 13, kind: "removed", text: "  return xs.reduce((a, b) => a+b);" },
    { number: 13, kind: "added", text: "  if (!xs.length) return 0;" },
    { number: 14, kind: "added", text: "  return xs.reduce((a, b) => a+b, 0);" },
    { number: 15, kind: "context", text: "}" },
    { number: 16, kind: "context", text: "" },
    { number: 17, kind: "context", text: "export function mean(xs: number[]) {" },
    { number: 18, kind: "context", text: "  return sum(xs) / xs.length;" },
    { number: 19, kind: "context", text: "}" },
] as const;

const diffSigns = { context: "", removed: "−", added: "+" };
const supportTones = ["ok", "ok", "pending", "unsupported"] as const;

function EditorMockup({ copy }: { copy: (typeof vscodeGuideCopy)["en"]["mock"] }) {
    return (
        <div className="term dark-zone vsc-window" aria-hidden="true">
            <div className="console-bar"><i /><i /><i /><span>calc — Visual Studio Code</span></div>
            <div className="vsc-workbench">
                <div className="vsc-activity">
                    <i /><i /><i />
                    <span className="vsc-active-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" focusable="false">
                            <path fill="currentColor" d="M3 4h18v4h-7v12h-4V8H3z" />
                        </svg>
                    </span>
                </div>
                <div className="vsc-editor">
                    <div className="vsc-tabs">
                        <div className="vsc-tab"><span>calc.ts</span><span>{copy.proposal}</span></div>
                    </div>
                    <div className="vsc-diff">
                        {diffLines.map(({ number, kind, text }) => (
                            <div className="vsc-line" data-kind={kind} key={`${number}-${kind}`}>
                                <span>{number}</span><span>{diffSigns[kind]}</span><code>{text}</code>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="vsc-sidebar">
                    <div className="vsc-sidebar-title">Tomverse</div>
                    <div className="vsc-modes"><span>Ask</span><span>Agent</span></div>
                    <div className="vsc-model"><span>{copy.model}</span><span>{copy.effort} ▾</span></div>
                    <div className="vsc-selection"><Paperclip size={12} /><span>{copy.selection}</span></div>
                    <p className="vsc-prompt">{copy.prompt}</p>
                    <div className="vsc-change">
                        <div className="vsc-change-title">
                            <strong>{copy.change} · src/calc.ts</strong>
                            <span className="vsc-count"><b>+2</b> <b>−1</b></span>
                        </div>
                        <div className="vsc-decisions">
                            <span>{copy.once}</span><span>{copy.run}</span><span>{copy.deny}</span>
                        </div>
                    </div>
                    <p className="vsc-receipt">{copy.receipt}</p>
                </div>
            </div>
        </div>
    );
}

export function TomverseVscodeGuide() {
    const { lang } = useLanguage();
    const copy = vscodeGuideCopy[lang];
    return (
        <section className="chapter" id="tomverse-vscode" aria-labelledby="tomverse-vscode-label tomverse-vscode-title" data-testid="tomverse-vscode-guide">
            <div className="wrap">
                <div className="chapter-head vsc-head">
                    <div>
                        <span className="eyebrow" id="tomverse-vscode-label">Tomverse for VS Code</span>
                        <h2 id="tomverse-vscode-title">{copy.title[0]} <em>{copy.title[1]}</em></h2>
                    </div>
                    <div className="vsc-intro">
                        <span className="badge">RELEASE · v1.0.2</span>
                        <p>{copy.description}</p>
                    </div>
                </div>
                <div className="cli vsc-layout">
                    <EditorMockup copy={copy.mock} />
                    <div className="vsc-guide">
                        <ol className="cli-steps vsc-steps">
                            {copy.steps.map(([title, body], index) => (
                                <li key={title}>
                                    <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                                    <div><h3>{title}</h3><p>{body}</p></div>
                                </li>
                            ))}
                        </ol>
                        <div className="vsc-support">
                            <h3>{copy.supportTitle}</h3>
                            <ul>{copy.support.map((label, index) => <li className="pill vsc-pill" data-tone={supportTones[index]} key={label}>{label}</li>)}</ul>
                        </div>
                        <Link className="btn vsc-cta" href="/settings/api"><span>{copy.createKey}</span><span aria-hidden="true">↗</span></Link>
                        <p className="vsc-note">{copy.availability}</p>
                    </div>
                </div>
            </div>
        </section>
    );
}
