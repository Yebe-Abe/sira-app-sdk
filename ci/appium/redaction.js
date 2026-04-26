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

// Cheap content fingerprint — first 8 bytes of the WebP buffer XOR'd
// into a single int. Good enough to detect "this is the same frame as
// last time" without requiring a real cryptographic hash.
function simpleHash(buf) {
  let h = 0;
  const n = Math.min(buf.length, 256);
  for (let i = 0; i < n; i++) h = ((h << 5) - h + buf[i]) | 0;
  return h;
}

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

    // Capture seed: the very first frame we received (likely the
    // in-session banner over the harness home).
    const seenHashes = new Set();
    let lastFrame = agent.latestFrame();
    if (lastFrame) seenHashes.add(simpleHash(lastFrame.webp));

    for (const screen of TARGETS.screens) {
      await step(`navigate to ${screen} (await new frame)`, async () => {
        // After navigating to a previous sensitive screen, the harness
        // home list is hidden. Press the system back button to return to
        // home before tapping the next row. (back is a no-op on home.)
        if (platform === "android") {
          try { await driver.back(); } catch {}
        } else {
          // iOS doesn't have a system back button; the harness home
          // covers the screen via `state === "home"` so we navigate via
          // a top-level Home link rendered on every sensitive screen.
          try {
            const homeLink = await driver.$("//*[@text='Home' or @label='Home']");
            if (await homeLink.isExisting()) await homeLink.click();
          } catch {}
        }

        // Tap the in-app row for this screen on the now-visible home.
        const url = `harness://goto/${screen}`;
        try {
          const row = await driver.$(`//*[@text='${screen}' or @label='${screen}']`);
          if (await row.isExisting()) await row.click();
        } catch {}
        // Fallback: deep link in case the harness layout doesn't expose
        // the row directly (e.g. the harness was rewritten).
        try {
          if (platform === "ios") {
            await driver.execute("mobile: deepLink", { url, bundleId: "com.sira.harness" });
          } else {
            await driver.execute("mobile: deepLink", { url, package: "com.sira.harness" });
          }
        } catch {}

        // Wait for a NEW (unique-hash) frame, not just any frame. If the
        // navigation didn't change pixels, lastFrame stays the same and
        // we'd silently capture the same image six times.
        const startTs = Date.now();
        let captured = null;
        while (Date.now() - startTs < 5000) {
          const f = agent.latestFrame();
          if (f) {
            const h = simpleHash(f.webp);
            if (!seenHashes.has(h)) {
              seenHashes.add(h);
              captured = f;
              break;
            }
          }
          await driver.pause(150);
        }
        if (!captured) throw new Error(`no NEW frame after navigating to ${screen}`);
        fs.writeFileSync(path.join(OUT, `${platform}-${screen}.webp`), captured.webp);
        console.log(`  captured ${platform}-${screen}.webp (${captured.webp.length} bytes, hash=${simpleHash(captured.webp).toString(16)})`);
        lastFrame = captured;
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
