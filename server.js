// Kanban server: REST API + static UI. Zero dependencies, JSON file storage.
// The server is the single writer to the data file; the UI and the MCP server both go through the API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.KANBAN_PORT || 4477);
const DATA_FILE = process.env.KANBAN_DATA || path.join(ROOT, 'data', 'board.json');

export const COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

// ---------- storage ----------

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { nextId: 1, tasks: [] };
  }
}

let board = load();

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const now = () => new Date().toISOString();

// ---------- domain ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function findTask(id) {
  const task = board.tasks.find((t) => t.id === Number(id));
  if (!task) throw new HttpError(404, `Task ${id} not found`);
  return task;
}

function validate(fields) {
  if (fields.column !== undefined && !COLUMNS.includes(fields.column)) {
    throw new HttpError(400, `column must be one of: ${COLUMNS.join(', ')}`);
  }
  if (fields.priority !== undefined && !PRIORITIES.includes(fields.priority)) {
    throw new HttpError(400, `priority must be one of: ${PRIORITIES.join(', ')}`);
  }
  if (fields.title !== undefined && !String(fields.title).trim()) {
    throw new HttpError(400, 'title cannot be empty');
  }
}

function addActivity(task, author, text, kind = 'comment') {
  task.activity.push({ at: now(), author: author || 'user', kind, text });
}

// Position within a column: append to the end unless told otherwise.
function nextOrder(column) {
  const orders = board.tasks.filter((t) => t.column === column).map((t) => t.order);
  return orders.length ? Math.max(...orders) + 1 : 0;
}

function createTask(input) {
  if (!input.title) throw new HttpError(400, 'title is required');
  validate(input);
  const column = input.column || 'todo';
  const task = {
    id: board.nextId++,
    title: String(input.title).trim(),
    description: input.description || '',
    column,
    priority: input.priority || 'medium',
    assignee: input.assignee || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    order: nextOrder(column),
    createdAt: now(),
    updatedAt: now(),
    activity: [],
  };
  addActivity(task, input.author, `Created in ${column}`, 'event');
  board.tasks.push(task);
  save();
  return task;
}

const EDITABLE = ['title', 'description', 'column', 'priority', 'assignee', 'tags', 'order'];

function updateTask(id, input) {
  const task = findTask(id);
  validate(input);
  const changes = [];
  for (const key of EDITABLE) {
    if (input[key] === undefined) continue;
    const prev = task[key];
    if (JSON.stringify(prev) === JSON.stringify(input[key])) continue;
    task[key] = input[key];
    if (key === 'column') {
      changes.push(`Moved ${prev} → ${input[key]}`);
      if (input.order === undefined) task.order = nextOrder(input[key]);
    } else if (key === 'assignee') {
      changes.push(input[key] ? `Assigned to ${input[key]}` : 'Unassigned');
    } else if (key !== 'order') {
      changes.push(`Updated ${key}`);
    }
  }
  if (changes.length || input.order !== undefined) {
    task.updatedAt = now();
    if (changes.length) addActivity(task, input.author, changes.join('; '), 'event');
    save();
  }
  return task;
}

function deleteTask(id) {
  const task = findTask(id);
  board.tasks = board.tasks.filter((t) => t !== task);
  save();
  return { deleted: task.id };
}

function commentTask(id, { text, author }) {
  if (!text) throw new HttpError(400, 'text is required');
  const task = findTask(id);
  addActivity(task, author, text);
  task.updatedAt = now();
  save();
  return task;
}

// Atomically take the highest-priority, oldest unassigned task from a column and start it.
function claimNext({ assignee, column = 'todo', tag }) {
  if (!assignee) throw new HttpError(400, 'assignee is required');
  const candidates = board.tasks
    .filter((t) => t.column === column && !t.assignee && (!tag || t.tags.includes(tag)))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order);
  if (!candidates.length) return null;
  return updateTask(candidates[0].id, { column: 'in_progress', assignee, author: assignee });
}

function listTasks(query) {
  let tasks = board.tasks;
  if (query.column) tasks = tasks.filter((t) => t.column === query.column);
  if (query.assignee) tasks = tasks.filter((t) => t.assignee === query.assignee);
  if (query.tag) tasks = tasks.filter((t) => t.tags.includes(query.tag));
  if (query.q) {
    const q = query.q.toLowerCase();
    tasks = tasks.filter((t) => `${t.title} ${t.description}`.toLowerCase().includes(q));
  }
  return [...tasks].sort((a, b) => COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || a.order - b.order);
}

// ---------- http ----------

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

const STATIC = { '/': 'index.html', '/index.html': 'index.html' };

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','tasks','3','comments']
  const method = req.method;

  if (method === 'GET' && STATIC[url.pathname]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'public', STATIC[url.pathname])).pipe(res);
  }

  if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });

  if (parts[1] === 'board' && method === 'GET') {
    return send(res, 200, { columns: COLUMNS, priorities: PRIORITIES, tasks: listTasks({}) });
  }
  if (parts[1] === 'claim' && method === 'POST') {
    const task = claimNext(await readBody(req));
    return send(res, 200, { task });
  }
  if (parts[1] === 'tasks') {
    const id = parts[2];
    if (!id && method === 'GET') return send(res, 200, listTasks(Object.fromEntries(url.searchParams)));
    if (!id && method === 'POST') return send(res, 201, createTask(await readBody(req)));
    if (id && parts[3] === 'comments' && method === 'POST') {
      return send(res, 201, commentTask(id, await readBody(req)));
    }
    if (id && !parts[3]) {
      if (method === 'GET') return send(res, 200, findTask(id));
      if (method === 'PATCH') return send(res, 200, updateTask(id, await readBody(req)));
      if (method === 'DELETE') return send(res, 200, deleteTask(id));
    }
  }
  send(res, 404, { error: 'Not found' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!(err instanceof HttpError)) console.error(err);
      send(res, err.status || 500, { error: err.message });
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Kanban running at http://localhost:${PORT}  (data: ${DATA_FILE})`);
  });
