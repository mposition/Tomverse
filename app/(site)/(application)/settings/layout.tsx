import type { ReactNode } from "react";
import { SettingsExitBar } from "@/components/settings/SettingsExitBar";

/**
 * Route shell for every /settings/** screen.
 *
 * The way out of settings is a property of *being in settings*, not of any one
 * page, so it is rendered once here rather than pasted into each detail
 * component. That is also what makes it hold for screens nobody has written
 * yet: a new segment under this folder is inside this layout by construction
 * and gets the exit control without touching anything.
 *
 * The page chrome (full-height ground, surface colours) moved here with it.
 * Each page used to declare `min-h-dvh` on its own `<main>`; with a strip
 * above them that would have made every settings page one strip taller than
 * the viewport, so the height now belongs to the column that contains both.
 */
export default function SettingsLayout({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <div className="flex min-h-dvh flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <SettingsExitBar />
            <div className="flex-1">{children}</div>
        </div>
    );
}
