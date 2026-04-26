#!/usr/bin/env node
// §3 redaction. For each sensitive screen, navigate the harness via
// deeplink, capture the dashboard-side frame via the in-process TestAgent,
// save to OUT_DIR for downstream Tesseract OCR + grep.

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");
const { TestAgent } = require("../test-agent");
const { startSession, fetchDeviceLogs } = require("./_lib");

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
  fs.mkdirSync("ci/artifacts", { recursive: true });
  let capturedFailure = null;
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
    // Stash sessionId so the post-deletion fetch can use it.
    const sid = driver.sessionId;
    // Capture session ID for the BrowserStack devicelogs API call below.
    fs.writeFileSync("ci/artifacts/bs-session-id.txt", sid);
    // We can't pull the logcat via Appium (BrowserStack disables adb shell);
    // it's fetched after driver.deleteSession() in the finally block.
    capturedFailure = e;
    throw e;
  } finally {
    const sid = driver.sessionId;
    await agent.stop().catch(() => {});
    // Close the BrowserStack session BEFORE fetching device logs — the
    // /devicelogs endpoint returns empty until the session is finalized
    // server-side. Then poll briefly because finalization is async.
    await driver.deleteSession().catch(() => {});
    if (capturedFailure && sid) {
      let logs = "";
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          logs = await fetchDeviceLogs({ sessionId: sid });
          if (logs && logs.length > 100) break;
        } catch (e) {
          console.error(`(devicelogs attempt ${i + 1} failed: ${e.message})`);
        }
      }
      fs.writeFileSync("ci/artifacts/redaction-devicelogs.txt", logs);
      console.error("--- BrowserStack devicelogs (last 250 lines) ---");
      console.error((logs || "(empty)").split("\n").slice(-250).join("\n"));
    }
  }
}

main()
  .then(() => {
    // The @roamhq/wrtc native module fires cleanup callbacks after the V8
    // isolate is torn down, causing a v8::HandleScope fatal during normal
    // exit. Exit explicitly so the crash never happens.
    process.exit(0);
  })
  .catch((e) => { console.error("✗ FAILED:", e.message, e.stack); process.exit(1); });
