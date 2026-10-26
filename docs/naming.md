# Naming and positioning (#6)

Research into comparable tools, what sets this board apart, and name options. **Outcome:** the user chose **Signboard** (decision #16): "a lightweight, locally hosted kanban board, MCP server and Claude skill". The rename was applied separately under #16.

Research was done on 2026-10-26 from web search results, mostly directory listings (glama.ai, mcpservers.org, Product Hunt, pkg.go.dev). Repos were not cloned or verified, so treat feature lists as approximate.

## The landscape

Kanban-for-agents is a crowded space in 2026. Comparable tools fall into four groups.

### 1. Orchestrators: the board launches and runs agents

| Tool | What it does |
|---|---|
| **Vibe Kanban** (BloopAI) | The best-known one. Runs 10+ coding agents (Claude Code, Codex, Gemini CLI, …) in parallel, each in its own git worktree; diff review, inline feedback, PR creation. `npx vibe-kanban`. Reportedly community-maintained since bloop wound down in 2026. |
| **Agent Task Board** (davidcjw) | Local-first; Queued → Running → Review → Done lanes; orchestration built around Claude Code. |
| **Board** (Claude Code kanban) | A watcher auto-spawns `claude -p /next-task`; one branch and PR per task. |
| **KAGAN** | Terminal kanban; low-risk tickets run autonomously, a review agent checks before merge. |
| **ntasker** | Agent picks up a dropped card, its report waits for your sign-off; a queue runs the rest unattended. |
| **Agent Kanban** (saltbo) | Agents as team members with identities and worktrees; a leader agent reviews and merges PRs; humans mostly read. |

### 2. Passive MCP boards: the agent stays in control and reports to the board

| Tool | What it does |
|---|---|
| **mcp-kanban** (gablabelle) | Explicitly not an orchestrator: Claude Code/Codex/Cursor report through MCP, you watch a live web UI. Ships as a Claude Code plugin. |
| **Kanban MCP** (eyalzh) | Kanban as memory across multi-session workflows; WIP limits, SQLite, web UI. |
| **kaban** (beshkenadze) | SQLite file, TUI and CLI; a hook syncs Claude Code's TodoWrite to the board. |
| **kanbo**, **Backplane**, **Veritas Kanban**, **TaskBoardAI**, **KanbanMCP.com**, **Runlane**, **kelvia-mcp** (58 tools) | General kanban boards with MCP access; some hosted, some local. |

### 3. Spec/plan-to-tasks generators

| Tool | What it does |
|---|---|
| **Taskmaster** (`task-master-ai`) | Parses a PRD into tasks and subtasks, expands them with an LLM. The agent works its own list. |
| **Backlog.md** | Tasks, docs and decision records as Markdown in the repo; CLI, web view and MCP. State lives in git. |

### 4. Human-in-the-loop gates (not boards)

| Tool | What it does |
|---|---|
| **AgentBoard** | Acceptance-driven: human approves the plan, then accepts or rejects the result; logs decisions. Closest in spirit. |
| **Tasklix**, **WhatsAgent** | Agents claim work by capability and escalate approvals; WhatsAgent has a Blocked column and close-approval for epics. |
| **awaithumans** | Library that pauses an agent to ask a human (Slack, email, web) and resumes with the answer. |
| **Claude Wall** | Dashboard over tmux sessions with a one-click approve/deny queue. |

## How this board compares

Most tools pick one end: either the board runs the agents (group 1) or the agent runs the board (groups 2 and 3). This one sits in between, with an explicit split of authority enforced by the server:

| | This board | Vibe Kanban / orchestrators | Passive MCP boards | Taskmaster / Backlog.md |
|---|---|---|---|---|
| Who releases work | **Human only** (Backlog → To do; Claude can't touch Backlog) | Human starts runs | Anyone, including the agent | Agent generates tasks |
| Who closes work | **Human only** (Claude can't move to Done) | Human merges | Anyone | Agent |
| Claim locking between sessions | **Yes**, enforced server-side | Worktree per task | Rarely | No |
| Agent-found bugs | **Own intake column**, human triage (or opt-in autofix routing) | No | As ordinary cards | As tasks |
| Agent questions for the human | **Decisions column** with options, recommendation, blocked-task link, reopen | Chat/feedback on a run | No | Backlog.md has decision records (human-written) |
| Agent may add its own work | **No**, only subtasks of a claimed task; ideas go in review notes | n/a | Yes | Yes |
| Launches agents | Optional: the coordinating session opens one Claude Code session per item, up to a set limit | Core feature | No | No |
| Footprint | Node, 2 deps, JSON file, vanilla UI | Rust + web app | Varies (SQLite, Next.js, hosted) | npm CLI / git files |

Things almost nobody else does:

1. **Guardrails are enforced, not suggested.** The server refuses Claude moving work to Done, editing Backlog, or touching another session's claim, and returns an error explaining why. Other boards rely on prompt instructions.
2. **The agent's outputs to the human are typed.** Bugs and decisions each get an intake column with a structured shape (repro steps, severity; options, recommendation, blocking task) and a human answer path, instead of free-text comments.
3. **Humans own both ends of the flow.** The agent cannot release or create new work for itself, so scope never grows behind the user's back. Ideas come back as follow-ups in the review note.
4. **It works with Claude Code as it is,** through MCP plus a skill, without wrapping or spawning the agent. Session fan-out is an option, not the architecture.

Weaknesses compared with the field: no worktree isolation or diff review (Vibe Kanban), single-agent focus (Claude Code only), no git-native storage (Backlog.md), and no hosted or multi-user mode.

## Comparative advantage, in one line

> **The kanban board where humans hold the keys:** you release the work and sign it off; Claude claims it under lock, hands back bugs and decisions instead of guessing, and can never mark its own work done.

## Name options

### Round 1

"Kanban Vibes" collides with **Vibe Kanban**, the best-known tool in this space, so a rename is worth considering. Names checked and found taken by agent tools: *Airlock* (Code Airlock), *Tether* (tether-mcp), *Pitwall* (pitwall), *Handrail* (svyatov/handrail), *Dispatch* (Claude Code Dispatch).

| Name | Rationale | Clash check |
|---|---|---|
| **Countersign** (round-1 pick) | A countersignature is a second, authorising signature: Claude does the work, a human signs it in and signs it off. Names the actual differentiator. | No software or agent tool found by that name. |
| **Gatehouse** | Humans keep the gates (release, triage, answer, close); the agent works inside them. | No agent or kanban tool found. |
| **Keep Kanban Vibes** | No migration cost; already in package.json and the README (the MCP server itself is just `kanban`). | Very close to Vibe Kanban, which invites confusion. |

Domain and npm availability were not checked.

### Round 2: Kanban + MCP

The user asked for names that draw on kanban and MCP.

- **Literal blends are taken:** *kanban-mcp* (eyalzh, sifyfy, dzikrihilman), *KanbanMCP.com* and *KnBn MCP* already exist. *Kanban Context Protocol* is free, but it reads like a spec.
- **Toyota Production System words** fit better. Kanban comes from that system, and so does the idea of a machine that stops and calls a human. *Andon* is taken by an MCP server.

| Name | Rationale | Clash check |
|---|---|---|
| **Signboard** (recommended, chosen) | 看板 (kanban) literally means "signboard", and humans sign work in and sign it off. | Nothing found |
| **Jidoka** | Toyota's "automation with a human touch": the machine stops and calls a person when something is off, as Bugs, Decisions and never-mark-it-Done do here. | Nothing found in dev or AI tools |
| **Countersign** | Carried over from round 1. | Nothing found |
| **Pullboard** | Kanban is a pull system, and Claude pulls released work over MCP. Less distinctive. | Not checked |

Tagline: *the kanban for Claude: you release the work, Claude pulls it over MCP, you sign it off.*
