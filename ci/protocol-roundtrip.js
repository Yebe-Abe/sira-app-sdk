#!/usr/bin/env node
// §7 — Protocol round-trip. Validates every message variant survives
// JSON.stringify → JSON.parse with structural identity, and that no field
// is silently dropped or coerced.

const SAMPLES = {
  frame: { t: "frame", seq: 1, ts: 1700000000000, webp: "AAAA", w: 720, h: 1280 },
  viewport: { t: "viewport", w: 720, h: 1280, dpr: 3, platform: "ios" },
  pointer: { t: "pointer", x: 100, y: 200 },
  draw: { t: "draw", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], color: "#f00" },
  arrow: { t: "arrow", x1: 0, y1: 0, x2: 10, y2: 10, color: "#0f0" },
  highlight: { t: "highlight", x: 5, y: 5, w: 50, h: 50 },
  clear: { t: "clear" },
  end: { t: "end", reason: "agent-ended" },
  ack: { t: "ack", seq: 42 },
};

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEq(a[k], b[k]));
  }
  return false;
}

let failed = 0;
for (const [name, msg] of Object.entries(SAMPLES)) {
  const round = JSON.parse(JSON.stringify(msg));
  if (!deepEq(msg, round)) {
    console.error(`✗ ${name}: round-trip changed shape`);
    console.error("  before:", msg);
    console.error("  after: ", round);
    failed++;
  } else {
    console.log(`✓ ${name}`);
  }
}
process.exit(failed ? 1 : 0);
