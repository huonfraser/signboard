#!/usr/bin/env node
// MCP server (stdio) exposing the kanban board to Claude Code.
// Thin client over the REST API in server.js, so the board UI and Claude always share state.
//
// Tools are scoped to a kanban project. The project is resolved per call from, in order:
// an explicit `project` argument, KANBAN_PROJECT (id or name), or the folder Claude Code was
// started in (CLAUDE_PROJECT_DIR or the process cwd) matched against each project's linked folders.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.KANBAN_URL || `http://localhost:${process.env.KANBAN_PORT || 4477}`;
const AGENT = process.env.KANBAN_AGENT || 'claude';
const WORKDIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const Column = z.enum(['bugs', 'decisions', 'backlog', 'todo', 'in_progress', 'review', 'done']);
const Priority = z.enum(['low', 'medium', 'high', 'urgent']);
const ProjectRef = z.string().optional().describe('Project name or id. Defaults to the project linked to the current folder.');

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error(`Kanban server not reachable at ${BASE}. Start it with: npm start`);
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
  if (process.env.KANBAN_PROJECT) return findByRef(process.env.KANBAN_PROJECT);
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

// Workflow guardrails. The UI (the user) can do anything; Claude, through these tools, cannot:
// close work (done is the user's call after review), resolve decisions, or skip the review summary.
function checkMove(task, column, note) {
  if (column === task.column) return;
  if (column === 'done') throw new Error('Only the user moves tasks to done. Move it to review with a summary note instead.');
  if (task.kind === 'decision' && !task.answer) {
    throw new Error(`#${task.id} is an open decision; only the user can resolve it (in the board UI). Use get_decisions to check for answers.`);
  }
  if (column === 'decisions') throw new Error('Use raise_decision to ask the user something; do not move tasks into decisions.');
  if (column === 'review' && !note) throw new Error('Moving to review needs a note: what changed, how it was tested, any follow-ups.');
}

const KIND_MARK = { bug: '🐞 ', decision: '❓ ', task: '' };

// Compact one-line summary for list views; full JSON for single-task views.
const line = (t, projectName) =>
  `#${t.id} [${t.column}] (${t.priority}) ${KIND_MARK[t.kind] ?? ''}${t.title}` +
  (t.kind === 'decision' && t.answer ? ` ⇒ answered: "${t.answer}"` : '') +
  (t.assignee ? ` @${t.assignee}` : '') +
  (t.tags.length ? ` {${t.tags.join(',')}}` : '') +
  (projectName ? `  — ${projectName}` : '');

const counts = (p) => Object.entries(p.counts).filter(([, n]) => n).map(([c, n]) => `${c}:${n}`).join(' ') || 'empty';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));

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
  { name: 'kanban', version: '0.3.0' },
  {
    instructions:
      'Kanban board for this project. Follow the kanban skill workflow: claim or resume a task before starting work; ' +
      'raise_bug for any bug you find (do not silently fix out-of-scope bugs); raise_decision whenever a choice belongs ' +
      'to the user instead of guessing; check get_decisions for answers; finish by moving to review with a summary. ' +
      'Never move tasks to done.',
  },
);

// ---------- projects ----------

tool('current_project', 'Show which kanban project this Claude Code session is working in, and its task counts.', {}, async () => {
  const p = await currentProject();
  return text(`Project "${p.name}" (id ${p.id})\nLinked folders: ${p.paths.join(', ') || 'none'}\nTasks: ${counts(p)}`);
});

tool('list_projects', 'List all kanban projects with their linked folders and task counts.', {}, async () => {
  const projects = await api('GET', '/api/projects');
  return text(projects.map((p) => `${p.id}. ${p.name}  [${counts(p)}]  ${p.paths.join(', ') || '(no linked folders)'}`).join('\n'));
});

tool(
  'link_project',
  'Link a folder (default: the current working folder) to a kanban project so future sessions there use its board. ' +
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

// ---------- tasks ----------

tool(
  'list_tasks',
  'List tasks in the current project (or all projects), optionally filtered. Returns one line per task.',
  {
    project: ProjectRef,
    all_projects: z.boolean().optional().describe('List across every project instead of just the current one'),
    column: Column.optional(),
    assignee: z.string().optional(),
    tag: z.string().optional(),
    query: z.string().optional().describe('Text search over title and description'),
  },
  async ({ project, all_projects, column, assignee, tag, query }) => {
    const pid = all_projects ? undefined : (await currentProject(project)).id;
    const params = new URLSearchParams(Object.entries({ project: pid, column, assignee, tag, q: query }).filter(([, v]) => v));
    const tasks = await api('GET', `/api/tasks?${params}`);
    if (!tasks.length) return text('No matching tasks.');
    const names = all_projects ? Object.fromEntries((await api('GET', '/api/projects')).map((p) => [p.id, p.name])) : {};
    return text(tasks.map((t) => line(t, names[t.projectId])).join('\n'));
  },
);

tool('get_task', 'Get full details of a task, including description and activity log.', { id: z.number().int() }, async ({ id }) =>
  json(await api('GET', `/api/tasks/${id}`)),
);

tool(
  'create_task',
  'Create a new task in the current project. Use this to break work into subtasks or record follow-ups you discover.',
  {
    title: z.string(),
    description: z.string().optional(),
    column: Column.optional().describe('Defaults to todo'),
    priority: Priority.optional().describe('Defaults to medium'),
    assignee: z.string().optional(),
    tags: z.array(z.string()).optional(),
    project: ProjectRef,
  },
  async ({ project, ...fields }) => {
    if (fields.column === 'bugs' || fields.column === 'decisions') {
      throw new Error(`Use ${fields.column === 'bugs' ? 'raise_bug' : 'raise_decision'} instead of create_task for that column.`);
    }
    if (fields.column === 'done' || fields.column === 'review') throw new Error(`New tasks cannot start in ${fields.column}.`);
    const p = await currentProject(project);
    const task = await api('POST', '/api/tasks', { ...fields, projectId: p.id, author: AGENT });
    return text(`Created ${line(task)} in "${p.name}"`);
  },
);

// ---------- bugs and decisions ----------

tool(
  'raise_bug',
  'Record a bug you found in the Bugs column of the current project. Use this for any defect you notice, including ones outside ' +
    'your current task, instead of silently fixing or ignoring it. Check list_tasks(column: "bugs") first to avoid duplicates.',
  {
    title: z.string().describe('Short symptom, e.g. "Login fails when email has uppercase letters"'),
    summary: z.string().describe('What is wrong and why it matters'),
    steps_to_reproduce: z.string().optional(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    location: z.string().optional().describe('Files / functions / lines involved, e.g. src/auth.ts:42'),
    severity: Priority.optional().describe('low | medium | high | urgent (defaults to medium)'),
    found_while_task_id: z.number().int().optional().describe('The task you were working on when you found it'),
    project: ProjectRef,
  },
  async ({ title, summary, steps_to_reproduce, expected, actual, location, severity, found_while_task_id, project }) => {
    const p = await currentProject(project);
    const sections = [
      summary,
      steps_to_reproduce && `**Steps to reproduce**\n${steps_to_reproduce}`,
      expected && `**Expected**\n${expected}`,
      actual && `**Actual**\n${actual}`,
      location && `**Location**\n${location}`,
    ].filter(Boolean);
    const task = await api('POST', '/api/tasks', {
      title,
      description: sections.join('\n\n'),
      column: 'bugs',
      priority: severity,
      tags: ['bug'],
      relatedTaskId: found_while_task_id,
      projectId: p.id,
      author: AGENT,
    });
    return text(`Raised bug ${line(task)} in "${p.name}"`);
  },
);

tool(
  'raise_decision',
  'Ask the user to make a decision, recorded in the Decisions column. Use this whenever a choice is the user\'s to make ' +
    '(product behaviour, architecture or dependency choices, scope changes, anything destructive or hard to reverse, ' +
    'ambiguous requirements) instead of guessing. Give 2-4 concrete options and your recommendation. ' +
    'Then work on something that does not depend on the answer, or stop and tell the user you are waiting.',
  {
    question: z.string().describe('The decision, phrased as a question'),
    context: z.string().describe('Background the user needs: what prompted this, constraints, trade-offs of each option'),
    options: z.array(z.string()).min(2).max(6).describe('Concrete, mutually exclusive choices'),
    recommendation: z.string().optional().describe('Which option you recommend and why'),
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
      tags: ['decision'],
      relatedTaskId: blocking_task_id,
      projectId: p.id,
      author: AGENT,
    });
    return text(`Raised decision ${line(task)} in "${p.name}". The user will answer it on the board; check with get_decisions.`);
  },
);

tool(
  'get_decisions',
  'List decisions in the current project with their answers. Check this at the start of a session and before resuming a blocked task.',
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
            `#${d.id} ${d.answer ? 'ANSWERED' : 'OPEN'}: ${d.title}`,
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

tool(
  'update_task',
  'Update fields on a task. Only provided fields change. Set assignee to null to unassign. Pass project to move it to another project.',
  {
    id: z.number().int(),
    title: z.string().optional(),
    description: z.string().optional(),
    column: Column.optional(),
    priority: Priority.optional(),
    assignee: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    project: z.string().optional().describe('Project name or id to move the task to'),
  },
  async ({ id, project, ...fields }) => {
    if (fields.column) {
      // Review needs a summary, which update_task has no field for, so route it through move_task.
      if (fields.column === 'review') throw new Error('Use move_task with a note to move a task to review.');
      checkMove(await api('GET', `/api/tasks/${id}`), fields.column);
    }
    const projectId = project ? (await findByRef(project)).id : undefined;
    const task = await api('PATCH', `/api/tasks/${id}`, { ...fields, projectId, author: AGENT });
    return text(`Updated ${line(task)}`);
  },
);

tool(
  'move_task',
  'Move a task to another column, leaving a note explaining why (what was done, what is blocking). ' +
    'A note is required for review. You cannot move tasks to done or resolve decisions; the user does that.',
  { id: z.number().int(), column: Column, note: z.string().optional() },
  async ({ id, column, note }) => {
    checkMove(await api('GET', `/api/tasks/${id}`), column, note);
    const task = await api('PATCH', `/api/tasks/${id}`, { column, author: AGENT });
    if (note) await api('POST', `/api/tasks/${id}/comments`, { text: note, author: AGENT });
    return text(`Moved ${line(task)}`);
  },
);

tool(
  'add_comment',
  'Add a comment to a task: progress updates, findings, questions for the user, or a summary of changes made.',
  { id: z.number().int(), text: z.string() },
  async ({ id, text: body }) => {
    const task = await api('POST', `/api/tasks/${id}/comments`, { text: body, author: AGENT });
    return text(`Commented on ${line(task)}`);
  },
);

tool(
  'claim_next_task',
  'Claim the highest-priority unassigned task in the current project from a column (default todo; use "bugs" when asked to fix bugs): ' +
    'assigns it to you and moves it to in_progress. Returns the full task, or a message if the queue is empty.',
  { column: Column.optional(), tag: z.string().optional(), project: ProjectRef },
  async ({ column, tag, project }) => {
    if (['decisions', 'review', 'done', 'in_progress'].includes(column)) throw new Error(`Cannot claim from ${column}.`);
    const p = await currentProject(project);
    const { task } = await api('POST', '/api/claim', { assignee: AGENT, projectId: p.id, column, tag });
    return task ? json(task) : text(`No unassigned tasks to claim in "${p.name}".`);
  },
);

tool('delete_task', 'Permanently delete a task you created in error (e.g. a duplicate bug). You cannot delete tasks the user created.', { id: z.number().int() }, async ({ id }) => {
  const task = await api('GET', `/api/tasks/${id}`);
  if (task.activity[0]?.author !== AGENT) throw new Error(`#${id} was not created by ${AGENT}; ask the user to delete it.`);
  await api('DELETE', `/api/tasks/${id}`);
  return text(`Deleted task #${id}`);
});

await server.connect(new StdioServerTransport());
