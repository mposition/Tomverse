"use client";

import { useId } from "react";

import {
  CONSENT_COPY_LANGUAGES,
  consentCopy,
  type ConsentCopyLanguage,
} from "@/lib/emailConsentCopy";

/**
 * The sign-up screen's consent devices: A, the unticked opt-in; B, the notice;
 * C, the separate refusal (docs/policy/email-product-news-redesign-draft.md
 * section 5.1; wording from lib/emailConsentCopy.ts, the approved version).
 *
 * Three independent states. A starts unticked and is never ticked for the
 * person; not ticking it is not a refusal, and C is its own control so that a
 * refusal can be expressed at all. Ticking one clears the other: they are two
 * answers to one question.
 */
export function SignupConsentDevices(props: {
  language: string;
  optIn: boolean;
  objected: boolean;
  onChange: (next: { optIn: boolean; objected: boolean }) => void;
}) {
  const id = useId();
  const language: ConsentCopyLanguage = (CONSENT_COPY_LANGUAGES as readonly string[]).includes(
    props.language
  )
    ? (props.language as ConsentCopyLanguage)
    : "en";
  const text = (key: "signupOptIn" | "signupNotice" | "signupRefuse") =>
    consentCopy(key, language) ?? consentCopy(key, "en") ?? "";

  return (
    <fieldset
      data-testid="signup-consent-devices"
      className="space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-left dark:border-zinc-800 dark:bg-zinc-950/60"
    >
      <label htmlFor={`${id}-optin`} className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          id={`${id}-optin`}
          type="checkbox"
          checked={props.optIn}
          onChange={(event) =>
            props.onChange({ optIn: event.target.checked, objected: event.target.checked ? false : props.objected })
          }
          data-testid="signup-consent-optin"
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-zinc-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-sm font-semibold leading-6 text-zinc-900 dark:text-zinc-100">
          {text("signupOptIn")}
        </span>
      </label>
      <p data-testid="signup-consent-notice" className="text-xs leading-5 text-zinc-600 dark:text-zinc-300">
        {text("signupNotice")}
      </p>
      <label htmlFor={`${id}-refuse`} className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          id={`${id}-refuse`}
          type="checkbox"
          checked={props.objected}
          onChange={(event) =>
            props.onChange({ optIn: event.target.checked ? false : props.optIn, objected: event.target.checked })
          }
          data-testid="signup-consent-refuse"
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-zinc-300 text-zinc-700 focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-sm leading-6 text-zinc-700 dark:text-zinc-200">{text("signupRefuse")}</span>
      </label>
    </fieldset>
  );
}
