// Wire-format additions for the native SDK. These are the three changes
// described in section 6 of the spec, expressed as TypeScript types.
//
// They are additive to the existing `@sira/shared` discriminated unions; the
// native SDK consumes them locally and the server propagates them unchanged.

export type Platform = "web" | "ios" | "android";
export type SessionType = "web" | "native";

// New stream message variant. Discriminator `t: "frame"` is distinct from the
// existing rrweb `t: "rrweb"` variant, so the union remains unambiguous.
export interface FrameMsg {
  t: "frame";
  // Monotonic per-session sequence. Receivers drop frames with seq < last seq.
  seq: number;
  // Capture timestamp in ms since epoch (sender clock).
  ts: number;
  // Base64-encoded WebP bytes. Native encoders write directly to base64 to
  // avoid an extra copy when serializing to the data channel.
  webp: string;
  w: number;
  h: number;
}

// Existing viewport message, extended with `platform`. The dashboard reads
// this to pick portrait vs. landscape framing on the native viewer.
export interface ViewportMsg {
  t: "viewport";
  w: number;
  h: number;
  dpr: number;
  platform: Platform;
}

// Annotation messages flow agent → customer. Coordinates are viewport-pixel,
// matching the dimensions reported in the most recent ViewportMsg.
//
// Shape mirrors the server's @sira/shared `AnnotationMsg` Zod schema
// (packages/shared/src/protocol.ts) — that is the contract the dashboard
// emits against. The previous local definition diverged (`points` /
// `x1,y1,x2,y2` / `x,y,w,h`) and the native parsers silently dropped every
// shape but `pointer`. Coordinates are tuples (`[x, y]`) for compactness on
// the wire — the JSON-stringified payload is shorter than the object form
// for paths with hundreds of points.
export type AnnotationMsg =
  | { t: "pointer"; x: number; y: number; ts: number }
  | { t: "draw"; id: string; path: Array<[number, number]>; color: string }
  | { t: "arrow"; id: string; from: [number, number]; to: [number, number]; color: string }
  | { t: "highlight"; id: string; rect: [number, number, number, number]; color: string }
  | { t: "clear"; ids?: string[] };

// Anything we receive on the data channel.
export type IncomingMsg = AnnotationMsg | { t: "end"; reason?: string };

// Anything we send on the data channel.
//
// The `end` variant is sent when the customer SDK ends the session
// intentionally — currently only when the customer taps the End button
// in the consent banner. The dashboard, on receipt, closes its peer
// immediately rather than waiting for the reconnect timer.
export type OutgoingMsg =
  | FrameMsg
  | ViewportMsg
  | { t: "ack"; seq: number }
  | { t: "end"; reason?: string };

// Join response extension. Server returns this when the customer joins.
export interface JoinSessionResponse {
  sessionId: string;
  iceServers: RTCIceServer[];
  sessionType: SessionType;
}
