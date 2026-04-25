#!/usr/bin/env node
// §3 redaction. For each sensitive screen, navigate the harness via
// deeplink, capture the dashboard-side frame via the in-process TestAgent,
// save to OUT_DIR for downstream Tesseract OCR + grep.

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");
const { TestAgent } = require("../test-agent");
const { startSession } = require("./_lib");

const SERVER = process.env.SIRA_SERVER_URL;
const TEST_KEY = process.env.SIRA_TEST_KEY;
const OUT = process.env.OUT_DIR || "redaction-frames";
const TARGETS = yaml.parse(fs.readFileSync(path.join(__dirname, "..", "redaction-targets.yaml"), "utf8"));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const platform = process.env.PLATFORM;

  const agent = new TestAgent({ serverUrl: SERVER, testKey: TEST_KEY });
  await agent.mintSession();

  const driver = await startSession({
    deviceName: platform === "ios" ? "iPhone 15" : "Google Pixel 8",
    deviceOs: platform,
    deviceVersion: platform === "ios" ? "17" : "14.0",
    sessionName: `redaction-${platform}`,
  });

  const agentReady = agent.start({ openTimeoutMs: 30_000 });

  try {
    await (await driver.$("~sira-help-button")).click();
    await (await driver.$("~sira-code-input")).setValue(agent.code);
    await (await driver.$("//*[@text='Connect']")).click();
    if (platform === "android") {
      await (await driver.$("//*[@text='Continue']")).click();
      await (await driver.$("//*[@text='Start now' or @text='Start']")).click();
    }
    await (await driver.$("~sira-end-button")).waitForDisplayed({ timeout: 15000 });
    await agentReady;

    for (const screen of TARGETS.screens) {
      const url = `harness://goto/${screen}`;
      if (platform === "ios") {
        await driver.execute("mobile: deepLink", { url, bundleId: "com.sira.harness" });
      } else {
        await driver.execute("mobile: deepLink", { url, package: "com.sira.harness" });
      }

      // Wait for at least one fresh frame to arrive after navigation. We
      // bound the wait at 3s to avoid stalling the whole suite if a screen
      // doesn't render.
      const beforeCount = agent.frameCount();
      const start = Date.now();
      while (Date.now() - start < 3000 && agent.frameCount() === beforeCount) {
        await driver.pause(150);
      }
      const f = agent.latestFrame();
      if (!f) throw new Error(`no frame received for ${screen}`);
      fs.writeFileSync(path.join(OUT, `${platform}-${screen}.webp`), f.webp);
      console.log(`captured ${platform}-${screen}.webp (${f.webp.length} bytes)`);
    }
  } finally {
    await agent.stop();
    await driver.deleteSession();
  }
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
