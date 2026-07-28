import type { HTMLAttributes } from "react";

type CreditCoinIconProps = {
  className?: string;
};

export function CreditCoinIcon({ className = "h-3.5 w-3.5" }: CreditCoinIconProps) {
  return (
    <svg
      data-testid="credit-coin-icon"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10.25" fill="#F59E0B" stroke="#92400E" strokeWidth="1" />
      <circle cx="12" cy="12" r="8.25" fill="#FCD34D" stroke="#FDE68A" strokeWidth="1" />
      <circle cx="12" cy="12" r="7" fill="none" stroke="#D97706" strokeWidth="0.65" />
      <path
        d="M15.75 8.75a4.75 4.75 0 1 0 0 6.5"
        fill="none"
        stroke="#92400E"
        strokeWidth="2.35"
        strokeLinecap="round"
      />
      <path
        d="M15.35 9.25a4.05 4.05 0 1 0 0 5.5"
        fill="none"
        stroke="#FFF7D6"
        strokeWidth="0.75"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

type CreditCostBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  credits: number;
  label?: string;
  size?: "xs" | "sm" | "md";
  tone?: "default" | "onColor" | "plain";
  testId?: string;
  /**
   * Marks the number as an estimate rather than a settled price. Used where
   * the real cost scales with the request (e.g. a difference summary over
   * long answers), so a bare "1" would read as a guaranteed charge.
   */
  approximate?: boolean;
};

const sizeClasses = {
  // `xs` rides inside the comparison rail's two mobile actions at 320px, where
  // the label has no width to spare. Raising the text to the 11px floor is paid
  // for out of the badge's own padding, not out of the label beside it.
  xs: "gap-0.5 px-0.5 py-0.5 text-[11px] [&_svg]:h-3 [&_svg]:w-3",
  sm: "gap-1 px-2 py-1 text-[11px] [&_svg]:h-3.5 [&_svg]:w-3.5",
  md: "gap-1.5 px-2.5 py-1.5 text-xs [&_svg]:h-4 [&_svg]:w-4",
} as const;

const toneClasses = {
  default:
    "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/50 dark:text-amber-100",
  onColor: "border-white/20 bg-white/15 text-white",
  plain: "border-transparent bg-transparent text-amber-800 dark:text-amber-200",
} as const;

function formatCredits(credits: number) {
  if (!Number.isFinite(credits)) return "0";
  return Number.isInteger(credits)
    ? String(credits)
    : credits.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function CreditCostBadge({
  credits,
  label,
  size = "sm",
  tone = "default",
  testId = "credit-cost-badge",
  className = "",
  title,
  approximate = false,
  ...props
}: CreditCostBadgeProps) {
  const accessibleLabel =
    label ||
    (approximate
      ? `about ${formatCredits(credits)} credits`
      : `${formatCredits(credits)} credits`);

  return (
    <span
      {...props}
      data-testid={testId}
      data-approximate={approximate ? "true" : undefined}
      aria-label={accessibleLabel}
      title={title === undefined ? accessibleLabel : title}
      className={`inline-flex shrink-0 items-center justify-center rounded-full border font-bold tabular-nums leading-none ${sizeClasses[size]} ${toneClasses[tone]} ${className}`}
    >
      <CreditCoinIcon />
      {/*
        The numeral sits inside a coin-sized pill and is aria-hidden: the whole
        badge already carries "N credits" as its accessible name and its title.
        It is a deliberate exception to the 11px consumer-text floor (UI-007),
        marked so the audit can see it rather than infer it.
      */}
      <span aria-hidden="true" data-allow-small-text>
        {approximate ? "~" : ""}
        {formatCredits(credits)}
      </span>
    </span>
  );
}
