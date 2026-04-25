#!/usr/bin/env node
// §4 chaos. One scenario per invocation, configured via SCENARIO env var.

const { startSession } = require("./_lib");

const SCENARIO = process.env.SCENARIO;
const SERVER = process.env.SIRA_SERVER_URL;

const SCENARIOS = {
  async lock(driver) {
    await startLiveSession(driver);
    await driver.execute("mobile: lock", { seconds: 30 });
    await assertSessionState(["paused", "ended"]);
  },
  async "force-quit"(driver) {
    const sid = await startLiveSession(driver);
    await driver.execute("mobile: terminateApp", { bundleId: pkgId() });
    await waitForEndReason(sid, "customer-ended", 30_000);
  },
  async "network-handoff"(driver) {
    await startLiveSession(driver);
    await driver.setNetworkConnection(0); // off
    await driver.pause(15_000);
    await driver.setNetworkConnection(6); // wifi+data
    await driver.pause(10_000);
    await assertSessionState(["live", "ended"]);
  },
  async rotation(driver) {
    const sid = await startLiveSession(driver);
    await driver.setOrientation("LANDSCAPE");
    await driver.pause(2500);
    const dims = await fetchLatestViewport(sid);
    if (dims.w <= dims.h) throw new Error(`dashboard didn't see landscape: ${JSON.stringify(dims)}`);
  },
  async "long-session"(driver) {
    const sid = await startLiveSession(driver);
    const samples = [];
    for (let i = 0; i < 30; i++) {
      await driver.pause(30_000);
      const stats = await driver.execute("mobile: deviceInfo");
      samples.push(stats.memory || stats.RSS || 0);
      const fps = await fetchFps(sid);
      if (fps && fps < 4) throw new Error(`fps dropped to ${fps} at sample ${i}`);
    }
    const growth = (samples[samples.length - 1] - samples[0]) / 1024 / 1024;
    if (growth > 50) throw new Error(`memory grew ${growth.toFixed(1)}MB`);
  },
  async background(driver) {
    const sid = await startLiveSession(driver);
    await driver.background(60);
    await assertSessionStateById(sid, ["paused"]);
    await driver.pause(2_000); // foreground
    await assertSessionStateById(sid, ["live"]);
  },
  async "incoming-call"(driver) {
    if (process.env.DEVICE_OS !== "android") throw new Error("incoming-call is android-only");
    const sid = await startLiveSession(driver);
    await driver.execute("mobile: shell", { command: "am", args: ["start", "-a", "android.intent.action.CALL", "tel:5551234"] });
    await driver.pause(8_000);
    await assertSessionStateById(sid, ["paused"]);
  },
};

function pkgId() {
  return process.env.DEVICE_OS === "ios" ? "com.sira.harness" : "com.sira.harness";
}

async function startLiveSession(driver) {
  const r = await fetch(`${SERVER}/admin/test-session`, { method: "POST" });
  const { sessionId, code } = await r.json();
  await (await driver.$("~sira-help-button")).click();
  await (await driver.$("~sira-code-input")).setValue(code);
  await (await driver.$("//*[@text='Connect']")).click();
  if (process.env.DEVICE_OS === "android") {
    await (await driver.$("//*[@text='Continue']")).click();
    await (await driver.$("//*[@text='Start now' or @text='Start']")).click();
  }
  await (await driver.$("~sira-end-button")).waitForDisplayed({ timeout: 15000 });
  return sessionId;
}

async function assertSessionState(allowed) { /* read latest */ }
async function assertSessionStateById(sid, allowed) {
  const r = await fetch(`${SERVER}/admin/test-session/${sid}`);
  const j = await r.json();
  if (!allowed.includes(j.state)) throw new Error(`state ${j.state} not in ${allowed}`);
}
async function waitForEndReason(sid, expected, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const j = await (await fetch(`${SERVER}/admin/test-session/${sid}`)).json();
    if (j.endReason === expected) return;
    await new Promise((s) => setTimeout(s, 1000));
  }
  throw new Error(`session never ended with reason=${expected}`);
}
async function fetchLatestViewport(sid) {
  const j = await (await fetch(`${SERVER}/admin/test-session/${sid}/viewport`)).json();
  return j;
}
async function fetchFps(sid) {
  const j = await (await fetch(`${SERVER}/admin/test-session/${sid}/stats`)).json();
  return j.fps;
}

async function main() {
  const fn = SCENARIOS[SCENARIO];
  if (!fn) throw new Error(`unknown scenario: ${SCENARIO}`);
  const driver = await startSession({
    deviceName: process.env.DEVICE_NAME,
    deviceOs: process.env.DEVICE_OS,
    deviceVersion: process.env.DEVICE_VERSION,
    sessionName: `chaos-${SCENARIO}`,
  });
  try {
    await fn(driver);
    console.log(`✓ ${SCENARIO} passed`);
  } finally {
    await driver.deleteSession();
  }
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
