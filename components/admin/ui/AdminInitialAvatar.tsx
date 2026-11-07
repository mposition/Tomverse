// Solid 500-600 steps: the Light theme keeps white text on these.
const PALETTE = [
  "bg-teal-600",
  "bg-indigo-500",
  "bg-pink-500",
  "bg-violet-500",
  "bg-orange-500",
  "bg-emerald-600",
  "bg-blue-600",
] as const;

/** Up to two initials, or "?" when there is nothing to take them from. */
export function adminInitials(name: string | null | undefined, email: string | null | undefined): string {
  const source = (name || "").trim() || (email || "").trim();
  if (!source) return "?";
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  const letters =
    words.length >= 2 && (name || "").trim()
      ? [Array.from(words[0])[0], Array.from(words[1])[0]]
      : Array.from(words[0] || source).slice(0, 2);
  return letters.join("").toUpperCase();
}

/** A round avatar of initials; the colour follows the id so a person keeps theirs. */
export function AdminInitialAvatar({
  id,
  name,
  email,
  size = "md",
}: {
  id: string;
  name?: string | null;
  email?: string | null;
  size?: "md" | "lg";
}) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${
        PALETTE[hash % PALETTE.length]
      } ${size === "lg" ? "h-16 w-16 text-2xl" : "h-10 w-10 text-sm"}`}
    >
      {adminInitials(name, email)}
    </span>
  );
}
