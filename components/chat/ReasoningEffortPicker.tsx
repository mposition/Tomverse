import { Layers, Scale, Zap } from "lucide-react";
import Image from "next/image";
import { useId } from "react";
import type { ExplicitReasoningEffort, ReasoningEffort } from "@/lib/reasoningEffort";
import type { ReasoningEffortCopy } from "@/lib/reasoningEffortCopy";

const levels = ["low", "default", "high"] as const;
const optionIcons = { low: Zap, default: Scale, high: Layers };

type Props = {
  copy: ReasoningEffortCopy;
  value: ReasoningEffort;
  onChange: (level: ReasoningEffort) => void;
  supportsEffort: (level: ExplicitReasoningEffort) => boolean;
  note?: string;
};

export function ReasoningEffortPicker({ copy, value, onChange, supportsEffort, note }: Props) {
  const id = useId();
  const unavailable = !supportsEffort("low") && !supportsEffort("high");
  const footer = unavailable ? copy.unavailable : note;

  return (
    <div className="mx-1 mb-3 min-w-0 shrink-0">
      <fieldset
        data-testid="model-picker-reasoning-effort"
        aria-describedby={`${id}-hint${footer ? ` ${id}-note` : ""}`}
        className="min-w-0 rounded-[13px] bg-[#eef1f8] p-2.5 dark:bg-[#18191f]"
      >
        <legend className="sr-only">{copy.title}</legend>
        <div className="mb-2.5 px-0.5">
          <p aria-hidden="true" className="text-sm font-bold text-[#192036] dark:text-[#f1f3fa]">{copy.title}</p>
          <p id={`${id}-hint`} className="mt-0.5 text-[0.6875rem] leading-snug text-[#52627e] dark:text-[#c1c6d6]">
            {copy.preferenceHint}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {levels.map((level) => {
            const [label, detail] = copy.options[level];
            const selected = value === level;
            const levelId = `${id}-${level}`;
            const Icon = optionIcons[level];
            return (
              <label key={level} className="relative min-w-0">
                <input
                  type="radio"
                  name={id}
                  value={level}
                  checked={selected}
                  disabled={level !== "default" && !supportsEffort(level)}
                  onChange={() => onChange(level)}
                  aria-labelledby={`${levelId}-label`}
                  aria-describedby={`${levelId}-detail`}
                  className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-default"
                />
                <span className={`relative flex h-full min-h-[78px] flex-col rounded-[10px] border px-2 py-2.5 text-left peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#354bd0] peer-disabled:opacity-50 sm:px-[11px] dark:peer-focus-visible:outline-[#b9c3ff] ${
                  selected
                    ? "border-[#7e8df1] bg-[#eef0ff] dark:border-[#8c9afa] dark:bg-[#252945]"
                    : "border-[#dde3f0] bg-white dark:border-[#363948] dark:bg-[#21232c]"
                }`}>
                  <Icon aria-hidden="true" className="mb-1.5 size-3.5 shrink-0 text-[#354bd0] dark:text-[#b9c3ff]" />
                  {selected && (
                    <span aria-hidden="true" className="absolute right-2 top-2.5 sm:right-2.5">
                      <Image src="/reasoning-effort/selected-light.svg" width={15} height={15} alt="" unoptimized className="block dark:hidden" />
                      <Image src="/reasoning-effort/selected-dark.svg" width={15} height={15} alt="" unoptimized className="hidden dark:block" />
                    </span>
                  )}
                  <span id={`${levelId}-label`} className="break-words text-[0.8125rem] font-bold leading-tight text-[#192036] dark:text-[#f1f3fa]">
                    {label}
                  </span>
                  <span id={`${levelId}-detail`} className="mt-1 break-words text-[0.6875rem] leading-snug text-[#52627e] dark:text-[#c1c6d6]">
                    {detail}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {footer && (
        <p id={`${id}-note`} className="mt-2 px-0.5 text-[0.6875rem] leading-snug text-[#52627e] dark:text-[#c1c6d6]">
          {footer}
        </p>
      )}
    </div>
  );
}
