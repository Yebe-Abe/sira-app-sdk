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

async function step(name, fn) {
  console.log(`▶ ${name}`);
  try {
    const out = await fn();
    console.log(`✓ ${name}`);
    return out;
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
    throw e;
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const platform = process.env.PLATFORM;

  const agent = new TestAgent({ serverUrl: SERVER, testKey: TEST_KEY });
  await step("mint test session", () => agent.mintSession());

  const driver = await step("BrowserStack session start", () =>
    startSession({
      deviceName: platform === "ios" ? "iPhone 15" : "Google Pixel 8",
      deviceOs: platform,
      deviceVersion: platform === "ios" ? "17" : "14.0",
      sessionName: `redaction-${platform}`,
    })
  );

  const agentReady = agent.start({ openTimeoutMs: 45_000 });
  agentReady.catch(() => {});

  try {
    await step("tap help button", async () => {
      const btn = await driver.$("~sira-help-button");
      await btn.waitForDisplayed({ timeout: 15000 });
      await btn.click();
    });
    await step("type code", async () => {
      const input = await driver.$("~sira-code-input");
      await input.waitForDisplayed({ timeout: 5000 });
      await input.setValue(agent.code);
    });
    await step("tap Connect", async () => {
      await (await driver.$("//*[@text='Connect' or @label='Connect' or @name='Connect']")).click();
    });
    if (platform === "android") {
      await step("priming Continue", async () => {
        const cont = await driver.$("//*[@text='Continue']");
        await cont.waitForDisplayed({ timeout: 10000 });
        await cont.click();
      });
      await step("system dialog Start", async () => {
        const start = await driver.$("//*[@text='Start now' or @text='Start' or @text='START']");
        await start.waitForDisplayed({ timeout: 10000 });
        await start.click();
      });
    }
    await step("wait for in-session banner", async () => {
      const banner = await driver.$("~sira-end-button");
      await banner.waitForDisplayed({ timeout: 20000 });
    });
    await step("await agent live (data channel open)", () => agentReady);

    for (const screen of TARGETS.screens) {
      await step(`navigate to ${screen}`, async () => {
        const url = `harness://goto/${screen}`;
        if (platform === "ios") {
          await driver.execute("mobile: deepLink", { url, bundleId: "com.sira.harness" });
        } else {
          await driver.execute("mobile: deepLink", { url, package: "com.sira.harness" });
        }
        const beforeCount = agent.frameCount();
        const startTs = Date.now();
        while (Date.now() - startTs < 3000 && agent.frameCount() === beforeCount) {
          await driver.pause(150);
        }
        const f = agent.latestFrame();
        if (!f) throw new Error(`no frame received for ${screen}`);
        fs.writeFileSync(path.join(OUT, `${platform}-${screen}.webp`), f.webp);
        console.log(`  captured ${platform}-${screen}.webp (${f.webp.length} bytes)`);
      });
    }
  } catch (e) {
    // Diagnostic dump so we can see what's actually on screen.
    try {
      const png = await driver.takeScreenshot();
      fs.mkdirSync("ci/artifacts", { recursive: true });
      fs.writeFileSync("ci/artifacts/redaction-failure.png", Buffer.from(png, "base64"));
      const src = await driver.getPageSource();
      fs.writeFileSync("ci/artifacts/redaction-failure.xml", src);
      console.error("--- page source (full) ---");
      console.error(src);
    } catch (dumpErr) {
      console.error("(page-source dump failed:", dumpErr.message + ")");
    }
    // Pull device logcat, filtered to our package + WebRTC + system errors,
    // so a native crash leaves a stack trace in the workflow log.
    try {
      const logcat = await driver.execute("mobile: shell", {
        command: "logcat",
        args: ["-d", "-v", "threadtime", "-t", "300",
               "SiraSupport:V", "AndroidRuntime:E", "DEBUG:V", "ActivityManager:I",
               "MediaProjection:V", "WebRTC:V", "*:S"],
      });
      const text = typeof logcat === "string" ? logcat : (logcat?.value || JSON.stringify(logcat));
      fs.writeFileSync("ci/artifacts/redaction-logcat.txt", text);
      console.error("--- logcat tail (300 lines, filtered) ---");
      console.error(text.split("\n").slice(-200).join("\n"));
    } catch (lcErr) {
      console.error("(logcat pull failed:", lcErr.message + ")");
    }
    throw e;
  } finally {
    await agent.stop().catch(() => {});
    await driver.deleteSession().catch(() => {});
  }
}

main().catch((e) => { console.error("✗ FAILED:", e.message, e.stack); process.exit(1); });
