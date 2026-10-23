const key = "tomverse-offline-draft";
const ownerKey = "tomverse-offline-owner";
let owner = null;
try { owner = sessionStorage.getItem(ownerKey); } catch { /* Storage may be unavailable. */ }
const input = document.getElementById("draft");
const status = document.getElementById("status");
try { let record = null; try { record = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { sessionStorage.removeItem(key); } input.value = owner && record?.owner === owner && typeof record.text === "string" ? record.text : ""; } catch { status.textContent = "Draft storage is unavailable. Keep this page open."; }
input.addEventListener("input", () => {
  try { if (!owner) throw Error("An online session is required before saving offline drafts."); sessionStorage.setItem(key, JSON.stringify({ owner, text: input.value })); status.textContent = "Draft saved in this tab."; }
  catch { status.textContent = "Draft storage is unavailable. Keep this page open."; }
});
document.getElementById("clear").addEventListener("click", () => { input.value = ""; try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ } status.textContent = "Draft discarded."; });
