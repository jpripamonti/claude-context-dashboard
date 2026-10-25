// The read-only scanner, against a throwaway HOME — the real ~/.claude,
// ~/.claude.json and ~/.claude-context-dashboard are never touched.
//
// Run with:  npm test
//
// Every check here exists because something was once wrong: a name in a file
// can point anywhere (a device that never ends, a file in your home folder),
// and a file of the wrong shape used to take the whole page down. Add to it
// rather than trimming it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-scan-test-')));
// HOME is a link to the real folder, as it is on machines where /home is a
// link: the scanner works from the resolved home, and the rule about which
// files may be changed has to hold under that spelling, not the link's.
const HOME_REAL = path.join(SANDBOX, 'home-real');
const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(HOME_REAL, { recursive: true });
fs.symlinkSync(HOME_REAL, HOME);
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const writeJson = (p, v) => w(p, JSON.stringify(v, null, 2));

// The global .claude folder is itself a link into a dotfiles repo, which is
// how many people keep it.
const DOTFILES_CLAUDE = path.join(SANDBOX, 'dotfiles', 'claude');
fs.mkdirSync(DOTFILES_CLAUDE, { recursive: true });
fs.symlinkSync(DOTFILES_CLAUDE, path.join(HOME_REAL, '.claude'));
const GLOBAL = path.join(HOME_REAL, '.claude');
const CLAUDE_JSON = path.join(HOME_REAL, '.claude.json');
const GLOBAL_SETTINGS = path.join(GLOBAL, 'settings.json');
const INSTALLED = path.join(GLOBAL, 'plugins', 'installed_plugins.json');
writeJson(CLAUDE_JSON, { mcpServers: {}, projects: {} });
w(path.join(HOME_REAL, '.bashrc'), 'ORIGINAL SHELL CONFIG\n');

// imported after HOME is redirected above, so the modules read the fake home
const scan = await import('../src/scan.js');
const toggle = await import('../src/toggle.js');
const { buildInventory, editablePathsFrom, viewablePathsFrom, listKnownProjects } = scan;

let failures = 0;
let checksRun = 0;
const check = (label, cond, detail) => {
  checksRun++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `  → ${detail ?? ''}`}`);
  if (!cond) failures++;
};
const attempt = (fn) => {
  try { return { value: fn(), error: null }; } catch (err) { return { value: null, error: err }; }
};

check('the sandbox is in effect: the home folder the scanner reads is the throwaway one',
  os.homedir() === HOME && scan.paths.GLOBAL_CLAUDE_DIR === GLOBAL && scan.paths.GLOBAL_CLAUDE_JSON === CLAUDE_JSON &&
  scan.paths.DASHBOARD_DIR.startsWith(SANDBOX + path.sep),
  JSON.stringify(scan.paths));

let n = 0;
const project = (files) => {
  const dir = path.join(SANDBOX, `proj-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) w(path.join(dir, rel), text);
  return dir;
};
const group = (inv, title) => inv.coverage.find((c) => c.title === title);
const importsOf = (inv, file) => inv.claudeMd.files.find((f) => f.path === file)?.importedFiles || [];

// --- names that are not ordinary files ----------------------------------
// "@/dev/zero" in a cloned repo's CLAUDE.md had the server read until it ran
// out of memory, and a pipe would wait for a writer forever. Run in a child
// with a time limit, so a regression fails this check instead of hanging the
// whole suite.
if (process.platform !== 'win32' && fs.existsSync('/dev/zero')) {
  const P = project({});
  let fifo = null;
  try {
    fifo = path.join(P, 'pipe.md');
    execFileSync('mkfifo', [fifo]);
    fs.symlinkSync(fifo, path.join(P, 'CLAUDE.local.md')); // an instructions file that is a pipe
  } catch { fifo = null; }
  w(path.join(P, 'CLAUDE.md'), `# rules\n@/dev/zero\n${fifo ? '@pipe.md\n' : ''}See /dev/zero.md too.\n`);
  const scanUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scan.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { buildInventory } = await import(${JSON.stringify(scanUrl)});
    const inv = buildInventory(${JSON.stringify(P)});
    const md = inv.claudeMd.files.find((f) => f.label === 'project');
    process.stdout.write(JSON.stringify({ imports: md.importedFiles, warnings: inv.warnings, files: inv.claudeMd.files.map((f) => f.path) }));
  `], { env: { ...process.env, HOME, USERPROFILE: HOME }, timeout: 20000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1 << 20 });
  const out = attempt(() => JSON.parse(child.stdout)).value;
  check('a CLAUDE.md with an @ line naming a device is scanned, rather than hanging the server',
    child.status === 0 && !!out, child.error ? String(child.error) : `${child.status} ${String(child.stderr).slice(0, 300)}`);
  const zero = out?.imports.find((i) => i.spec === '/dev/zero');
  check('and that line gets a row saying it is not an ordinary file and brings nothing',
    !!zero && zero.bytes === 0 && /not an ordinary file/.test(zero.error || ''), JSON.stringify(zero));
  if (fifo) {
    const pipe = out?.imports.find((i) => i.spec === 'pipe.md');
    check('an @ line naming a pipe gets the same row, instead of waiting for a writer forever',
      !!pipe && pipe.bytes === 0 && /a pipe/.test(pipe.error || ''), JSON.stringify(pipe));
    check('an instructions file that is a pipe is named in a warning, not silently left out',
      !!out && out.warnings.some((x) => x.path === path.join(P, 'CLAUDE.local.md') && /a pipe/.test(x.message)) &&
      !out.files.includes(path.join(P, 'CLAUDE.local.md')),
      JSON.stringify(out?.warnings));
  }
  if (out) {
    const inv = buildInventory(P);
    check('a device named by an @ line can be neither opened nor changed from the page',
      !viewablePathsFrom(inv).has('/dev/zero') && !editablePathsFrom(inv).has('/dev/zero'));
  }
  fs.rmSync(P, { recursive: true, force: true });
} else {
  console.log('skip  no /dev/zero on this machine — the device checks need one');
}

// --- files too large to read --------------------------------------------
{
  const cap = scan.MAX_TEXT_BYTES;
  const P = project({
    'CLAUDE.md': '# rules\n@big.md\n@edge.md\n',
    'big.md': 'x'.repeat(cap + 1),
    'edge.md': 'y'.repeat(cap),
  });
  const inv = buildInventory(P);
  const rows = importsOf(inv, path.join(P, 'CLAUDE.md'));
  const big = rows.find((i) => i.spec === 'big.md');
  const edge = rows.find((i) => i.spec === 'edge.md');
  check('an @ line naming a file over the ceiling gets a row saying it is too large, and weighs nothing',
    !!big && big.bytes === 0 && /over 2 MB/.test(big.error || ''), JSON.stringify(big));
  check('a file exactly at the ceiling is still read in full',
    !!edge && edge.bytes === cap && !edge.error, JSON.stringify(edge && { ...edge, path: undefined }));
  check('a file too large to read is not offered for opening or changing',
    !viewablePathsFrom(inv).has(path.join(P, 'big.md')) && editablePathsFrom(inv).has(path.join(P, 'edge.md')));
  fs.rmSync(P, { recursive: true, force: true });
}
{
  // an instructions file itself too large to read is warned about, and the
  // coverage list says it could not be read, rather than going quiet about it
  const P = project({ 'CLAUDE.md': 'z'.repeat(scan.MAX_TEXT_BYTES + 1) });
  const skill = path.join(P, '.claude', 'skills', 'huge', 'SKILL.md');
  w(skill, `---\ndescription: huge\n---\n${'s'.repeat(scan.MAX_TEXT_BYTES)}`);
  const inv = buildInventory(P);
  check('an instructions file too large to read is named in a warning at the top',
    inv.warnings.some((x) => x.path === path.join(P, 'CLAUDE.md') && /over 2 MB/.test(x.message) && /instructions file/.test(x.message)),
    JSON.stringify(inv.warnings));
  check('and is not listed as if it had been read', !inv.claudeMd.files.some((f) => f.path === path.join(P, 'CLAUDE.md')));
  const line = group(inv, 'Instructions files').looked.find((l) => l.startsWith(path.join(P, 'CLAUDE.md')));
  check('and the coverage list says it is there but could not be read',
    /CLAUDE\.md there could not be read/.test(line || ''), line);
  check('the coverage list states the ceiling as something it does not read',
    group(inv, 'Instructions files').notLooked.some((l) => /over 2 MB/.test(l) && /not an ordinary file/.test(l)),
    JSON.stringify(group(inv, 'Instructions files').notLooked));
  check('a skill file too large to read is warned about instead of vanishing from the list',
    inv.warnings.some((x) => x.path === skill && /over 2 MB/.test(x.message)) && !inv.skills.some((s) => s.path === skill),
    JSON.stringify(inv.warnings.map((x) => x.path)));
  fs.rmSync(P, { recursive: true, force: true });
}
{
  // ~/.claude.json legitimately grows large (Claude Code keeps history in it):
  // a ceiling sized for settings files would hide every connection
  const P = project({ 'CLAUDE.md': '# rules\n' });
  const padding = 'h'.repeat(scan.MAX_JSON_BYTES + 1024);
  writeJson(CLAUDE_JSON, { mcpServers: { big: { command: 'big' } }, projects: { [P]: { history: [padding] } } });
  const inv = buildInventory(P);
  check('a ~/.claude.json larger than any settings file may be is still read',
    fs.statSync(CLAUDE_JSON).size > scan.MAX_JSON_BYTES && inv.mcp.user.some((s) => s.name === 'big') &&
    !inv.warnings.some((x) => x.path === CLAUDE_JSON),
    JSON.stringify(inv.warnings));
  check('and the list of known projects still comes from it', listKnownProjects().includes(P));
  check('its own, larger ceiling is stated as such',
    scan.MAX_CLAUDE_JSON_BYTES > scan.MAX_JSON_BYTES &&
    group(inv, 'Tool connections (MCP)').notLooked.some((l) => l.startsWith(CLAUDE_JSON) && /256 MB/.test(l)),
    JSON.stringify(group(inv, 'Tool connections (MCP)').notLooked));
  writeJson(CLAUDE_JSON, { mcpServers: {}, projects: {} });

  // a settings file over its own ceiling is broken, and said to be
  w(GLOBAL_SETTINGS, `{"pad": "${'p'.repeat(scan.MAX_JSON_BYTES)}"}`);
  const inv2 = buildInventory(P);
  check('a settings file over its ceiling is warned about and treated as saying nothing',
    inv2.warnings.some((x) => x.path === GLOBAL_SETTINGS && /over 16 MB/.test(x.message)) &&
    inv2.settingsLayers.find((l) => l.path === GLOBAL_SETTINGS)?.broken === true,
    JSON.stringify(inv2.warnings));
  fs.unlinkSync(GLOBAL_SETTINGS);
  fs.rmSync(P, { recursive: true, force: true });
}

// --- files of the wrong shape stay in their own section -------------------
{
  const P = project({ 'CLAUDE.md': '# rules\n', '.mcp.json': JSON.stringify({ mcpServers: { shared1: { command: 'x' } } }) });
  const installDir = path.join(SANDBOX, 'plugin-good');
  writeJson(path.join(installDir, '.claude-plugin', 'plugin.json'), { description: 'good one' });
  writeJson(INSTALLED, {
    plugins: {
      'notalist@m': { scope: 'user', installPath: installDir },
      'nopath@m': [{ scope: 'user' }],
      'nullrecord@m': [null],
      'good@m': [{ scope: 'user', installPath: installDir, version: '1' }],
    },
  });
  writeJson(GLOBAL_SETTINGS, {
    enabledMcpjsonServers: 'shared1', // a string, where a list belongs
    hooks: { PreToolUse: [{ matcher: 'x', hooks: [null, { type: 'command', command: 'echo hi' }] }] },
  });
  writeJson(path.join(P, '.claude', 'settings.json'), { disabledMcpjsonServers: { shared1: true } }); // an object
  writeJson(CLAUDE_JSON, { mcpServers: ['not', 'a', 'map'], projects: { [P]: { enabledMcpjsonServers: 5 } } });

  const built = attempt(() => buildInventory(P));
  check('install records that are not a list, and a list of servers that is not a list, do not take the page down',
    !built.error, built.error && built.error.stack);
  const inv = built.value;
  if (inv) {
    check('the plugins that can be read are still listed',
      inv.plugins.some((p) => p.key === 'good@m' && p.description === 'good one') &&
      !inv.plugins.some((p) => ['notalist@m', 'nopath@m', 'nullrecord@m'].includes(p.key)),
      JSON.stringify(inv.plugins.map((p) => p.key)));
    const pluginWarning = inv.warnings.find((x) => x.path === INSTALLED);
    check('and the records left out are named in one warning about that file',
      !!pluginWarning && ['notalist@m', 'nopath@m', 'nullrecord@m'].every((k) => pluginWarning.message.includes(k)) &&
      pluginWarning.partial === true,
      JSON.stringify(inv.warnings));
    const pluginLine = group(inv, 'Plugins').looked.find((l) => l.startsWith(INSTALLED));
    check('a list of plugins read with a few records left out is not described as unreadable',
      !/could not be read/.test(pluginLine || ''), pluginLine);
    check('a list of servers that is not a list is warned about, in the file it is in',
      [GLOBAL_SETTINGS, path.join(P, '.claude', 'settings.json'), CLAUDE_JSON].every((f) =>
        inv.warnings.some((x) => x.path === f && x.partial && /server names/.test(x.message))),
      JSON.stringify(inv.warnings));
    check('and treated as deciding nothing, so the shared server is still undecided',
      inv.mcp.shared.find((s) => s.name === 'shared1')?.enabled === null, JSON.stringify(inv.mcp.shared));
    const settingsLine = group(inv, 'Settings').looked.find((l) => l.startsWith(GLOBAL_SETTINGS));
    check('a settings file with one key in the wrong shape is not described as unreadable',
      !/could not be read/.test(settingsLine || ''), settingsLine);
    check('a map of servers that is a list is not turned into servers named "0", "1", "2"',
      inv.mcp.user.length === 0 && inv.warnings.some((x) => x.path === CLAUDE_JSON && /set of servers/.test(x.message)),
      JSON.stringify(inv.mcp.user));
    check('a hook entry holding a null among its commands is still listed',
      inv.hooks.some((h) => h.source === GLOBAL_SETTINGS && h.commands.includes('echo hi')), JSON.stringify(inv.hooks));
  }

  writeJson(INSTALLED, { plugins: 'not a map' });
  const built2 = attempt(() => buildInventory(P));
  check('a plugins key that is not a set of plugins is warned about, not a crash',
    !built2.error && built2.value.plugins.length === 0 && built2.value.warnings.some((x) => x.path === INSTALLED),
    built2.error ? built2.error.stack : JSON.stringify(built2.value.warnings));

  fs.unlinkSync(INSTALLED);
  fs.unlinkSync(GLOBAL_SETTINGS);
  writeJson(CLAUDE_JSON, { mcpServers: {}, projects: {} });
  fs.rmSync(P, { recursive: true, force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
}

// --- what an @ line pulls in from outside the project ----------------------
// "@~/.bashrc" in a cloned repo's CLAUDE.md made ~/.bashrc a file the dashboard
// offered to overwrite. Its text loads, so it is shown; it is not changeable.
{
  const outside = path.join(SANDBOX, 'outside.md');
  w(outside, '# outside\n');
  const elsewhere = path.join(SANDBOX, 'elsewhere');
  w(path.join(elsewhere, 'escaped.md'), '# escaped through a link\n');
  w(path.join(GLOBAL, 'rules.md'), '# global rules kept in dotfiles\n');
  const P = project({
    'CLAUDE.md': [
      '# rules',
      '@~/.bashrc',
      `@${outside}`,
      '@docs/inside.md',
      '@~/.claude/rules.md',
      '@linked/escaped.md',
      '',
    ].join('\n'),
    'docs/inside.md': '# inside\n',
  });
  fs.symlinkSync(elsewhere, path.join(P, 'linked'));
  // the project is opened through a link to it, as the page might send it
  const PL = path.join(SANDBOX, `proj-link-${n}`);
  fs.symlinkSync(P, PL);

  const inv = buildInventory(PL);
  const editable = editablePathsFrom(inv);
  const viewable = viewablePathsFrom(inv);
  const bashrc = path.join(HOME_REAL, '.bashrc');
  const rows = importsOf(inv, path.join(P, 'CLAUDE.md'));
  const row = (spec) => rows.find((i) => i.spec === spec);

  check('a file in your home folder that an @ line pulls in is still read and counted — its text loads',
    row('~/.bashrc')?.bytes > 0 && !row('~/.bashrc').error, JSON.stringify(rows));
  check('and can be opened', viewable.has(bashrc));
  check('but is not a file this dashboard will change', !editable.has(bashrc) && row('~/.bashrc').outsideProject === true);
  check('nor is any file outside the project and the global .claude folder',
    viewable.has(outside) && !editable.has(outside));
  check('nor one reached through a link inside the project that leads out of it',
    viewable.has(path.join(P, 'linked', 'escaped.md')) && !editable.has(path.join(P, 'linked', 'escaped.md')));
  check('a file inside the project stays changeable, with the project opened through a link',
    editable.has(path.join(P, 'docs', 'inside.md')) && !row('docs/inside.md').outsideProject);
  check('the scanner can say why such a file is read-only, so a refusal need not claim it is not shown',
    scan.isOutsideImport(inv, bashrc) && scan.isOutsideImport(inv, outside) && !scan.isOutsideImport(inv, path.join(P, 'docs', 'inside.md')));
  check('a file in the global .claude folder stays changeable, when that folder is a link into a dotfiles repo',
    editable.has(path.join(GLOBAL, 'rules.md')) && !row('~/.claude/rules.md').outsideProject);

  const before = fs.readFileSync(bashrc, 'utf8');
  const save = attempt(() => toggle.writeEditableFile({ filePath: bashrc, projectPath: PL, content: 'pwned\n', expectedMtimeMs: fs.statSync(bashrc).mtimeMs }));
  check('saving over it is refused, and the file is left alone',
    !!save.error && fs.readFileSync(bashrc, 'utf8') === before, save.error ? save.error.message : 'saved');
  const opened = attempt(() => toggle.readEditableFile({ filePath: bashrc, projectPath: PL }));
  check('opening it shows it read-only',
    !opened.error && opened.value.writable === false && opened.value.content === before,
    opened.error ? opened.error.message : JSON.stringify({ ...opened.value, content: undefined }));
  const off = attempt(() => toggle.toggleMarkdown({ filePath: outside, projectPath: PL, enabled: false }));
  check('and switching it off is refused too, leaving it where it is',
    !!off.error && fs.existsSync(outside) && !fs.existsSync(outside + '.disabled'), off.error ? off.error.message : 'switched');

  // the home folder viewed as a project: its own files are inside the project
  w(path.join(HOME_REAL, 'CLAUDE.md'), '# home rules\n@.bashrc\n');
  const homeInv = buildInventory(HOME);
  check('with the home folder itself as the project, a file in it is inside the project',
    editablePathsFrom(homeInv).has(bashrc), JSON.stringify(importsOf(homeInv, path.join(HOME_REAL, 'CLAUDE.md'))));
  fs.unlinkSync(path.join(HOME_REAL, 'CLAUDE.md'));

  // the user's own global CLAUDE.md chooses its imports itself: outside is editable
  const chainB = path.join(SANDBOX, 'chain-b.md');
  const chainA = path.join(SANDBOX, 'chain-a.md');
  w(chainB, '# b\n');
  w(chainA, `# a\n@${chainB}\n`);
  const gOnly = path.join(SANDBOX, 'global-only.md');
  w(gOnly, '# g\n');
  w(path.join(GLOBAL, 'CLAUDE.md'), `# global\n@${gOnly}\n`);
  const globalInv = buildInventory(P);
  check('a file the global CLAUDE.md pulls in from outside both folders stays editable',
    editablePathsFrom(globalInv).has(gOnly) && !scan.isOutsideImport(globalInv, gOnly));
  w(path.join(GLOBAL, 'CLAUDE.md'), `# global\n@${chainA}\n`);
  const gChain = buildInventory(P);
  check('...and so does a chain global -> A -> B, both outside',
    editablePathsFrom(gChain).has(chainA) && editablePathsFrom(gChain).has(chainB));
  const P2 = project({ 'CLAUDE.md': `# p\n@${chainA}\n` });
  w(path.join(GLOBAL, 'CLAUDE.md'), '# global\n');
  const pChain = buildInventory(P2);
  check('a chain project -> A -> B outside is read-only at both links',
    viewablePathsFrom(pChain).has(chainB) && !editablePathsFrom(pChain).has(chainA) && !editablePathsFrom(pChain).has(chainB));
  w(path.join(GLOBAL, 'CLAUDE.md'), `# global\n@${chainA}\n`);
  const both = buildInventory(P2);
  check('reachable from both global and project: the stricter wins (read-only)',
    !editablePathsFrom(both).has(chainA) && !editablePathsFrom(both).has(chainB));
  fs.unlinkSync(path.join(GLOBAL, 'CLAUDE.md'));
  fs.rmSync(P2, { recursive: true, force: true });
  fs.rmSync(gOnly, { force: true });
  fs.rmSync(chainA, { force: true });
  fs.rmSync(chainB, { force: true });

  fs.unlinkSync(PL);
  fs.rmSync(P, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
  fs.rmSync(outside + '.disabled', { force: true });
  fs.rmSync(path.join(GLOBAL, 'rules.md'), { force: true });
}

// --- how deep @ lines are followed ----------------------------------------
{
  const files = { 'CLAUDE.md': '# rules\n@d1.md\n' };
  for (let i = 1; i <= 7; i++) files[`d${i}.md`] = `# depth ${i}\n${i < 7 ? `@d${i + 1}.md\n` : ''}`;
  const P = project(files);
  const inv = buildInventory(P);
  const rows = importsOf(inv, path.join(P, 'CLAUDE.md'));
  check(`a chain of seven @ lines is followed ${inv.claudeMd.searched.importDepth} levels and no further`,
    inv.claudeMd.searched.importDepth === 5 && rows.length === 5 && Math.max(...rows.map((r) => r.level)) === 5 &&
    rows.some((r) => r.spec === 'd5.md') && !rows.some((r) => r.spec === 'd6.md'),
    JSON.stringify(rows.map((r) => [r.spec, r.level])));
  fs.rmSync(P, { recursive: true, force: true });
}

// --- a plugin that no settings file mentions ------------------------------
// Schema assumption A24: no enabledPlugins entry means the plugin is off.
{
  const P = project({ 'CLAUDE.md': '# rules\n' });
  const installDir = path.join(SANDBOX, 'plugin-quiet');
  writeJson(path.join(installDir, '.claude-plugin', 'plugin.json'), { description: 'quiet' });
  w(path.join(installDir, 'skills', 'qskill', 'SKILL.md'), '---\ndescription: from the quiet plugin\n---\nbody\n');
  writeJson(INSTALLED, { plugins: { 'quiet@m': [{ scope: 'user', installPath: installDir, version: '1' }] } });
  let inv = buildInventory(P);
  let plugin = inv.plugins.find((p) => p.key === 'quiet@m');
  check('an installed plugin that no settings file mentions is listed as off',
    plugin?.enabled === false && plugin.enabledSetBy === null, JSON.stringify(plugin));
  check('and its skills are not counted as loading', !inv.skills.some((s) => s.name === 'qskill'));
  writeJson(GLOBAL_SETTINGS, { enabledPlugins: { 'quiet@m': true } });
  inv = buildInventory(P);
  plugin = inv.plugins.find((p) => p.key === 'quiet@m');
  check('switched on in settings, it is on, and its skills are counted',
    plugin?.enabled === true && plugin.enabledSetBy === GLOBAL_SETTINGS && inv.skills.some((s) => s.name === 'qskill'),
    JSON.stringify(plugin));
  fs.unlinkSync(GLOBAL_SETTINGS);
  fs.unlinkSync(INSTALLED);
  fs.rmSync(P, { recursive: true, force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
}

// A skill reached through a linked folder above it (not the skill folder
// itself) still says it is a link — writes follow that link. A global skill is
// not flagged just because ~/.claude as a whole is a link into dotfiles.
{
  const P = path.join(SANDBOX, 'proj-linked-skills');
  const shared = path.join(SANDBOX, 'shared-skills');
  w(path.join(shared, 'team', 'SKILL.md'), '---\ndescription: shared\n---\nbody\n');
  fs.mkdirSync(path.join(P, '.claude'), { recursive: true });
  fs.symlinkSync(shared, path.join(P, '.claude', 'skills'));
  w(path.join(GLOBAL, 'skills', 'mine', 'SKILL.md'), '---\ndescription: mine\n---\nbody\n');
  const inv = buildInventory(P);
  const team = inv.skills.find((s) => s.name === 'team');
  const mine = inv.skills.find((s) => s.name === 'mine');
  check('a skill inside a linked skills folder is reported as living where the link leads',
    team?.symlink === path.join(shared, 'team'), JSON.stringify(team));
  check('a global skill under a linked ~/.claude is not flagged as a link',
    mine && mine.symlink === null, JSON.stringify(mine));
  fs.rmSync(P, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
  fs.rmSync(path.join(GLOBAL, 'skills', 'mine'), { recursive: true, force: true });
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${checksRun} checks FAILED` : `\nall ${checksRun} checks passed`);
process.exit(failures ? 1 : 0);
