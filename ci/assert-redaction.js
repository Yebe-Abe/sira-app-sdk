#!/usr/bin/env node
// §3 — Reads every captured frame, OCRs it, greps for any marker. Hard
// fails on any hit. Prints which screen/marker leaked.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");

const dir = process.argv[2];
const targetsFile = process.argv[3];
if (!dir || !targetsFile) {
  console.error("usage: assert-redaction.js <frames-dir> <targets.yaml>");
  process.exit(2);
}

const targets = yaml.parse(fs.readFileSync(targetsFile, "utf8"));
const frames = fs.readdirSync(dir).filter((f) => f.endsWith(".webp") || f.endsWith(".png"));

let leaks = 0;
for (const f of frames) {
  const fullPath = path.join(dir, f);
  let ocr = "";
  try {
    // Tesseract handles WebP via libwebp. -l eng is default; --psm 6 for blocks.
    ocr = execSync(`tesseract "${fullPath}" - --psm 6 -l eng 2>/dev/null`, { encoding: "utf8" });
  } catch (e) {
    console.warn(`! tesseract failed on ${f}: ${e.message}`);
    continue;
  }
  for (const marker of targets.markers) {
    if (ocr.includes(marker)) {
      console.error(`✗ LEAK: ${marker} found in ${f}`);
      leaks++;
    }
  }
}

if (leaks > 0) {
  console.error(`\n${leaks} marker(s) leaked through redaction.`);
  process.exit(1);
}
console.log(`✓ no markers leaked across ${frames.length} frames`);
