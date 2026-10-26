#!/usr/bin/env node
// MCP server (stdio) exposing the kanban board to Claude Code.
// Thin client over the REST API in server.js, so the board UI and Claude always share state.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.KANBAN_URL || `http://localhost:${process.env.KANBAN_PORT || 4477}`;
const AGENT = process.env.KANBAN_AGENT || 'claude';

const Column = z.enum(['backlog', 'todo', 'in_progress', 'review', 'done']);
const Priority = z.enum(['low', 'medium', 'high', 'urgent']);

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
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Compact one-line summary for list views; full JSON for single-task views.
const line = (t) =>
  `#${t.id} [${t.column}] (${t.priority}) ${t.title}` +
  (t.assignee ? ` @${t.assignee}` : '') +
  (t.tags.length ? ` {${t.tags.join(',')}}` : '');

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

const server = new McpServer({ name: 'kanban', version: '0.1.0' });

tool(
  'list_tasks',
  'List tasks on the kanban board, optionally filtered. Returns one line per task.',
  {
    column: Column.optional(),
    assignee: z.string().optional(),
    tag: z.string().optional(),
    query: z.string().optional().describe('Text search over title and description'),
  },
  async ({ column, assignee, tag, query }) => {
    const params = new URLSearchParams(Object.entries({ column, assignee, tag, q: query }).filter(([, v]) => v));
    const tasks = await api('GET', `/api/tasks?${params}`);
    return text(tasks.length ? tasks.map(line).join('\n') : 'No matching tasks.');
  },
);

tool('get_task', 'Get full details of a task, including description and activity log.', { id: z.number().int() }, async ({ id }) =>
  json(await api('GET', `/api/tasks/${id}`)),
);

tool(
  'create_task',
  'Create a new task. Use this to break work into subtasks or record follow-ups you discover.',
  {
    title: z.string(),
    description: z.string().optional(),
    column: Column.optional().describe('Defaults to todo'),
    priority: Priority.optional().describe('Defaults to medium'),
    assignee: z.string().optional(),
    tags: z.array(z.string()).optional(),
  },
  async (args) => {
    const task = await api('POST', '/api/tasks', { ...args, author: AGENT });
    return text(`Created ${line(task)}`);
  },
);

tool(
  'update_task',
  'Update fields on a task. Only provided fields change. Set assignee to null to unassign.',
  {
    id: z.number().int(),
    title: z.string().optional(),
    description: z.string().optional(),
    column: Column.optional(),
    priority: Priority.optional(),
    assignee: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
  },
  async ({ id, ...fields }) => {
    const task = await api('PATCH', `/api/tasks/${id}`, { ...fields, author: AGENT });
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
  'Claim the highest-priority unassigned task from a column (default todo): assigns it to you and moves it to in_progress. Returns the full task, or a message if the queue is empty.',
  { column: Column.optional(), tag: z.string().optional() },
  async ({ column, tag }) => {
    const { task } = await api('POST', '/api/claim', { assignee: AGENT, column, tag });
    return task ? json(task) : text('No unassigned tasks available to claim.');
  },
);

tool('delete_task', 'Permanently delete a task. Prefer moving to done unless the task was created in error.', { id: z.number().int() }, async ({ id }) => {
  await api('DELETE', `/api/tasks/${id}`);
  return text(`Deleted task #${id}`);
});

await server.connect(new StdioServerTransport());
