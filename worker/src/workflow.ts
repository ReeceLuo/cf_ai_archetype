import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type {
  ChatMessage,
  ExtractIntentResult,
  RecommendationCard,
  RecommendationInput,
  RecommendationMatchMode,
  RetrievedCharacter,
  WorkflowParams,
  WorkflowResult,
} from "./types";
import { asTrimmedString } from "./string-utils";
import { CATALOG_GENRES } from "./genres";
import seedCharacters from "../../data/characters.seed.json";

const LLM = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const EMBED = "@cf/baai/bge-m3";

// Max recommendation cards per reply
const CARD_LIMIT = 3;

// Include the next match only if its score stays close to the best and to the previous pick.
const PICK_MIN_RELATIVE_TO_TOP = 0.84;
const PICK_MAX_SCORE_DROP_FROM_PREV = 0.04;

type SeedCharacter = {
  id: string;
  workTitle: string;
  workType: "movie" | "tv";
  characterName: string;
  blurb: string;
  genres?: string[];
  imageUrl?: string;
};

// Full seed row by id - fills gaps and overrides stale Vectorize imageUrl when seed is updated.
const SEED_BY_ID = new Map<string, SeedCharacter>(
  (seedCharacters as SeedCharacter[]).map((c) => [c.id, c])
);

// Map LLM / user text to a canonical CATALOG_GENRES label when possible.
function resolveCatalogGenre(raw: string | undefined): string | undefined {
  const s = asTrimmedString(raw);
  if (!s) return undefined;
  const lower = s.toLowerCase();
  const exact = CATALOG_GENRES.find((g) => g.toLowerCase() === lower);
  if (exact) return exact;
  const aliases: Record<string, (typeof CATALOG_GENRES)[number]> = {
    "sci-fi": "Science Fiction",
    scifi: "Science Fiction",
    "science fiction": "Science Fiction",
    historical: "Historical",
    history: "Historical",
  };
  if (aliases[lower]) return aliases[lower];
  return CATALOG_GENRES.find(
    (g) => lower.includes(g.toLowerCase()) || g.toLowerCase().includes(lower)
  );
}

// Best-effort progress broadcast - never throws so workflow steps aren't affected
async function sendProgress(env: Env, sessionId: string, text: string): Promise<void> {
  try {
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    await stub.fetch("https://session/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "progress", text }),
    });
  } catch {
  }
}

export class ArchetypeWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(
    event: WorkflowEvent<WorkflowParams>,
    step: WorkflowStep
  ): Promise<WorkflowResult> {
    const { sessionId, userMessage, history, recommendation } = event.payload;

    try {
      await sendProgress(this.env, sessionId, "Analyzing your request…");
      const intent = await step.do("extract-intent", async () =>
        recommendation
          ? extractRecommendationIntent(this.env.AI, recommendation, history)
          : extractIntent(this.env.AI, userMessage, history)
      );

      // For freeform chat messages that aren't recommendation requests, respond conversationally.
      const wantsRecommendation = Boolean(recommendation) || intent.needsRecommendation !== false;

      let reply: string;
      let cards: RecommendationCard[];

      if (!wantsRecommendation) {
        await sendProgress(this.env, sessionId, "Writing response…");
        reply = await step.do("compose-conversational", async () =>
          composeConversationalReply(this.env.AI, userMessage, history)
        );
        cards = [];
      } else {
        const genreLabel =
          resolveCatalogGenre(intent.genre) ?? asTrimmedString(intent.genre);
        const strictGenre =
          Boolean(recommendation) || Boolean(resolveCatalogGenre(intent.genre));

        await sendProgress(this.env, sessionId, "Searching the catalog…");
        const retrieved = await step.do("vector-retrieve", async () =>
          retrieveMerged(
            this.env.AI,
            this.env.VECTORIZE,
            userMessage,
            intent.searchQuery,
            genreLabel || undefined,
            { strictGenre }
          )
        );

        const filtered = filterExcluded(retrieved, userMessage, intent.excludeSubjects);
        const picks = selectPicksForDisplay(filtered, CARD_LIMIT);

        if (picks.length === 0) {
          await sendProgress(this.env, sessionId, "Writing response…");
          reply = await step.do("compose-no-matches", async () =>
            composeNoMatchesMessage(this.env.AI, userMessage)
          );
          cards = [];
        } else {
          await sendProgress(this.env, sessionId, "Writing recommendations…");
          const { reply: footnote, reasons } = await step.do(
            "compose-card-rationales",
            async () =>
              composePerCardRationales(this.env.AI, {
                userMessage,
                history,
                intent,
                catalogRows: picks,
              })
          );
          reply = footnote;
          cards = buildRecommendationCards(picks, reasons);
        }
      }

      await step.do("persist-assistant", async () => {
        const stub = this.env.SESSION.get(
          this.env.SESSION.idFromName(sessionId)
        );
        await stub.fetch("https://session/append", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "assistant", content: reply, cards }),
        });
      });

      return { reply, cards };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Something went wrong";
      try {
        const stub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
        await stub.fetch("https://session/broadcast", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "error", text: message }),
        });
      } catch {}
      throw e;
    }
  }
}

// Use catalog/vector URL when present; fall back to undefined so the CSS avatar floor shows.
function resolveCharacterImageUrl(
  imageUrl: string | undefined,
  _characterName: string
): string | undefined {
  const trimmed = asTrimmedString(imageUrl ?? "");
  return trimmed || undefined;
}

function buildRecommendationCards(
  rows: RetrievedCharacter[],
  reasons: string[]
): RecommendationCard[] {
  return rows.map((r, i) => {
    const seed = SEED_BY_ID.get(r.id);
    const characterName =
      asTrimmedString(r.characterName) || asTrimmedString(seed?.characterName) || r.id;
    const workTitle = asTrimmedString(r.workTitle) || asTrimmedString(seed?.workTitle);
    const blurbRaw = asTrimmedString(r.blurb) || asTrimmedString(seed?.blurb);
    const blurb = blurbRaw.length > 360 ? `${blurbRaw.slice(0, 357)}…` : blurbRaw;
    const workType: "movie" | "tv" =
      r.workType === "tv" || seed?.workType === "tv" ? "tv" : "movie";
    const genres = r.genres?.length ? r.genres : seed?.genres;
    const imageUrl = resolveCharacterImageUrl(
      seed?.imageUrl ?? r.imageUrl,
      characterName
    );
    const rationaleRaw = asTrimmedString(reasons[i]);
    const rationale =
      rationaleRaw.length > 0 ? rationaleRaw : blurb || "Related catalog pick for your question.";
    return {
      id: r.id,
      characterName,
      workTitle,
      workType,
      blurb,
      rationale,
      imageUrl,
      genres,
    };
  });
}

async function extractIntent(
  ai: Ai,
  userMessage: string,
  history: ChatMessage[]
): Promise<ExtractIntentResult> {
  const historyText = history
    .slice(-8)
    .map((m) => `${m.role}: ${asTrimmedString(m.content)}`)
    .join("\n");

  const raw = await ai.run(LLM, {
    messages: [
      {
        role: "system",
        content: `You help map user questions to a short search string for **vector search** over a catalog of film/TV characters.

Respond with ONLY valid JSON (no markdown): {"needsRecommendation": boolean, "searchQuery": string, "contextNotes"?: string, "excludeSubjects"?: string[], "matchMode"?: "similar" | "contrast", "genre"?: string}

**needsRecommendation**: Set to true if the message is asking for film/TV character or title *recommendations* — i.e. the user wants to discover new titles/characters. Set to false for: greetings, small talk, questions about how the app works, or requests to go *deeper* on a specific character that was already mentioned (e.g. "go deeper into Pennywise", "tell me more about that character", "explain their personality") — these should be answered conversationally. When false, searchQuery can be an empty string.

**genre**: If the user names or implies a target genre or world for the recommendations (e.g. "high fantasy epic", "dropped into sci-fi", "crime drama", "rom-com"), set **genre** to exactly one of:
Action, Animation, Comedy, Crime, Drama, Fantasy, Historical, Horror, Mystery, Romance, Science Fiction, Sports, Thriller.
This includes "what if X were in Y" framings — the Y is the genre. Omit only if no genre or world is mentioned at all.

**Default behavior is similarity.** Users want recommendations that feel like **the same kind of character drama** as their message (parallel flaws, arcs, moral pressure, competence, hubris, transformation), often transplanted into the genre/world they mention.

Rules for searchQuery (when needsRecommendation is true and matchMode is **similar** or omitted):
- searchQuery is used for **personality-only** vector search against character blurbs. It must contain ONLY personality trait keywords — no character names, no show titles, no genre/setting words.
- Do NOT include the anchor's name or show title (e.g. do not write "Walter White" or "Breaking Bad") — name similarity in vector space causes false matches with unrelated characters who share the same first name.
- Do NOT include genre, setting, or world references (e.g. do not write "high fantasy", "sci-fi") — genre is handled separately.
- Instead, extract and expand the anchor's personality into trait keywords: e.g. for Walter White write something like "ego pride hubris moral corruption self-deception rationalizes violence need for dominance control genius exploited for power".
- Do **not** bias searchQuery toward **opposites**, foils, rule-followers, or "moral contrast" unless matchMode is **contrast**.
- If the user only names a vibe or show for taste ("similar to Breaking Bad"), same idea: search for **parallel** character types.

matchMode:
- **"similar"** (default): omit the key or set "similar" unless the user clearly wants opposites/foils.
- **"contrast"** only if they explicitly ask for contrast, foil, opposite, antagonistic counterpart, "who would clash with", "nothing like X", "inverse", "antithesis", etc.

excludeSubjects (important):
- List **character names** and/or **exact show or movie titles** the user is using as the *hypothetical anchor* (the "what if X…" subject, or the character they want parallels *for* while X stays off the recommendation list).
- Example: "What if Walter White were in a fantasy show?" → include "Walter White" (and "Breaking Bad" only if they clearly mean the whole series as the premise, not just as taste reference).
- If they only want "similar vibe to Breaking Bad", leave excludeSubjects empty or omit it.
- Use canonical full names when obvious. Omit the key or use [] when nothing should be excluded.`,
      },
      {
        role: "user",
        content: `Prior chat (may be empty):\n${historyText || "(none)"}\n\nLatest message:\n${asTrimmedString(userMessage)}`,
      },
    ],
    max_tokens: 512,
  });

  const text = llmText(raw);
  return parseJsonIntent(text);
}

async function extractRecommendationIntent(
  ai: Ai,
  rec: RecommendationInput,
  history: ChatMessage[]
): Promise<ExtractIntentResult> {
  const historyText = history
    .slice(-6)
    .map((m) => `${m.role}: ${asTrimmedString(m.content)}`)
    .join("\n");
  const genre = asTrimmedString(rec.genre);

  if (rec.inputMode === "mbti") {
    const mbti = asTrimmedString(rec.mbti).toUpperCase();
    const raw = await ai.run(LLM, {
      messages: [
        {
          role: "system",
          content: `You map Myers-Briggs types to a dense search string for matching fictional characters by personality - using serious typology, not memes.

Depth requirements (avoid one-word stereotypes):
- Treat the four-letter code as shorthand for patterns in cognition and motivation, not a costume.
- Explain axis pairs: I/E (where attention habitually goes), S/N (concrete vs pattern/abstract), T/F (decision basis: models/harmony), J/P (outer structure vs exploration).
- Name the typical dominant + auxiliary cognitive functions for this type in the common function stack (Ni, Ne, Si, Se, Ti, Te, Fi, Fe) and what that tends to look like in behavior and inner life.
- Mention inferior function pressure and stress/grip tendencies at a high level, plus a growth direction - grounded and non-caricatured.

Output ONLY valid JSON (no markdown): {"searchQuery": string, "contextNotes": string, "excludeSubjects"?: string[], "matchMode"?: "similar" | "contrast"}
- searchQuery: a rich paragraph blending personality dynamics with genre "${genre}" so vector search finds **similar** character types in that kind of story (parallel dramatic DNA, not foils). Include "matchMode":"contrast" only if the user explicitly asked for opposites or foils.
- contextNotes: 5-7 sentences tying MBTI depth to protagonists and conflicts in ${genre}.
- excludeSubjects: optional anchors not to recommend again.`,
        },
        {
          role: "user",
          content: `MBTI type: ${mbti}\nPreferred genre for titles: ${genre}\n\nPrior chat (may be empty):\n${historyText || "(none)"}`,
        },
      ],
      max_tokens: 900,
    });
    const parsed = parseJsonIntent(llmText(raw));
    return { ...parsed, genre };
  }

  const traits = asTrimmedString(rec.traits);
  const raw = await ai.run(LLM, {
    messages: [
      {
        role: "system",
        content: `The user listed personality traits and wants ${genre} film/TV recommendations. Expand traits into values, fears, relational habits, and inner conflicts - concrete enough for character matching.

Output ONLY valid JSON (no markdown): {"searchQuery": string, "contextNotes": string, "excludeSubjects"?: string[], "matchMode"?: "similar" | "contrast"}
searchQuery: dense paragraph for embedding - **similar** characters matching these traits in ${genre}. Use "contrast" only if the user explicitly wanted opposites/foils.
contextNotes: how traits map to arcs in ${genre}.
excludeSubjects: optional.`,
      },
      {
        role: "user",
        content: `Traits (user-written):\n${traits}\n\nGenre: ${genre}\n\nPrior chat:\n${historyText || "(none)"}`,
      },
    ],
    max_tokens: 512,
  });
  const parsed = parseJsonIntent(llmText(raw));
  return { ...parsed, genre };
}

function llmText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return asTrimmedString(raw);
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    // Workers AI wraps text responses in { response: string | object }.
    if ("response" in obj) {
      const inner = obj.response;
      if (typeof inner === "string") return asTrimmedString(inner);
      // When response_format: json_object is set, Workers AI may pre-parse the JSON.
      if (typeof inner === "object" && inner !== null) return JSON.stringify(inner);
    }
    // Fallback: serialize the whole object so JSON intent parsers can still extract fields.
    return JSON.stringify(raw);
  }
  return asTrimmedString(raw);
}

function parsePicksRationale(text: string, n: number): { footnote: string; reasons: string[] } {
  const empty = (): { footnote: string; reasons: string[] } => ({
    footnote: "",
    reasons: Array.from({ length: n }, () => ""),
  });

  const safe = asTrimmedString(text);
  let trimmed = safe.replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    trimmed = trimmed.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const footnote = asTrimmedString(
      parsed.footnote ?? parsed.Footnote ?? ""
    );
    const rawArr = parsed.reasons ?? parsed.Reasons;
    const raw = Array.isArray(rawArr) ? rawArr : [];
    const reasons = raw.map((r) => asTrimmedString(r));
    while (reasons.length < n) {
      reasons.push("");
    }
    return { footnote, reasons: reasons.slice(0, n) };
  } catch {
    return empty();
  }
}

function parseJsonIntent(text: string): ExtractIntentResult {
  const safe = asTrimmedString(text);
  let trimmed = safe.replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    trimmed = trimmed.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const q = asTrimmedString(parsed.searchQuery);
    const needsRecommendation = parsed.needsRecommendation !== false;
    const rawEx = parsed.excludeSubjects ?? parsed.exclude_subjects;
    const excludeSubjects = normalizeExcludeSubjects(rawEx);
    const modeRaw = asTrimmedString(
      parsed.matchMode ?? parsed.match_mode
    ).toLowerCase();
    const matchMode: RecommendationMatchMode =
      modeRaw === "contrast" ? "contrast" : "similar";
    return {
      searchQuery: q,
      needsRecommendation,
      contextNotes:
        parsed.contextNotes === undefined
          ? undefined
          : asTrimmedString(parsed.contextNotes) || undefined,
      genre:
        parsed.genre === undefined
          ? undefined
          : asTrimmedString(parsed.genre) || undefined,
      excludeSubjects: excludeSubjects.length > 0 ? excludeSubjects : undefined,
      matchMode,
    };
  } catch {
  }
  return { searchQuery: safe.slice(0, 2000) };
}

function normalizeExcludeSubjects(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    const s = asTrimmedString(x);
    if (s.length >= 2) out.push(s);
  }
  return out;
}

function normalizeForMatch(s: string): string {
  return asTrimmedString(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Filter retrieved results by two criteria:
 *  1. Direct mention - if the result's character name or work title appears verbatim in
 *     the user message it is the anchor, not a recommendation.
 *  2. LLM intent - subjects the model explicitly flagged as excludeSubjects.
 *
 * Checking the results themselves (not SEED_BY_ID) means the filter works even when
 * a character's catalog name doesn't exactly match what's in the current seed file.
 */
function filterExcluded(
  rows: RetrievedCharacter[],
  userMessage: string,
  intentExcludes: string[] | undefined
): RetrievedCharacter[] {
  const u = normalizeForMatch(userMessage);
  const intentNeedles = (intentExcludes ?? [])
    .map(normalizeForMatch)
    .filter((n) => n.length >= 2);

  return rows.filter((r) => {
    const seed = SEED_BY_ID.get(r.id);
    const cn = normalizeForMatch(
      asTrimmedString(r.characterName) || asTrimmedString(seed?.characterName)
    );
    const wt = normalizeForMatch(
      asTrimmedString(r.workTitle) || asTrimmedString(seed?.workTitle)
    );

    // 1. Direct mention in the user message.
    if (cn.length >= 4 && u.includes(cn)) return false;
    if (wt.length >= 6 && u.includes(wt)) return false;

    // 2. LLM-extracted intent subjects.
    for (const needle of intentNeedles) {
      if (excludedSubjectMatchesRow(needle, cn, wt)) return false;
    }

    return true;
  });
}

function excludedSubjectMatchesRow(
  needle: string,
  charNorm: string,
  workNorm: string
): boolean {
  if (!needle) return false;
  if (charNorm) {
    if (charNorm === needle) return true;
    if (needle.length >= 5 && charNorm.includes(needle)) return true;
    if (charNorm.length >= 5 && needle.includes(charNorm)) return true;
  }
  if (workNorm) {
    if (workNorm === needle) return true;
    if (needle.length >= 6 && workNorm.includes(needle)) return true;
    if (workNorm.length >= 6 && needle.includes(workNorm)) return true;
  }
  return false;
}

async function embedTextsBatch(ai: Ai, texts: string[]): Promise<number[][]> {
  const cleaned = texts.map((t) => asTrimmedString(t)).filter(Boolean);
  if (cleaned.length === 0) throw new Error("Empty batch for embedding");
  const out = await ai.run(EMBED, {
    text: cleaned,
  });
  const data = (out as { data?: number[][] }).data;
  if (!data?.length || data.length !== cleaned.length) {
    throw new Error("Embedding batch size mismatch");
  }
  for (const row of data) {
    if (!row?.length) throw new Error("Embedding model returned empty vector");
  }
  return data;
}

async function querySimilar(
  index: VectorizeIndex,
  vector: number[],
  topK: number
): Promise<RetrievedCharacter[]> {
  const res = await index.query(vector, {
    topK,
    returnMetadata: "all",
  });

  return (res.matches ?? []).map((m) => {
    const meta = (m.metadata ?? {}) as Record<string, string | number | boolean | undefined>;
    const rowId = String(meta.id ?? m.id);
    const seedRow = SEED_BY_ID.get(rowId);
    const imageRaw = meta.imageUrl;
    const imageUrlFromMeta =
      imageRaw !== undefined && imageRaw !== null && String(imageRaw).trim() !== ""
        ? String(imageRaw).trim()
        : undefined;
    const characterName = String(meta.characterName ?? "");
    // Prefer bundled seed URLs (e.g. title posters after refresh)
    const imageUrl = seedRow?.imageUrl ?? imageUrlFromMeta;
    const resolvedImage = resolveCharacterImageUrl(imageUrl, characterName);
    return {
      id: rowId,
      workTitle: String(meta.workTitle ?? ""),
      workType: (meta.workType === "tv" ? "tv" : "movie") as "movie" | "tv",
      characterName,
      blurb: String(meta.blurb ?? ""),
      imageUrl: resolvedImage,
      genres: parseGenresField(meta.genres),
      score: m.score,
    };
  });
}

function parseGenresField(meta: unknown): string[] | undefined {
  if (meta == null) return undefined;
  const parts = String(meta)
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function rowMatchesCatalogGenre(
  r: RetrievedCharacter,
  genre: string
): boolean {
  const g = genre.toLowerCase().trim();
  if (!g) return true;
  return (r.genres ?? []).some((x) => {
    const xl = x.toLowerCase();
    return xl === g || xl.includes(g) || g.includes(xl);
  });
}

async function retrieveMerged(
  ai: Ai,
  index: VectorizeIndex,
  _userMessage: string,
  intentQuery: string,
  genreFilter?: string,
  opts?: { strictGenre?: boolean }
): Promise<RetrievedCharacter[]> {
  const iq = asTrimmedString(intentQuery);

  const byId = new Map<string, RetrievedCharacter>();

  const mergeIn = (rows: RetrievedCharacter[]) => {
    for (const r of rows) {
      const prev = byId.get(r.id);
      const s = r.score ?? 0;
      if (!prev || s > (prev.score ?? 0)) {
        byId.set(r.id, { ...r, score: s });
      }
    }
  };

  const jobs: { topK: number }[] = [];
  const batchTexts: string[] = [];
  if (iq) {
    batchTexts.push(iq);
    jobs.push({ topK: 14 });
  }
  if (batchTexts.length > 0) {
    const vectors = await embedTextsBatch(ai, batchTexts);
    const branchResults = await Promise.all(
      jobs.map((j, i) => querySimilar(index, vectors[i]!, j.topK))
    );
    for (const rows of branchResults) {
      mergeIn(rows);
    }
  }

  let merged = [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const g = asTrimmedString(genreFilter);
  if (g) {
    if (opts?.strictGenre) {
      merged = merged.filter((r) => rowMatchesCatalogGenre(r, g));
    } else {
      merged = prioritizeByGenre(merged, g, 16);
    }
  }
  return merged.slice(0, 14);
}

function selectPicksForDisplay(
  rows: RetrievedCharacter[],
  max: number
): RetrievedCharacter[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const out: RetrievedCharacter[] = [sorted[0]];
  const topScore = sorted[0].score ?? 0;
  const scoresLookUsable = topScore > 0.015;

  for (let i = 1; i < sorted.length && out.length < max; i++) {
    const prev = out[out.length - 1].score ?? 0;
    const curr = sorted[i].score ?? 0;
    if (scoresLookUsable) {
      if (curr < topScore * PICK_MIN_RELATIVE_TO_TOP) break;
      if (prev - curr > PICK_MAX_SCORE_DROP_FROM_PREV) break;
    }
    out.push(sorted[i]);
  }

  return out;
}

function prioritizeByGenre(
  rows: RetrievedCharacter[],
  genre: string,
  pool: number
): RetrievedCharacter[] {
  const g = genre.toLowerCase();
  const yes = rows
    .filter((r) => rowMatchesCatalogGenre(r, g))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const no = rows
    .filter((r) => !rowMatchesCatalogGenre(r, g))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return [...yes, ...no].slice(0, pool);
}

async function composeConversationalReply(
  ai: Ai,
  userMessage: string,
  history: ChatMessage[]
): Promise<string> {
  const hist = history
    .slice(-6)
    .map((m) => `${m.role}: ${asTrimmedString(m.content)}`)
    .join("\n");
  const raw = await ai.run(LLM, {
    messages: [
      {
        role: "system",
        content: `You are Archetype, a helpful film and TV recommendation assistant specializing in character personality matching. You help users discover films and TV shows by:
- Asking "what if character X were in genre Y?" (e.g. "What if Walter White were in a fantasy epic?")
- Describing personality traits or an MBTI type to find matching characters
- Exploring characters similar to one they already like

If the user is asking to go deeper on a specific character (e.g. "go deeper into Pennywise", "tell me more about that character"), act as a movie enthusiast and give a focused 3-5 sentence personality analysis: their core drive or motivation, how they behave under pressure, their relational style, and what makes them dramatically compelling. Focus on psychology and behavior — not plot summary or lore.

Respond naturally and helpfully to the user's message. If they seem unsure how to use the app, briefly explain the features above. Keep replies concise.`,
      },
      ...(hist ? [{ role: "user" as const, content: `Prior conversation:\n${hist}` }, { role: "assistant" as const, content: "Got it." }] : []),
      { role: "user", content: asTrimmedString(userMessage) },
    ],
    max_tokens: 300,
  });
  return llmText(raw);
}

async function composeNoMatchesMessage(ai: Ai, userMessage: string): Promise<string> {
  const raw = await ai.run(LLM, {
    messages: [
      {
        role: "system",
        content: `You are Archetype, a film/TV guide focused on character personality. The vector catalog returned no matches.

Say briefly that no close character matches were found. Suggest the user rephrase, or (for developers) confirm the Vectorize index is seeded and remote bindings are enabled in wrangler. Do not invent titles as if they were retrieved.`,
      },
      { role: "user", content: asTrimmedString(userMessage) },
    ],
    max_tokens: 256,
  });
  return llmText(raw);
}

async function composePerCardRationales(
  ai: Ai,
  input: {
    userMessage: string;
    history: ChatMessage[];
    intent: ExtractIntentResult;
    catalogRows: RetrievedCharacter[];
  }
): Promise<{ reply: string; reasons: string[] }> {
  const { userMessage, history, intent, catalogRows } = input;
  const n = catalogRows.length;

  // Surface the anchor character(s) so the model can write explicit comparisons.
  const anchors = (intent.excludeSubjects ?? []).filter((s) => s.length >= 2);
  const anchorLine = anchors.length > 0
    ? `Anchor character(s) the user is asking about: ${anchors.join(", ")}`
    : "";
  const genreLine = intent.genre
    ? `Target genre: ${intent.genre}`
    : "";

  const catalog = catalogRows
    .map((r, i) => {
      const seed = SEED_BY_ID.get(r.id);
      const name = asTrimmedString(r.characterName) || asTrimmedString(seed?.characterName);
      const title = asTrimmedString(r.workTitle) || asTrimmedString(seed?.workTitle);
      const type: "movie" | "tv" =
        r.workType === "tv" || seed?.workType === "tv" ? "tv" : "movie";
      const blurb = asTrimmedString(r.blurb) || asTrimmedString(seed?.blurb);
      const genres = (r.genres?.length ? r.genres : seed?.genres) ?? [];
      const tags = genres.length ? ` [${genres.join(", ")}]` : "";
      return `[${i + 1}] ${name} - "${title}" (${type})${tags}\n${blurb}`;
    })
    .join("\n\n");

  const hist = history
    .slice(-6)
    .map((m) => `${m.role}: ${asTrimmedString(m.content)}`)
    .join("\n");

  const anchorPhrase = anchors.length > 0 ? anchors.join(" / ") : null;

  const systemMain = `You are Archetype, a film/TV recommendation guide. Each rationale answers one question: **why does this character's personality match the anchor?**

${anchorPhrase
  ? `The anchor is: ${anchorPhrase}. Open every rationale with the specific personality trait or flaw that this recommended character shares with the anchor. Example: "[Character] shares [anchor]'s X — both are driven by Y and tend to Z under pressure."`
  : "Open every rationale by naming the specific trait or flaw that makes this character a match."}

STRICT RULES:
- 5-7 sentences per rationale. No more.
- Focus entirely on PERSONALITY: drives, flaws, arc pattern, behavior under pressure, relational style.
- Do NOT reference the user's hypothetical scenario or genre framing (e.g. do not say "in a high fantasy epic" or "if they were dropped into..."). The genre determined which results were retrieved — you do not need to mention it.
- Do NOT imagine the two characters meeting or interacting. They are from separate stories.
- Do NOT summarize plot.
- Name 2-3 concrete shared traits. Vague words like "complex" or "nuanced" are forbidden.
- Use the recommended character's exact name at least once.

Respond with ONE JSON object only (no markdown):
{"footnote":"<string>","reasons":["<string>","..."]}
- "reasons": exactly ${n} strings, one per card [1]-[${n}]. Escape internal quotes as \\".
- "footnote": one optional line (~120 chars max) after all cards, or "".

${anchorLine}
${genreLine}`.trim();

  const userBlock = `Prior conversation:\n${hist || "(none)"}\n\nCatalog (card order [1]-[${n}]):\n${catalog}\n\nLatest user message (each rationale must relate clearly to this):\n${asTrimmedString(userMessage)}`;

  const runRationaleLlm = async (systemContent: string, maxTok: number) =>
    ai.run(LLM, {
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userBlock },
      ],
      max_tokens: maxTok,
      temperature: 0.78,
      top_p: 0.92,
      response_format: { type: "json_object" },
    });

  const raw = await runRationaleLlm(systemMain, 2200);
  const { footnote, reasons } = parsePicksRationale(llmText(raw), n);
  return { reply: footnote, reasons };
}
