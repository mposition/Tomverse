"use client";

/**
 * An on/off setting, drawn as a switch.
 *
 * It is a native checkbox underneath (screen readers and `getByRole("checkbox")`
 * both find it by its label), with the track and knob painted over it. The
 * track is chosen from `checked` rather than from a `peer-checked:` variant so
 * the solid emerald step carries the plain `bg-emerald-500` class: the Light
 * theme keeps white on exactly those classes, which keeps the knob white there.
 */
export function AdminSwitch({
  label,
  checked,
  onChange,
  disabled = false,
  className = "",
}: {
  label: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={`relative flex min-h-8 w-full cursor-pointer items-center justify-between gap-3 text-sm text-zinc-200 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${className}`}
    >
      <span className="min-w-0">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        // Covers the whole row, invisibly: a 1px sr-only input sat under the
        // label text, so a pointer (and Playwright's check()) hit the text
        // instead of the control.
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-400 ${
          checked ? "bg-emerald-500" : "bg-zinc-600"
        }`}
      >
        <span
          className={`absolute left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </label>
  );
}
