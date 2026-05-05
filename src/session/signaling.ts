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
  let res: Response;
  try {
    res = await fetch(`${args.serverUrl}/sessions/join`, {
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
  } catch (e) {
    // fetch() throws on network failure (DNS, no internet, TLS, etc.).
    throw new SiraJoinError(
      "Couldn't reach Sira. Check your connection and try again.",
      `network: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    // Server returns {"error": "<machine_code>"} for known failures.
    let serverCode = "";
    try { serverCode = (await res.json())?.error ?? ""; } catch { /* not JSON */ }
    throw new SiraJoinError(userMessageFor(res.status, serverCode), `HTTP ${res.status} ${serverCode}`);
  }
  return (await res.json()) as JoinSessionResponse;
}

// SiraJoinError carries two strings: a friendly user-facing message
// (rendered in the code-entry modal) and a technical detail string
// (forwarded to onSessionEnd for the integrator's telemetry / logs).
// Surfacing "HTTP 400 not_found" to a non-technical end user is bad
// UX; surfacing only "Try again" to the integrator is bad observability.
export class SiraJoinError extends Error {
  readonly userMessage: string;
  readonly details: string;
  constructor(userMessage: string, details: string) {
    super(userMessage);
    this.userMessage = userMessage;
    this.details = details;
  }
}

function userMessageFor(status: number, serverCode: string): string {
  // Server's machine codes for /sessions/join failures, mapped to
  // strings the user can act on. Keep these short and concrete —
  // they render below the code input field on a small screen.
  if (serverCode === "not_found")  return "That code wasn't recognized. Double-check the digits and try again.";
  if (serverCode === "expired")    return "This support code has expired. Ask your agent for a new one.";
  if (serverCode === "invalid_code") return "That doesn't look like a valid 6-digit code.";
  if (serverCode === "in_use")     return "This code is already in use. Ask your agent for a new one.";
  if (status === 401 || status === 403) return "This app isn't set up to use Sira support. Please contact support.";
  if (status >= 500) return "Sira is temporarily unavailable. Please try again in a moment.";
  return "Something went wrong. Please try again.";
}

export interface PeerHandle {
  // Returns true iff the message was actually written to the data channel.
  // False if the channel isn't open yet (caller should NOT count this as a
  // successful send — see SiraSupport.tsx's frame counter).
  send(msg: OutgoingMsg): boolean;
  close(): void;
}

export interface PeerCallbacks {
  onMessage(msg: IncomingMsg): void;
  onOpen(): void;
  onClose(): void;
}

// Diagnostic accumulator. Off by default — production users pay zero
// cost. Integrators can flip it on at runtime via `setSiraDiagEnabled(true)`
// or by setting EXPO_PUBLIC_SIRA_DEBUG=1 / SIRA_DEBUG=1 at bundle time.
let DIAG_ENABLED =
  typeof process !== "undefined" &&
  process.env &&
  (process.env.EXPO_PUBLIC_SIRA_DEBUG === "1" || process.env.SIRA_DEBUG === "1");

export function setSiraDiagEnabled(on: boolean): void {
  DIAG_ENABLED = on;
}
// Two separate buffers so frame-counter spam can never evict signaling
// events. Signaling events (ws-open, offer-sent, rcv:sdp, dc-open, ws-close,
// pc:*) are the load-bearing ones for debugging connection failures —
// frame counts are nice-to-have. Renderers should show signaling on top.
let signalingTail = "";
let frameTail = "";
function pushDiag(buf: string, s: string, max: number): string {
  return `${buf.slice(-max)} | ${s}`.trim();
}
export function getSignalingDiag(): string {
  if (!DIAG_ENABLED) return "";
  // Render signaling first (more important), then frame stats.
  return [signalingTail, frameTail].filter(Boolean).join("  ·  ");
}
function diag(s: string): void {
  if (!DIAG_ENABLED) return;
  // ~16 signaling events.
  signalingTail = pushDiag(signalingTail, s, 800);
}

// Frame-stat diag from SiraSupport.tsx's SiraFrame listener. Kept in its
// own buffer so frame logs can never evict the signaling timeline.
export function siraFrameDiag(s: string): void {
  if (!DIAG_ENABLED) return;
  frameTail = pushDiag(frameTail, s, 80); // just the most-recent count line
}

// Backwards-compatible alias. Anything calling this should be a signaling
// event; if you're logging frames, call siraFrameDiag.
export function siraDiag(s: string): void { diag(s); }

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
// 30s grace before truly ending on a transient WebRTC failure. The product
// requirement is "session only ends when customer or agent explicitly ends,
// or after 30s of confirmed dead connection." This holds the session
// through brief network blips (subway tunnels, cell handoffs, WiFi → LTE
// switches). The dashboard has its own ~10s grace, so the effective end-
// to-end recovery window is bounded by whichever is shorter — fixing the
// dashboard side is a separate workstream.
const NETWORK_GRACE_MS = 30_000;

export function connectPeer(
  deps: SignalingDeps,
  serverUrl: string,
  sessionId: string,
  iceServers: RTCIceServer[],
  cb: PeerCallbacks
): PeerHandle {
  const pc = new deps.RTCPeerConnection({ iceServers });
  const dc = pc.createDataChannel("sira", { ordered: true });

  // 30s grace state. Single timer; idempotent scheduling.
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const scheduleEnd = (reason: string): void => {
    if (closed) return;
    if (graceTimer != null) return;
    diag(`grace-start:${reason}`);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (closed) return;
      closed = true;
      diag(`grace-expired:${reason}`);
      cb.onClose();
    }, NETWORK_GRACE_MS);
  };
  const cancelEnd = (): void => {
    if (graceTimer != null) {
      clearTimeout(graceTimer);
      graceTimer = null;
      diag("grace-cancel");
    }
  };
  const endNow = (reason: string): void => {
    if (closed) return;
    closed = true;
    cancelEnd();
    diag(`end-now:${reason}`);
    cb.onClose();
  };

  // Surface peer-connection lifecycle + drive the grace timer. ICE
  // briefly going `disconnected` is normal during cell handoffs / NAT
  // rebinding; we don't want to kill a healthy session for that. Only
  // commit to ending if it stays bad for the full grace window.
  pc.onconnectionstatechange = () => {
    diag(`pc:${pc.connectionState}`);
    switch (pc.connectionState) {
      case "connected":
        cancelEnd();
        break;
      case "disconnected":
      case "failed":
        scheduleEnd(`pc:${pc.connectionState}`);
        break;
      case "closed":
        // Local pc.close() — happens via peer.close() (cb.onClose
        // already fired by that path) or as a cascade from dc.close().
        endNow("pc:closed");
        break;
    }
  };

  dc.onopen = () => {
    diag("dc-open");
    cb.onOpen();
  };
  dc.onclose = () => {
    diag("dc-close");
    // Same 30s grace. dc.onclose can fire during transient pc failure
    // before the pc state machine has caught up; gracing here means we
    // don't double-trigger the close path on a temporary blip.
    scheduleEnd("dc-close");
  };
  dc.onmessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data as string) as IncomingMsg;
      cb.onMessage(msg);
    } catch (e) {
      // Defensive: agent should never send non-JSON, but a buggy/compromised
      // peer can. Surface via diag() in debug builds; silently drop in prod
      // (we don't want a malformed message to take down the SDK).
      diag(`dc-bad-json:${(e as Error).message?.slice(0, 40) ?? "?"}`);
    }
  };

  const wsUrl = `${serverUrl.replace(/^http/, "ws")}/rtc?sid=${encodeURIComponent(sessionId)}&role=customer`;
  const ws = new WebSocket(wsUrl);

  const wsSend = (env: Record<string, unknown>): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
  };

  ws.onopen = async () => {
    diag("ws-open");
    try {
      const offer = await pc.createOffer();
      diag("offer-made");
      await pc.setLocalDescription(offer);
      diag("local-desc-set");
      wsSend({ t: "sdp", kind: "offer", sdp: offer.sdp ?? "" });
      diag("offer-sent");
    } catch (e) {
      diag(`offer-err:${(e as Error).message?.slice(0, 60) ?? e}`);
    }
  };

  ws.onerror = () => diag("ws-err");
  ws.onclose = (ev: CloseEvent) => diag(`ws-close:${ev.code}:${(ev.reason || "").slice(0, 60)}`);

  let iceRcvCount = 0;
  ws.onmessage = async (ev: MessageEvent) => {
    let env: Record<string, unknown>;
    try { env = JSON.parse(ev.data as string); } catch { return; }
    switch (env.t) {
      case "sdp": {
        const kind = env.kind as "offer" | "answer";
        diag(`rcv:sdp:${kind}`);
        const sdp = (env.sdp as string) ?? "";
        await pc.setRemoteDescription({ type: kind, sdp });
        if (kind === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          wsSend({ t: "sdp", kind: "answer", sdp: answer.sdp ?? "" });
          diag("snd:sdp:answer");
        }
        break;
      }
      case "ice": {
        const candidate = env.candidate as string | undefined;
        if (!candidate) return;
        iceRcvCount++;
        // Log only the first ICE candidate (so we know flow started) and
        // every 5th thereafter — they can come in bursts of 10+ and would
        // crowd out signaling events without rate-limiting.
        if (iceRcvCount === 1 || iceRcvCount % 5 === 0) {
          diag(`rcv:ice#${iceRcvCount}`);
        }
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
        diag("rcv:peer-left");
        // Agent's signaling WS dropped — could be a transient cloud-WS
        // blip or the agent really left. Grace before tearing down so a
        // brief agent-side blip doesn't kill an otherwise healthy
        // WebRTC data channel.
        scheduleEnd("peer-left");
        break;
      case "error":
        diag(`rcv:error:${env.code as string}:${(env.message as string ?? "").slice(0, 80)}`);
        // Server explicitly told us the session is bad (auth failure,
        // session ended on agent side, etc.). No grace — end immediately.
        endNow(`error:${env.code as string}`);
        break;
      default:
        diag(`rcv:${env.t as string}`);
    }
  };

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    // Server's Zod schema requires sdpMid/sdpMLineIndex as nullable — they
    // must be PRESENT (can be null, can't be undefined). JSON.stringify
    // drops undefineds, so coerce explicitly or the message fails
    // validation and the server closes the WS.
    wsSend({
      t: "ice",
      candidate: ev.candidate.candidate,
      sdpMid: ev.candidate.sdpMid ?? null,
      sdpMLineIndex: ev.candidate.sdpMLineIndex ?? null,
    });
  };

  return {
    send(msg) {
      if (dc.readyState !== "open") return false;
      try {
        dc.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    },
    close() {
      // Caller-initiated teardown — bypass the grace timer. Setting
      // `closed` first means the dc.onclose / pc.onconnectionstatechange
      // handlers triggered by the close() calls below will see closed=true
      // and bail (so cb.onClose is fired exactly once).
      if (closed) return;
      closed = true;
      cancelEnd();
      try { dc.close(); } catch {}
      try { pc.close(); } catch {}
      try { ws.close(); } catch {}
      cb.onClose();
    },
  };
}
