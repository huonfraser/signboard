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

const Column = z.enum(['backlog', 'todo', 'in_progress', 'review', 'done']);
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

// Compact one-line summary for list views; full JSON for single-task views.
const line = (t, projectName) =>
  `#${t.id} [${t.column}] (${t.priority}) ${t.title}` +
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

const server = new McpServer({ name: 'kanban', version: '0.2.0' });

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
    const p = await currentProject(project);
    const task = await api('POST', '/api/tasks', { ...fields, projectId: p.id, author: AGENT });
    return text(`Created ${line(task)} in "${p.name}"`);
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
    const projectId = project ? (await findByRef(project)).id : undefined;
    const task = await api('PATCH', `/api/tasks/${id}`, { ...fields, projectId, author: AGENT });
    return text(`Updated ${line(task)}`);
  },
);

tool(
  'move_task',
  'Move a task to another column, optionally leaving a note explaining why (e.g. what was done, what is blocking).',
  { id: z.number().int(), column: Column, note: z.string().optional() },
  async ({ id, column, note }) => {
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
  'Claim the highest-priority unassigned task in the current project from a column (default todo): assigns it to you and moves it to in_progress. Returns the full task, or a message if the queue is empty.',
  { column: Column.optional(), tag: z.string().optional(), project: ProjectRef },
  async ({ column, tag, project }) => {
    const p = await currentProject(project);
    const { task } = await api('POST', '/api/claim', { assignee: AGENT, projectId: p.id, column, tag });
    return task ? json(task) : text(`No unassigned tasks to claim in "${p.name}".`);
  },
);

tool('delete_task', 'Permanently delete a task. Prefer moving to done unless the task was created in error.', { id: z.number().int() }, async ({ id }) => {
  await api('DELETE', `/api/tasks/${id}`);
  return text(`Deleted task #${id}`);
});

await server.connect(new StdioServerTransport());
