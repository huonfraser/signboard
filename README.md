# Kanban Vibes

A lightweight, local kanban board for managing Claude Code work. You plan tasks in the browser; Claude Code picks them up, comments on progress and moves them across the board through an MCP server. Changes show up in the UI live.

```
Browser UI ──┐
             ├──> REST API (server.js) ──> data/board.json
Claude Code ─┘    via MCP (mcp.js, stdio)
```

- **Stack:** Node 24+, zero-dependency HTTP server, vanilla HTML/JS UI, JSON file storage. The only npm deps are `@modelcontextprotocol/sdk` and `zod` for the MCP server.
- **Columns:** `backlog` → `todo` → `in_progress` → `review` → `done`
- **Priorities:** `low`, `medium`, `high`, `urgent`

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
| `list_tasks` | List tasks, filter by column / assignee / tag / text |
| `get_task` | Full task with description and activity log |
| `create_task` | Add a task (subtasks, follow-ups) |
| `update_task` | Change title, description, column, priority, assignee, tags |
| `move_task` | Move to a column with an optional note |
| `add_comment` | Progress updates, findings, questions for you |
| `claim_next_task` | Take the top unassigned task (priority, then board order), assign it and move it to `in_progress` |
| `delete_task` | Remove a task |

### Suggested workflow (paste into a project's CLAUDE.md)

```markdown
## Task board
Work is tracked on the kanban MCP server.
- Start with `claim_next_task` (or the task id I give you) and read its description.
- Comment with `add_comment` when you make a meaningful decision or hit a blocker.
- Create follow-up tasks in `backlog` instead of expanding scope.
- When done, `move_task` to `review` with a short summary of what changed and how it was tested. Never move tasks to `done` — I do that after review.
```

Then just tell Claude: *"work the board"*.

## REST API

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/api/board` | columns, priorities and all tasks |
| GET | `/api/tasks` | `?column=&assignee=&tag=&q=` |
| POST | `/api/tasks` | `{title, description?, column?, priority?, assignee?, tags?, author?}` |
| GET | `/api/tasks/:id` | |
| PATCH | `/api/tasks/:id` | any editable field, plus `author?` |
| DELETE | `/api/tasks/:id` | |
| POST | `/api/tasks/:id/comments` | `{text, author?}` |
| POST | `/api/claim` | `{assignee, column?, tag?}` → `{task}` or `{task: null}` |

The server binds to `127.0.0.1` only and has no auth. It is meant for local use.
