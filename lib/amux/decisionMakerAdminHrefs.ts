/**
 * Where the AMUX Decision Maker lives in Admin. Plain values, importable by a
 * server page and by the client panels alike.
 */

/** Operations settings › Decision Maker: switches, the accuracy report and the request history. */
export const DM_ADMIN_REQUEST_LIST_HREF = "/admin/amux-settings?tab=decision-maker";

/**
 * One request, opened as a side panel over AMUX › Execution. The panel opens on
 * any Execution tab, so an operator who may judge but not see the Cards board
 * still reaches it (docs/ui-contracts/admin-console-ia.md: a section lives in
 * the query).
 */
export const DM_ADMIN_REQUEST_PANEL_PATH = "/admin/amux-execution";
export const dmAdminRequestDetailHref = (requestId: string) =>
  `${DM_ADMIN_REQUEST_PANEL_PATH}?dmRequest=${encodeURIComponent(requestId)}`;
