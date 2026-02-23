#!/usr/bin/env bun
/**
 * ISCPersist.hook.ts - Persist ISC Criteria to WORK Directory (PostToolUse)
 *
 * PURPOSE:
 * Bridges the in-memory Claude Code Task system to the persistent MEMORY/WORK
 * ISC.json files. Fires on TaskCreate and TaskUpdate to capture ISC-prefixed
 * criteria as they are created and completed during Algorithm execution.
 *
 * TRIGGER: PostToolUse (matchers: "TaskCreate", "TaskUpdate", "TodoWrite")
 *
 * INPUT:
 * - stdin: Hook JSON with tool_name, tool_input, tool_result, session_id
 *
 * TaskCreate tool_input fields:
 *   subject: string  — the task content (e.g., "ISC-C1: ...")
 *
 * TaskUpdate tool_input fields:
 *   taskId: string   — the task number (e.g., "3")
 *   status: string   — new status ("pending"|"in_progress"|"completed"|"deleted")
 *
 * TodoWrite tool_input fields:
 *   todos: Array<{content, status, activeForm}> — full replacement list
 *   Only ISC-prefixed items are captured. ISC.json is append-only:
 *   criteria are added/updated but never removed on TodoWrite calls.
 *
 * OUTPUT:
 * - stdout: None (PostToolUse — output becomes system-reminder in context)
 * - stderr: Status/debug messages
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Writes: MEMORY/WORK/{session_dir}/tasks/{task_id}/ISC.json
 *
 * DESIGN NOTES:
 * - TaskCreate: adds criterion to ISC.json (criteria or antiCriteria array)
 * - TaskUpdate: updates criterion status by taskNum, recomputes satisfaction
 * - TodoWrite: diffs full list against ISC.json, adds new + updates changed
 * - Criteria stored as objects {content, taskNum, status} for status tracking
 * - Backward-compatible: migrates old string[] format to object[] on first update
 * - Silent failure on missing state — non-ISC sessions don't have WORK dirs
 * - Must be fast: PostToolUse hooks run in-line with tool execution
 *
 * ISC CRITERIA NAMING CONVENTIONS:
 * - ISC-C{N}: Regular criterion (e.g., "ISC-C1: ...")
 * - ISC-A{N}: Anti-criterion (e.g., "ISC-A1: ...")
 * - ISC-A-{Domain}-{N}: Grouped anti-criterion
 * - ISC-{Domain}-{N}: Grouped criterion
 * Any task subject starting with "ISC-" is captured.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PAI_DIR = process.env.PAI_DIR || join(process.env.HOME!, '.claude');
const STATE_DIR = join(PAI_DIR, 'MEMORY', 'STATE');
const WORK_DIR = join(PAI_DIR, 'MEMORY', 'WORK');

// "Task #3 created successfully" — same regex as AlgorithmTracker
const TASK_NUMBER = /Task\s+#(\d+)\s+created successfully/;

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    subject?: string;   // TaskCreate
    taskId?: string;    // TaskUpdate
    status?: string;    // TaskUpdate
    todos?: Array<{ content: string; status: string; activeForm?: string }>; // TodoWrite
  };
  tool_result?: string;
}

interface ISCEntry {
  content: string;
  taskNum?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

interface ISCJson {
  taskId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETE';
  effortLevel: string;
  criteria: ISCEntry[];
  antiCriteria: ISCEntry[];
  satisfaction: {
    satisfied: number;
    total: number;
    partial: number;
    failed: number;
  } | null;
  createdAt: string;
  updatedAt: string;
}

function isAntiCriterion(content: string): boolean {
  return /^ISC-A[-\d]/.test(content);
}

function isISCItem(content: string): boolean {
  return content.startsWith('ISC-');
}

function computeSatisfaction(criteria: ISCEntry[], antiCriteria: ISCEntry[]): ISCJson['satisfaction'] {
  const all = [...criteria, ...antiCriteria];
  if (all.length === 0) return null;
  const total = all.length;
  const satisfied = all.filter(e => e.status === 'completed').length;
  const partial = all.filter(e => e.status === 'in_progress').length;
  const failed = total - satisfied - partial;
  return { satisfied, total, partial, failed };
}

function computeStatus(criteria: ISCEntry[], antiCriteria: ISCEntry[]): ISCJson['status'] {
  const all = [...criteria, ...antiCriteria];
  if (all.length === 0) return 'PENDING';
  if (all.every(e => e.status === 'completed')) return 'COMPLETE';
  if (all.some(e => e.status !== 'pending')) return 'IN_PROGRESS';
  return 'PENDING';
}

/** Migrate old string[] format to ISCEntry[] format (backward-compat). */
function migrateEntries(arr: (string | ISCEntry)[]): ISCEntry[] {
  return arr.map(e =>
    typeof e === 'string' ? { content: e, status: 'pending' as const } : e
  );
}

async function getISCPath(sessionId: string): Promise<string | null> {
  const stateFile = join(STATE_DIR, `current-work-${sessionId}.json`);
  if (!existsSync(stateFile)) return null;

  const stateData = JSON.parse(readFileSync(stateFile, 'utf-8'));
  const sessionDir = stateData.session_dir;
  if (!sessionDir) return null;

  const tasksPath = join(WORK_DIR, sessionDir, 'tasks');
  if (!existsSync(tasksPath)) return null;

  const taskDirs = readdirSync(tasksPath).filter(d => d !== 'current');
  if (taskDirs.length === 0) return null;

  return join(tasksPath, taskDirs[0], 'ISC.json');
}

function readISC(iscPath: string, taskDir: string): ISCJson {
  if (existsSync(iscPath)) {
    try {
      const raw = JSON.parse(readFileSync(iscPath, 'utf-8'));
      // Migrate string[] to ISCEntry[]
      return {
        ...raw,
        criteria: migrateEntries(raw.criteria || []),
        antiCriteria: migrateEntries(raw.antiCriteria || []),
      };
    } catch { /* fall through to default */ }
  }

  const now = new Date().toISOString();
  return {
    taskId: taskDir,
    status: 'PENDING',
    effortLevel: 'STANDARD',
    criteria: [],
    antiCriteria: [],
    satisfaction: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function handleTaskCreate(data: HookInput): Promise<void> {
  const subject = data.tool_input?.subject;
  if (!subject || !isISCItem(subject)) return;

  const iscPath = await getISCPath(data.session_id);
  if (!iscPath) {
    console.error('[ISCPersist] No WORK state file for session — skipping');
    return;
  }

  // Extract task number from tool_result: "Task #3 created successfully"
  let taskNum: string | undefined;
  if (data.tool_result) {
    const m = data.tool_result.match(TASK_NUMBER);
    if (m) taskNum = m[1];
  }

  const taskDir = iscPath.split('/tasks/')[1]?.split('/')[0] || 'unknown';
  const isc = readISC(iscPath, taskDir);
  const entry: ISCEntry = { content: subject, taskNum, status: 'pending' };

  if (isAntiCriterion(subject)) {
    if (!isc.antiCriteria.some(e => e.content === subject)) {
      isc.antiCriteria.push(entry);
    }
  } else {
    if (!isc.criteria.some(e => e.content === subject)) {
      isc.criteria.push(entry);
    }
  }

  const now = new Date().toISOString();
  isc.satisfaction = computeSatisfaction(isc.criteria, isc.antiCriteria);
  isc.status = computeStatus(isc.criteria, isc.antiCriteria);
  isc.updatedAt = now;

  writeFileSync(iscPath, JSON.stringify(isc, null, 2), 'utf-8');
  const label = isAntiCriterion(subject) ? 'anti-criterion' : 'criterion';
  console.error(`[ISCPersist] + ${label}: ${subject.slice(0, 60)} (task #${taskNum ?? '?'})`);
}

async function handleTaskUpdate(data: HookInput): Promise<void> {
  const { taskId, status } = data.tool_input;
  if (!taskId || !status) return;

  const iscPath = await getISCPath(data.session_id);
  if (!iscPath) return;

  // Only process if ISC.json exists and has criteria
  if (!existsSync(iscPath)) return;
  const raw = JSON.parse(readFileSync(iscPath, 'utf-8'));
  const isc: ISCJson = {
    ...raw,
    criteria: migrateEntries(raw.criteria || []),
    antiCriteria: migrateEntries(raw.antiCriteria || []),
  };

  const statusMap: Record<string, ISCEntry['status']> = {
    pending: 'pending',
    in_progress: 'in_progress',
    completed: 'completed',
    deleted: 'failed',
  };
  const newStatus = statusMap[status];
  if (!newStatus) return;

  let updated = false;
  for (const entry of [...isc.criteria, ...isc.antiCriteria]) {
    if (entry.taskNum === taskId) {
      entry.status = newStatus;
      updated = true;
    }
  }

  if (!updated) return; // Not an ISC task — nothing to do

  const now = new Date().toISOString();
  isc.satisfaction = computeSatisfaction(isc.criteria, isc.antiCriteria);
  isc.status = computeStatus(isc.criteria, isc.antiCriteria);
  isc.updatedAt = now;

  writeFileSync(iscPath, JSON.stringify(isc, null, 2), 'utf-8');
  console.error(`[ISCPersist] ✓ Task #${taskId} → ${status}`);
}

async function handleTodoWrite(data: HookInput): Promise<void> {
  const todos = data.tool_input?.todos;
  if (!todos || !Array.isArray(todos)) return;

  // Only process ISC-prefixed items — ignore all other todos
  const iscTodos = todos.filter(t => t.content && isISCItem(t.content));
  if (iscTodos.length === 0) return;

  const iscPath = await getISCPath(data.session_id);
  if (!iscPath) {
    console.error('[ISCPersist] No WORK state file for session — skipping');
    return;
  }

  const taskDir = iscPath.split('/tasks/')[1]?.split('/')[0] || 'unknown';
  const isc = readISC(iscPath, taskDir);

  const statusMap: Record<string, ISCEntry['status']> = {
    pending: 'pending',
    in_progress: 'in_progress',
    completed: 'completed',
  };

  let changed = false;
  for (const todo of iscTodos) {
    const newStatus = statusMap[todo.status] || 'pending';
    const isAnti = isAntiCriterion(todo.content);
    const arr = isAnti ? isc.antiCriteria : isc.criteria;
    const existing = arr.find(e => e.content === todo.content);

    if (existing) {
      // Update status if changed — never delete
      if (existing.status !== newStatus) {
        existing.status = newStatus;
        changed = true;
        console.error(`[ISCPersist] ↺ "${todo.content.slice(0, 50)}" → ${newStatus}`);
      }
    } else {
      // New criterion — append only
      arr.push({ content: todo.content, status: newStatus });
      changed = true;
      const label = isAnti ? 'anti-criterion' : 'criterion';
      console.error(`[ISCPersist] + ${label}: ${todo.content.slice(0, 60)}`);
    }
  }

  if (!changed) return;

  const now = new Date().toISOString();
  isc.satisfaction = computeSatisfaction(isc.criteria, isc.antiCriteria);
  isc.status = computeStatus(isc.criteria, isc.antiCriteria);
  isc.updatedAt = now;

  writeFileSync(iscPath, JSON.stringify(isc, null, 2), 'utf-8');
  console.error(`[ISCPersist] TodoWrite synced ${iscTodos.length} ISC item(s)`);
}

async function main() {
  try {
    const raw = await Bun.stdin.text();
    if (!raw.trim()) process.exit(0);

    const data: HookInput = JSON.parse(raw);
    const { tool_name, session_id } = data;

    if (!session_id) process.exit(0);

    if (tool_name === 'TaskCreate') {
      await handleTaskCreate(data);
    } else if (tool_name === 'TaskUpdate') {
      await handleTaskUpdate(data);
    } else if (tool_name === 'TodoWrite') {
      await handleTodoWrite(data);
    }

    process.exit(0);
  } catch (err) {
    console.error('[ISCPersist] Fatal:', err);
    process.exit(0);
  }
}

main();
