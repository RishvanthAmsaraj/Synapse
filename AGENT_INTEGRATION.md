# Driving the Synapse canvas from an external agent

The voice model is one client of the canvas, not its owner. Any process that
can make an HTTP request can put panels on the stage — a coding agent, a
research loop, a framework like Hermes or OpenClaw — while the user keeps
talking to Synapse about what it is doing.

## Endpoint

```
POST /api/panel
Content-Type: application/json

{ "name": "<tool>", "args": { ... }, "agent": "optional-label" }
```

`agent` is attribution, not a tool argument. Panels created by an external
agent carry its label in the corner, so when several agents are working on the
canvas at once you can see which one put a given panel there.

Calls run through the **same validator** as the voice model's, so an external
agent gets no more privilege over the canvas than Gemini has. Unknown tools
and malformed arguments are rejected with `400`; `409` means no canvas is
currently connected.

## Panels are addressed by slug

Every panel tool takes a `panel` slug. A new slug opens a panel; re-using one
replaces it in place. This is what lets an agent stream progress into a fixed
set of panels instead of accumulating clutter.

```bash
# Open a plan panel
curl -X POST localhost:3001/api/panel -H 'content-type: application/json' -d '{
  "name": "text_show",
  "args": { "panel": "plan", "title": "Plan",
            "content": "- [x] scaffold\n- [ ] auth\n- [ ] tests" }
}'

# Replace the same panel as work progresses — same slug
curl -X POST localhost:3001/api/panel -H 'content-type: application/json' -d '{
  "name": "text_show",
  "args": { "panel": "plan", "title": "Plan",
            "content": "- [x] scaffold\n- [x] auth\n- [ ] tests" }
}'

# Show the file being written, in its own panel
curl -X POST localhost:3001/api/panel -H 'content-type: application/json' -d '{
  "name": "code_viewer_show",
  "args": { "panel": "auth-ts", "language": "typescript",
            "code": "export function signIn() {\n  // ...\n}" }
}'

# Walk the user through it
curl -X POST localhost:3001/api/panel -H 'content-type: application/json' -d '{
  "name": "code_viewer_next_highlight",
  "args": { "panel": "auth-ts", "start_line": 1, "end_line": 3 }
}'

# Lay it out: 12-column grid, rows 1-4
curl -X POST localhost:3001/api/panel -H 'content-type: application/json' -d '{
  "name": "arrange_panel", "args": { "panel": "auth-ts", "cols": 8, "rows": 3 }
}'

# Spotlight it
curl -X POST localhost:3001/api/panel -H 'content-type: application/json' -d '{
  "name": "focus_panel", "args": { "panel": "auth-ts" }
}'
```

## Available tools

| Tool | Args |
|---|---|
| `text_show` | `panel`, `content`, `title?` |
| `image_show` | `panel`, `query` (subject noun phrase; the server resolves the image) |
| `code_viewer_show` | `panel`, `language`, `code` |
| `code_viewer_next_highlight` | `panel`, `start_line`, `end_line` |
| `exec_python` | `code`, `description` |
| `activity_log` | `panel`, `label`, `detail?`, `url?`, `status?` (`running`/`done`/`error`) |
| `arrange_panel` | `panel`, `cols` (2-12), `rows` (2-14) — the stage is 12 x 8 |
| `focus_panel` | `panel` |
| `close_panel` | `panel` |
| `clear_canvas` | — |

## Notes

- `focus_panel` also turns the face toward that panel on screen. An agent
  narrating its own work gets deixis for free.
- The user can drag and resize panels at any time. Treat layout as shared:
  `arrange_panel` sets a sensible starting size, it does not enforce one.
- `GET /health` reports how many canvases are connected.


---

# Using Synapse as a front end for a local agent

Synapse does not care what is on the other end. It needs a process that can
make HTTP requests; the agent framework running on your machine already can.

## The shape of the integration

Wrap your agent's tool-call hook so that every call it makes also POSTs a
panel. Most frameworks expose a callback or middleware for this — anywhere you
can see "the agent is about to run tool X with arguments Y" is the right place.

```python
import requests
SYNAPSE = "http://localhost:3001/api/panel"

def show(name, args, agent="local-agent"):
    try:
        requests.post(SYNAPSE, json={"name": name, "args": args, "agent": agent}, timeout=2)
    except requests.RequestException:
        pass  # the canvas is a view, never a dependency of the agent

def on_tool_call(tool, args):
    # One activity panel, appended to. Send "running" when a step starts and
    # the SAME label again with "done" or "error" when it finishes — the entry
    # updates in place rather than appearing twice.
    show("activity_log", {
        "panel": "work",
        "label": tool,
        "detail": str(args)[:120],
        "url": args.get("url"),          # rendered as a real link if present
        "status": "running",
    })

def on_tool_result(tool, ok, summary):
    show("activity_log", {
        "panel": "work",
        "label": tool,
        "detail": summary[:120],
        "status": "done" if ok else "error",
    })

def on_file_written(path, source, language):
    show("code_viewer_show", {
        "panel": path.replace("/", "-"),
        "language": language,
        "code": source,
    })
    show("focus_panel", {"panel": path.replace("/", "-")})
```

Two habits make this feel good rather than noisy:

- **Reuse slugs for streams, mint slugs for artifacts.** Progress, status and
  the current step belong in one panel that keeps being replaced. A file the
  agent wrote deserves its own panel that stays.
- **Call `focus_panel` when the agent moves on.** The face turns toward the
  panel it is about to discuss, and the canvas follows the work.

## Talking to the agent, rather than about it

Synapse's own voice loop and the ingest endpoint are independent. The voice
model narrates and answers questions about whatever is on the canvas; your
agent puts its work there. If you want the voice model to be able to *drive*
your agent as well, expose the agent behind one more tool in `tools.ts` and
handle it in the proxy — at that point the voice becomes the agent's operator
rather than its commentator.

## Known limits

- Panels are pushed, never pulled. Synapse cannot ask your agent for state.
- Editing a text panel notifies the **voice model**, not your agent. Routing
  user edits back out to an external agent needs an outbound webhook, which
  does not exist yet.


## Seeing what the agent is doing

`activity_log` is the panel to reach for when the interesting thing is the
work rather than the output. It renders a live feed: a pulsing dot for the
step currently running, green for finished, red for failed, and any `url` as
a clickable link so you can go and look at the page the agent opened.

Reuse one slug for the whole run. Sending the same `label` again with a
terminal status updates that row in place, so a step goes from running to done
rather than the feed filling with duplicates. The feed keeps the last 60 rows.

Pair it with `focus_panel` and the face turns toward the feed whenever the
agent starts something new.


## Layout, from either side

The grid is 12 columns wide and 8 rows tall at the default stage size, with
rows and columns at roughly the same pixel size — so `cols` and `rows` map
directly to a shape.

The user can drag any panel to a new position, drag its corner to resize, or
press the corner without dragging to pick a preset footprint. An agent setting
`arrange_panel` is choosing a sensible starting size, not enforcing one; the
user's layout always wins after they touch it.
