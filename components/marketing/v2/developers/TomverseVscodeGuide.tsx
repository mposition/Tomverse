"use client";

import { ArrowUpRight, Paperclip } from "lucide-react";
import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";
import { editorExtensionsCopy, vscodeGuideCopy } from "@/locales/developerTools";

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

const editorInstallations = [
    { id: "vscode", title: "Tomverse for VS Code", href: "https://marketplace.visualstudio.com/items?itemName=Tomverse.tomverse-vscode" },
    { id: "visualStudio", title: "Tomverse for Visual Studio", href: "https://marketplace.visualstudio.com/items?itemName=Tomverse.tomverseforvs" },
] as const;

export function TomverseVscodeGuide() {
    const { lang } = useLanguage();
    const copy = vscodeGuideCopy[lang];
    const extensions = editorExtensionsCopy[lang];

    return (
        <section className="chapter vsc-extensions" id="editor-extensions" aria-labelledby="editor-extensions-title" data-testid="editor-extensions">
            <div className="wrap">
                <div className="chapter-head vsc-head">
                    <div>
                        <span className="eyebrow">{extensions.menuTitle}</span>
                        <h2 id="editor-extensions-title">{copy.title[0]} <em>{copy.title[1]}</em></h2>
                    </div>
                    <p className="vsc-intro-desktop">{extensions.description}</p>
                    <p className="vsc-intro-mobile">{extensions.mobileDescription}</p>
                </div>

                <div className="vsc-install-grid">
                    {editorInstallations.map(({ id, title, href }) => {
                        const [requirements, install, open] = extensions[id];
                        return (
                            <article className="vsc-install-card" key={id} aria-labelledby={`${id}-install-title`}>
                                <div>
                                    <h3 id={`${id}-install-title`}>{title}</h3>
                                    <p className="vsc-install-target">{requirements}</p>
                                </div>
                                <div className="vsc-install-instructions">
                                    <p>{install}</p>
                                    <p>{open}</p>
                                </div>
                                <a className="btn vsc-marketplace-action" href={href} aria-labelledby={`${id}-install-action ${id}-install-title`}>
                                    <span id={`${id}-install-action`}>{extensions.installAction}</span>
                                    <ArrowUpRight aria-hidden="true" size={15} />
                                </a>
                            </article>
                        );
                    })}
                </div>

                <div className="vsc-install-footer">
                    <p>{extensions.sharedKey}</p>
                    <Link className="vsc-key-action" href="/settings/api">
                        {copy.createKey}
                        <ArrowUpRight aria-hidden="true" size={14} />
                    </Link>
                </div>

                <section className="vsc-guide-section" id="tomverse-vscode" aria-labelledby="tomverse-vscode-title" data-testid="tomverse-vscode-guide">
                    <h3 id="tomverse-vscode-title">{extensions.guideTitle}</h3>
                    <div className="cli vsc-layout">
                        <EditorMockup copy={copy.mock} />
                        <div className="vsc-guide">
                            <ol className="cli-steps vsc-steps" role="list">
                                {copy.steps.map(([title, body], index) => (
                                    <li key={title}>
                                        <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                                        <div><h4>{title}</h4><p>{body}</p></div>
                                    </li>
                                ))}
                            </ol>
                            <div className="vsc-support">
                                <h4>{copy.supportTitle}</h4>
                                <ul>{copy.support.map((label, index) => <li className="pill vsc-pill" data-tone={supportTones[index]} key={label}>{label}</li>)}</ul>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </section>
    );
}
