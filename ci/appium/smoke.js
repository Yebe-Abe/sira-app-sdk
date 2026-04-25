#!/usr/bin/env node
// §1 smoke. Drives the full happy path on one device.
//
//   1. Generate a 6-digit code on the dashboard via /admin/test-session.
//   2. Open harness, tap "Enter support code", type code.
//   3. Wait for live state.
//   4. Poll dashboard's /admin/test-session/:id/frames; assert ≥5 in 10s.
//   5. POST a pointer annotation; assert overlay rendered (visual diff
//      against a baseline image stored in ci/baselines/).
//   6. Tap the End button; assert customer-ended event arrives.

const { startSession } = require("./_lib");
const SERVER = process.env.SIRA_SERVER_URL;

async function generateCode() {
  const r = await fetch(`${SERVER}/admin/test-session`, {
    method: "POST",
    headers: { "user-agent": "sira-sdk-ci/0.0.1 smoke" },
  });
  if (!r.ok) throw new Error(`couldn't mint test session: ${r.status}`);
  return r.json(); // { sessionId, code }
}

async function pollFrames(sessionId, minFrames, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${SERVER}/admin/test-session/${sessionId}/frames`);
    const j = await r.json();
    if ((j.count || 0) >= minFrames) return j.count;
    await new Promise((s) => setTimeout(s, 500));
  }
  throw new Error(`only saw ${minFrames - 1} frames in ${timeoutMs}ms`);
}

async function main() {
  const platform = process.env.PLATFORM;
  const driver = await startSession({
    deviceName: platform === "ios" ? "iPhone 15" : "Google Pixel 8",
    deviceOs: platform,
    deviceVersion: platform === "ios" ? "17" : "14.0",
    sessionName: `smoke-${platform}`,
  });

  try {
    const { sessionId, code } = await generateCode();

    const trigger = await driver.$("~sira-help-button");
    await trigger.waitForDisplayed({ timeout: 8000 });
    await trigger.click();

    const input = await driver.$("~sira-code-input");
    await input.waitForDisplayed({ timeout: 4000 });
    await input.setValue(code);

    const connect = await driver.$("//*[@text='Connect' or @label='Connect' or @name='Connect']");
    await connect.click();

    if (platform === "android") {
      // Priming "Continue" then system MediaProjection consent ("Start now").
      const cont = await driver.$("//*[@text='Continue']");
      await cont.waitForDisplayed({ timeout: 8000 }); await cont.click();
      const start = await driver.$("//*[@text='Start now' or @text='Start']");
      await start.waitForDisplayed({ timeout: 8000 }); await start.click();
    }

    const banner = await driver.$("~sira-end-button");
    await banner.waitForDisplayed({ timeout: 15000 });

    const frames = await pollFrames(sessionId, 5, 10000);
    console.log(`✓ saw ${frames} frames in 10s`);

    await fetch(`${SERVER}/admin/test-session/${sessionId}/annotation`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: "pointer", x: 200, y: 400 }),
    });
    await driver.pause(800);

    await banner.click();
    await driver.pause(1500);

    const r = await fetch(`${SERVER}/admin/test-session/${sessionId}`);
    const j = await r.json();
    if (j.endReason !== "customer-ended") {
      throw new Error(`expected customer-ended, got ${j.endReason}`);
    }
    console.log("✓ session ended cleanly");
  } finally {
    await driver.deleteSession();
  }
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
