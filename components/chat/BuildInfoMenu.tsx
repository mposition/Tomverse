"use client";

import { useState } from "react";
import { GitCommitHorizontal, Copy } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { buildInfoCopy } from "@/components/chat/buildInfoCopy";
import { useBuildInfo } from "@/lib/useBuildInfo";
import { dispatchAppToast } from "@/lib/appToast";

// STG-F010: lets a user or QA tester confirm which commit/deployment is
// actually running, without logging in. Renders inline inside the existing
// sidebar help menu (ChatSidebar.tsx) rather than a second floating
// popover, so Escape/outside-click/focus-trap behavior is inherited for
// free from that menu instead of needing its own.

const buildCopyText = (
  info: NonNullable<ReturnType<typeof useBuildInfo>>,
  copy: (typeof buildInfoCopy)["en"]
) => {
  const notAvailable = copy.notAvailable;
  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}${window.location.pathname}`
      : "";
  return [
    `Environment: ${info.environment}`,
    `Commit: ${info.commitSha || notAvailable}`,
    `Built: ${info.builtAt || notAvailable}`,
    `Deployment started: ${info.deploymentStartedAt || notAvailable}`,
    `Deployment completed: ${info.deployedAt || notAvailable}`,
    `Deployment: ${info.deploymentId || notAvailable}`,
    `Deployment status: ${copy.deploymentStatusNames[info.deploymentStatus] || notAvailable}`,
    url ? `URL: ${url}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};

export function BuildStagingBadge() {
  const buildInfo = useBuildInfo();
  const { lang } = useLanguage();
  if (buildInfo?.environment !== "staging") return null;
  return (
    <span
      data-testid="build-staging-badge"
      className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
    >
      {buildInfoCopy[lang].environmentNames.staging}
    </span>
  );
}

export function BuildInfoMenuItem({
  menuItemClassName,
  iconClassName,
}: {
  menuItemClassName: string;
  iconClassName: string;
}) {
  const buildInfo = useBuildInfo();
  const { lang } = useLanguage();
  const copy = buildInfoCopy[lang];
  const [isExpanded, setIsExpanded] = useState(false);

  const handleCopy = async () => {
    if (!buildInfo) return;
    try {
      await navigator.clipboard.writeText(buildCopyText(buildInfo, copy));
      dispatchAppToast(copy.copySuccess, "success");
    } catch {
      dispatchAppToast(copy.copyFailure, "error");
    }
  };

  return (
    <>
      <button
        type="button"
        role="menuitem"
        data-testid="sidebar-build-info-toggle"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((current) => !current)}
        className={menuItemClassName}
      >
        <GitCommitHorizontal className={iconClassName} aria-hidden="true" />
        {copy.menuLabel}
        {buildInfo?.shortCommitSha && (
          <span className="ml-auto font-mono text-[11px] font-normal text-zinc-400">
            {buildInfo.shortCommitSha}
          </span>
        )}
      </button>
      {isExpanded && (
        <div
          data-testid="build-info-panel"
          className="mx-1 mb-1 rounded-xl bg-zinc-100 p-3 text-xs dark:bg-zinc-950"
        >
          <dl className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <dt className="font-bold text-zinc-500">{copy.environmentLabel}</dt>
              <dd className="font-semibold text-zinc-800 dark:text-zinc-100">
                {buildInfo
                  ? copy.environmentNames[buildInfo.environment]
                  : copy.notAvailable}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="font-bold text-zinc-500">{copy.commitLabel}</dt>
              <dd
                className="font-mono text-zinc-800 dark:text-zinc-100"
                title={buildInfo?.commitSha || undefined}
              >
                {buildInfo?.shortCommitSha || copy.notAvailable}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="font-bold text-zinc-500">{copy.builtLabel}</dt>
              <dd className="text-zinc-800 dark:text-zinc-100">
                {buildInfo?.builtAt || copy.notAvailable}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="font-bold text-zinc-500">{copy.deploymentStartedLabel}</dt>
              <dd className="text-zinc-800 dark:text-zinc-100">
                {buildInfo?.deploymentStartedAt || copy.notAvailable}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="font-bold text-zinc-500">{copy.deployedLabel}</dt>
              <dd className="text-zinc-800 dark:text-zinc-100">
                {buildInfo?.deployedAt || copy.notAvailable}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="font-bold text-zinc-500">{copy.deploymentLabel}</dt>
              <dd
                className="max-w-[9rem] truncate font-mono text-zinc-800 dark:text-zinc-100"
                title={buildInfo?.deploymentId || undefined}
              >
                {buildInfo?.deploymentId || copy.notAvailable}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="font-bold text-zinc-500">{copy.deploymentStatusLabel}</dt>
              <dd className="text-zinc-800 dark:text-zinc-100">
                {buildInfo
                  ? copy.deploymentStatusNames[buildInfo.deploymentStatus]
                  : copy.notAvailable}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            data-testid="build-info-copy-button"
            onClick={() => void handleCopy()}
            disabled={!buildInfo}
            className="mt-2.5 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white text-xs font-bold text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {copy.copyButton}
          </button>
        </div>
      )}
    </>
  );
}
