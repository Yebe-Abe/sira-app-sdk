// Bridge to the native iOS / Android module. The TS surface is intentionally
// platform-agnostic; per-platform divergence (ReplayKit vs. PixelCopy vs.
// MediaProjection) lives in the native code.

import { NativeEventEmitter, NativeModules, Platform } from "react-native";

import type { Platform as ProtocolPlatform } from "../protocol/messages";

export type CaptureMode = "in-app" | "full-screen";

export interface StartCaptureOptions {
  captureMode: CaptureMode;
  // Pixel cap on the longer edge. The native side downscales before encoding.
  maxDimension: number;
  // Steady-state frame rate. The native side bursts up to maxFps on motion.
  targetFps: number;
  maxFps: number;
}

export type FrameEvent = {
  seq: number;
  ts: number;
  webp: string;
  w: number;
  h: number;
};

export type EntireScreenRefusedEvent = {
  // First frame's reported dimensions matched the device screen rather than
  // the app window. Native side has already stopped the projection.
  capturedW: number;
  capturedH: number;
  screenW: number;
  screenH: number;
};

export type CaptureStateEvent = {
  state: "starting" | "live" | "paused" | "stopped";
  reason?: string;
};

interface SiraSupportNativeModule {
  // Constants exposed by the native module. `bundleId` is the host app's
  // identifier (com.example.app or similar). Read once at module init.
  bundleId?: string;

  startCapture(options: StartCaptureOptions): Promise<void>;
  stopCapture(): Promise<void>;

  // Annotation overlay. The agent's draws/pointers are forwarded straight
  // through; the native side renders them on a transparent layer that does
  // not steal touches from the host app.
  showAnnotation(payload: string): void;
  clearAnnotations(): void;

  // Tells the overlay the dashboard's coordinate space (the same w/h that
  // were sent in the `viewport` message). Annotations arrive in viewport-
  // pixel space; the native overlay's actual canvas is decorView pixel
  // space, which can differ subtly (status-bar exclusion, rounding from
  // RN's `Dimensions` to Android's `decorView`, etc.). Without this, every
  // shape lands offset/scaled — the symptom we're fixing.
  setAnnotationViewport(w: number, h: number): void;

  // Required by Android MediaProjection: requests the system consent dialog.
  // Resolves true if the user granted, false on cancel. iOS implementation
  // is a no-op that resolves true. The captureMode argument tells the
  // native side whether to actually prompt — passing "in-app" makes it a
  // no-op that resolves true on both platforms.
  requestProjectionConsent(captureMode: CaptureMode): Promise<boolean>;
}

const LINKING_ERROR =
  `The native module 'SiraSupport' is not linked. Make sure you have:
  - rebuilt the app after installing the package
  - added the Expo config plugin to app.json (if using Expo)
  - run 'cd ios && pod install' (bare RN, iOS)`;

const NativeMod = NativeModules.SiraSupport as SiraSupportNativeModule | undefined;

export const SiraSupportNative: SiraSupportNativeModule = NativeMod
  ? NativeMod
  : (new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      }
    ) as SiraSupportNativeModule);

// NativeEventEmitter's constructor type varies between RN versions; the
// runtime accepts any object with addListener/removeListeners. Cast to the
// loose runtime contract rather than fighting TS across RN minor bumps.
type NativeEventEmitterArg = ConstructorParameters<typeof NativeEventEmitter>[0];
export const SiraSupportEvents = NativeMod
  ? new NativeEventEmitter(NativeMod as unknown as NativeEventEmitterArg)
  : null;

export const getBundleId = (): string => {
  // Falls back to "unknown" when the module isn't linked (Storybook, tests).
  return (NativeMod && NativeMod.bundleId) || "unknown";
};

export const currentPlatform = (): ProtocolPlatform => {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  // Fallback: this SDK is RN-only, but the type forces us to be exhaustive.
  return "android";
};
