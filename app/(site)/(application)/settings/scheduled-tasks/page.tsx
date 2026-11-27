export const dynamic = "force-dynamic";

import { ScheduledTasksSettings } from "@/components/scheduledTasks/ScheduledTasksSettings";

// Route shell only. Whether the feature is open, the account's plan and the
// tasks themselves come from /api/scheduled-tasks, which is also the session probe.
export default function ScheduledTasksSettingsPage() {
  return (
    <main>
      <ScheduledTasksSettings />
    </main>
  );
}
