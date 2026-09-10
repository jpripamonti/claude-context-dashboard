import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
// Everything is built from the symlink-resolved home, so a global file and a
// project file never end up as two different spellings of the same path
// (which happens when the project being viewed is the home directory itself).
const HOME_REAL = realpathOrResolve(HOME);

// Identifies the file a path names, even when that file does not exist yet:
// resolving the parent folder is what catches a project whose ".claude" folder
// is a link to the global one, where the file to be created would land in the
// global folder. Resolving only the file itself would miss exactly that case.
function fileIdentity(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch { /* not there yet — resolve the folder it would be created in */ }
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}
const GLOBAL_CLAUDE_DIR = path.join(HOME_REAL, '.claude');
const GLOBAL_CLAUDE_JSON = path.join(HOME_REAL, '.claude.json');
// This dashboard's own storage. Switched-off hooks are parked here rather than
// in the real settings file, because Claude Code validates settings.json and
// would warn about a key it doesn't recognize.
const DASHBOARD_DIR = path.join(HOME, '.claude-context-dashboard');
const PARKED_FILE = path.join(DASHBOARD_DIR, 'parked.json');

// Every file read here is meant to hold a JSON object. One that holds valid
// JSON of another shape — `null`, a list, a bare number — would otherwise sail
// past the parse and blow up in whichever reader touched it first, taking the
// whole inventory (and with it the editor, which needs the inventory to decide
// what may be opened) down with it. So it is reported exactly like a syntax
// error: the file is ignored, the dashboard warns about it, and it can still be
// opened and fixed.
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function describeJson(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'string') return 'a piece of text';
  if (typeof v === 'number') return 'a number';
  if (typeof v === 'boolean') return String(v);
  return typeof v;
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!isPlainObject(data)) {
      return { ok: false, error: `it holds ${describeJson(data)}, not a set of settings`, path: filePath };
    }
    return { ok: true, data, path: filePath };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, missing: true, path: filePath };
    return { ok: false, error: String(err.message || err), path: filePath };
  }
}

function readTextSafe(filePath) {
  try {
    return { ok: true, data: fs.readFileSync(filePath, 'utf8'), path: filePath };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, missing: true, path: filePath };
    return { ok: false, error: String(err.message || err), path: filePath };
  }
}

function statSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function resolveIfSymlink(p) {
  const st = statSafe(p);
  if (st && st.isSymbolicLink()) {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  }
  return p;
}

// Canonicalize a directory path (resolve symlinks) so the same project
// reached via two different routes (e.g. a symlink) is treated identically —
// this must be used consistently everywhere a project path is matched
// against Claude Code's own records (which are also filesystem paths).
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory(); // follows links, unlike readdir's own answer
  } catch {
    return false;
  }
}

function realpathOrResolve(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved; // path may not exist (yet) — fall back to the resolved form
  }
}

// --- frontmatter (SKILL.md / agent .md) -------------------------------

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawRest] = kv;
    const rest = rawRest.trim();

    if (/^[>|][+-]?$/.test(rest)) {
      // YAML block scalar (folded ">" or literal "|"), any chomping indicator
      const folded = rest.startsWith('>');
      const blockLines = [];
      while (i + 1 < lines.length && (lines[i + 1] === '' || /^\s+\S/.test(lines[i + 1]))) {
        i++;
        blockLines.push(lines[i].replace(/^\s\s/, ''));
      }
      out[key] = folded ? blockLines.join(' ').trim() : blockLines.join('\n').trim();
    } else if (rest === '' && i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1])) {
      // YAML list value — not needed for any field we read; skip rather than mis-parse.
      while (i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1])) i++;
    } else if (rest !== '') {
      const isQuoted = rest[0] === '"' || rest[0] === "'";
      const noComment = isQuoted ? rest : rest.replace(/\s+#.*$/, '');
      out[key] = stripQuotes(noComment.trim());
    }
  }
  return out;
}

// --- CLAUDE.md hierarchy -----------------------------------------------

function findImports(text) {
  const imports = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*@(\S+)/);
    if (m) imports.push(m[1]);
  }
  return imports;
}

function resolveSpec(spec, baseDir) {
  if (spec.startsWith('~/')) return path.join(HOME_REAL, spec.slice(2));
  return path.resolve(baseDir, spec);
}

// An "@other-file" line pulls that file's whole text in as well, and that file
// can pull in more, so the real weight of an instructions file includes
// everything it drags along. Follows a few levels and never the same file twice.
const MAX_IMPORT_DEPTH = 5;

// Every "@" line produces a row, including the ones that bring nothing: a line
// naming a file that is not there, or that is there but cannot be read, is the
// one case where a reader most needs to be told — the instructions file claims
// to pull something in and nothing arrives. A line naming a file some earlier
// line already pulled in gets a row too, saying so, rather than vanishing.
function followImports(text, baseDir, seen, via, level = 1) {
  const out = [];
  if (level > MAX_IMPORT_DEPTH) return out;
  for (const spec of findImports(text)) {
    const target = resolveSpec(spec, baseDir);
    const key = realpathOrResolve(target);
    if (seen.has(key)) {
      out.push({ path: target, spec, via, level, bytes: 0, alreadyPulledIn: true });
      continue;
    }
    seen.add(key);
    const res = readTextSafe(target);
    if (!res.ok) {
      out.push({ path: target, spec, via, level, bytes: 0, missing: !!res.missing, error: res.error || null });
      continue;
    }
    out.push({ path: target, spec, via, level, bytes: Buffer.byteLength(res.data, 'utf8') });
    out.push(...followImports(res.data, path.dirname(target), seen, target, level + 1));
  }
  return out;
}

// --- files the instructions point at without pulling them in ----------------

// A CLAUDE.md that says "see docs/architecture.md" is layering instructions
// just as surely as one that writes "@docs/architecture.md" — except Claude
// Code does not load it. The text only arrives once Claude goes and reads it,
// which is why these are gathered separately and never counted as weight.
//
// Only files that end in one of these are followed. A CLAUDE.md naming
// src/scan.js is saying where the code lives, not adding a layer.
const REFERENCE_EXTENSIONS = ['.md', '.markdown', '.mdx', '.mdc', '.txt', '.rst'];
const MAX_REFERENCE_DEPTH = 3;
// A doc tree that cross-links heavily would otherwise be walked in full, and
// the far end of it says nothing about this project's instructions.
const MAX_REFERENCES = 40;

// Anything that reads as a path and ends in one of the extensions above:
// markdown link targets, backticked paths and bare prose mentions all match,
// which is why the extensions are the filter rather than the syntax around the
// path. Being preceded by "/" rules out the tail of a URL; by "@" an import.
const REFERENCE_RE = new RegExp(
  String.raw`(?<![\w/.~@-])((?:~\/|\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:` +
  REFERENCE_EXTENSIONS.map((e) => e.slice(1)).join('|') + '))\\b',
  'gi'
);

function findReferenceSpecs(text) {
  const out = [];
  for (const m of text.matchAll(REFERENCE_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function isReadableFile(p) {
  try {
    return fs.statSync(p).isFile(); // follows links: a linked doc is a doc
  } catch {
    return false;
  }
}

// Resolved from beside the file that names it, and nowhere else. Trying the
// project root as well would have caught a subfolder's CLAUDE.md meaning
// "docs/conventions.md" from the root — and would also have turned the global
// CLAUDE.md's passing mention of a filename into a claim about this project's
// copy of it, which is a layer of instructions that does not exist.
function resolveReference(spec, baseDir) {
  const candidate = resolveSpec(spec, baseDir);
  return isReadableFile(candidate) ? candidate : null;
}

// "found" collects the rows and records whether the walk was cut short, so the
// page can say the list is partial instead of showing a short list as complete.
function followReferences(text, baseDir, seen, via, found, level = 1) {
  if (level > MAX_REFERENCE_DEPTH) return;
  for (const spec of findReferenceSpecs(text)) {
    const target = resolveReference(spec, baseDir);
    if (!target) continue; // named in the text, not on disk — nothing to show
    const key = realpathOrResolve(target);
    if (seen.has(key)) continue;
    seen.add(key);
    const res = readTextSafe(target);
    if (!res.ok) continue; // there, but unreadable — it points at nothing usable
    if (found.files.length >= MAX_REFERENCES) {
      found.truncated = true;
      return;
    }
    found.files.push({
      path: target,
      spec,
      via,
      level,
      bytes: Buffer.byteLength(res.data, 'utf8'),
    });
    followReferences(res.data, path.dirname(target), seen, target, found, level + 1);
    if (found.truncated) return;
  }
}

// An instructions file switched off by this dashboard keeps its content but is
// renamed with a ".disabled" suffix, so Claude Code no longer recognizes it.
// Both variants are reported, otherwise switching one off would hide it forever.
function loadClaudeMdFile(filePath, label) {
  const disabledPath = filePath + '.disabled';
  const active = readTextSafe(filePath);
  const res = active.ok ? active : readTextSafe(disabledPath);
  if (!res.ok) return null;
  const actualPath = active.ok ? filePath : disabledPath;
  const realPath = resolveIfSymlink(actualPath);
  const isSymlink = realPath && realPath !== actualPath;
  return {
    label,
    path: actualPath,
    disabled: !active.ok,
    // both a live file and a switched-off copy exist — switching is blocked
    // until one of them is dealt with by hand
    hasTwin: active.ok && fs.existsSync(disabledPath),
    realPath: isSymlink ? realPath : null,
    bytes: Buffer.byteLength(res.data, 'utf8'),
    lines: res.data.split(/\r?\n/).length,
    // no separate list of the raw "@" specs: every one of them is a row in
    // importedFiles, carrying both what the line said and where it landed
    importedFiles: active.ok
      ? followImports(res.data, path.dirname(actualPath), new Set([realpathOrResolve(actualPath)]), actualPath)
      : [],
  };
}

// canonicalProjectPath must already be realpath-resolved (see buildInventory)
function scanClaudeMd(canonicalProjectPath) {
  // One file can be reachable under two labels — viewing the home directory
  // itself, or a home CLAUDE.md that is a link to a project's own. List it
  // once, keeping the most specific label: the walk runs from the outermost
  // folder inwards, so a later find is the more specific one, and it is also
  // the spelling that names the real file rather than the link to it.
  const byFile = new Map();
  const push = (md) => {
    if (!md) return;
    const key = fileIdentity(md.path);
    const existing = byFile.get(key);
    byFile.set(key, existing ? { ...md, alsoReachableAs: existing.path } : md);
  };

  push(loadClaudeMdFile(path.join(GLOBAL_CLAUDE_DIR, 'CLAUDE.md'), 'global'));

  // walk from the project up to HOME (or filesystem root if the project is outside HOME)
  const chain = [];
  let dir = canonicalProjectPath;
  const stopAt = dir.startsWith(HOME_REAL + path.sep) || dir === HOME_REAL ? HOME_REAL : path.parse(dir).root;
  while (true) {
    chain.push(dir);
    if (dir === stopAt || dir === path.parse(dir).root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  chain.reverse(); // root-most ancestor first, project dir last

  for (const d of chain) {
    const isProjectRoot = d === canonicalProjectPath;
    const label = isProjectRoot ? 'project' : 'ancestor';
    push(loadClaudeMdFile(path.join(d, 'CLAUDE.md'), label));
    push(loadClaudeMdFile(path.join(d, 'CLAUDE.local.md'), isProjectRoot ? 'project-local' : 'ancestor-local'));
  }

  // immediate subdirectories: loaded on demand if you work inside them
  const nested = [];
  const subdirsRead = [];
  let subdirsListed = true;
  try {
    for (const entry of fs.readdirSync(canonicalProjectPath, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      // a folder reached through a link is still a folder you can work in, and
      // Claude Code reads the CLAUDE.md it finds there. The skills walk has
      // always followed these; this one used to drop them without a word.
      if (!isDirectory(path.join(canonicalProjectPath, entry.name))) continue;
      subdirsRead.push(entry.name);
      const sub = loadClaudeMdFile(
        path.join(canonicalProjectPath, entry.name, 'CLAUDE.md'),
        'nested (loads if you work in this subfolder)'
      );
      if (sub && !byFile.has(fileIdentity(sub.path))) nested.push(sub);
    }
  } catch {
    subdirsListed = false; // the project folder itself could not be listed
  }

  const files = [...byFile.values()];

  // Files the instructions only point at. Everything already accounted for is
  // seeded into "seen" first, so a doc that an "@" line pulls in is reported as
  // loaded (which it is) rather than a second time as merely pointed at.
  const referenceSeen = new Set();
  for (const f of [...files, ...nested]) {
    referenceSeen.add(realpathOrResolve(f.path));
    for (const i of f.importedFiles) referenceSeen.add(realpathOrResolve(i.path));
  }
  // The walk starts from every instructions file AND from every file an "@"
  // line pulls in: that text loads too, so a pointer written in it is the same
  // kind of layer as one written in the CLAUDE.md itself.
  const startingPoints = [];
  for (const f of [...files, ...nested]) {
    if (f.disabled) continue; // switched off: its text points nowhere any more
    startingPoints.push(f.path);
    for (const i of f.importedFiles) {
      if (!i.missing && !i.error && !i.alreadyPulledIn) startingPoints.push(i.path);
    }
  }
  const found = { files: [], truncated: false };
  for (const from of startingPoints) {
    if (found.truncated) break;
    const res = readTextSafe(from);
    if (!res.ok) continue;
    followReferences(res.data, path.dirname(from), referenceSeen, from, found);
  }

  // where the walk went, so the dashboard can say what it looked at without a
  // second description of the scan that could drift away from the scan itself
  return {
    files,
    nested,
    references: {
      files: found.files,
      // the walk stopped early — say so rather than let the list read as complete
      truncated: found.truncated,
      depth: MAX_REFERENCE_DEPTH,
      limit: MAX_REFERENCES,
      extensions: REFERENCE_EXTENSIONS,
    },
    searched: { chain, subdirs: subdirsRead, subdirsListed, importDepth: MAX_IMPORT_DEPTH },
  };
}

// --- settings.json layers -----------------------------------------------

// All four layers are always returned — including the ones that don't exist yet —
// so the dashboard can offer to create them. A layer that is missing or broken
// carries an empty object, which makes every "effective value" computation below
// treat it as contributing nothing.
function scanSettings(projectPath) {
  const layerDefs = [
    { label: 'global', path: path.join(GLOBAL_CLAUDE_DIR, 'settings.json') },
    { label: 'global-local', path: path.join(GLOBAL_CLAUDE_DIR, 'settings.local.json') },
    { label: 'project', path: path.join(projectPath, '.claude', 'settings.json') },
    { label: 'project-local', path: path.join(projectPath, '.claude', 'settings.local.json') },
  ];
  const layers = [];
  const errors = [];
  const sameFile = []; // dropped because another label already named this file
  const seen = new Map();
  for (const layer of layerDefs) {
    // Two labels can name one file — viewing the home directory itself, or a
    // project whose .claude folder is a link to the global one. This must hold
    // for a file that does not exist yet too, since creating it through the
    // dashboard is exactly how a "this project" edit would land in the global
    // settings instead.
    const key = fileIdentity(layer.path);
    if (seen.has(key)) {
      sameFile.push({ label: layer.label, path: layer.path, ...seen.get(key) });
      continue;
    }
    seen.set(key, { sameAs: layer.path, sameAsLabel: layer.label });
    const res = readJsonSafe(layer.path);
    if (res.error) errors.push({ path: layer.path, error: res.error });
    layers.push({
      label: layer.label,
      path: layer.path,
      exists: !!res.ok,
      broken: !!res.error,
      data: res.ok ? res.data : {},
    });
  }
  return { layers, errors, sameFile };
}

const LAYER_ORDER = ['global', 'global-local', 'project', 'project-local'];

// What each individual settings layer says about one plugin (null = the layer
// is silent, so the plugin inherits whatever a lower layer decided). The
// dashboard needs this to offer a separate "everywhere" and "here" switch.
function pluginLayerStates(settingsLayers, key) {
  const out = {};
  for (const name of LAYER_ORDER) {
    const layer = settingsLayers.find((l) => l.label === name);
    const value = layer?.data?.enabledPlugins?.[key];
    out[name] = typeof value === 'boolean' ? value : null;
  }
  return out;
}

function effectiveEnabledPlugins(settingsLayers) {
  const effective = {};
  for (const name of LAYER_ORDER) {
    const layer = settingsLayers.find((l) => l.label === name);
    if (layer && layer.data.enabledPlugins) {
      for (const [k, v] of Object.entries(layer.data.enabledPlugins)) {
        effective[k] = { enabled: v, setBy: layer.path };
      }
    }
  }
  return effective;
}

// enabledMcpjsonServers / disabledMcpjsonServers / enableAllProjectMcpServers
// are ordinary settings keys that can appear in any settings layer (global or
// project, shared or local) — they are NOT read from ~/.claude.json alone.
// ~/.claude.json's own per-project fields are treated as an extra, lowest
// -precedence layer since some Claude Code versions still populate them.
function collectMcpApprovals(settingsLayers, claudeJsonProjectEntry) {
  const state = {};
  let enableAllDefault = null;
  let enableAllSource = null;

  const applyLayer = (data, sourcePath) => {
    for (const n of data.enabledMcpjsonServers || []) state[n] = { enabled: true, source: sourcePath };
    for (const n of data.disabledMcpjsonServers || []) state[n] = { enabled: false, source: sourcePath };
    if (typeof data.enableAllProjectMcpServers === 'boolean') {
      enableAllDefault = data.enableAllProjectMcpServers;
      enableAllSource = sourcePath;
    }
  };

  if (claudeJsonProjectEntry) applyLayer(claudeJsonProjectEntry, GLOBAL_CLAUDE_JSON);
  for (const name of LAYER_ORDER) {
    const layer = settingsLayers.find((l) => l.label === name);
    if (layer) applyLayer(layer.data, layer.path);
  }

  return { state, enableAllDefault, enableAllSource };
}

// --- plugins --------------------------------------------------------------

function scanPlugins(canonicalProjectPath, settingsLayers) {
  const installedRes = readJsonSafe(path.join(GLOBAL_CLAUDE_DIR, 'plugins', 'installed_plugins.json'));
  const marketplacesRes = readJsonSafe(path.join(GLOBAL_CLAUDE_DIR, 'plugins', 'known_marketplaces.json'));
  const installed = installedRes.ok ? installedRes.data.plugins || {} : {};
  const marketplaces = marketplacesRes.ok ? marketplacesRes.data : {};
  const effective = effectiveEnabledPlugins(settingsLayers);

  const errors = [];
  if (installedRes.error) errors.push({ path: installedRes.path, error: installedRes.error });
  if (marketplacesRes.error) errors.push({ path: marketplacesRes.path, error: marketplacesRes.error });

  const plugins = [];
  for (const [key, records] of Object.entries(installed)) {
    const hasUser = records.some((r) => r.scope === 'user');
    const localRecord = records.find(
      (r) => r.scope === 'local' && r.projectPath && realpathOrResolve(r.projectPath) === canonicalProjectPath
    );
    if (!hasUser && !localRecord) continue;

    const scope = hasUser && localRecord ? 'both' : localRecord ? 'local' : 'user';
    const record = localRecord || records.find((r) => r.scope === 'user');

    const manifestRes = readJsonSafe(path.join(record.installPath, '.claude-plugin', 'plugin.json'));
    const manifest = manifestRes.ok ? manifestRes.data : null;
    if (manifestRes.error) errors.push({ path: manifestRes.path, error: manifestRes.error });

    const contributes = { commands: [], agents: [], skills: [], hooks: null };
    try {
      const commandsDir = path.join(record.installPath, 'commands');
      if (fs.existsSync(commandsDir)) contributes.commands = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'));
    } catch { /* ignore */ }
    try {
      const agentsDir = path.join(record.installPath, 'agents');
      if (fs.existsSync(agentsDir)) contributes.agents = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
    } catch { /* ignore */ }
    try {
      const skillsDir = path.join(record.installPath, 'skills');
      if (fs.existsSync(skillsDir)) {
        contributes.skills = fs.readdirSync(skillsDir).filter((f) => fs.existsSync(path.join(skillsDir, f, 'SKILL.md')));
      }
    } catch { /* ignore */ }
    try {
      const hooksJsonPath = path.join(record.installPath, 'hooks', 'hooks.json');
      const hooksRes = readJsonSafe(hooksJsonPath);
      if (hooksRes.ok) contributes.hooks = hooksRes.data;
    } catch { /* ignore */ }

    const [name, marketplace] = key.split('@');
    plugins.push({
      key,
      name,
      marketplace,
      marketplaceSource: marketplaces[marketplace]?.source || null,
      description: manifest?.description || null,
      author: manifest?.author?.name || null,
      version: record.version,
      installPath: record.installPath,
      scope,
      enabled: effective[key]?.enabled ?? false,
      enabledSetBy: effective[key]?.setBy || null,
      states: pluginLayerStates(settingsLayers, key),
      contributes,
    });
  }
  // Settings can name a plugin that is no longer installed anywhere. It has no
  // effect, but leaving it invisible hides why a setting looks like it does.
  const installedKeys = new Set(Object.keys(installed));
  const missing = Object.entries(effective)
    .filter(([key]) => !installedKeys.has(key))
    .map(([key, v]) => ({ key, enabled: v.enabled, setBy: v.setBy, states: pluginLayerStates(settingsLayers, key) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { plugins: plugins.sort((a, b) => a.key.localeCompare(b.key)), missing, errors };
}

// --- MCP servers ------------------------------------------------------------

function scanMcp(canonicalProjectPath, settingsLayers) {
  const globalJson = readJsonSafe(GLOBAL_CLAUDE_JSON);
  const projectEntry = globalJson.ok ? globalJson.data.projects?.[canonicalProjectPath] : null;

  const userScope = globalJson.ok ? globalJson.data.mcpServers || {} : {};
  const localScope = projectEntry?.mcpServers || {};
  // servers this dashboard has switched off: their config is parked in a shadow
  // key rather than deleted, and they must stay listed so they can be switched
  // back on (otherwise turning one off would be a one-way trip).
  const userDisabled = globalJson.ok ? globalJson.data.disabledUserMcpServers || {} : {};
  const localDisabled = projectEntry?.disabledLocalMcpServers || {};

  const mcpJsonRes = readJsonSafe(path.join(canonicalProjectPath, '.mcp.json'));
  const sharedDefs = mcpJsonRes.ok ? mcpJsonRes.data.mcpServers || {} : {};

  const { state, enableAllDefault, enableAllSource } = collectMcpApprovals(settingsLayers, projectEntry);

  const shared = Object.entries(sharedDefs).map(([name, config]) => {
    let enabled;
    let reason;
    if (state[name]) {
      enabled = state[name].enabled;
      reason = `${enabled ? 'explicitly enabled' : 'explicitly disabled'} for this project (set in ${state[name].source})`;
    } else if (enableAllDefault === true) {
      enabled = true;
      reason = `default: "enable all project MCP servers" is on (set in ${enableAllSource})`;
    } else if (enableAllDefault === false) {
      enabled = false;
      reason = `default: "enable all project MCP servers" is off (set in ${enableAllSource})`;
    } else {
      enabled = null;
      reason = 'not decided yet — Claude Code will ask the first time';
    }
    // Which file to write to when this is switched: a settings layer that
    // names the server outranks ~/.claude.json's own record, so writing the
    // record while a layer says otherwise would be a switch that changes
    // nothing. Null means nothing names it explicitly (the "enable all"
    // default may still be deciding, which `reason` explains).
    return { name, config, enabled, reason, explicitlySetIn: state[name] ? state[name].source : null };
  });

  const errors = [];
  if (mcpJsonRes.error) errors.push({ path: mcpJsonRes.path, error: mcpJsonRes.error });
  if (globalJson.error) errors.push({ path: globalJson.path, error: globalJson.error });

  // A name can be in both lists at once: switched off here, so its definition
  // was parked, and then set up again by another route (`claude mcp add`, or an
  // edit by hand) under the same name. Both definitions are real and only one
  // can win, so the row carries both and the dashboard asks which to keep
  // rather than letting a switch quietly overwrite one with the other.
  const withState = (active, disabled) =>
    [
      ...Object.entries(active).map(([name, config]) => ({
        name,
        config,
        enabled: true,
        parkedDuplicate: disabled[name] || null,
      })),
      ...Object.entries(disabled)
        .filter(([name]) => !(name in active))
        .map(([name, config]) => ({ name, config, enabled: false, parkedDuplicate: null })),
    ].sort((a, b) => a.name.localeCompare(b.name));

  return {
    mcpJsonPath: mcpJsonRes.ok ? mcpJsonRes.path : null,
    user: withState(userScope, userDisabled),
    local: withState(localScope, localDisabled),
    shared,
    errors,
  };
}

// --- skills & agents --------------------------------------------------------

// Only a skill's or subagent's name and description are in the conversation
// from the start — its body is read when it actually gets used. So the weight
// that matters here is those two strings, not the size of the file.
function descriptionWeight(name, description) {
  return Buffer.byteLength(`${name} ${description || ''}`.trim(), 'utf8');
}

function scanEntries(dirPath, fileName, scopeLabel) {
  const out = [];
  if (!fs.existsSync(dirPath)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = path.join(dirPath, entry.name);
    const target = fs.existsSync(path.join(entryPath, fileName))
      ? path.join(entryPath, fileName)
      : fs.existsSync(path.join(entryPath, fileName + '.disabled'))
      ? path.join(entryPath, fileName + '.disabled')
      : null;
    if (!target) continue;
    const res = readTextSafe(target);
    if (!res.ok) continue;
    const fm = parseFrontmatter(res.data);
    out.push({
      name: entry.name,
      scope: scopeLabel,
      path: target,
      disabled: target.endsWith('.disabled'),
      description: fm.description || null,
      startupBytes: descriptionWeight(entry.name, fm.description),
      symlink: resolveIfSymlink(entryPath) !== entryPath ? resolveIfSymlink(entryPath) : null,
    });
  }
  return out;
}

function statIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function scanFlatAgents(dirPath, scopeLabel) {
  const out = [];
  if (!fs.existsSync(dirPath)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // A subagent kept in a dotfiles repo and linked in here is still a
    // subagent; skill folders have always been followed the same way.
    if (!entry.isFile() && !(entry.isSymbolicLink() && statIsFile(path.join(dirPath, entry.name)))) continue;
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.md.disabled')) continue;
    const full = path.join(dirPath, entry.name);
    const res = readTextSafe(full);
    if (!res.ok) continue;
    const fm = parseFrontmatter(res.data);
    out.push({
      name: entry.name.replace(/\.md(\.disabled)?$/, ''),
      scope: scopeLabel,
      path: full,
      disabled: entry.name.endsWith('.disabled'),
      description: fm.description || null,
      startupBytes: descriptionWeight(entry.name, fm.description),
      symlink: resolveIfSymlink(full) !== full ? resolveIfSymlink(full) : null,
    });
  }
  return out;
}

function skillDirs(canonicalProjectPath) {
  return [
    { dir: path.join(GLOBAL_CLAUDE_DIR, 'skills'), scope: 'global' },
    { dir: path.join(canonicalProjectPath, '.claude', 'skills'), scope: 'project' },
  ];
}

function agentDirs(canonicalProjectPath) {
  return [
    { dir: path.join(GLOBAL_CLAUDE_DIR, 'agents'), scope: 'global' },
    { dir: path.join(canonicalProjectPath, '.claude', 'agents'), scope: 'project' },
  ];
}

function scanSkills(canonicalProjectPath, plugins) {
  const list = skillDirs(canonicalProjectPath).flatMap(({ dir, scope }) => scanEntries(dir, 'SKILL.md', scope));
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const skillDirName of p.contributes.skills) {
      const full = path.join(p.installPath, 'skills', skillDirName, 'SKILL.md');
      const res = readTextSafe(full);
      if (!res.ok) continue;
      const fm = parseFrontmatter(res.data);
      list.push({
        name: skillDirName,
        scope: `plugin: ${p.key}`,
        path: full,
        disabled: false,
        description: fm.description || null,
        startupBytes: descriptionWeight(skillDirName, fm.description),
      });
    }
  }
  return list;
}

function scanAgents(canonicalProjectPath, plugins) {
  const list = agentDirs(canonicalProjectPath).flatMap(({ dir, scope }) => scanFlatAgents(dir, scope));
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const agentFile of p.contributes.agents) {
      const full = path.join(p.installPath, 'agents', agentFile);
      const res = readTextSafe(full);
      if (!res.ok) continue;
      const fm = parseFrontmatter(res.data);
      list.push({
        name: agentFile.replace(/\.md$/, ''),
        scope: `plugin: ${p.key}`,
        path: full,
        disabled: false,
        description: fm.description || null,
        startupBytes: descriptionWeight(agentFile.replace(/\.md$/, ''), fm.description),
      });
    }
  }
  return list;
}

// --- hooks -------------------------------------------------------------

function readParked() {
  const res = readJsonSafe(PARKED_FILE);
  return res.ok ? res.data : {};
}

// One hook entry is a matcher plus the commands it runs. Summarize the commands
// so the dashboard can show what a hook actually does without dumping raw JSON.
function describeHookEntry(entry) {
  const commands = Array.isArray(entry?.hooks)
    ? entry.hooks.map((h) => h.command || h.type || JSON.stringify(h))
    : [];
  return {
    matcher: entry?.matcher ?? '(every time)',
    commands,
    // Sent back with a toggle so the server can confirm it is switching the
    // hook the user actually clicked, not whatever has drifted into that
    // position since the page was drawn.
    signature: JSON.stringify(entry),
  };
}

// A hook this dashboard switched off is stored as { index, entry } so it can go
// back where it was; entries written before that was recorded are plain entries.
// The wrapper is recognised by a key no hook definition would ever carry, so a
// hook whose own fields happen to be named like the wrapper's can't be mistaken
// for one and unwrapped into nonsense.
export const PARKED_SLOT_KEY = '__dashboardSlot';

export function unpackParkedHook(parked) {
  const isWrapper =
    parked && typeof parked === 'object' && !Array.isArray(parked) && PARKED_SLOT_KEY in parked && 'entry' in parked;
  if (isWrapper) return { index: parked[PARKED_SLOT_KEY], entry: parked.entry };
  return { index: null, entry: parked };
}

function scanHooks(settingsLayers, plugins) {
  const out = [];
  const parked = readParked().hooks || {};

  for (const layer of settingsLayers) {
    const isGlobal = layer.label.startsWith('global');
    const active = layer.data.hooks || {};
    for (const [event, entries] of Object.entries(active)) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        out.push({
          source: layer.path,
          sourceLabel: layer.label,
          global: isGlobal,
          event,
          id: `active:${index}`,
          enabled: true,
          editable: true,
          ...describeHookEntry(entry),
        });
      });
    }
    // hooks this dashboard switched off: still listed, so they can come back
    for (const [event, entries] of Object.entries(parked[layer.path] || {})) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((parkedEntry, index) => {
        out.push({
          source: layer.path,
          sourceLabel: layer.label,
          global: isGlobal,
          event,
          id: `parked:${index}`,
          enabled: false,
          editable: true,
          ...describeHookEntry(unpackParkedHook(parkedEntry).entry),
        });
      });
    }
  }

  // Hooks that come from a plugin can't be switched off one by one —
  // they exist only as long as the plugin is enabled.
  for (const p of plugins) {
    if (!p.enabled || !p.contributes.hooks) continue;
    for (const [event, entries] of Object.entries(p.contributes.hooks.hooks || p.contributes.hooks)) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        out.push({
          source: `plugin: ${p.key}`,
          sourceLabel: `plugin: ${p.key}`,
          global: false,
          event,
          id: `plugin:${index}`,
          enabled: true,
          editable: false,
          ...describeHookEntry(entry),
        });
      });
    }
  }
  return out;
}

// --- auto-loaded memory (this environment's own memory system) --------------

function scanMemory(canonicalProjectPath) {
  // Claude Code names this folder after the project path with every character
  // that is not a letter or a digit turned into a dash — not just the
  // separators. Replacing only the slashes silently missed the memory of any
  // project whose path holds a dot, an underscore or a space (a worktree under
  // ".claude", a "site.github.io" folder, "Application Support").
  const slug = canonicalProjectPath.replace(/[^A-Za-z0-9]/g, '-');
  const memoryDir = path.join(GLOBAL_CLAUDE_DIR, 'projects', slug, 'memory');
  const files = [];
  if (fs.existsSync(memoryDir)) {
    try {
      for (const entry of fs.readdirSync(memoryDir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.md(\.disabled)?$/.test(entry.name)) continue;
        const full = path.join(memoryDir, entry.name);
        const res = readTextSafe(full);
        if (res.ok) {
          files.push({
            name: entry.name,
            path: full,
            bytes: Buffer.byteLength(res.data, 'utf8'),
            disabled: entry.name.endsWith('.disabled'),
            isIndex: entry.name.startsWith('MEMORY.md'),
          });
        }
      }
    } catch { /* ignore */ }
  }
  return { dir: memoryDir, exists: fs.existsSync(memoryDir), files };
}

// --- how much of this actually lands in the conversation --------------------

// What goes in before you type anything is not the same for every category:
// an instructions file goes in whole (plus whatever its "@" lines pull in),
// while a skill or subagent contributes only its name and description. Tool
// connections send the list of tools they offer, which is often the largest
// single thing — but reading it means connecting to the server, which this
// dashboard never does, so those are reported as not measured rather than
// guessed at.
function summarizeWeight({ claudeMd, skills, agents, memory, mcp }) {
  const items = [];

  for (const f of claudeMd.files) {
    if (f.disabled) continue;
    const importedBytes = f.importedFiles.reduce((n, i) => n + i.bytes, 0);
    items.push({
      category: 'instructions',
      name: f.path.split(path.sep).pop(),
      detail: f.label,
      path: f.path,
      bytes: f.bytes + importedBytes,
      importedBytes,
    });
  }

  for (const s of skills) {
    if (s.disabled) continue;
    items.push({ category: 'skills', name: s.name, detail: s.scope, path: s.path, bytes: s.startupBytes || 0 });
  }
  for (const a of agents) {
    if (a.disabled) continue;
    items.push({ category: 'agents', name: a.name, detail: a.scope, path: a.path, bytes: a.startupBytes || 0 });
  }

  const index = memory.files.find((f) => f.isIndex && !f.disabled);
  if (index) {
    items.push({ category: 'memory', name: index.name, detail: 'loaded at the start', path: index.path, bytes: index.bytes });
  }

  const CATEGORY_TITLES = {
    instructions: 'Instructions files',
    skills: 'Skills (names and descriptions only)',
    agents: 'Subagents (names and descriptions only)',
    memory: 'Memory index',
  };
  const categories = Object.keys(CATEGORY_TITLES).map((key) => {
    const own = items.filter((i) => i.category === key);
    return {
      key,
      title: CATEGORY_TITLES[key],
      count: own.length,
      bytes: own.reduce((n, i) => n + i.bytes, 0),
    };
  });

  const connections = [
    ...mcp.user.filter((s) => s.enabled),
    ...mcp.shared.filter((s) => s.enabled === true),
    ...mcp.local.filter((s) => s.enabled),
  ].length;

  return {
    measuredBytes: categories.reduce((n, c) => n + c.bytes, 0),
    categories,
    biggest: items.sort((a, b) => b.bytes - a.bytes).slice(0, 12),
    notMeasured: { toolConnections: connections },
  };
}

// --- aggregate ------------------------------------------------------------

// --- what was looked at, and what was not ---------------------------------

// A tool that tells you what loads is only trustworthy if it also tells you
// where it did not look. Every line below is built from the same paths the scan
// itself used, so it cannot drift into describing a scan that no longer happens.
//
// This path is not read — only checked for. It is where Claude Code documents
// that a settings file installed for the whole machine goes; that file outranks
// every settings file this dashboard shows, so its existence is worth saying
// out loud even though its contents are none of our business.
const MANAGED_SETTINGS_PATH =
  process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : process.platform === 'win32'
    ? 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'
    : '/etc/claude-code/managed-settings.json';

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// A file that is not there and a file that is there and unreadable are not the
// same thing, and calling the second one missing is what this section kept
// getting wrong: the top of the page says it is there and could not be read
// while this said it did not exist.
function fileState(filePath, unreadable, notThere = ' — not there') {
  if (unreadable.has(filePath)) {
    return ' — it is there, but could not be read (see the warning at the top), so nothing in it is listed';
  }
  return fs.existsSync(filePath) ? '' : notThere;
}

const LAYER_NAMES = {
  global: 'your settings for every project',
  'global-local': 'your personal settings for every project',
  project: "this project's own settings",
  'project-local': 'your personal settings for this project',
};

function describeCoverage({ projectPath, claudeMd, settingsLayers, settingsSameFile, plugins, mcp, memory, warnings }) {
  const { chain, subdirs, subdirsListed, importDepth } = claudeMd.searched;
  const refs = claudeMd.references;
  const off = plugins.filter((p) => !p.enabled).length;
  const managedExists = fs.existsSync(MANAGED_SETTINGS_PATH);
  // every file the scan opened and could not read; the page warns about each
  const unreadable = new Set(warnings.map((w) => w.path));
  const installedPlugins = path.join(GLOBAL_CLAUDE_DIR, 'plugins', 'installed_plugins.json');
  const knownMarketplaces = path.join(GLOBAL_CLAUDE_DIR, 'plugins', 'known_marketplaces.json');
  const mcpJson = mcp.mcpJsonPath || path.join(projectPath, '.mcp.json');

  return [
    {
      title: 'Instructions files',
      looked: [
        path.join(GLOBAL_CLAUDE_DIR, 'CLAUDE.md'),
        ...chain.map((dir) => `${path.join(dir, 'CLAUDE.md')} — and CLAUDE.local.md beside it`),
        !subdirsListed
          ? 'folders directly inside the project — the project folder itself could not be listed, so none of them were looked at'
          : subdirs.length
          ? `CLAUDE.md in each folder directly inside the project, links to folders included: ${subdirs.join(', ')}`
          : 'folders directly inside the project — there are none',
        `whatever an @ line pulls in, and what those pull in, ${importDepth} levels deep at most, never the same file twice`,
        `files only named in the text of those instructions files, or in the text of anything an @ line pulls into them — a link, a path in backticks, a path written plainly — ending in ${
          refs.extensions.join(' ')
        }, and there on disk beside the file that names them: followed ${refs.depth} levels and ${refs.limit} files at most${
          refs.truncated ? ', and that ceiling was reached here, so what is listed is only part of what is named' : ''
        }`,
      ],
      notLooked: [
        'folders more than one level inside the project — Claude Code reads a CLAUDE.md in any folder you work in, however deep, so a nested one further down would not be listed here',
        `a file named in the text whose name ends in anything else — a "docs/conventions" or a "setup.sh" written in the text is not followed, only the endings listed above are`,
        'a file named in the text that is not there on disk beside the file naming it — nothing is listed for it, and a path meant from the project root but written in a CLAUDE.md in a subfolder lands here (a dead @ line is listed, though, because that one really was going to be loaded)',
        'anything named in the text of an instructions file that is switched off — while it is off its text points nowhere',
        'a CLAUDE.md inside a folder of the project whose name starts with a dot — the walk over the subfolders above skips those (the global .claude folder is read; that is a different path, named directly)',
        'CLAUDE.local.md inside those subfolders — that name is only looked for in the project folder and the ones above it',
      ],
    },
    {
      title: 'Settings',
      looked: [
        ...settingsLayers.map((l) => `${l.path}${fileState(l.path, unreadable, ' — not there yet')}`),
        // a project whose .claude folder is a link to the global one — or the
        // home folder viewed as a project — names one file twice. Saying
        // nothing left that path out of both columns, and naming the path
        // twice said "X is the same file as X": it is the roles that differ.
        ...settingsSameFile.map(
          (l) => `${l.path} — this would be ${LAYER_NAMES[l.label]}, but it is the same file as ${LAYER_NAMES[l.sameAsLabel]} above, so it is read once, not twice`
        ),
      ],
      notLooked: [
        managedExists
          ? `${MANAGED_SETTINGS_PATH} — this file IS on this machine and is not read here. A settings file installed for the whole machine outranks all four above, so something here may say "on" while that file turns it off.`
          : `${MANAGED_SETTINGS_PATH} — where a settings file installed for the whole machine would be. There is none on this machine.`,
        'settings given on the command line when Claude Code starts, and anything set through environment variables',
      ],
    },
    {
      title: 'Plugins',
      looked: [
        `${installedPlugins}${fileState(installedPlugins, unreadable)}`,
        `${knownMarketplaces}${fileState(knownMarketplaces, unreadable)}`,
        plugins.length
          ? `the plugin.json and hooks/hooks.json of each installed plugin (${plural(plugins.length, 'plugin', 'plugins')}), switched on or off`
          : unreadable.has(installedPlugins)
          ? 'each installed plugin — which ones those are could not be read, so none are listed above'
          : 'each installed plugin — there are none on this machine',
      ],
      notLooked: off
        ? [
            // the plugin's own files ARE opened; what is skipped is the files
            // its skills and subagents live in, since none of them load
            `the SKILL.md and subagent files of the ${off === 1 ? 'switched-off plugin' : `${off} switched-off plugins`} — those are not opened, because nothing of theirs loads while the plugin is off. The hooks it would add are read but not listed, for the same reason.`,
          ]
        : [plugins.length ? 'nothing here — every installed plugin is switched on' : 'nothing here — there are no plugins to leave out'],
    },
    {
      title: 'Tool connections (MCP)',
      looked: [
        unreadable.has(GLOBAL_CLAUDE_JSON)
          ? `${GLOBAL_CLAUDE_JSON} — it is there, but could not be read (see the warning at the top). It is where connections for every project, this project's private ones, and Claude Code's own record of the shared ones live, so none of that is listed above.`
          : `${GLOBAL_CLAUDE_JSON} — connections for every project, this project's private ones, and Claude Code's own record of which shared ones it may use`,
        `${mcpJson}${fileState(mcpJson, unreadable)}`,
        'the enabled/disabled lists inside each settings file above',
      ],
      notLooked: [
        'the list of tools each connection sends. Reading it would mean connecting to those servers, which this never does — so that list, usually the largest single thing that enters a conversation, is not in the count at the top of the page.',
      ],
    },
    {
      title: 'Skills and subagents',
      looked: [
        ...skillDirs(projectPath).map(({ dir }) => `${path.join(dir, '<each folder>', 'SKILL.md')}`),
        ...agentDirs(projectPath).map(({ dir }) => `${path.join(dir, '<each .md file>')}`),
        'the skills and subagents each switched-on plugin brings with it',
        'each of those files in full — though only the name and description count towards what loads, since the body does not go in until the skill or subagent is actually used',
      ],
      notLooked: [
        'folders in there that have no SKILL.md, and anything nested a further folder down',
        'skill and subagent folders anywhere else — only the four above, plus what a switched-on plugin brings',
      ],
    },
    {
      title: 'Hooks',
      looked: [
        'the hooks block of each settings file above',
        'the hooks each switched-on plugin brings (a switched-off one keeps its hooks to itself, so they are not listed)',
        `${PARKED_FILE} — the hooks this dashboard has switched off, kept so they can be switched back on`,
      ],
      notLooked: ['what a hook actually does when it runs — the command is shown, never run or read'],
    },
    {
      title: 'Memory',
      looked: [`${memory.dir}${memory.exists ? '' : ' — not there'}`],
      notLooked: [
        'memory kept for any other project',
        'anything below that folder — only the .md files directly inside it are listed',
      ],
    },
  ];
}

export function buildInventory(projectPathInput) {
  const resolved = path.resolve(projectPathInput);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${projectPathInput}`);
  }
  const projectPath = realpathOrResolve(resolved);

  const claudeMd = scanClaudeMd(projectPath);
  const { layers: settingsLayers, errors: settingsErrors, sameFile: settingsSameFile } = scanSettings(projectPath);
  const { plugins, missing: missingPlugins, errors: pluginErrors } = scanPlugins(projectPath, settingsLayers);
  const mcp = scanMcp(projectPath, settingsLayers);
  const skills = scanSkills(projectPath, plugins);
  const agents = scanAgents(projectPath, plugins);
  const hooks = scanHooks(settingsLayers, plugins);
  const memory = scanMemory(projectPath);

  const warnings = [...settingsErrors, ...pluginErrors, ...mcp.errors].map((e) => ({
    path: e.path,
    message: `Could not use this file — it is there, but could not be read as settings (${e.error}). It is being ignored, which may make something look more/less enabled than it really is.`,
  }));

  return {
    projectPath,
    generatedAt: new Date().toISOString(),
    warnings,
    weight: summarizeWeight({ claudeMd, skills, agents, memory, mcp }),
    coverage: describeCoverage({ projectPath, claudeMd, settingsLayers, settingsSameFile, plugins, mcp, memory, warnings }),
    claudeMd,
    settingsLayers,
    plugins,
    missingPlugins,
    mcp,
    skills,
    agents,
    hooks,
    memory,
  };
}

// The security boundary for editing: a file may only be written or renamed if
// the dashboard is actually showing it for this project. That keeps the rule
// easy to state ("you can change what you can see") and means no separate list
// of path patterns can drift out of step with what the scanner reports.
export function collectEditablePaths(projectPathInput) {
  return editablePathsFrom(buildInventory(projectPathInput));
}

// Takes an inventory that has already been built. Reading one file used to
// build three of them — several megabytes of ~/.claude.json read three times
// to answer one question — because each of these helpers started from scratch.
export function editablePathsFrom(inv) {
  const set = new Set();
  const add = (p) => {
    if (!p) return;
    set.add(p);
    set.add(p.endsWith('.disabled') ? p.slice(0, -'.disabled'.length) : p + '.disabled');
  };
  for (const f of [...inv.claudeMd.files, ...inv.claudeMd.nested]) add(f.path);
  // A file an "@" line pulls in is instructions text that loads with the rest,
  // so it can be changed here too — but only under the exact name the "@" line
  // gives it, and with no ".disabled" twin: switching one off would not park
  // it, it would leave the "@" line pointing at nothing.
  for (const f of [...inv.claudeMd.files, ...inv.claudeMd.nested]) {
    for (const i of f.importedFiles) if (!i.missing && !i.error && !i.alreadyPulledIn) set.add(i.path);
  }
  for (const l of inv.settingsLayers) add(l.path);
  for (const s of [...inv.skills, ...inv.agents]) if (!s.scope.startsWith('plugin:')) add(s.path);
  for (const f of inv.memory.files) add(f.path);
  add(inv.mcp.mcpJsonPath || path.join(inv.projectPath, '.mcp.json'));
  return set;
}

// Everything the dashboard lists can be READ in full, including files owned by
// an installed plugin — you should be able to see what a plugin is telling
// Claude. Writing them is still refused (see assertEditable), because a plugin
// update would overwrite the change.
export function collectViewablePaths(projectPathInput) {
  return viewablePathsFrom(buildInventory(projectPathInput));
}

export function viewablePathsFrom(inv) {
  const set = editablePathsFrom(inv);
  for (const entry of [...inv.skills, ...inv.agents]) set.add(entry.path);
  // A file the instructions merely point at can be read here — that is the
  // whole point of listing it — but not written: it is an ordinary project
  // document that nothing here loads, and it belongs to your own editor.
  for (const f of inv.claudeMd.references ? inv.claudeMd.references.files : []) set.add(f.path);
  return set;
}

export function listKnownProjects() {
  const globalJson = readJsonSafe(GLOBAL_CLAUDE_JSON);
  if (!globalJson.ok) return [];
  return Object.keys(globalJson.data.projects || {}).sort();
}

export const paths = { HOME, GLOBAL_CLAUDE_DIR, GLOBAL_CLAUDE_JSON, DASHBOARD_DIR, PARKED_FILE };
