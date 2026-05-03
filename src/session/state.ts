// Session state machine. Mirrors the web SDK's transitions:
//
//   idle → modal → connecting → live → idle
//
// Owned by the provider; integrators see only `idle` vs `live` via callbacks.

export type SessionState =
  | { kind: "idle" }
  | { kind: "modal" }
  | { kind: "priming"; sessionId: string }
  | { kind: "connecting"; sessionId: string }
  | { kind: "live"; sessionId: string }
  | { kind: "recovery"; sessionId: string }; // entire-screen-refused recovery

export type SessionEndReason =
  | "customer-ended"
  | "agent-ended"
  | "timeout"
  | "error"
  | "entire-screen-refused"
  // App backgrounded / user navigated away — distinct from "customer-ended"
  // (which implies an explicit End button) so integrators can tell the
  // difference in their telemetry.
  | "user-left";
