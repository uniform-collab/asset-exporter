#!/usr/bin/env node
/**
 * Push locally downloaded Uniform assets to a target Uniform project.
 * Reads manifest.json produced by pull_assets.mjs.
 *
 * Requirements:
 *   UNIFORM_TARGET_API_KEY    - API key for the TARGET project
 *   UNIFORM_TARGET_PROJECT_ID - Target project ID
 *
 * Usage:
 *   node push_assets.mjs [--assets-dir ./assets] [--dry-run] [--concurrency 3]
 *   node push_assets.mjs --ids id1,id2          # push only a subset of the manifest
 *   node push_assets.mjs --ids-file ids.txt     # ... or read the subset from a file
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const API_BASE = "https://uniform.app/api/v1";

// ── CLI args ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    "assets-dir":  { type: "string",  default: "./assets" },
    ids:           { type: "string" },
    "ids-file":    { type: "string" },
    "dry-run":     { type: "boolean", default: false },
    concurrency:   { type: "string",  default: "3" },
  },
});

const assetsDir   = args["assets-dir"];
const dryRun      = args["dry-run"];
const concurrency = Math.max(1, parseInt(args["concurrency"], 10));

// ── Optional id filter ────────────────────────────────────────────────────────

function parseIdsFromText(text) {
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
  return trimmed
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join(",")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadIdFilter() {
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
  return ids.length > 0 ? new Set(ids) : null;
}

// ── Env vars ──────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`Error: ${name} is not set`); process.exit(1); }
  return v;
}

const API_KEY    = requireEnv("UNIFORM_TARGET_API_KEY");
const PROJECT_ID = requireEnv("UNIFORM_TARGET_PROJECT_ID");

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiRequest(method, endpoint, body) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      "x-api-key":    API_KEY,
      "content-type": "application/json",
      accept:         "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status} ${method} ${url}: ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Step 1: Register the file and get a signed upload URL ─────────────────────

async function registerFile(entry) {
  const fields    = entry.fields ?? {};
  const mediaType = fields.mediaType?.value ?? mimeFromFilename(entry.localFile);
  const size      = fields.size?.value ?? fs.statSync(path.join(assetsDir, entry.localFile)).size;
  const width     = fields.width?.value;
  const height    = fields.height?.value;

  const body = {
    projectId: PROJECT_ID,
    name:      entry.name,
    size,
    mediaType,
    ...(width  != null && { width }),
    ...(height != null && { height }),
  };

  // POST /api/v1/files → { id, uploadUrl, method }
  return apiRequest("POST", "/files", body);
}

// ── Step 2: Upload the binary to the signed URL ───────────────────────────────

async function uploadBinary(localFile, uploadUrl, httpMethod, mediaType) {
  const filePath = path.join(assetsDir, localFile);
  const buffer   = fs.readFileSync(filePath);

  const res = await fetch(uploadUrl, {
    method:  httpMethod,
    headers: { "content-type": mediaType },
    body:    buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload ${res.status} for ${localFile}: ${text}`);
  }
}

// ── Step 3: Poll until the file is processed and get its CDN URL ─────────────

async function waitForFile(fileId, maxAttempts = 10, delayMs = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    const url = new URL(`${API_BASE}/files`);
    url.searchParams.set("id", fileId);
    url.searchParams.set("projectId", PROJECT_ID);

    const res = await fetch(url, {
      headers: { "x-api-key": API_KEY, accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`File poll ${res.status}: ${text}`);
    }

    const raw  = await res.text();
    const data = raw ? JSON.parse(raw) : {};
    // state 1 = ready; url is populated once the file is processed
    if (data.url) return data;

    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`File ${fileId} did not become ready after ${maxAttempts} attempts`);
}

// ── Step 4: Upsert the asset record in the target project ─────────────────────

// Fields that Uniform derives from the uploaded file — rejected if sent in PUT
const SYSTEM_FIELDS = new Set(["url", "file", "mediaType", "size", "width", "height", "custom"]);

async function upsertAsset(entry, fileId) {
  const fields = entry.fields ?? {};

  const assetFields = { file: { type: "file", value: fileId } };
  for (const [key, val] of Object.entries(fields)) {
    if (!SYSTEM_FIELDS.has(key)) assetFields[key] = val;
  }

  return apiRequest("PUT", "/assets", {
    projectId: PROJECT_ID,
    asset: {
      _id:    entry.id,
      type:   entry.type,
      _name:  entry.name,
      fields: assetFields,
    },
  });
}

// ── Full pipeline for a single asset ─────────────────────────────────────────

async function pushAsset(entry) {
  const label = entry.localFile;

  if (dryRun) {
    console.log(`  [DRY-RUN] ${label} → would upload to project ${PROJECT_ID}`);
    return true;
  }

  process.stdout.write(`  [1/4] ${label}: registering file ...\r`);
  const { id: fileId, uploadUrl, method: uploadMethod } = await registerFile(entry);

  const mediaType = entry.fields?.mediaType?.value ?? mimeFromFilename(entry.localFile);

  process.stdout.write(`  [2/4] ${label}: uploading binary ...  \r`);
  await uploadBinary(entry.localFile, uploadUrl, uploadMethod, mediaType);

  process.stdout.write(`  [3/4] ${label}: waiting for processing ...\r`);
  const fileRecord = await waitForFile(fileId);

  process.stdout.write(`  [4/4] ${label}: creating asset record ...\r`);
  await upsertAsset(entry, fileId);

  console.log(`  [DONE] ${label} → ${fileRecord.url}                    `);
  return true;
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runPool(tasks, limit) {
  const results = [];
  const queue   = [...tasks];
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      results.push(await task());
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png",  ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml",
    ".avif": "image/avif", ".tiff": "image/tiff",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",  ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav",
  })[ext] ?? "application/octet-stream";
}

// ── Main ──────────────────────────────────────────────────────────────────────

const manifestPath = path.join(assetsDir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`Error: ${manifestPath} not found. Run pull_assets.mjs first.`);
  process.exit(1);
}

let manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

if (manifest.length === 0) {
  console.log("manifest.json is empty — nothing to push.");
  process.exit(0);
}

const idFilter = loadIdFilter();
if (idFilter) {
  const before = manifest.length;
  manifest = manifest.filter((entry) => idFilter.has(entry.id));
  console.log(`Filtered manifest by id: ${manifest.length}/${before} asset(s) selected.`);

  const missing = [...idFilter].filter((id) => !manifest.some((e) => e.id === id));
  if (missing.length > 0) {
    console.log(`  Not in manifest: ${missing.join(", ")}`);
  }
  if (manifest.length === 0) {
    console.log("No manifest entries match the requested ids — nothing to push.");
    process.exit(0);
  }
}

console.log(`Pushing ${manifest.length} asset(s) to project ${PROJECT_ID} ...`);
if (dryRun)       console.log("(dry-run — no changes will be made)");
if (!dryRun)      console.log(`Concurrency: ${concurrency}\n`);

const tasks   = manifest.map((entry) => () => pushAsset(entry).catch((err) => {
  console.error(`\n  [ERROR] ${entry.localFile}: ${err.message}`);
  return false;
}));

const results = await runPool(tasks, dryRun ? manifest.length : concurrency);

const ok   = results.filter(Boolean).length;
const fail = results.length - ok;

console.log(`\n${dryRun ? "Would push" : "Pushed"} ${ok} asset(s)${fail ? `, ${fail} failed` : ""}.`);
