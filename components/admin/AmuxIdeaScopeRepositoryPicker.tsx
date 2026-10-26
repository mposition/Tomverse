"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import {
  pickedScopeRepositories, scopeRepositoryBlock, type ScopeRepositoryRead,
} from "@/lib/amux/ideaScopeRepositoryPickCore";

const SETTINGS_HREF = "/admin/amux-settings?tab=analysis";
const linkClass = "inline-flex min-h-11 items-center font-medium text-blue-300 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";

/**
 * The repositories of the Admin operating scope as a checklist, all selected by
 * default. Presentational: the panel owns the read and the selection, and closes
 * saving with the same `scopeRepositoryBlock` this shows the reason for.
 */
export function AmuxIdeaScopeRepositoryPicker({ read, deselected, disabled, onToggle, stepUpHref }: {
  read: ScopeRepositoryRead; deselected: readonly string[]; disabled: boolean;
  onToggle: (repository: string, checked: boolean) => void; stepUpHref: string;
}) {
  const messages = useAdminMessages(adminAmuxIdeaInputMessages);
  const picked = pickedScopeRepositories(read, deselected);
  const block = scopeRepositoryBlock(read, picked);
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm border-zinc-800"
      data-testid="amux-idea-scope-repositories">
      <legend className="px-1 font-medium">{messages.scopeReposLabel}</legend>
      {read.kind === "ready" ? (
        <>
          <p className="text-xs leading-5 text-zinc-400">{messages.scopeReposHint}</p>
          <ul className="flex flex-col">
            {read.repositories.map((repository) => (
              <li key={repository}>
                <label className="flex min-h-11 items-center gap-3 font-mono text-zinc-100">
                  <input type="checkbox" className="size-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300"
                    checked={!deselected.includes(repository)} value={repository}
                    onChange={(event) => onToggle(repository, event.target.checked)} />
                  <span className="min-w-0 break-all">{repository}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {block === "loading" ? <p role="status" className="text-zinc-400">{messages.scopeReposLoading}</p> : null}
      {block === "none" ? <p role="alert" className="text-amber-200">{messages.scopeReposNone}</p> : null}
      {block === "unavailable" ? <p role="alert" className="text-amber-200">{messages.scopeReposUnavailable}</p> : null}
      {block === "empty" ? <p role="alert" className="text-amber-200">{messages.scopeReposEmptySelection}</p> : null}
      {block === "none" || block === "unavailable" ? (
        <div className="flex flex-wrap gap-x-4">
          <Link href={SETTINGS_HREF} className={linkClass}>{messages.scopeReposSettingsLink}</Link>
          {read.kind === "error" && read.reauth ? <a href={stepUpHref} className={linkClass}>{messages.stepUp}</a> : null}
        </div>
      ) : null}
    </fieldset>
  );
}
