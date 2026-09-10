#!/usr/bin/env node
// Checks the file shapes this dashboard assumes against the ones on this
// machine, and prints what it found. It opens files for reading and writes
// nothing. The only other process it starts is `claude --version`, to put the
// Claude Code version in the report.
//
// The assumptions were read off one installation (Claude Code 2.1.x, macOS,
// September 2026) rather than from a published schema, so the point of this
// script is to find out where another machine differs. Every line is numbered
// to match docs/schema-assumptions.md, and every assumption in that file gets a
// line here — including the ones this script cannot settle, which say so rather
// than being left out.
//
// The output is meant to be pasted into a public bug report, so nothing read
// out of a file ever reaches it: no values, no server names, no error text from
// the filesystem or the JSON parser (both quote paths, and a parse error quotes
// the first characters of the file), and no paths of your own — the project is
// named by its last folder alone. What gets printed is counts, the names of
// keys this dashboard already knows, and types.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths, isPlainObject } from '../src/scan.js';

const USAGE = `check-config — do this machine's Claude Code files match what the dashboard assumes?

Usage: node bin/check-config.js [--path <dir>]

  --path <dir>   project to check the project-level files of (default: current directory)
  -h, --help     show this message

Reads only. Nothing is written.
`;

let projectPath = process.cwd();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '-h' || a === '--help') { process.stdout.write(USAGE); process.exit(0); }
  else if (a === '--path' || a === '-p') { projectPath = path.resolve(process.argv[++i] || '.'); }
  else { process.stderr.write(`unknown option: ${a}\n\n${USAGE}`); process.exit(2); }
}
try {
  if (!fs.statSync(projectPath).isDirectory()) throw new Error('not a directory');
  // The dashboard looks a project up by its real path, so this has to as well,
  // or the two read different files and the report describes neither.
  projectPath = fs.realpathSync(projectPath);
} catch {
  process.stderr.write(`not a directory this can check: ${path.basename(projectPath)}\n`);
  process.exit(2);
}

const { GLOBAL_CLAUDE_DIR, GLOBAL_CLAUDE_JSON } = paths;

const results = [];
const push = (id, status, what, detail) => results.push({ id, status, what, detail });
const ok = (id, what, detail) => push(id, 'ok', what, detail);
const absent = (id, what, detail) => push(id, 'absent', what, detail);
const skipped = (id, what, detail) => push(id, 'skipped', what, detail);
const mismatch = (id, what, detail) => push(id, 'MISMATCH', what, detail);
const unchecked = (id, what, detail) => push(id, 'not checked', what, detail);

// Filesystem and JSON errors are never repeated verbatim: those messages quote
// the path, and a parse error quotes the start of the file itself.
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { error: 'missing' };
    if (e.code === 'EACCES' || e.code === 'EPERM') return { error: 'unreadable' };
    return { error: `unreadable (${e.code || 'unknown error'})` };
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: 'not valid JSON' };
  }
}
const isMissing = (res) => res.error === 'missing';
const isUnreadable = (res) => Boolean(res.error) && res.error !== 'missing' && res.error !== 'not valid JSON';

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const allObjects = (o) => Object.values(o).every(isPlainObject);
const allStrings = (a) => a.every((v) => typeof v === 'string');
const realpathOr = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const statIsFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const statIsDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// --- ~/.claude.json -------------------------------------------------------

const globalJson = readJson(GLOBAL_CLAUDE_JSON);
if (isMissing(globalJson)) {
  absent('A1', '~/.claude.json', 'not on this machine');
  skipped('A2', 'mcpServers', 'no ~/.claude.json to read');
  skipped('A3', 'projects', 'no ~/.claude.json to read');
} else if (globalJson.error || !isPlainObject(globalJson.data)) {
  mismatch('A1', '~/.claude.json', globalJson.error || `top level is ${typeOf(globalJson.data)}, expected an object`);
  // Said out loud: these two are not "fine", they went unchecked.
  skipped('A2', 'mcpServers', 'could not read ~/.claude.json as an object');
  skipped('A3', 'projects', 'could not read ~/.claude.json as an object');
} else {
  ok('A1', '~/.claude.json', 'a JSON object');
  const g = globalJson.data;

  if (g.mcpServers === undefined) absent('A2', 'mcpServers', 'no global MCP servers configured here');
  else if (!isPlainObject(g.mcpServers)) mismatch('A2', 'mcpServers', `is ${typeOf(g.mcpServers)}, expected an object — switching a server off here can lose its definition`);
  else if (!allObjects(g.mcpServers)) mismatch('A2', 'mcpServers', 'some entries are not objects');
  else ok('A2', 'mcpServers', `${Object.keys(g.mcpServers).length} entries, all objects`);

  if (g.projects === undefined) absent('A3', 'projects', 'no per-project records here');
  else if (!isPlainObject(g.projects)) mismatch('A3', 'projects', `is ${typeOf(g.projects)}, expected an object`);
  else {
    const keys = Object.keys(g.projects);
    // Absolute is not enough. The dashboard looks this up by the project's real
    // path, so a key written as a path through a symlink is one it never finds
    // — and a switch would then write a second key beside it that Claude Code
    // never reads.
    const notReal = keys.filter((k) => {
      if (!path.isAbsolute(k)) return true;
      try { return fs.realpathSync(k) !== k; } catch { return false; } // gone from disk: nothing to compare
    });
    const notObjects = keys.filter((k) => !isPlainObject(g.projects[k]));
    const badServers = keys.filter((k) => isPlainObject(g.projects[k]) && g.projects[k].mcpServers !== undefined && !isPlainObject(g.projects[k].mcpServers));
    if (notObjects.length) mismatch('A3', 'projects', `${notObjects.length} of ${keys.length} entries are not objects`);
    else if (badServers.length) mismatch('A3', 'projects', `${badServers.length} entries have a non-object mcpServers`);
    else if (notReal.length) mismatch('A3', 'projects', `${notReal.length} of ${keys.length} keys are not the project's real path (relative, or written through a symlink)`);
    else ok('A3', 'projects', `${keys.length} projects, each keyed by its real absolute path`);
  }
}

// The approval keys can also sit in ~/.claude.json's own project entry, below
// every settings file — this is where a switch writes when nothing else has
// decided.
if (isMissing(globalJson) || globalJson.error || !isPlainObject(globalJson.data)) {
  skipped('A21', 'project entry approvals', 'could not read ~/.claude.json as an object');
} else {
  const entry = globalJson.data.projects?.[projectPath];
  if (!isPlainObject(entry)) absent('A21', 'project entry approvals', 'no record for this project in ~/.claude.json');
  else {
    const bad = ['enabledMcpjsonServers', 'disabledMcpjsonServers']
      .filter((k) => entry[k] !== undefined && (!Array.isArray(entry[k]) || !allStrings(entry[k])));
    const set = ['enabledMcpjsonServers', 'disabledMcpjsonServers'].filter((k) => entry[k] !== undefined);
    if (bad.length) mismatch('A21', 'project entry approvals', `${bad.join(' and ')} ${bad.length === 1 ? 'is' : 'are'} not an array of names`);
    else if (!set.length) absent('A21', 'project entry approvals', 'this project decides no shared servers here');
    else ok('A21', 'project entry approvals', `${set.join(', ')} present, as arrays of names`);
  }
}

unchecked('A20', 'settings precedence', 'which layer wins is Claude Code\'s behaviour, not something a file states');
unchecked('A22', 'the ".disabled" suffix', 'whether renaming a file really hides it from Claude Code can only be seen in a running session');
unchecked('A23', 'where CLAUDE.md is looked for', 'which of these Claude Code loads depends on where you start it, not on what is on disk');
unchecked('A24', 'a plugin with no entry is off', 'the default for a plugin nobody has decided about is Claude Code\'s, not a file\'s');

unchecked('A4', 'shadow keys', "this dashboard's own keys for switched-off servers — no file says whether Claude Code tolerates them");

// --- the four settings layers --------------------------------------------

const layers = [
  ['global', path.join(GLOBAL_CLAUDE_DIR, 'settings.json')],
  ['global-local', path.join(GLOBAL_CLAUDE_DIR, 'settings.local.json')],
  ['project', path.join(projectPath, '.claude', 'settings.json')],
  ['project-local', path.join(projectPath, '.claude', 'settings.local.json')],
];

const settings = [];
const badLayers = [];
let unreadableLayers = 0;
for (const [label, file] of layers) {
  const res = readJson(file);
  if (isMissing(res)) continue;
  // A file that cannot be opened is not a file in an unexpected shape.
  if (isUnreadable(res)) { unreadableLayers++; continue; }
  if (res.error || !isPlainObject(res.data)) {
    badLayers.push(`${label}: ${res.error || `top level is ${typeOf(res.data)}`}`);
    continue;
  }
  settings.push({ label, data: res.data });
}
if (badLayers.length) mismatch('A5', 'settings files', badLayers.join('; '));
else if (unreadableLayers && !settings.length) skipped('A5', 'settings files', `${unreadableLayers} present but not readable by this user`);
else if (!settings.length) absent('A5', 'settings files', 'none of the four exist here');
else ok('A5', 'settings files', `${settings.length} of 4 present, all JSON objects${unreadableLayers ? `, ${unreadableLayers} not readable` : ''}`);

// Each key is checked across whichever layers set it, since a machine may use
// only one of them. A layer that could not be opened is said out loud rather
// than quietly counted as a layer that does not set the key.
function checkSettingsKey(id, key, describe) {
  const blind = unreadableLayers ? ` (${unreadableLayers} unreadable ${unreadableLayers === 1 ? 'layer' : 'layers'} not looked at)` : '';
  const found = settings.filter((s) => s.data[key] !== undefined);
  if (!found.length) {
    return unreadableLayers
      ? skipped(id, key, `not set in the settings files that could be read${blind}`)
      : absent(id, key, 'not set in any settings file here');
  }
  const problems = [];
  for (const { label, data } of found) {
    const problem = describe(data[key]);
    if (problem) problems.push(`${label}: ${problem}`);
  }
  if (problems.length) mismatch(id, key, problems.join('; '));
  else ok(id, key, `set in ${found.map((f) => f.label).join(', ')}, as expected${blind}`);
}

checkSettingsKey('A6', 'enabledPlugins', (v) => {
  if (!isPlainObject(v)) return `is ${typeOf(v)}, expected an object`;
  const bad = Object.entries(v).filter(([, on]) => typeof on !== 'boolean');
  if (bad.length) return `${bad.length} entries are not booleans`;
  const odd = Object.keys(v).filter((k) => !/^[^@]+@[^@]+$/.test(k));
  if (odd.length) return `${odd.length} keys are not "name@marketplace"`;
  return null;
});

for (const key of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) {
  checkSettingsKey('A7', key, (v) => {
    if (!Array.isArray(v)) return `is ${typeOf(v)}, expected an array — the scan iterates it, so the whole page fails, not just this section`;
    if (!allStrings(v)) return 'contains entries that are not strings';
    return null;
  });
}
checkSettingsKey('A7', 'enableAllProjectMcpServers', (v) => (typeof v === 'boolean' ? null : `is ${typeOf(v)}, expected a boolean`));

checkSettingsKey('A8', 'hooks', (v) => {
  if (!isPlainObject(v)) return `is ${typeOf(v)}, expected an object`;
  let unknownTypes = 0;
  for (const [event, entries] of Object.entries(v)) {
    if (!Array.isArray(entries)) return `${event} is ${typeOf(entries)}, expected an array`;
    for (const entry of entries) {
      if (!isPlainObject(entry)) return `${event} holds a ${typeOf(entry)}, expected objects`;
      if (!Array.isArray(entry.hooks)) return `${event} entry has hooks: ${typeOf(entry.hooks)}, expected an array`;
      // The type is a value out of the file, so it is counted and never printed.
      for (const h of entry.hooks) if (!isPlainObject(h) || h.type !== 'command') unknownTypes++;
    }
  }
  if (unknownTypes) return `${unknownTypes} hook(s) are not of type "command", the only kind this switches`;
  return null;
});

checkSettingsKey('A9', 'permissions', (v) => {
  if (!isPlainObject(v)) return `is ${typeOf(v)}, expected an object`;
  for (const list of ['allow', 'deny', 'ask']) {
    if (v[list] === undefined) continue;
    if (!Array.isArray(v[list])) return `${list} is ${typeOf(v[list])}, expected an array — adding a rule would replace what is in it`;
    if (!allStrings(v[list])) return `${list} contains entries that are not strings`;
  }
  return null;
});

// --- plugins --------------------------------------------------------------

const installedRes = readJson(path.join(GLOBAL_CLAUDE_DIR, 'plugins', 'installed_plugins.json'));
let installPaths = [];
if (isMissing(installedRes)) {
  absent('A10', 'installed_plugins.json', 'no plugins installed here');
} else if (isUnreadable(installedRes)) {
  skipped('A10', 'installed_plugins.json', installedRes.error);
} else if (installedRes.error) {
  mismatch('A10', 'installed_plugins.json', installedRes.error);
} else if (!isPlainObject(installedRes.data?.plugins)) {
  mismatch('A10', 'installed_plugins.json', `plugins is ${typeOf(installedRes.data?.plugins)}, expected an object`);
} else {
  const entries = Object.entries(installedRes.data.plugins);
  const problems = [];
  let records = 0;
  let knownScope = 0;
  let unknownScopes = 0;
  let stale = 0;
  for (const [key, list] of entries) {
    if (!Array.isArray(list)) { problems.push(`${typeOf(list)} where an array of install records was expected — this stops the whole page, not just the plugin list`); continue; }
    for (const r of list) {
      records++;
      if (!isPlainObject(r)) { problems.push(`a record is ${typeOf(r)}, expected an object`); continue; }
      if (r.scope === 'user' || r.scope === 'local') knownScope++;
      else unknownScopes++;
      if (typeof r.installPath !== 'string') { problems.push('a record has no installPath string — the scan builds a path out of it and would throw'); continue; }
      if (r.scope === 'local' && typeof r.projectPath !== 'string') problems.push('a "local" record has no projectPath');
      // Only records this dashboard would actually use are its business: a
      // "local" record for someone else's project is not one of them, and a
      // folder that has been cleaned up is not a difference in file format.
      const mine = r.scope === 'user' || (r.scope === 'local' && typeof r.projectPath === 'string' && realpathOr(r.projectPath) === projectPath);
      if (!mine) continue;
      if (fs.existsSync(r.installPath)) installPaths.push(r.installPath);
      else stale++;
    }
    if (!/^[^@]+@[^@]+$/.test(key)) problems.push('a key is not "name@marketplace"');
  }
  if (unknownScopes) problems.push(`${unknownScopes} record(s) have a scope that is neither "user" nor "local"`);
  const unique = [...new Set(problems)];
  if (unique.length) mismatch('A10', 'installed_plugins.json', unique.join('; '));
  else ok('A10', 'installed_plugins.json', `${entries.length} plugins, ${records} install records (${knownScope} of scope user/local)${stale ? `, ${stale} pointing at a folder that is gone` : ''}`);
}

installPaths = [...new Set(installPaths)];
if (!installPaths.length) {
  absent('A11', 'plugin manifests', 'no installed plugins that apply here');
  absent('A12', 'plugin contents', 'no installed plugins that apply here');
} else {
  const manifest = (p) => readJson(path.join(p, '.claude-plugin', 'plugin.json'));
  const problems = [];
  let read = 0;
  for (const p of installPaths) {
    const res = manifest(p);
    if (isMissing(res)) problems.push('a plugin with no .claude-plugin/plugin.json');
    else if (isUnreadable(res)) problems.push('a manifest this user cannot open');
    else if (res.error) problems.push('a manifest that is not valid JSON');
    else if (!isPlainObject(res.data)) problems.push('a manifest whose top level is not an object');
    else read++;
  }
  const unique = [...new Set(problems)];
  if (unique.length) mismatch('A11', 'plugin manifests', `${unique.join('; ')} (${read} of ${installPaths.length} read cleanly)`);
  else ok('A11', 'plugin manifests', `${read} found at .claude-plugin/plugin.json`);

  // This dashboard looks for a plugin's contents in commands/, agents/, skills/
  // and hooks/ and nowhere else. A manifest that points one of those somewhere
  // else is undercounted; one that names its own default folder is fine, and
  // the other folders a plugin ships (docs, scripts, assets) are none of its
  // business.
  const folders = ['commands', 'agents', 'skills', 'hooks'];
  const defaults = (key) => [key, `./${key}`, `${key}/`, `./${key}/`, `${key}/hooks.json`, `./${key}/hooks.json`];
  const redirected = new Set();
  for (const p of installPaths) {
    const res = manifest(p);
    if (res.error || !isPlainObject(res.data)) continue;
    for (const key of folders) {
      const v = res.data[key];
      if (v === undefined) continue;
      if (typeof v === 'string' && defaults(key).includes(v)) continue;
      redirected.add(key);
    }
  }
  const withFolders = installPaths.filter((p) => folders.some((d) => fs.existsSync(path.join(p, d))));
  if (redirected.size) mismatch('A12', 'plugin contents', `manifest(s) name their own location for: ${[...redirected].join(', ')} — this dashboard only looks in the folders of those names`);
  else ok('A12', 'plugin contents', `${withFolders.length} of ${installPaths.length} ship at least one of ${folders.join('/')}, all read from those folders`);
}

const hooksFiles = installPaths.map((p) => path.join(p, 'hooks', 'hooks.json')).filter((f) => fs.existsSync(f));
if (!hooksFiles.length) {
  absent('A25', "a plugin's hooks.json", 'no installed plugin here ships one');
} else {
  const bad = hooksFiles.filter((f) => {
    const res = readJson(f);
    if (res.error || !isPlainObject(res.data)) return true;
    // Either { hooks: { … } } or the events object written directly.
    return res.data.hooks !== undefined && !isPlainObject(res.data.hooks);
  });
  if (bad.length) mismatch('A25', "a plugin's hooks.json", `${bad.length} of ${hooksFiles.length} are neither { hooks: … } nor an events object`);
  else ok('A25', "a plugin's hooks.json", `${hooksFiles.length} found, all shaped as expected`);
}

const marketplacesRes = readJson(path.join(GLOBAL_CLAUDE_DIR, 'plugins', 'known_marketplaces.json'));
if (isMissing(marketplacesRes)) absent('A13', 'known_marketplaces.json', 'not on this machine');
else if (isUnreadable(marketplacesRes)) skipped('A13', 'known_marketplaces.json', marketplacesRes.error);
else if (marketplacesRes.error) mismatch('A13', 'known_marketplaces.json', marketplacesRes.error);
else if (!isPlainObject(marketplacesRes.data)) mismatch('A13', 'known_marketplaces.json', `top level is ${typeOf(marketplacesRes.data)}`);
else {
  // "source" is a string on some installations and an object naming a kind on
  // others; either is fine, since the page only passes it through.
  const noSource = Object.values(marketplacesRes.data).filter((m) => !isPlainObject(m) || m.source === undefined);
  if (noSource.length) mismatch('A13', 'known_marketplaces.json', `${noSource.length} entries have no "source"`);
  else ok('A13', 'known_marketplaces.json', `${Object.keys(marketplacesRes.data).length} marketplaces, each with a source`);
}

// --- skills, subagents and their frontmatter ------------------------------

const skillDirs = [path.join(GLOBAL_CLAUDE_DIR, 'skills'), path.join(projectPath, '.claude', 'skills')];
const agentDirs = [path.join(GLOBAL_CLAUDE_DIR, 'agents'), path.join(projectPath, '.claude', 'agents')];

const skillFiles = [];
const agentFiles = [];
let parked = 0;
let strays = 0;
for (const dir of skillDirs) {
  for (const e of listDir(dir)) {
    const full = path.join(dir, e.name);
    // Loose files in a skills folder (a README, a stray note) say nothing about
    // Claude Code's layout. Only folders are a claim about it.
    if (!statIsDir(full)) continue;
    if (fs.existsSync(path.join(full, 'SKILL.md'))) skillFiles.push(path.join(full, 'SKILL.md'));
    else if (fs.existsSync(path.join(full, 'SKILL.md.disabled'))) parked++; // switched off from this dashboard
    else strays++;
  }
}
for (const dir of agentDirs) {
  for (const e of listDir(dir)) {
    const full = path.join(dir, e.name);
    if (statIsDir(full)) { strays++; continue; } // a subagent in a folder is not read
    if (!statIsFile(full)) continue;
    if (e.name.endsWith('.md')) agentFiles.push(full);
    else if (e.name.endsWith('.md.disabled')) parked++;
  }
}
if (!skillFiles.length && !agentFiles.length && !strays && !parked) {
  absent('A14', 'skills and subagents', 'none in ~/.claude or this project');
} else if (strays) {
  mismatch('A14', 'skills and subagents', `${strays} entries are laid out some other way than skills/<name>/SKILL.md or agents/<name>.md, so they are not read`);
} else {
  ok('A14', 'skills and subagents', `${skillFiles.length} skills, ${agentFiles.length} subagents, laid out as expected${parked ? `, ${parked} switched off` : ''}`);
}

// The description is what actually loads at startup, so one this dashboard
// cannot read is weight it cannot count. The name is taken from the folder or
// the file name, so its absence from the frontmatter is not a problem.
const frontmatterProblems = [];
for (const f of [...skillFiles, ...agentFiles]) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { frontmatterProblems.push('a file this user cannot read'); continue; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) { frontmatterProblems.push('no --- frontmatter block'); continue; }
  const body = m[1];
  if (!/^description\s*:/m.test(body)) frontmatterProblems.push('no description field');
  else if (/^description\s*:\s*(\r?\n\s*-\s|\[)/m.test(body)) frontmatterProblems.push('a description written as a list rather than a string');
}
if (!skillFiles.length && !agentFiles.length) absent('A15', 'frontmatter', 'nothing to read');
else if (frontmatterProblems.length) {
  const counts = frontmatterProblems.reduce((acc, p) => ({ ...acc, [p]: (acc[p] || 0) + 1 }), {});
  mismatch('A15', 'frontmatter', Object.entries(counts).map(([p, n]) => `${n}× ${p}`).join('; '));
} else ok('A15', 'frontmatter', `${skillFiles.length + agentFiles.length} files, all with a description`);

unchecked('A16', 'CLAUDE.md and its "@" lines', 'which of these Claude Code really loads can only be seen in a running session, not read off disk');

// --- the project's own files ---------------------------------------------

const mcpJsonRes = readJson(path.join(projectPath, '.mcp.json'));
if (isMissing(mcpJsonRes)) absent('A17', '.mcp.json', 'this project has none');
else if (isUnreadable(mcpJsonRes)) skipped('A17', '.mcp.json', mcpJsonRes.error);
else if (mcpJsonRes.error) mismatch('A17', '.mcp.json', mcpJsonRes.error);
else if (!isPlainObject(mcpJsonRes.data?.mcpServers)) mismatch('A17', '.mcp.json', `mcpServers is ${typeOf(mcpJsonRes.data?.mcpServers)}, expected an object`);
else if (!allObjects(mcpJsonRes.data.mcpServers)) mismatch('A17', '.mcp.json', 'some server definitions are not objects');
else ok('A17', '.mcp.json', `${Object.keys(mcpJsonRes.data.mcpServers).length} shared servers`);

// Claude Code names this folder after the project path with every character
// that is not a letter or a digit turned into a dash. Spelled any other way,
// the memory section comes up empty for reasons that have nothing to do with
// memory — so the check looks for the same project under another spelling
// rather than only asking whether the expected folder is there.
const projectsDir = path.join(GLOBAL_CLAUDE_DIR, 'projects');
const slug = projectPath.replace(/[^A-Za-z0-9]/g, '-');
const expectedDir = path.join(projectsDir, slug);
if (!fs.existsSync(projectsDir)) {
  absent('A18', 'per-project memory', 'no ~/.claude/projects folder on this machine');
} else if (fs.existsSync(path.join(expectedDir, 'memory', 'MEMORY.md'))) {
  ok('A18', 'per-project memory', 'MEMORY.md found under the expected folder name');
} else if (fs.existsSync(expectedDir)) {
  absent('A18', 'per-project memory', 'the folder name matches, but this project keeps no memory notes');
} else {
  const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const others = listDir(projectsDir).filter((e) => e.isDirectory() && e.name !== slug && loose(e.name) === loose(slug));
  if (others.length) mismatch('A18', 'per-project memory', 'this project has a session folder spelled differently from the name built here, so memory notes would be missed');
  else absent('A18', 'per-project memory', 'no session folder for this project yet, so there is nothing to compare');
}

const managedPath = process.platform === 'darwin'
  ? '/Library/Application Support/ClaudeCode/managed-settings.json'
  : process.platform === 'win32'
  ? 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'
  : '/etc/claude-code/managed-settings.json';
unchecked('A19', 'enterprise-managed settings', fs.existsSync(managedPath)
  ? 'one exists on this machine and is deliberately not read — it outranks every layer above, so the page can say "on" about something it turns off'
  : 'none on this machine');

// --- report ---------------------------------------------------------------

let claudeVersion = 'not found on PATH';
try {
  claudeVersion = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
} catch { /* the CLI may not be installed, or not be on PATH */ }

results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
const width = Math.max(...results.map((r) => r.what.length));
const mismatches = results.filter((r) => r.status === 'MISMATCH');
const count = (status) => results.filter((r) => r.status === status).length;
const label = { ok: 'ok         ', absent: '—          ', skipped: 'not read   ', MISMATCH: 'MISMATCH   ', 'not checked': 'not checked' };

const out = [];
out.push('claude-context-dashboard — config shape check');
out.push('');
out.push(`  claude --version   ${claudeVersion}`);
out.push(`  node               ${process.version}`);
out.push(`  platform           ${process.platform} ${process.arch}`);
out.push(`  project checked    ${path.basename(projectPath)}  (folder name only)`);
out.push('');
for (const r of results) out.push(`  ${r.id.padEnd(4)}${label[r.status]}  ${r.what.padEnd(width)}  ${r.detail}`);
out.push('');
out.push(`  ${new Set(results.map((r) => r.id)).size} assumptions over ${results.length} lines: ${count('ok')} as expected, ${count('absent')} not present here, ${count('skipped')} could not be read, ${count('not checked')} not settleable from disk, ${mismatches.length} different.`);
out.push('');
if (mismatches.length) {
  out.push('  A line marked MISMATCH means this machine keeps that file in a shape the');
  out.push('  dashboard was not built against. Reading around it is usually safe; a switch');
  out.push('  that writes it may not take effect. Each number is explained in');
  out.push('  docs/schema-assumptions.md — please report it. Nothing above was copied out');
  out.push('  of a file, so it is safe to paste as it stands.');
} else {
  out.push('  Everything this script can check looks the way the dashboard expects here.');
  out.push('  The "not checked" lines are assumptions no file on disk can settle.');
}
out.push('');
out.push('  Nothing was written. This check only read files.');
out.push('');

process.stdout.write(out.join('\n'));
process.exit(mismatches.length ? 1 : 0);
