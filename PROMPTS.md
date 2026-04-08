## Prompts used while building Archetype

This file is the running record of the prompts I used as I built this project, organized by category so it is easier to see intent, tradeoffs, and the process behind its features. It contains the most relevant prompts - I also had other conversations with the agent, though those were mainly to suggest fixes to specific errors when they arose (as opposed to creating the features themselves).

---------------------------------

### React frontend

---------------------------------

Write the boilerplate code for a single-page React app (Vite + TypeScript, no router) for “Archetype”: an app that recommends movie / TV titles by character traits. The UI should be one column, clear hierarchy (not a dashboard) in a dark purple color scheme.

Two ways for user input should be clear: 
    (1) a panel where I can pick an MBTI (dropdown) or list traits (text input) + a genre from a dropdown. Genres will load from the API when it is available. 
    (2) a chat interface for freeform messages.

Wire everything to a configurable API base URL (env). Chat should call the chat endpoint, get back a workflow id, then poll status until the run completes. Remote runs can take a long time, so use a generous timeout and a clear error if things stall.

---------------------------------

### Data pipeline 

---------------------------------

Work with me to create a Node script that builds a seed JSON file from TMDB: many US English film/TV roles, genres mapped to our fixed labels. Each title is matched with a blurb, which should prioritize traits (motivation, habits under pressure) over plot.

---------------------------------

### Cloudflare Worker

---------------------------------

I’ve created the vector index and wired embeddings plus vector search in the worker toolchain (empty until seeding runs). The catalog rows live in the local seed file and vectors only land in the index once the worker can embed and upsert. 

Assist me in managing APIs for: 
- JSON + CORS for the static app
- chat/recommendation entry (freeform or MBTI/traits + genre, validated against the shared genre list)
- session append / workflow start with an id the client can poll

Mainly help with making config, env, and types line up and not missing validation or CORS requirements.

---------------------------------

### Durable Object 

---------------------------------

Add a Durable Object per session that stores a bounded chat history. Support reading messages and appending user/assistant turns; assistant turns can include recommendation cards so a page refresh still shows the same picks.

---------------------------------