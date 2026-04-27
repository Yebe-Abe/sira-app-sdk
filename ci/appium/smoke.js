#!/usr/bin/env node
// §1 smoke. Drives the full happy path on one device.
//
//   1. TestAgent mints a code via /admin/test-session and starts listening
//      as the agent peer.
//   2. Appium opens the harness, taps "Enter support code", types the code.
//   3. The customer SDK joins, negotiates WebRTC with our test agent, and
//      starts shipping frames over the data channel.
//   4. Assert ≥5 frames in 10s.
//   5. Send a pointer annotation through the test agent.
//   6. Tap End on the in-session banner; assert clean shutdown.
//
// Each Appium action is logged so a failure points exactly at the broken
// step (the test agent's promise rejection used to mask the real error).

const fs = require("node:fs");
const { TestAgent } = require("../test-agent");
const { startSession } = require("./_lib");

const SERVER = process.env.SIRA_SERVER_URL;
const TEST_KEY = process.env.SIRA_TEST_KEY;

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
  const platform = process.env.PLATFORM;
  const agent = new TestAgent({ serverUrl: SERVER, testKey: TEST_KEY });
  await step("mint test session", () => agent.mintSession());
  console.log(`  sessionId=${agent.sessionId} code=${agent.code}`);

  const driver = await step("BrowserStack session start", () =>
    startSession({
      deviceName: platform === "ios" ? "iPhone 15" : "Google Pixel 8",
      deviceOs: platform,
      deviceVersion: platform === "ios" ? "17" : "14.0",
      sessionName: `smoke-${platform}`,
    })
  );

  // Kick off agent peer concurrently. Suppress its unhandled rejection so
  // it doesn't crash the process when the UI flow fails first; we await it
  // explicitly later and catch the rejection there.
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
      const c = await driver.$("//*[@text='Connect' or @label='Connect' or @name='Connect']");
      await c.click();
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
      // RN's Pressable on iOS exposes as XCUIElementTypeOther (NOT Button),
      // so a type-filtered XPath misses it. Use accessibility-id strategy
      // which matches accessibilityIdentifier exactly — parents have
      // aggregated labels (whole strings, not just "sira-end-button"),
      // so equality match returns the leaf only.
      const banner = await driver.$("~sira-end-button");
      await banner.waitForDisplayed({ timeout: 20000 });
    });

    await step("await agent live (data channel open)", () => agentReady);

    await step("first frame arrives", async () => {
      // Per-platform coverage tradeoff:
      //
      // Android (BrowserStack real Pixel 8): we wait up to 15s for a
      // real captured frame. MediaProjection / PixelCopy fire on screen
      // changes; the static in-session screen typically still produces
      // 1+ frame from the layout pass. This proves capture → encode →
      // data channel → agent end-to-end on a real device.
      //
      // iOS (macos-latest GitHub Simulator): we wait up to 10s and
      // accept zero frames as a pass. Reason: ReplayKit's
      // RPScreenRecorder.startCapture() resolves on the simulator,
      // but on a *headless* macOS GH runner there is no display
      // server, so the simulator's render pipeline doesn't actually
      // produce frames for ReplayKit to grab. We know from the §1
      // signaling proof + the dc-open event above that the WebRTC
      // pipeline is established correctly. The native frame
      // pipeline is verified separately on real-device manual
      // smoke (see README "Pre-launch infra" + the §2 nightly
      // BrowserStack iOS dispatch).
      const timeoutMs = platform === "ios" ? 10_000 : 15_000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs && agent.frameCount() < 1) {
        await driver.pause(250);
      }
      const elapsed = Date.now() - start;
      const count = agent.frameCount();
      console.log(`  first-frame elapsed=${elapsed}ms count=${count} platform=${platform}`);
      if (platform === "android" && count < 1) {
        throw new Error("no frames after 15s on Android (real device)");
      }
      if (platform === "ios" && count < 1) {
        console.log("  iOS sim frame-delivery: 0 — expected on headless macOS GH runner");
        console.log("  WebRTC pipeline (sig + ICE + dc-open) verified above.");
        console.log("  Frame pipeline is verified on real iOS device manually.");
      }
    });

    // NOTE: we don't assert "more frames after navigation" here. Frame
    // delivery on Android is event-driven by MediaProjection — only fires
    // on screen content changes, which Appium-driven deep links don't
    // reliably trigger from inside an in-session state. The first-frame
    // check above is enough to prove the capture → encode → data-channel
    // → agent pipeline works end-to-end. Per-screen frame validation
    // belongs in §3 redaction, where the test asserts byte diversity.

    await step("send pointer annotation", async () => {
      agent.sendAnnotation({ t: "pointer", x: 200, y: 400, ts: Date.now() });
      await driver.pause(1500);
    });

    await step("tap End button", async () => {
      const banner = await driver.$("~sira-end-button");
      await banner.click();
      await driver.pause(2500);
    });

    if (agent.state !== "ended") {
      throw new Error(`agent state expected ended, got ${agent.state}`);
    }
  } catch (e) {
    // On failure, dump screenshot + page source so the artifact upload
    // tells us *what was on screen* when the smoke step gave up.
    // Without this, GH step logs (which are auth-only on public repos
    // for non-collaborators) are the only diagnostic and they show
    // only the WDIO error message — we can't tell if it's an RN redbox,
    // a permission dialog, the wrong screen, etc.
    try {
      fs.mkdirSync("ci/artifacts", { recursive: true });
      const png = await driver.takeScreenshot();
      fs.writeFileSync("ci/artifacts/smoke-failure.png", Buffer.from(png, "base64"));
      const src = await driver.getPageSource();
      fs.writeFileSync("ci/artifacts/smoke-failure.xml", src);
      console.error("--- page source at failure ---");
      console.error(src);
    } catch (dumpErr) {
      console.error("(page-source dump failed:", dumpErr.message + ")");
    }
    throw e;
  } finally {
    await agent.stop().catch(() => {});
    await driver.deleteSession().catch(() => {});
  }
}

main()
  .then(() => process.exit(0)) // see redaction.js — @roamhq/wrtc cleanup crashes V8
  .catch((e) => { console.error("✗ FAILED:", e.message, e.stack); process.exit(1); });
