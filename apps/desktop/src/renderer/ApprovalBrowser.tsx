import type { ApprovalRequest } from "../contract";
import type { desktopCodeEngineCopy } from "../../../../locales/desktopCodeEngine";

type EngineCopy = (typeof desktopCodeEngineCopy)[keyof typeof desktopCodeEngineCopy];

/** What the agent would click or type in the browser tab: the site, the page, the element, and the exact text. */
export function ApprovalBrowser({ browser, copy }: { browser: NonNullable<ApprovalRequest["browser"]>; copy: EngineCopy }) {
  const heading = browser.action === "click" ? copy.approvalBrowserClick : copy.approvalBrowserType;
  return <section aria-label={heading}>
    <h2>{heading}</h2>
    <dl>
      <dt>{copy.approvalBrowserSite}</dt><dd><code>{browser.origin}</code></dd>
      <dt>{copy.approvalBrowserPage}</dt><dd><code>{browser.url}</code></dd>
      <dt>{copy.approvalBrowserElement}</dt><dd><code>{browser.selector}</code></dd>
      {browser.text !== undefined && <><dt>{copy.approvalBrowserText}</dt><dd><pre>{browser.text}</pre></dd></>}
    </dl>
    {browser.clear && <p role="note">{copy.approvalBrowserClear}</p>}
    {browser.submit && <p role="note">{copy.approvalBrowserSubmit}</p>}
    <p role="note">{copy.approvalBrowserNote}</p>
  </section>;
}
