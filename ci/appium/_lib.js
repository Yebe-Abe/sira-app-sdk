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

async function fetchDeviceLogs(driver) {
  const sessionId = driver.sessionId;
  const u = process.env.BROWSERSTACK_USERNAME;
  const k = process.env.BROWSERSTACK_ACCESS_KEY;
  const url = `https://api-cloud.browserstack.com/app-automate/sessions/${sessionId}/devicelogs`;
  const r = await fetch(url, {
    headers: { authorization: "Basic " + Buffer.from(`${u}:${k}`).toString("base64") },
  });
  if (!r.ok) throw new Error(`devicelogs ${r.status}`);
  return r.text();
}


async function startSession(opts) {
  return wdio.remote({
    protocol: "https", hostname: "hub-cloud.browserstack.com", port: 443, path: "/wd/hub",
    logLevel: "warn", capabilities: caps(opts),
  });
}

module.exports = { startSession, fetchDeviceLogs };
