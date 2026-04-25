#!/usr/bin/env node
// §3 redaction. For each sensitive screen, navigate the harness via
// deeplink, capture the dashboard-side frame, save to OUT_DIR for
// downstream Tesseract OCR + grep.

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");
const { startSession } = require("./_lib");

const SERVER = process.env.SIRA_SERVER_URL;
const OUT = process.env.OUT_DIR || "redaction-frames";
const TARGETS = yaml.parse(fs.readFileSync(path.join(__dirname, "..", "redaction-targets.yaml"), "utf8"));

async function generate() {
  const r = await fetch(`${SERVER}/admin/test-session`, { method: "POST" });
  return r.json();
}

async function pullLatestFrame(sessionId) {
  const r = await fetch(`${SERVER}/admin/test-session/${sessionId}/latest.webp`);
  if (!r.ok) throw new Error(`no frame yet (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const platform = process.env.PLATFORM;
  const driver = await startSession({
    deviceName: platform === "ios" ? "iPhone 15" : "Google Pixel 8",
    deviceOs: platform,
    deviceVersion: platform === "ios" ? "17" : "14.0",
    sessionName: `redaction-${platform}`,
  });

  try {
    const { sessionId, code } = await generate();

    const trigger = await driver.$("~sira-help-button");
    await trigger.waitForDisplayed({ timeout: 8000 }); await trigger.click();
    const input = await driver.$("~sira-code-input");
    await input.setValue(code);
    await (await driver.$("//*[@text='Connect']")).click();
    if (platform === "android") {
      await (await driver.$("//*[@text='Continue']")).click();
      await (await driver.$("//*[@text='Start now' or @text='Start']")).click();
    }
    await (await driver.$("~sira-end-button")).waitForDisplayed({ timeout: 15000 });

    for (const screen of TARGETS.screens) {
      const url = `harness://goto/${screen}`;
      if (platform === "ios") {
        await driver.execute("mobile: deepLink", { url, bundleId: "com.sira.harness" });
      } else {
        await driver.execute("mobile: deepLink", { url, package: "com.sira.harness" });
      }
      await driver.pause(2500);
      const buf = await pullLatestFrame(sessionId);
      fs.writeFileSync(path.join(OUT, `${platform}-${screen}.webp`), buf);
      console.log(`captured ${platform}-${screen}.webp (${buf.length} bytes)`);
    }
  } finally {
    await driver.deleteSession();
  }
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
