// Tiny fire-and-forget telemetry shim. If a Better Stack ingest URL +
// source token are configured at build time (or injected at runtime via
// configureTelemetry), the SDK ships session-lifecycle events. Otherwise
// it's a no-op — the SDK never crashes if telemetry isn't wired.

let endpoint: string | null = null;
let token: string | null = null;

export function configureTelemetry(url: string | null, sourceToken: string | null): void {
  endpoint = url;
  token = sourceToken;
}

export function emit(event: string, data: Record<string, unknown> = {}): void {
  if (!endpoint || !token) return;
  const body = JSON.stringify([
    { dt: new Date().toISOString(), message: event, level: "info", ...data, _source: "sira-sdk-rn" },
  ]);
  // Fire and forget — telemetry must never block or throw into user code.
  fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body,
  }).catch(() => {});
}
