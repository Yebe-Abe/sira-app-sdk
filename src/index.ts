export { SiraSupport, useSiraSupport } from "./SiraSupport";
export { configureTelemetry } from "./telemetry";
export type {
  SiraSupportProps,
  SiraSupportHandle,
  CaptureMode,
} from "./SiraSupport";

export { SiraRedact } from "./redaction/SiraRedact";
export type { SiraRedactProps } from "./redaction/SiraRedact";

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
