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
import { connectPeer, joinSession, siraDiag, SiraJoinError, type PeerHandle, type SignalingDeps } from "./session/signaling";
import { CodeEntryModal } from "./ui/CodeEntryModal";
import { ConsentBanner, type BannerTheme } from "./ui/ConsentBanner";
import { PrimingScreen } from "./ui/PrimingScreen";
import { RecoveryScreen } from "./ui/RecoveryScreen";

// Default URL matches the published web SDK so a bare <SiraSupport
// publicKey="..." /> works out of the box against the existing backend.
// publicKey has NO default — every integrator must pass their own. The
// previous "pk_test" default was a CI convenience that would have shipped
// a shared key into every customer app; we throw on use without one.
const DEFAULT_SERVER_URL = "https://sira-support-api-production.up.railway.app";

// Gate diagnostic console.warns added during CI bring-up. Set the env via
// EXPO_PUBLIC_SIRA_DEBUG=1 (or the bare-RN equivalent) when iterating; off
// by default so production users don't see SDK warnings in their console.
const debugLog = (msg: string, ...rest: unknown[]): void => {
  const enabled =
    typeof process !== "undefined" &&
    process.env &&
    (process.env.EXPO_PUBLIC_SIRA_DEBUG === "1" || process.env.SIRA_DEBUG === "1");
  if (enabled) {
    // eslint-disable-next-line no-console
    console.warn(msg, ...rest);
  }
};

export type CaptureMode = "in-app" | "full-screen";

export interface SiraSupportProps {
  // Required. Sira-issued public key (pk_live_<slug> for production,
  // pk_test / pk_demo for localhost/staging).
  //
  // Unlike the web SDK, there's no production default: the web SDK ships
  // `pk_live_sira` because that key's allowlist is `https://sira.team`,
  // which only sira.team's own browser frontend ever sends. Mobile apps
  // send their bundle ID (e.g. `com.acme.payroll`) as the origin, so a
  // production mobile integration must use a key Sira has provisioned
  // against the integrator's bundle ID — there is no sensible shared
  // default. Use `pk_test` (server-side allowlists localhost ports) for
  // development, unsigned simulator builds, and the shipped harness.
  publicKey: string;
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
  onSessionEnd?: (reason: SessionEndReason, sessionId: string | null, details?: string) => void;

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

// Used by <SiraRedact> to know whether to render its black mask overlay.
// True iff a session is in any state where frames could be sent to an
// agent (live, or transitioning into live). False the rest of the time so
// the customer sees their own PII normally.
export function useIsLiveSession(): boolean {
  const ctx = useContext(Ctx);
  if (!ctx) return false;
  return ctx.state.kind === "live" || ctx.state.kind === "connecting";
}

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
  publicKey,
  serverUrl = DEFAULT_SERVER_URL,
  android = {},
  mask = {},
  banner,
  appName = "this app",
  onSessionStart,
  onSessionEnd,
  children,
}) => {
  if (!publicKey) {
    throw new Error(
      "@sira-screen-share/support-react-native: <SiraSupport publicKey> is required. " +
      "Use \"pk_test\" or \"pk_demo\" for development, or a `pk_live_<slug>` key " +
      "Sira has provisioned for your bundle ID for production."
    );
  }
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
    (reason: SessionEndReason, details?: string) => {
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
      emitTelemetry("session_end", { reason, sessionId: sid, details });
      onSessionEnd?.(reason, sid, details);
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
    let recv = 0;
    let sent = 0;
    const sub = SiraSupportEvents.addListener("SiraFrame", (ev) => {
      recv++;
      const f: FrameMsg = {
        t: "frame",
        seq: seqRef.current++,
        ts: Date.now(),
        webp: ev.webp,
        w: ev.w,
        h: ev.h,
      };
      try {
        peerRef.current?.send(f);
        sent++;
      } catch {
        // ignore — diag will reflect the gap (recv > sent)
      }
      // Append to the signaling-diag accumulator so CI page-source dumps
      // include native-frame stats alongside the WS/ICE/SDP timeline.
      // Only diag every Nth frame to avoid 800-char overrun in steady
      // state; first frame is always diagged so we know capture started.
      if (recv === 1 || recv % 30 === 0) {
        siraDiag(`frame recv=${recv} sent=${sent}`);
      }
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
      try {
        // Server populates sessionType from our clientHint='native', so it
        // should always come back as 'native'. We still tolerate undefined
        // for backward compat with older server deployments — bail only on
        // an explicit 'web', which would mean the code was minted from the
        // dashboard for a web customer.
        if (sessionType === "web") {
          const msg = "This code is for a web session.";
          setError(msg);
          endInternal("error", msg);
          return;
        }

        // Order matters on Android: the system MediaProjection dialog
        // backgrounds our app, and without a foreground service Android
        // will close the WebSocket out from under us. So we run consent +
        // startCapture FIRST (which starts the foreground service), then
        // connectPeer once we're stable in the foreground again.
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

        const deps = resolveRTCDeps();
        const peer = connectPeer(deps, serverUrl, sessionId, iceServers, {
          onMessage: onIncoming,
          onOpen: () => {
            const v: ViewportMsg = {
              t: "viewport",
              w: 0,
              h: 0,
              dpr: 1,
              platform: currentPlatform(),
            };
            peer.send(v);
          },
          onClose: () => endInternal("error", "WebSocket closed unexpectedly"),
        });
        peerRef.current = peer;

        setState({ kind: "live", sessionId });
        resetTimeout();
        emitTelemetry("session_start", { sessionId, captureMode });
        onSessionStart?.(sessionId);
      } catch (e) {
        // Caller (PrimingScreen onContinue) doesn't await us, so any throw
        // would silently leak the connecting state. Surface the error and
        // tear down the session.
        const msg = e instanceof Error ? e.message : "startCapture failed";
        
        debugLog("[SiraSupport] startCaptureFlow failed:", msg);
        setError(msg);
        endInternal("error", msg);
      }
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
        // Two strings, two audiences:
        //   userMessage → end-user copy rendered in the modal
        //                 ("That code wasn't recognized…")
        //   details     → integrator-facing technical detail, sent to
        //                 onSessionEnd for telemetry/logs
        //                 ("HTTP 400 not_found")
        // SiraJoinError carries both. Anything else is a bug we didn't
        // map yet; show generic copy + the raw message in details.
        const userMessage = e instanceof SiraJoinError
          ? e.userMessage
          : "Something went wrong. Please try again.";
        const details = e instanceof SiraJoinError
          ? e.details
          : (e instanceof Error ? e.message : "Connection failed.");
        debugLog("[SiraSupport] submitCode failed:", details);
        setError(userMessage);
        endInternal("error", details);
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
          
          debugLog("[SiraSupport] priming Continue tapped, state=", state.kind, "pending?", !!pendingJoinRef.current);
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
