# Kanban Vibes

A lightweight, local kanban board for managing Claude Code work. You plan tasks in the browser; Claude Code picks them up, comments on progress and moves them across the board through an MCP server. Changes show up in the UI live.

```
Browser UI ──┐
             ├──> REST API (server.js) ──> data/board.json
Claude Code ─┘    via MCP (mcp.js, stdio)
```

- **Stack:** Node 24+, zero-dependency HTTP server, vanilla HTML/JS UI, JSON file storage. The only npm deps are `@modelcontextprotocol/sdk` and `zod` for the MCP server.
- **Projects:** each kanban project has its own board and one or more linked folders (☰ menu in the UI).
- **Columns:** `bugs` · `decisions` · `backlog` → `todo` → `in_progress` → `review` → `done`
- **Priorities:** `low`, `medium`, `high`, `urgent`

## Bugs and decisions

Two intake columns where Claude reports back to you:

- **🐞 Bugs:** Claude raises a bug (`raise_bug`) whenever it finds a defect, including ones outside its current task, with steps to reproduce, expected and actual behaviour, and the file location. Out-of-scope bugs are recorded, not silently fixed. Triage them by dragging to To do, or tell Claude to "fix the bugs".
- **❓ Decisions:** when a choice belongs to you (unspecified behaviour, architecture or dependencies, anything destructive, scope changes), Claude raises a decision (`raise_decision`) with options and a recommendation instead of guessing. The blocked task gets a comment pointing at it. Open the card and click an option, or type your own answer. The decision files itself in Done, the blocked task is told the answer, and Claude picks it up with `get_decisions` next session. The header badge counts decisions waiting on you across all projects.

Cards keep their kind after leaving these columns, and dragging a card into Bugs or Decisions turns it into that kind.

## Projects and Claude Code folders

A Claude Code session belongs to whichever kanban project has its working folder linked. Subfolders count too, and the deepest link wins. So when you start `claude` in `~/code/my-api`, its MCP tools automatically read and write the board of the project linked to `~/code/my-api`.

Two ways to link a folder:

- **In the UI:** open ☰ → ⚙ on a project (or create one with **+ New project**). The settings window suggests folders you've recently used Claude Code in, read from `~/.claude/projects`. Click one to link it, or type any absolute path.
- **From Claude Code:** in an unlinked folder, the tools return an error that prompts Claude to ask you which project it belongs to and then call `link_project`. You can also just say *"link this folder to the kanban project X"*.

Order of precedence for which project a tool call uses: an explicit `project` argument, then the `KANBAN_PROJECT` env var (name or id), then the linked folder.

## Run it

```bash
npm install
npm start          # http://localhost:4477
```

Environment variables: `KANBAN_PORT` (default `4477`), `KANBAN_DATA` (default `./data/board.json`).

## Connect Claude Code

Register the MCP server once at user scope so every Claude Code session can see the board (run from this directory):

```bash
claude mcp add --scope user kanban -- node "$(pwd)/mcp.js"
```

The board server must be running (`npm start`); the MCP server is a thin client over it. Optional env for the MCP server:

- `KANBAN_URL` — board address (default `http://localhost:4477`)
- `KANBAN_AGENT` — name Claude uses when claiming/commenting (default `claude`). Give parallel sessions different names, e.g. `claude mcp add ... -e KANBAN_AGENT=claude-api`.

### MCP tools

| Tool | What it does |
| --- | --- |
| `current_project` | Which project this session is working in |
| `list_projects` | All projects with linked folders and task counts |
| `link_project` | Link the current (or a given) folder to an existing project, or create one |
| `list_tasks` | Tasks in the current project (or `all_projects`), filter by column / assignee / tag / text |
| `get_task` | Full task with description and activity log |
| `create_task` | Add a task to the current project (subtasks, follow-ups) |
| `update_task` | Change title, description, column, priority, assignee, tags, or project |
| `move_task` | Move to a column with a note (required for review) |
| `add_comment` | Progress updates, findings, questions for you |
| `claim_next_task` | Take the current project's top unassigned task (priority, then board order) from To do, or Bugs, assign it and move it to `in_progress` |
| `raise_bug` | Record a bug in Bugs with repro steps, expected/actual, location, severity |
| `raise_decision` | Ask you to decide: question, context, 2–6 options, recommendation, blocking task |
| `get_decisions` | Open / answered decisions with your answers |
| `delete_task` | Remove a task Claude created in error |

### Workflow guardrails

The MCP tools enforce the workflow. Claude can't work around these limits; you can do anything in the UI.

- Claude can't move tasks to Done; you close them after review.
- Claude can't resolve, move or claim an open decision; only you can answer it.
- Moving to Review requires a note (what changed, how it was verified, follow-ups).
- Bugs and decisions can only be created through `raise_bug` and `raise_decision`, so they're always structured.
- Claude can only delete tasks it created.

The MCP server also sends Claude a short instruction about the workflow whenever it connects.

## The kanban skill

[`skills/kanban/SKILL.md`](skills/kanban/SKILL.md) is a Claude Code skill with the full workflow:
- the start-of-session checks (linked project, answered decisions, resuming in-progress work),
- when to raise a bug versus fix it,
- what counts as your decision,
- what a review note must contain.

Install it for all projects by symlinking it into your user skills, so edits here take effect immediately:

```bash
mkdir -p ~/.claude/skills && ln -s "$(pwd)/skills/kanban" ~/.claude/skills/kanban
```

Then in any linked project just tell Claude *"work the board"*.

## REST API

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/api/board` | columns, priorities, projects and tasks; `?project=` to scope |
| GET | `/api/projects` | projects with linked folders and per-column counts |
| POST | `/api/projects` | `{name, paths?}` |
| GET/PATCH/DELETE | `/api/projects/:id` | PATCH `{name?, paths?}`; DELETE removes its tasks too |
| POST | `/api/projects/:id/paths` | `{path}`: link one more folder |
| GET | `/api/projects/resolve` | `?path=`: project linked to a folder (or 404) |
| GET | `/api/claude-projects` | folders Claude Code has been used in, newest first |
| GET | `/api/tasks` | `?project=&column=&kind=&assignee=&tag=&q=` (`kind`: task, bug, decision) |
| POST | `/api/tasks` | `{title, projectId, description?, column?, priority?, assignee?, tags?, relatedTaskId?, author?}`; decisions also take `options?, recommendation?` |
| GET | `/api/tasks/:id` | |
| PATCH | `/api/tasks/:id` | any editable field, plus `author?` |
| DELETE | `/api/tasks/:id` | |
| POST | `/api/tasks/:id/comments` | `{text, author?}` |
| POST | `/api/tasks/:id/decide` | `{answer, author?}`: answer a decision, move it to done, notify the blocked task |
| POST | `/api/claim` | `{assignee, projectId, column?, tag?}` → `{task}` or `{task: null}` |

Boards created before projects existed are migrated on startup: all their tasks move into a "General" project.

The server binds to `127.0.0.1` only and has no auth. It is meant for local use.
