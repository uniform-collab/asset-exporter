#!/usr/bin/env node
/**
 * Pull a specific set of assets from a Uniform project by asset id.
 *
 * Requirements:
 *   UNIFORM_API_KEY    - Uniform API key
 *   UNIFORM_PROJECT_ID - Uniform project ID
 *
 * Usage:
 *   node pull_assets.mjs --ids id1,id2,id3 [--output-dir ./assets] [--dry-run]
 *   node pull_assets.mjs --ids-file ids.txt [--output-dir ./assets] [--dry-run]
 *
 * The id list can be supplied via --ids (comma/space/newline separated) and/or
 * --ids-file. The file may be a plain text list (one id per line, # for
 * comments), a JSON array of ids, or a JSON array of objects with an "id"
 * property (e.g. a previously produced manifest.json).
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

const API_BASE = "https://uniform.app/api/v1";

// ── CLI args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    "output-dir": { type: "string", default: "./assets" },
    ids:          { type: "string" },
    "ids-file":   { type: "string" },
    "dry-run":    { type: "boolean", default: false },
  },
});

const outputDir = args["output-dir"];
const dryRun    = args["dry-run"];

// ── Env vars ─────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`Error: ${name} is not set`); process.exit(1); }
  return v;
}

const API_KEY    = requireEnv("UNIFORM_API_KEY");
const PROJECT_ID = requireEnv("UNIFORM_PROJECT_ID");

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiGet(endpoint, params) {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { "x-api-key": API_KEY, accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status} ${url}: ${body}`);
  }
  return res.json();
}

// ── Asset id manifest ─────────────────────────────────────────────────────────

function parseIdsFromText(text) {
  // Try JSON first (array of strings, or array of objects with an "id" field).
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return arr
        .map((entry) => (typeof entry === "string" ? entry : entry?.id))
        .filter(Boolean);
    } catch {
      // fall through to plain-text parsing
    }
  }

  // Plain text: split on commas / whitespace / newlines, drop "#" comments.
  return trimmed
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join(",")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadAssetIds() {
  const ids = [];

  if (args.ids) ids.push(...parseIdsFromText(args.ids));

  if (args["ids-file"]) {
    const filePath = args["ids-file"];
    if (!fs.existsSync(filePath)) {
      console.error(`Error: ids file not found: ${filePath}`);
      process.exit(1);
    }
    ids.push(...parseIdsFromText(fs.readFileSync(filePath, "utf-8")));
  }

  // De-duplicate while preserving order.
  return [...new Set(ids)];
}

// ── Asset fetching ────────────────────────────────────────────────────────────

// Fetch a single asset by id and normalize it to the { asset, modified } shape
// that downloadAsset() expects (the same shape the list endpoint returns).
async function fetchAssetById(id) {
  const data = await apiGet("/assets", { projectId: PROJECT_ID, assetId: id });

  if (Array.isArray(data.assets) && data.assets.length > 0) {
    return data.assets[0];
  }
  if (data.asset) {
    return { asset: data.asset, modified: data.asset.modified ?? data.modified };
  }
  if (data._id || data.fields) {
    return { asset: data, modified: data.modified };
  }
  return null;
}

// ── Download helpers ──────────────────────────────────────────────────────────

function safeFilename(name) {
  return name.replace(/[/\\]/g, "_");
}

function uniqueDest(dir, filename, usedNames) {
  const ext  = path.extname(filename);
  const stem = path.basename(filename, ext);

  if (!usedNames.has(filename) && !fs.existsSync(path.join(dir, filename))) {
    usedNames.add(filename);
    return path.join(dir, filename);
  }

  // Shouldn't normally happen since the API returns unique asset IDs,
  // but guard against same-name files across runs.
  let n = 1;
  while (true) {
    const candidate = `${stem}__${n}${ext}`;
    if (!usedNames.has(candidate) && !fs.existsSync(path.join(dir, candidate))) {
      usedNames.add(candidate);
      return path.join(dir, candidate);
    }
    n++;
  }
}

async function downloadAsset(item, usedNames, manifest) {
  const asset     = item.asset ?? {};
  const fields    = asset.fields ?? {};
  const url       = fields.url?.value;
  const name      = asset._name ?? "unknown";
  const assetId   = asset._id ?? "no-id";
  const mediaType = fields.mediaType?.value ?? "";
  const size      = fields.size?.value;

  if (!url) {
    console.log(`  [SKIP] ${name} (${assetId}) — no download URL`);
    return false;
  }

  const filename = safeFilename(name);
  const dest     = uniqueDest(outputDir, filename, usedNames);
  const destName = path.basename(dest);

  if (dryRun) {
    console.log(`  [DRY-RUN] ${name} → ${destName}  (${size ?? "?"} bytes)  ${url}`);
    return true;
  }

  process.stdout.write(`  Downloading ${name} (${mediaType}) → ${destName} ...\r`);

  const res = await fetch(url, { headers: { "user-agent": "uniform-asset-puller/1.0" } });
  if (!res.ok) {
    console.error(`\n  [ERROR] HTTP ${res.status} for ${name}`);
    return false;
  }

  const fileStream = fs.createWriteStream(dest);
  await pipeline(res.body, Writable.toWeb ? Writable.toWeb(fileStream) : fileStream);

  process.stdout.write(`  Downloaded  ${name} → ${destName}              \n`);

  // Record metadata for push_assets.mjs — exclude url/file since those are project-specific
  const { url: _url, file: _file, ...pushFields } = fields;
  manifest.push({
    localFile: destName,
    id: asset._id,
    name,
    type: asset.type ?? "image",
    modified: item.modified,
    fields: pushFields,
  });

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const ids = loadAssetIds();

if (ids.length === 0) {
  console.error("Error: no asset ids provided. Use --ids id1,id2 or --ids-file path.");
  process.exit(1);
}

if (!dryRun) fs.mkdirSync(outputDir, { recursive: true });

console.log(`Pulling ${ids.length} asset(s) by id:\n`);

let ok = 0, fail = 0;
const usedNames = new Set();
const manifest  = [];

for (const id of ids) {
  let item = null;
  try {
    item = await fetchAssetById(id);
  } catch (err) {
    console.error(`  [ERROR] ${id}: ${err.message}`);
    fail++;
    continue;
  }

  if (!item) {
    console.log(`  [SKIP] ${id} — asset not found`);
    fail++;
    continue;
  }

  const success = await downloadAsset(item, usedNames, manifest);
  if (success) ok++; else fail++;
}

if (!dryRun && manifest.length > 0) {
  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written: ${manifestPath}`);
}

const verb = dryRun ? "Would download" : "Downloaded";
console.log(`\n${verb} ${ok} asset(s)${fail ? `, ${fail} failed` : ""}.`);
if (!dryRun && ok) console.log(`Saved to: ${path.resolve(outputDir)}`);
