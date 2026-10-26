# Signboard

A lightweight, locally hosted kanban board, MCP server and Claude skill for managing Claude Code work. (看板, *kanban*, literally means "signboard".) You plan tasks in the browser; Claude Code picks them up, comments on progress and moves them across the board through an MCP server. Changes show up in the UI live.

```
Browser UI ──┐
             ├──> REST API (server.js) ──> data/board.json
Claude Code ─┘    via MCP (mcp.js, stdio)
```

- **Stack:** Node 24+, zero-dependency HTTP server, vanilla HTML/JS UI, JSON file storage. The only npm deps are `@modelcontextprotocol/sdk` and `zod` for the MCP server.
- **Projects:** each kanban project has its own board and one or more linked folders (☰ menu in the UI).
- **Columns:** `bugs` · `decisions` · `backlog` → `todo` → `in_progress` → `review` → `done`
- **Priorities:** `low`, `medium`, `high`, `urgent`

## Workflows

```
            humans                     Claude                     humans
Backlog ───────────▶ To do ──claim──▶ In progress ──submit──▶ Review ───────▶ Done
                                 (locked to Claude)

Claude finds a bug        ──raise_bug──────▶ Bugs      ──human triage──▶ Backlog / To do
Claude needs a human call ──raise_decision─▶ Decisions ──human answer──▶ Backlog / To do
```

**1. Tasks.**
- **Release:** Backlog belongs to humans. You decide what work Claude can do by moving it to To do.
- **Claim:** Claude claims from To do, either the next one by priority, a specific one, or by polling with `wait_for_task`. Claiming moves the task to In progress and locks it to that agent, so no other session can edit or move it.
- **Finish:** Claude submits to Review with a summary of what changed, how it was verified, and follow-ups. You move it to Done.
- **Hand back:** Claude can release a task to To do with a reason.
- **New work:** Claude can't add work of its own. It can only split a task it has in progress into subtasks. Other ideas go in the review summary.

**2. Bugs.**
- **Raising:** when Claude finds a bug, it raises it in 🐞 Bugs. Every card has a type (task, bug or decision), and the type filter in the header shows just the bugs.
- **Triage:** you move bugs to Backlog or To do. Claude doesn't fix out-of-scope bugs on its own.
- **⚡ Autofix bugs** (project setting): Claude routes bugs itself, to To do, to In progress to fix them now, or to Decisions when how to fix it is your call.

**3. Decisions.**
- **Raising:** when a choice is yours, Claude raises it in ❓ Decisions with options and a recommendation instead of guessing. That covers unspecified behaviour, architecture or dependencies, anything destructive, and scope changes. The blocked task gets a note.
- **Answering:** open the card, click an option or type your own, and choose where it goes: To do (Claude acts on it) or Backlog (parked). The header badge counts decisions waiting on you across projects.
- **Changing your mind:** open an answered decision and click **Reopen decision**. It goes back to Decisions, open again. The old answer stays in its history, and the task it blocks is told not to act on that answer. Anything in the comment box is recorded as the reason.
- **💬 Decisions from chat** (project setting): when you answer in a Claude Code chat, Claude records your answer on the board, quoting your words, and carries on without waiting.

Turn the two settings on per project in ☰ → ⚙. Cards keep their kind (task, bug, decision) as they move. Dragging a task into Bugs or Decisions turns it into that kind. A bug can't be moved into Decisions, and a decision can't be moved into Bugs; raise a new card instead.

## Projects and Claude Code folders

A Claude Code session belongs to whichever kanban project has its working folder linked. Subfolders count too, and the deepest link wins. So when you start `claude` in `~/code/my-api`, its MCP tools automatically read and write the board of the project linked to `~/code/my-api`.

Two ways to link a folder:

- **In the UI:** open ☰ → ⚙ on a project (or create one with **+ New project**). The settings window suggests folders you've recently used Claude Code in, read from `~/.claude/projects`. Click one to link it, or type any absolute path.
- **From Claude Code:** in an unlinked folder, the tools return an error that prompts Claude to ask you which project it belongs to and then call `link_project`. You can also just say *"link this folder to the kanban project X"*.

Order of precedence for which project a tool call uses: an explicit `project` argument, then the `SIGNBOARD_PROJECT` env var (name or id), then the linked folder.

## Run it

You need Node 24 or later and [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/<you>/signboard.git
cd signboard
npm install
npm start          # http://localhost:4477
```

Environment variables: `SIGNBOARD_PORT` (default `4477`), `SIGNBOARD_DATA` (default `./data/board.json`). Your board lives in `data/`, which git ignores.

## Connect Claude Code

Register the MCP server once at user scope so every Claude Code session can see the board (run from this directory):

```bash
claude mcp add --scope user signboard -- node "$(pwd)/mcp.js"
```

The board server must be running (`npm start`); the MCP server is a thin client over it. Optional env for the MCP server:

- `SIGNBOARD_URL` — board address (default `http://localhost:4477`)
- `SIGNBOARD_AGENT` — name Claude uses when claiming/commenting (default `claude`). Give parallel sessions different names, e.g. `claude mcp add ... -e SIGNBOARD_AGENT=claude-api`.

### MCP tools

| Tool | What it does |
| --- | --- |
| `current_project` | Which project this session is in, its workflow settings and task counts |
| `list_projects` / `link_project` | See projects; link the current folder to one (or create it) |
| `list_tasks` / `get_task` | Read the board: filter by column, kind, assignee, text |
| `claim_next_task` / `claim_task` | Take the top To do task, or a specific one; moves it to In progress, locked |
| `wait_for_task` | Poll To do until work is released, then claim it |
| `submit_for_review` | In progress → Review, with a required summary |
| `release_task` | In progress → To do, unlocked, with a reason |
| `create_subtask` | Split a task you have in progress (the only way Claude adds work) |
| `update_task` | Edit title, description or priority of your claimed task, or of a bug or decision you raised |
| `add_comment` | Progress notes and findings (not on Backlog) |
| `raise_bug` | Bug with repro, expected/actual, location, severity → Bugs (or routed, with autofix) |
| `triage_bug` | Autofix only: Bugs → To do / In progress |
| `raise_decision` | Question, context, options, recommendation, blocking task → Decisions |
| `record_decision` | Decisions from chat only: record your chat answer, quoting you |
| `get_decisions` | Open and answered decisions, with where they are now |
| `delete_task` | Remove a task Claude created in error |

### Guardrails

The server enforces these rules on every request from Claude. The MCP server marks each request with an `X-Signboard-Agent` header, and requests from the UI are unrestricted.

- **Backlog is off-limits.** Claude never creates, edits, moves, claims or comments on Backlog tasks, and never moves anything into Backlog.
- **No Done.** Claude never moves anything to Done.
- **Claude's allowed moves:**
  - To do → In progress (claim)
  - In progress → Review (with a summary)
  - In progress → To do (release, with a reason)
- **Locking.** A task in progress belongs to the agent that claimed it. Other agents can't edit, move or claim it.
- **No new work.** Claude only creates bugs, decisions, and subtasks of its own in-progress task.
- **Bugs** stay in Bugs for you unless Autofix bugs is on.
- **Decisions** are answered only by you, either on the board, or in chat when Decisions from chat is on. A chat answer must quote you.
- **Settings.** Project settings can only be changed in the UI.
- **Deleting.** Claude can only delete tasks it created.

The MCP server also gives Claude a short workflow reminder whenever it connects. The skill tells Claude never to call the HTTP API directly. That is an honour-system rule: the server can't tell a hand-written request from a UI request.

## The signboard skill

[`skills/signboard/SKILL.md`](skills/signboard/SKILL.md) is a Claude Code skill with the full workflow:
- the start-of-session checks (linked project, answered decisions, resuming in-progress work),
- when to raise a bug versus fix it,
- what counts as your decision,
- what a review note must contain.

Install it for all projects by symlinking it into your user skills, so edits here take effect immediately:

```bash
mkdir -p ~/.claude/skills && ln -s "$(pwd)/skills/signboard" ~/.claude/skills/signboard
```

Then in any linked project just tell Claude *"work the board"*.

## REST API

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/api/board` | columns, priorities, projects and tasks; `?project=` to scope |
| GET | `/api/projects` | projects with linked folders and per-column counts |
| POST | `/api/projects` | `{name, paths?}` |
| GET/PATCH/DELETE | `/api/projects/:id` | PATCH `{name?, paths?, settings?: {autofixBugs, chatDecisions}}`; DELETE removes its tasks too |
| POST | `/api/projects/:id/paths` | `{path}`: link one more folder |
| GET | `/api/projects/resolve` | `?path=`: project linked to a folder (or 404) |
| GET | `/api/claude-projects` | folders Claude Code has been used in, newest first |
| GET | `/api/tasks` | `?project=&column=&kind=&assignee=&q=` (`kind`: task, bug, decision) |
| POST | `/api/tasks` | `{title, projectId, description?, column?, priority?, assignee?, relatedTaskId?, author?}`; decisions also take `options?, recommendation?` |
| GET | `/api/tasks/:id` | |
| PATCH | `/api/tasks/:id` | any editable field, plus `note?` (added as a comment) and `author?` |
| DELETE | `/api/tasks/:id` | |
| POST | `/api/tasks/:id/comments` | `{text, author?}` |
| POST | `/api/tasks/:id/decide` | `{answer, column?}`: answer a decision and route it (humans: `todo` / `backlog`); notifies the blocked task. Agents also send `userQuote` |
| POST | `/api/tasks/:id/reopen` | `{reason?}`: humans only. Take an answer back, return the decision to `decisions`, notify the blocked task |
| POST | `/api/claim` | `{assignee, projectId, column?}` or `{assignee, taskId}` → `{task}` or `{task: null}` |

Boards created before projects existed are migrated on startup: all their tasks move into a "General" project.

## Security

Signboard is for one person on one machine. The server has no login, so it protects itself in other ways:

- It binds to `127.0.0.1` only, so nothing else on the network can reach it.
- It only answers requests addressed to `localhost`, `127.0.0.1` or `[::1]`, which stops DNS-rebinding attacks.
- It refuses requests from other web origins, and requires a JSON body on writes. A web page you visit can't change your board.

Don't expose it through a tunnel or reverse proxy. Anyone who can reach it can release work to your Claude sessions.

The agent guardrails (Backlog, Done, locking) stop Claude from overstepping by mistake. They are not a security boundary: anything that can run commands on your machine can call the API as a human.

## License

[MIT](LICENSE)
