export { SiraSupport, useSiraSupport } from "./SiraSupport";
export { configureTelemetry } from "./telemetry";
// Diagnostic-only — exposed so the test harness can render signaling state
// in a corner Text view for CI page-source dumps. Not part of the stable API.
export { getSignalingDiag, setSiraDiagEnabled } from "./session/signaling";
export type {
  SiraSupportProps,
  SiraSupportHandle,
  CaptureMode,
} from "./SiraSupport";

export { SiraSupportTrigger } from "./ui/SiraSupportTrigger";
export type { SiraSupportTriggerProps } from "./ui/SiraSupportTrigger";

export type { BannerTheme } from "./ui/ConsentBanner";
export type { SessionEndReason } from "./session/state";
export type {
  FrameMsg,
  ViewportMsg,
  AnnotationMsg,
  Platform,
  SessionType,
  JoinSessionResponse,
} from "./protocol/messages";
