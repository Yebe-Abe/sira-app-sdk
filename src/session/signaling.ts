// Signaling + WebRTC plumbing. Reuses the web SDK's endpoints exactly:
//   POST {serverUrl}/sessions/join
//   WSS  {serverUrl}/rtc?sid=…&role=customer
//
// One ordered RTCDataChannel named "sira" carries both annotation messages
// (incoming) and frame messages (outgoing).

import type { JoinSessionResponse, IncomingMsg, OutgoingMsg } from "../protocol/messages";

export interface SignalingDeps {
  // Injected so we can swap in react-native-webrtc without coupling the
  // session logic to its import. Keeps the type-checker honest if the
  // peer dep isn't installed in a test harness.
  RTCPeerConnection: typeof RTCPeerConnection;
}

export interface JoinArgs {
  serverUrl: string;
  publicKey: string;
  code: string;
  bundleId: string;
}

export async function joinSession(args: JoinArgs): Promise<JoinSessionResponse> {
  // CI test runs set process.env.SIRA_CI to a marker. The server doesn't
  // need to do anything special with it; it just lets monitoring filter
  // synthetic traffic out of real-customer dashboards.
  const ciTag = (typeof process !== "undefined" && process.env && process.env.SIRA_CI) || null;
  const ua = ciTag ? `sira-sdk-rn/0.0.1 ci=${ciTag}` : "sira-sdk-rn/0.0.1";

  // Body shape matches the published web SDK's /sessions/join call exactly:
  // { code, publicKey, origin }. clientHint is an additive field the server
  // can use to pick the right sessionType for the response (additive,
  // backward-compatible — old servers ignore it and infer from the code).
  const res = await fetch(`${args.serverUrl}/sessions/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": ua,
    },
    body: JSON.stringify({
      code: args.code,
      publicKey: args.publicKey,
      origin: args.bundleId,
      clientHint: "native",
    }),
  });
  if (!res.ok) {
    throw new Error(`join failed: ${res.status}`);
  }
  return (await res.json()) as JoinSessionResponse;
}

export interface PeerHandle {
  send(msg: OutgoingMsg): void;
  close(): void;
}

export interface PeerCallbacks {
  onMessage(msg: IncomingMsg): void;
  onOpen(): void;
  onClose(): void;
}

// Establishes a WebRTC peer connection with the agent. The signaling channel
// is a WebSocket; offer/answer/ICE flow through it as JSON envelopes whose
// shape matches the published web SDK's wire format exactly:
//
//   {t: "sdp", kind: "offer"|"answer", sdp}
//   {t: "ice", candidate, sdpMid?, sdpMLineIndex?}
//   {t: "peer-left"} (incoming only)
//   {t: "error", code} (incoming only)
//
// The customer is the offerer (mirrors the published web SDK behavior — the
// dashboard agent is the answerer). This means the customer creates the
// data channel and offer, sends it through the WS as soon as the WS opens,
// and waits for the agent's answer before ICE candidates can flow.
export function connectPeer(
  deps: SignalingDeps,
  serverUrl: string,
  sessionId: string,
  iceServers: RTCIceServer[],
  cb: PeerCallbacks
): PeerHandle {
  const pc = new deps.RTCPeerConnection({ iceServers });
  const dc = pc.createDataChannel("sira", { ordered: true });

  dc.onopen = () => cb.onOpen();
  dc.onclose = () => cb.onClose();
  dc.onmessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data as string) as IncomingMsg;
      cb.onMessage(msg);
    } catch {
      // Ignore malformed payloads; the peer is the only sender on this
      // channel and should never produce non-JSON.
    }
  };

  const wsUrl = `${serverUrl.replace(/^http/, "ws")}/rtc?sid=${encodeURIComponent(sessionId)}&role=customer`;
  const ws = new WebSocket(wsUrl);

  const wsSend = (env: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
  };

  ws.onopen = async () => {
    // Customer is the offerer. The data channel is already created above,
    // so createOffer will include it in the SDP.
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ t: "sdp", kind: "offer", sdp: offer.sdp ?? "" });
    } catch {
      // Failure here means we can't negotiate — the dc.onclose path will
      // surface the closure to the SDK.
    }
  };

  ws.onmessage = async (ev: MessageEvent) => {
    let env: Record<string, unknown>;
    try { env = JSON.parse(ev.data as string); } catch { return; }
    switch (env.t) {
      case "sdp": {
        const kind = env.kind as "offer" | "answer";
        const sdp = (env.sdp as string) ?? "";
        await pc.setRemoteDescription({ type: kind, sdp });
        if (kind === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          wsSend({ t: "sdp", kind: "answer", sdp: answer.sdp ?? "" });
        }
        break;
      }
      case "ice": {
        const candidate = env.candidate as string | undefined;
        if (!candidate) return;
        try {
          await pc.addIceCandidate({
            candidate,
            sdpMid: (env.sdpMid as string) ?? undefined,
            sdpMLineIndex: (env.sdpMLineIndex as number) ?? undefined,
          });
        } catch {
          // Late candidates after close are expected; swallow.
        }
        break;
      }
      case "peer-left":
      case "error":
        cb.onClose();
        break;
    }
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    wsSend({
      t: "ice",
      candidate: ev.candidate.candidate,
      sdpMid: ev.candidate.sdpMid,
      sdpMLineIndex: ev.candidate.sdpMLineIndex,
    });
  };

  return {
    send(msg) {
      if (dc.readyState === "open") {
        dc.send(JSON.stringify(msg));
      }
    },
    close() {
      try { dc.close(); } catch {}
      try { pc.close(); } catch {}
      try { ws.close(); } catch {}
    },
  };
}
