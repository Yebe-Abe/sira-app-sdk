#!/usr/bin/env node
// §5 — Android MediaProjection consent dialog. Captures the dialog,
// OCRs to verify our priming-screen copy still matches, then drives
// either the success path or the entire-screen refusal recovery path.

const fs = require("node:fs");
const { execSync } = require("node:child_process");
const path = require("node:path");
const { startSession } = require("./_lib");

const PRIMING_PHRASES = ["A single app", "Entire screen", "Start now"];
const PATH = process.env.DIALOG_PATH; // "single-app" | "entire-screen-refused"
const SERVER = process.env.SIRA_SERVER_URL;

async function main() {
  const driver = await startSession({
    deviceName: process.env.DEVICE_NAME,
    deviceOs: "android",
    deviceVersion: process.env.DEVICE_VERSION,
    sessionName: `dialog-${PATH}`,
  });

  try {
    const r = await fetch(`${SERVER}/admin/test-session`, { method: "POST" });
    const { sessionId, code } = await r.json();

    await (await driver.$("~sira-help-button")).click();
    await (await driver.$("~sira-code-input")).setValue(code);
    await (await driver.$("//*[@text='Connect']")).click();
    await (await driver.$("//*[@text='Continue']")).click();
    await driver.pause(2500);

    // Capture the OS dialog screenshot for OCR.
    const png = await driver.takeScreenshot();
    fs.mkdirSync("ci/artifacts", { recursive: true });
    const screenshotPath = `ci/artifacts/dialog-${process.env.DEVICE_NAME.replace(/\s+/g, "_")}.png`;
    fs.writeFileSync(screenshotPath, Buffer.from(png, "base64"));
    const ocr = execSync(`tesseract "${screenshotPath}" - --psm 6 -l eng 2>/dev/null`, { encoding: "utf8" });

    const missing = PRIMING_PHRASES.filter((p) => !ocr.includes(p));
    if (missing.length > 0) {
      console.warn(`! priming copy may be stale; OS dialog missing: ${missing.join(", ")}`);
      console.warn(`  raw OCR:\n${ocr}`);
    }

    if (PATH === "single-app") {
      const single = await driver.$("//*[contains(@text,'A single app')]");
      await single.click();
      await driver.pause(1500);
      const harness = await driver.$("//*[contains(@text,'harness')]");
      await harness.click();
      const start = await driver.$("//*[@text='Start now' or @text='Start']");
      await start.click();
      await (await driver.$("~sira-end-button")).waitForDisplayed({ timeout: 15000 });
      console.log("✓ single-app path completed; session live");
    } else {
      const entire = await driver.$("//*[contains(@text,'Entire screen')]");
      await entire.click();
      const start = await driver.$("//*[@text='Start now' or @text='Start']");
      await start.click();
      // Recovery screen should appear within ~3s
      const tryAgain = await driver.$("//*[@text='Try Again']");
      await tryAgain.waitForDisplayed({ timeout: 8000 });
      console.log("✓ entire-screen refusal triggered recovery screen");
    }
  } finally {
    await driver.deleteSession();
  }
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
