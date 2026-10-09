import styles from "@/components/admin/agentOffice.module.css";

/**
 * Class names for the Agent office, written as the original UI wrote them.
 *
 * The stylesheet is a CSS Module so it cannot leak into the console, which
 * hashes every class. `cx("win rail-card")` maps each name to its hashed
 * form, so the markup -- and the paint loop that rewrites `className` sixty
 * times a second -- keeps the original names.
 */
const map = styles as Record<string, string>;

export const cx = (...names: (string | false | null | undefined)[]) =>
  names
    .flatMap((name) => (name ? name.split(/\s+/) : []))
    .filter(Boolean)
    .map((name) => map[name] ?? name)
    .join(" ");
