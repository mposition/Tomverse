/**
 * An on/off switch for a setting, drawn over a real checkbox.
 *
 * The input is still an `<input type="checkbox">` (with `role="switch"`), so it
 * submits, focuses, toggles with Space and reads "on"/"off" to a screen reader
 * exactly as a checkbox does; only its look changed. `label` is its accessible
 * name. Colours are palette classes so the Light theme can remap them; the knob
 * is white in both themes, which a palette class cannot say (white is remapped
 * in Light), hence the inline style.
 */
export function AdminToggleSwitch({
  checked,
  onChange,
  label,
  disabled,
  className = "",
  ...rest
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The accessible name; say what the switch controls. */
  label: string;
  disabled?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "role" | "checked" | "onChange" | "aria-label">) {
  return (
    <span className={`relative inline-flex h-6 w-11 shrink-0 ${className}`}>
      <input
        {...rest}
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-zinc-600 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 peer-disabled:opacity-50"
      />
      <span
        aria-hidden
        style={{ backgroundColor: "#fff" }}
        className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full shadow transition-transform peer-checked:translate-x-5 peer-disabled:opacity-80"
      />
    </span>
  );
}
