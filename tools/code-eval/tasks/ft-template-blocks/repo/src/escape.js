const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => MAP[ch]);
}
