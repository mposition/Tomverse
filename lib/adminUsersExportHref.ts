/**
 * The download address of the Users CSV for a search and group. A read-only
 * GET; kept out of the panel so the panel names no route that can answer 409
 * or 428 (it calls none), which the refusal sweep in
 * tests/adminReauthenticationCta.test.mjs reads from the panel's source.
 */
export const adminUsersExportHref = (query: string, segment: string) =>
  `/api/admin/users/export?q=${encodeURIComponent(query)}&segment=${encodeURIComponent(segment)}`;
