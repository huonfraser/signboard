# Kanban Vibes

A lightweight, local kanban board for managing Claude Code work. You plan tasks in the browser; Claude Code picks them up, comments on progress and moves them across the board through an MCP server. Changes show up in the UI live.

```
Browser UI ──┐
             ├──> REST API (server.js) ──> data/board.json
Claude Code ─┘    via MCP (mcp.js, stdio)
```

- **Stack:** Node 24+, zero-dependency HTTP server, vanilla HTML/JS UI, JSON file storage. The only npm deps are `@modelcontextprotocol/sdk` and `zod` for the MCP server.
- **Projects:** each kanban project has its own board and one or more linked folders (☰ menu in the UI).
- **Columns:** `backlog` → `todo` → `in_progress` → `review` → `done`
- **Priorities:** `low`, `medium`, `high`, `urgent`

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
| `move_task` | Move to a column with an optional note |
| `add_comment` | Progress updates, findings, questions for you |
| `claim_next_task` | Take the current project's top unassigned task (priority, then board order), assign it and move it to `in_progress` |
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
| GET | `/api/board` | columns, priorities, projects and tasks; `?project=` to scope |
| GET | `/api/projects` | projects with linked folders and per-column counts |
| POST | `/api/projects` | `{name, paths?}` |
| GET/PATCH/DELETE | `/api/projects/:id` | PATCH `{name?, paths?}`; DELETE removes its tasks too |
| POST | `/api/projects/:id/paths` | `{path}`: link one more folder |
| GET | `/api/projects/resolve` | `?path=`: project linked to a folder (or 404) |
| GET | `/api/claude-projects` | folders Claude Code has been used in, newest first |
| GET | `/api/tasks` | `?project=&column=&assignee=&tag=&q=` |
| POST | `/api/tasks` | `{title, projectId, description?, column?, priority?, assignee?, tags?, author?}` |
| GET | `/api/tasks/:id` | |
| PATCH | `/api/tasks/:id` | any editable field, plus `author?` |
| DELETE | `/api/tasks/:id` | |
| POST | `/api/tasks/:id/comments` | `{text, author?}` |
| POST | `/api/claim` | `{assignee, projectId, column?, tag?}` → `{task}` or `{task: null}` |

Boards created before projects existed are migrated on startup: all their tasks move into a "General" project.

The server binds to `127.0.0.1` only and has no auth. It is meant for local use.
