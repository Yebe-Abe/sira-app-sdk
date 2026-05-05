// Session state machine. Mirrors the web SDK's transitions:
//
//   idle → modal → (priming) → connecting → live → idle
//
// Owned by the provider; integrators see only `idle` vs `live` via callbacks.

export type SessionState =
  | { kind: "idle" }
  | { kind: "modal" }
  | { kind: "priming"; sessionId: string }
  | { kind: "connecting"; sessionId: string }
  | { kind: "live"; sessionId: string };

export type SessionEndReason =
  | "customer-ended"
  | "agent-ended"
  | "timeout"
  | "error";
