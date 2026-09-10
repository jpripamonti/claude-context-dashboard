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
const { createServer } = await import('../src/server.js');
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
let restartsAsked = 0;
const server = createServer(PROJECT, PORT, { onRestart: () => { restartsAsked++; } });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const BASE = `http://127.0.0.1:${PORT}`;
const H = { 'Content-Type': 'application/json', Origin: BASE, Host: `127.0.0.1:${PORT}` };
const post = async (p, body) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (p) => {
  const res = await fetch(BASE + p, { headers: { Origin: BASE } });
  return { status: res.status, body: await res.json() };
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const inventory = async (p = PROJECT) => (await get(`/api/inventory?path=${encodeURIComponent(p)}`)).body;
const parkedFile = path.join(HOME, '.claude-context-dashboard', 'parked.json');

let failures = 0;
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
  await saveTo(projectMd, '# after the budget\n');
  const after = fs.readdirSync(backupsDir);
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
    headers: { 'Content-Type': 'text/plain', Origin: BASE },
    body: 'restart',
  });
  await new Promise((r) => setTimeout(r, 50));
  check('a post that is not JSON does not restart anything',
    notJson.status === 400 && restartsAsked === before + 1, `${notJson.status} restarts=${restartsAsked - before}`);

  const fromElsewhere = await fetch(BASE + '/api/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: '{}',
  });
  await new Promise((r) => setTimeout(r, 50));
  check('and neither does another page in the same browser',
    fromElsewhere.status === 403 && restartsAsked === before + 1, `${fromElsewhere.status} restarts=${restartsAsked - before}`);

  const asGet = await fetch(`${BASE}/api/restart`, { headers: { Origin: BASE } });
  await new Promise((r) => setTimeout(r, 50));
  check('and neither does merely visiting the address',
    asGet.status === 404 && restartsAsked === before + 1, `${asGet.status} restarts=${restartsAsked - before}`);
}

// --- CSRF -------------------------------------------------------------
const foreign = await fetch(BASE + '/api/file/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Host: `127.0.0.1:${PORT}` },
  body: JSON.stringify({ filePath: projectMd, projectPath: PROJECT, content: 'x' }),
});
check('foreign origin blocked on save', foreign.status === 403, foreign.status);
const foreignInv = await fetch(`${BASE}/api/inventory?path=${encodeURIComponent(PROJECT)}`, {
  headers: { Origin: 'http://evil.example' },
});
check('foreign origin blocked on the inventory too', foreignInv.status === 403, foreignInv.status);
// fetch() refuses to set Host, so this one needs a raw request
const http = await import('node:http');
const rawStatus = (headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/inventory', headers }, (r) => {
    r.resume();
    resolve(r.statusCode);
  });
  req.on('error', reject);
  req.end();
});
check('foreign host blocked', (await rawStatus({ Host: 'evil.example' })) === 403);
check('a rebinding hostname is blocked', (await rawStatus({ Host: `attacker.test:${PORT}` })) === 403);
check('the dashboard\'s own host is accepted', (await rawStatus({ Host: `localhost:${PORT}` })) === 200);

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
