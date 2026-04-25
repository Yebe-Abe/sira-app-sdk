#!/usr/bin/env node
// §9 — Bundle-size delta. Compares the about-to-publish tarball against
// the latest published version. Writes growth_pct to GITHUB_OUTPUT.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function size(file) {
  return fs.statSync(file).size;
}

function packLocal() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sira-pack-"));
  execSync(`npm pack --pack-destination ${tmp}`, { stdio: "inherit" });
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
  return path.join(tmp, files[0]);
}

function fetchPublished() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sira-pub-"));
  try {
    execSync(`npm pack @sira-screen-share/support-react-native@latest`, { cwd: tmp });
    const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
    return path.join(tmp, files[0]);
  } catch {
    return null;
  }
}

const local = packLocal();
const localSize = size(local);
console.log(`local tarball: ${(localSize / 1024).toFixed(1)} KB`);

const published = fetchPublished();
let growthPct = 0;
if (published) {
  const pubSize = size(published);
  console.log(`published:     ${(pubSize / 1024).toFixed(1)} KB`);
  growthPct = ((localSize - pubSize) / pubSize) * 100;
  console.log(`delta:         ${growthPct.toFixed(1)}%`);
} else {
  console.log("no prior published version — skipping delta");
}

const out = process.env.GITHUB_OUTPUT;
if (out) fs.appendFileSync(out, `growth_pct=${growthPct.toFixed(1)}\n`);
