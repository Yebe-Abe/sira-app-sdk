#!/usr/bin/env node
// §8 — Render the telemetry JSON to a static HTML dashboard.
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync("telemetry/data.json", "utf8"));

const runs = data.gh.runs;
const byName = {};
for (const r of runs) {
  byName[r.name] = byName[r.name] || { pass: 0, fail: 0 };
  if (r.conclusion === "success") byName[r.name].pass++;
  else if (r.conclusion === "failure") byName[r.name].fail++;
}

const rows = Object.entries(byName).map(([n, c]) => {
  const total = c.pass + c.fail;
  const rate = total ? ((c.pass / total) * 100).toFixed(1) : "—";
  return `<tr><td>${n}</td><td>${c.pass}</td><td>${c.fail}</td><td>${rate}%</td></tr>`;
}).join("");

process.stdout.write(`<!doctype html>
<meta charset="utf-8" />
<title>sira-app-sdk telemetry</title>
<style>
  body { font: 14px -apple-system, sans-serif; margin: 40px; max-width: 900px; color: #222; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .ts { color: #888; font-size: 12px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { background: #fafafa; font-weight: 600; }
</style>
<h1>sira-app-sdk CI rollup</h1>
<div class="ts">fetched ${data.fetched_at}</div>
<table>
  <thead><tr><th>workflow</th><th>pass</th><th>fail</th><th>success rate</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="4">no runs yet</td></tr>`}</tbody>
</table>
`);
