---
name: kanban
description: Workflow for working from the local kanban board (the `kanban` MCP server). Use whenever the kanban MCP tools are available and you are doing project work, when the user says "work the board", "next task", "check the board", or refers to a task by number, and whenever you find a bug or reach a choice the user should make. Covers claiming from To do, submitting for review, raising bugs into Bugs, raising decisions into Decisions, and the guardrails (never touch Backlog, never move to Done).
---

# Kanban workflow

The board is how the user releases work to you and how you report back. Humans own the flow of work. You pick up what they release, report what you find, and hand finished work back.

```
            humans                     Claude                     humans
Backlog ───────────▶ To do ──claim──▶ In progress ──submit──▶ Review ───────▶ Done
                                 (locked to you)

Claude finds a bug       ──raise_bug──────▶ Bugs      ──human triage──▶ Backlog / To do
Claude needs a human call ─raise_decision─▶ Decisions ──human answer──▶ Backlog / To do
```

## Guardrails (never break these)

- **Never touch Backlog.** Don't create, move, edit or comment on Backlog tasks, and don't move anything into Backlog. Backlog is how humans decide what work is released to you. Reading it is fine.
- **No work starts from Backlog.** Backlog tasks are not available work, whatever their priority. "Next task" or "highest-priority task" always means To do. Don't start, plan, or offer to start a Backlog task, and don't ask the user to release one.
- **Never move anything to Done.** Finished work goes to Review; a human closes it.
- **Only work on tasks you've claimed.** A task in progress is locked to whoever claimed it. Don't work on, edit or move another agent's task.
- **Don't release new work yourself.** The only items you create are bugs, decisions and subtasks of a task you have in progress.
- **Never answer a decision yourself.** Only record an answer the user actually gave, and only when "Decisions from chat" is on (Workflow 3).
- **Use the MCP tools only.** Never call the board's HTTP API directly (curl, fetch, scripts) or edit its data file.

The server enforces these guardrails and returns an error explaining why. Treat that error as the workflow working, not as an obstacle to route around.

## Start of session

1. `current_project`. Note the two settings it reports: **Autofix bugs** and **Decisions from chat**. If the folder isn't linked, ask the user which project it belongs to (show `list_projects`), then `link_project`. Don't guess.
2. `list_tasks(assignee: "claude", column: "in_progress")`. If you have something in progress, resume it before claiming anything new.
3. `get_decisions(status: "answered")`. Any answered decision now sitting in **To do** is released work. If it unblocks a task you have in progress, `claim_task` it, apply the answer in that task, and submit both. Otherwise treat it like any To do task.

## Viewing the board

When the user asks to see or check the board, `list_tasks` per column (or one column they name). Add `all_projects: true` when they ask about every project. Backlog is read-only: show it, but don't act on it.

## Workflow 1: Tasks

1. **Claim.** If the user named a task, `claim_task(id)`. Otherwise `claim_next_task` takes the top-priority unassigned task from To do. Claiming moves it to In progress and locks it to you.
2. **Read** the full description and activity log (`get_task`). If the requirements are unclear in a way that changes what you'd build, go to Workflow 3 rather than guessing. If the task has no difficulty yet, set your estimate (`update_task(id, difficulty: "easy" | "medium" | "hard")`). Never change a difficulty that's already set; humans own it.
3. **Work.** `add_comment` at meaningful points: approach chosen, a non-obvious finding, partial progress on a long task. Keep comments short; no running commentary.
   - **Too big?** `create_subtask(parent_id, …)` puts a piece of *this* task into To do.
   - **Other ideas, follow-ups or refactors** you notice: don't create tasks for them. List them under "Follow-ups" in your review summary, so the human can add them to Backlog if they want them.
4. **Commit.** Once the change is verified (run the tests, typecheck, exercise the change), commit it. **Each task or item gets its own commit.** Stage only that task's files, never batch several tasks into one commit, and put the task number in the message (e.g. `Add sort options (#5)`). A bug you fix or a decision you apply inside the task is committed separately too, under its own number. Then `link_commit(id, sha, message)` so the board shows the commit on the task.
5. **Submit.** `submit_for_review(id, summary)`. The summary covers:
   - **What changed:** files and areas.
   - **How it was verified:** the commands you ran and their results. Say plainly if something is untested.
   - **Commits:** the short hash of each commit.
   - **Bugs:** raised or fixed, by number.
   - **Decisions:** raised or applied, by number.
   - **Follow-ups:** suggestions for Backlog.
6. **Can't finish it** as described (wrong premise, out of your reach)? `release_task(id, reason)` puts it back in To do, unlocked. If a human needs to choose how to proceed, raise a decision instead and keep the task.
7. **Next.** If the user asked you to "work the board", go back to step 1. When To do is empty:
   - If the user asked you to keep polling, `wait_for_task`. It waits for new work and claims it; call it again on timeout.
   - Otherwise stop. If you did nothing this session, the answer is simply **"No work available."** Don't list or suggest Backlog tasks. If you did work, summarise what you did and what's waiting on the user (open decisions, untriaged bugs).

## Workflow 2: Bugs

Raise a bug **whenever you find a defect**: in code you're changing or reading, in tests or tooling, or in behaviour you observe. This includes bugs unrelated to your task.

1. **Check for duplicates:** `list_tasks(kind: "bug")`, plus `query:` with a keyword. If the bug is already raised, `add_comment` with any new information instead. Skip this if it's in Backlog, since you can't comment there.
2. **Raise:** `raise_bug` with:
   - `summary`, `steps_to_reproduce`, `expected`, `actual`, and `location` (file:line), where known.
   - `severity`: be honest; urgent means data loss, a security issue, or a broken main path.
   - `found_while_task_id`: your current task.
3. **Then:**
   - **Autofix bugs off (the default):** the bug stays in Bugs until a human moves it to Backlog or To do. Carry on with your task; don't fix the bug. The exception is a bug that is part of your task or blocks it: raise it, fix it as part of the task, and mention both in your summary.
   - **Autofix bugs on:** you route the bug yourself, as you see fit:
     - `column: "in_progress"`: fix it now. It's claimed by you; submit it for review like a task.
     - `column: "todo"`: a real bug to fix later, in the queue.
     - `column: "decisions"`, with `options` and `recommendation`: how to fix it is the human's call.
     - For bugs already sitting in Bugs, use `triage_bug(id, to)`.

Not bugs: style preferences, refactor opportunities, missing features. Those go in your review summary as follow-ups.

## Workflow 3: Decisions

Raise a decision whenever **the choice belongs to the user** rather than being an implementation detail you can reasonably make. Typical triggers:

- Unspecified product or UX behaviour ("what should happen when…").
- Architecture, data model or public API shape with lasting consequences.
- Adding a dependency, service or paid resource.
- Anything destructive or hard to reverse: data migrations, deleting data or files, force-pushes, schema changes.
- Scope changes: the task is much bigger or different than described.
- Requirements that conflict with each other or with existing behaviour.

Choices you make yourself, without raising: naming, internal structure, which existing utility to use, test layout, and anything else that's easy to change later and that a reviewer wouldn't object to.

1. **Raise:** `raise_decision` with:
   - `question`: one clear question.
   - `context`: what prompted it, the constraints, and the trade-off of each option, so the user can answer without reading code.
   - `options`: 2–4 concrete, mutually exclusive choices.
   - `recommendation`: the option you'd pick and why, quoting the option text exactly.
   - `blocking_task_id`: the task that can't proceed without the answer.
2. **Don't implement any option speculatively.** Do work that doesn't depend on the answer. If nothing useful remains, comment on the blocked task, leave it in progress, and tell the user in chat that decision #N is waiting.
3. **When it's answered on the board,** a human moves it to To do (act on it) or Backlog (parked). You pick it up as in "Start of session", step 3.
   - **Reopened decisions.** A human can reopen an answered decision, which takes the answer back. The decision returns to Decisions, and the task it blocks gets a "Decision #N was reopened" note. When you see that note on a task you hold, or a decision you applied shows as OPEN again in `get_decisions`, stop acting on the old answer. Don't build on work that depends on it. If you already committed work based on that answer, say so in a comment on the task, so the human can decide whether to revert it. Treat the task as blocked again.
4. **Decisions from chat.** In an interactive session, you may also ask the question in chat.
   - **Setting on:** if the user answers in chat, call `record_decision(id, answer, user_quote, then)` straight away. `user_quote` is their actual words. `then: "in_progress"` keeps it claimed so you act on it now; use `"todo"` to queue it. If the decision came up in chat before you'd raised it, `raise_decision` first and then `record_decision`, so the board still has the record.
   - **Setting off:** tell the user it's recorded as decision #N on the board and ask them to answer it there. Don't act on a chat answer until the board shows it answered.
   - **Either way, never infer an answer** from silence or ambiguity, or from something the user said about a different question.
