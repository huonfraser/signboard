---
name: kanban
description: Workflow for working from the local kanban board (the `kanban` MCP server). Use whenever the kanban MCP tools are available and you are doing project work, when the user says "work the board", "next task", "check the board", or refers to a task by number, and whenever you find a bug or reach a decision the user should make. Covers claiming tasks, logging progress, raising bugs into the Bugs column, raising decisions into the Decisions column, and handing work back for review.
---

# Kanban workflow

The kanban board is the shared record between you and the user. You keep it accurate as you work, so the user can see what you're doing, what you found, and what you need from them without reading the transcript.

Columns: **Bugs** · **Decisions** · Backlog · To do · In progress · Review · Done.

The MCP tools enforce some of this workflow. Claude cannot move tasks to Done, resolve decisions, move to Review without a note, or delete tasks it didn't create. Don't try to work around these limits; they are the workflow.

## 1. Start of session

1. Call `current_project`. If the folder isn't linked, ask the user which project it belongs to (show `list_projects`), then `link_project`. Don't guess.
2. Call `get_decisions`. For each **answered** decision you raised, read the answer and act on it: unblock the task it was blocking and comment on that task saying which decision unblocked it.
3. Call `list_tasks(assignee: "claude", column: "in_progress")`. If something is already in progress, resume it rather than claiming new work.

## 2. Picking up work

- If the user named a task, `get_task` it, then `update_task(id, assignee: "claude")` and `move_task(id, "in_progress")`.
- Otherwise `claim_next_task` (from To do). If the user asks you to fix bugs, `claim_next_task(column: "bugs")`.
- Read the full description and activity log before starting. If the acceptance criteria are unclear in a way that changes what you'd build, raise a decision (section 5) rather than guessing.

## 3. While working

- `add_comment` at meaningful points: approach chosen, a non-obvious discovery, partial progress on long tasks. Keep it short and factual. Don't post a running commentary.
- Work you discover that's **outside the current task's scope**: `create_task` in `backlog` with enough context to pick up cold. Don't expand scope silently.
- Stay on one task at a time. If you must stop partway, comment on what's done and what's left.

## 4. Bugs → `raise_bug`

Raise a bug **whenever you find a defect**, whether in the code you're touching, code you're reading, tests, tooling, or behaviour you observe. This includes bugs unrelated to your current task.

- First check `list_tasks(column: "bugs")` (and `query:` with a keyword) for an existing entry. If one exists, `add_comment` on it with any new information instead of raising a duplicate.
- Fill in `summary`, `steps_to_reproduce`, `expected`, `actual`, and `location` (file:line) where you know them. Set `severity` honestly: urgent means data loss, security, or a broken main path.
- Pass `found_while_task_id` with your current task.
- **Fix or not?**
  - Fix it as part of the current task only if it's inside the task's scope or blocks it. Still raise it, then note the fix in a comment on the bug and in your review summary.
  - Otherwise raise it and carry on. The user triages Bugs.
- A bug is not: a style preference, a refactor opportunity, or a missing feature. Those go to `backlog` via `create_task`, if anywhere.

## 5. Decisions → `raise_decision`

Raise a decision whenever **the choice belongs to the user** rather than being an implementation detail you can reasonably make. Typical triggers:

- Product or UX behaviour that isn't specified ("what should happen when…").
- Architecture, data model, or public API shape with lasting consequences.
- Adding a dependency, service, or paid resource.
- Anything destructive or hard to reverse: data migrations, deleting files or data, force-pushes, changing a schema in place.
- Scope changes: the task turns out much bigger or different than described.
- Requirements that conflict with each other or with existing behaviour.

How to raise one:

- `question`: one clear question.
- `context`: what prompted it, constraints, and the trade-off of each option, so the user can answer without reading code.
- `options`: 2–4 concrete, mutually exclusive choices.
- `recommendation`: the option you'd pick and why, quoting the option text exactly.
- `blocking_task_id`: the task that can't proceed without the answer.

After raising it:

- Don't implement any of the options speculatively.
- Continue with parts of the task that don't depend on the answer, or other work. If nothing useful remains, comment on the blocked task, leave it in In progress, and tell the user in chat that a decision is waiting (give its number).
- In an interactive session you may also ask the question in chat, but always record it on the board too, so the answer is captured.
- When you next start, `get_decisions` shows the answer (section 1).

Decisions you can make yourself without raising: naming, internal structure, which existing utility to use, test layout, and other choices that are easy to change later and that a reviewer wouldn't object to.

## 6. Finishing a task

1. Verify the work: run the tests, typecheck, or exercise the change.
2. `move_task(id, "review", note)` where the note covers:
   - **What changed** (files/areas).
   - **How it was verified** (commands run and their results; say plainly if something wasn't tested).
   - **Bugs raised or fixed** (by number).
   - **Follow-ups** created (by number).
3. Never move tasks to Done. The user does that after reviewing.
4. If the user asked you to "work the board", go back to section 2 for the next task. Stop when To do is empty or everything left is blocked on decisions, and summarise in chat.
