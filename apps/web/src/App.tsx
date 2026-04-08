import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const APP_PASSWORD = import.meta.env.VITE_APP_PASSWORD ?? "";

/** Derive WebSocket base from API_BASE (http→ws, https→wss, or same-origin). */
function wsBase(): string {
  if (API_BASE) return API_BASE.replace(/^http/, "ws");
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

const MBTI_TYPES = [
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
] as const;

const GENRES_FALLBACK = [
  "Action", "Animation", "Comedy", "Crime", "Drama", "Fantasy",
  "Historical", "Horror", "Mystery", "Romance", "Science Fiction", "Sports", "Thriller",
];

type RecommendationCard = {
  id: string;
  characterName: string;
  workTitle: string;
  workType: string;
  blurb: string;
  rationale?: string;
  imageUrl?: string;
  genres?: string[];
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  cards?: RecommendationCard[];
};

const SESSION_KEY = "archetype_session";

function getSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function newSessionId(): string {
  const id = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, id);
  return id;
}

export function App() {
  const [unlocked, setUnlocked] = useState(!APP_PASSWORD);
  const [attempt, setAttempt] = useState("");
  const [sessionId, setSessionId] = useState(() => getSessionId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(
    "What if Walter White were dropped into a high fantasy epic?"
  );
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [genres, setGenres] = useState<string[]>(GENRES_FALLBACK);
  const [personalityMode, setPersonalityMode] = useState<"mbti" | "traits">("mbti");
  const [mbti, setMbti] = useState<string>(MBTI_TYPES[0]);
  const [traitsText, setTraitsText] = useState(
    "Introverted, stubbornly principled, dry humor, slow to trust, loyal once committed."
  );
  const [genre, setGenre] = useState("Fantasy");

  const loadHistory = useCallback(async () => {
    const res = await fetch(
      `${API_BASE}/api/session/${encodeURIComponent(sessionId)}/messages`
    );
    if (!res.ok) return;
    const data = (await res.json()) as { messages: ChatMessage[] };
    setMessages(data.messages ?? []);
  }, [sessionId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/genres`);
        if (!res.ok) return;
        const data = (await res.json()) as { genres?: string[] };
        if (data.genres?.length) {
          setGenres(data.genres);
          setGenre((g) => data.genres!.find((x) => x === g) ?? data.genres![0]);
        }
      } catch {}
    })();
  }, []);

  // WebSocket — persistent connection per session. The DO pushes progress events
  // and the final assistant message so the frontend never needs to poll.
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    const url = `${wsBase()}/api/session/${encodeURIComponent(sessionId)}/socket`;
    let ws: WebSocket;
    let dead = false;

    function connect() {
      if (dead) return;
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as {
            type: string;
            text?: string;
            message?: ChatMessage;
          };
          if (data.type === "progress") {
            setProgress(data.text ?? null);
          } else if (data.type === "message" && data.message) {
            setMessages((m) => [...m, data.message!]);
            setLoading(false);
            setProgress(null);
          } else if (data.type === "error") {
            setErr(data.text ?? "Something went wrong");
            setLoading(false);
            setProgress(null);
          }
        } catch {}
      };

      ws.onclose = () => {
        // Reconnect after a short delay so a lost connection doesn't strand the user
        if (!dead) setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      dead = true;
      ws?.close();
    };
  }, [sessionId]);

  async function runChat(body: Record<string, unknown>) {
    setErr(null);
    setLoading(true);
    setProgress("Starting…");
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(bodyText || `HTTP ${res.status}`);
      }
      
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setErr(msg);
      setLoading(false);
      setProgress(null);
    }
  }

  async function onPersonalitySubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (loading) return;
    const g = genre.trim();
    if (!g) { setErr("Pick a genre."); return; }
    if (personalityMode === "traits" && !traitsText.trim()) {
      setErr("Add at least one personality trait.");
      return;
    }
    const userLine =
      personalityMode === "mbti"
        ? `Personality + genre: MBTI ${mbti}, genre ${g}.`
        : `Personality + genre: traits (${traitsText.slice(0, 120)}…), genre ${g}.`;
    setMessages((m) => [...m, { role: "user", content: userLine }]);
    await runChat({
      sessionId,
      recommendation:
        personalityMode === "mbti"
          ? { inputMode: "mbti", mbti, genre: g }
          : { inputMode: "traits", traits: traitsText.trim(), genre: g },
    });
  }

  function onNewChat() {
    setSessionId(newSessionId());
    setMessages([]);
    setErr(null);
    setProgress(null);
  }

  async function sendChat() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    await runChat({ sessionId, message: text });
  }

  async function onChatSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    await sendChat();
  }

  if (!unlocked) {
    return (
      <div className="app" style={{ maxWidth: 320 }}>
        <h1 className="brand">Archetype</h1>
        <form onSubmit={(e) => { e.preventDefault(); if (attempt === APP_PASSWORD) setUnlocked(true); }}>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              type="text"
              value={attempt}
              onChange={(e) => setAttempt(e.target.value)}
              autoFocus
            />
          </label>
          <button type="submit" className="btn-primary" style={{ width: "100%", marginTop: "0.75rem" }}>
            Enter
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <h1 className="brand">Archetype</h1>
      <p className="tagline">
        Match film and TV through character traits — by chat, or by your personality +
        genre.
      </p>

      <section className="panel" aria-labelledby="personality-heading">
        <h2 id="personality-heading" className="panel-title">
          Recommend by personality + genre
        </h2>
        <p className="panel-desc">
          Enter your <strong>MBTI</strong>{" "}
          <em>or</em> a <strong>trait list</strong>, then choose a genre. Retrieval
          uses your profile + genre tags on each title in the catalog.
        </p>

        <form className="personality-form" onSubmit={onPersonalitySubmit}>
          <div className="mode-toggle">
            <label>
              <input
                type="radio"
                name="pmode"
                checked={personalityMode === "mbti"}
                onChange={() => setPersonalityMode("mbti")}
              />{" "}
              MBTI type
            </label>
            <label>
              <input
                type="radio"
                name="pmode"
                checked={personalityMode === "traits"}
                onChange={() => setPersonalityMode("traits")}
              />{" "}
              Personality traits
            </label>
          </div>

          {personalityMode === "mbti" ? (
            <label className="field">
              <span className="field-label">Myers-Briggs type</span>
              <select value={mbti} onChange={(e) => setMbti(e.target.value)} disabled={loading}>
                {MBTI_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span className="field-label">Traits (comma or short lines)</span>
              <textarea
                value={traitsText}
                onChange={(e) => setTraitsText(e.target.value)}
                rows={4}
                disabled={loading}
                placeholder="e.g. high openness, conflict-averse, sarcastic under stress…"
              />
            </label>
          )}

          <label className="field">
            <span className="field-label">Genre</span>
            <select value={genre} onChange={(e) => setGenre(e.target.value)} disabled={loading}>
              {genres.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </label>

          <button type="submit" className="btn-primary" disabled={loading}>
            Get recommendations
          </button>
        </form>
      </section>

      <div className="chat-heading-row">
        <h2 className="chat-heading">Chat</h2>
        <button className="btn-new-chat" onClick={onNewChat} disabled={loading}>
          New chat
        </button>
      </div>
      <div className="messages">
        {messages.length === 0 && !loading && (
          <div className="bubble assistant meta">
            Freeform questions work too — e.g. character mashups or "similar to X"
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`bubble ${m.role}${
              m.role === "assistant" && (m.cards?.length ?? 0) > 0 ? " bubble--rich" : ""
            }`}
          >
            {m.role === "assistant" ? (
              <AssistantMessage content={m.content} cards={m.cards} />
            ) : (
              m.content
            )}
          </div>
        ))}
        {loading && (
          <div className="bubble assistant meta">
            {progress ?? "Starting…"}
          </div>
        )}
      </div>

      {err && <p className="error">{err}</p>}

      <form className="form" onSubmit={onChatSubmit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendChat();
            }
          }}
          placeholder="Ask anything…"
          rows={3}
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function AssistantMessage({
  content,
  cards,
}: {
  content: string;
  cards?: RecommendationCard[];
}) {
  const hasCards = Boolean(cards && cards.length > 0);
  const footnote = content.trim();
  const bodyText = (c: RecommendationCard) =>
    (c.rationale?.trim() && c.rationale.trim()) || c.blurb;

  return (
    <div className="assistant-message">
      {hasCards && (
        <ol className="rec-cards" aria-label="Recommendations in order">
          {cards!.map((c, index) => (
            <li
              key={c.id}
              className="rec-card rec-card--enter"
              style={{ "--rec-stagger": index } as CSSProperties}
            >
              <div className="rec-card-header">
                <span className="rec-card-index" aria-hidden>{index + 1}.</span>
                <span className="rec-card-headline">
                  {c.characterName}
                  <span className="rec-card-headline-sep"> — </span>
                  <span className="rec-card-headline-work">{c.workTitle}</span>
                  <span className="rec-card-type-pill">
                    {c.workType === "tv" ? "TV" : "Movie"}
                  </span>
                </span>
              </div>
              <div className="rec-card-main">
                <div className="rec-card-body-col">
                  <p className="rec-card-explanation">{bodyText(c)}</p>
                  {c.genres && c.genres.length > 0 && (
                    <p className="rec-card-genres">{c.genres.join(" · ")}</p>
                  )}
                </div>
                <div className="rec-card-media">
                  <div className="rec-card-poster">
                    <div className="rec-card-avatar-floor" aria-hidden>
                      <span className="rec-card-avatar-initials">
                        {initialsFromName(c.characterName)}
                      </span>
                    </div>
                    {c.imageUrl ? (
                      <img
                        src={c.imageUrl}
                        alt=""
                        className="rec-card-photo"
                        loading="lazy"
                        decoding="async"
                        onError={(e) => { e.currentTarget.remove(); }}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {footnote && (
        <p className={hasCards ? "bubble-text bubble-text--footnote" : "bubble-text"}>
          {footnote}
        </p>
      )}
    </div>
  );
}
