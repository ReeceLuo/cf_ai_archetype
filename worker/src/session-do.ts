import type { ChatMessage, RecommendationCard } from "./types";

// Per-session chat transcript (last N turns) + WebSocket broadcast channel.
export class SessionDO {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/socket") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET" && url.pathname === "/messages") {
      const messages = (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
      return json({ messages });
    }

    if (request.method === "POST" && url.pathname === "/append") {
      const body = (await request.json()) as {
        role: "user" | "assistant";
        content: string;
        cards?: RecommendationCard[];
      };
      const messages = (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
      const entry: ChatMessage = { role: body.role, content: body.content };
      if (body.cards !== undefined && body.cards.length > 0) {
        entry.cards = body.cards;
      }
      messages.push(entry);
      await this.ctx.storage.put("messages", messages.slice(-40));

      if (body.role === "assistant") {
        this.broadcast({ type: "message", message: entry });
      }

      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/broadcast") {
      const body = await request.json();
      this.broadcast(body);
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string): void {
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
  }

  private broadcast(data: unknown): void {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Client already gone; ignore.
      }
    }
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...corsHeaders(), ...init?.headers },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
}
