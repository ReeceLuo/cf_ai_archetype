/**
 * TMDB_API_KEY=xxx node scripts/refresh-tmdb-posters.mjs
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SEED_PATH = join(ROOT, "data/characters.seed.json");
const TMDB_BASE = "https://api.themoviedb.org/3";

const ID_RE = /^tmdb-(m|t)-(\d+)-\d+$/;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tmdb(path, apiKey) {
  const url = `${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Portrait-friendly: prefer poster; backdrop is last resort (often wide). */
function posterW342FromDetail(info) {
  const p = info.poster_path || info.backdrop_path;
  if (!p) return null;
  return `https://image.tmdb.org/t/p/w342${p}`;
}

async function main() {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error("Set TMDB_API_KEY (see https://www.themoviedb.org/settings/api)");
    process.exit(1);
  }

  const raw = await readFile(SEED_PATH, "utf8");
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error("characters.seed.json must be an array");

  /** @type {Map<string, number[]>} */
  const byMedia = new Map();
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i]?.id;
    if (typeof id !== "string") continue;
    const m = id.match(ID_RE);
    if (!m) continue;
    const kind = m[1] === "m" ? "movie" : "tv";
    const mediaId = m[2];
    const key = `${kind}:${mediaId}`;
    if (!byMedia.has(key)) byMedia.set(key, []);
    byMedia.get(key).push(i);
  }

  console.log(`Unique TMDB titles to fetch: ${byMedia.size}`);

  /** @type {Map<string, string | null>} */
  const urlByKey = new Map();

  for (const key of byMedia.keys()) {
    const [kind, idStr] = key.split(":");
    const path =
      kind === "movie" ? `/movie/${idStr}?language=en-US` : `/tv/${idStr}?language=en-US`;
    try {
      const info = await tmdb(path, apiKey);
      urlByKey.set(key, posterW342FromDetail(info));
    } catch (e) {
      console.warn("Skip", key, e.message);
      urlByKey.set(key, null);
    }
    await sleep(110);
  }

  let updated = 0;
  for (const [key, indices] of byMedia) {
    const url = urlByKey.get(key);
    if (!url) continue;
    for (const i of indices) {
      rows[i].imageUrl = url;
      updated++;
    }
  }

  const backupPath = join(ROOT, `data/characters.seed.backup.${Date.now()}.json`);
  await copyFile(SEED_PATH, backupPath);
  console.log(`Backup: ${backupPath}`);
  await writeFile(SEED_PATH, JSON.stringify(rows, null, 2) + "\n", "utf8");
  console.log(`Updated ${updated} rows with title posters/backdrops (${byMedia.size} titles).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
