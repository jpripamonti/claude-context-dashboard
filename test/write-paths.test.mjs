// Every path that writes, against a throwaway HOME — the real ~/.claude,
// ~/.claude.json and ~/.claude-context-dashboard are never touched. File paths
// are taken from the inventory, exactly as the dashboard's own page does.
//
// Run with:  npm test
//
// Most checks here exist because something was once wrong: three rounds of
// adversarial review found real defects in this project's write paths, and each
// one left a check behind. Add to it rather than trimming it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-test-')));
const HOME = path.join(SANDBOX, 'home');
const PROJECT = path.join(SANDBOX, 'proj');
process.env.HOME = HOME;

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const hook = (n) => ({ matcher: n, hooks: [{ type: 'command', command: `echo ${n}` }] });

w(path.join(HOME, '.claude', 'CLAUDE.md'), '# global rules\nbe nice\n');
w(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({
  enabledPlugins: { 'demo@market': true },
  hooks: { PreToolUse: [hook('A'), hook('B'), hook('C')] },
}, null, 2));
w(path.join(HOME, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: tidies\n---\nbody\n');
w(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }, null, 2));
fs.chmodSync(path.join(HOME, '.claude.json'), 0o600);
w(path.join(HOME, '.zshrc'), 'ORIGINAL SHELL CONFIG\n');
w(path.join(PROJECT, 'CLAUDE.md'), '# project rules\n');
w(path.join(PROJECT, '.claude', 'settings.json'), JSON.stringify({}, null, 2));

// imported after HOME is redirected above, so the modules read the fake home
const serverModule = await import('../src/server.js');
const { startServer } = serverModule;
const toggle = await import('../src/toggle.js');

// Ask the machine for a free port first — the server needs to know its own
// port up front, since that is what it checks incoming requests against — so a
// dashboard left running does not break the suite.
const net = await import('node:net');
const PORT = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
// The restart is handed to the server rather than performed by it, so this
// suite can watch the endpoint without restarting the test run.
// Started the way the command line starts it, so the address it listens on is
// the one users get.
let restartsAsked = 0;
let restartHandedToken = null;
const started = await startServer({
  projectPath: PROJECT,
  port: PORT,
  onRestart: (_server, handed = {}) => { restartsAsked++; restartHandedToken = handed.token; },
});
const { server, token: TOKEN } = started;

const BASE = `http://127.0.0.1:${PORT}`;
// every API request needs this launch's key; the checks that leave it out say so
const T = { 'X-Dashboard-Token': TOKEN };
const H = { 'Content-Type': 'application/json', Origin: BASE, Host: `127.0.0.1:${PORT}`, ...T };
const post = async (p, body) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (p) => {
  const res = await fetch(BASE + p, { headers: { Origin: BASE, ...T } });
  return { status: res.status, body: await res.json() };
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const inventory = async (p = PROJECT) => (await get(`/api/inventory?path=${encodeURIComponent(p)}`)).body;
const parkedFile = path.join(HOME, '.claude-context-dashboard', 'parked.json');

let failures = 0;
function spawnSyncOk(cmd, args) {
  try {
    return childProcess.spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
let checksRun = 0;
const check = (label, cond, detail) => {
  checksRun++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `  → ${detail ?? ''}`}`);
  if (!cond) failures++;
};

let refused = null;
const GLOBAL_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const PROJECT_SETTINGS = path.join(PROJECT, '.claude', 'settings.json');
const matchers = () => (readJson(GLOBAL_SETTINGS).hooks?.PreToolUse || []).map((e) => e.matcher).join(',');

// --- inventory --------------------------------------------------------
let inv = await inventory();
check('settings shows all four layers', inv.settingsLayers.length === 4, inv.settingsLayers.length);
check('missing layers flagged', inv.settingsLayers.filter((l) => !l.exists).length === 2);
check('three hooks listed individually', inv.hooks.length === 3, inv.hooks.length);

// --- plugins ----------------------------------------------------------
await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'demo@market', enabled: false, scope: 'project' });
check('project override written to project settings', readJson(PROJECT_SETTINGS).enabledPlugins?.['demo@market'] === false);
check('global untouched by project toggle', readJson(GLOBAL_SETTINGS).enabledPlugins['demo@market'] === true);

inv = await inventory();
check('missing plugin reports per-layer state',
  inv.missingPlugins[0]?.states.global === true && inv.missingPlugins[0]?.states.project === false,
  JSON.stringify(inv.missingPlugins));

await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'demo@market', clear: true, scope: 'project' });
check('clearing the override removes the key entirely', readJson(PROJECT_SETTINGS).enabledPlugins === undefined);

await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'demo@market', clear: true, scope: 'global' });
check('a leftover global entry can be removed', readJson(GLOBAL_SETTINGS).enabledPlugins === undefined,
  JSON.stringify(readJson(GLOBAL_SETTINGS).enabledPlugins));

// a leftover entry in a personal settings file can be removed too
const projectLocal = path.join(PROJECT, '.claude', 'settings.local.json');
w(projectLocal, JSON.stringify({ enabledPlugins: { 'ghost@market': false }, model: 'opus' }, null, 2));
inv = await inventory();
check('an entry in a personal settings file is attributed to it',
  inv.missingPlugins.find((m) => m.key === 'ghost@market')?.states['project-local'] === false,
  JSON.stringify(inv.missingPlugins));
await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'ghost@market', clear: true, scope: 'project-local' });
check('and it can be removed from there without touching the rest of the file',
  readJson(projectLocal).enabledPlugins === undefined && readJson(projectLocal).model === 'opus',
  JSON.stringify(readJson(projectLocal)));
const badScope = await post('/api/toggle/plugin', {
  projectPath: PROJECT, key: 'x@y', enabled: true, scope: 'project-local',
});
check('but a switch cannot write a personal settings file',
  badScope.status !== 200 && /only be switched/.test(badScope.body.error || ''), JSON.stringify(badScope.body));
fs.unlinkSync(projectLocal);

// --- instructions files ----------------------------------------------
inv = await inventory();
let projectMd = inv.claudeMd.files.find((f) => f.label === 'project').path;
await post('/api/toggle/markdown', { projectPath: PROJECT, filePath: projectMd, enabled: false });
check('CLAUDE.md renamed away', !fs.existsSync(projectMd) && fs.existsSync(projectMd + '.disabled'));
inv = await inventory();
const off = inv.claudeMd.files.find((f) => f.path.endsWith('CLAUDE.md.disabled'));
check('switched-off instructions file still listed', !!off && off.disabled === true);
await post('/api/toggle/markdown', { projectPath: PROJECT, filePath: off.path, enabled: true });
check('CLAUDE.md restored', fs.existsSync(projectMd));

// D4: a live file and a switched-off copy at once must not report success
w(projectMd + '.disabled', 'stale copy\n');
const twin = await post('/api/toggle/markdown', { projectPath: PROJECT, filePath: projectMd, enabled: false });
check('ambiguous twin refused instead of falsely reporting success',
  twin.status !== 200 && /both a live file and a switched-off copy/.test(twin.body.error || '') && fs.existsSync(projectMd),
  JSON.stringify(twin.body));
inv = await inventory();
check('the twin is surfaced in the inventory',
  inv.claudeMd.files.find((f) => f.label === 'project')?.hasTwin === true);
fs.unlinkSync(projectMd + '.disabled');

// --- editing ----------------------------------------------------------
let file = (await get(`/api/file?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`)).body;
check('read back returns content', file.content === '# project rules\n', JSON.stringify(file.content));

let save = await post('/api/file/save', {
  filePath: projectMd, projectPath: PROJECT, content: '# edited\n', expectedMtimeMs: file.mtimeMs,
});
check('save wrote the new content', save.status === 200 && fs.readFileSync(projectMd, 'utf8') === '# edited\n');
check('save kept a backup', !!save.body.backupPath && fs.existsSync(save.body.backupPath));

save = await post('/api/file/save', {
  filePath: projectMd, projectPath: PROJECT, content: 'stale write\n', expectedMtimeMs: file.mtimeMs,
});
check('stale save refused', save.status !== 200 && /changed on disk/.test(save.body.error || ''));

const badJson = await post('/api/file/save', {
  filePath: PROJECT_SETTINGS, projectPath: PROJECT, content: '{ nope', expectedMtimeMs: fs.statSync(PROJECT_SETTINGS).mtimeMs,
});
check('invalid JSON refused', /not valid JSON/i.test(badJson.body.error || ''));

const localLayer = path.join(PROJECT, '.claude', 'settings.local.json');
const created = await post('/api/file/save', {
  filePath: localLayer, projectPath: PROJECT, content: '{"model":"opus"}\n', expectedMtimeMs: null,
});
check('missing settings layer can be created', created.status === 200 && readJson(localLayer).model === 'opus');
fs.unlinkSync(localLayer);

// --- S1: a symlink among the listed files must not become a way out ----
const ZSHRC = path.join(HOME, '.zshrc');
fs.unlinkSync(projectMd);
fs.symlinkSync(ZSHRC, projectMd); // project CLAUDE.md now points at ~/.zshrc
inv = await inventory();
check('the symlink is reported as one', !!inv.claudeMd.files.find((f) => f.label === 'project')?.realPath);

const escapeWrite = await post('/api/file/save', {
  filePath: ZSHRC, projectPath: PROJECT, content: 'PWNED\n', expectedMtimeMs: fs.statSync(ZSHRC).mtimeMs,
});
check('naming a symlink target directly is refused',
  escapeWrite.status !== 200 && fs.readFileSync(ZSHRC, 'utf8') === 'ORIGINAL SHELL CONFIG\n',
  JSON.stringify(escapeWrite.body));

const escapeRead = await get(`/api/file?path=${encodeURIComponent(ZSHRC)}&project=${encodeURIComponent(PROJECT)}`);
check('reading a symlink target directly is refused', escapeRead.status !== 200, JSON.stringify(escapeRead.body));

const throughLink = await post('/api/file/save', {
  filePath: projectMd, projectPath: PROJECT, content: 'PWNED\n', expectedMtimeMs: fs.statSync(projectMd).mtimeMs,
});
check('saving over a symlink is refused rather than replacing the link',
  throughLink.status !== 200 && /link to another file/.test(throughLink.body.error || '') &&
  fs.readFileSync(ZSHRC, 'utf8') === 'ORIGINAL SHELL CONFIG\n' && fs.lstatSync(projectMd).isSymbolicLink(),
  JSON.stringify(throughLink.body));
fs.unlinkSync(projectMd);
w(projectMd, '# project rules\n');

const outside = await post('/api/file/save', {
  filePath: path.join(HOME, 'nothing-to-see'), projectPath: PROJECT, content: 'x', expectedMtimeMs: null,
});
check('file outside the dashboard refused', /not showing/.test(outside.body.error || ''));

// --- permissions ------------------------------------------------------
const modeBefore = fs.statSync(path.join(HOME, '.claude.json')).mode & 0o777;
await post('/api/toggle/mcp-user', { name: 'nothing', enabled: false });
check('~/.claude.json permissions preserved',
  (fs.statSync(path.join(HOME, '.claude.json')).mode & 0o777) === modeBefore);

// S3: the temp file must never exist with wider permissions than the target
const realWrite = fs.writeFileSync;
let widest = 0;
fs.writeFileSync = (p, d, opts) => {
  const r = realWrite(p, d, opts);
  if (String(p).includes('.claude.json.tmp-')) widest = fs.statSync(p).mode & 0o777;
  return r;
};
await post('/api/toggle/mcp-user', { name: 'nothing2', enabled: false });
fs.writeFileSync = realWrite;
check('temp file is never world-readable', widest === 0o600, widest.toString(8));

// --- hooks ------------------------------------------------------------
inv = await inventory();
const hookRow = (matcher, enabled) => inv.hooks.find((h) => h.matcher === matcher && h.enabled === enabled);
const toggleHookRow = (h, enabled) => post('/api/toggle/hook', {
  projectPath: PROJECT, settingsPath: h.source, event: h.event,
  index: Number(h.id.split(':')[1]), signature: h.signature, enabled,
});

const rowA = hookRow('A', true);
let res = await toggleHookRow(rowA, false);
check('hook removed from settings', res.status === 200 && matchers() === 'B,C', matchers());
check('settings file gains no unknown keys', !('disabledHooks' in readJson(GLOBAL_SETTINGS)));
check('parked in the dashboard\'s own file', readJson(parkedFile).hooks[GLOBAL_SETTINGS].PreToolUse.length === 1);

// D1: a second click from the SAME page render must not hit the wrong hook
const rowB = hookRow('B', true); // index 1 as the page saw it; B is now at index 0
res = await toggleHookRow(rowB, false);
check('a stale position still switches off the hook that was clicked',
  res.status === 200 && matchers() === 'C', matchers());

// a position whose hook is gone entirely is refused rather than guessed
res = await post('/api/toggle/hook', {
  projectPath: PROJECT, settingsPath: GLOBAL_SETTINGS, event: 'PreToolUse',
  index: 0, signature: JSON.stringify(hook('GONE')), enabled: false,
});
check('a hook that is no longer there is refused',
  res.status !== 200 && /not where the page said/.test(res.body.error || ''), JSON.stringify(res.body));

// D3: switching back on restores the original position
inv = await inventory();
res = await toggleHookRow(hookRow('A', false), true);
check('restored to its original position', matchers() === 'A,C', matchers());
inv = await inventory();
res = await toggleHookRow(hookRow('B', false), true);
// each hook returns to the slot it occupied when it was switched off, so
// switching several off and back on in a different order can reshuffle them
check('every hook is back', matchers().split(',').sort().join(',') === 'A,B,C', matchers());
check('parked list emptied out', Object.keys(readJson(parkedFile).hooks).length === 0);
const restoredA = readJson(GLOBAL_SETTINGS).hooks.PreToolUse.find((e) => e.matcher === 'A');
check('hook definition survived the round trip', restoredA?.hooks[0].command === 'echo A', JSON.stringify(restoredA));

// An entry that looks identical to an active one is still treated as a second
// real hook and restored: two hooks in the same event can legitimately be
// written the same way, and dropping one would destroy it. Keeping both is
// visible and undoable; losing one is neither.
w(parkedFile, JSON.stringify({ hooks: { [GLOBAL_SETTINGS]: { PreToolUse: [{ __dashboardSlot: 0, entry: hook("A") }] } } }, null, 2));
inv = await inventory();
res = await toggleHookRow(hookRow('A', false), true);
check('a look-alike hook is restored rather than dropped',
  matchers().split(',').filter((m) => m === 'A').length === 2, matchers());
check('the parked copy is cleared', Object.keys(readJson(parkedFile).hooks).length === 0);

// --- two identical hooks: both must survive a round trip --------------
w(GLOBAL_SETTINGS, JSON.stringify({ hooks: { PreToolUse: [hook('D'), hook('D'), hook('E')] } }, null, 2));
fs.rmSync(parkedFile, { force: true });
inv = await inventory();
const dupRows = inv.hooks.filter((h) => h.matcher === 'D');
check('both identical hooks are listed', dupRows.length === 2, JSON.stringify(inv.hooks.map((h) => h.matcher)));
await toggleHookRow(dupRows[1], false);
inv = await inventory();
await toggleHookRow(inv.hooks.find((h) => h.matcher === 'D' && h.enabled), false);
check('both identical hooks were parked, none lost',
  readJson(parkedFile).hooks[GLOBAL_SETTINGS].PreToolUse.length === 2 && matchers() === 'E',
  `${matchers()} | parked ${JSON.stringify(readJson(parkedFile).hooks[GLOBAL_SETTINGS])}`);
inv = await inventory();
for (const row of inv.hooks.filter((h) => h.matcher === 'D')) {
  const fresh = (await inventory()).hooks.find((h) => h.matcher === 'D' && !h.enabled);
  if (fresh) await toggleHookRow(fresh, true);
  void row;
}
check('both come back', matchers().split(',').sort().join(',') === 'D,D,E', matchers());

// --- a failed second write is rolled back, not left half-done ---------
w(GLOBAL_SETTINGS, JSON.stringify({ hooks: { PreToolUse: [hook('F'), hook('G')] } }, null, 2));
fs.rmSync(parkedFile, { force: true });
inv = await inventory();
const realRename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to) === parkedFile) throw Object.assign(new Error('forced failure'), { code: 'EIO' });
  return realRename(from, to);
};
res = await toggleHookRow(inv.hooks.find((h) => h.matcher === 'F'), false);
fs.renameSync = realRename;
check('a failed pair write is reported, not silently half-applied', res.status !== 200, JSON.stringify(res.body));
check('the hook is still active after the rollback', matchers() === 'F,G', matchers());

// --- backups are not readable by other users --------------------------
const dashDir = path.join(HOME, '.claude-context-dashboard');
check('the dashboard\'s own folders are private',
  (fs.statSync(dashDir).mode & 0o777) === 0o700 &&
  (fs.statSync(path.join(dashDir, 'backups')).mode & 0o777) === 0o700,
  `${(fs.statSync(dashDir).mode & 0o777).toString(8)} / ${(fs.statSync(path.join(dashDir, 'backups')).mode & 0o777).toString(8)}`);

// --- a project whose .claude folder is a link to the global one -------
const TRAP = path.join(SANDBOX, 'cloned');
fs.mkdirSync(TRAP, { recursive: true });
fs.symlinkSync(path.join(HOME, '.claude'), path.join(TRAP, '.claude'));
const trapInv = await inventory(TRAP);
const trapProjectLayer = trapInv.settingsLayers.find((l) => l.label === 'project');
check('a settings folder that is a link to the global one is not offered as "this project"',
  !trapProjectLayer, JSON.stringify(trapInv.settingsLayers.map((l) => [l.label, l.path])));
check('the global settings file is still listed once',
  trapInv.settingsLayers.filter((l) => l.path === GLOBAL_SETTINGS).length === 1);

// --- a settings file that does not exist yet, behind a linked folder ---
const TRAP2 = path.join(SANDBOX, 'cloned2');
fs.mkdirSync(TRAP2, { recursive: true });
fs.symlinkSync(path.join(HOME, '.claude'), path.join(TRAP2, '.claude'));
const globalLocal = path.join(HOME, '.claude', 'settings.local.json');
fs.rmSync(globalLocal, { force: true });
const trap2 = await inventory(TRAP2);
check('a not-yet-created settings file behind a linked folder is not offered as the project\'s own',
  !trap2.settingsLayers.find((l) => l.label === 'project-local'),
  JSON.stringify(trap2.settingsLayers.map((l) => [l.label, l.exists])));
const trapCreate = await post('/api/file/save', {
  filePath: path.join(TRAP2, '.claude', 'settings.local.json'), projectPath: TRAP2,
  content: '{"model":"opus"}\n', expectedMtimeMs: null,
});
check('and it cannot be created through that project either',
  trapCreate.status !== 200 && !fs.existsSync(globalLocal), JSON.stringify(trapCreate.body));

// --- a home CLAUDE.md that is a link to a project's own file ----------
const DOTFILES = path.join(HOME, 'work', 'dotproj'); // inside HOME, so the walk passes through it
w(path.join(DOTFILES, 'CLAUDE.md'), '# the real one\n');
fs.symlinkSync(path.join(DOTFILES, 'CLAUDE.md'), path.join(HOME, 'CLAUDE.md'));
const dotInv = await inventory(DOTFILES);
const ownRow = dotInv.claudeMd.files.find((f) => f.label === 'project');
check('the project keeps its own instructions file when a link elsewhere points at it',
  !!ownRow && ownRow.path === path.join(DOTFILES, 'CLAUDE.md'),
  JSON.stringify(dotInv.claudeMd.files.map((f) => [f.label, f.path])));
check('and the other way it is reachable is named', !!ownRow?.alsoReachableAs);
const dotEdit = await post('/api/file/save', {
  filePath: path.join(DOTFILES, 'CLAUDE.md'), projectPath: DOTFILES,
  content: '# edited through the dashboard\n', expectedMtimeMs: fs.statSync(path.join(DOTFILES, 'CLAUDE.md')).mtimeMs,
});
check('and it is still editable', dotEdit.status === 200, JSON.stringify(dotEdit.body));
fs.unlinkSync(path.join(HOME, 'CLAUDE.md'));

// --- a failed pair write must never lose the hook ---------------------
w(GLOBAL_SETTINGS, JSON.stringify({ hooks: { PreToolUse: [hook('J'), hook('K')] } }, null, 2));
fs.rmSync(parkedFile, { force: true });
inv = await inventory();
const realRename2 = fs.renameSync;
const realUnlink = fs.unlinkSync;
fs.renameSync = (from, to) => {
  // the parked file is written first when switching off; make the SECOND
  // write (the settings file) fail, and the undo of the first fail too
  if (String(to) === GLOBAL_SETTINGS) throw Object.assign(new Error('forced settings failure'), { code: 'EIO' });
  if (String(to) === parkedFile && fs.existsSync(parkedFile)) throw Object.assign(new Error('forced undo failure'), { code: 'EIO' });
  return realRename2(from, to);
};
fs.unlinkSync = (p) => {
  if (String(p) === parkedFile) throw Object.assign(new Error('forced undo failure'), { code: 'EIO' });
  return realUnlink(p);
};
res = await toggleHookRow(inv.hooks.find((h) => h.matcher === 'J'), false);
fs.renameSync = realRename2;
fs.unlinkSync = realUnlink;
check('a doubly-failed write reports the failure', res.status !== 200, JSON.stringify(res.body));
check('the hook still exists somewhere — never in neither file',
  matchers() === 'J,K' || (fs.existsSync(parkedFile) &&
    JSON.stringify(readJson(parkedFile)).includes('echo J')),
  `${matchers()} | parked ${fs.existsSync(parkedFile) ? fs.readFileSync(parkedFile, 'utf8') : '(none)'}`);
check('the failure message says where the copy is',
  /both|copy of the file/.test(res.body.error || '') || matchers() === 'J,K', JSON.stringify(res.body));

// --- a failed undo must not invent a settings file --------------------
const NEWPROJ = path.join(SANDBOX, 'fresh');
fs.mkdirSync(path.join(NEWPROJ, '.claude'), { recursive: true });
w(parkedFile, JSON.stringify({
  hooks: { [path.join(NEWPROJ, '.claude', 'settings.json')]: { PreToolUse: [{ __dashboardSlot: 0, entry: hook('L') }] } },
}, null, 2));
inv = await inventory(NEWPROJ);
const freshRow = inv.hooks.find((h) => h.matcher === 'L');
const realRename3 = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to) === parkedFile) throw Object.assign(new Error('forced parked failure'), { code: 'EIO' });
  return realRename3(from, to);
};
res = await post('/api/toggle/hook', {
  projectPath: NEWPROJ, settingsPath: freshRow.source, event: freshRow.event,
  index: Number(freshRow.id.split(':')[1]), signature: freshRow.signature, enabled: true,
});
fs.renameSync = realRename3;
check('an undone write does not leave behind a settings file that never existed',
  !fs.existsSync(path.join(NEWPROJ, '.claude', 'settings.json')),
  fs.existsSync(path.join(NEWPROJ, '.claude', 'settings.json'))
    ? fs.readFileSync(path.join(NEWPROJ, '.claude', 'settings.json'), 'utf8') : '');
fs.rmSync(parkedFile, { force: true });

// --- a folder the tool cannot chmod must not block saving -------------
const realChmod = fs.chmodSync;
fs.chmodSync = (p, m) => {
  if (String(p).includes('.claude-context-dashboard')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  return realChmod(p, m);
};
const chmodSave = await post('/api/file/save', {
  filePath: projectMd, projectPath: PROJECT, content: '# still saves\n',
  expectedMtimeMs: fs.statSync(projectMd).mtimeMs,
});
fs.chmodSync = realChmod;
check('a backup folder that cannot be locked down does not block the save',
  chmodSave.status === 200 && fs.readFileSync(projectMd, 'utf8') === '# still saves\n', JSON.stringify(chmodSave.body));

// --- a parked entry that itself has a key called "entry" --------------
w(parkedFile, JSON.stringify({
  hooks: { [GLOBAL_SETTINGS]: { PreToolUse: [{ matcher: 'H', entry: 'a real field', hooks: [{ type: 'command', command: 'echo H' }] }] } },
}, null, 2));
inv = await inventory();
const oddRow = inv.hooks.find((h) => h.matcher === 'H');
check('an odd-looking parked hook is read as a hook, not as a wrapper', !!oddRow, JSON.stringify(inv.hooks));
if (oddRow) {
  await toggleHookRow(oddRow, true);
  const back = readJson(GLOBAL_SETTINGS).hooks.PreToolUse.find((e) => e && e.matcher === 'H');
  check('it is restored whole', back?.entry === 'a real field' && back?.hooks[0].command === 'echo H', JSON.stringify(back));
}
fs.rmSync(parkedFile, { force: true });

// --- switching off something that is not there ------------------------
refused = null;
try {
  toggle.toggleFile({ filePath: path.join(HOME, '.claude', 'skills', 'ghost', 'SKILL.md'), enabled: false });
} catch (err) { refused = err.message; }
check('switching off a file that does not exist is refused, not reported as done',
  /not there/.test(refused || ''), refused);

// --- C1: viewing the home directory itself ----------------------------
const homeInv = await inventory(HOME);
const globalSettingsRows = homeInv.settingsLayers.filter((l) => l.path === GLOBAL_SETTINGS);
check('the same settings file is not listed twice', globalSettingsRows.length === 1,
  JSON.stringify(homeInv.settingsLayers.map((l) => l.label)));
const ids = homeInv.hooks.map((h) => `${h.source}|${h.id}`);
check('no two hooks share an identity', new Set(ids).size === ids.length, JSON.stringify(ids));

// --- toggleFile is markdown-only --------------------------------------
w(path.join(HOME, '.claude', 'skills', 'tidy', 'secret.key'), 'k');
refused = null;
try {
  toggle.toggleFile({ filePath: path.join(HOME, '.claude', 'skills', 'tidy', 'secret.key'), enabled: false });
} catch (err) { refused = err.message; }
check('a non-markdown file cannot be renamed', /Only markdown/.test(refused || ''), refused);

// --- moving a tool connection between global and one project ----------
{
  const claudeJson = path.join(HOME, '.claude.json');
  const cfg = { command: 'npx', args: ['thing'], env: { TOKEN: 'secret' } };
  let d = readJson(claudeJson);
  d.mcpServers = { widgets: cfg };
  w(claudeJson, JSON.stringify(d, null, 2));

  inv = await inventory();
  check('the connection starts out global', inv.mcp.user.some((s) => s.name === 'widgets') && inv.mcp.local.length === 0);

  res = await post('/api/mcp/move', { name: 'widgets', to: 'project', projectPath: PROJECT });
  d = readJson(claudeJson);
  const proj = fs.realpathSync(PROJECT);
  check('it moves into the project, definition intact',
    res.status === 200 && JSON.stringify(d.projects[proj].mcpServers.widgets) === JSON.stringify(cfg),
    JSON.stringify(res.body));
  check('and is gone from the global lists',
    d.mcpServers.widgets === undefined && (d.disabledUserMcpServers || {}).widgets === undefined);

  inv = await inventory();
  check('the dashboard now shows it as this project\'s own',
    inv.mcp.local.some((s) => s.name === 'widgets' && s.enabled) && !inv.mcp.user.some((s) => s.name === 'widgets'));
  const other = path.join(SANDBOX, 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  check('and it does not show up in another project', (await inventory(other)).mcp.local.length === 0);

  res = await post('/api/mcp/move', { name: 'widgets', to: 'project', projectPath: PROJECT });
  check('moving it somewhere it already is is refused', res.status !== 200, JSON.stringify(res.body));

  // a switched-off global connection can be moved too, and arrives switched on
  d = readJson(claudeJson);
  delete d.projects[proj].mcpServers.widgets;
  d.disabledUserMcpServers = { widgets: cfg };
  w(claudeJson, JSON.stringify(d, null, 2));
  res = await post('/api/mcp/move', { name: 'widgets', to: 'project', projectPath: PROJECT });
  d = readJson(claudeJson);
  check('a switched-off connection moves too, and arrives switched on',
    res.status === 200 && JSON.stringify(d.projects[proj].mcpServers.widgets) === JSON.stringify(cfg) &&
    (d.disabledUserMcpServers || {}).widgets === undefined, JSON.stringify(res.body));

  res = await post('/api/mcp/move', { name: 'widgets', to: 'global', projectPath: PROJECT });
  d = readJson(claudeJson);
  check('and it can be sent back to every project',
    res.status === 200 && JSON.stringify(d.mcpServers.widgets) === JSON.stringify(cfg) &&
    (d.projects[proj].mcpServers || {}).widgets === undefined, JSON.stringify(res.body));

  res = await post('/api/mcp/move', { name: 'ghost', to: 'project', projectPath: PROJECT });
  check('moving something that is not there is refused', res.status !== 200, JSON.stringify(res.body));

  d = readJson(claudeJson);
  delete d.mcpServers.widgets;
  w(claudeJson, JSON.stringify(d, null, 2));
}

// --- permission rules, edited one at a time ---------------------------
w(PROJECT_SETTINGS, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, model: 'opus' }, null, 2));
res = await post('/api/file/permission', {
  filePath: PROJECT_SETTINGS, projectPath: PROJECT, group: 'deny', rule: 'Bash(rm:*)', action: 'add',
});
check('a rule can be added to a group that did not exist',
  res.status === 200 && readJson(PROJECT_SETTINGS).permissions.deny[0] === 'Bash(rm:*)', JSON.stringify(res.body));
check('the rest of the file is untouched', readJson(PROJECT_SETTINGS).model === 'opus');
res = await post('/api/file/permission', {
  filePath: PROJECT_SETTINGS, projectPath: PROJECT, group: 'allow', rule: 'Bash(ls:*)', action: 'remove',
});
check('a rule can be removed, and an emptied group goes away',
  readJson(PROJECT_SETTINGS).permissions.allow === undefined, JSON.stringify(readJson(PROJECT_SETTINGS)));
res = await post('/api/file/permission', {
  filePath: PROJECT_SETTINGS, projectPath: PROJECT, group: 'deny', rule: 'Bash(rm:*)', action: 'remove',
});
check('removing the last rule leaves no empty permissions block',
  readJson(PROJECT_SETTINGS).permissions === undefined, JSON.stringify(readJson(PROJECT_SETTINGS)));
res = await post('/api/file/permission', {
  filePath: PROJECT_SETTINGS, projectPath: PROJECT, group: 'nonsense', rule: 'x', action: 'add',
});
check('an unknown group is refused', res.status !== 200, JSON.stringify(res.body));
res = await post('/api/file/permission', {
  filePath: path.join(HOME, '.zshrc'), projectPath: PROJECT, group: 'allow', rule: 'x', action: 'add',
});
check('a file outside the dashboard is refused', res.status !== 200, JSON.stringify(res.body));
w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));

// --- a plugin's own file can be read but not written ------------------
const pluginSkill = path.join(HOME, '.claude', 'plugins', 'cache', 'demo', 'skills', 'thing', 'SKILL.md');
w(pluginSkill, '---\nname: thing\ndescription: from a plugin\n---\nplugin body\n');
w(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: { 'demo@market': [{ scope: 'user', version: '1.0.0', installPath: path.join(HOME, '.claude', 'plugins', 'cache', 'demo') }] },
}, null, 2));
w(GLOBAL_SETTINGS, JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));
inv = await inventory();
const pluginRow = inv.skills.find((s) => s.scope.startsWith('plugin:'));
check('a plugin\'s skill is listed', !!pluginRow, JSON.stringify(inv.skills.map((s) => s.scope)));
const pluginRead = (await get(`/api/file?path=${encodeURIComponent(pluginRow.path)}&project=${encodeURIComponent(PROJECT)}`)).body;
check('it can be read in full', pluginRead.content?.includes('plugin body'), JSON.stringify(pluginRead).slice(0, 160));
check('but it is marked as not writable', pluginRead.writable === false && !!pluginRead.readOnlyReason);
const pluginWrite = await post('/api/file/save', {
  filePath: pluginRow.path, projectPath: PROJECT, content: 'changed', expectedMtimeMs: pluginRead.mtimeMs,
});
check('and writing it is still refused',
  pluginWrite.status !== 200 && fs.readFileSync(pluginSkill, 'utf8').includes('plugin body'), JSON.stringify(pluginWrite.body));

// a linked instructions file reads in full, but is not writable
inv = await inventory();
const ownMd = inv.claudeMd.files.find((f) => f.label === 'project');
const mdRead = (await get(`/api/file?path=${encodeURIComponent(ownMd.path)}&project=${encodeURIComponent(PROJECT)}`)).body;
check('an ordinary instructions file is writable', mdRead.writable === true, JSON.stringify(mdRead.readOnlyReason));

// --- an oversized request is refused, not accumulated -----------------
const huge = await post('/api/file/save', {
  filePath: projectMd, projectPath: PROJECT, content: 'x'.repeat(9 * 1024 * 1024), expectedMtimeMs: null,
});
check('an oversized request body is refused', huge.status === 413, `${huge.status} ${JSON.stringify(huge.body)}`);
check('a normal-sized save still works', (await post('/api/file/save', {
  filePath: projectMd, projectPath: PROJECT, content: '# fine\n', expectedMtimeMs: fs.statSync(projectMd).mtimeMs,
})).status === 200);

// --- two definitions of the same connection name ----------------------
// Switching one off parks its definition; setting it up again by another route
// while it is off leaves two, and restoring the parked one used to overwrite
// the newer one without a word.
{
  const claudeJson = path.join(HOME, '.claude.json');
  const proj = fs.realpathSync(PROJECT);
  let d = readJson(claudeJson);
  d.mcpServers = { ...(d.mcpServers || {}), notes: { command: 'old-notes' } };
  w(claudeJson, JSON.stringify(d, null, 2));

  res = await post('/api/toggle/mcp-user', { name: 'notes', enabled: false });
  check('a global connection is switched off by parking its definition',
    res.status === 200 && readJson(claudeJson).disabledUserMcpServers.notes.command === 'old-notes', JSON.stringify(res.body));

  d = readJson(claudeJson);
  d.mcpServers.notes = { command: 'new-notes' }; // set up again by another route
  w(claudeJson, JSON.stringify(d, null, 2));

  inv = await inventory();
  const row = inv.mcp.user.find((s) => s.name === 'notes');
  check('both definitions are reported, on one row',
    inv.mcp.user.filter((s) => s.name === 'notes').length === 1 &&
    row.config.command === 'new-notes' && row.parkedDuplicate?.command === 'old-notes', JSON.stringify(row));

  res = await post('/api/toggle/mcp-user', { name: 'notes', enabled: true });
  check('switching it is refused while there are two, and neither is touched',
    res.status !== 200 && readJson(claudeJson).mcpServers.notes.command === 'new-notes' &&
    readJson(claudeJson).disabledUserMcpServers.notes.command === 'old-notes', JSON.stringify(res.body));
  res = await post('/api/mcp/move', { name: 'notes', to: 'project', projectPath: PROJECT });
  check('and so is moving it', res.status !== 200 &&
    readJson(claudeJson).disabledUserMcpServers.notes.command === 'old-notes', JSON.stringify(res.body));

  res = await post('/api/mcp/resolve-duplicate', { scope: 'user', name: 'notes', keep: 'saved', projectPath: PROJECT });
  d = readJson(claudeJson);
  check('going back to the saved one is a choice you make explicitly',
    res.status === 200 && d.mcpServers.notes.command === 'old-notes' && d.disabledUserMcpServers === undefined,
    JSON.stringify(res.body));
  res = await post('/api/toggle/mcp-user', { name: 'notes', enabled: false });
  check('after which the ordinary switch works again',
    res.status === 200 && readJson(claudeJson).disabledUserMcpServers.notes.command === 'old-notes', JSON.stringify(res.body));

  d = readJson(claudeJson);
  d.mcpServers.notes = { command: 'newer-notes' };
  w(claudeJson, JSON.stringify(d, null, 2));
  res = await post('/api/mcp/resolve-duplicate', { scope: 'user', name: 'notes', keep: 'current', projectPath: PROJECT });
  d = readJson(claudeJson);
  check('keeping the one in use drops the saved copy instead',
    res.status === 200 && d.mcpServers.notes.command === 'newer-notes' && d.disabledUserMcpServers === undefined,
    JSON.stringify(res.body));
  res = await post('/api/mcp/resolve-duplicate', { scope: 'user', name: 'notes', keep: 'current', projectPath: PROJECT });
  check('choosing between two that are no longer two is refused', res.status !== 200, JSON.stringify(res.body));

  // the same thing for a connection private to this project
  d = readJson(claudeJson);
  d.projects[proj] = d.projects[proj] || {};
  d.projects[proj].mcpServers = { ...(d.projects[proj].mcpServers || {}), scratch: { command: 'old-scratch' } };
  w(claudeJson, JSON.stringify(d, null, 2));
  await post('/api/toggle/mcp-local', { projectPath: PROJECT, name: 'scratch', enabled: false });
  d = readJson(claudeJson);
  d.projects[proj].mcpServers.scratch = { command: 'new-scratch' };
  w(claudeJson, JSON.stringify(d, null, 2));
  res = await post('/api/toggle/mcp-local', { projectPath: PROJECT, name: 'scratch', enabled: true });
  check('a private connection with two definitions is refused too',
    res.status !== 200 && readJson(claudeJson).projects[proj].disabledLocalMcpServers.scratch.command === 'old-scratch',
    JSON.stringify(res.body));
  res = await post('/api/mcp/resolve-duplicate', { scope: 'local', name: 'scratch', keep: 'current', projectPath: PROJECT });
  d = readJson(claudeJson);
  check('and can be settled the same way',
    res.status === 200 && d.projects[proj].mcpServers.scratch.command === 'new-scratch' &&
    d.projects[proj].disabledLocalMcpServers === undefined, JSON.stringify(res.body));

  d = readJson(claudeJson);
  delete d.mcpServers.notes;
  delete d.projects[proj].mcpServers.scratch;
  w(claudeJson, JSON.stringify(d, null, 2));
}

// --- a shared server whose state is decided in a settings file --------
// The enabled/disabled lists are ordinary settings keys, and a settings layer
// outranks ~/.claude.json's own record — so writing the record while a layer
// says otherwise was a switch that reported success and changed nothing. A
// switch that says "this project" must also not rewrite a file that applies to
// every project, so when the decision lives in one of those, the answer goes in
// this project's own settings file, which outranks it here.
{
  const claudeJson = path.join(HOME, '.claude.json');
  const proj = fs.realpathSync(PROJECT);
  const mcpJson = path.join(PROJECT, '.mcp.json');
  w(mcpJson, JSON.stringify({ mcpServers: { docs: { command: 'docs' } } }, null, 2));
  w(GLOBAL_SETTINGS, JSON.stringify({ enabledPlugins: { 'demo@market': true }, disabledMcpjsonServers: ['docs'] }, null, 2));
  w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));

  inv = await inventory();
  check('the file that decides a shared server is reported',
    inv.mcp.shared.find((s) => s.name === 'docs')?.explicitlySetIn === GLOBAL_SETTINGS,
    JSON.stringify(inv.mcp.shared));

  res = await post('/api/toggle/mcp-shared', { projectPath: PROJECT, name: 'docs', enabled: true });
  inv = await inventory();
  check('a decision that applies to every project is not rewritten by a switch that says this project',
    res.status === 200 && JSON.stringify(readJson(GLOBAL_SETTINGS).disabledMcpjsonServers) === JSON.stringify(['docs']),
    JSON.stringify(readJson(GLOBAL_SETTINGS)));
  check('the answer goes in this project\'s own settings file, and wins there',
    (readJson(PROJECT_SETTINGS).enabledMcpjsonServers || []).includes('docs') &&
    inv.mcp.shared.find((s) => s.name === 'docs').enabled === true, JSON.stringify(readJson(PROJECT_SETTINGS)));
  check('and you are told where it went and why',
    /applies to every project/.test(res.body.note || ''), JSON.stringify(res.body.note));

  // now the project's own file is the one deciding: it is edited in place
  res = await post('/api/toggle/mcp-shared', { projectPath: PROJECT, name: 'docs', enabled: false });
  inv = await inventory();
  check('switching it again edits that same file, moving the entry between the lists',
    res.status === 200 && res.body.filePath === PROJECT_SETTINGS &&
    (readJson(PROJECT_SETTINGS).disabledMcpjsonServers || []).includes('docs') &&
    readJson(PROJECT_SETTINGS).enabledMcpjsonServers === undefined &&
    inv.mcp.shared.find((s) => s.name === 'docs').enabled === false, JSON.stringify(readJson(PROJECT_SETTINGS)));
  check('and no note this time, because nothing else is deciding', !res.body.note, JSON.stringify(res.body.note));

  // with nothing in any settings file, the decision goes to Claude Code's own record
  w(GLOBAL_SETTINGS, JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));
  w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));
  res = await post('/api/toggle/mcp-shared', { projectPath: PROJECT, name: 'docs', enabled: false });
  inv = await inventory();
  check('with no settings file deciding, it goes to Claude Code\'s own record',
    res.status === 200 && res.body.filePath === claudeJson &&
    (readJson(claudeJson).projects[proj].disabledMcpjsonServers || []).includes('docs') &&
    inv.mcp.shared.find((s) => s.name === 'docs').enabled === false, JSON.stringify(res.body));

  // a project whose .claude folder IS the global one has nothing to override with
  const linked = path.join(SANDBOX, 'linked-proj');
  w(path.join(linked, 'CLAUDE.md'), '# linked\n');
  w(path.join(linked, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs' } } }, null, 2));
  fs.symlinkSync(path.join(HOME, '.claude'), path.join(linked, '.claude'));
  w(GLOBAL_SETTINGS, JSON.stringify({ enabledPlugins: { 'demo@market': true }, disabledMcpjsonServers: ['docs'] }, null, 2));
  res = await post('/api/toggle/mcp-shared', { projectPath: linked, name: 'docs', enabled: true });
  check('a project whose settings file is the global one is told, not quietly switched everywhere',
    res.status !== 200 && /every project/.test(res.body.error || '') &&
    JSON.stringify(readJson(GLOBAL_SETTINGS).disabledMcpjsonServers) === JSON.stringify(['docs']),
    JSON.stringify(res.body));
  fs.rmSync(linked, { recursive: true, force: true });

  // a settings file that is there and unreadable is not a missing one
  w(PROJECT_SETTINGS, '{ this is not json');
  const brokenSettings = (await inventory()).coverage.find((c) => c.title === 'Settings').looked
    .find((line) => line.startsWith(PROJECT_SETTINGS));
  check('a settings file that is there but unreadable says so, instead of "not there yet"',
    /could not be read/.test(brokenSettings) && !/not there/.test(brokenSettings), brokenSettings);
  w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));

  // nor is an unreadable list of plugins an empty one, and an unreadable
  // ~/.claude.json must not still be described as the source of every connection
  const claudeJsonPath = path.join(HOME, '.claude.json');
  const keptClaudeJson = fs.readFileSync(claudeJsonPath, 'utf8');
  const installedPath = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
  const keptInstalled = fs.readFileSync(installedPath, 'utf8');
  w(claudeJsonPath, 'not json');
  w(installedPath, '{ nope');
  inv = await inventory();
  const mcpLine = inv.coverage.find((c) => c.title === 'Tool connections (MCP)').looked.find((l) => l.startsWith(claudeJsonPath));
  const pluginLines = inv.coverage.find((c) => c.title === 'Plugins').looked;
  check('an unreadable ~/.claude.json is not still described as the source of every connection',
    /could not be read/.test(mcpLine) && /none of that is listed/.test(mcpLine), mcpLine);
  check('and an unreadable list of plugins is not reported as no plugins',
    pluginLines.some((l) => /could not be read/.test(l)) && !pluginLines.some((l) => /there are none on this machine/.test(l)),
    JSON.stringify(pluginLines));
  w(claudeJsonPath, keptClaudeJson);
  w(installedPath, keptInstalled);

  // the home folder viewed as a project names one file under two roles
  const homeSettings = (await inventory(HOME)).coverage.find((c) => c.title === 'Settings').looked
    .filter((line) => /the same file as/.test(line));
  check('one file under two roles is explained by role, not by repeating the path',
    homeSettings.length === 2 && homeSettings.every((l) => /this would be/.test(l) && !/as \/.*settings/.test(l)),
    JSON.stringify(homeSettings));

  // a subfolder reached through a link is a subfolder
  const linkedSub = path.join(SANDBOX, 'linked-sub-target');
  w(path.join(linkedSub, 'CLAUDE.md'), '# from a linked folder\n');
  fs.symlinkSync(linkedSub, path.join(PROJECT, 'pkg'));
  inv = await inventory();
  check('a CLAUDE.md in a subfolder reached through a link is listed',
    inv.claudeMd.nested.some((f) => f.path === path.join(PROJECT, 'pkg', 'CLAUDE.md')),
    JSON.stringify(inv.claudeMd.nested.map((f) => f.path)));
  check('and the folders line says links are included',
    inv.coverage.find((c) => c.title === 'Instructions files').looked
      .some((l) => /directly inside the project/.test(l) && /pkg/.test(l)),
    JSON.stringify(inv.coverage.find((c) => c.title === 'Instructions files').looked));
  fs.unlinkSync(path.join(PROJECT, 'pkg'));
  fs.rmSync(linkedSub, { recursive: true, force: true });

  // and the two wordings that were simply wrong
  inv = await inventory();
  const skillsGroup = inv.coverage.find((c) => c.title === 'Skills and subagents');
  check('the count of skill folders matches the number listed',
    skillsGroup.notLooked.some((l) => /only the four above/.test(l)) &&
    skillsGroup.looked.filter((l) => l.includes('<each')).length === 4, JSON.stringify(skillsGroup.notLooked));
  const pluginsGroup = inv.coverage.find((c) => c.title === 'Plugins');
  check('a switched-off plugin leaves out its skill files, not the file that was read',
    pluginsGroup.notLooked.every((l) => !/their skills, subagents and hooks are left out/.test(l)),
    JSON.stringify(pluginsGroup.notLooked));

  fs.unlinkSync(mcpJson);
  w(GLOBAL_SETTINGS, JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));
  w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));
}

// --- a settings file that is a link into a dotfiles repo --------------
// Writing by renaming a temp file into place would leave an ordinary file where
// the link was, silently disconnecting it from the repo it lives in.
const dotfiles = path.join(HOME, 'dotfiles', 'settings.json');
w(dotfiles, JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));
fs.unlinkSync(GLOBAL_SETTINGS);
fs.symlinkSync(dotfiles, GLOBAL_SETTINGS);
res = await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'demo@market', enabled: false, scope: 'global' });
check('a switch writes through a linked settings file',
  res.status === 200 && readJson(dotfiles).enabledPlugins['demo@market'] === false, JSON.stringify(res.body));
check('and the link is still a link afterwards',
  fs.lstatSync(GLOBAL_SETTINGS).isSymbolicLink(), 'it was replaced by an ordinary file');
const linkedRead = (await get(`/api/file?path=${encodeURIComponent(GLOBAL_SETTINGS)}&project=${encodeURIComponent(PROJECT)}`)).body;
check('the editor still refuses to save through a link', linkedRead.writable === false, JSON.stringify(linkedRead.readOnlyReason));

// following a link is limited to a file of the same kind, so a settings file
// pointed at something else cannot be overwritten with JSON
const notSettings = path.join(HOME, 'dotfiles', 'settings.backup');
w(notSettings, JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));
fs.unlinkSync(GLOBAL_SETTINGS);
fs.symlinkSync(notSettings, GLOBAL_SETTINGS);
res = await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'demo@market', enabled: false, scope: 'global' });
check('a link to a different kind of file is refused, and that file is untouched',
  res.status !== 200 && readJson(notSettings).enabledPlugins['demo@market'] === true, JSON.stringify(res.body));
fs.unlinkSync(GLOBAL_SETTINGS);
w(GLOBAL_SETTINGS, JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));

// --- a settings file holding valid JSON of the wrong shape ------------
// `null` parses, so it passes every syntax check and then breaks whatever reads
// it. It must not take the whole dashboard down, since the editor is where you
// would go to fix it.
w(PROJECT_SETTINGS, 'null\n');
inv = await inventory();
check('a settings file holding null does not break the inventory',
  Array.isArray(inv.settingsLayers) && inv.settingsLayers.length === 4, JSON.stringify(inv).slice(0, 200));
check('it is marked unreadable and warned about',
  inv.settingsLayers.find((l) => l.path === PROJECT_SETTINGS)?.broken === true &&
  inv.warnings.some((warn) => warn.path === PROJECT_SETTINGS), JSON.stringify(inv.warnings));
const brokenRead = (await get(`/api/file?path=${encodeURIComponent(PROJECT_SETTINGS)}&project=${encodeURIComponent(PROJECT)}`)).body;
check('and it can still be opened here to be fixed',
  brokenRead.content?.trim() === 'null' && brokenRead.writable === true, JSON.stringify(brokenRead).slice(0, 200));
res = await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'demo@market', enabled: false, scope: 'project' });
check('a switch against it explains the problem instead of crashing',
  res.status !== 200 && /holds null/.test(res.body.error || ''), JSON.stringify(res.body));
res = await post('/api/file/save', {
  filePath: PROJECT_SETTINGS, projectPath: PROJECT, content: '[1, 2]\n', expectedMtimeMs: brokenRead.mtimeMs,
});
check('saving JSON that is not an object is refused too',
  res.status !== 200 && readJson(PROJECT_SETTINGS) === null, JSON.stringify(res.body));
res = await post('/api/file/save', {
  filePath: PROJECT_SETTINGS, projectPath: PROJECT, content: '{\n  "model": "opus"\n}\n', expectedMtimeMs: brokenRead.mtimeMs,
});
check('and fixing it from the editor works',
  res.status === 200 && readJson(PROJECT_SETTINGS).model === 'opus', JSON.stringify(res.body));
w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));

// --- earlier versions of a file ---------------------------------------
// Every write already keeps a copy of what it replaced; these are those copies,
// listed and put back through the same rules as an ordinary save.
{
  const backupsFor = async (p, project = PROJECT) =>
    (await get(`/api/file/backups?path=${encodeURIComponent(p)}&project=${encodeURIComponent(project)}`)).body;

  w(projectMd, '# version one\n');
  let file = (await get(`/api/file?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`)).body;
  await post('/api/file/save', { filePath: projectMd, projectPath: PROJECT, content: '# version two\n', expectedMtimeMs: file.mtimeMs });
  file = (await get(`/api/file?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`)).body;
  await post('/api/file/save', { filePath: projectMd, projectPath: PROJECT, content: '# version three\n', expectedMtimeMs: file.mtimeMs });

  let list = await backupsFor(projectMd);
  check('each save leaves a version behind, newest first',
    list.versions.length >= 2 && list.versions[0].savedAtMs >= list.versions[1].savedAtMs, JSON.stringify(list.versions));
  check('a version says when it was kept', !!list.versions[0].savedAt && list.versions[0].size > 0, JSON.stringify(list.versions[0]));

  const secondNewest = list.versions[1].id;
  const read = (await get(`/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}&id=${encodeURIComponent(list.versions[0].id)}`)).body;
  check('a version can be read back', read.content === '# version two\n', JSON.stringify(read).slice(0, 120));

  // a copy of some other file cannot be read through this one
  const otherId = (await backupsFor(GLOBAL_SETTINGS)).versions[0]?.id;
  res = await get(`/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}&id=${encodeURIComponent(otherId || 'x.bak')}`);
  check('a version of a different file is refused', !!otherId && res.status !== 200, `${otherId} → ${res.status} ${JSON.stringify(res.body)}`);
  res = await get(`/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}&id=${encodeURIComponent('../../.zshrc')}`);
  check('and so is an id that tries to leave the folder', res.status !== 200, `${res.status} ${JSON.stringify(res.body)}`);
  res = await get(`/api/file/backups?path=${encodeURIComponent(path.join(HOME, '.zshrc'))}&project=${encodeURIComponent(PROJECT)}`);
  check('versions of a file the dashboard does not show are refused', res.status !== 200, JSON.stringify(res.body));

  file = (await get(`/api/file?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`)).body;
  res = await post('/api/file/restore', { filePath: projectMd, projectPath: PROJECT, id: secondNewest, expectedMtimeMs: file.mtimeMs });
  check('putting a version back writes it to the file',
    res.status === 200 && fs.readFileSync(projectMd, 'utf8') === '# version one\n', JSON.stringify(res.body));
  list = await backupsFor(projectMd);
  check('and what it replaced is kept as a version too',
    list.versions.length >= 3 && fs.readFileSync(path.join(HOME, '.claude-context-dashboard', 'backups', list.versions[0].id), 'utf8') === '# version three\n',
    JSON.stringify(list.versions.map((v) => v.id)));

  res = await post('/api/file/restore', { filePath: projectMd, projectPath: PROJECT, id: secondNewest, expectedMtimeMs: file.mtimeMs });
  check('putting one back is refused if the file changed since it was read',
    res.status !== 200 && /changed on disk/.test(res.body.error || ''), JSON.stringify(res.body));

  const pluginVersions = await backupsFor(pluginRow.path);
  check('a plugin\'s file has no versions to put back and cannot be written',
    Array.isArray(pluginVersions.versions), JSON.stringify(pluginVersions));
  file = (await get(`/api/file?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`)).body;
  res = await post('/api/file/restore', {
    filePath: pluginRow.path, projectPath: PROJECT, id: secondNewest, expectedMtimeMs: file.mtimeMs,
  });
  check('and a version cannot be pushed into a file that is not writable', res.status !== 200, JSON.stringify(res.body));

  w(projectMd, '# project rules\n');
}

// --- versions of a linked file, and of a switched-off twin ------------
// A write goes to the file a link points at, so the copies it keeps are named
// after that file: looking for them under the link's own name found none at
// all. And a copy's name starts with the name of the file it came from, which
// is also the start of the name of that file's switched-off twin.
{
  const linkedTarget = path.join(HOME, 'dotfiles', 'linked-settings.json');
  w(linkedTarget, JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));
  fs.unlinkSync(GLOBAL_SETTINGS);
  fs.symlinkSync(linkedTarget, GLOBAL_SETTINGS);
  await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'demo@market', enabled: false, scope: 'global' });

  let list = (await get(`/api/file/backups?path=${encodeURIComponent(GLOBAL_SETTINGS)}&project=${encodeURIComponent(PROJECT)}`)).body;
  check('a linked file lists the versions kept under the name it really has',
    list.versions.length === 1 && list.restorable === true, JSON.stringify(list));
  let file = (await get(`/api/file?path=${encodeURIComponent(GLOBAL_SETTINGS)}&project=${encodeURIComponent(PROJECT)}`)).body;
  check('the editor still refuses to save typed text over a link', file.writable === false, JSON.stringify(file.readOnlyReason));
  res = await post('/api/file/restore', {
    filePath: GLOBAL_SETTINGS, projectPath: PROJECT, id: list.versions[0].id, expectedMtimeMs: file.mtimeMs,
  });
  check('but an earlier version goes back through the link, which survives',
    res.status === 200 && fs.lstatSync(GLOBAL_SETTINGS).isSymbolicLink() &&
    readJson(linkedTarget).enabledPlugins['demo@market'] === true, JSON.stringify(res.body));
  fs.unlinkSync(GLOBAL_SETTINGS);
  w(GLOBAL_SETTINGS, JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));

  const twin = PROJECT_SETTINGS + '.disabled';
  w(PROJECT_SETTINGS, JSON.stringify({ real: true }, null, 2));
  w(twin, JSON.stringify({ unrelated: 'never in settings.json' }, null, 2));
  const twinRead = (await get(`/api/file?path=${encodeURIComponent(twin)}&project=${encodeURIComponent(PROJECT)}`)).body;
  await post('/api/file/save', {
    filePath: twin, projectPath: PROJECT, content: '{"unrelated":"changed"}\n', expectedMtimeMs: twinRead.mtimeMs,
  });
  const live = (await get(`/api/file/backups?path=${encodeURIComponent(PROJECT_SETTINGS)}&project=${encodeURIComponent(PROJECT)}`)).body;
  check('a switched-off twin\'s versions are not offered as the live file\'s own',
    live.versions.every((v) => !v.id.includes('.disabled.')), JSON.stringify(live.versions.map((v) => v.id)));
  const twinList = (await get(`/api/file/backups?path=${encodeURIComponent(twin)}&project=${encodeURIComponent(PROJECT)}`)).body;
  check('they are listed for the twin itself', twinList.versions.length === 1, JSON.stringify(twinList.versions));
  res = await post('/api/file/restore', {
    filePath: PROJECT_SETTINGS, projectPath: PROJECT, id: twinList.versions[0].id,
    expectedMtimeMs: fs.statSync(PROJECT_SETTINGS).mtimeMs,
  });
  check('and naming one of them for the live file is refused',
    res.status !== 200 && readJson(PROJECT_SETTINGS).real === true, JSON.stringify(res.body));

  fs.unlinkSync(twin);
  w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));
}

// --- the copies do not pile up for ever -------------------------------
// Every write copies the whole file and nothing used to remove them, so a
// ~/.claude.json of several megabytes turned a dozen clicks into a folder of a
// hundred. The rule has to hold without ever dropping a file's newest copy.
{
  const backupsDir = path.join(HOME, '.claude-context-dashboard', 'backups');
  const versionsOf = async (p2) =>
    (await get(`/api/file/backups?path=${encodeURIComponent(p2)}&project=${encodeURIComponent(PROJECT)}`)).body;
  const saveTo = async (p2, content) => {
    const now = (await get(`/api/file?path=${encodeURIComponent(p2)}&project=${encodeURIComponent(PROJECT)}`)).body;
    return post('/api/file/save', { filePath: p2, projectPath: PROJECT, content, expectedMtimeMs: now.mtimeMs });
  };

  for (let i = 0; i < 24; i++) await saveTo(projectMd, `# take ${i}\n`);
  let list = await versionsOf(projectMd);
  check('a file keeps at most twenty versions', list.versions.length === 20, list.versions.length);
  check('and the page is told the limits rather than repeating them',
    list.limits.perFile === 20 && list.limits.totalBytes >= 1024, JSON.stringify(list.limits));
  const newest = (await get(`/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}&id=${encodeURIComponent(list.versions[0].id)}`)).body;
  check('the ones kept are the newest, not the first twenty',
    newest.content === '# take 22\n', JSON.stringify(newest.content));

  // a budget too small for anything at all: the oldest go until it fits, and
  // what is left is the newest copy of every file, which is never given up
  process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET = '1';
  const before = fs.readdirSync(backupsDir).length;
  const fileOf = (n) => n.replace(/\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/, '');
  const filesBefore = new Set(fs.readdirSync(backupsDir).map(fileOf));
  await saveTo(projectMd, '# after the budget\n');
  const after = fs.readdirSync(backupsDir);
  // counting copies per file cannot see a file that has none left at all
  const filesAfter = new Set(after.map(fileOf));
  check('every file that had a copy before the budget bit still has one',
    filesBefore.size > 1 && [...filesBefore].every((f) => filesAfter.has(f)),
    `${[...filesBefore].filter((f) => !filesAfter.has(f)).length} of ${filesBefore.size} files left with none`);
  check('a budget that bites clears the oldest copies', after.length < before, `${before} → ${after.length}`);
  check('and it comes down to the newest of each file, nothing more',
    after.length === new Set(after.map((n) => n.replace(/\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/, ''))).size,
    `${after.length} copies left`);
  const perFile = new Map();
  for (const name of after) {
    const of = name.replace(/\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/, '');
    perFile.set(of, (perFile.get(of) || 0) + 1);
  }
  check('down to one copy per file, and no file left without one',
    after.length > 0 && [...perFile.values()].every((n) => n === 1), JSON.stringify([...perFile]));
  list = await versionsOf(projectMd);
  check('and the one kept is what the last write replaced',
    list.versions.length === 1 &&
    (await get(`/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}&id=${encodeURIComponent(list.versions[0].id)}`)).body.content === '# take 23\n',
    JSON.stringify(list.versions));
  delete process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET;

  // two writes to one file inside the same millisecond would be given the same
  // name, and the second copy would land on top of the first: a version lost
  // rather than kept. The clock is held still to make that certain.
  const wasOneCopy = (await versionsOf(projectMd)).versions.length;
  const realNow = Date.now;
  Date.now = () => 1788888888888;
  toggle.writeEditableFile({ filePath: projectMd, projectPath: PROJECT, content: '# frozen one\n', expectedMtimeMs: fs.statSync(projectMd).mtimeMs });
  toggle.writeEditableFile({ filePath: projectMd, projectPath: PROJECT, content: '# frozen two\n', expectedMtimeMs: fs.statSync(projectMd).mtimeMs });
  Date.now = realNow;
  const frozen = (await versionsOf(projectMd)).versions;
  check('two writes in the same millisecond are kept as two versions',
    frozen.length === wasOneCopy + 2 && new Set(frozen.map((v) => v.id)).size === frozen.length,
    JSON.stringify(frozen.map((v) => v.id)));

  // Which copy is newest is read off its name, so a clock that steps backwards
  // — a time correction, a machine waking up — would file the copy just made as
  // the oldest one, and the next prune would take the very copy it had made.
  const contentOf = async (id) =>
    (await get(`/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}&id=${encodeURIComponent(id)}`)).body.content;
  const replaced = fs.readFileSync(projectMd, 'utf8');
  process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET = '1';
  Date.now = () => realNow() - 10 * 60 * 1000; // ten minutes behind
  const behind = await saveTo(projectMd, '# written while the clock was behind\n');
  Date.now = realNow;
  delete process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET;
  check('a copy made while the clock is behind is not the one pruning takes',
    fs.existsSync(behind.body.backupPath), JSON.stringify(behind.body));
  const afterBehind = (await versionsOf(projectMd)).versions;
  check('it is the version listed as newest, holding what that write replaced',
    afterBehind[0]?.id === path.basename(behind.body.backupPath) && (await contentOf(afterBehind[0].id)) === replaced,
    JSON.stringify(afterBehind.map((v) => v.id)));

  // and with the clock held still, the names must still move forward: pruning
  // frees the oldest name, and a new copy taking it would be next to go
  Date.now = () => 1788999000000;
  for (let i = 0; i < 25; i++) await saveTo(projectMd, `# still ${i}\n`);
  Date.now = realNow;
  const still = (await versionsOf(projectMd)).versions;
  check('with the clock held still, the twenty kept are the last twenty written',
    still.length === 20 && (await contentOf(still[0].id)) === '# still 23\n',
    `${still.length} versions, newest holds ${JSON.stringify(await contentOf(still[0].id))}`);

  w(projectMd, '# project rules\n');
}

// --- what the scan says it looked at ----------------------------------
// The list of gaps is only worth having if it keeps matching the real ones.
{
  w(path.join(PROJECT, 'shallow', 'CLAUDE.md'), '# one level down\n');
  w(path.join(PROJECT, 'deep', 'deeper', 'CLAUDE.md'), '# two levels down\n');
  inv = await inventory();
  const nestedPaths = inv.claudeMd.nested.map((f) => f.path);
  check('a CLAUDE.md one level inside the project is listed',
    nestedPaths.includes(path.join(PROJECT, 'shallow', 'CLAUDE.md')), JSON.stringify(nestedPaths));
  check('one two levels in is not', !nestedPaths.some((p2) => p2.includes('deeper')), JSON.stringify(nestedPaths));

  const instructions = inv.coverage.find((c) => c.title === 'Instructions files');
  check('and the page says so, instead of leaving you to find out',
    instructions.notLooked.some((line) => /more than one level/.test(line)), JSON.stringify(instructions.notLooked));
  check('the folders it walked are the ones it says it walked',
    instructions.looked.some((line) => line.startsWith(path.join(PROJECT, 'CLAUDE.md'))) &&
    instructions.looked.some((line) => line.includes('shallow') && line.includes('deep')),
    JSON.stringify(instructions.looked));

  const settings = inv.coverage.find((c) => c.title === 'Settings');
  check('every settings file it reads is named',
    inv.settingsLayers.every((l) => settings.looked.some((line) => line.startsWith(l.path))), JSON.stringify(settings.looked));
  check('and the settings file installed for the whole machine is named as not read',
    settings.notLooked.some((line) => /managed-settings\.json/.test(line)), JSON.stringify(settings.notLooked));

  const connections = inv.coverage.find((c) => c.title === 'Tool connections (MCP)');
  check('not connecting to MCP servers is stated where it matters',
    connections.notLooked.some((line) => /list of tools/.test(line)), JSON.stringify(connections.notLooked));

  const skills = inv.coverage.find((c) => c.title === 'Skills and subagents');
  check('it does not claim a file is unread when the scan opens it in full',
    skills.looked.some((line) => /in full/.test(line)) &&
    !skills.notLooked.some((line) => /body of a skill/.test(line)), JSON.stringify(skills));
  check('and the dot-folder gap is stated as the project gap it is, not a blanket one',
    instructions.notLooked.some((line) => /starts with a dot/.test(line) && /folder of the project/.test(line)),
    JSON.stringify(instructions.notLooked));

  // a .mcp.json that is there but cannot be read was reported as missing, on the
  // same page as a warning saying it is there and cannot be read
  w(path.join(PROJECT, '.mcp.json'), '{ not json at all');
  inv = await inventory();
  const broken = inv.coverage.find((c) => c.title === 'Tool connections (MCP)').looked.find((line) => line.includes('.mcp.json'));
  check('a file that is there but unreadable is not reported as missing',
    /could not be read/.test(broken) && !/not there/.test(broken), broken);
  check('and the page warns about that same file', inv.warnings.some((warn) => warn.path.endsWith('.mcp.json')), JSON.stringify(inv.warnings));
  fs.unlinkSync(path.join(PROJECT, '.mcp.json'));

  // a project whose .claude folder is a link to the global one names one file
  // twice: it used to fall out of both columns
  const linked = path.join(SANDBOX, 'linked-settings-proj');
  w(path.join(linked, 'CLAUDE.md'), '# linked\n');
  fs.symlinkSync(path.join(HOME, '.claude'), path.join(linked, '.claude'));
  const linkedSettings = (await inventory(linked)).coverage.find((c) => c.title === 'Settings');
  check('a settings file that is the same file under two names is still named, and said to be the same one',
    linkedSettings.looked.some((line) => line.startsWith(path.join(linked, '.claude', 'settings.json')) && /the same file as/.test(line)),
    JSON.stringify(linkedSettings.looked));
  fs.rmSync(linked, { recursive: true, force: true });

  fs.rmSync(path.join(PROJECT, 'shallow'), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT, 'deep'), { recursive: true, force: true });
}

// --- layers of instructions -------------------------------------------
// Two different things sit behind a short CLAUDE.md: "@" lines, whose text
// Claude Code really does load, and plain mentions of other files, which it
// does not. Both are layers; only one of them weighs anything.
{
  const L = path.join(SANDBOX, 'layers-proj');
  w(path.join(L, 'CLAUDE.md'), [
    '# rules',
    '@shared/style.md',
    '@shared/gone.md',
    '@shared/style.md',
    '',
    'The style rules in shared/style.md are pulled in above.',
    'Before touching the parser read docs/architecture.md.',
    'The build is described in `docs/build.txt`.',
    'See [the notes](docs/notes.md), and src/parser.js for the rest.',
    'Conventions live in docs/nothing-here.md.',
    'Upstream has one too: https://example.com/docs/theirs.md',
    '',
  ].join('\n'));
  w(path.join(L, 'shared', 'style.md'), '# style\n@deeper.md\nThe long version is in prose.md.\n');
  w(path.join(L, 'shared', 'prose.md'), '# the long version\n');
  w(path.join(L, 'shared', 'deeper.md'), '# deeper\n');
  w(path.join(L, 'docs', 'architecture.md'), '# architecture\nThen read database.md.\n');
  w(path.join(L, 'docs', 'database.md'), '# database\n');
  w(path.join(L, 'docs', 'build.txt'), 'run make\n');
  w(path.join(L, 'docs', 'notes.md'), '# notes\n');
  w(path.join(L, 'src', 'parser.js'), '// code\n');
  const at = (p2) => path.join(L, p2);

  let li = await inventory(L);
  let md = li.claudeMd.files.find((f) => f.path === at('CLAUDE.md'));
  const imported = md.importedFiles;
  const importRow = (p2) => imported.filter((i) => i.path === at(p2));

  check('an @ line gets a row naming the file it landed on',
    importRow('shared/style.md')[0]?.level === 1 && importRow('shared/style.md')[0].bytes > 0,
    JSON.stringify(imported));
  check('an @ line inside an imported file is a row one level further in, saying which file pulled it',
    importRow('shared/deeper.md')[0]?.level === 2 && importRow('shared/deeper.md')[0].via === at('shared/style.md'),
    JSON.stringify(imported));
  check('an @ line naming a file that is not there is listed as bringing nothing, not dropped',
    importRow('shared/gone.md')[0]?.missing === true && importRow('shared/gone.md')[0].bytes === 0,
    JSON.stringify(imported));
  check('the same file named by two @ lines is one row of text and one row saying it is already in',
    importRow('shared/style.md').length === 2 && importRow('shared/style.md')[1].alreadyPulledIn === true &&
    importRow('shared/style.md')[1].bytes === 0,
    JSON.stringify(imported));

  const weighed = li.weight.biggest.find((i) => i.path === at('CLAUDE.md'));
  const styleBytes = fs.statSync(at('shared/style.md')).size;
  const deeperBytes = fs.statSync(at('shared/deeper.md')).size;
  check('what those @ lines bring is weighed once, and the missing one weighs nothing',
    weighed.importedBytes === styleBytes + deeperBytes, `${weighed.importedBytes} vs ${styleBytes + deeperBytes}`);

  const refs = li.claudeMd.references;
  const refPath = (p2) => refs.files.find((f) => f.path === at(p2));
  check('a file the text only points at is listed, with the words it was written as',
    refPath('docs/architecture.md')?.level === 1 && refPath('docs/architecture.md').spec === 'docs/architecture.md' &&
    refPath('docs/architecture.md').via === at('CLAUDE.md'),
    JSON.stringify(refs.files));
  check('a path in backticks and a markdown link count as pointing at it too',
    !!refPath('docs/build.txt') && !!refPath('docs/notes.md'), JSON.stringify(refs.files.map((f) => f.path)));
  check('and so does a file that one of those points at, one step further out',
    refPath('docs/database.md')?.level === 2 && refPath('docs/database.md').via === at('docs/architecture.md'),
    JSON.stringify(refs.files));
  check('a file that is not a document is not a layer of instructions',
    !refPath('src/parser.js'), JSON.stringify(refs.files.map((f) => f.path)));
  check('a name in the text with no file behind it is left out',
    !refs.files.some((f) => /nothing-here/.test(f.path)), JSON.stringify(refs.files.map((f) => f.path)));
  check('the tail of a web address is not mistaken for a file',
    !refs.files.some((f) => /theirs/.test(f.path)), JSON.stringify(refs.files.map((f) => f.path)));
  check('a pointer written inside a file an @ line pulls in is a layer too — that text loads',
    refPath('shared/prose.md')?.via === at('shared/style.md'), JSON.stringify(refs.files.map((f) => f.path)));
  check('a file an @ line already pulls in is not listed a second time as merely pointed at',
    !refPath('shared/style.md'), JSON.stringify(refs.files.map((f) => f.path)));
  check('none of what is pointed at is counted as weight',
    weighed.bytes === md.bytes + weighed.importedBytes, `${weighed.bytes} vs ${md.bytes + weighed.importedBytes}`);

  const instructions = li.coverage.find((c) => c.title === 'Instructions files');
  check('the page says it followed those mentions, and with which endings',
    instructions.looked.some((l) => refs.extensions.every((e) => l.includes(e)) && l.includes(String(refs.depth))),
    JSON.stringify(instructions.looked));
  check('and says the two ways a mention is dropped: wrong ending, and no file behind it',
    instructions.notLooked.some((l) => /ends in anything else/.test(l)) &&
    instructions.notLooked.some((l) => /not there on disk/.test(l)),
    JSON.stringify(instructions.notLooked));

  // reading and writing: the text that loads can be changed here, the text that
  // is only pointed at can be read here
  const impRead = await get(`/api/file?path=${encodeURIComponent(at('shared/style.md'))}&project=${encodeURIComponent(L)}`);
  check('a file an @ line pulls in opens as changeable, not read-only',
    impRead.body.writable === true, JSON.stringify(impRead.body).slice(0, 200));
  const imp = await post('/api/file/save', {
    filePath: at('shared/style.md'), projectPath: L, content: '# restyled\n', expectedMtimeMs: impRead.body.mtimeMs,
  });
  check('a file an @ line pulls in can be saved — it is instructions text that loads',
    imp.status === 200 && fs.readFileSync(at('shared/style.md'), 'utf8') === '# restyled\n', JSON.stringify(imp.body));
  const ref = await get(`/api/file?path=${encodeURIComponent(at('docs/architecture.md'))}&project=${encodeURIComponent(L)}`);
  check('a file that is only pointed at opens, read-only, and says why',
    ref.status === 200 && ref.body.writable === false && /only points at it/.test(ref.body.readOnlyReason || ''),
    JSON.stringify(ref.body).slice(0, 200));
  const refSave = await post('/api/file/save', { filePath: at('docs/architecture.md'), projectPath: L, content: 'nope\n' });
  check('and saving it is refused, leaving the file alone',
    refSave.status >= 400 && fs.readFileSync(at('docs/architecture.md'), 'utf8').startsWith('# architecture'),
    `${refSave.status} ${JSON.stringify(refSave.body)}`);

  // an instructions file that is switched off points nowhere while it is off
  await post('/api/toggle/markdown', { projectPath: L, filePath: at('CLAUDE.md'), enabled: false });
  li = await inventory(L);
  check('a switched-off instructions file stops pointing at anything',
    li.claudeMd.references.files.length === 0, JSON.stringify(li.claudeMd.references.files.map((f) => f.path)));
  check('and stops pulling anything in',
    li.claudeMd.files.find((f) => f.path === at('CLAUDE.md.disabled')).importedFiles.length === 0);
  await post('/api/toggle/markdown', { projectPath: L, filePath: at('CLAUDE.md.disabled'), enabled: true });
  li = await inventory(L);
  check('switching it back on brings both lists back',
    li.claudeMd.references.files.length > 0 && li.claudeMd.files.find((f) => f.path === at('CLAUDE.md')).importedFiles.length > 0);

  // a doc tree big enough to hit the ceiling must say the list is partial
  const many = path.join(L, 'docs', 'many');
  for (let i = 0; i < refs.limit + 5; i++) w(path.join(many, `doc${i}.md`), `# doc ${i}\n`);
  w(path.join(L, 'docs', 'notes.md'), '# notes\n' +
    Array.from({ length: refs.limit + 5 }, (_, i) => `many/doc${i}.md`).join('\n') + '\n');
  li = await inventory(L);
  check('past the ceiling the list stops there rather than growing without end',
    li.claudeMd.references.truncated === true && li.claudeMd.references.files.length === refs.limit,
    `${li.claudeMd.references.files.length} of ${refs.limit}, truncated=${li.claudeMd.references.truncated}`);
  check('and the page says the list is only part of what is named',
    li.coverage.find((c) => c.title === 'Instructions files').looked.some((l) => /only part of what is named/.test(l)),
    JSON.stringify(li.coverage.find((c) => c.title === 'Instructions files').looked));

  fs.rmSync(L, { recursive: true, force: true });
}

// --- a dashboard left running while the tool is updated ---------------
// The page is read off disk on every reload; the server keeps the code it
// started with. The page needs to be able to tell that apart from a bug.
{
  const meta = (await get('/api/projects')).body;
  const newestFileIn = (dir) => {
    let newest = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      newest = Math.max(newest, fs.statSync(path.join(dir, entry.name)).mtimeMs);
    }
    return newest;
  };
  const src = path.dirname(new URL('../src/server.js', import.meta.url).pathname);
  const pub = path.dirname(new URL('../public/app.js', import.meta.url).pathname);
  check('the server says when it started and when its own files last changed',
    typeof meta.startedAt === 'number' && typeof meta.sourceChangedAt === 'number', JSON.stringify(meta).slice(0, 160));
  check('and that second number is the newest of the files it is running and serving',
    meta.sourceChangedAt === Math.max(newestFileIn(src), newestFileIn(pub)),
    `${meta.sourceChangedAt} vs ${Math.max(newestFileIn(src), newestFileIn(pub))}`);
  check('a server started after its files reports nothing to worry about',
    meta.sourceChangedAt <= meta.startedAt, `${meta.sourceChangedAt} > ${meta.startedAt}`);
}

// --- restarting from the page ------------------------------------------
{
  const before = restartsAsked;
  const asked = await post('/api/restart', {});
  await new Promise((r) => setTimeout(r, 50)); // the restart runs after the answer
  check('the page can ask the dashboard to start itself again',
    asked.status === 200 && asked.body.ok === true && restartsAsked === before + 1,
    `${asked.status} ${JSON.stringify(asked.body)} restarts=${restartsAsked - before}`);
  // the answer goes out first — a restart that tore the socket down before
  // that would leave the page unable to tell a restart from a failure
  check('and it is told which run it just ended', asked.body.startedAt > 0, JSON.stringify(asked.body));

  const notJson = await fetch(BASE + '/api/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: BASE, ...T },
    body: 'restart',
  });
  await new Promise((r) => setTimeout(r, 50));
  check('a post that is not JSON does not restart anything',
    notJson.status === 400 && restartsAsked === before + 1, `${notJson.status} restarts=${restartsAsked - before}`);

  // the body above is not JSON either, so it would be refused by the parser
  // alone; a valid one under the wrong type is what tests the type check
  const validButPlain = await fetch(BASE + '/api/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: BASE, ...T },
    body: '{}',
  });
  await new Promise((r) => setTimeout(r, 50));
  check('valid JSON sent as plain text does not restart anything either',
    validButPlain.status === 400 && restartsAsked === before + 1, `${validButPlain.status} restarts=${restartsAsked - before}`);

  const fromElsewhere = await fetch(BASE + '/api/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', ...T },
    body: '{}',
  });
  await new Promise((r) => setTimeout(r, 50));
  check('and neither does another page in the same browser',
    fromElsewhere.status === 403 && restartsAsked === before + 1, `${fromElsewhere.status} restarts=${restartsAsked - before}`);

  const asGet = await fetch(`${BASE}/api/restart`, { headers: { Origin: BASE, ...T } });
  await new Promise((r) => setTimeout(r, 50));
  check('and neither does merely visiting the address',
    asGet.status === 404 && restartsAsked === before + 1, `${asGet.status} restarts=${restartsAsked - before}`);
}

// --- CSRF -------------------------------------------------------------
const foreign = await fetch(BASE + '/api/file/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Host: `127.0.0.1:${PORT}`, ...T },
  body: JSON.stringify({ filePath: projectMd, projectPath: PROJECT, content: 'x' }),
});
check('foreign origin blocked on save', foreign.status === 403, foreign.status);
const foreignInv = await fetch(`${BASE}/api/inventory?path=${encodeURIComponent(PROJECT)}`, {
  headers: { Origin: 'http://evil.example', ...T },
});
check('foreign origin blocked on the inventory too', foreignInv.status === 403, foreignInv.status);
// fetch() refuses to set Host, so this one needs a raw request
const http = await import('node:http');
const rawStatus = (headers, withKey = true) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/inventory', headers: withKey ? { ...T, ...headers } : headers }, (r) => {
    r.resume();
    resolve(r.statusCode);
  });
  req.on('error', reject);
  req.end();
});
check('foreign host blocked', (await rawStatus({ Host: 'evil.example' })) === 403);
check('a rebinding hostname is blocked', (await rawStatus({ Host: `attacker.test:${PORT}` })) === 403);
check('the dashboard\'s own host is accepted', (await rawStatus({ Host: `localhost:${PORT}` })) === 200);

// --- the launch key ------------------------------------------------------
// Host and Origin only stop a browser: any program on the machine can send
// the right ones. What it cannot send is the key this launch printed.
{
  check('the server listens on loopback only', server.address().address === '127.0.0.1', JSON.stringify(server.address()));
  check('and the address it gives to open carries the key in the fragment',
    started.url === `http://localhost:${PORT}/#token=${TOKEN}` && /^[A-Za-z0-9_-]{43}$/.test(TOKEN), started.url);
  const local = { Host: `127.0.0.1:${PORT}` };
  check('a request with the right Host but no key is refused',
    (await rawStatus(local, false)) === 403);
  const noKeyGet = await fetch(`${BASE}/api/projects`, { headers: { Origin: BASE } });
  const noKeyBody = await noKeyGet.json();
  check('a GET without the key is refused, saying to open the address the terminal printed',
    noKeyGet.status === 403 && /terminal printed/.test(noKeyBody.error) && !JSON.stringify(noKeyBody).includes(TOKEN),
    `${noKeyGet.status} ${JSON.stringify(noKeyBody)}`);
  const readTarget = path.join(HOME, '.zshrc');
  const noKeyRead = await fetch(`${BASE}/api/file?path=${encodeURIComponent(readTarget)}&project=${encodeURIComponent(HOME)}`, { headers: { Origin: BASE } });
  const noKeyReadBody = await noKeyRead.text();
  check('reading a file without the key is refused before anything is read',
    noKeyRead.status === 403 && !noKeyReadBody.includes('ORIGINAL SHELL CONFIG'), `${noKeyRead.status} ${noKeyReadBody.slice(0, 120)}`);
  const settingsWas = fs.readFileSync(path.join(PROJECT, '.claude', 'settings.json'), 'utf8');
  const noKeyPost = await fetch(`${BASE}/api/toggle/plugin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ projectPath: PROJECT, key: 'nokey@market', enabled: false, scope: 'project' }),
  });
  check('a POST without the key is refused and writes nothing',
    noKeyPost.status === 403 && fs.readFileSync(path.join(PROJECT, '.claude', 'settings.json'), 'utf8') === settingsWas, noKeyPost.status);
  const restartsBefore = restartsAsked;
  const noKeyRestart = await fetch(`${BASE}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{}' });
  await new Promise((r) => setTimeout(r, 50));
  check('and so is a restart', noKeyRestart.status === 403 && restartsAsked === restartsBefore, `${noKeyRestart.status}`);
  // wrong keys: another launch's, one character off, a prefix, and one longer
  const wrongKeys = [serverModule.newToken(), TOKEN.slice(0, -1) + (TOKEN.endsWith('A') ? 'B' : 'A'), TOKEN.slice(0, 10), TOKEN + 'x', TOKEN + TOKEN];
  const wrongStatuses = [];
  for (const k of wrongKeys) wrongStatuses.push(await rawStatus({ ...local, 'X-Dashboard-Token': k }, false));
  check('a wrong key is refused, whatever its length', wrongStatuses.every((st) => st === 403), JSON.stringify(wrongStatuses));
  check('the right key is accepted', (await rawStatus({ ...local, 'X-Dashboard-Token': TOKEN }, false)) === 200);
  // the page itself has to load without the key, or there is nothing to put it in
  const staticStatuses = [];
  for (const p2 of ['/', '/app.js', '/index.html']) staticStatuses.push((await fetch(BASE + p2)).status);
  check('the page\'s own files are served without the key', staticStatuses.every((st) => st === 200), JSON.stringify(staticStatuses));
  let threw = false;
  try { serverModule.createServer(PROJECT, PORT, {}); } catch { threw = true; }
  check('there is no way to build a server without a key', threw);

  // a restart hands the key to the replacement in its environment, never its arguments
  const cmd = serverModule.restartCommand(TOKEN, [process.execPath, '/x/bin/cli.js', '--port', '9'], { HOME, PATH: process.env.PATH });
  check('a restart passes the key in the environment, not on the command line',
    cmd.options.env[serverModule.TOKEN_ENV] === TOKEN && !cmd.args.some((a) => a.includes(TOKEN)) &&
    cmd.args.includes('--no-open') && cmd.args[0] === '/x/bin/cli.js' && cmd.options.env.HOME === HOME,
    JSON.stringify(cmd.args));
  const env = { [serverModule.TOKEN_ENV]: TOKEN, OTHER: '1' };
  check('the replacement takes the key and leaves none in its environment for what it starts',
    serverModule.takeTokenFromEnv(env) === TOKEN && !(serverModule.TOKEN_ENV in env) && env.OTHER === '1', JSON.stringify(env));
  const junk = { [serverModule.TOKEN_ENV]: 'short' };
  check('and a value that is not a key it made is ignored', serverModule.takeTokenFromEnv(junk) === null && !(serverModule.TOKEN_ENV in junk));
  const asked = await post('/api/restart', {});
  await new Promise((r) => setTimeout(r, 50));
  check('the restart endpoint hands this launch\'s key on to the restart', asked.status === 200 && restartHandedToken === TOKEN, String(restartHandedToken));
}

// The real thing, end to end: the command line, a restart through the API, and
// the same key still working on the replacement.
{
  const { spawn } = await import('node:child_process');
  const cliPort = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const cli = spawn(process.execPath, [new URL('../bin/cli.js', import.meta.url).pathname, '--path', PROJECT, '--port', String(cliPort), '--no-open'], {
    env: { ...process.env, [serverModule.TOKEN_ENV]: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  cli.stdout.on('data', (d) => { out += d; });
  cli.stderr.on('data', (d) => { out += d; });
  const waitFor = async (test, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const urlRe = new RegExp(`http://localhost:${cliPort}/#token=([A-Za-z0-9_-]{43})`);
  await waitFor(() => urlRe.test(out));
  const key = (out.match(urlRe) || [])[1];
  check('the command line prints the whole address, key included', !!key, out);
  const cliBase = `http://127.0.0.1:${cliPort}`;
  const meta = async (k) => {
    try {
      const r = await fetch(`${cliBase}/api/projects`, { headers: { 'X-Dashboard-Token': k || '' } });
      return { status: r.status, body: await r.json() };
    } catch {
      return { status: 0 };
    }
  };
  if (key) {
    const first = await meta(key);
    check('and that key opens its API', first.status === 200, JSON.stringify(first));
    // the desktop launcher has no terminal to read the key from, so it is left
    // in a file only this user can read
    const keyFile = serverModule.tokenFilePath(cliPort, HOME);
    const keyFileOk = () => {
      try {
        return fs.readFileSync(keyFile, 'utf8').trim() === key && (fs.statSync(keyFile).mode & 0o777) === 0o600;
      } catch {
        return false;
      }
    };
    check('the command line leaves its key in a file only this user can read', keyFileOk(),
      fs.existsSync(keyFile) ? (fs.statSync(keyFile).mode & 0o777).toString(8) : 'missing');
    check('in a folder only this user can open', (fs.statSync(path.dirname(keyFile)).mode & 0o777) === 0o700);
    check('with no temporary file left beside it', fs.readdirSync(path.dirname(keyFile)).filter((n) => n.endsWith('.tmp')).length === 0,
      fs.readdirSync(path.dirname(keyFile)).join(','));
    const r = await fetch(`${cliBase}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': key }, body: '{}' });
    check('a restart through the API is accepted', r.status === 200, r.status);
    let after = null;
    const cameBack = await waitFor(async () => {
      after = await meta(key);
      return after.status === 200 && after.body.startedAt > first.body.startedAt;
    }, 20000);
    check('the replacement answers the same key the tab already holds', cameBack, JSON.stringify(after));
    // the process that handed over is still alive, waiting; it must not have
    // taken the file away from the replacement
    check('and the key file survives the handover, still holding that key', keyFileOk(),
      fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : 'missing');
    // a stop during a restart reaches the replacement, which removes the file;
    // checked below once both have gone
    const printedAgain = [...out.matchAll(new RegExp(urlRe, 'g'))].map((m) => m[1]);
    check('and prints the same address again', printedAgain.length === 2 && printedAgain[1] === key, JSON.stringify(printedAgain));
    check('while a different key is still refused', (await meta(serverModule.newToken())).status === 403);
  }
  cli.kill('SIGTERM');
  await new Promise((r) => (cli.exitCode !== null || cli.signalCode ? r() : cli.on('exit', r)));
  check('stopping the command line stops the replacement too',
    await waitFor(async () => (await meta(key)).status === 0, 5000));
  check('and the key file goes with them', !fs.existsSync(serverModule.tokenFilePath(cliPort, HOME)));
}

// A dashboard stopped with Ctrl+C (no restart in between) removes its key
// file; and a file that holds some other key is left alone.
{
  const { spawn } = await import('node:child_process');
  const p = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const cli = spawn(process.execPath, [new URL('../bin/cli.js', import.meta.url).pathname, '--path', PROJECT, '--port', String(p), '--no-open'], {
    env: { ...process.env, [serverModule.TOKEN_ENV]: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  cli.stdout.on('data', (d) => { out += d; });
  const keyFile = serverModule.tokenFilePath(p, HOME);
  // The file can land before the printed address reaches this end of the
  // pipe, so wait for both.
  for (let i = 0; i < 100 && !(fs.existsSync(keyFile) && out.includes('#token=')); i++) await new Promise((r) => setTimeout(r, 100));
  const written = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : null;
  check('the key in the file is the key in the printed address', !!written && out.includes(`#token=${written}`), out);
  cli.kill('SIGINT');
  const code = await new Promise((r) => (cli.exitCode !== null ? r(cli.exitCode) : cli.on('exit', (c) => r(c))));
  check('Ctrl+C removes the key file', !fs.existsSync(keyFile), String(code));
  check('and ends with the code a shell gives Ctrl+C', code === 130, String(code));

  const other = serverModule.newToken();
  serverModule.writeTokenFile(p, other, HOME);
  serverModule.removeTokenFile(p, serverModule.newToken(), HOME);
  check('a key file holding some other key is not removed', fs.readFileSync(keyFile, 'utf8').trim() === other);
  serverModule.removeTokenFile(p, other, HOME);
  check('and one holding its own is', !fs.existsSync(keyFile));
}

// The macOS desktop launcher, bin/open-dashboard.sh, run with stand-ins for
// `open` and `osascript` that only record what they were given. It hardcodes
// port 4317 unless CLAUDE_DASHBOARD_PORT says otherwise.
if (process.platform !== 'win32' && fs.existsSync('/bin/bash') && spawnSyncOk('curl', ['--version'])) {
  const { spawn, spawnSync } = await import('node:child_process');
  const freePort = () => new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const L = path.join(SANDBOX, 'launcher');
  const fakeBin = path.join(L, 'bin');
  const rec = path.join(L, 'rec');
  const tmp = path.join(L, 'tmp');
  for (const d of [fakeBin, rec, tmp]) fs.mkdirSync(d, { recursive: true });
  for (const name of ['open', 'osascript']) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/bash\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${rec}/${name}.args"\n`, { mode: 0o755 });
  }
  const recorded = (name) => { try { return fs.readFileSync(path.join(rec, `${name}.args`), 'utf8'); } catch { return ''; } };
  const clearRecords = () => { for (const n of fs.readdirSync(rec)) fs.rmSync(path.join(rec, n)); };
  const script = new URL('../bin/open-dashboard.sh', import.meta.url).pathname;
  const target = path.join(SANDBOX, 'my proj');
  fs.mkdirSync(target, { recursive: true });
  const launch = (port) => spawnSync('/bin/bash', [script, target], {
    env: {
      HOME, TMPDIR: tmp, CLAUDE_DASHBOARD_PORT: String(port),
      PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  const expectedPage = (port, key) =>
    `location.replace("http://localhost:${port}/?path=${encodeURIComponent(target)}#token=${key}")`;
  const openedPage = () => {
    const arg = recorded('open').trim();
    try {
      return { arg, mode: fs.statSync(arg).mode & 0o777, text: fs.readFileSync(arg, 'utf8') };
    } catch {
      return { arg };
    }
  };

  // a dashboard already running, started from the command line
  const p1 = await freePort();
  const cli = spawn(process.execPath, [new URL('../bin/cli.js', import.meta.url).pathname, '--path', PROJECT, '--port', String(p1), '--no-open'], {
    env: { ...process.env, [serverModule.TOKEN_ENV]: '' },
    stdio: 'ignore',
  });
  const keyFile1 = serverModule.tokenFilePath(p1, HOME);
  for (let i = 0; i < 100 && !fs.existsSync(keyFile1); i++) await new Promise((r) => setTimeout(r, 100));
  const key1 = fs.existsSync(keyFile1) ? fs.readFileSync(keyFile1, 'utf8').trim() : '';
  let r = launch(p1);
  let page = openedPage();
  check('the launcher reuses a running dashboard and opens it with that dashboard\'s key, keeping ?path=',
    r.status === 0 && page.text?.includes(expectedPage(p1, key1)) && !recorded('osascript'),
    `${r.status} ${r.stderr} ${JSON.stringify(page)} ${recorded('osascript')}`);
  check('through a page only this user can read, so the key is not on `open`\'s command line',
    page.mode === 0o600 && path.basename(page.arg) === 'open.html' && !page.arg.includes(key1) &&
    (fs.statSync(path.dirname(page.arg)).mode & 0o777) === 0o700, JSON.stringify(page));

  // a key file left behind that the running dashboard does not take
  clearRecords();
  const stale = serverModule.newToken();
  serverModule.writeTokenFile(p1, stale, HOME);
  r = launch(p1);
  check('a key the running dashboard refuses is reported, not opened',
    r.status === 1 && /did not accept the key/.test(recorded('osascript')) && /did not accept the key/.test(r.stderr) && !recorded('open'),
    `${r.status} ${r.stderr} ${recorded('osascript')} ${recorded('open')}`);
  cli.kill('SIGTERM');
  await new Promise((res) => (cli.exitCode !== null ? res() : cli.on('exit', res)));
  check('and that file, holding a key that is not the dashboard\'s own, outlives it', fs.existsSync(keyFile1) &&
    fs.readFileSync(keyFile1, 'utf8').trim() === stale);

  // nothing running, and a key file left by a dashboard that crashed: the
  // launcher starts one itself and opens it with the new key
  clearRecords();
  r = launch(p1);
  const key2 = fs.existsSync(keyFile1) ? fs.readFileSync(keyFile1, 'utf8').trim() : '';
  page = openedPage();
  check('with nothing running, the launcher starts a dashboard and opens it with the new key, not the stale one',
    r.status === 0 && key2 && key2 !== stale && page.text?.includes(expectedPage(p1, key2)),
    `${r.status} ${r.stderr} ${JSON.stringify(page)} ${recorded('osascript')}`);
  const log = path.join(HOME, '.claude-context-dashboard', 'run', `server-${p1}.log`);
  check('its output, which holds the key, goes to a log only this user can read',
    fs.existsSync(log) && (fs.statSync(log).mode & 0o777) === 0o600, fs.existsSync(log) ? (fs.statSync(log).mode & 0o777).toString(8) : 'missing');
  // stop the server the launcher started (it is not a child of this process)
  spawnSync('pkill', ['-TERM', '-f', '--', `--port ${p1} --no-open`]);
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    await new Promise((res) => setTimeout(res, 100));
    gone = !fs.existsSync(keyFile1);
  }
  check('and that dashboard, stopped, takes its key file with it', gone);

  // a port nothing answers on, with no way to start one there: the launcher's
  // server fails, and that is said
  clearRecords();
  // (in a process of its own: the launcher runs synchronously, so a socket
  // held by this one would never be answered)
  const p2 = await freePort();
  const busy = spawn(process.execPath, ['-e',
    `require('net').createServer((s) => s.destroy()).listen(${p2}, '127.0.0.1', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((res) => busy.stdout.once('data', res));
  r = launch(p2);
  check('a port held by something that is not the dashboard is reported, not opened',
    r.status === 1 && /did not start/.test(recorded('osascript')) && !recorded('open'), `${r.status} ${r.stderr} ${recorded('osascript')}`);
  busy.kill();
} else {
  console.log('  (launcher checks skipped: needs bash and curl)');
}

// --- what the scan finds at all -------------------------------------------
// Both of these were found by review: the scan looked for memory under a folder
// name Claude Code does not use, and refused a subagent file that is a link
// while accepting a skill folder that is one.

// Claude Code names the memory folder after the project path with every
// character that is not a letter or a digit turned into a dash. A project whose
// path holds a dot or an underscore is the case that used to be missed.
const DOTTED = path.join(SANDBOX, 'proj.v2_beta');
w(path.join(DOTTED, 'CLAUDE.md'), '# dotted\n');
const dottedSlug = DOTTED.replace(/[^A-Za-z0-9]/g, '-');
w(path.join(HOME, '.claude', 'projects', dottedSlug, 'memory', 'MEMORY.md'), '- [note](note.md) — hook\n');
const dottedInv = await inventory(DOTTED);
check('memory is found for a project whose path holds a dot and an underscore',
  dottedInv.memory?.files?.some((f) => f.name === 'MEMORY.md'), JSON.stringify(dottedInv.memory));
// and the folder built the old way is not what is read
const slashOnlySlug = DOTTED.replace(/[\\/]/g, '-');
check('the folder name is not the slash-only spelling', dottedSlug !== slashOnlySlug, dottedSlug);

// A subagent linked in from a dotfiles repo is a subagent.
const realAgent = path.join(SANDBOX, 'elsewhere', 'linked.md');
w(realAgent, '---\nname: linked\ndescription: lives in another repo\n---\nbody\n');
fs.mkdirSync(path.join(HOME, '.claude', 'agents'), { recursive: true });
fs.symlinkSync(realAgent, path.join(HOME, '.claude', 'agents', 'linked.md'));
inv = await inventory();
const linkedAgent = inv.agents.find((a) => a.name === 'linked');
check('a subagent file that is a symlink is listed', !!linkedAgent, JSON.stringify(inv.agents.map((a) => a.name)));
check('and its description is read through the link, so it counts towards the weight',
  linkedAgent?.description === 'lives in another repo' && linkedAgent?.startupBytes > 0, JSON.stringify(linkedAgent));
check('and the row says where the link really points', linkedAgent?.symlink === realAgent, linkedAgent?.symlink);

// --- review fixes: write paths ------------------------------------------
// Each of these was proven wrong by review, with a script that showed it.
{
  const backupsDir = path.join(HOME, '.claude-context-dashboard', 'backups');
  const readFile = async (p2, project = PROJECT) =>
    (await get(`/api/file?path=${encodeURIComponent(p2)}&project=${encodeURIComponent(project)}`)).body;
  const versionsOf = async (p2, project = PROJECT) =>
    (await get(`/api/file/backups?path=${encodeURIComponent(p2)}&project=${encodeURIComponent(project)}`)).body;
  const saveTo = async (p2, content, project = PROJECT) => {
    const now = await readFile(p2, project);
    return post('/api/file/save', { filePath: p2, projectPath: project, content, expectedMtimeMs: now.mtimeMs });
  };
  const STAMP = /\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/;

  // A request body arrives in pieces, and a character can straddle two of them:
  // decoding each piece on its own turned a few of a long file's "—" into U+FFFD.
  {
    // two- and three-byte characters back to back, long enough to arrive in
    // many pieces, so some piece boundary always falls inside one
    const long = 'é'.repeat(300000) + '\n' + Array.from({ length: 20000 }, (_, i) => `line ${i} — some prose here, é ok`).join('\n') + '\n';
    res = await saveTo(projectMd, long);
    const back = fs.readFileSync(projectMd, 'utf8');
    check('a long save full of characters wider than a byte comes back exactly as sent',
      res.status === 200 && back === long, `${res.status} replacement chars: ${(back.match(/�/g) || []).length}`);
    w(projectMd, '# project rules\n');
  }

  // Two files whose paths differ only in "/" against "__" were given the same
  // name for their copies, so one file's versions were offered, and put back,
  // as the other's.
  const C = path.join(SANDBOX, 'collide');
  const A = path.join(C, 'a', 'b', 'CLAUDE.md');
  const B = path.join(C, 'a__b', 'CLAUDE.md');
  w(A, 'SECRET A original\n');
  w(B, 'B original\n');
  {
    res = await saveTo(A, 'A v2\n', path.join(C, 'a'));
    check('(the first of two look-alike paths is saved)', res.status === 200, JSON.stringify(res.body));
    const forB = await versionsOf(B, C);
    check('a file is not offered the versions of a different file whose path looks the same once flattened',
      Array.isArray(forB.versions) && forB.versions.length === 0, JSON.stringify(forB.versions));
    const forA = await versionsOf(A, path.join(C, 'a'));
    check('and the file that was saved still has its own',
      forA.versions?.length === 1, JSON.stringify(forA.versions));
  }

  // A path holding a line break: the old shape of a copy's name could not be
  // matched across it, so its copies were made and then never seen again.
  {
    const NL = path.join(C, 'line\nbreak', 'CLAUDE.md');
    w(NL, '# odd folder\n');
    const nlInv = await inventory(C);
    if (nlInv.claudeMd.nested.some((f) => f.path === NL)) {
      res = await saveTo(NL, '# changed\n', C);
      const list = await versionsOf(NL, C);
      check('a file whose path holds a line break lists the version its save kept',
        res.status === 200 && list.versions?.length === 1, `${res.status} ${JSON.stringify(list.versions)}`);
    } else {
      check('(a folder with a line break in its name is listed, so its versions can be checked)', false,
        JSON.stringify(nlInv.claudeMd.nested.map((f) => f.path)));
    }
    fs.rmSync(path.dirname(NL), { recursive: true, force: true });
  }

  // Copies made under the old names are still on disk. Which file one came from
  // cannot be known — guessing from what exists now handed a deleted file's
  // history to the survivor for good — so they are never renamed: shown, marked,
  // to a file whose old-style name is exactly theirs, to compare and not put back.
  {
    const legacy = (p2, stamp) => path.join(backupsDir, `${p2.replace(/[\\/]/g, '__')}.${stamp}.bak`);
    const SOLO = path.join(C, 'solo', 'CLAUDE.md');
    w(SOLO, '# solo now\n');
    const soloOld = legacy(SOLO, '2020-01-01T00-00-00-000Z');
    w(soloOld, '# solo, as it was in 2020\n');
    w(legacy(SOLO + '.disabled', '2020-01-03T00-00-00-000Z'), 'the switched-off twin\n');
    const shared = legacy(A, '2020-01-02T00-00-00-000Z'); // A and B both flatten to this
    w(shared, 'whose is this?\n');

    const solo = await versionsOf(SOLO, C);
    const v = solo.versions?.[0];
    const kept = v ? (await get(`/api/file/backups?path=${encodeURIComponent(SOLO)}&project=${encodeURIComponent(C)}&id=${encodeURIComponent(v.id)}`)).body : {};
    check('a copy kept under the old kind of name is listed for the file whose old name is exactly its own, and can be read',
      solo.versions?.length === 1 && kept.content === '# solo, as it was in 2020\n', JSON.stringify(solo.versions));
    check('marked as possibly another file\'s, and not to be put back',
      v?.legacy === true && v?.restorable === false && /may belong to another file/.test(v?.note || '') && solo.restorable === true,
      JSON.stringify(v));
    check('and it is left under its old name: listing renames nothing',
      fs.existsSync(soloOld) && v?.id === path.basename(soloOld), JSON.stringify(fs.readdirSync(backupsDir)));
    res = await post('/api/file/restore', { filePath: SOLO, projectPath: C, id: v?.id, expectedMtimeMs: fs.statSync(SOLO).mtimeMs });
    check('putting it back is refused, saying why, and the file is untouched',
      res.status === 400 && /before backup names changed/.test(res.body.error || '') && fs.readFileSync(SOLO, 'utf8') === '# solo now\n',
      `${res.status} ${JSON.stringify(res.body)}`);

    // the case that made renaming wrong: the look-alike file is gone, and
    // the one still there must not come to own its history
    const forA = await versionsOf(A, path.join(C, 'a'));
    const forB = await versionsOf(B, C);
    const oldOf = (list) => list.versions.filter((x) => x.legacy).map((x) => x.id);
    check('an old name two files could own is shown to both, marked, and restorable for neither',
      JSON.stringify(oldOf(forA)) === JSON.stringify([path.basename(shared)]) &&
      JSON.stringify(oldOf(forB)) === JSON.stringify([path.basename(shared)]) &&
      [...forA.versions, ...forB.versions].every((x) => x.legacy ? x.restorable === false : x.restorable === true) &&
      forA.versions[0] && !forA.versions[0].legacy,
      JSON.stringify([forA.versions, forB.versions]));
    const bWas = fs.readFileSync(B, 'utf8');
    fs.rmSync(path.dirname(B), { recursive: true, force: true });
    await versionsOf(A, path.join(C, 'a'));
    check('and with one of them deleted, it is still not handed to the other',
      fs.existsSync(shared) && fs.readdirSync(backupsDir).filter((n) => n.includes('CLAUDE.md') && n.startsWith('%') && n.includes('2020-01-02')).length === 0,
      JSON.stringify(fs.readdirSync(backupsDir)));
    w(B, bWas);
    res = await post('/api/file/restore', {
      filePath: B, projectPath: C, id: path.basename(shared), expectedMtimeMs: fs.statSync(B).mtimeMs,
    });
    check('nor can it be put back into either of them by naming it',
      res.status === 400 && fs.readFileSync(B, 'utf8') === 'B original\n', `${res.status} ${JSON.stringify(res.body)}`);

    // pruned as a file of its own: the old copies never cost a file its newest
    for (let i = 0; i < 24; i++) w(legacy(SOLO, `2020-02-${String(i + 1).padStart(2, '0')}T00-00-00-000Z`), 'x'.repeat(5000));
    process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET = String(30000);
    res = await saveTo(SOLO, '# solo, saved\n', C);
    delete process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET;
    const after = (await versionsOf(SOLO, C)).versions;
    const olds = after.filter((x) => x.legacy);
    check('old-style copies are pruned as their own group, and the newest new-style copy survives the budget',
      res.status === 200 && after[0] && !after[0].legacy && after[0].restorable === true &&
      olds.length >= 1 && olds.length <= 20 && olds.some((x) => x.id.includes('2020-02-24')),
      `${res.status} ${after.length} ${olds.length} ${JSON.stringify(after[0])}`);
  }

  // A path too deep to spell out in a copy's name: the spelled-out form is
  // longer than the old one, so a save that used to work failed on the copy.
  {
    let deep = C;
    while (Buffer.byteLength(path.join(deep, 'CLAUDE.md').replace(/[\\/]/g, '__')) + 29 < 245) deep = path.join(deep, 'abcd');
    const DEEP = path.join(deep, 'CLAUDE.md');
    const TWIN = path.join(deep, 'abcd', 'CLAUDE.md'); // the same tail, a different file
    w(DEEP, '# deep\n');
    w(TWIN, '# twin\n');
    res = await saveTo(DEEP, '# deep, saved\n', deep);
    const list = await versionsOf(DEEP, deep);
    const id = list.versions?.[0]?.id || '';
    check('a file too deep to spell out in a copy\'s name still saves, and lists the copy it kept',
      res.status === 200 && list.versions?.length === 1 && Buffer.byteLength(id) <= 200 && id.endsWith(STAMP.exec(id)?.[0] || '!') &&
      fs.readFileSync(path.join(backupsDir, id), 'utf8') === '# deep\n', `${res.status} ${JSON.stringify(res.body)} ${id}`);
    res = await saveTo(TWIN, '# twin, saved\n', deep);
    const twin = await versionsOf(TWIN, deep);
    check('and a different deep file gets copies of its own, not the first one\'s',
      res.status === 200 && twin.versions?.length === 1 && twin.versions[0].id !== id &&
      (await versionsOf(DEEP, deep)).versions.length === 1, JSON.stringify([id, twin.versions]));
    res = await post('/api/file/restore', { filePath: TWIN, projectPath: deep, id, expectedMtimeMs: fs.statSync(TWIN).mtimeMs });
    check('nor can the first one\'s copy be put back into it',
      res.status === 400 && fs.readFileSync(TWIN, 'utf8') === '# twin, saved\n', `${res.status} ${JSON.stringify(res.body)}`);
    fs.rmSync(path.join(C, 'abcd'), { recursive: true, force: true });
  }

  // A copy that cannot be made fails the write before the file is touched.
  {
    const realCopy = fs.copyFileSync;
    fs.copyFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    const was = fs.readFileSync(projectMd, 'utf8');
    res = await saveTo(projectMd, '# not without a copy\n');
    fs.copyFileSync = realCopy;
    check('a write whose copy cannot be taken is refused with the reason, and the file is untouched',
      res.status >= 400 && /Could not keep a copy/.test(res.body.error || '') && /ENOSPC/.test(res.body.error || '') &&
      fs.readFileSync(projectMd, 'utf8') === was && !fs.readdirSync(PROJECT).some((n) => n.includes('.tmp-')),
      `${res.status} ${JSON.stringify(res.body)}`);
  }

  // A version goes back byte for byte: reading it as text first turned a file
  // that is not UTF-8 into replacement characters.
  {
    const original = Buffer.from('caf\xe9 r\xe9sum\xe9\r\n', 'latin1');
    fs.writeFileSync(projectMd, original);
    res = await post('/api/file/save', {
      filePath: projectMd, projectPath: PROJECT, content: '# new\n', expectedMtimeMs: fs.statSync(projectMd).mtimeMs,
    });
    const id = (await versionsOf(projectMd)).versions[0].id;
    res = await post('/api/file/restore', { filePath: projectMd, projectPath: PROJECT, id, expectedMtimeMs: fs.statSync(projectMd).mtimeMs });
    check('putting back a version of a file that is not UTF-8 restores the same bytes',
      res.status === 200 && fs.readFileSync(projectMd).equals(original), fs.readFileSync(projectMd).toString('hex'));
    w(projectMd, '# project rules\n');
  }

  // Something else writing the file while its copy is being taken: the rename
  // used to go ahead and throw that write away.
  {
    const realCopy = fs.copyFileSync;
    const theirs = '# written by a Claude Code session in the meantime\n';
    fs.copyFileSync = (from, to, ...rest) => {
      const r = realCopy(from, to, ...rest);
      if (String(from) === projectMd) realWrite(projectMd, theirs);
      return r;
    };
    res = await saveTo(projectMd, '# mine\n');
    fs.copyFileSync = realCopy;
    check('a write that lands while the copy is being taken is not thrown away',
      res.status === 409 && fs.readFileSync(projectMd, 'utf8') === theirs, `${res.status} ${JSON.stringify(res.body)}`);
    check('and the temporary file is cleared up',
      !fs.readdirSync(PROJECT).some((n) => n.includes('.tmp-')), JSON.stringify(fs.readdirSync(PROJECT)));
    w(projectMd, '# project rules\n');
  }

  // Over the total, space comes back from the file using the most of it: going
  // oldest-first across every file let one big file wipe out the others' history.
  {
    fs.rmSync(backupsDir, { recursive: true, force: true });
    for (let i = 0; i < 4; i++) await saveTo(projectMd, `# small ${i}\n`);
    const big = (i) => JSON.stringify({ pad: 'x'.repeat(40000), i }) + '\n';
    for (let i = 0; i < 6; i++) await saveTo(PROJECT_SETTINGS, big(i));
    process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET = String(3 * 41000);
    await saveTo(PROJECT_SETTINGS, big(6));
    delete process.env.CLAUDE_DASHBOARD_BACKUP_BUDGET;
    const small = (await versionsOf(projectMd)).versions;
    const bigOnes = (await versionsOf(PROJECT_SETTINGS)).versions;
    check('a budget that bites takes from the file using the most space, not every file\'s oldest',
      small.length === 4 && bigOnes.length >= 1 && bigOnes.length < 7, `small ${small.length}, big ${bigOnes.length}`);
    w(projectMd, '# project rules\n');
    w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));
  }

  // A key holding the wrong kind of value was replaced, so what it held was lost.
  {
    w(PROJECT_SETTINGS, JSON.stringify({ permissions: { allow: 'Bash(ls:*)' } }, null, 2));
    const was = fs.readFileSync(PROJECT_SETTINGS, 'utf8');
    res = await post('/api/file/permission', {
      filePath: PROJECT_SETTINGS, projectPath: PROJECT, group: 'allow', rule: 'Bash(cat:*)', action: 'add',
    });
    check('adding a rule to a group that is not a list is refused, and the file is left alone',
      res.status === 400 && /permissions\.allow/.test(res.body.error || '') && fs.readFileSync(PROJECT_SETTINGS, 'utf8') === was,
      `${res.status} ${JSON.stringify(res.body)}`);
    w(PROJECT_SETTINGS, JSON.stringify({ permissions: [] }, null, 2));
    res = await post('/api/file/permission', {
      filePath: PROJECT_SETTINGS, projectPath: PROJECT, group: 'deny', rule: 'Bash(rm:*)', action: 'add',
    });
    check('and so is adding one where "permissions" itself is not a set of groups',
      res.status === 400 && Array.isArray(readJson(PROJECT_SETTINGS).permissions), `${res.status} ${JSON.stringify(res.body)}`);
    w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));

    const claudeJson = path.join(HOME, '.claude.json');
    const keptJson = fs.readFileSync(claudeJson, 'utf8');
    const proj = fs.realpathSync(PROJECT);
    const d = JSON.parse(keptJson);
    d.mcpServers = { roamer: { command: 'roam' } };
    d.projects = { ...(d.projects || {}), [proj]: { ...(d.projects?.[proj] || {}), mcpServers: 'oops' } };
    w(claudeJson, JSON.stringify(d, null, 2));
    const before = fs.readFileSync(claudeJson, 'utf8');
    res = await post('/api/mcp/move', { name: 'roamer', to: 'project', projectPath: PROJECT });
    check('moving a connection into a list that is not a set of entries is refused, and it is not lost',
      res.status === 400 && fs.readFileSync(claudeJson, 'utf8') === before, `${res.status} ${JSON.stringify(res.body)}`);
    w(claudeJson, JSON.stringify({ ...JSON.parse(keptJson), mcpServers: [{ name: 'listed' }] }, null, 2));
    const asList = fs.readFileSync(claudeJson, 'utf8');
    res = await post('/api/toggle/mcp-user', { name: 'listed', enabled: false });
    check('switching off a connection where "mcpServers" is a list is refused, not reported as done',
      res.status === 400 && /mcpServers/.test(res.body.error || '') && fs.readFileSync(claudeJson, 'utf8') === asList,
      `${res.status} ${JSON.stringify(res.body)}`);
    w(claudeJson, keptJson);
    fs.chmodSync(claudeJson, 0o600);
  }

  // A project whose .claude folder is a link to the global one: a switch that
  // says "this project" wrote the settings every project reads.
  {
    const REPO = path.join(SANDBOX, 'repo-linked-claude');
    w(path.join(REPO, 'CLAUDE.md'), '# cloned\n');
    fs.symlinkSync(path.join(HOME, '.claude'), path.join(REPO, '.claude'));
    const globalWas = fs.readFileSync(GLOBAL_SETTINGS, 'utf8');
    res = await post('/api/toggle/plugin', { projectPath: REPO, key: 'demo@market', enabled: false, scope: 'project' });
    check('a "this project" switch through a linked .claude folder is refused, and the global file untouched',
      res.status === 400 && /every project reads/.test(res.body.error || '') && fs.readFileSync(GLOBAL_SETTINGS, 'utf8') === globalWas,
      `${res.status} ${JSON.stringify(res.body)}`);
    res = await post('/api/toggle/plugin', { projectPath: REPO, key: 'demo@market', clear: true, scope: 'project' });
    check('and so is clearing a project override through it',
      res.status === 400 && fs.readFileSync(GLOBAL_SETTINGS, 'utf8') === globalWas, `${res.status} ${JSON.stringify(res.body)}`);
    const globalSkill = path.join(HOME, '.claude', 'skills', 'tidy', 'SKILL.md');
    refused = null;
    try {
      toggle.toggleFile({ filePath: path.join(REPO, '.claude', 'skills', 'tidy', 'SKILL.md'), enabled: false, projectPath: REPO });
    } catch (err) { refused = err; }
    check('and a "project" skill that is really a global one is not switched off',
      refused?.statusCode === 400 && fs.existsSync(globalSkill), refused?.message);
    fs.rmSync(REPO, { recursive: true, force: true });

    // the file itself being a link: still fine into a dotfiles repo, refused into ~/.claude
    const P3 = path.join(SANDBOX, 'linked-file-proj');
    w(path.join(P3, 'CLAUDE.md'), '# p3\n');
    fs.mkdirSync(path.join(P3, '.claude'), { recursive: true });
    const P3S = path.join(P3, '.claude', 'settings.json');
    fs.symlinkSync(GLOBAL_SETTINGS, P3S);
    res = await post('/api/toggle/plugin', { projectPath: P3, key: 'demo@market', enabled: false, scope: 'project' });
    check('a project settings file that is a link to the global one is refused too',
      res.status === 400 && fs.readFileSync(GLOBAL_SETTINGS, 'utf8') === globalWas, `${res.status} ${JSON.stringify(res.body)}`);
    fs.unlinkSync(P3S);
    const p3Dotfile = path.join(HOME, 'dotfiles', 'p3-settings.json');
    w(p3Dotfile, JSON.stringify({}, null, 2));
    fs.symlinkSync(p3Dotfile, P3S);
    res = await post('/api/toggle/plugin', { projectPath: P3, key: 'demo@market', enabled: false, scope: 'project' });
    check('but one linked into a dotfiles repo is still written through, and stays a link',
      res.status === 200 && readJson(p3Dotfile).enabledPlugins?.['demo@market'] === false && fs.lstatSync(P3S).isSymbolicLink(),
      `${res.status} ${JSON.stringify(res.body)}`);
    fs.rmSync(P3, { recursive: true, force: true });

    // the editor: a subfolder that is a link out of the project
    const OUT = path.join(SANDBOX, 'outside-target');
    w(path.join(OUT, 'CLAUDE.md'), '# lives outside\n');
    const P4 = path.join(SANDBOX, 'linked-sub-proj');
    w(path.join(P4, 'CLAUDE.md'), '# p4\n');
    fs.symlinkSync(OUT, path.join(P4, 'pkg'));
    const linkedMd = path.join(P4, 'pkg', 'CLAUDE.md');
    const opened = await readFile(linkedMd, P4);
    check('a file in a folder that links out of the project opens read-only, saying why',
      opened.writable === false && /outside this project/.test(opened.readOnlyReason || ''), JSON.stringify(opened).slice(0, 240));
    res = await post('/api/file/save', { filePath: linkedMd, projectPath: P4, content: 'PWNED\n', expectedMtimeMs: opened.mtimeMs });
    check('and saving it is refused, leaving the file it really is alone',
      res.status === 400 && fs.readFileSync(path.join(OUT, 'CLAUDE.md'), 'utf8') === '# lives outside\n',
      `${res.status} ${JSON.stringify(res.body)}`);
    // the same project named through a link of its own: the paths the page
    // sends are built from where the project really is, not from that name
    const P4_ALIAS = path.join(SANDBOX, 'linked-sub-alias');
    fs.symlinkSync(P4, P4_ALIAS);
    res = await post('/api/file/save', { filePath: linkedMd, projectPath: P4_ALIAS, content: 'PWNED\n', expectedMtimeMs: opened.mtimeMs });
    check('and so is a save naming the project through a link',
      res.status === 400 && /outside this project/.test(res.body.error || '') &&
      fs.readFileSync(path.join(OUT, 'CLAUDE.md'), 'utf8') === '# lives outside\n', `${res.status} ${JSON.stringify(res.body)}`);
    fs.unlinkSync(P4_ALIAS);
    fs.rmSync(P4, { recursive: true, force: true });

    // A skill or subagent folder linked in from elsewhere is how one is shared,
    // so a switch or a save changes it where it really lives — refusing made
    // both buttons fail. But a cloned repo can ship that link pointed at any
    // folder of yours, so each write or rename out of the project through it
    // needs a confirmation naming that exact location, checked by the server.
    // Into ~/.claude stays refused, confirmed or not.
    const P7 = path.join(SANDBOX, 'linked-skill-proj');
    const SHARED = path.join(SANDBOX, 'shared-skills', 'roam');
    const SHARED_MD = path.join(SHARED, 'SKILL.md');
    w(path.join(P7, 'CLAUDE.md'), '# p7\n');
    w(SHARED_MD, '---\nname: roam\ndescription: shared\n---\nbody\n');
    fs.mkdirSync(path.join(P7, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(SHARED, path.join(P7, '.claude', 'skills', 'roam'));
    fs.symlinkSync(path.join(HOME, '.claude', 'skills', 'tidy'), path.join(P7, '.claude', 'skills', 'tidy'));
    // and one whose link stays inside the project: nothing to ask
    w(path.join(P7, 'vendored', 'near', 'SKILL.md'), '---\nname: near\ndescription: vendored\n---\nbody\n');
    fs.symlinkSync(path.join('..', '..', 'vendored', 'near'), path.join(P7, '.claude', 'skills', 'near'));
    const p7Skills = (await inventory(P7)).skills;
    const roam = p7Skills.find((x) => x.name === 'roam' && x.scope === 'project');
    const shownRoam = await readFile(roam?.path || '', P7);
    check('a project skill folder linked in from outside the project opens writable',
      !!roam?.symlink && shownRoam.writable === true, JSON.stringify(shownRoam).slice(0, 200));
    const edit = (confirmLinked) => post('/api/file/save', {
      filePath: roam?.path, projectPath: P7, content: '---\nname: roam\ndescription: edited\n---\n', expectedMtimeMs: shownRoam.mtimeMs,
      ...(confirmLinked === undefined ? {} : { confirmLinked }),
    });
    const sharedWas = fs.readFileSync(SHARED_MD, 'utf8');
    res = await edit();
    check('but saving it unconfirmed is refused as a question (409, confirm-linked) naming where it really lives, and nothing is written',
      res.status === 409 && res.body.code === 'confirm-linked' && res.body.linkTarget === SHARED_MD &&
      res.body.error.includes(SHARED_MD) && fs.readFileSync(SHARED_MD, 'utf8') === sharedWas,
      `${res.status} ${JSON.stringify(res.body)}`);
    res = await edit(path.join(HOME, 'Documents', 'SKILL.md'));
    check('a confirmation naming some other location does not let it through',
      res.status === 409 && res.body.code === 'confirm-linked' && fs.readFileSync(SHARED_MD, 'utf8') === sharedWas,
      `${res.status} ${JSON.stringify(res.body)}`);
    res = await edit(roam?.path);
    check('nor does one naming the path as the page lists it, rather than where it really is',
      res.status === 409 && fs.readFileSync(SHARED_MD, 'utf8') === sharedWas, `${res.status} ${JSON.stringify(res.body)}`);
    res = await edit(SHARED_MD);
    check('confirmed with that exact location, it saves where it really lives',
      res.status === 200 && /edited/.test(fs.readFileSync(SHARED_MD, 'utf8')), `${res.status} ${JSON.stringify(res.body)}`);
    // putting the earlier version back writes there too, so it asks the same
    const roamVersions = (await get(`/api/file/backups?path=${encodeURIComponent(roam?.path || '')}&project=${encodeURIComponent(P7)}`)).body;
    const restoreBody = { filePath: roam?.path, projectPath: P7, id: roamVersions.versions?.[0]?.id, expectedMtimeMs: fs.statSync(SHARED_MD).mtimeMs };
    check('its versions are listed as restorable — the question comes when one is put back', roamVersions.restorable === true && roamVersions.versions?.length >= 1,
      JSON.stringify(roamVersions));
    res = await post('/api/file/restore', restoreBody);
    check('putting an earlier version back unconfirmed is refused the same way',
      res.status === 409 && res.body.code === 'confirm-linked' && res.body.linkTarget === SHARED_MD && /edited/.test(fs.readFileSync(SHARED_MD, 'utf8')),
      `${res.status} ${JSON.stringify(res.body)}`);
    res = await post('/api/file/restore', { ...restoreBody, confirmLinked: SHARED_MD });
    check('and goes through confirmed', res.status === 200 && fs.readFileSync(SHARED_MD, 'utf8') === sharedWas, `${res.status} ${JSON.stringify(res.body)}`);
    res = await post('/api/toggle/file', { filePath: roam?.path, projectPath: P7, enabled: false });
    check('switching it off unconfirmed is refused, and the file stays where it is',
      res.status === 409 && res.body.code === 'confirm-linked' && res.body.linkTarget === SHARED_MD && fs.existsSync(SHARED_MD) && !fs.existsSync(SHARED_MD + '.disabled'),
      `${res.status} ${JSON.stringify(res.body)}`);
    res = await post('/api/toggle/file', { filePath: roam?.path, projectPath: P7, enabled: false, confirmLinked: SHARED_MD });
    check('confirmed, switching it off renames the file where it really lives',
      res.status === 200 && fs.existsSync(SHARED_MD + '.disabled') && !fs.existsSync(SHARED_MD),
      `${res.status} ${JSON.stringify(res.body)}`);
    res = await post('/api/toggle/file', { filePath: roam?.path + '.disabled', projectPath: P7, enabled: true, confirmLinked: SHARED_MD });
    check('switching it back on asks again, for the file that is there now (the switched-off name)',
      res.status === 409 && res.body.linkTarget === SHARED_MD + '.disabled' && fs.existsSync(SHARED_MD + '.disabled'),
      `${res.status} ${JSON.stringify(res.body)}`);
    res = await post('/api/toggle/file', { filePath: roam?.path + '.disabled', projectPath: P7, enabled: true, confirmLinked: SHARED_MD + '.disabled' });
    check('and goes through confirmed', res.status === 200 && fs.existsSync(SHARED_MD), `${res.status} ${JSON.stringify(res.body)}`);
    const near = p7Skills.find((x) => x.name === 'near' && x.scope === 'project');
    const shownNear = await readFile(near?.path || '', P7);
    res = await post('/api/file/save', { filePath: near?.path, projectPath: P7, content: '---\nname: near\ndescription: edited\n---\n', expectedMtimeMs: shownNear.mtimeMs });
    check('a skill folder linked to somewhere else inside the project saves without asking',
      !!near?.symlink && res.status === 200 && /edited/.test(fs.readFileSync(path.join(P7, 'vendored', 'near', 'SKILL.md'), 'utf8')),
      `${res.status} ${JSON.stringify(res.body)}`);
    const tidyRow = p7Skills.find((x) => x.name === 'tidy' && x.scope === 'project');
    res = await post('/api/toggle/file', { filePath: tidyRow?.path, projectPath: P7, enabled: false, confirmLinked: globalSkill });
    check('but one linked into the global .claude folder is still refused, confirmation or not, and the global skill stays on',
      !!tidyRow && res.status === 400 && /every project reads/.test(res.body.error || '') && fs.existsSync(globalSkill),
      `${res.status} ${JSON.stringify(res.body)}`);
    // a cloned repo's whole agents folder pointed at a folder of your own
    const DOCS = path.join(HOME, 'Documents');
    w(path.join(DOCS, 'diary.md'), 'my private diary\n');
    fs.symlinkSync(path.join('..', '..', 'home', 'Documents'), path.join(P7, '.claude', 'agents'));
    const diary = (await inventory(P7)).agents.find((a) => a.path.endsWith(`${path.sep}diary.md`));
    const shownDiary = await readFile(diary?.path || '', P7);
    res = await post('/api/file/save', { filePath: diary?.path, projectPath: P7, content: 'overwritten\n', expectedMtimeMs: shownDiary.mtimeMs });
    const off = await post('/api/toggle/file', { filePath: diary?.path, projectPath: P7, enabled: false });
    check('a project agents folder linked to a folder of yours: saving and switching off both ask first, naming the real file, and change nothing',
      !!diary && res.status === 409 && res.body.linkTarget === path.join(DOCS, 'diary.md') && off.status === 409 &&
      off.body.linkTarget === path.join(DOCS, 'diary.md') && fs.readFileSync(path.join(DOCS, 'diary.md'), 'utf8') === 'my private diary\n' &&
      !fs.existsSync(path.join(DOCS, 'diary.md.disabled')),
      `${res.status} ${JSON.stringify(res.body)} ${off.status} ${JSON.stringify(off.body)}`);
    fs.rmSync(DOCS, { recursive: true, force: true });

    // The global folder under a second spelling that is already "real" — a bind
    // mount here; on macOS a different case on a disk that ignores case, or
    // /System/Volumes/Data. Comparing resolved paths as text let a project's
    // skills folder linked to that spelling overwrite a global skill as "this
    // project". Making the second spelling needs a bind mount, which needs
    // root, so that part runs only where it can; the walk itself is checked
    // below with an injected stat that says the alias is the global folder.
    const GLOBAL_DIR = path.join(HOME, '.claude');
    const ALIAS = path.join(SANDBOX, 'alias-of-dot-claude');
    const fakeStat = (p2) => {
      if (p2 === ALIAS) return fs.statSync(GLOBAL_DIR);
      return fs.statSync(p2);
    };
    check('the global-folder test goes by what a folder is: a second spelling of it counts, and every folder below it',
      toggle.isInGlobalFolder(path.join(ALIAS, 'skills', 'tidy', 'SKILL.md'), GLOBAL_DIR, fakeStat) &&
      toggle.isInGlobalFolder(ALIAS, GLOBAL_DIR, fakeStat) &&
      toggle.isInGlobalFolder(path.join(GLOBAL_DIR, 'skills'), GLOBAL_DIR) &&
      !toggle.isInGlobalFolder(path.join(SANDBOX, 'shared-skills'), GLOBAL_DIR, fakeStat) &&
      !toggle.isInGlobalFolder(path.join(ALIAS, 'x'), GLOBAL_DIR));
    fs.mkdirSync(ALIAS);
    let mounted = false;
    try {
      childProcess.execFileSync('mount', ['--bind', GLOBAL_DIR, ALIAS], { stdio: 'ignore' });
      mounted = true;
    } catch { /* not root, or no mount here */ }
    if (mounted) {
      try {
        const P8 = path.join(SANDBOX, 'alias-skill-proj');
        w(path.join(P8, 'CLAUDE.md'), '# p8\n');
        fs.mkdirSync(path.join(P8, '.claude'), { recursive: true });
        fs.symlinkSync(path.join(ALIAS, 'skills'), path.join(P8, '.claude', 'skills'));
        const aliasRow = (await inventory(P8)).skills.find((x) => x.name === 'tidy' && x.scope === 'project');
        const shownAlias = await readFile(aliasRow?.path || '', P8);
        const globalWasText = fs.readFileSync(globalSkill, 'utf8');
        res = await post('/api/file/save', {
          filePath: aliasRow?.path, projectPath: P8, content: 'WRITTEN AS THIS PROJECT\n', expectedMtimeMs: shownAlias.mtimeMs,
          confirmLinked: path.join(ALIAS, 'skills', 'tidy', 'SKILL.md'),
        });
        check('a project skills folder linked to the global folder under a second spelling (bind mount) is refused, confirmed or not',
          !!aliasRow && res.status === 400 && /every project reads/.test(res.body.error || '') && fs.readFileSync(globalSkill, 'utf8') === globalWasText,
          `${res.status} ${JSON.stringify(res.body)}`);
        fs.rmSync(P8, { recursive: true, force: true });
      } finally {
        childProcess.execFileSync('umount', [ALIAS], { stdio: 'ignore' });
      }
    } else {
      console.log('note  no bind mount here (needs root): the second-spelling save is checked only through the injected stat above');
    }
    fs.rmdirSync(ALIAS);
    fs.rmSync(P7, { recursive: true, force: true });
    fs.rmSync(path.dirname(SHARED), { recursive: true, force: true });
  }

  // Answers say what kind of "no" they are.
  {
    const now = await readFile(projectMd);
    await post('/api/file/save', { filePath: projectMd, projectPath: PROJECT, content: '# one\n', expectedMtimeMs: now.mtimeMs });
    res = await post('/api/file/save', { filePath: projectMd, projectPath: PROJECT, content: '# two\n', expectedMtimeMs: now.mtimeMs });
    check('a save against a file that changed meanwhile is a conflict (409)', res.status === 409, `${res.status} ${JSON.stringify(res.body)}`);
    res = await post('/api/file/permission', { filePath: PROJECT_SETTINGS, projectPath: PROJECT, group: 'nonsense', rule: 'x', action: 'add' });
    check('a request that makes no sense is a bad request (400), not a server failure', res.status === 400, `${res.status}`);
    res = await post('/api/file/save', { filePath: path.join(HOME, 'nothing-to-see'), projectPath: PROJECT, content: 'x', expectedMtimeMs: null });
    check('and so is asking for a file the dashboard is not showing', res.status === 400, `${res.status}`);
    w(projectMd, '# project rules\n');
  }

  // The checks below are each the only thing that notices if one line goes.
  {
    // the content-type rule on its own, with a body that is valid JSON
    const settingsWas = fs.readFileSync(PROJECT_SETTINGS, 'utf8');
    const plain = await fetch(BASE + '/api/toggle/plugin', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: BASE, ...T },
      body: JSON.stringify({ projectPath: PROJECT, key: 'demo@market', enabled: false, scope: 'project' }),
    });
    check('a switch sent as plain text is refused even when the body is valid JSON',
      plain.status === 400 && fs.readFileSync(PROJECT_SETTINGS, 'utf8') === settingsWas, `${plain.status}`);

    // permissions carried over, past the umask
    const oldMask = process.umask(0o022);
    fs.chmodSync(PROJECT_SETTINGS, 0o664);
    res = await post('/api/toggle/plugin', { projectPath: PROJECT, key: 'demo@market', enabled: false, scope: 'project' });
    check('a written file keeps permissions the umask would otherwise strip',
      res.status === 200 && (fs.statSync(PROJECT_SETTINGS).mode & 0o777) === 0o664, (fs.statSync(PROJECT_SETTINGS).mode & 0o777).toString(8));
    w(PROJECT_SETTINGS, JSON.stringify({}, null, 2));

    const fresh = path.join(PROJECT, '.claude', 'settings.local.json');
    fs.rmSync(fresh, { force: true });
    res = await post('/api/file/save', { filePath: fresh, projectPath: PROJECT, content: '{}\n', expectedMtimeMs: null });
    check('a file created here is readable by you alone',
      res.status === 200 && (fs.statSync(fresh).mode & 0o777) === 0o600, (fs.statSync(fresh).mode & 0o777).toString(8));
    fs.rmSync(fresh, { force: true });

    // a backup folder left open by an older version is locked down by the next write
    const dash = path.dirname(backupsDir);
    fs.rmSync(backupsDir, { recursive: true, force: true });
    fs.chmodSync(dash, 0o755);
    fs.mkdirSync(backupsDir, { mode: 0o755 });
    fs.chmodSync(backupsDir, 0o755);
    res = await saveTo(projectMd, '# locks the folder\n');
    check('a backup folder that was left open is made private again',
      res.status === 200 && (fs.statSync(dash).mode & 0o777) === 0o700 && (fs.statSync(backupsDir).mode & 0o777) === 0o700,
      `${(fs.statSync(dash).mode & 0o777).toString(8)} / ${(fs.statSync(backupsDir).mode & 0o777).toString(8)}`);
    // and one made fresh is private from the start, even when it cannot be chmodded
    fs.rmSync(backupsDir, { recursive: true, force: true });
    const realChmod2 = fs.chmodSync;
    fs.chmodSync = (p2, m) => {
      if (String(p2).includes('.claude-context-dashboard')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return realChmod2(p2, m);
    };
    res = await saveTo(projectMd, '# a fresh folder\n');
    fs.chmodSync = realChmod2;
    check('a backup folder is created private, not only made so afterwards',
      res.status === 200 && (fs.statSync(backupsDir).mode & 0o777) === 0o700, (fs.statSync(backupsDir).mode & 0o777).toString(8));
    process.umask(oldMask);
    w(projectMd, '# project rules\n');

    // a plugin's file reached by an "@" line is on the editable list, which is
    // why the plugin-cache refusal is there at all
    const P5 = path.join(SANDBOX, 'imports-plugin');
    const spec = '~/' + path.relative(HOME, pluginSkill).split(path.sep).join('/');
    w(path.join(P5, 'CLAUDE.md'), `# p5\n@${spec}\n`);
    const pluginText = fs.readFileSync(pluginSkill, 'utf8');
    const viaImport = await readFile(pluginSkill, P5);
    check('a plugin\'s file pulled in by an @ line opens read-only, and says it is the plugin\'s',
      viaImport.writable === false && /belongs to a plugin/.test(viaImport.readOnlyReason || ''), JSON.stringify(viaImport).slice(0, 240));
    res = await post('/api/file/save', { filePath: pluginSkill, projectPath: P5, content: 'changed\n', expectedMtimeMs: viaImport.mtimeMs });
    check('and saving it is refused',
      res.status === 400 && /belongs to a plugin/.test(res.body.error || '') && fs.readFileSync(pluginSkill, 'utf8') === pluginText,
      `${res.status} ${JSON.stringify(res.body)}`);
    fs.rmSync(P5, { recursive: true, force: true });

    // an "@" line reaching out of the project and the global .claude folder
    const P6 = path.join(SANDBOX, 'imports-outside');
    const elsewhereDoc = path.join(SANDBOX, 'not-a-project', 'shared-notes.md');
    w(elsewhereDoc, '# someone else\'s notes\n');
    w(path.join(P6, 'CLAUDE.md'), `# p6\n@${elsewhereDoc}\n`);
    const outsideRead = await readFile(elsewhereDoc, P6);
    check('a file an @ line pulls in from outside the project opens read-only, and says that is why',
      outsideRead.writable === false && /outside this project/.test(outsideRead.readOnlyReason || '') &&
      !/not showing/.test(outsideRead.readOnlyReason || ''), JSON.stringify(outsideRead).slice(0, 240));
    res = await post('/api/file/save', { filePath: elsewhereDoc, projectPath: P6, content: 'x\n', expectedMtimeMs: outsideRead.mtimeMs });
    check('and its save is refused for that same reason',
      res.status === 400 && /outside this project/.test(res.body.error || '') &&
      fs.readFileSync(elsewhereDoc, 'utf8') === '# someone else\'s notes\n', `${res.status} ${JSON.stringify(res.body)}`);
    fs.rmSync(P6, { recursive: true, force: true });
    fs.rmSync(path.dirname(elsewhereDoc), { recursive: true, force: true });
  }
  fs.rmSync(C, { recursive: true, force: true });
}

server.close();
if (failures) {
  // keep the sandbox so the failure can be inspected
  console.log(`\n${failures} FAILURE(S)`);
  console.log('sandbox left in place:', SANDBOX);
} else {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`\nall ${checksRun} checks passed`);
}
process.exit(failures ? 1 : 0);
