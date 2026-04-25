#!/usr/bin/env node
// §8 — Pull recent CI runs + Better Stack telemetry into a single JSON
// blob that telemetry-render.js consumes. Best-effort: degrades gracefully
// if any source is missing.

const fs = require("node:fs");

const GH = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || "Yebe-Abe/sira-app-sdk";
const BS_TOKEN = process.env.BETTERSTACK_TELEMETRY_TOKEN;
const BS_INGEST = process.env.BETTERSTACK_TELEMETRY_INGEST_URL;

async function ghRuns() {
  if (!GH) return { runs: [] };
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/runs?per_page=50`, {
    headers: { authorization: `Bearer ${GH}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) return { runs: [] };
  const j = await r.json();
  return {
    runs: (j.workflow_runs || []).map((w) => ({
      name: w.name, conclusion: w.conclusion, created_at: w.created_at,
      branch: w.head_branch, run_id: w.id,
    })),
  };
}

async function betterStack() {
  if (!BS_TOKEN || !BS_INGEST) return { events: [] };
  // Better Stack doesn't have a generic "fetch back" endpoint without the
  // Telemetry warehouse query API; this is a stub that fetches the most
  // recent count via the live tail endpoint when configured.
  return { events: [] };
}

(async () => {
  const data = { fetched_at: new Date().toISOString(), gh: await ghRuns(), bs: await betterStack() };
  fs.mkdirSync("telemetry", { recursive: true });
  fs.writeFileSync("telemetry/data.json", JSON.stringify(data, null, 2));
  console.log("telemetry/data.json written");
})();
