const key = "tomverse-offline-draft";
const input = document.getElementById("draft");
const status = document.getElementById("status");
try { input.value = sessionStorage.getItem(key) || ""; } catch { status.textContent = "Draft storage is unavailable. Keep this page open."; }
input.addEventListener("input", () => {
  try { sessionStorage.setItem(key, input.value); status.textContent = "Draft saved in this tab."; }
  catch { status.textContent = "Draft storage is unavailable. Keep this page open."; }
});
document.getElementById("clear").addEventListener("click", () => { input.value = ""; try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ } status.textContent = "Draft discarded."; });
