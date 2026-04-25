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
      const banner = await driver.$("~sira-end-button");
      await banner.waitForDisplayed({ timeout: 20000 });
    });

    await step("await agent live (data channel open)", () => agentReady);

    await step("collect ≥5 frames in 10s", async () => {
      const start = Date.now();
      while (Date.now() - start < 10_000 && agent.frameCount() < 5) {
        await driver.pause(500);
      }
      console.log(`  saw ${agent.frameCount()} frames`);
      if (agent.frameCount() < 5) throw new Error(`only ${agent.frameCount()} frames in 10s`);
    });

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
  } finally {
    await agent.stop().catch(() => {});
    await driver.deleteSession().catch(() => {});
  }
}

main().catch((e) => { console.error("✗ FAILED:", e.message, e.stack); process.exit(1); });
