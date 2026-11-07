"use client";

import { useRouter } from "next/navigation";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { adminFeedbackInboxMessages } from "@/lib/adminMessages/feedbackInbox";

/**
 * What a Support tab shows when its server read failed. The page is a server
 * component and cannot hand a retry function down, so the retry lives here: it
 * asks the server to render the page again. The failure is never drawn as an
 * empty list, which would hide a customer who is waiting.
 */
export function SupportReadFailedBlock({ read }: { read: "inquiries" | "autofix" }) {
  const m = useAdminMessages(adminFeedbackInboxMessages);
  const router = useRouter();
  return (
    <div data-testid="support-read-failed" data-read={read}>
      <AdminStateBlock
        kind="error"
        title={read === "autofix" ? m.autoFix.readFailedTitle : m.readFailedTitle}
        detail={read === "autofix" ? m.autoFix.readFailedDetail : m.readFailedDetail}
        onRetry={() => router.refresh()}
      />
    </div>
  );
}
