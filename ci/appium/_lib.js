// Shared helpers for the Appium scripts. WebDriverIO + BrowserStack.
const wdio = require("webdriverio");

const BS_USER = process.env.BROWSERSTACK_USERNAME;
const BS_KEY = process.env.BROWSERSTACK_ACCESS_KEY;
const BS_APP = process.env.BS_APP_URL;

if (!BS_USER || !BS_KEY) {
  throw new Error("BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY required");
}

function caps({ deviceName, deviceOs, deviceVersion, sessionName }) {
  return {
    "bstack:options": {
      userName: BS_USER, accessKey: BS_KEY,
      projectName: "sira-app-sdk", buildName: process.env.GITHUB_RUN_ID || "local",
      sessionName, deviceName, osVersion: deviceVersion,
      // Capture the device's full logcat — BrowserStack uploads it to
      // their dashboard and exposes it via /sessions/:id/devicelogs.
      // (BrowserStack runs Appium on their side and doesn't honor the
      // standard appium:relaxedSecurity cap, so we can't run adb shell
      // ourselves; this is the supported path.)
      debug: true,
      networkLogs: true,
      appiumLogs: true,
    },
    platformName: deviceOs === "ios" ? "iOS" : "Android",
    "appium:app": BS_APP,
    "appium:autoGrantPermissions": true,
    "appium:autoAcceptAlerts": deviceOs === "ios",
  };
}

async function fetchDeviceLogs(driverOrSessionRef) {
  const sessionId = driverOrSessionRef.sessionId;
  if (!sessionId) throw new Error("missing sessionId");
  const u = process.env.BROWSERSTACK_USERNAME;
  const k = process.env.BROWSERSTACK_ACCESS_KEY;
  const auth = "Basic " + Buffer.from(`${u}:${k}`).toString("base64");
  // Step 1: look up the session to get its build_hashed_id (BrowserStack
  // requires this for the devicelogs endpoint).
  const meta = await fetch(`https://api-cloud.browserstack.com/app-automate/sessions/${sessionId}.json`,
    { headers: { authorization: auth } });
  if (!meta.ok) throw new Error(`session-meta ${meta.status}`);
  const j = await meta.json();
  const buildId =
    j?.automation_session?.build_hashed_id ?? j?.automation_session?.build_id;
  if (!buildId) throw new Error("session metadata missing build_hashed_id");
  // Step 2: pull the device logs (logcat).
  const logsUrl =
    `https://api-cloud.browserstack.com/app-automate/builds/${buildId}/sessions/${sessionId}/devicelogs`;
  const r = await fetch(logsUrl, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`devicelogs ${r.status} url=${logsUrl}`);
  return r.text();
}


// iOS simulator path: instead of paying BrowserStack to run a signed
// .ipa on a real iPhone, we boot iOS Simulator on the macOS GitHub
// runner itself and point Appium at localhost. Apple-Developer-account-free
// and BS-quota-free. Trade-off: no real-device-only behavior (camera,
// thermal, real carrier NAT). For SDK-level testing (UI flows, signaling,
// redaction) the simulator is sufficient.
function localSimulatorCaps(deviceName, deviceVersion) {
  // Prefer pinning by UDID (set by ci/run-ios-simulator.sh into
  // GITHUB_ENV) — that binds Appium to the exact already-booted
  // simulator and skips the platformVersion / deviceName lookup that
  // otherwise fails when CI's installed SDKs (e.g. 18.5, 26.0) don't
  // match a hardcoded version like "17".
  const udid = process.env.IOS_SIM_UDID;
  return {
    platformName: "iOS",
    ...(udid
      ? { "appium:udid": udid }
      : {
          "appium:platformVersion": deviceVersion,
          "appium:deviceName": deviceName,
        }),
    "appium:automationName": "XCUITest",
    "appium:app": process.env.LOCAL_IOS_APP_PATH,
    "appium:autoAcceptAlerts": true,
    "appium:newCommandTimeout": 180,
  };
}

async function startSession(opts) {
  // Local-simulator override for iOS jobs running on the macos-latest
  // GitHub runner. Set USE_LOCAL_APPIUM=1 + LOCAL_IOS_APP_PATH to take
  // this path instead of BrowserStack.
  if (opts.deviceOs === "ios" && process.env.USE_LOCAL_APPIUM === "1") {
    return wdio.remote({
      protocol: "http", hostname: "127.0.0.1", port: 4723, path: "/",
      logLevel: "warn",
      capabilities: localSimulatorCaps(opts.deviceName, opts.deviceVersion),
    });
  }
  return wdio.remote({
    protocol: "https", hostname: "hub-cloud.browserstack.com", port: 443, path: "/wd/hub",
    logLevel: "warn", capabilities: caps(opts),
  });
}

module.exports = { startSession, fetchDeviceLogs };
