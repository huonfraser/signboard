// Kanban server: REST API + static UI. Zero dependencies, JSON file storage.
// The server is the single writer to the data file; the UI and the MCP server both go through the API.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.KANBAN_PORT || 4477);
const DATA_FILE = process.env.KANBAN_DATA || path.join(ROOT, 'data', 'board.json');
const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

// bugs and decisions are intake lanes Claude raises into; the rest is the normal work flow.
const COLUMNS = ['bugs', 'decisions', 'backlog', 'todo', 'in_progress', 'review', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
// A task keeps its kind after it leaves its intake column, so answered decisions stay findable.
const KIND_FOR_COLUMN = { bugs: 'bug', decisions: 'decision' };
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

// ---------- storage ----------

function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    data = { nextId: 1, tasks: [] };
  }
  // Migrate boards created before projects existed: every task belongs to a project.
  data.projects ??= [];
  data.nextProjectId ??= 1;
  if (!data.projects.length) {
    data.projects.push({ id: data.nextProjectId++, name: 'General', paths: [], createdAt: new Date().toISOString() });
  }
  for (const t of data.tasks) {
    t.projectId ??= data.projects[0].id;
    t.kind ??= 'task';
  }
  return data;
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
  if (fields.projectId !== undefined) findProject(fields.projectId);
}

function addActivity(task, author, text, kind = 'comment') {
  task.activity.push({ at: now(), author: author || 'user', kind, text });
}

// Position within a project's column: append to the end unless told otherwise.
function nextOrder(projectId, column) {
  const orders = board.tasks.filter((t) => t.projectId === projectId && t.column === column).map((t) => t.order);
  return orders.length ? Math.max(...orders) + 1 : 0;
}

function createTask(input) {
  if (!input.title) throw new HttpError(400, 'title is required');
  if (input.projectId === undefined) throw new HttpError(400, 'projectId is required');
  validate(input);
  const column = input.column || 'todo';
  const projectId = Number(input.projectId);
  const kind = KIND_FOR_COLUMN[column] || 'task';
  const related = input.relatedTaskId ? findTask(input.relatedTaskId) : null;
  const task = {
    id: board.nextId++,
    projectId,
    kind,
    title: String(input.title).trim(),
    description: input.description || '',
    column,
    priority: input.priority || 'medium',
    assignee: input.assignee || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    order: nextOrder(projectId, column),
    relatedTaskId: related?.id ?? null,
    createdAt: now(),
    updatedAt: now(),
    activity: [],
  };
  if (kind === 'decision') {
    task.options = Array.isArray(input.options) ? input.options.map(String).filter(Boolean) : [];
    task.recommendation = input.recommendation || null;
    task.answer = null;
    task.answeredAt = null;
  }
  addActivity(task, input.author, `Created in ${column}`, 'event');
  if (related) {
    const what = kind === 'decision' ? 'Waiting on decision' : kind === 'bug' ? 'Bug raised' : 'Related task created';
    addActivity(related, input.author, `${what} #${task.id}: ${task.title}`, 'event');
    related.updatedAt = now();
  }
  board.tasks.push(task);
  save();
  return task;
}

// The user answers a decision: record the answer, file it in done, and tell the task it was blocking.
function decideTask(id, { answer, author }) {
  if (!answer || !String(answer).trim()) throw new HttpError(400, 'answer is required');
  const task = findTask(id);
  if (task.kind !== 'decision') throw new HttpError(400, `Task ${id} is not a decision`);
  if (task.answer) throw new HttpError(409, `Decision ${id} was already answered: ${task.answer}`);
  task.answer = String(answer).trim();
  task.answeredAt = now();
  addActivity(task, author, `Decided: ${task.answer}`, 'comment');
  updateTask(task.id, { column: 'done', author });
  if (task.relatedTaskId) {
    const related = board.tasks.find((t) => t.id === task.relatedTaskId);
    if (related) {
      addActivity(related, author, `Decision #${task.id} answered: ${task.answer}`, 'event');
      related.updatedAt = now();
    }
  }
  save();
  return task;
}

const EDITABLE = ['title', 'description', 'column', 'priority', 'assignee', 'tags', 'order', 'projectId', 'options', 'recommendation'];

function updateTask(id, input) {
  const task = findTask(id);
  validate(input);
  if (input.projectId !== undefined) input = { ...input, projectId: Number(input.projectId) };
  const changes = [];
  for (const key of EDITABLE) {
    if (input[key] === undefined) continue;
    const prev = task[key];
    if (JSON.stringify(prev) === JSON.stringify(input[key])) continue;
    task[key] = input[key];
    if (key === 'column') {
      changes.push(`Moved ${prev} → ${input[key]}`);
    } else if (key === 'projectId') {
      changes.push(`Moved to project ${findProject(input[key]).name}`);
    } else if (key === 'assignee') {
      changes.push(input[key] ? `Assigned to ${input[key]}` : 'Unassigned');
    } else if (key !== 'order') {
      changes.push(`Updated ${key}`);
    }
  }
  // Dropping a card into an intake column makes it that kind (e.g. a task dragged into Bugs becomes a bug).
  const intakeKind = KIND_FOR_COLUMN[task.column];
  if (intakeKind && task.kind !== intakeKind) {
    task.kind = intakeKind;
    if (intakeKind === 'decision') {
      task.options ??= [];
      task.recommendation ??= null;
      task.answer ??= null;
      task.answeredAt ??= null;
    }
  }
  // A column or project change lands the task at the end of its new list unless an order was given.
  const relocated = changes.some((c) => c.startsWith('Moved'));
  if (relocated && input.order === undefined) task.order = nextOrder(task.projectId, task.column);
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

// Atomically take the highest-priority, oldest unassigned task from a project's column and start it.
function claimNext({ assignee, projectId, column = 'todo', tag }) {
  if (!assignee) throw new HttpError(400, 'assignee is required');
  if (projectId === undefined) throw new HttpError(400, 'projectId is required');
  const pid = findProject(projectId).id;
  const candidates = board.tasks
    .filter((t) => t.projectId === pid && t.column === column && !t.assignee && (!tag || t.tags.includes(tag)))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order);
  if (!candidates.length) return null;
  return updateTask(candidates[0].id, { column: 'in_progress', assignee, author: assignee });
}

function listTasks(query) {
  let tasks = board.tasks;
  if (query.project) tasks = tasks.filter((t) => t.projectId === Number(query.project));
  if (query.column) tasks = tasks.filter((t) => t.column === query.column);
  if (query.kind) tasks = tasks.filter((t) => t.kind === query.kind);
  if (query.assignee) tasks = tasks.filter((t) => t.assignee === query.assignee);
  if (query.tag) tasks = tasks.filter((t) => t.tags.includes(query.tag));
  if (query.q) {
    const q = query.q.toLowerCase();
    tasks = tasks.filter((t) => `${t.title} ${t.description}`.toLowerCase().includes(q));
  }
  return [...tasks].sort((a, b) => COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || a.order - b.order);
}

// ---------- projects ----------

// Normalise a folder path so links compare reliably (absolute, no trailing slash, symlinks resolved
// when the folder exists — e.g. macOS /tmp vs /private/tmp).
function normPath(p) {
  if (!p || !path.isAbsolute(String(p))) throw new HttpError(400, `path must be absolute: ${p}`);
  const resolved = path.resolve(String(p));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function findProject(id) {
  const project = board.projects.find((p) => p.id === Number(id));
  if (!project) throw new HttpError(404, `Project ${id} not found`);
  return project;
}

function withCounts(project) {
  const tasks = board.tasks.filter((t) => t.projectId === project.id);
  const counts = Object.fromEntries(COLUMNS.map((c) => [c, tasks.filter((t) => t.column === c).length]));
  return { ...project, counts };
}

function checkName(name, exceptId) {
  if (!name || !String(name).trim()) throw new HttpError(400, 'name is required');
  const clash = board.projects.find((p) => p.id !== exceptId && p.name.toLowerCase() === String(name).trim().toLowerCase());
  if (clash) throw new HttpError(409, `A project named "${clash.name}" already exists`);
}

// A folder can only be linked to one project, otherwise resolution would be ambiguous.
function checkPaths(paths, exceptId) {
  for (const p of paths) {
    const owner = board.projects.find((x) => x.id !== exceptId && x.paths.includes(p));
    if (owner) throw new HttpError(409, `${p} is already linked to project "${owner.name}"`);
  }
}

function createProject({ name, paths = [] }) {
  checkName(name);
  const normalised = [...new Set(paths.map(normPath))];
  checkPaths(normalised);
  const project = { id: board.nextProjectId++, name: String(name).trim(), paths: normalised, createdAt: now() };
  board.projects.push(project);
  save();
  return withCounts(project);
}

function updateProject(id, { name, paths }) {
  const project = findProject(id);
  if (name !== undefined) {
    checkName(name, project.id);
    project.name = String(name).trim();
  }
  if (paths !== undefined) {
    const normalised = [...new Set(paths.map(normPath))];
    checkPaths(normalised, project.id);
    project.paths = normalised;
  }
  save();
  return withCounts(project);
}

function linkPath(id, { path: p }) {
  const project = findProject(id);
  return updateProject(project.id, { paths: [...project.paths, p] });
}

function deleteProject(id) {
  const project = findProject(id);
  if (board.projects.length === 1) throw new HttpError(400, 'Cannot delete the last project');
  const removed = board.tasks.filter((t) => t.projectId === project.id).length;
  board.tasks = board.tasks.filter((t) => t.projectId !== project.id);
  board.projects = board.projects.filter((p) => p !== project);
  save();
  return { deleted: project.id, tasksDeleted: removed };
}

// Find the project linked to a folder: the deepest linked path that contains it.
function resolveProject(dir) {
  const target = normPath(dir);
  let best = null;
  for (const project of board.projects) {
    for (const p of project.paths) {
      const inside = target === p || target.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
      if (inside && (!best || p.length > best.path.length)) best = { project, path: p };
    }
  }
  if (!best) throw new HttpError(404, `No project is linked to ${target}`);
  return { ...withCounts(best.project), matchedPath: best.path };
}

// Folders Claude Code has been used in, read from ~/.claude/projects/<encoded-dir>/<session>.jsonl.
// The directory name encoding is lossy, so take the real cwd from the newest session transcript.
function claudeProjects() {
  let dirs;
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const found = new Map();
  for (const d of dirs) {
    const dir = path.join(CLAUDE_PROJECTS_DIR, d.name);
    const sessions = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!sessions.length) continue;
    const cwd = readCwd(sessions[0].file);
    if (!cwd) continue;
    const prev = found.get(cwd);
    if (!prev || prev.lastActive < sessions[0].mtime) found.set(cwd, { path: cwd, lastActive: sessions[0].mtime });
  }
  return [...found.values()]
    .sort((a, b) => b.lastActive - a.lastActive)
    .map((c) => {
      const owner = board.projects.find((p) => p.paths.includes(c.path));
      return { path: c.path, lastActive: new Date(c.lastActive).toISOString(), linkedProjectId: owner?.id ?? null };
    });
}

function readCwd(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const match = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    return match ? JSON.parse(`"${match[1]}"`) : null;
  } finally {
    fs.closeSync(fd);
  }
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
  const query = Object.fromEntries(url.searchParams);

  if (method === 'GET' && STATIC[url.pathname]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'public', STATIC[url.pathname])).pipe(res);
  }

  if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });

  if (parts[1] === 'board' && method === 'GET') {
    return send(res, 200, {
      columns: COLUMNS,
      priorities: PRIORITIES,
      projects: board.projects.map(withCounts),
      tasks: listTasks({ project: query.project }),
    });
  }
  if (parts[1] === 'claim' && method === 'POST') {
    const task = claimNext(await readBody(req));
    return send(res, 200, { task });
  }
  if (parts[1] === 'claude-projects' && method === 'GET') return send(res, 200, claudeProjects());
  if (parts[1] === 'projects') {
    const id = parts[2];
    if (id === 'resolve' && method === 'GET') return send(res, 200, resolveProject(query.path));
    if (!id && method === 'GET') return send(res, 200, board.projects.map(withCounts));
    if (!id && method === 'POST') return send(res, 201, createProject(await readBody(req)));
    if (id && parts[3] === 'paths' && method === 'POST') return send(res, 200, linkPath(id, await readBody(req)));
    if (id && !parts[3]) {
      if (method === 'GET') return send(res, 200, withCounts(findProject(id)));
      if (method === 'PATCH') return send(res, 200, updateProject(id, await readBody(req)));
      if (method === 'DELETE') return send(res, 200, deleteProject(id));
    }
  }
  if (parts[1] === 'tasks') {
    const id = parts[2];
    if (!id && method === 'GET') return send(res, 200, listTasks(query));
    if (!id && method === 'POST') return send(res, 201, createTask(await readBody(req)));
    if (id && parts[3] === 'comments' && method === 'POST') {
      return send(res, 201, commentTask(id, await readBody(req)));
    }
    if (id && parts[3] === 'decide' && method === 'POST') return send(res, 200, decideTask(id, await readBody(req)));
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
