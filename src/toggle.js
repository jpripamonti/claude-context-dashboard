import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { paths, buildInventory, editablePathsFrom, viewablePathsFrom, unpackParkedHook, isPlainObject, describeJson, PARKED_SLOT_KEY } from './scan.js';

const BACKUP_DIR = path.join(os.homedir(), '.claude-context-dashboard', 'backups');

// The name of a copy: the file it came from, then the moment it was taken.
// One shape, used to find a file's copies, to check an id names one of them,
// and to decide which to remove — so those three can't drift apart.
const BACKUP_NAME = /^(.*)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/;

// Nothing used to remove these, and every write copies the whole file: with a
// ~/.claude.json of several megabytes, a dozen clicks is a folder of a hundred.
// So it is kept to a size that can be stated plainly — at most this many copies
// of any one file, and this much in total, oldest going first. The newest copy
// of a file is never removed: it is the one an undo needs.
const KEEP_PER_FILE = 20;

// The environment variable is a test hook — it lets the total be reached
// without writing 50 MB — not something anyone needs to set.
function backupBudgetBytes() {
  const set = Number(process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET);
  return set > 0 ? set : 50 * 1024 * 1024;
}

function backupBeforeWrite(filePath) {
  if (!fs.existsSync(filePath)) return null;
  // Only you: the file names alone spell out every path you have edited, and
  // the copies hold whatever the originals held, keys included. Best effort —
  // a folder we cannot chmod (someone else owns it) must not block every save.
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  for (const dir of [path.dirname(BACKUP_DIR), BACKUP_DIR]) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* keep going: the backup itself still keeps the source file's own mode */
    }
  }
  const backupPath = nextBackupPath(filePath.replace(/[\\/]/g, '__'));
  fs.copyFileSync(filePath, backupPath);
  try {
    // never the copy just made, whatever its name says
    pruneBackups(path.basename(backupPath));
  } catch {
    /* the copy is made; tidying up afterwards must never fail a write */
  }
  return backupPath;
}

function stampToMs(stamp) {
  const at = Date.parse(stamp.replace(/^(.{10})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z'));
  return Number.isNaN(at) ? null : at;
}

function msToStamp(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

// Which copy of a file is the newest is read off its name, and everything
// downstream trusts that: the order of the version list, which one an undo
// takes, and which one pruning must never remove. So the moment in the name
// only ever moves forward for a given file. Two things would otherwise put it
// backwards — two writes inside one millisecond, and a clock that steps back (a
// time correction, a machine waking up) — and the second is the dangerous one:
// the copy just made would be filed as the oldest, and pruning would take it.
function nextBackupPath(flat) {
  let at = Date.now();
  for (const copy of backupNames()) {
    if (copy.of !== flat) continue;
    const already = stampToMs(copy.stamp);
    if (already !== null && already >= at) at = already + 1;
  }
  for (let i = 0; i < 1000; i++, at++) {
    const candidate = path.join(BACKUP_DIR, `${flat}.${msToStamp(at)}.bak`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  // falling through would mean copying over a copy: a version lost, silently
  throw new Error(`Could not find an unused name for a copy of this file in ${BACKUP_DIR}.`);
}

function backupNames() {
  let names;
  try {
    names = fs.readdirSync(BACKUP_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const parsed = BACKUP_NAME.exec(name);
    if (parsed) out.push({ name, of: parsed[1], stamp: parsed[2] });
  }
  return out;
}

function everyBackup() {
  const out = [];
  for (const copy of backupNames()) {
    try {
      out.push({ ...copy, size: fs.statSync(path.join(BACKUP_DIR, copy.name)).size });
    } catch {
      /* it went away between listing and asking about it */
    }
  }
  return out;
}

function pruneBackups(keepAlways = null) {
  const byFile = new Map();
  for (const copy of everyBackup()) {
    if (!byFile.has(copy.of)) byFile.set(copy.of, []);
    byFile.get(copy.of).push(copy);
  }

  const remove = [];
  const keep = [];
  const newest = new Map();
  for (const [of_, copies] of byFile) {
    copies.sort((a, b) => b.stamp.localeCompare(a.stamp)); // newest first
    newest.set(of_, copies[0]);
    keep.push(...copies.slice(0, KEEP_PER_FILE));
    remove.push(...copies.slice(KEEP_PER_FILE));
  }

  keep.sort((a, b) => a.stamp.localeCompare(b.stamp)); // oldest first
  let total = keep.reduce((bytes, copy) => bytes + copy.size, 0);
  const budget = backupBudgetBytes();
  for (const copy of keep) {
    if (total <= budget) break;
    if (newest.get(copy.of) === copy) continue; // the one an undo needs
    remove.push(copy);
    total -= copy.size;
  }

  // The name says which copy is newest, and it is kept above; this is the
  // second lock on the same door, for a name that somehow says otherwise.
  const doomed = remove.filter((copy) => copy.name !== keepAlways);
  for (const copy of doomed) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, copy.name));
    } catch {
      /* already gone, or not ours to remove */
    }
  }
  return doomed.length;
}

function statMeta(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, mtimeMs: st.mtimeMs, mode: st.mode & 0o777 };
  } catch {
    return { exists: false, mtimeMs: null, mode: null };
  }
}

// Reads a JSON file (or {} if it doesn't exist yet) together with a snapshot
// of its on-disk state, so a later write can detect whether something else —
// most likely a running Claude Code session — changed it in the meantime.
function loadForUpdate(filePath, { keepOriginal = false } = {}) {
  const meta = statMeta(filePath);
  let data = {};
  if (meta.exists) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`${filePath} exists but is not valid JSON (${err.message}). Fix it by hand first.`);
    }
    // Valid JSON of the wrong shape (`null`, a list) would otherwise be written
    // into as if it were an object, which throws something unreadable.
    if (!isPlainObject(parsed)) {
      throw new Error(
        `${filePath} is valid JSON but holds ${describeJson(parsed)}, not a set of settings, so there is nowhere to put this. Open it here and fix it first.`
      );
    }
    data = parsed;
  }
  // `original` is only cloned when a caller needs to roll back — ~/.claude.json
  // can be several megabytes, and every toggle reads it.
  return { data, meta, original: keepOriginal ? structuredClone(data) : null };
}

// Two files have to change together (a hook leaves one and joins the other).
// The file it is joining is always written FIRST, so if the second write fails
// the hook exists in both files — visible in the dashboard, and undoable —
// rather than in neither. Undoing the first write is then only a tidy-up, and
// is skipped rather than forced if anything looks off.
function writePair(first, second) {
  const firstBackup = writeJsonAtomic(first.path, first.next, first.meta);
  const metaAfterFirst = statMeta(first.path);
  try {
    const secondBackup = writeJsonAtomic(second.path, second.next, second.meta);
    return { firstBackup, secondBackup };
  } catch (err) {
    let undone = false;
    try {
      if (!first.meta.exists) {
        // it did not exist before, so putting "the previous contents" back
        // would leave an empty file where there was none
        fs.unlinkSync(first.path);
      } else {
        // metaAfterFirst is this write's own result: if it no longer matches,
        // something else has written the file and must not be overwritten
        writeJsonAtomic(first.path, first.original, metaAfterFirst);
      }
      undone = true;
    } catch {
      /* leave it: both files naming the same thing is the safe failure */
    }
    if (undone) throw err;
    throw new Error(
      `${err.message}\n\n${first.path} was already changed and could not be put back, so the same entry is now in both ${first.path} and ${second.path} — the dashboard will list it twice. A copy of the file as it was is at ${firstBackup}.`
    );
  }
}

// A settings file that is a link almost always belongs to a dotfiles repo. A
// write here replaces the file by renaming a temporary one over it, which would
// leave an ordinary file where the link was and quietly disconnect it — so the
// link is followed and the file it really points at is the one written.
// It is only followed to a file of the same kind: a `settings.json` pointing at
// something that is not a .json file is refused rather than overwritten. The
// editor (writeEditableFile) refuses links outright instead, because what it
// writes is whatever text you typed rather than keys this dashboard generated.
function resolveWriteTarget(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    return filePath; // not there yet — nothing to follow
  }
  if (!st.isSymbolicLink()) return filePath;

  let target;
  try {
    target = fs.realpathSync(filePath);
  } catch {
    throw new Error(`${filePath} is a link and the file it points to is not there. Fix the link first.`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (path.extname(target).toLowerCase() !== ext) {
    throw new Error(
      `${filePath} is a link to ${target}, which is a different kind of file. Refusing to write over it — point the link at a ${ext || 'file of the same kind'} file, or edit ${target} directly.`
    );
  }
  return target;
}

function writeTextAtomic(pathAsListed, text, expectedMeta) {
  const filePath = resolveWriteTarget(pathAsListed);
  const currentMeta = statMeta(filePath);
  if (currentMeta.exists !== expectedMeta.exists || currentMeta.mtimeMs !== expectedMeta.mtimeMs) {
    throw new Error(
      `${filePath} changed on disk since it was read (likely a running Claude Code session) — reload the dashboard and try again.`
    );
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backupPath = backupBeforeWrite(filePath);
  const tmp = filePath + '.tmp-' + process.pid;
  // Preserve the original file's permissions (e.g. ~/.claude.json is 600), and
  // create the temp file with them from the start: writing first and fixing the
  // mode afterwards would leave the contents — API keys included — briefly
  // readable by anyone else on the machine.
  const mode = currentMeta.exists ? currentMeta.mode : 0o600;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
  fs.chmodSync(tmp, mode); // writeFileSync's mode is subject to the umask
  fs.renameSync(tmp, filePath);
  return backupPath;
}

function writeJsonAtomic(filePath, data, expectedMeta) {
  return writeTextAtomic(filePath, JSON.stringify(data, null, 2) + '\n', expectedMeta);
}

function assertDirectory(p, label) {
  if (!p || typeof p !== 'string' || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new Error(`${label} is not a directory: ${p}`);
  }
}

function assertString(v, label) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertBoolean(v, label) {
  if (typeof v !== 'boolean') throw new Error(`${label} must be a boolean`);
}

// A plugin can be switched at two levels: globally (the default for every
// project) or just for the project being viewed, which overrides the global
// default. "project" stays the default so an accidental click can't change
// every project at once.
const SETTINGS_FILE_BY_SCOPE = {
  global: ['settings.json'],
  'global-local': ['settings.local.json'],
  project: ['settings.json'],
  'project-local': ['settings.local.json'],
};

function pluginSettingsPath(scope, projectPath) {
  const fileName = SETTINGS_FILE_BY_SCOPE[scope]?.[0];
  if (!fileName) throw new Error(`unknown settings scope: ${scope}`);
  if (scope.startsWith('global')) return path.join(paths.GLOBAL_CLAUDE_DIR, fileName);
  assertDirectory(projectPath, 'projectPath');
  return path.join(projectPath, '.claude', fileName);
}

export function togglePlugin({ projectPath, key, enabled, scope = 'project' }) {
  assertString(key, 'key');
  assertBoolean(enabled, 'enabled');
  // Switching is only offered for the two shared files; the personal "local"
  // ones can have a leftover entry removed, but the dashboard does not put
  // new decisions there.
  if (scope !== 'global' && scope !== 'project') throw new Error('a plugin can only be switched globally or for this project');

  const filePath = pluginSettingsPath(scope, projectPath);
  const { data, meta } = loadForUpdate(filePath);
  data.enabledPlugins = data.enabledPlugins || {};
  data.enabledPlugins[key] = enabled;
  const backupPath = writeJsonAtomic(filePath, data, meta);
  return { filePath, backupPath };
}

// Removes a project's own decision about a plugin, so it goes back to
// following whatever the global default says.
export function clearPluginOverride({ projectPath, key, scope = 'project' }) {
  assertString(key, 'key');

  const filePath = pluginSettingsPath(scope, projectPath);
  const { data, meta } = loadForUpdate(filePath);
  if (!data.enabledPlugins || !(key in data.enabledPlugins)) {
    return { filePath, note: 'nothing to clear at this level' };
  }
  delete data.enabledPlugins[key];
  if (Object.keys(data.enabledPlugins).length === 0) delete data.enabledPlugins;
  const backupPath = writeJsonAtomic(filePath, data, meta);
  return { filePath, backupPath };
}

// Puts the "this project may / may not use this .mcp.json server" entry in one
// settings file, replacing whatever that file said about the server before.
function setMcpjsonApproval({ filePath, projectPath, name, enabled, inv = null }) {
  const real = assertEditable(filePath, projectPath, inv);
  const { data, meta } = loadForUpdate(real);
  for (const key of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) {
    if (!Array.isArray(data[key])) continue;
    data[key] = data[key].filter((n) => n !== name);
    if (data[key].length === 0) delete data[key];
  }
  const key = enabled ? 'enabledMcpjsonServers' : 'disabledMcpjsonServers';
  data[key] = [...(Array.isArray(data[key]) ? data[key] : []), name];
  const backupPath = writeJsonAtomic(real, data, meta);
  return { filePath: real, backupPath };
}

// project-shared (.mcp.json) servers: native mechanism already used by Claude
// Code itself — the per-project enabled/disabled lists. Those lists are
// ordinary settings keys, so they can appear in any settings layer as well as
// in ~/.claude.json's own record, and a settings layer outranks the record.
// Writing the record regardless would be a switch that reports success and
// leaves the server exactly as it was, so the decision is written wherever it
// is currently being made.
export function toggleMcpShared({ projectPath, name, enabled }) {
  assertString(name, 'name');
  assertBoolean(enabled, 'enabled');
  assertDirectory(projectPath, 'projectPath');

  const inv = buildInventory(projectPath);
  const before = inv.mcp.shared.find((s) => s.name === name);
  const decidedIn = before?.explicitlySetIn || null;
  const layerFor = (label) => inv.settingsLayers.find((l) => l.label === label)?.path || null;
  const projectFiles = [layerFor('project'), layerFor('project-local')].filter(Boolean);

  const notes = [];
  let result;
  if (decidedIn && projectFiles.includes(decidedIn)) {
    result = setMcpjsonApproval({ filePath: decidedIn, projectPath, name, enabled, inv });
  } else if (decidedIn && decidedIn !== paths.GLOBAL_CLAUDE_JSON) {
    // The decision lives in a settings file that applies to every project.
    // Writing there would switch this server on or off everywhere, from a
    // switch that says "this project" — so the decision is made in the
    // project's own settings file instead, which outranks it here and leaves
    // every other project alone.
    const here = layerFor('project');
    if (!here) {
      throw new Error(
        `"${name}" is decided in ${decidedIn}, which applies to every project, and this project has no settings file of its own to override it with (its .claude folder is the same one). Change it in ${decidedIn} if you mean it for every project.`
      );
    }
    result = setMcpjsonApproval({ filePath: here, projectPath, name, enabled, inv });
    notes.push(
      `${decidedIn} applies to every project and still says ${before.enabled ? 'on' : 'off'}, so this was written to ${here} instead, which wins for this project only.`
    );
  } else {
    const resolvedProjectPath = fs.realpathSync(path.resolve(projectPath));
    const { data, meta } = loadForUpdate(paths.GLOBAL_CLAUDE_JSON);
    data.projects = data.projects || {};
    data.projects[resolvedProjectPath] = data.projects[resolvedProjectPath] || {};
    const entry = data.projects[resolvedProjectPath];
    entry.enabledMcpjsonServers = (entry.enabledMcpjsonServers || []).filter((n) => n !== name);
    entry.disabledMcpjsonServers = (entry.disabledMcpjsonServers || []).filter((n) => n !== name);
    (enabled ? entry.enabledMcpjsonServers : entry.disabledMcpjsonServers).push(name);
    const backupPath = writeJsonAtomic(paths.GLOBAL_CLAUDE_JSON, data, meta);
    result = { filePath: paths.GLOBAL_CLAUDE_JSON, backupPath };
  }

  // Belt and braces: if something else is still deciding, say so instead of
  // reporting a success the dashboard would then contradict.
  const after = buildInventory(projectPath).mcp.shared.find((s) => s.name === name);
  if (after && after.enabled !== enabled) {
    notes.push(`Written to ${result.filePath}, but "${name}" still counts as ${after.enabled === null ? 'undecided' : after.enabled ? 'on' : 'off'}: ${after.reason}`);
  }
  if (notes.length) result.note = notes.join('\n\n');
  return result;
}

// Switching a server off parks its definition under a shadow key instead of
// deleting it. If it is then set up again by another route under the same name
// — `claude mcp add`, or an edit by hand — there are two real definitions, and
// switching either way would overwrite one of them with the other. Which one is
// wanted is not something this can work out, so it refuses and the dashboard
// shows both with a choice (see resolveMcpDuplicate).
function assertNoDuplicate(active, parked, name) {
  if (active?.[name] && parked?.[name]) {
    throw new Error(
      `There are two definitions of "${name}" right now: the one in use, and the one saved when it was switched off here. Choose which one to keep — the dashboard shows both — before switching it.`
    );
  }
}

// project-local (private) MCP servers: presence = enabled, so "off" moves
// the config into our own shadow key instead of deleting it.
export function toggleMcpLocal({ projectPath, name, enabled }) {
  assertString(name, 'name');
  assertBoolean(enabled, 'enabled');
  assertDirectory(projectPath, 'projectPath');

  const resolvedProjectPath = fs.realpathSync(path.resolve(projectPath));
  const { data, meta } = loadForUpdate(paths.GLOBAL_CLAUDE_JSON);
  data.projects = data.projects || {};
  data.projects[resolvedProjectPath] = data.projects[resolvedProjectPath] || {};
  const entry = data.projects[resolvedProjectPath];
  entry.mcpServers = entry.mcpServers || {};
  entry.disabledLocalMcpServers = entry.disabledLocalMcpServers || {};
  assertNoDuplicate(entry.mcpServers, entry.disabledLocalMcpServers, name);

  if (enabled) {
    if (entry.disabledLocalMcpServers[name]) {
      entry.mcpServers[name] = entry.disabledLocalMcpServers[name];
      delete entry.disabledLocalMcpServers[name];
    }
  } else if (entry.mcpServers[name]) {
    entry.disabledLocalMcpServers[name] = entry.mcpServers[name];
    delete entry.mcpServers[name];
  }
  const backupPath = writeJsonAtomic(paths.GLOBAL_CLAUDE_JSON, data, meta);
  return { filePath: paths.GLOBAL_CLAUDE_JSON, backupPath };
}

// user (global) MCP servers: affects every project, so callers must make
// that explicit to the user before calling this.
export function toggleMcpUser({ name, enabled }) {
  assertString(name, 'name');
  assertBoolean(enabled, 'enabled');

  const { data, meta } = loadForUpdate(paths.GLOBAL_CLAUDE_JSON);
  data.mcpServers = data.mcpServers || {};
  data.disabledUserMcpServers = data.disabledUserMcpServers || {};
  assertNoDuplicate(data.mcpServers, data.disabledUserMcpServers, name);

  if (enabled) {
    if (data.disabledUserMcpServers[name]) {
      data.mcpServers[name] = data.disabledUserMcpServers[name];
      delete data.disabledUserMcpServers[name];
    }
  } else if (data.mcpServers[name]) {
    data.disabledUserMcpServers[name] = data.mcpServers[name];
    delete data.mcpServers[name];
  }
  const backupPath = writeJsonAtomic(paths.GLOBAL_CLAUDE_JSON, data, meta);
  return { filePath: paths.GLOBAL_CLAUDE_JSON, backupPath };
}

// Settles the case above: one of the two definitions is kept and the other is
// dropped, which leaves the server switched on with a single definition, so the
// ordinary switch works again. Nothing is guessed — the dashboard shows both
// and this records the answer. The definition that is dropped is still in the
// backup taken before the write.
export function resolveMcpDuplicate({ scope, projectPath, name, keep }) {
  assertString(name, 'name');
  if (scope !== 'user' && scope !== 'local') throw new Error('scope must be "user" or "local"');
  if (keep !== 'current' && keep !== 'saved') throw new Error('keep must be "current" or "saved"');

  const { data, meta } = loadForUpdate(paths.GLOBAL_CLAUDE_JSON);
  let holder = data;
  if (scope === 'local') {
    assertDirectory(projectPath, 'projectPath');
    const resolvedProjectPath = fs.realpathSync(path.resolve(projectPath));
    holder = data.projects?.[resolvedProjectPath];
  }
  const parkedKey = scope === 'user' ? 'disabledUserMcpServers' : 'disabledLocalMcpServers';
  const active = holder?.mcpServers;
  const parked = holder?.[parkedKey];
  if (!active?.[name] || !parked?.[name]) {
    throw new Error(`"${name}" does not have two definitions any more — reload the dashboard.`);
  }

  if (keep === 'saved') active[name] = parked[name];
  delete parked[name];
  if (Object.keys(parked).length === 0) delete holder[parkedKey];
  const backupPath = writeJsonAtomic(paths.GLOBAL_CLAUDE_JSON, data, meta);
  return { filePath: paths.GLOBAL_CLAUDE_JSON, backupPath, kept: keep };
}

// Skills/agents that live directly under a global or project folder (never
// inside a plugin's own install cache) are toggled by renaming the file —
// Claude Code simply won't see a file it doesn't recognize. Restricted to
// known skill/agent directories, and never overwrites an existing file.
export function toggleFile({ filePath, enabled, projectPath }) {
  assertString(filePath, 'filePath');
  assertBoolean(enabled, 'enabled');

  const real = path.resolve(filePath);
  const allowedDirs = [path.join(paths.GLOBAL_CLAUDE_DIR, 'skills'), path.join(paths.GLOBAL_CLAUDE_DIR, 'agents')];
  if (projectPath && fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()) {
    const resolvedProject = path.resolve(projectPath);
    allowedDirs.push(path.join(resolvedProject, '.claude', 'skills'), path.join(resolvedProject, '.claude', 'agents'));
  }
  const isAllowed = allowedDirs.some((dir) => real === dir || real.startsWith(dir + path.sep));
  if (!isAllowed) {
    throw new Error('Refusing to toggle a file outside known skill/agent directories.');
  }
  if (real.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) {
    throw new Error('This file belongs to a plugin. Toggle the plugin instead.');
  }
  assertMarkdown(real);

  return renameToggle(real, enabled);
}

function assertMarkdown(real) {
  if (!/\.md(\.disabled)?$/.test(real)) {
    throw new Error('Only markdown files can be switched off this way.');
  }
}

// Switching a file off means renaming it so Claude Code stops recognizing it;
// the content is never touched, and never renamed over an existing file.
function renameToggle(real, enabled) {
  const disabledPath = real.endsWith('.disabled') ? real : real + '.disabled';
  const enabledPath = real.endsWith('.disabled') ? real.slice(0, -'.disabled'.length) : real;

  // Both present at once is ambiguous — reporting success while the live file
  // keeps loading would be a lie, so say what is in the way instead.
  if (fs.existsSync(enabledPath) && fs.existsSync(disabledPath)) {
    throw new Error(
      `There is both a live file and a switched-off copy here: ${enabledPath} and ${disabledPath}. Delete or rename one of them by hand, then try again.`
    );
  }

  if (enabled) {
    if (fs.existsSync(enabledPath)) return { filePath: enabledPath, note: 'already enabled' };
    if (!fs.existsSync(disabledPath)) throw new Error('Nothing to enable — neither file exists.');
    fs.renameSync(disabledPath, enabledPath);
    return { filePath: enabledPath };
  } else {
    if (!fs.existsSync(enabledPath)) {
      if (fs.existsSync(disabledPath)) return { filePath: disabledPath, note: 'already disabled' };
      throw new Error('Nothing to switch off — the file is not there.');
    }
    fs.renameSync(enabledPath, disabledPath);
    return { filePath: disabledPath };
  }
}

// --- editing anything the dashboard shows ---------------------------------

// A file may only be read back or written if the dashboard is currently
// listing it for this project (see collectEditablePaths). Files that belong to
// an installed plugin are never writable — they are replaced whenever the
// plugin updates, so an edit there would silently disappear.
// The path must be one the dashboard listed, spelled exactly as it listed it.
// Matching on the symlink-resolved form instead would be a hole: an instructions
// file that is a symlink to ~/.ssh/authorized_keys resolves to that target, so
// naming the target directly would pass the check and get it overwritten. The
// scanner already reports every path in symlink-resolved form, so an exact
// comparison is also what the dashboard's own page always sends.
function assertEditable(filePath, projectPath, inv = null) {
  assertString(filePath, 'filePath');
  assertDirectory(projectPath, 'projectPath');
  const resolved = path.resolve(filePath);
  if (resolved.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) {
    throw new Error('This file belongs to a plugin, so it can be read but not changed here — the next plugin update would overwrite anything you wrote.');
  }
  // `inv` is an inventory the caller has already built in this same operation:
  // the answer is the same one a fresh build would give, without reading
  // several megabytes of ~/.claude.json again to give it.
  const inventory = inv || buildInventory(projectPath);
  if (!editablePathsFrom(inventory).has(resolved)) {
    // A file an instructions file only points at IS shown here, so the general
    // refusal below would be a lie about why it cannot be written.
    const refs = inventory.claudeMd.references;
    if (refs && refs.files.some((f) => f.path === resolved)) {
      throw new Error('Nothing loads this file — an instructions file only points at it, so it is shown here to be read, not changed. Edit it where you edit the rest of the project.');
    }
    throw new Error('Refusing to touch a file this dashboard is not showing for this project.');
  }
  return resolved;
}

// Reading is allowed for everything the dashboard lists; writing is narrower,
// so the answer says which of the two this file is.
function assertViewable(filePath, projectPath, inv = null) {
  assertString(filePath, 'filePath');
  assertDirectory(projectPath, 'projectPath');
  const real = path.resolve(filePath);
  if (!viewablePathsFrom(inv || buildInventory(projectPath)).has(real)) {
    throw new Error('Refusing to touch a file this dashboard is not showing for this project.');
  }
  return real;
}

export function readEditableFile({ filePath, projectPath }) {
  const inv = buildInventory(projectPath);
  const real = assertViewable(filePath, projectPath, inv);

  let writable = true;
  let readOnlyReason = null;
  try {
    assertEditable(real, projectPath, inv);
    if (fs.lstatSync(real).isSymbolicLink()) {
      writable = false;
      readOnlyReason = 'This is a link to another file, so text typed here cannot be saved over it — open the file it points to for that. Switches, and putting an earlier version back, do write through the link.';
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      writable = false;
      readOnlyReason = err.message;
    }
  }

  const meta = statMeta(real);
  return {
    filePath: real,
    exists: meta.exists,
    mtimeMs: meta.mtimeMs,
    writable,
    readOnlyReason,
    content: meta.exists ? fs.readFileSync(real, 'utf8') : '',
  };
}

// followLink is for putting an earlier version back: that content is this
// dashboard's own copy of this very file, so writing it through a link is the
// same thing a switch does. Typed text is not — hence the refusal below.
export function writeEditableFile({ filePath, projectPath, content, expectedMtimeMs, followLink = false }) {
  const real = assertEditable(filePath, projectPath);
  if (typeof content !== 'string') throw new Error('content must be a string');
  try {
    if (!followLink && fs.lstatSync(real).isSymbolicLink()) {
      throw new Error(
        `${real} is a link to another file. Saving here would replace the link itself, so edit the file it points to instead.`
      );
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // a file that doesn't exist yet is fine
  }
  if (real.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Not valid JSON, so it was not saved: ${err.message}`);
    }
    // Valid JSON that is not an object parses fine and then breaks every reader
    // of the file, Claude Code's included — so it cannot be saved from here.
    if (!isPlainObject(parsed)) {
      throw new Error(`This file has to hold a JSON object; that is ${describeJson(parsed)}. Not saved.`);
    }
  }
  // expectedMtimeMs is what the editor saw when it opened the file; null or
  // absent means "this file did not exist when I opened it". Either way the
  // write is refused if the file changed in the meantime.
  const expected = {
    exists: expectedMtimeMs !== undefined && expectedMtimeMs !== null,
    mtimeMs: expectedMtimeMs ?? null,
  };
  const backupPath = writeTextAtomic(real, content, expected);
  return { filePath: real, backupPath };
}

// CLAUDE.md files and memory notes are switched off the same way skills are:
// by renaming them. Restricted to markdown so a settings file or .mcp.json
// can't be renamed out from under Claude Code by accident.
export function toggleMarkdown({ filePath, projectPath, enabled }) {
  assertBoolean(enabled, 'enabled');
  const real = assertEditable(filePath, projectPath);
  assertMarkdown(real);
  return renameToggle(real, enabled);
}

// Moves a tool connection between "every project" and "only this project".
// A connection you use in one project has no reason to be loaded into every
// conversation you start, and the list of tools it sends is usually the
// largest single thing that goes in. The definition is carried across exactly
// as it was, whether it was switched on or off.
export function moveMcpServer({ name, to, projectPath }) {
  assertString(name, 'name');
  if (to !== 'project' && to !== 'global') throw new Error('to must be "project" or "global"');
  assertDirectory(projectPath, 'projectPath');

  const resolvedProjectPath = fs.realpathSync(path.resolve(projectPath));
  const { data, meta } = loadForUpdate(paths.GLOBAL_CLAUDE_JSON);
  data.projects = data.projects || {};
  const entry = (data.projects[resolvedProjectPath] = data.projects[resolvedProjectPath] || {});

  const global = { active: (data.mcpServers = data.mcpServers || {}), parked: (data.disabledUserMcpServers = data.disabledUserMcpServers || {}) };
  const local = { active: (entry.mcpServers = entry.mcpServers || {}), parked: (entry.disabledLocalMcpServers = entry.disabledLocalMcpServers || {}) };
  const [from, dest] = to === 'project' ? [global, local] : [local, global];

  assertNoDuplicate(from.active, from.parked, name);
  const config = from.active[name] ?? from.parked[name];
  if (config === undefined) throw new Error(`There is no connection called "${name}" to move — reload the dashboard.`);
  if (dest.active[name] !== undefined || dest.parked[name] !== undefined) {
    throw new Error(`There is already a connection called "${name}" where you are moving it to. Rename or remove that one first.`);
  }

  delete from.active[name];
  delete from.parked[name];
  // it lands switched on: moving it somewhere is how you say you want it there
  dest.active[name] = config;

  const backupPath = writeJsonAtomic(paths.GLOBAL_CLAUDE_JSON, data, meta);
  return { filePath: paths.GLOBAL_CLAUDE_JSON, backupPath };
}

// --- permission rules -----------------------------------------------------

const PERMISSION_GROUPS = new Set(['allow', 'deny', 'ask']);

// Adds or removes one permission rule in one settings file, leaving everything
// else in the file exactly as it was — the readable view edits through this
// rather than making the user rewrite the whole file as text.
export function updatePermissionRule({ filePath, projectPath, group, rule, action }) {
  assertString(rule, 'rule');
  if (!PERMISSION_GROUPS.has(group)) throw new Error('group must be allow, deny or ask');
  if (action !== 'add' && action !== 'remove') throw new Error('action must be add or remove');
  const real = assertEditable(filePath, projectPath);
  if (!real.endsWith('.json')) throw new Error('Permission rules live in a settings file.');

  const { data, meta } = loadForUpdate(real);
  data.permissions = data.permissions || {};
  const list = Array.isArray(data.permissions[group]) ? data.permissions[group] : [];

  if (action === 'add') {
    if (list.includes(rule)) return { filePath: real, note: 'that rule is already there' };
    list.push(rule);
  } else {
    const at = list.indexOf(rule);
    if (at === -1) throw new Error('That rule is not there any more — reload the dashboard.');
    list.splice(at, 1);
  }

  if (list.length === 0) delete data.permissions[group];
  else data.permissions[group] = list;
  if (Object.keys(data.permissions).length === 0) delete data.permissions;

  const backupPath = writeJsonAtomic(real, data, meta);
  return { filePath: real, backupPath };
}

// --- hooks ----------------------------------------------------------------

function loadParked() {
  const loaded = loadForUpdate(paths.PARKED_FILE, { keepOriginal: true });
  loaded.data.hooks = loaded.data.hooks || {};
  return loaded;
}

// A hook is switched off by moving it out of the settings file into this
// dashboard's own storage, so Claude Code's settings stay schema-clean and the
// hook's exact definition can be put back untouched.
// The position alone is not enough to identify a hook: two clicks made from one
// page render, or a second tab, would send positions that no longer mean what
// they did when the page was drawn, and the wrong hook would be switched off.
// The caller sends what it saw, and the position is only trusted if it still
// holds exactly that.
function findHookIndex(list, index, signature, what) {
  if (Array.isArray(list) && JSON.stringify(list[index]) === signature) return index;
  const found = Array.isArray(list) ? list.findIndex((e) => JSON.stringify(e) === signature) : -1;
  if (found === -1) {
    throw new Error(`That ${what} is not where the page said it was any more — reload the dashboard and try again.`);
  }
  return found;
}

export function toggleHook({ settingsPath, projectPath, event, index, enabled, signature }) {
  assertBoolean(enabled, 'enabled');
  assertString(event, 'event');
  assertString(signature, 'signature');
  if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');
  const real = assertEditable(settingsPath, projectPath);
  if (!real.endsWith('.json')) throw new Error('Hooks live in a settings file.');

  const parked = loadParked();
  const settings = loadForUpdate(real, { keepOriginal: true });
  const bucket = (parked.data.hooks[real] = parked.data.hooks[real] || {});

  if (enabled) {
    const list = bucket[event] || [];
    const unpacked = list.map((p) => unpackParkedHook(p));
    const at = findHookIndex(unpacked.map((u) => u.entry), index, signature, 'switched-off hook');
    const { entry, index: originalIndex } = unpacked[at];

    list.splice(at, 1);
    if (list.length === 0) delete bucket[event];

    settings.data.hooks = settings.data.hooks || {};
    const active = (settings.data.hooks[event] = settings.data.hooks[event] || []);
    // Two hooks in the same event can be written identically, so an entry that
    // looks like one already in the list is still a second real hook — put it
    // back regardless, in the slot it was switched off from.
    const target = originalIndex === null ? active.length : Math.min(originalIndex, active.length);
    active.splice(target, 0, entry);
  } else {
    const list = settings.data.hooks?.[event];
    const at = findHookIndex(list, index, signature, 'hook');
    const [entry] = list.splice(at, 1);
    if (list.length === 0) delete settings.data.hooks[event];
    if (Object.keys(settings.data.hooks).length === 0) delete settings.data.hooks;

    bucket[event] = bucket[event] || [];
    // remember where it was, so switching it back on restores the running order
    bucket[event].push({ [PARKED_SLOT_KEY]: at, entry });
  }

  if (Object.keys(bucket).length === 0) delete parked.data.hooks[real];

  const settingsWrite = { path: real, next: settings.data, meta: settings.meta, original: settings.original };
  const parkedWrite = { path: paths.PARKED_FILE, next: parked.data, meta: parked.meta, original: parked.original };
  // Whichever file the hook is joining goes first (see writePair).
  const [first, second] = enabled ? [settingsWrite, parkedWrite] : [parkedWrite, settingsWrite];
  const { firstBackup, secondBackup } = writePair(first, second);
  return { filePath: real, backupPath: enabled ? firstBackup : secondBackup };
}

// --- earlier versions -----------------------------------------------------

// Every write here already keeps a copy of what it replaced. Those copies are
// named after the file they came from, so the ones belonging to a file are
// found by building that name again — never by taking a name apart, which a
// path containing the separator would get wrong.
// A write goes to the file a link points at (see resolveWriteTarget), so the
// copy kept before it is named after that file. Look under the same name, or a
// settings file kept in a dotfiles repo shows no versions at all while its
// copies pile up under a name nothing asks about.
function backupSourcePath(real) {
  try {
    if (fs.lstatSync(real).isSymbolicLink()) return fs.realpathSync(real);
  } catch {
    /* not there, or a link pointing nowhere: its own name is all there is */
  }
  return real;
}

function backupPrefix(real) {
  return backupSourcePath(real).replace(/[\\/]/g, '__') + '.';
}

// Matching on the name's start alone was not enough — every copy of
// "settings.json.disabled" starts with the name of "settings.json", so a
// switched-off twin's versions were offered as the live file's own. What
// follows the name has to be the moment it was taken, and nothing else.
function isBackupOf(name, prefix) {
  const parsed = BACKUP_NAME.exec(name);
  return !!parsed && `${parsed[1]}.` === prefix;
}

// The stamp in the name is an ISO time with its colons and dot replaced.
function savedAtFromName(name, prefix) {
  const stamp = name.slice(prefix.length, -'.bak'.length);
  const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z');
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// An id is a file name inside the backup folder and nothing else, and only one
// that belongs to this file: no separators, and it must carry this file's own
// prefix, so no id can name a copy of some other file (or anything outside).
function backupPathFor(real, id) {
  assertString(id, 'id');
  const prefix = backupPrefix(real);
  if (/[\\/\0]/.test(id) || !isBackupOf(id, prefix)) {
    throw new Error('That is not a saved copy of this file.');
  }
  const full = path.join(BACKUP_DIR, id);
  if (!fs.existsSync(full)) throw new Error('That saved copy is not there any more — reload the list.');
  return full;
}

export function listBackups({ filePath, projectPath }) {
  const inv = buildInventory(projectPath);
  const real = assertViewable(filePath, projectPath, inv);
  const prefix = backupPrefix(real);
  let names;
  let restorable = true;
  try {
    assertEditable(real, projectPath, inv);
  } catch {
    restorable = false; // a plugin's file, or one this project may not write
  }
  try {
    names = fs.readdirSync(BACKUP_DIR);
  } catch {
    // nothing has been written yet
    return { filePath: real, restorable, versions: [], limits: { perFile: KEEP_PER_FILE, totalBytes: backupBudgetBytes() } };
  }
  const versions = names
    .filter((name) => isBackupOf(name, prefix))
    .map((name) => {
      let size = null;
      let copiedAtMs = null;
      try {
        const st = fs.statSync(path.join(BACKUP_DIR, name));
        size = st.size;
        copiedAtMs = st.mtimeMs;
      } catch {
        /* it went away between listing and asking about it */
      }
      return {
        id: name,
        savedAt: savedAtFromName(name, prefix) || (copiedAtMs ? new Date(copiedAtMs).toISOString() : null),
        savedAtMs: copiedAtMs,
        size,
      };
    })
    .sort((a, b) => String(b.id).localeCompare(String(a.id))); // newest first: the name carries the time
  return { filePath: real, restorable, versions, limits: { perFile: KEEP_PER_FILE, totalBytes: backupBudgetBytes() } };
}

export function readBackup({ filePath, projectPath, id }) {
  const real = assertViewable(filePath, projectPath);
  return { filePath: real, id, content: fs.readFileSync(backupPathFor(real, id), 'utf8') };
}

// Putting an earlier version back is an ordinary save of that version's text:
// same rule about which files may be written, same refusal if the file has
// changed since the editor read it, and the version being replaced is itself
// copied first — so this is never a one-way door.
export function restoreBackup({ filePath, projectPath, id, expectedMtimeMs }) {
  const real = assertViewable(filePath, projectPath);
  const content = fs.readFileSync(backupPathFor(real, id), 'utf8');
  return {
    ...writeEditableFile({ filePath: real, projectPath, content, expectedMtimeMs, followLink: true }),
    restoredFrom: id,
  };
}
