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
export type AnnotationMsg =
  | { t: "pointer"; x: number; y: number }
  | { t: "draw"; points: Array<{ x: number; y: number }>; color?: string }
  | { t: "arrow"; x1: number; y1: number; x2: number; y2: number; color?: string }
  | { t: "highlight"; x: number; y: number; w: number; h: number; color?: string }
  | { t: "clear" };

// Anything we receive on the data channel.
export type IncomingMsg = AnnotationMsg | { t: "end"; reason?: string };

// Anything we send on the data channel.
export type OutgoingMsg = FrameMsg | ViewportMsg | { t: "ack"; seq: number };

// Join response extension. Server returns this when the customer joins.
export interface JoinSessionResponse {
  sessionId: string;
  iceServers: RTCIceServer[];
  sessionType: SessionType;
}
