#!/usr/bin/env node
// §1 smoke. Drives the full happy path on one device.
//
//   1. TestAgent mints a code via /admin/test-session and starts listening
//      as the agent peer.
//   2. Appium opens the harness, taps "Enter support code", types the code.
//   3. The customer SDK joins, negotiates WebRTC with our test agent, and
//      starts shipping frames over the data channel.
//   4. Assert ≥5 frames in 10s.
//   5. Send a pointer annotation through the test agent; assert overlay
//      rendered (visual check, not strict — just confirms no crash).
//   6. Tap End on the in-session banner; assert clean shutdown.

const { TestAgent } = require("../test-agent");
const { startSession } = require("./_lib");

const SERVER = process.env.SIRA_SERVER_URL;
const TEST_KEY = process.env.SIRA_TEST_KEY;

async function main() {
  const platform = process.env.PLATFORM;
  const agent = new TestAgent({ serverUrl: SERVER, testKey: TEST_KEY });
  await agent.mintSession();
  console.log(`✓ minted session ${agent.sessionId} code=${agent.code}`);

  const driver = await startSession({
    deviceName: platform === "ios" ? "iPhone 15" : "Google Pixel 8",
    deviceOs: platform,
    deviceVersion: platform === "ios" ? "17" : "14.0",
    sessionName: `smoke-${platform}`,
  });

  // Start the agent peer concurrently with the device flow. start() resolves
  // when the data channel opens, which happens after the customer connects.
  const agentReady = agent.start({ openTimeoutMs: 30_000 });

  try {
    const trigger = await driver.$("~sira-help-button");
    await trigger.waitForDisplayed({ timeout: 8000 });
    await trigger.click();

    const input = await driver.$("~sira-code-input");
    await input.waitForDisplayed({ timeout: 4000 });
    await input.setValue(agent.code);

    const connect = await driver.$("//*[@text='Connect' or @label='Connect' or @name='Connect']");
    await connect.click();

    if (platform === "android") {
      const cont = await driver.$("//*[@text='Continue']");
      await cont.waitForDisplayed({ timeout: 8000 }); await cont.click();
      const start = await driver.$("//*[@text='Start now' or @text='Start']");
      await start.waitForDisplayed({ timeout: 8000 }); await start.click();
    }

    const banner = await driver.$("~sira-end-button");
    await banner.waitForDisplayed({ timeout: 15000 });

    await agentReady;
    console.log("✓ agent peer connected; data channel open");

    const start = Date.now();
    while (Date.now() - start < 10_000 && agent.frameCount() < 5) {
      await driver.pause(500);
    }
    if (agent.frameCount() < 5) throw new Error(`only saw ${agent.frameCount()} frames in 10s`);
    console.log(`✓ ${agent.frameCount()} frames in 10s`);

    agent.sendAnnotation({ t: "pointer", x: 200, y: 400, ts: Date.now() });
    await driver.pause(1500);

    await banner.click();
    await driver.pause(2500);

    if (agent.state !== "ended") {
      throw new Error(`agent state expected 'ended', got '${agent.state}'`);
    }
    console.log("✓ session ended cleanly");
  } finally {
    await agent.stop();
    await driver.deleteSession();
  }
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
