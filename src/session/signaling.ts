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

  const res = await fetch(`${args.serverUrl}/sessions/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sira-key": args.publicKey,
      "user-agent": ua,
    },
    body: JSON.stringify({
      code: args.code,
      origin: args.bundleId,
      // Hint to the server so it returns the correct sessionType. The server
      // is the source of truth — it will overwrite if the code maps to a
      // different session kind.
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
// shape matches the existing web SDK's contract.
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

  const ws = new WebSocket(
    `${serverUrl.replace(/^http/, "ws")}/rtc?sid=${encodeURIComponent(sessionId)}&role=customer`
  );

  ws.onmessage = async (ev: MessageEvent) => {
    const env = JSON.parse(ev.data as string) as
      | { kind: "offer"; sdp: string }
      | { kind: "answer"; sdp: string }
      | { kind: "ice"; candidate: RTCIceCandidateInit };
    if (env.kind === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: env.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ kind: "answer", sdp: answer.sdp }));
    } else if (env.kind === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: env.sdp });
    } else if (env.kind === "ice" && env.candidate) {
      try {
        await pc.addIceCandidate(env.candidate);
      } catch {
        // Late candidates after close are expected; swallow.
      }
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ kind: "ice", candidate: ev.candidate.toJSON() }));
    }
  };

  return {
    send(msg) {
      if (dc.readyState === "open") {
        dc.send(JSON.stringify(msg));
      }
    },
    close() {
      try {
        dc.close();
      } catch {}
      try {
        pc.close();
      } catch {}
      try {
        ws.close();
      } catch {}
    },
  };
}
