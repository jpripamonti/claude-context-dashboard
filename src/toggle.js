import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { paths, buildInventory, editablePathsFrom, viewablePathsFrom, unpackParkedHook, isPlainObject, describeJson, PARKED_SLOT_KEY, isOutsideImport } from './scan.js';

const BACKUP_DIR = path.join(os.homedir(), '.claude-context-dashboard', 'backups');

// A refusal: the request asked for something this will not do, or the file is
// no longer what the page saw. It carries the answer's status, so the page is
// told "no" (400) or "changed meanwhile" (409) rather than "the server broke"
// (500) — which is what anything else thrown still means.
class Refusal extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// The name of a copy: the file it came from, then the moment it was taken.
// One shape, used to find a file's copies, to check an id names one of them,
// and to decide which to remove — so those three can't drift apart. The `s`
// flag is for the older names (see legacyFlat), which could hold a line break.
const BACKUP_NAME = /^(.*)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/s;

// The file a copy came from is written into its name in a form that reads back
// to exactly one path: "%" and every character a file name cannot hold, or
// should not (separators, a drive's colon, line breaks), become %XX.
function encodeSource(p) {
  return p.replace(/[%\\/:*?"<>|\x00-\x1f\x7f]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

// A copy's full name — source, moment, ".bak" — is held to this many bytes.
// Most file systems stop at 255, and the encoded form is longer than the path
// it spells (every separator is three characters), so a deep path that saved
// fine under the older names failed every save once it was spelled this way.
const MAX_BACKUP_NAME_BYTES = 200;
const STAMP_SUFFIX_BYTES = '.2026-01-01T00-00-00-000Z.bak'.length;

// The part of a copy's name that says which file it is a copy of. A path too
// long to spell out in full is named by a hash of the whole path instead, with
// as much of the path's end (its folder and file name) as still fits, so it is
// still readable and still maps to exactly one file. "%-" cannot occur in a
// spelled-out name — encodeSource only ever writes "%" before two hex digits —
// so a hashed name never equals one spelled out in full.
function backupBase(p) {
  const full = encodeSource(p);
  if (Buffer.byteLength(full, 'utf8') + STAMP_SUFFIX_BYTES <= MAX_BACKUP_NAME_BYTES) return full;
  const head = `%-${crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 32)}-`;
  const room = MAX_BACKUP_NAME_BYTES - STAMP_SUFFIX_BYTES - head.length;
  let tail = '';
  let used = 0;
  const chars = [...p]; // whole characters, so a name never ends half way through one
  for (let i = chars.length - 1; i >= 0; i--) {
    const piece = encodeSource(chars[i]);
    const bytes = Buffer.byteLength(piece, 'utf8');
    if (used + bytes > room) break;
    tail = piece + tail;
    used += bytes;
  }
  return head + tail;
}

// The older names turned each separator into "__", which does not read back:
// /p/a/b/CLAUDE.md and /p/a__b/CLAUDE.md both became "__p__a__b__CLAUDE.md",
// so one file's versions were offered — and put back — as the other's. Those
// copies are still on disk, and are left under their old names: which file one
// came from cannot be known, only guessed from what exists now, and a guess
// made after the other file was deleted hands its history to the survivor for
// good. So they are shown, for a file whose old-style name is exactly theirs,
// as something to read and compare — marked as possibly another file's — and
// never put back (see listBackups). Pruning treats each old name as a file of
// its own, under the same rules.
function legacyFlat(p) {
  return p.replace(/[\\/]/g, '__');
}

// Nothing used to remove these, and every write copies the whole file: with a
// ~/.claude.json of several megabytes, a dozen clicks is a folder of a hundred.
// So it is kept to a size that can be stated plainly — at most this many copies
// of any one file, and this much in total, taken back from whichever file uses
// the most. The newest copy of a file is never removed: it is the one an undo
// needs.
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
  const cannotCopy = (err) =>
    new Error(
      `Could not keep a copy of ${filePath} before writing it (${err.code || err.message}), so nothing was written. Every write here is copied first; free some space or fix ${BACKUP_DIR}, then try again.`
    );
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw cannotCopy(err);
  }
  for (const dir of [path.dirname(BACKUP_DIR), BACKUP_DIR]) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* keep going: the backup itself still keeps the source file's own mode */
    }
  }
  const backupPath = nextBackupPath(backupBase(filePath));
  try {
    // never over another copy, even one that appeared since the name was chosen
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      try {
        fs.unlinkSync(backupPath); // half a copy is not a version
      } catch {
        /* never made */
      }
    }
    throw cannotCopy(err);
  }
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
  const kept = new Map(); // per file, newest first
  const used = new Map(); // per file, bytes still kept
  let total = 0;
  for (const [of_, copies] of byFile) {
    copies.sort((a, b) => b.stamp.localeCompare(a.stamp)); // newest first
    const keep = copies.slice(0, KEEP_PER_FILE);
    remove.push(...copies.slice(KEEP_PER_FILE));
    kept.set(of_, keep);
    const bytes = keep.reduce((sum, copy) => sum + copy.size, 0);
    used.set(of_, bytes);
    total += bytes;
  }

  // Over the total, space comes back from whichever file is using the most of
  // it, its oldest copy first. Taking the oldest copies across every file
  // instead let one big file — a ~/.claude.json of several megabytes — keep
  // twenty of its own while every other file's history went down to one.
  const budget = backupBudgetBytes();
  while (total > budget) {
    let biggest = null;
    for (const [of_, keep] of kept) {
      // a file down to one copy has nothing left to give: that one is the undo
      if (keep.length > 1 && (biggest === null || used.get(of_) > used.get(biggest))) biggest = of_;
    }
    if (biggest === null) break; // every file is down to its newest copy
    const copy = kept.get(biggest).pop(); // its oldest
    remove.push(copy);
    used.set(biggest, used.get(biggest) - copy.size);
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
    return { exists: true, mtimeMs: st.mtimeMs, mode: st.mode & 0o777, size: st.size, ino: st.ino };
  } catch {
    return { exists: false, mtimeMs: null, mode: null, size: null, ino: null };
  }
}

// Whether a file is still in the state `expected` describes. The page only
// knows the moment it saw; a snapshot taken here also knows the size and which
// file it was, and a write that lands within the same tick, or a file replaced
// by renaming another over it, shows in those even when the moment does not.
function sameState(now, expected) {
  if (now.exists !== expected.exists || now.mtimeMs !== expected.mtimeMs) return false;
  for (const key of ['size', 'ino']) {
    if (expected[key] !== undefined && now[key] !== expected[key]) return false;
  }
  return true;
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
      throw new Refusal(`${filePath} exists but is not valid JSON (${err.message}). Fix it by hand first.`);
    }
    // Valid JSON of the wrong shape (`null`, a list) would otherwise be written
    // into as if it were an object, which throws something unreadable.
    if (!isPlainObject(parsed)) {
      throw new Refusal(
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
    throw new Refusal(`${filePath} is a link and the file it points to is not there. Fix the link first.`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (path.extname(target).toLowerCase() !== ext) {
    throw new Refusal(
      `${filePath} is a link to ${target}, which is a different kind of file. Refusing to write over it — point the link at a ${ext || 'file of the same kind'} file, or edit ${target} directly.`
    );
  }
  return target;
}

// `text` is a string, or — when putting a kept copy back — the copy's own bytes.
function writeTextAtomic(pathAsListed, text, expectedMeta) {
  const filePath = resolveWriteTarget(pathAsListed);
  const changed = () =>
    new Refusal(
      `${filePath} changed on disk since it was read (likely a running Claude Code session) — reload the dashboard and try again.`,
      409
    );
  const currentMeta = statMeta(filePath);
  if (!sameState(currentMeta, expectedMeta)) throw changed();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backupPath = backupBeforeWrite(filePath);
  const tmp = filePath + '.tmp-' + process.pid;
  // Preserve the original file's permissions (e.g. ~/.claude.json is 600), and
  // create the temp file with them from the start: writing first and fixing the
  // mode afterwards would leave the contents — API keys included — briefly
  // readable by anyone else on the machine.
  const mode = currentMeta.exists ? currentMeta.mode : 0o600;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
    fs.chmodSync(tmp, mode); // writeFileSync's mode is subject to the umask
    // The check above and the copy are not one step. Something that writes the
    // file while the copy is being taken would be thrown away by the rename
    // below, and the copy kept would hold neither version. So the file has to
    // still be exactly the one that was checked and copied, right before it is
    // replaced; the window left after this is a few system calls wide.
    if (!sameState(statMeta(filePath), currentMeta)) throw changed();
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written, or already gone */
    }
    throw err;
  }
  return backupPath;
}

function writeJsonAtomic(filePath, data, expectedMeta) {
  return writeTextAtomic(filePath, JSON.stringify(data, null, 2) + '\n', expectedMeta);
}

function assertDirectory(p, label) {
  if (!p || typeof p !== 'string' || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new Refusal(`${label} is not a directory: ${p}`);
  }
}

function assertString(v, label) {
  if (typeof v !== 'string' || v.length === 0) throw new Refusal(`${label} must be a non-empty string`);
}

function assertBoolean(v, label) {
  if (typeof v !== 'boolean') throw new Refusal(`${label} must be a boolean`);
}

// The place a write puts something, made if it is not there yet. A key that is
// there but holds the wrong kind of value — a list where a set of entries
// belongs, text where a list belongs — used to be replaced by an empty one, so
// a click quietly threw away whatever it held. That is refused instead, and
// the file is left as it is for you to look at.
function wrongShape(key, where, value, wanted) {
  return new Refusal(
    `"${key}" in ${where} holds ${describeJson(value)}, not ${wanted}, so nothing was changed — writing here would throw away what it holds. Open the file and fix it first.`
  );
}

function objectAt(holder, key, where) {
  if (holder[key] === undefined || holder[key] === null) return (holder[key] = {});
  if (!isPlainObject(holder[key])) throw wrongShape(key, where, holder[key], 'a set of entries');
  return holder[key];
}

function listAt(holder, key, where) {
  if (holder[key] === undefined || holder[key] === null) return (holder[key] = []);
  if (!Array.isArray(holder[key])) throw wrongShape(key, where, holder[key], 'a list');
  return holder[key];
}

// A folder's real location, even when the file in it does not exist yet: the
// nearest part of the path that does exist is resolved, and the rest is put
// back on the end.
function realLocation(p) {
  const rest = [];
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...rest);
    } catch {
      const up = path.dirname(at);
      if (up === at) return path.resolve(p);
      rest.unshift(path.basename(at));
      at = up;
    }
  }
}

const isWithin = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// A file that is this project's by its name has to be this project's on disk
// as well. A repository can ship `.claude` as a link to ~/.claude, and then a
// switch that says "this project" lands in the settings every project reads —
// shown, with no warning, as a change to one project. Checking the file itself
// for a link misses that: the link is a folder further up. So a project file
// whose folder really lives in the global ~/.claude is refused, always.
//
// Anywhere else depends on what the file is. A skill or subagent folder linked
// in from somewhere else — a shared skills repo, a dotfiles checkout — is the
// ordinary way to share one, the page says on its row that a switch or a save
// changes the file where it really lives, and that is what happens: the same
// trade a settings file linked into a dotfiles repo makes (resolveWriteTarget).
// Every other project file — its settings, its instructions files — must also
// really be inside the project: those are what "this project" means, and a
// folder of a cloned repo linking out of it would let that repo pick the file.
//
// The file itself may still be a link (see resolveWriteTarget), except to a
// file in the global ~/.claude, which is the same trap one level down. That
// last part is only for writing into the file: renaming one (switching it
// off) renames the link itself and never touches what it points at.
const LINKABLE_DIRS = ['skills', 'agents'];

function assertStaysInProject(filePath, projectPath, { rename = false } = {}) {
  const listed = path.resolve(filePath);
  const root = path.resolve(projectPath);
  const dir = path.dirname(listed);
  const realRoot = realLocation(root);
  // Only a file that names itself a project file is checked: global files are
  // global by name, and the home folder viewed as a project holds ~/.claude.
  // The project may be named through a link of its own while the inventory's
  // paths are built from where it really is, so either spelling counts.
  if (!(isWithin(dir, root) || isWithin(dir, realRoot)) || isWithin(dir, paths.GLOBAL_CLAUDE_DIR)) return;
  const realGlobal = realLocation(paths.GLOBAL_CLAUDE_DIR);
  const realDir = realLocation(dir);
  const linkable = [root, realRoot].some((r) => LINKABLE_DIRS.some((d) => isWithin(dir, path.join(r, '.claude', d))));
  if (isWithin(realDir, realGlobal) || (!linkable && !isWithin(realDir, realRoot))) {
    const where = isWithin(realDir, realGlobal) ? `your global ${paths.GLOBAL_CLAUDE_DIR} folder, which every project reads` : `${realDir}, outside this project`;
    throw new Refusal(
      `${listed} is this project's by its name, but the folder it is in is a link to ${where}. Writing it would change that instead, so it was not written. Change it there directly if that is what you mean.`
    );
  }
  const realFile = realLocation(listed);
  if (!rename && isWithin(realFile, realGlobal)) {
    throw new Refusal(
      `${listed} is this project's by its name, but it is a link to ${realFile}, in your global ${paths.GLOBAL_CLAUDE_DIR} folder, which every project reads. Writing it would change that instead, so it was not written.`
    );
  }
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
  if (!fileName) throw new Refusal(`unknown settings scope: ${scope}`);
  if (scope.startsWith('global')) return path.join(paths.GLOBAL_CLAUDE_DIR, fileName);
  assertDirectory(projectPath, 'projectPath');
  const filePath = path.join(projectPath, '.claude', fileName);
  assertStaysInProject(filePath, projectPath);
  return filePath;
}

export function togglePlugin({ projectPath, key, enabled, scope = 'project' }) {
  assertString(key, 'key');
  assertBoolean(enabled, 'enabled');
  // Switching is only offered for the two shared files; the personal "local"
  // ones can have a leftover entry removed, but the dashboard does not put
  // new decisions there.
  if (scope !== 'global' && scope !== 'project') throw new Refusal('a plugin can only be switched globally or for this project');

  const filePath = pluginSettingsPath(scope, projectPath);
  const { data, meta } = loadForUpdate(filePath);
  objectAt(data, 'enabledPlugins', filePath)[key] = enabled;
  const backupPath = writeJsonAtomic(filePath, data, meta);
  return { filePath, backupPath };
}

// Removes a project's own decision about a plugin, so it goes back to
// following whatever the global default says.
export function clearPluginOverride({ projectPath, key, scope = 'project' }) {
  assertString(key, 'key');

  const filePath = pluginSettingsPath(scope, projectPath);
  const { data, meta } = loadForUpdate(filePath);
  if (data.enabledPlugins !== undefined && !isPlainObject(data.enabledPlugins)) {
    throw wrongShape('enabledPlugins', filePath, data.enabledPlugins, 'a set of entries');
  }
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
    if (data[key] === undefined) continue;
    data[key] = listAt(data, key, real).filter((n) => n !== name);
    if (data[key].length === 0) delete data[key];
  }
  listAt(data, enabled ? 'enabledMcpjsonServers' : 'disabledMcpjsonServers', real).push(name);
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
      throw new Refusal(
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
    const entry = projectRecord(data, resolvedProjectPath);
    const where = recordName(resolvedProjectPath);
    entry.enabledMcpjsonServers = listAt(entry, 'enabledMcpjsonServers', where).filter((n) => n !== name);
    entry.disabledMcpjsonServers = listAt(entry, 'disabledMcpjsonServers', where).filter((n) => n !== name);
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

// This project's own record in ~/.claude.json, made if it is not there yet.
function projectRecord(data, resolvedProjectPath) {
  return objectAt(objectAt(data, 'projects', paths.GLOBAL_CLAUDE_JSON), resolvedProjectPath, `the "projects" list in ${paths.GLOBAL_CLAUDE_JSON}`);
}

function recordName(resolvedProjectPath) {
  return `the record for ${resolvedProjectPath} in ${paths.GLOBAL_CLAUDE_JSON}`;
}

// Switching a server off parks its definition under a shadow key instead of
// deleting it. If it is then set up again by another route under the same name
// — `claude mcp add`, or an edit by hand — there are two real definitions, and
// switching either way would overwrite one of them with the other. Which one is
// wanted is not something this can work out, so it refuses and the dashboard
// shows both with a choice (see resolveMcpDuplicate).
function assertNoDuplicate(active, parked, name) {
  if (active?.[name] && parked?.[name]) {
    throw new Refusal(
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
  const entry = projectRecord(data, resolvedProjectPath);
  objectAt(entry, 'mcpServers', recordName(resolvedProjectPath));
  objectAt(entry, 'disabledLocalMcpServers', recordName(resolvedProjectPath));
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
  objectAt(data, 'mcpServers', paths.GLOBAL_CLAUDE_JSON);
  objectAt(data, 'disabledUserMcpServers', paths.GLOBAL_CLAUDE_JSON);
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
  if (scope !== 'user' && scope !== 'local') throw new Refusal('scope must be "user" or "local"');
  if (keep !== 'current' && keep !== 'saved') throw new Refusal('keep must be "current" or "saved"');

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
    throw new Refusal(`"${name}" does not have two definitions any more — reload the dashboard.`, 409);
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
    throw new Refusal('Refusing to toggle a file outside known skill/agent directories.');
  }
  if (real.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) {
    throw new Refusal('This file belongs to a plugin. Toggle the plugin instead.');
  }
  // a project's skills folder that is really the global one renames there
  if (allowedDirs.length > 2) assertStaysInProject(real, projectPath, { rename: true });
  assertMarkdown(real);

  return renameToggle(real, enabled);
}

function assertMarkdown(real) {
  if (!/\.md(\.disabled)?$/.test(real)) {
    throw new Refusal('Only markdown files can be switched off this way.');
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
    throw new Refusal(
      `There is both a live file and a switched-off copy here: ${enabledPath} and ${disabledPath}. Delete or rename one of them by hand, then try again.`
    );
  }

  if (enabled) {
    if (fs.existsSync(enabledPath)) return { filePath: enabledPath, note: 'already enabled' };
    if (!fs.existsSync(disabledPath)) throw new Refusal('Nothing to enable — neither file exists.');
    fs.renameSync(disabledPath, enabledPath);
    return { filePath: enabledPath };
  } else {
    if (!fs.existsSync(enabledPath)) {
      if (fs.existsSync(disabledPath)) return { filePath: disabledPath, note: 'already disabled' };
      throw new Refusal('Nothing to switch off — the file is not there.');
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
function assertEditable(filePath, projectPath, inv = null, { rename = false } = {}) {
  assertString(filePath, 'filePath');
  assertDirectory(projectPath, 'projectPath');
  const resolved = path.resolve(filePath);
  if (resolved.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) {
    throw new Refusal('This file belongs to a plugin, so it can be read but not changed here — the next plugin update would overwrite anything you wrote.');
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
      throw new Refusal('Nothing loads this file — an instructions file only points at it, so it is shown here to be read, not changed. Edit it where you edit the rest of the project.');
    }
    // and the same for text that does load, but from somewhere that is not
    // this project's or the global .claude folder's to change
    if (isOutsideImport(inventory, resolved)) {
      throw new Refusal('An @ line pulls this file in from outside this project and the global .claude folder, so it is shown here to be read, not changed — whoever wrote that @ line chose the file. Edit it where you normally would.');
    }
    throw new Refusal('Refusing to touch a file this dashboard is not showing for this project.');
  }
  assertStaysInProject(resolved, projectPath, { rename });
  return resolved;
}

// Reading is allowed for everything the dashboard lists; writing is narrower,
// so the answer says which of the two this file is.
function assertViewable(filePath, projectPath, inv = null) {
  assertString(filePath, 'filePath');
  assertDirectory(projectPath, 'projectPath');
  const real = path.resolve(filePath);
  if (!viewablePathsFrom(inv || buildInventory(projectPath)).has(real)) {
    throw new Refusal('Refusing to touch a file this dashboard is not showing for this project.');
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
export function writeEditableFile({ filePath, projectPath, content, expectedMtimeMs }) {
  return saveEditable({ filePath, projectPath, content, expectedMtimeMs, followLink: false });
}

// `content` is typed text (a string) or, for putting a version back, the bytes
// of the copy (a Buffer), which are written exactly as they were kept.
function saveEditable({ filePath, projectPath, content, expectedMtimeMs, followLink }) {
  const real = assertEditable(filePath, projectPath);
  if (typeof content !== 'string' && !(followLink && Buffer.isBuffer(content))) {
    throw new Refusal('content must be a string');
  }
  try {
    if (!followLink && fs.lstatSync(real).isSymbolicLink()) {
      throw new Refusal(
        `${real} is a link to another file. Saving here would replace the link itself, so edit the file it points to instead.`
      );
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // a file that doesn't exist yet is fine
  }
  if (real.endsWith('.json')) {
    let parsed;
    try {
      // decoded only to check it: what is written is `content` itself
      parsed = JSON.parse(typeof content === 'string' ? content : content.toString('utf8'));
    } catch (err) {
      throw new Refusal(`Not valid JSON, so it was not saved: ${err.message}`);
    }
    // Valid JSON that is not an object parses fine and then breaks every reader
    // of the file, Claude Code's included — so it cannot be saved from here.
    if (!isPlainObject(parsed)) {
      throw new Refusal(`This file has to hold a JSON object; that is ${describeJson(parsed)}. Not saved.`);
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
  const real = assertEditable(filePath, projectPath, null, { rename: true });
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
  if (to !== 'project' && to !== 'global') throw new Refusal('to must be "project" or "global"');
  assertDirectory(projectPath, 'projectPath');

  const resolvedProjectPath = fs.realpathSync(path.resolve(projectPath));
  const { data, meta } = loadForUpdate(paths.GLOBAL_CLAUDE_JSON);
  const entry = projectRecord(data, resolvedProjectPath);
  const here = recordName(resolvedProjectPath);

  const global = {
    active: objectAt(data, 'mcpServers', paths.GLOBAL_CLAUDE_JSON),
    parked: objectAt(data, 'disabledUserMcpServers', paths.GLOBAL_CLAUDE_JSON),
  };
  const local = { active: objectAt(entry, 'mcpServers', here), parked: objectAt(entry, 'disabledLocalMcpServers', here) };
  const [from, dest] = to === 'project' ? [global, local] : [local, global];

  assertNoDuplicate(from.active, from.parked, name);
  const config = from.active[name] ?? from.parked[name];
  if (config === undefined) throw new Refusal(`There is no connection called "${name}" to move — reload the dashboard.`, 409);
  if (dest.active[name] !== undefined || dest.parked[name] !== undefined) {
    throw new Refusal(`There is already a connection called "${name}" where you are moving it to. Rename or remove that one first.`);
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
  if (!PERMISSION_GROUPS.has(group)) throw new Refusal('group must be allow, deny or ask');
  if (action !== 'add' && action !== 'remove') throw new Refusal('action must be add or remove');
  const real = assertEditable(filePath, projectPath);
  if (!real.endsWith('.json')) throw new Refusal('Permission rules live in a settings file.');

  const { data, meta } = loadForUpdate(real);
  const permissions = objectAt(data, 'permissions', real);
  if (permissions[group] !== undefined && !Array.isArray(permissions[group])) {
    throw wrongShape(`permissions.${group}`, real, permissions[group], 'a list of rules');
  }
  const list = permissions[group] || [];

  if (action === 'add') {
    if (list.includes(rule)) return { filePath: real, note: 'that rule is already there' };
    list.push(rule);
  } else {
    const at = list.indexOf(rule);
    if (at === -1) throw new Refusal('That rule is not there any more — reload the dashboard.', 409);
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
    throw new Refusal(`That ${what} is not where the page said it was any more — reload the dashboard and try again.`, 409);
  }
  return found;
}

export function toggleHook({ settingsPath, projectPath, event, index, enabled, signature }) {
  assertBoolean(enabled, 'enabled');
  assertString(event, 'event');
  assertString(signature, 'signature');
  if (!Number.isInteger(index) || index < 0) throw new Refusal('index must be a non-negative integer');
  const real = assertEditable(settingsPath, projectPath);
  if (!real.endsWith('.json')) throw new Refusal('Hooks live in a settings file.');

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

    const active = listAt(objectAt(settings.data, 'hooks', real), event, `the hooks in ${real}`);
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
  return backupBase(backupSourcePath(real)) + '.';
}

// The name this file's copies had before names changed (see legacyFlat).
function legacyPrefix(real) {
  return legacyFlat(backupSourcePath(real)) + '.';
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
function savedAtFromName(name) {
  const parsed = BACKUP_NAME.exec(name);
  const at = parsed ? stampToMs(parsed[2]) : null;
  return at === null ? null : new Date(at).toISOString();
}

// An id is a file name inside the backup folder and nothing else, and only one
// that belongs to this file: no separators, and it must carry this file's own
// prefix, so no id can name a copy of some other file (or anything outside).
// A copy under the old kind of name may be another file's (see legacyFlat), so
// it can be read to compare — `legacyOk` — but never put back.
function backupPathFor(real, id, { legacyOk = false } = {}) {
  assertString(id, 'id');
  const mine = isBackupOf(id, backupPrefix(real));
  const legacy = !mine && isBackupOf(id, legacyPrefix(real));
  if (/[\\/\0]/.test(id) || !(mine || (legacy && legacyOk))) {
    throw new Refusal(
      legacy
        ? 'That copy was taken before backup names changed, and may belong to another file with a similar path, so it can be compared but not put back. Copy any part of it you need by hand.'
        : 'That is not a saved copy of this file.'
    );
  }
  const full = path.join(BACKUP_DIR, id);
  if (!fs.existsSync(full)) throw new Refusal('That saved copy is not there any more — reload the list.', 409);
  return full;
}

const LEGACY_NOTE = 'Taken before backup names changed; it may belong to another file with a similar path, so it can be compared but not put back.';

export function listBackups({ filePath, projectPath }) {
  const inv = buildInventory(projectPath);
  const real = assertViewable(filePath, projectPath, inv);
  const prefix = backupPrefix(real);
  const oldPrefix = legacyPrefix(real);
  let names;
  let restorable = true;
  try {
    assertEditable(real, projectPath, inv);
  } catch {
    restorable = false; // a plugin's file, or one this project may not write
  }
  const limits = { perFile: KEEP_PER_FILE, totalBytes: backupBudgetBytes() };
  try {
    names = fs.readdirSync(BACKUP_DIR);
  } catch {
    // nothing has been written yet
    return { filePath: real, restorable, versions: [], limits };
  }
  const versions = [];
  for (const name of names) {
    const legacy = !isBackupOf(name, prefix);
    if (legacy && !isBackupOf(name, oldPrefix)) continue;
    let size = null;
    let copiedAtMs = null;
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      size = st.size;
      copiedAtMs = st.mtimeMs;
    } catch {
      /* it went away between listing and asking about it */
    }
    versions.push({
      id: name,
      savedAt: savedAtFromName(name) || (copiedAtMs ? new Date(copiedAtMs).toISOString() : null),
      savedAtMs: copiedAtMs,
      size,
      // per version: the file can be restorable while this copy of it is not
      restorable: restorable && !legacy,
      ...(legacy ? { legacy: true, note: LEGACY_NOTE } : {}),
    });
  }
  // newest first, by the moment in the name: the two kinds of name sort apart
  // as text, so comparing whole ids would put every old one after the new ones
  const stamp = (v) => BACKUP_NAME.exec(v.id)[2];
  versions.sort((a, b) => stamp(b).localeCompare(stamp(a)) || String(b.id).localeCompare(String(a.id)));
  return { filePath: real, restorable, versions, limits };
}

export function readBackup({ filePath, projectPath, id }) {
  const real = assertViewable(filePath, projectPath);
  return { filePath: real, id, content: fs.readFileSync(backupPathFor(real, id, { legacyOk: true }), 'utf8') };
}

// Putting an earlier version back is an ordinary save of that version's text:
// same rule about which files may be written, same refusal if the file has
// changed since the editor read it, and the version being replaced is itself
// copied first — so this is never a one-way door.
// The copy goes back byte for byte. Reading it as text first turned anything
// that is not UTF-8 — a file saved as Latin-1, say — into replacement
// characters, so putting a version back did not put it back.
export function restoreBackup({ filePath, projectPath, id, expectedMtimeMs }) {
  const real = assertViewable(filePath, projectPath);
  const content = fs.readFileSync(backupPathFor(real, id));
  return {
    ...saveEditable({ filePath: real, projectPath, content, expectedMtimeMs, followLink: true }),
    restoredFrom: id,
  };
}
