import { expect, test, type Page } from "@playwright/test";
import { selectProduct } from "./workspaceNavigation";

type HeldUpload = { name: string; resolve: () => void; reject: () => void };
const uploads = (page: Page, index: number, outcome: "resolve" | "reject" = "resolve") => page.evaluate(({ index, outcome }) => {
  (window as unknown as { heldUploads: HeldUpload[] }).heldUploads[index][outcome]();
}, { index, outcome });

async function open(page: Page, language = "en") {
  await page.addInitScript(language => localStorage.setItem("tomverse-language", language), language);
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const fixture = `window.heldUploads=[];const upload=transport.upload;transport.upload=async file=>{await new Promise((resolve,reject)=>window.heldUploads.push({name:file.name,resolve,reject:()=>reject(Error('Upload unavailable'))}));return upload(file);};`;
    await route.fulfill({ response, body: (await response.text()).replace("createRoot(container).render(", fixture + "createRoot(container).render(") });
  });
  await page.goto("/");
  await page.locator(".welcome .primary").click();
  await expect(page.getByRole("textbox")).toBeEnabled();
}

for (const product of ["chat", "review"] as const) test(`${product} shows the active file and real completed count until all uploads finish`, async ({ page }) => {
  await open(page);
  if (product === "review") await selectProduct(page, product);
  await page.getByRole("textbox").fill("Keep this draft while attaching");
  await page.getByTestId("file-picker").setInputFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic file") },
    { name: "second.pdf", mimeType: "application/pdf", buffer: Buffer.from("Synthetic PDF") },
  ]);
  const modal = page.getByRole("dialog", { name: "Uploading files", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.locator(".upload-progress-name")).toHaveText("first.txt");
  await expect(modal.getByRole("status")).toHaveText("0 / 2 complete");
  await expect(modal.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await uploads(page, 0);
  await expect(modal.locator(".upload-progress-name")).toHaveText("second.pdf");
  await expect(modal.getByRole("status")).toHaveText("1 / 2 complete");
  await uploads(page, 1);
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("Keep this draft while attaching");
  await expect(page.getByRole("button", { name: "Remove attachment: first.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove attachment: second.pdf" })).toBeVisible();
  await expect(page.locator("article.user")).toHaveCount(0);
});

test("failure closes the modal, retains completed files and allows selecting the failed file again", async ({ page }) => {
  await open(page);
  const file = { name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic retry") };
  await page.getByTestId("file-picker").setInputFiles([
    { ...file, name: "saved.txt" }, file,
  ]);
  await expect(page.getByRole("dialog")).toBeVisible();
  await uploads(page, 0);
  await expect(page.locator(".upload-progress-name")).toHaveText("retry.txt");
  await uploads(page, 1, "reject");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove attachment: saved.txt" })).toBeVisible();
  await page.getByTestId("file-picker").setInputFiles(file);
  await expect(page.getByRole("dialog")).toBeVisible();
  await uploads(page, 2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove attachment: retry.txt" })).toBeVisible();
});

for (const theme of ["light", "dark"]) test(`${theme} photo uploads use the selected modal and respect reduced motion`, async ({ page }) => {
  await open(page, "ko");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  await page.getByTestId("photo-picker").setInputFiles({ name: "현장사진.png", mimeType: "image/png", buffer: Buffer.alloc(1024) });
  const modal = page.getByRole("dialog", { name: "파일 업로드 중", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.locator(".upload-progress-size")).toHaveText("1.0 KB");
  await expect(modal).toContainText("완료되면 자동으로 닫힙니다.");
  expect(await modal.locator(".upload-progress-spinner").evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  expect(await modal.locator(".upload-progress-track span").evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  await uploads(page, 0);
  await expect(modal).toHaveCount(0);
});

test("long names fit a narrow viewport at 200% text scale without horizontal clipping", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await open(page, "de");
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  await page.getByTestId("file-picker").setInputFiles({ name: "A-very-long-filename-without-spaces-to-preserve-readable-layout.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic") });
  const modal = page.getByRole("dialog", { name: "Dateien werden hochgeladen" });
  await expect(modal).toBeVisible();
  expect(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await expect(modal.getByRole("heading")).toHaveCSS("font-size", "40px");
  await uploads(page, 0);
  await expect(modal).toHaveCount(0);
});

for (const [language, title] of [["zh", "正在上传文件"], ["fr", "Envoi des fichiers"], ["es", "Subiendo archivos"], ["pt", "Enviando arquivos"]]) test(`upload feedback follows the ${language} app language`, async ({ page }) => {
  await open(page, language);
  await page.getByTestId("file-picker").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic") });
  const modal = page.getByRole("dialog", { name: title, exact: true });
  await expect(modal).toBeVisible();
  await uploads(page, 0);
  await expect(modal).toHaveCount(0);
});
