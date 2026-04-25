// The root provider. Mounted once at the app root. Renders nothing until a
// session starts; while live, renders the in-session consent banner over
// the host app and routes agent annotations to the native overlay.
//
// Owns the entire `idle → modal → priming → connecting → live → recovery`
// state machine. Integrators see only `onSessionStart` / `onSessionEnd`.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";

import { AnnotationBridge } from "./annotation/AnnotationOverlay";
import { SiraSupportEvents, SiraSupportNative, currentPlatform, getBundleId } from "./native/SiraSupportModule";
import type {
  AnnotationMsg,
  FrameMsg,
  IncomingMsg,
  SessionType,
  ViewportMsg,
} from "./protocol/messages";
import type { SessionEndReason, SessionState } from "./session/state";
import { emit as emitTelemetry } from "./telemetry";
import { connectPeer, joinSession, type PeerHandle, type SignalingDeps } from "./session/signaling";
import { CodeEntryModal } from "./ui/CodeEntryModal";
import { ConsentBanner, type BannerTheme } from "./ui/ConsentBanner";
import { PrimingScreen } from "./ui/PrimingScreen";
import { RecoveryScreen } from "./ui/RecoveryScreen";

// Same default as the published web SDK so a bare <SiraSupport /> works
// out of the box for the existing Sira backend.
const DEFAULT_SERVER_URL = "https://sira-support-api-production.up.railway.app";
const DEFAULT_TEST_KEY = "pk_test";

export type CaptureMode = "in-app" | "full-screen";

export interface SiraSupportProps {
  publicKey?: string;
  serverUrl?: string;

  android?: {
    captureMode?: CaptureMode;
    priming?: boolean;
  };

  mask?: {
    secureTextEntryAuto?: boolean;
    testIDPatterns?: string[];
  };

  banner?: BannerTheme;

  appName?: string; // for priming / recovery copy

  onSessionStart?: (sessionId: string) => void;
  onSessionEnd?: (reason: SessionEndReason, sessionId: string | null) => void;

  children?: React.ReactNode;
}

export interface SiraSupportHandle {
  openCodeEntry(): void;
  end(): void;
}

interface SiraSupportContextValue {
  handle: SiraSupportHandle;
  state: SessionState;
}

const Ctx = createContext<SiraSupportContextValue | null>(null);

// Allow `react-native-webrtc` to be injected at runtime so the SDK can be
// imported in environments without it (Storybook, unit tests). The provider
// resolves the import lazily so missing peer deps fail loudly only when a
// session is actually started.
function resolveRTCDeps(): SignalingDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rtc = require("react-native-webrtc") as { RTCPeerConnection: typeof RTCPeerConnection };
  return { RTCPeerConnection: rtc.RTCPeerConnection };
}

export const SiraSupport: React.FC<SiraSupportProps> = ({
  publicKey = DEFAULT_TEST_KEY,
  serverUrl = DEFAULT_SERVER_URL,
  android = {},
  mask = {},
  banner,
  appName = "this app",
  onSessionStart,
  onSessionEnd,
  children,
}) => {
  const captureMode: CaptureMode = android.captureMode ?? "in-app";
  const priming = android.priming ?? true;
  const secureTextEntryAuto = mask.secureTextEntryAuto ?? true;
  const testIDPatterns = mask.testIDPatterns ?? [];

  const [state, setState] = useState<SessionState>({ kind: "idle" });
  const [error, setError] = useState<string | undefined>();
  const peerRef = useRef<PeerHandle | null>(null);
  const seqRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    // Auto-end after 10 minutes of agent inactivity.
    timeoutRef.current = setTimeout(() => endInternal("timeout"), 10 * 60 * 1000);
  }, []);

  const endInternal = useCallback(
    (reason: SessionEndReason) => {
      const sid = "sessionId" in state ? state.sessionId : null;
      try {
        peerRef.current?.close();
      } catch {}
      peerRef.current = null;
      try {
        SiraSupportNative.stopCapture();
      } catch {}
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setState({ kind: "idle" });
      emitTelemetry("session_end", { reason, sessionId: sid });
      onSessionEnd?.(reason, sid);
    },
    [state, onSessionEnd]
  );

  const onIncoming = useCallback(
    (msg: IncomingMsg) => {
      resetTimeout();
      if (msg.t === "end") {
        endInternal("agent-ended");
        return;
      }
      AnnotationBridge.apply(msg as AnnotationMsg);
    },
    [endInternal, resetTimeout]
  );

  // Native frame-event subscription. Each frame from the OS encoder gets
  // shipped as a FrameMsg over the data channel.
  useEffect(() => {
    if (!SiraSupportEvents) return;
    const sub = SiraSupportEvents.addListener("SiraFrame", (ev) => {
      const f: FrameMsg = {
        t: "frame",
        seq: seqRef.current++,
        ts: Date.now(),
        webp: ev.webp,
        w: ev.w,
        h: ev.h,
      };
      peerRef.current?.send(f);
    });
    return () => sub.remove();
  }, []);

  // The Android-specific "Entire screen" guardrail: native side fires this
  // event when the first frame's dimensions match the device screen rather
  // than the app window. We tear down capture and switch to recovery.
  useEffect(() => {
    if (!SiraSupportEvents) return;
    const sub = SiraSupportEvents.addListener("SiraEntireScreenRefused", () => {
      try {
        peerRef.current?.close();
      } catch {}
      peerRef.current = null;
      try {
        SiraSupportNative.stopCapture();
      } catch {}
      const sid = "sessionId" in state ? state.sessionId : null;
      if (sid) {
        setState({ kind: "recovery", sessionId: sid });
      }
      onSessionEnd?.("entire-screen-refused", sid);
    });
    return () => sub.remove();
  }, [onSessionEnd, state]);

  const startCaptureFlow = useCallback(
    async (sessionId: string, sessionType: SessionType, iceServers: RTCIceServer[]) => {
      if (sessionType !== "native") {
        setError("This code is for a web session.");
        endInternal("error");
        return;
      }

      const deps = resolveRTCDeps();
      const peer = connectPeer(deps, serverUrl, sessionId, iceServers, {
        onMessage: onIncoming,
        onOpen: () => {
          // Send initial viewport. Frame dimensions will follow.
          const v: ViewportMsg = {
            t: "viewport",
            w: 0, // filled in by native module before first frame
            h: 0,
            dpr: 1,
            platform: currentPlatform(),
          };
          peer.send(v);
        },
        onClose: () => endInternal("error"),
      });
      peerRef.current = peer;

      // Android full-screen mode requires explicit consent. iOS resolves true
      // immediately. The priming screen (if enabled) was already shown.
      const effectiveMode: CaptureMode = Platform.OS === "ios" ? "in-app" : captureMode;
      const granted = await SiraSupportNative.requestProjectionConsent(effectiveMode);
      if (!granted) {
        endInternal("customer-ended");
        return;
      }

      await SiraSupportNative.startCapture({
        captureMode: effectiveMode,
        maxDimension: 1280,
        targetFps: 8,
        maxFps: 15,
        testIDPatterns,
        redactSecureTextEntry: secureTextEntryAuto,
      });

      setState({ kind: "live", sessionId });
      resetTimeout();
      emitTelemetry("session_start", { sessionId, captureMode });
      onSessionStart?.(sessionId);
    },
    [captureMode, endInternal, onIncoming, onSessionStart, resetTimeout, secureTextEntryAuto, serverUrl, testIDPatterns]
  );

  const submitCode = useCallback(
    async (code: string) => {
      setError(undefined);
      try {
        // We use the application bundle ID as the origin for parity with the
        // web SDK's `origin` field. Native side could expose this; for now
        // the public key is the integrator identity and we send a placeholder.
        const join = await joinSession({
          serverUrl,
          publicKey,
          code,
          bundleId: getBundleId(),
        });

        if (Platform.OS === "android" && captureMode === "full-screen" && priming) {
          setState({ kind: "priming", sessionId: join.sessionId });
          // The priming screen's Continue button advances to startCaptureFlow.
          // We stash join data on a ref so Continue can use it.
          pendingJoinRef.current = { sessionType: join.sessionType, iceServers: join.iceServers };
          return;
        }

        setState({ kind: "connecting", sessionId: join.sessionId });
        await startCaptureFlow(join.sessionId, join.sessionType, join.iceServers);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Connection failed.");
        endInternal("error");
      }
    },
    [captureMode, endInternal, priming, publicKey, serverUrl, startCaptureFlow]
  );

  const pendingJoinRef = useRef<{ sessionType: SessionType; iceServers: RTCIceServer[] } | null>(null);

  const handle = useMemo<SiraSupportHandle>(
    () => ({
      openCodeEntry() {
        if (state.kind === "idle") setState({ kind: "modal" });
      },
      end() {
        if (state.kind === "live" || state.kind === "connecting" || state.kind === "priming") {
          endInternal("customer-ended");
        }
      },
    }),
    [endInternal, state.kind]
  );

  const ctx = useMemo<SiraSupportContextValue>(() => ({ handle, state }), [handle, state]);

  return (
    <Ctx.Provider value={ctx}>
      {children}

      <CodeEntryModal
        visible={state.kind === "modal"}
        error={error}
        onSubmit={submitCode}
        onCancel={() => setState({ kind: "idle" })}
      />

      <PrimingScreen
        visible={state.kind === "priming"}
        appName={appName}
        onContinue={() => {
          if (state.kind !== "priming") return;
          const pending = pendingJoinRef.current;
          if (!pending) return;
          setState({ kind: "connecting", sessionId: state.sessionId });
          startCaptureFlow(state.sessionId, pending.sessionType, pending.iceServers);
        }}
        onCancel={() => endInternal("customer-ended")}
      />

      <RecoveryScreen
        visible={state.kind === "recovery"}
        appName={appName}
        onTryAgain={() => {
          if (state.kind !== "recovery") return;
          const pending = pendingJoinRef.current;
          if (!pending) return;
          setState({ kind: "connecting", sessionId: state.sessionId });
          startCaptureFlow(state.sessionId, pending.sessionType, pending.iceServers);
        }}
        onCancel={() => endInternal("customer-ended")}
      />

      {state.kind === "live" ? (
        <ConsentBanner theme={banner} onEnd={() => endInternal("customer-ended")} />
      ) : null}
    </Ctx.Provider>
  );
};

export function useSiraSupport(): SiraSupportHandle {
  const ctx = useContext(Ctx);
  // Pre-mount calls return no-ops, per the spec.
  if (!ctx) {
    return {
      openCodeEntry() {},
      end() {},
    };
  }
  return ctx.handle;
}
