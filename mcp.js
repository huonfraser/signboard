#!/usr/bin/env node
// MCP server (stdio) exposing the kanban board to Claude Code.
// Thin client over the REST API in server.js, so the board UI and Claude always share state.
//
// Every request carries X-Signboard-Agent, so the server applies its agent policy (see "agent policy" in
// server.js): Claude claims todo → in_progress → review, raises bugs and decisions, and never touches backlog.
// The tools below map one-to-one onto the moves that policy allows.
//
// Tools are scoped to a kanban project, resolved per call from, in order: an explicit `project` argument,
// SIGNBOARD_PROJECT (id or name), or the folder Claude Code was started in (CLAUDE_PROJECT_DIR or the process
// cwd) matched against each project's linked folders.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pkg from './package.json' with { type: 'json' };

// SIGNBOARD_* env vars, falling back to the pre-rename KANBAN_* names so existing configs keep working.
const env = (name) => process.env[`SIGNBOARD_${name}`] || process.env[`KANBAN_${name}`];
const BASE = env('URL') || `http://localhost:${env('PORT') || 4477}`;
const AGENT = env('AGENT') || 'claude';
const WORKDIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const POLL_MS = 5000;

const Column = z.enum(['bugs', 'decisions', 'backlog', 'todo', 'in_progress', 'review', 'done']);
const Priority = z.enum(['low', 'medium', 'high', 'urgent']);
const Difficulty = z.enum(['easy', 'medium', 'hard']);
const ProjectRef = z.string().optional().describe('Project name or id. Defaults to the project linked to the current folder.');

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      // X-Kanban-Agent too, so a board server still running pre-rename code keeps applying its agent policy.
      headers: { 'Content-Type': 'application/json', 'X-Signboard-Agent': AGENT, 'X-Kanban-Agent': AGENT },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error(`Signboard server not reachable at ${BASE}. Ask the user to start it (npm start in the Signboard repo).`);
  }
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

async function findByRef(ref) {
  const projects = await api('GET', '/api/projects');
  const match = projects.find((p) => String(p.id) === String(ref) || p.name.toLowerCase() === String(ref).toLowerCase());
  if (!match) throw new Error(`No project "${ref}". Projects: ${projects.map((p) => p.name).join(', ')}`);
  return match;
}

async function currentProject(ref) {
  if (ref) return findByRef(ref);
  if (env('PROJECT')) return findByRef(env('PROJECT'));
  try {
    return await api('GET', `/api/projects/resolve?path=${encodeURIComponent(WORKDIR)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    const projects = await api('GET', '/api/projects');
    throw new Error(
      `${WORKDIR} is not linked to a kanban project. Ask the user which project this folder belongs to, ` +
        `then call link_project. Existing projects: ${projects.map((p) => p.name).join(', ')}`,
    );
  }
}

const KIND_MARK = { bug: '🐞 ', decision: '❓ ', task: '' };

// Compact one-line summary for list views; full JSON for single-task views.
const line = (t, projectName) =>
  `#${t.id} [${t.column}] (${t.priority}${t.difficulty ? `, ${t.difficulty}` : ''}) ${KIND_MARK[t.kind] ?? ''}${t.title}` +
  (t.kind === 'decision' && t.answer ? ` ⇒ answered: "${t.answer}"` : '') +
  (t.assignee ? ` @${t.assignee}` : '') +
  (t.parentId ? ` ↳ parent #${t.parentId}` : '') +
  (projectName ? `  — ${projectName}` : '');

const counts = (p) => Object.entries(p.counts).filter(([, n]) => n).map(([c, n]) => `${c}:${n}`).join(' ') || 'empty';
const settingsText = (s) =>
  `Autofix bugs: ${s.autofixBugs ? 'ON (you may route bugs to todo/in_progress/decisions yourself)' : 'off (bugs wait in bugs for human triage)'}\n` +
  `Decisions from chat: ${s.chatDecisions ? 'ON (record_decision may record answers the user gives in chat)' : 'off (only humans answer decisions, on the board)'}\n` +
  `Concurrent sessions: ${s.maxSessions ?? 1} (working the board runs at most this many items at once, one session per item)`;

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return { ...text(`Error: ${err.message}`), isError: true };
    }
  });
}

const server = new McpServer(
  { name: 'signboard', version: pkg.version },
  {
    instructions:
      'Signboard, the kanban board for this project; follow the signboard skill. Work comes only from To do: claim a task (it moves to ' +
      'in_progress and is locked to you), then submit_for_review with a summary. Never touch Backlog — it is how humans ' +
      'release work. Raise any bug you find with raise_bug and any choice that belongs to the user with raise_decision ' +
      'instead of guessing. Never move anything to Done. Do not call the board\'s HTTP API directly; use these tools.',
  },
);

// ---------- projects ----------

tool('current_project', 'Show which kanban project this session is working in, its workflow settings, and task counts.', {}, async () => {
  const p = await currentProject();
  return text(
    `Project "${p.name}" (id ${p.id})\nLinked folders: ${p.paths.join(', ') || 'none'}\nTasks: ${counts(p)}\n${settingsText(p.settings)}`,
  );
});

tool('list_projects', 'List all kanban projects with their linked folders and task counts.', {}, async () => {
  const projects = await api('GET', '/api/projects');
  return text(projects.map((p) => `${p.id}. ${p.name}  [${counts(p)}]  ${p.paths.join(', ') || '(no linked folders)'}`).join('\n'));
});

tool(
  'link_project',
  'Link a folder (default: the current working folder) to a kanban project so sessions there use its board. ' +
    'Links to an existing project by name or id, or creates a new project with that name. Confirm the project with the user first.',
  {
    project: z.string().describe('Existing project name/id, or the name for a new project'),
    path: z.string().optional().describe('Absolute folder path. Defaults to the current working folder.'),
  },
  async ({ project, path }) => {
    const folder = path || WORKDIR;
    const projects = await api('GET', '/api/projects');
    const existing = projects.find((p) => String(p.id) === project || p.name.toLowerCase() === project.toLowerCase());
    const p = existing
      ? await api('POST', `/api/projects/${existing.id}/paths`, { path: folder })
      : await api('POST', '/api/projects', { name: project, paths: [folder] });
    return text(`${existing ? 'Linked' : 'Created project and linked'} ${folder} → "${p.name}" (id ${p.id})`);
  },
);

// ---------- reading ----------

tool(
  'list_tasks',
  'List tasks in the current project (or all projects), optionally filtered. Returns one line per task.',
  {
    project: ProjectRef,
    all_projects: z.boolean().optional().describe('List across every project instead of just the current one'),
    column: Column.optional(),
    kind: z.enum(['task', 'bug', 'decision']).optional(),
    assignee: z.string().optional(),
    query: z.string().optional().describe('Text search over title and description'),
  },
  async ({ project, all_projects, column, kind, assignee, query }) => {
    const pid = all_projects ? undefined : (await currentProject(project)).id;
    const params = new URLSearchParams(Object.entries({ project: pid, column, kind, assignee, q: query }).filter(([, v]) => v));
    const tasks = await api('GET', `/api/tasks?${params}`);
    if (!tasks.length) return text('No matching tasks.');
    const names = all_projects ? Object.fromEntries((await api('GET', '/api/projects')).map((p) => [p.id, p.name])) : {};
    return text(tasks.map((t) => line(t, names[t.projectId])).join('\n'));
  },
);

tool('get_task', 'Get full details of a task, including description and activity log.', { id: z.number().int() }, async ({ id }) =>
  json(await api('GET', `/api/tasks/${id}`)),
);

// ---------- workflow 1: tasks ----------

tool(
  'claim_next_task',
  'Claim the highest-priority unassigned task in To do: moves it to in_progress and locks it to you. ' +
    'Returns the full task, or a message if To do is empty. (With "Autofix bugs" on you may pass column "bugs".)',
  { column: z.enum(['todo', 'bugs']).optional(), project: ProjectRef },
  async ({ column, project }) => {
    const p = await currentProject(project);
    const { task } = await api('POST', '/api/claim', { projectId: p.id, column });
    return task ? json(task) : text(`To do is empty in "${p.name}".`);
  },
);

tool(
  'claim_task',
  'Claim a specific task from To do by id (e.g. one the user named, or an answered decision): moves it to in_progress and locks it to you.',
  { id: z.number().int() },
  async ({ id }) => json((await api('POST', '/api/claim', { taskId: id })).task),
);

tool(
  'wait_for_task',
  'Poll To do until a task is available, then claim it. Use when the board is empty and the user wants you to keep ' +
    'working the board. Returns the claimed task, or a message if nothing arrived before the timeout (call again to keep waiting).',
  {
    timeout_seconds: z.number().int().min(10).max(1800).optional().describe('How long to wait (default 300)'),
    project: ProjectRef,
  },
  async ({ timeout_seconds = 300, project }) => {
    const p = await currentProject(project);
    const deadline = Date.now() + timeout_seconds * 1000;
    for (;;) {
      const { task } = await api('POST', '/api/claim', { projectId: p.id });
      if (task) return json(task);
      if (Date.now() + POLL_MS > deadline) break;
      await sleep(POLL_MS);
    }
    return text(`No task arrived in To do in "${p.name}" within ${timeout_seconds}s.`);
  },
);

tool(
  'submit_for_review',
  'Finish a task you have in progress: moves it to Review (humans move it to Done). The summary is required.',
  {
    id: z.number().int(),
    summary: z.string().describe('What changed, how it was verified (commands and results; say if untested), bugs raised/fixed, follow-ups'),
  },
  async ({ id, summary }) => text(`Submitted ${line(await api('PATCH', `/api/tasks/${id}`, { column: 'review', note: summary }))}`),
);

tool(
  'release_task',
  'Give a task you claimed back to To do, unlocked, e.g. it cannot be done as described. Explain why.',
  { id: z.number().int(), reason: z.string() },
  async ({ id, reason }) => text(`Released ${line(await api('PATCH', `/api/tasks/${id}`, { column: 'todo', note: reason }))}`),
);

tool(
  'create_subtask',
  'Split a task you have in progress into a smaller task in To do. This is the only way you can add work; ' +
    'other follow-ups go in your review summary, or raise_decision if a human must choose.',
  {
    parent_id: z.number().int().describe('The in-progress task you are splitting'),
    title: z.string(),
    description: z.string().optional(),
    priority: Priority.optional(),
  },
  async ({ parent_id, ...fields }) => {
    const parent = await api('GET', `/api/tasks/${parent_id}`);
    const task = await api('POST', '/api/tasks', { ...fields, column: 'todo', parentId: parent_id, projectId: parent.projectId });
    return text(`Created subtask ${line(task)}`);
  },
);

tool(
  'update_task',
  'Edit the title, description or priority of a task you have in progress, or of a bug/decision you raised. ' +
    'Set difficulty right after claiming, only if it is empty; humans own it once set. ' +
    'Column changes go through claim/submit/release; assignment follows claiming.',
  {
    id: z.number().int(),
    title: z.string().optional(),
    description: z.string().optional(),
    priority: Priority.optional(),
    difficulty: Difficulty.optional().describe('Your estimate: easy | medium | hard. Only when the task has none.'),
  },
  async ({ id, ...fields }) => text(`Updated ${line(await api('PATCH', `/api/tasks/${id}`, fields))}`),
);

tool(
  'add_comment',
  'Comment on a task: progress, findings, questions. (Not allowed on Backlog tasks.)',
  { id: z.number().int(), text: z.string() },
  async ({ id, text: body }) => text(`Commented on ${line(await api('POST', `/api/tasks/${id}/comments`, { text: body }))}`),
);

tool(
  'link_commit',
  'Record a commit that implements a task you claimed, once the change is committed. Works while the task is in ' +
    'progress or in review. Linking the same commit twice is harmless.',
  {
    id: z.number().int(),
    sha: z.string().describe('Commit hash, short or full (e.g. from `git log -1 --format=%H`)'),
    message: z.string().optional().describe('Commit subject line'),
  },
  async ({ id, sha, message }) => {
    const task = await api('POST', `/api/tasks/${id}/commits`, { sha, message });
    return text(`Linked ${sha.slice(0, 7)} to ${line(task)} (${task.commits.length} commit${task.commits.length === 1 ? '' : 's'})`);
  },
);

// ---------- workflow 2: bugs ----------

tool(
  'raise_bug',
  'Record a bug you found. By default it goes to Bugs for a human to triage. Use this for every defect you ' +
    'notice, including ones outside your current task. Check list_tasks(kind: "bug") first to avoid duplicates. ' +
    'With "Autofix bugs" on you may route it yourself: todo, in_progress (fix it now; it is claimed by you) or decisions ' +
    '(a human must choose how to fix it; give options).',
  {
    title: z.string().describe('Short symptom, e.g. "Login fails when email has uppercase letters"'),
    summary: z.string().describe('What is wrong and why it matters'),
    steps_to_reproduce: z.string().optional(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    location: z.string().optional().describe('Files / functions / lines involved, e.g. src/auth.ts:42'),
    severity: Priority.optional().describe('low | medium | high | urgent (defaults to medium)'),
    found_while_task_id: z.number().int().optional().describe('The task you were working on when you found it'),
    column: z.enum(['bugs', 'todo', 'in_progress', 'decisions']).optional().describe('Defaults to bugs. Others need "Autofix bugs".'),
    options: z.array(z.string()).optional().describe('Only for column "decisions": the fix options for the human'),
    recommendation: z.string().optional().describe('Only for column "decisions"'),
    project: ProjectRef,
  },
  async ({ title, summary, steps_to_reproduce, expected, actual, location, severity, found_while_task_id, column = 'bugs', options, recommendation, project }) => {
    const p = await currentProject(project);
    const sections = [
      summary,
      steps_to_reproduce && `**Steps to reproduce**\n${steps_to_reproduce}`,
      expected && `**Expected**\n${expected}`,
      actual && `**Actual**\n${actual}`,
      location && `**Location**\n${location}`,
    ].filter(Boolean);
    if (column === 'decisions' && (!options || options.length < 2)) throw new Error('Routing a bug to decisions needs at least 2 options.');
    const task = await api('POST', '/api/tasks', {
      title,
      description: sections.join('\n\n'),
      kind: 'bug',
      column,
      priority: severity,
      options,
      recommendation,
      relatedTaskId: found_while_task_id,
      projectId: p.id,
    });
    return text(`Raised bug ${line(task)} in "${p.name}"`);
  },
);

tool(
  'triage_bug',
  'Only with "Autofix bugs" on: move a bug out of Bugs to todo, or to in_progress to fix it now (claims it).',
  { id: z.number().int(), to: z.enum(['todo', 'in_progress']), note: z.string().optional() },
  async ({ id, to, note }) => text(`Moved ${line(await api('PATCH', `/api/tasks/${id}`, { column: to, note }))}`),
);

// ---------- workflow 3: decisions ----------

tool(
  'raise_decision',
  'Ask the user to decide, recorded in Decisions. Use whenever a choice is the user\'s to make (unspecified product ' +
    'behaviour, architecture or dependency choices, scope changes, anything destructive or hard to reverse, ambiguous ' +
    'or conflicting requirements) instead of guessing. Give 2-4 concrete options and your recommendation. A human answers ' +
    'it and moves it to To do or Backlog. Meanwhile do unblocked work, or stop and tell the user.',
  {
    question: z.string().describe('The decision, phrased as a question'),
    context: z.string().describe('Background the user needs: what prompted this, constraints, trade-offs of each option'),
    options: z.array(z.string()).min(2).max(6).describe('Concrete, mutually exclusive choices'),
    recommendation: z.string().optional().describe('Which option you recommend and why (quote the option text)'),
    blocking_task_id: z.number().int().optional().describe('Task that cannot proceed until this is decided'),
    priority: Priority.optional().describe('How urgently you need an answer (defaults to medium)'),
    project: ProjectRef,
  },
  async ({ question, context, options, recommendation, blocking_task_id, priority, project }) => {
    const p = await currentProject(project);
    const task = await api('POST', '/api/tasks', {
      title: question,
      description: context,
      column: 'decisions',
      options,
      recommendation,
      priority,
      relatedTaskId: blocking_task_id,
      projectId: p.id,
    });
    return text(
      `Raised decision ${line(task)} in "${p.name}".` +
        (p.settings.chatDecisions
          ? ' If the user answers in chat, record it with record_decision.'
          : ' The user will answer it on the board; check with get_decisions.'),
    );
  },
);

tool(
  'record_decision',
  'Only with "Decisions from chat" on: record an answer the user gave you in this chat to an open decision, so the ' +
    'session is not held up. Quote the user\'s own words. Never infer or invent an answer. Then the decision goes to ' +
    'in_progress (you act on it now; it is claimed by you) or todo.',
  {
    id: z.number().int(),
    answer: z.string().describe('The decision the user made'),
    user_quote: z.string().describe('The user\'s words from the chat that state the decision'),
    then: z.enum(['in_progress', 'todo']).optional().describe('Defaults to in_progress'),
  },
  async ({ id, answer, user_quote, then = 'in_progress' }) => {
    const task = await api('POST', `/api/tasks/${id}/decide`, { answer, userQuote: user_quote, column: then });
    return text(`Recorded decision ${line(task)}`);
  },
);

tool(
  'get_decisions',
  'List decisions in the current project with their answers and where they are now. Check at session start and before resuming a blocked task.',
  {
    status: z.enum(['open', 'answered', 'all']).optional().describe('Defaults to all'),
    project: ProjectRef,
  },
  async ({ status = 'all', project }) => {
    const p = await currentProject(project);
    let decisions = await api('GET', `/api/tasks?project=${p.id}&kind=decision`);
    if (status === 'open') decisions = decisions.filter((d) => !d.answer);
    if (status === 'answered') decisions = decisions.filter((d) => d.answer);
    if (!decisions.length) return text(`No ${status === 'all' ? '' : `${status} `}decisions in "${p.name}".`);
    return text(
      decisions
        .map((d) =>
          [
            `#${d.id} ${d.answer ? 'ANSWERED' : 'OPEN'} [${d.column}${d.assignee ? ` @${d.assignee}` : ''}]: ${d.title}`,
            `  options: ${d.options.map((o) => `"${o}"`).join(', ') || '(none given)'}`,
            d.answer && `  answer: ${d.answer}`,
            d.relatedTaskId && `  blocks task #${d.relatedTaskId}`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n'),
    );
  },
);

tool('delete_task', 'Permanently delete a task you created in error (e.g. a duplicate bug). You cannot delete tasks others created.', { id: z.number().int() }, async ({ id }) => {
  await api('DELETE', `/api/tasks/${id}`);
  return text(`Deleted task #${id}`);
});

await server.connect(new StdioServerTransport());
