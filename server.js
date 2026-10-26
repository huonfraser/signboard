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
const KINDS = ['task', 'bug', 'decision'];
// Per-project switches, set by humans in the UI, that loosen the bug and decision workflows for Claude.
const DEFAULT_SETTINGS = { autofixBugs: false, chatDecisions: false };
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
  for (const p of data.projects) p.settings = { ...DEFAULT_SETTINGS, ...p.settings };
  for (const t of data.tasks) {
    t.projectId ??= data.projects[0].id;
    t.kind ??= 'task';
    delete t.tags; // tags were removed (#13); the type field and filter cover what they were used for
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
  if (fields.kind !== undefined && !KINDS.includes(fields.kind)) {
    throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
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

// ---------- agent policy ----------
// Requests from Claude (via the MCP server) carry an X-Kanban-Agent header naming the agent ("actor").
// The UI sends none: humans can do anything. Claude is held to the three workflows:
//   Tasks:     humans release work backlog → todo; Claude claims todo → in_progress (a lock) → review.
//   Bugs:      Claude raises into bugs; humans triage to backlog/todo. "Autofix bugs" lets Claude route them itself.
//   Decisions: Claude raises into decisions; humans answer and route to backlog/todo.
//              "Decisions from chat" lets Claude record an answer the user gave in chat.
// Claude never touches backlog, and never moves anything to done.

const deny = (message) => {
  throw new HttpError(403, message);
};

const settingsOf = (projectId) => findProject(projectId).settings;
const createdBy = (task) => task.activity[0]?.author;

function guardTask(actor, task) {
  if (task.column === 'backlog') deny(`#${task.id} is in backlog. Backlog belongs to humans; Claude never changes it.`);
  if (task.column === 'in_progress' && task.assignee && task.assignee !== actor) {
    deny(`#${task.id} is locked: in progress by ${task.assignee}.`);
  }
}

function checkAgentMove(actor, task, to, note) {
  const from = task.column;
  if (to === from) return;
  if (to === 'backlog') deny('Claude never moves tasks into backlog; humans decide what goes there.');
  if (to === 'done') deny('Only humans move tasks to done. Move finished work to review.');
  if (from === 'decisions') {
    deny(`#${task.id} is an open decision; a human answers it on the board` +
      (settingsOf(task.projectId).chatDecisions ? ', or record their chat answer with record_decision.' : '.'));
  }
  if (from === 'bugs') {
    if (!settingsOf(task.projectId).autofixBugs) {
      deny(`#${task.id} is awaiting triage; a human moves bugs to backlog or todo. ("Autofix bugs" is off for this project.)`);
    }
    if (to === 'todo' || to === 'in_progress') return;
    deny(`With autofix, bugs can move to todo or in_progress, not ${to}.`);
  }
  if (from === 'todo' && to === 'in_progress') return;
  if (from === 'in_progress' && (to === 'review' || to === 'todo')) {
    if (task.assignee !== actor) deny(`#${task.id} is not claimed by ${actor}.`);
    if (!note) {
      deny(to === 'review'
        ? 'Moving to review needs a note: what changed, how it was verified, bugs raised, follow-ups.'
        : 'Releasing a task back to todo needs a note explaining why.');
    }
    return;
  }
  deny(`Claude can't move tasks from ${from} to ${to}. Allowed: todo → in_progress (claim), ` +
    'in_progress → review (with a note), in_progress → todo (release, with a note).');
}

const AGENT_EDITABLE = ['title', 'description', 'priority', 'options', 'recommendation'];

// Validate and adjust an update coming from Claude. Assignment follows the move: claiming locks, releasing unlocks.
function agentUpdate(actor, task, input) {
  guardTask(actor, task);
  const fields = Object.keys(input).filter((k) => input[k] !== undefined && !['author', 'note', 'column'].includes(k));
  const bad = fields.filter((k) => !AGENT_EDITABLE.includes(k));
  if (bad.length) deny(`Claude can't change ${bad.join(', ')}.`);
  if (fields.length) {
    if (task.column === 'review' || task.column === 'done') deny(`#${task.id} is in ${task.column}, waiting on a human.`);
    if (task.column === 'decisions' && createdBy(task) !== actor) deny(`#${task.id} is a decision raised by someone else.`);
    if (task.column === 'todo') deny(`Claim #${task.id} before editing it.`);
  }
  if (input.column !== undefined && input.column !== task.column) {
    checkAgentMove(actor, task, input.column, input.note);
    if (input.column === 'in_progress') input.assignee = actor;
    if (input.column === 'todo') input.assignee = null;
  }
  return input;
}

function agentCreate(actor, input, kind, column) {
  if (column === 'backlog') deny('Claude never adds to backlog; humans decide what work is released.');
  if (column === 'review' || column === 'done') deny(`New items cannot start in ${column}.`);
  const settings = settingsOf(input.projectId);
  if (kind === 'task') {
    const parent = input.relatedTaskId && board.tasks.find((t) => t.id === Number(input.relatedTaskId));
    if (column !== 'todo' || !parent || parent.column !== 'in_progress' || parent.assignee !== actor) {
      deny('Claude does not release new work; humans do, via backlog → todo. You can only split a task you have in ' +
        'progress into subtasks (in todo, with its id as the parent). Put other follow-ups in your review note, ' +
        'or raise a decision if a human needs to choose.');
    }
  }
  if (kind === 'bug' && column !== 'bugs' && !settings.autofixBugs) {
    deny('Bugs go to the bugs column for human triage ("Autofix bugs" is off for this project).');
  }
  if (kind === 'decision' && column !== 'decisions') deny('Decisions are raised into the decisions column.');
  if (column === 'in_progress') input.assignee = actor;
}

// ---------- tasks ----------

function createTask(input, actor) {
  if (!input.title) throw new HttpError(400, 'title is required');
  if (input.projectId === undefined) throw new HttpError(400, 'projectId is required');
  validate(input);
  let column = input.column || 'todo';
  const projectId = Number(input.projectId);
  // Kind comes from the intake column, or is given explicitly (e.g. an autofixed bug created straight in todo).
  let kind = KIND_FOR_COLUMN[column] || input.kind || 'task';
  if (!KINDS.includes(kind)) throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
  if (actor) agentCreate(actor, input, input.kind === 'bug' && column === 'decisions' ? 'bug' : kind, column);
  const author = actor || input.author;
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
  addActivity(task, author, `Created in ${column}`, 'event');
  if (related) {
    const what = { decision: 'Waiting on decision', bug: 'Bug raised', task: 'Subtask created' }[kind];
    addActivity(related, author, `${what} #${task.id}: ${task.title}`, 'event');
    related.updatedAt = now();
  }
  board.tasks.push(task);
  save();
  return task;
}

// Answer a decision and route it on. Humans send it to todo or backlog. Claude may record an answer the user
// gave in chat (when the project allows it), quoting them, and send it to todo or keep working on it.
function decideTask(id, { answer, column = 'todo', userQuote, author }, actor) {
  if (!answer || !String(answer).trim()) throw new HttpError(400, 'answer is required');
  const task = findTask(id);
  if (task.kind !== 'decision') throw new HttpError(400, `Task ${id} is not a decision`);
  if (task.answer) throw new HttpError(409, `Decision ${id} was already answered: ${task.answer}`);
  if (task.column !== 'decisions') throw new HttpError(400, `Decision ${id} is not in the decisions column`);
  let note = `Decided: ${String(answer).trim()}`;
  if (actor) {
    if (!settingsOf(task.projectId).chatDecisions) {
      deny('Only humans answer decisions on the board ("Decisions from chat" is off for this project).');
    }
    if (!userQuote || !String(userQuote).trim()) deny('Recording a chat decision needs the user\'s own words (userQuote).');
    if (!['todo', 'in_progress'].includes(column)) deny('A chat-answered decision goes to todo or in_progress.');
    author = `user (in chat, recorded by ${actor})`;
    note += `\n> ${String(userQuote).trim()}`;
  } else if (!['todo', 'backlog'].includes(column)) {
    throw new HttpError(400, 'An answered decision goes to todo or backlog');
  }
  task.answer = String(answer).trim();
  task.answeredAt = now();
  addActivity(task, author, note, 'comment');
  updateTask(task.id, { column, assignee: column === 'in_progress' ? actor : null, author: actor || author });
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

const EDITABLE = ['title', 'description', 'column', 'priority', 'assignee', 'kind', 'order', 'projectId', 'options', 'recommendation'];

// Keep a task's decision fields in line with its kind.
function applyKind(task, kind) {
  task.kind = kind;
  if (kind === 'decision') {
    task.options ??= [];
    task.recommendation ??= null;
    task.answer ??= null;
    task.answeredAt ??= null;
  }
}

function updateTask(id, input, actor) {
  const task = findTask(id);
  validate(input);
  if (actor) input = agentUpdate(actor, task, { ...input });
  const author = actor || input.author;
  if (input.projectId !== undefined) input = { ...input, projectId: Number(input.projectId) };
  const changes = [];
  for (const key of EDITABLE) {
    if (input[key] === undefined) continue;
    const prev = task[key];
    if (JSON.stringify(prev) === JSON.stringify(input[key])) continue;
    if (key === 'kind') {
      applyKind(task, input[key]);
      changes.push(`Changed type ${prev} → ${input[key]}`);
      continue;
    }
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
  if (intakeKind && task.kind !== intakeKind) applyKind(task, intakeKind);
  // A column or project change lands the task at the end of its new list unless an order was given.
  const relocated = changes.some((c) => c.startsWith('Moved'));
  if (relocated && input.order === undefined) task.order = nextOrder(task.projectId, task.column);
  if (input.note) addActivity(task, author, String(input.note));
  if (changes.length || input.order !== undefined || input.note) {
    task.updatedAt = now();
    if (changes.length) addActivity(task, author, changes.join('; '), 'event');
    save();
  }
  return task;
}

function deleteTask(id, actor) {
  const task = findTask(id);
  if (actor) {
    guardTask(actor, task);
    if (createdBy(task) !== actor) deny(`#${task.id} was not created by ${actor}; ask a human to delete it.`);
  }
  board.tasks = board.tasks.filter((t) => t !== task);
  save();
  return { deleted: task.id };
}

function commentTask(id, { text, author }, actor) {
  if (!text) throw new HttpError(400, 'text is required');
  const task = findTask(id);
  if (actor && task.column === 'backlog') deny(`#${task.id} is in backlog. Backlog belongs to humans; Claude never changes it.`);
  addActivity(task, actor || author, text);
  task.updatedAt = now();
  save();
  return task;
}

// Record a commit that implements a task. Commits often land after submitting for review, so Claude may link
// them to a task it claimed while that task is in progress or in review.
function linkCommit(id, { sha, message, author }, actor) {
  const task = findTask(id);
  sha = String(sha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, 'sha must be a 7–40 character hex commit hash');
  if (actor) {
    guardTask(actor, task);
    if (!['in_progress', 'review'].includes(task.column)) deny(`Commits are linked while a task is in progress or in review; #${task.id} is in ${task.column}.`);
    if (task.assignee !== actor) deny(`#${task.id} is not claimed by ${actor}.`);
  }
  task.commits ??= [];
  // Short and full hashes of the same commit count as one.
  if (task.commits.some((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha))) return task;
  const subject = String(message ?? '').split('\n')[0].trim();
  task.commits.push({ sha, message: subject, author: actor || author || 'user', at: now() });
  addActivity(task, actor || author, `Linked commit ${sha.slice(0, 7)}${subject ? `: ${subject}` : ''}`, 'event');
  task.updatedAt = now();
  save();
  return task;
}

// Atomically take a task and start it: a specific one (taskId) or the highest-priority, oldest unassigned
// one in a project's column. Claude may claim from todo, or from bugs when "Autofix bugs" is on.
function claimNext({ assignee, projectId, column = 'todo', taskId }, actor) {
  assignee = actor || assignee;
  if (!assignee) throw new HttpError(400, 'assignee is required');
  let task;
  if (taskId !== undefined) {
    task = findTask(taskId);
    column = task.column;
    if (task.assignee && task.assignee !== assignee) deny(`#${task.id} is already claimed by ${task.assignee}.`);
  } else if (projectId === undefined) {
    throw new HttpError(400, 'projectId or taskId is required');
  }
  const pid = task ? task.projectId : findProject(projectId).id;
  if (actor) {
    const allowed = ['todo', ...(settingsOf(pid).autofixBugs ? ['bugs'] : [])];
    if (!allowed.includes(column)) {
      deny(`Claude can only claim from ${allowed.join(' or ')}${column === 'bugs' ? ' ("Autofix bugs" is off for this project)' : ''}.`);
    }
  }
  if (!task) {
    [task] = board.tasks
      .filter((t) => t.projectId === pid && t.column === column && !t.assignee)
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order);
    if (!task) return null;
  }
  return updateTask(task.id, { column: 'in_progress', assignee, author: assignee });
}

function listTasks(query) {
  let tasks = board.tasks;
  if (query.project) tasks = tasks.filter((t) => t.projectId === Number(query.project));
  if (query.column) tasks = tasks.filter((t) => t.column === query.column);
  if (query.kind) tasks = tasks.filter((t) => t.kind === query.kind);
  if (query.assignee) tasks = tasks.filter((t) => t.assignee === query.assignee);
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
  const project = {
    id: board.nextProjectId++,
    name: String(name).trim(),
    paths: normalised,
    settings: { ...DEFAULT_SETTINGS },
    createdAt: now(),
  };
  board.projects.push(project);
  save();
  return withCounts(project);
}

function updateProject(id, { name, paths, settings }) {
  const project = findProject(id);
  if (settings !== undefined) {
    const unknown = Object.keys(settings).filter((k) => !(k in DEFAULT_SETTINGS));
    if (unknown.length) throw new HttpError(400, `Unknown settings: ${unknown.join(', ')}`);
    project.settings = { ...project.settings, ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, Boolean(v)])) };
  }
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
  // Set by the MCP server on every request Claude makes; absent for the UI. See "agent policy".
  const actor = req.headers["x-kanban-agent"] || null;

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
    const task = claimNext(await readBody(req), actor);
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
      if (actor && method !== 'GET') deny('Project settings are changed by humans in the board UI.');
      if (method === 'PATCH') return send(res, 200, updateProject(id, await readBody(req)));
      if (method === 'DELETE') return send(res, 200, deleteProject(id));
    }
  }
  if (parts[1] === 'tasks') {
    const id = parts[2];
    if (!id && method === 'GET') return send(res, 200, listTasks(query));
    if (!id && method === 'POST') return send(res, 201, createTask(await readBody(req), actor));
    if (id && parts[3] === 'comments' && method === 'POST') {
      return send(res, 201, commentTask(id, await readBody(req), actor));
    }
    if (id && parts[3] === 'commits' && method === 'POST') return send(res, 201, linkCommit(id, await readBody(req), actor));
    if (id && parts[3] === 'decide' && method === 'POST') return send(res, 200, decideTask(id, await readBody(req), actor));
    if (id && !parts[3]) {
      if (method === 'GET') return send(res, 200, findTask(id));
      if (method === 'PATCH') return send(res, 200, updateTask(id, await readBody(req), actor));
      if (method === 'DELETE') return send(res, 200, deleteTask(id, actor));
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
