import type { RecommendationInput, WorkflowParams } from "./types";
import { CATALOG_GENRES } from "./genres";
import { ArchetypeWorkflow } from "./workflow";
import { SessionDO } from "./session-do";
import { asTrimmedString } from "./string-utils";
import seedCharacters from "../../data/characters.seed.json";

export { ArchetypeWorkflow, SessionDO };

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    try {
      if (path === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }
      if (path === "/api/workflow/status" && request.method === "GET") {
        return await handleWorkflowStatus(url, env);
      }
      if (path.startsWith("/api/session/") && path.endsWith("/messages")) {
        if (request.method === "GET") {
          return await handleSessionMessages(url, env);
        }
      }
      if (path.startsWith("/api/session/") && path.endsWith("/socket")) {
        return await handleSessionSocket(request, url, env);
      }
      if (path === "/api/seed" && request.method === "POST") {
        return await handleSeed(request, env);
      }
      if (path === "/health" && request.method === "GET") {
        return json({ ok: true, service: "archetype" });
      }
      if (path === "/api/catalog-health" && request.method === "GET") {
        return await handleCatalogHealth(env);
      }
      if (path === "/api/genres" && request.method === "GET") {
        return json({ genres: [...CATALOG_GENRES] });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return json({ error: message }, { status: 500 });
    }

    return new Response("Not found", { status: 404, headers: cors() });
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    sessionId?: unknown;
    message?: unknown;
    recommendation?: {
      inputMode?: unknown;
      mbti?: unknown;
      traits?: unknown;
      genre?: unknown;
    };
  };

  let recommendation: RecommendationInput | undefined;
  const rec = body.recommendation;
  if (rec && typeof rec === "object") {
    const inputMode = asTrimmedString(rec.inputMode).toLowerCase();
    const genre = asTrimmedString(rec.genre);
    if (!genre || !(CATALOG_GENRES as readonly string[]).includes(genre)) {
      return json(
        {
          error: "invalid genre",
          genres: [...CATALOG_GENRES],
        },
        { status: 400 }
      );
    }
    if (inputMode !== "mbti" && inputMode !== "traits") {
      return json({ error: "recommendation.inputMode must be mbti or traits" }, { status: 400 });
    }
    if (inputMode === "mbti") {
      const mbti = asTrimmedString(rec.mbti).toUpperCase();
      if (!/^[IE][NS][TF][JP]$/.test(mbti)) {
        return json({ error: "recommendation.mbti must be a valid four-letter MBTI code" }, { status: 400 });
      }
      recommendation = { inputMode: "mbti", mbti, genre };
    } else {
      const traits = asTrimmedString(rec.traits);
      if (!traits) {
        return json({ error: "recommendation.traits is required for traits mode" }, { status: 400 });
      }
      recommendation = { inputMode: "traits", traits, genre };
    }
  }

  const sessionId = asTrimmedString(body.sessionId) || crypto.randomUUID();
  let message = asTrimmedString(body.message);
  if (recommendation) {
    message =
      recommendation.inputMode === "mbti"
        ? `Recommend ${recommendation.genre} film/TV for MBTI ${recommendation.mbti} (deep typology, not stereotypes).`
        : `Recommend ${recommendation.genre} film/TV for personality traits: ${recommendation.traits}`;
  }
  if (!message) {
    return json({ error: "message or recommendation is required" }, { status: 400 });
  }

  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  await stub.fetch("https://session/append", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "user", content: message }),
  });

  const histRes = await stub.fetch("https://session/messages");
  const histJson = (await histRes.json()) as {
    messages: { role: "user" | "assistant"; content: string }[];
  };

  const instance = await env.ARCHETYPE_WORKFLOW.create({
    id: crypto.randomUUID(),
    params: {
      sessionId,
      userMessage: message,
      history: histJson.messages,
      recommendation,
    } satisfies WorkflowParams,
  });

  const status = await instance.status();
  return json({
    sessionId,
    instanceId: instance.id,
    status: status.status,
    output: status.output,
    error: status.error,
  });
}

async function handleWorkflowStatus(url: URL, env: Env): Promise<Response> {
  const instanceId = url.searchParams.get("instanceId");
  if (!instanceId) {
    return json({ error: "instanceId required" }, { status: 400 });
  }
  const instance = await env.ARCHETYPE_WORKFLOW.get(instanceId);
  const status = await instance.status();
  return json({
    instanceId,
    status: status.status,
    output: status.output,
    error: status.error,
  });
}

// Probe Vectorize with a fixed string; if matches.length is 0, index is empty or unreachable.
async function handleCatalogHealth(env: Env): Promise<Response> {
  try {
    const probe =
      "Personality, temperament, and dramatic behavior (not plot summary). Walter White — Breaking Bad (tv). Prideful chemist antihero moral descent.";
    const out = await env.AI.run("@cf/baai/bge-m3", { text: [probe] });
    const data = (out as { data?: number[][] }).data;
    if (!data?.[0]?.length) {
      return json({ ok: false, seeded: false, error: "embedding failed" });
    }
    const res = await env.VECTORIZE.query(data[0], { topK: 3, returnMetadata: "all" });
    const matches = res.matches ?? [];
    return json({
      ok: true,
      seeded: matches.length > 0,
      matchCount: matches.length,
      top: matches[0]
        ? {
            id: matches[0].id,
            score: matches[0].score,
          }
        : null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ ok: false, seeded: false, error: message }, { status: 500 });
  }
}

async function handleSessionSocket(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  const parts = url.pathname.split("/");
  const sessionId = parts[3];
  if (!sessionId) return json({ error: "invalid path" }, { status: 400 });
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  return stub.fetch(new Request("https://session/socket", { headers: request.headers }));
}

async function handleSessionMessages(url: URL, env: Env): Promise<Response> {
  const parts = url.pathname.split("/");
  const sessionId = parts[3];
  if (!sessionId) {
    return json({ error: "invalid path" }, { status: 400 });
  }
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  const res = await stub.fetch("https://session/messages");
  return new Response(res.body, {
    status: res.status,
    headers: { ...Object.fromEntries(res.headers), ...cors() },
  });
}

type SeedRow = {
  id: string;
  workTitle: string;
  workType: "movie" | "tv";
  characterName: string;
  blurb: string;
  genres: string[];
  imageUrl?: string;
};

async function handleSeed(request: Request, env: Env): Promise<Response> {
  const expected = asTrimmedString(env.SEED_SECRET);
  if (!expected) {
    return json(
      {
        error: "SEED_SECRET not configured",
        hint: "Local: copy worker/.dev.vars.example to worker/.dev.vars (contains SEED_SECRET), restart wrangler dev. Deployed: wrangler secret put SEED_SECRET",
      },
      { status: 503 }
    );
  }
  const secret = request.headers.get("authorization");
  if (secret !== `Bearer ${expected}`) {
    return json(
      {
        error: "unauthorized",
        hint: "Authorization header must be exactly: Bearer <your SEED_SECRET from worker/.dev.vars>",
      },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const allRows = seedCharacters as SeedRow[];
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const rows = allRows.slice(offset, offset + limit);
  const vectors: VectorizeVector[] = [];

  const embedBatchSize = 24;
  for (let i = 0; i < rows.length; i += embedBatchSize) {
    const chunk = rows.slice(i, i + embedBatchSize);
    const texts = chunk.map((row) => {
      // Seed blurb is trait-only; anchor identity once with name + title for vector search.
      const core = `${row.characterName} — ${row.workTitle} (${row.workType}). ${row.blurb}`;
      return `Personality, temperament, and dramatic behavior (not plot summary). ${core}`;
    });
    const out = await env.AI.run("@cf/baai/bge-m3", { text: texts });
    const data = (out as { data?: number[][] }).data;
    if (!data?.length || data.length !== chunk.length) {
      return json(
        { error: `embed batch failed at offset ${i}` },
        { status: 500 }
      );
    }
    for (let j = 0; j < chunk.length; j++) {
      const row = chunk[j]!;
      const vec = data[j];
      if (!vec?.length) {
        return json({ error: `embed failed for ${row.id}` }, { status: 500 });
      }
      vectors.push({
        id: row.id,
        values: vec,
        metadata: {
          id: row.id,
          workTitle: row.workTitle,
          workType: row.workType,
          characterName: row.characterName,
          blurb: row.blurb.slice(0, 2000),
          genres: row.genres.join("|"),
          ...(row.imageUrl ? { imageUrl: row.imageUrl.slice(0, 2048) } : {}),
        },
      });
    }
  }

  const upsertBatchSize = 100;
  for (let i = 0; i < vectors.length; i += upsertBatchSize) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + upsertBatchSize));
  }
  return json({
    ok: true,
    count: vectors.length,
    offset,
    next: offset + rows.length < allRows.length ? offset + rows.length : null,
    total: allRows.length,
  });
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...cors(), ...init?.headers },
  });
}

function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  };
}
