#!/usr/bin/env node
// §7 — Wire-format snapshot. Any change to the field set / discriminator
// shape requires regenerating ci/protocol.snapshot.json by running:
//   UPDATE_SNAPSHOT=1 node ci/protocol-snapshot.js

const fs = require("node:fs");
const path = require("node:path");

const SNAPSHOT_PATH = path.join(__dirname, "protocol.snapshot.json");

const FIELDS = {
  frame: ["t", "seq", "ts", "webp", "w", "h"],
  viewport: ["t", "w", "h", "dpr", "platform"],
  pointer: ["t", "x", "y"],
  draw: ["t", "points", "color"],
  arrow: ["t", "x1", "y1", "x2", "y2", "color"],
  highlight: ["t", "x", "y", "w", "h", "color"],
  clear: ["t"],
  end: ["t", "reason"],
  ack: ["t", "seq"],
  joinResponse: ["sessionId", "iceServers", "sessionType"],
};

const current = JSON.stringify(FIELDS, null, 2);

if (process.env.UPDATE_SNAPSHOT === "1") {
  fs.writeFileSync(SNAPSHOT_PATH, current + "\n");
  console.log("snapshot updated");
  process.exit(0);
}

if (!fs.existsSync(SNAPSHOT_PATH)) {
  fs.writeFileSync(SNAPSHOT_PATH, current + "\n");
  console.log("snapshot created (first run)");
  process.exit(0);
}

const stored = fs.readFileSync(SNAPSHOT_PATH, "utf8").trim();
if (stored !== current.trim()) {
  console.error("✗ wire-format snapshot mismatch.");
  console.error("  If this is intentional, run: UPDATE_SNAPSHOT=1 node ci/protocol-snapshot.js");
  process.exit(1);
}
console.log("✓ wire format unchanged");
