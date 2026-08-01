"use client";

import { useState } from "react";
import {
  AdminUserSecurityControls,
  toAdminSecurityUser,
  type AdminSecurityUser,
} from "@/components/admin/AdminUserSecurityControls";

/**
 * Reproduces exactly what AdminUsersPanel does around the security controls:
 * it owns the single-action lock, and on success it refetches the customer
 * detail so the new account state is what the operator sees.
 *
 * Only reachable from the Playwright fixture server (see the page component).
 */
export function AdminUserSecurityHarness({
  initialUser,
}: {
  initialUser: AdminSecurityUser;
}) {
  const [user, setUser] = useState(initialUser);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const response = await fetch(
      `/api/admin/users/${encodeURIComponent(user.id)}`,
      { cache: "no-store" }
    );
    const data = (await response.json().catch(() => null)) as
      | { user?: Parameters<typeof toAdminSecurityUser>[0] }
      | null;
    if (data?.user) setUser(toAdminSecurityUser(data.user));
  };

  return (
    <AdminUserSecurityControls
      user={user}
      busy={busy}
      onBusyChange={setBusy}
      onApplied={reload}
    />
  );
}
