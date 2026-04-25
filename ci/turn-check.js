#!/usr/bin/env node
// Nightly TURN check (workflow §6). Exits non-zero on any failure.
//
// 1) Mint creds via /sessions/join (preferred path, post pre-launch §9-A).
//    If that endpoint doesn't yet wire TURN, fall back to direct Cloudflare
//    minting so we still verify the credentials work.
// 2) Build an RTCPeerConnection forced to relay-only.
// 3) Gather candidates; assert at least one `relay` candidate appeared.

const SERVER = process.env.SIRA_SERVER_URL;
const KEY = process.env.SIRA_TEST_PUBLIC_KEY || "pk_live_sira";
const CF_TOKEN_ID = process.env.CLOUDFLARE_TURN_TOKEN_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN;

async function viaJoin() {
  const r = await fetch(`${SERVER}/sessions/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sira-key": KEY,
      "user-agent": "sira-sdk-ci/0.0.1 turn-check",
    },
    body: JSON.stringify({ code: "000000", origin: "ci.turn-check", clientHint: "native" }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.iceServers || null;
}

async function viaCloudflare() {
  if (!CF_TOKEN_ID || !CF_API_TOKEN) {
    throw new Error("missing CLOUDFLARE_TURN_TOKEN_ID / CLOUDFLARE_TURN_API_TOKEN for fallback");
  }
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TOKEN_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CF_API_TOKEN}` },
      body: JSON.stringify({ ttl: 600 }),
    }
  );
  if (!r.ok) throw new Error(`Cloudflare TURN mint failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.iceServers || j;
}

async function main() {
  let iceServers = await viaJoin();
  if (!iceServers || iceServers.length === 0) {
    console.warn("• /sessions/join did not return iceServers; falling back to direct Cloudflare mint");
    iceServers = await viaCloudflare();
  }

  const hasStun = iceServers.some((s) => (s.urls || s.url || "").toString().includes("stun:"));
  const hasTurn = iceServers.some((s) => (s.urls || s.url || "").toString().includes("turn:"));
  if (!hasStun || !hasTurn) throw new Error(`expected STUN+TURN, got ${JSON.stringify(iceServers)}`);

  const wrtc = await import("@roamhq/wrtc").catch(() => null);
  if (!wrtc) {
    console.warn("• @roamhq/wrtc not installed; skipping ICE-gathering check");
    console.log("✓ STUN+TURN entries present");
    return;
  }

  const { RTCPeerConnection } = wrtc.default || wrtc;
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
  pc.createDataChannel("probe");

  let sawRelay = false;
  pc.onicecandidate = (e) => {
    if (e.candidate && e.candidate.candidate.includes("typ relay")) sawRelay = true;
  };
  await pc.setLocalDescription(await pc.createOffer());

  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && resolve();
    setTimeout(resolve, 8000);
  });
  pc.close();

  if (!sawRelay) throw new Error("no relay-typ candidate seen — TURN allocation failed");
  console.log("✓ TURN relay candidate gathered");
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
