/**
 * The sections of a customer page, in order. Declared with the route table as
 * the `user-detail` entry's tabs (lib/adminNavigation.ts); this is the plain
 * list the server page and the client view both read. It lives outside the
 * client component because a server component cannot read a value exported
 * from a "use client" module -- it receives a reference, not the array.
 */
export const ADMIN_USER_DETAIL_TABS = ["overview", "billing", "security", "conversations", "notes"] as const;
export type AdminUserDetailTab = (typeof ADMIN_USER_DETAIL_TABS)[number];
