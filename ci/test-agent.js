// In-process WebRTC test-agent peer used by CI.
//
// Production has a real human in the dashboard generating codes, watching
// frames, drawing annotations. CI doesn't. So we run a fake "agent" right
// here in the test process that:
//
//   1. POSTs the server's /admin/test-session to mint a code (via the
//      SIRA_TEST_KEY-gated admin endpoint).
//   2. Opens the same public WS the real dashboard uses, as role=agent.
//   3. Negotiates a real WebRTC peer connection with the customer device,
//      accepts the customer-created "sira" data channel, and listens for
//      frames / viewport / hello messages.
//   4. Forwards annotations the test asks to send back through the channel.
//
// Everything below uses the same protocol the production dashboard uses.
// No frame storage in the server — the test agent holds latest frame +
// count in-memory, and the test reads them via methods on this object.

const WS = require("ws");
const { RTCPeerConnection } = require("@roamhq/wrtc");

class TestAgent {
  constructor({ serverUrl, testKey }) {
    if (!serverUrl) throw new Error("serverUrl required");
    if (!testKey) throw new Error("testKey required (SIRA_TEST_KEY)");
    this.serverUrl = serverUrl;
    this.testKey = testKey;

    this.sessionId = null;
    this.code = null;
    this.ws = null;
    this.pc = null;
    this.dc = null;

    this.frames = []; // { seq, ts, w, h, webp (Buffer) }
    this.viewport = null;
    this.endReason = null;
    this.state = "idle"; // idle | waiting | connecting | live | ended
  }

  async mintSession() {
    const r = await fetch(`${this.serverUrl}/admin/test-session`, {
      method: "POST",
      headers: { "x-sira-test-key": this.testKey },
    });
    if (!r.ok) throw new Error(`mint failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    this.sessionId = j.sessionId;
    this.code = j.code;
    return j;
  }

  // Connect to the signaling WS as role=agent and start ICE/SDP. Returns
  // when the data channel is open OR after timeout (ms). The customer will
  // create the data channel after answering — we wait for ondatachannel.
  async start({ openTimeoutMs = 20_000 } = {}) {
    if (!this.sessionId) await this.mintSession();
    this.state = "waiting";

    const wsUrl =
      this.serverUrl.replace(/^http/, "ws") +
      `/rtc?sid=${encodeURIComponent(this.sessionId)}&role=agent&testKey=${encodeURIComponent(this.testKey)}`;
    this.ws = new WS(wsUrl);

    const rtcConfig = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
    this.pc = new RTCPeerConnection(rtcConfig);

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this._wsSend({
          t: "ice",
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        });
      }
    };

    this.pc.ondatachannel = (ev) => {
      console.log(`[TestAgent] ondatachannel: label=${ev.channel.label}`);
      this.dc = ev.channel;
      this.dc.onopen = () => { console.log("[TestAgent] dc open → live"); this.state = "live"; };
      this.dc.onmessage = (m) => this._onChannelMessage(m.data);
      this.dc.onclose = () => { console.log("[TestAgent] dc close → ended"); this.state = "ended"; };
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log(`[TestAgent] ice state: ${this.pc.iceConnectionState}`);
    };
    this.pc.onconnectionstatechange = () => {
      console.log(`[TestAgent] pc state: ${this.pc.connectionState}`);
    };

    const opened = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for data channel")), openTimeoutMs);
      const tick = setInterval(() => {
        if (this.state === "live") {
          clearTimeout(t); clearInterval(tick); resolve();
        } else if (this.state === "ended") {
          clearTimeout(t); clearInterval(tick); reject(new Error("session ended before live"));
        }
      }, 100);
    });

    await new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });

    this.ws.on("message", (raw) => this._onSignal(raw.toString()));
    return opened;
  }

  // Convenience getters for tests.
  frameCount() { return this.frames.length; }
  latestFrame() { return this.frames[this.frames.length - 1]; }
  latestViewport() { return this.viewport; }

  // Send an annotation back to the customer.
  sendAnnotation(msg) {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error(`data channel not open (state=${this.dc?.readyState})`);
    }
    this.dc.send(JSON.stringify(msg));
  }

  async stop() {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    try { this.ws?.close(); } catch {}
    this.state = "ended";
  }

  // --- internals ---

  _wsSend(msg) {
    if (this.ws && this.ws.readyState === WS.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async _onSignal(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    console.log(`[TestAgent] signal in: t=${msg.t}${msg.kind?` kind=${msg.kind}`:""}${msg.code?` code=${msg.code}`:""}`);
    switch (msg.t) {
      case "ready":
        // Customer may already be present; either way we let them initiate.
        this.state = "connecting";
        break;
      case "peer-joined":
        this.state = "connecting";
        break;
      case "peer-left":
        console.log("[TestAgent] peer-left → ended");
        this.state = "ended";
        break;
      case "sdp":
        if (msg.kind === "offer") {
          await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          const ans = await this.pc.createAnswer();
          await this.pc.setLocalDescription(ans);
          this._wsSend({ t: "sdp", kind: "answer", sdp: ans.sdp });
        } else if (msg.kind === "answer") {
          await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        }
        break;
      case "ice":
        if (msg.candidate) {
          try {
            await this.pc.addIceCandidate({
              candidate: msg.candidate,
              sdpMid: msg.sdpMid,
              sdpMLineIndex: msg.sdpMLineIndex,
            });
          } catch {} // late candidates after close are expected
        }
        break;
      case "error":
        console.log(`[TestAgent] server error → ended: ${msg.code} ${msg.message||""}`);
        this.state = "ended";
        this.endReason = `signal_error:${msg.code}`;
        break;
    }
  }

  _onChannelMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === "string" ? data : data.toString()); } catch { return; }
    switch (msg.t) {
      case "frame":
        this.frames.push({
          seq: msg.seq, ts: msg.ts, w: msg.w, h: msg.h,
          webp: Buffer.from(msg.webp, "base64"),
        });
        break;
      case "viewport":
        this.viewport = { w: msg.w, h: msg.h, dpr: msg.dpr, platform: msg.platform };
        break;
      case "end":
        this.state = "ended";
        this.endReason = msg.reason ?? "customer-ended";
        break;
      case "hello":
        // informational
        break;
    }
  }
}

module.exports = { TestAgent };
