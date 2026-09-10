// The editor and the project switcher, driven the way the page drives them.
//
// Run with:  npm test
//
// public/app.js is a plain browser script, so it is run here in a vm context
// with a small stand-in for the few browser things it uses: elements addressed
// by id, event listeners, confirm/alert, and fetch. Everything below the fetch
// is real — a real server, real files, a throwaway HOME — so these are not
// tests of a mock: the file on disk is what says whether a save worked.
//
// Top-level `function` declarations in a script become properties of that
// context's global object, which is how the page's own openEditor/saveEditor
// are called here. `let`/`const` do not, so nothing reaches inside the page's
// state: every check reads what you could see — the elements, the requests
// that went out, and the files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-editor-')));
const HOME = path.join(SANDBOX, 'home');
const PROJECT = path.join(SANDBOX, 'proj');
const OTHER = path.join(SANDBOX, 'other-proj');
process.env.HOME = HOME;

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
w(path.join(HOME, '.claude', 'CLAUDE.md'), '# global rules\n');
w(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({}, null, 2));
w(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }, null, 2));
w(path.join(PROJECT, 'CLAUDE.md'), '# project rules\none\ntwo\nthree\n');
w(path.join(OTHER, 'CLAUDE.md'), '# the other project\n');

const { createServer } = await import('../src/server.js');

const net = await import('node:net');
const PORT = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
// The restart is handed to the server rather than performed by it, so clicking
// the button here does not restart the test run.
let restartsAsked = 0;
const server = createServer(PROJECT, PORT, { onRestart: () => { restartsAsked++; } });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checksRun = 0;
const check = (label, cond, detail) => {
  checksRun++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `  → ${detail ?? ''}`}`);
  if (!cond) failures++;
};

// --- the few browser things the page uses -----------------------------

// Only the ids the page actually has. A stub that invents an element for any id
// asked of it would let the page address something that is not in index.html
// and still pass here, while the real page threw on null.
const markup = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const knownIds = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const elements = new Map();
function makeEl(id) {
  const classes = new Set();
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    readOnly: false,
    handlers: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    appendChild() {},
    focus() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}
const el = (id) => {
  if (!knownIds.has(id)) throw new Error(`the page asked for #${id}, which is not in index.html`);
  if (!elements.has(id)) elements.set(id, makeEl(id));
  return elements.get(id);
};

const documentHandlers = {};
const windowHandlers = {};
const document = {
  getElementById: el,
  createElement: () => makeEl('created'),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener(type, fn) {
    (documentHandlers[type] = documentHandlers[type] || []).push(fn);
  },
};
const windowStub = {
  addEventListener(type, fn) {
    (windowHandlers[type] = windowHandlers[type] || []).push(fn);
  },
};

// what the page asked for, so a check can say where a request went
const requests = [];
const fetchShim = async (url, opts = {}) => {
  const absolute = url.startsWith('http') ? url : BASE + url;
  requests.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  return fetch(absolute, { ...opts, headers: { Origin: BASE, ...(opts.headers || {}) } });
};

let reloads = 0;
let confirmAnswer = true;
const asked = [];
const alerted = [];

const context = vm.createContext({
  document,
  window: windowStub,
  location: { search: '', reload: () => { reloads++; } },
  fetch: fetchShim,
  URLSearchParams,
  console,
  setTimeout,
  CSS: { escape: (s) => s },
  confirm: (question) => {
    asked.push(question);
    return confirmAnswer;
  },
  alert: (message) => alerted.push(message),
});
vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context, { filename: 'app.js' });

// The page draws its buttons as HTML text, so a click is aimed by reading that
// text back: the same data attributes and classes a real button would carry.
// Making them up here instead would let a renamed action pass unnoticed.
const unescapeHtml = (s2) =>
  s2.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function buttonsIn(html) {
  return [...html.matchAll(/<button\b([^>]*)>/g)].map((m) => {
    const dataset = {};
    for (const attr of m[1].matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      dataset[attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = unescapeHtml(attr[2]);
    }
    const classes = (m[1].match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/);
    return { dataset, classes };
  }).filter((b) => b.dataset.action);
}

const clickRendered = (target, pick, what = 'a button') => {
  const found = buttonsIn(target.innerHTML).find((b) => pick(b.dataset, b.classes));
  if (!found) throw new Error(`${what} is not among the buttons #${target.id} drew`);
  const button = {
    dataset: found.dataset,
    classList: { contains: (c) => found.classes.includes(c) },
    closest: () => button,
  };
  return Promise.all((target.handlers.click || []).map((fn) => fn({ target: button })));
};
const openFile = (p2) => clickRendered(el('content'), (d) => d.action === 'edit' && d.path === p2, `an edit button for ${p2}`);
const fireClick = (target) => Promise.all((target.handlers.click || []).map((fn) => fn({ target })));

const settle = () => new Promise((r) => setTimeout(r, 60));
const projectMd = path.join(PROJECT, 'CLAUDE.md');
const otherMd = path.join(OTHER, 'CLAUDE.md');
const editorText = el('editor-text');
const editor = el('editor');

// init() runs when the script is loaded; wait for the first inventory
for (let i = 0; i < 100 && !el('content').innerHTML.includes('block'); i++) await settle();
check('the page loads the project it was started for',
  requests.some((r) => r.url.startsWith(`/api/inventory?path=${encodeURIComponent(PROJECT)}`)), JSON.stringify(requests));

// --- opening, and not losing what you typed ---------------------------
await openFile(projectMd);
await settle();
check('a file opens with its own text', editorText.value === '# project rules\none\ntwo\nthree\n', JSON.stringify(editorText.value));
check('and the editor is showing', editor.hidden === false);

editorText.value = '# project rules\none\nEDITED\nthree\n';
confirmAnswer = false;
asked.length = 0;
await fireClick(el('editor-close'));
check('closing with unsaved typing asks first', asked.length === 1 && /have not saved/.test(asked[0]), JSON.stringify(asked));
check('and saying no keeps the file open, with the typing still there',
  editor.hidden === false && editorText.value.includes('EDITED'));

asked.length = 0;
await openFile(path.join(HOME, '.claude', 'CLAUDE.md'));
check('opening another file asks too, and is not opened when you say no',
  asked.length === 1 && editorText.value.includes('EDITED'), JSON.stringify(asked));

// --- saving -----------------------------------------------------------
confirmAnswer = true;
asked.length = 0;
await context.saveEditor();
check('saving writes the file', fs.readFileSync(projectMd, 'utf8') === '# project rules\none\nEDITED\nthree\n');
check('and says where the version it replaced was kept', /Saved\./.test(el('editor-msg').textContent), el('editor-msg').textContent);
await fireClick(el('editor-close'));
check('after saving, closing does not ask', asked.length === 0 && editor.hidden === true, JSON.stringify(asked));

await openFile(projectMd);
await settle();
editorText.value = '# saved once more\n';
await context.saveEditor();
check('a second save in a row is not mistaken for someone else writing the file',
  fs.readFileSync(projectMd, 'utf8') === '# saved once more\n' && /Saved\./.test(el('editor-msg').textContent),
  el('editor-msg').textContent);

// two saves fired at once: the second must not go out with a modification
// time the first is in the middle of replacing
requests.length = 0;
editorText.value = '# saved twice at once\n';
await Promise.all([context.saveEditor(), context.saveEditor(), context.saveEditor()]);
check('three saves fired at once send exactly one write',
  requests.filter((r) => r.url === '/api/file/save').length === 1,
  JSON.stringify(requests.map((r) => r.url)));
check('and the file holds what was typed', fs.readFileSync(projectMd, 'utf8') === '# saved twice at once\n');

// --- switching project ------------------------------------------------
editorText.value = '# not saved yet\n';
confirmAnswer = false;
asked.length = 0;
requests.length = 0;
el('project-path').value = OTHER;
await fireClick(el('load-btn'));
await settle();
check('switching project with unsaved typing asks first', asked.length === 1, JSON.stringify(asked));
check('and saying no stays where you were, with the editor still open',
  editor.hidden === false && !requests.some((r) => r.url.includes(encodeURIComponent(OTHER))),
  JSON.stringify(requests.map((r) => r.url)));

confirmAnswer = true;
asked.length = 0;
await fireClick(el('load-btn'));
await settle();
check('saying yes closes the editor and loads the other project',
  editor.hidden === true && requests.some((r) => r.url.startsWith(`/api/inventory?path=${encodeURIComponent(OTHER)}`)),
  JSON.stringify(requests.map((r) => r.url)));
check('and the unsaved typing was not written anywhere',
  fs.readFileSync(projectMd, 'utf8') === '# saved twice at once\n' && fs.readFileSync(otherMd, 'utf8') === '# the other project\n');

// a save already on its way keeps the file and project it started with, even
// if the project is switched underneath it
el('project-path').value = PROJECT;
await fireClick(el('load-btn'));
await settle();
await openFile(projectMd);
await settle();
editorText.value = '# written while switching\n';
requests.length = 0;
const saving = context.saveEditor();
el('project-path').value = OTHER;
await fireClick(el('load-btn'));
await saving;
await settle();
const save = requests.find((r) => r.url === '/api/file/save');
const reread = requests.find((r) => r.url.startsWith('/api/file?'));
check('a save already on its way is sent with the project it was opened for',
  save?.body.projectPath === PROJECT && save?.body.filePath === projectMd, JSON.stringify(save));
check('and every request it makes after that names that project too, not the one just switched to',
  reread?.url.includes(`project=${encodeURIComponent(PROJECT)}`) && !reread?.url.includes(encodeURIComponent(OTHER)),
  reread?.url);
check('it lands in that project\'s file', fs.readFileSync(projectMd, 'utf8') === '# written while switching\n');
check('and it does not end in an error message', /Saved\./.test(el('editor-msg').textContent), el('editor-msg').textContent);

// --- leaving the page -------------------------------------------------
el('project-path').value = PROJECT;
await fireClick(el('load-btn'));
await settle();
await openFile(projectMd);
await settle();
const beforeUnload = (windowHandlers.beforeunload || [])[0];
let prevented = 0;
beforeUnload({ preventDefault: () => prevented++ });
check('leaving the page with nothing typed does not warn', prevented === 0);
editorText.value = '# typed but not saved\n';
beforeUnload({ preventDefault: () => prevented++ });
check('leaving it with unsaved typing does', prevented === 1);

// --- earlier versions -------------------------------------------------
confirmAnswer = true;
editorText.value = '# version A\nline one\nline two\n';
await context.saveEditor();
editorText.value = '# version B\nline one\nline two changed\n';
await context.saveEditor();
await settle();
check('the earlier versions button appears, and counts them',
  el('editor-versions').hidden === false && /Earlier versions \(\d+\)/.test(el('editor-versions').textContent),
  el('editor-versions').textContent);

await fireClick(el('editor-versions'));
check('opening the list shows one row per version',
  el('editor-history').hidden === false && el('editor-history').innerHTML.includes('Put this one back'),
  el('editor-history').innerHTML.slice(0, 120));

const list = await (await fetch(`${BASE}/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`, { headers: { Origin: BASE } })).json();
const newest = list.versions[0];
check('the row for a version carries the id the page will send back',
  buttonsIn(el('editor-history').innerHTML).some((b) => b.dataset.action === 'version-diff' && b.dataset.id === newest.id),
  JSON.stringify(buttonsIn(el('editor-history').innerHTML).map((b) => b.dataset)).slice(0, 200));
await clickRendered(el('editor-history'), (d) => d.action === 'version-diff' && d.id === newest.id, 'the compare button');
await settle();
const shown = el('editor-history').innerHTML;
check('comparing a version marks what went and what came',
  shown.includes('− line two') && shown.includes('+ line two changed'), shown.slice(shown.indexOf('diff'), 400));

asked.length = 0;
await clickRendered(el('editor-history'), (d) => d.action === 'version-restore' && d.id === newest.id, 'the restore button');
await settle();
check('putting a version back asks first, then writes it',
  asked.length === 1 && fs.readFileSync(projectMd, 'utf8') === '# version A\nline one\nline two\n', JSON.stringify(asked));
check('and the editor shows what is now in the file',
  editorText.value === '# version A\nline one\nline two\n', JSON.stringify(editorText.value));
check('what it replaced was kept as a version too',
  (await (await fetch(`${BASE}/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`, { headers: { Origin: BASE } })).json()).versions.length > list.versions.length);

// --- a file that can be read but not written --------------------------
const pluginSkill = path.join(HOME, '.claude', 'plugins', 'cache', 'demo', 'skills', 'thing', 'SKILL.md');
w(pluginSkill, '---\nname: thing\ndescription: from a plugin\n---\nplugin body\n');
w(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: { 'demo@market': [{ scope: 'user', version: '1.0.0', installPath: path.join(HOME, '.claude', 'plugins', 'cache', 'demo') }] },
}, null, 2));
w(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));
await fireClick(el('load-btn'));
await settle();
await openFile(pluginSkill);
await settle();
check('a plugin\'s file opens read-only, with the reason shown',
  editorText.readOnly === true && el('editor-save').hidden === true && el('editor-msg').textContent.length > 0,
  el('editor-msg').textContent);
requests.length = 0;
editorText.value = 'changed';
await context.saveEditor();
check('and saving it does not even try',
  requests.length === 0 && fs.readFileSync(pluginSkill, 'utf8').includes('plugin body'), JSON.stringify(requests));
asked.length = 0;
await fireClick(el('editor-close'));
check('typing into a read-only file is not treated as unsaved work',
  asked.length === 0 && editor.hidden === true, JSON.stringify(asked));

// --- a switch that answers with a message ------------------------------
// The shared-server switch can land in a different file from the one that was
// deciding, and says so; nothing was checking that the page ever shows it.
w(path.join(PROJECT, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs' } } }, null, 2));
w(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({
  enabledPlugins: { 'demo@market': true },
  disabledMcpjsonServers: ['docs'],
}, null, 2));
el('project-path').value = PROJECT;
await fireClick(el('load-btn'));
await settle();
alerted.length = 0;
await clickRendered(el('content'), (d) => d.action === 'toggle-mcp-shared' && d.name === 'docs', 'the shared-server switch');
await settle();
check('the page shows what the switch had to say',
  alerted.length === 1 && /every project/.test(alerted[0]), JSON.stringify(alerted));
check('and the switch changed this project without touching the file that applies to all of them',
  JSON.parse(fs.readFileSync(path.join(PROJECT, '.claude', 'settings.json'), 'utf8')).enabledMcpjsonServers?.includes('docs') &&
  JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')).disabledMcpjsonServers.includes('docs'),
  fs.readFileSync(path.join(PROJECT, '.claude', 'settings.json'), 'utf8'));

// --- an old server behind a new page -----------------------------------
check('nothing is said when the server is at least as new as its files',
  context.staleWarning({ startedAt: 2000, sourceChangedAt: 1000 }) === '' &&
  context.staleWarning(null) === '' && context.staleWarning({ startedAt: 2000 }) === '',
  JSON.stringify(context.staleWarning({ startedAt: 2000, sourceChangedAt: 1000 })));
const stale = context.staleWarning({ startedAt: 1000, sourceChangedAt: 2000 });
check('and when it is older, the page says so and offers to start it again',
  /running since/.test(stale) && buttonsIn(stale).some((b) => b.dataset.action === 'restart'), stale);

// the page must not die on an answer that is missing something it now asks for
const full = await (await fetch(`${BASE}/api/inventory?path=${encodeURIComponent(PROJECT)}`, { headers: { Origin: BASE } })).json();
delete full.coverage;
let threw = null;
try {
  context.render(full);
} catch (err) {
  threw = err.message;
}
check('an answer without one of the things the page asks for leaves that part out, not the page',
  threw === null && el('content').innerHTML.includes('id="claude-md"') && !el('content').innerHTML.includes('id="coverage"'),
  threw || el('content').innerHTML.slice(0, 160));
check('and no link is left pointing at the part that is not there',
  !el('side-nav').innerHTML.includes('#coverage') && el('side-nav').innerHTML.includes('#claude-md'),
  el('side-nav').innerHTML.slice(0, 200));

// --- the layers behind a short CLAUDE.md -------------------------------
// A file an "@" line pulls in and a file the text merely names both get a row
// with a button; only the first of the two can be written from here.
{
  const pulled = path.join(PROJECT, 'shared', 'rules.md');
  const pointed = path.join(PROJECT, 'docs', 'architecture.md');
  w(pulled, '# pulled in\n');
  w(pointed, '# pointed at\n');
  w(path.join(PROJECT, 'CLAUDE.md'), '# project rules\n@shared/rules.md\nAlso read docs/architecture.md first.\n');
  el('project-path').value = PROJECT;
  await fireClick(el('load-btn'));
  await settle();

  const drawn = el('content').innerHTML;
  check('a file an @ line pulls in gets its own row on the page, not just a number',
    drawn.includes('shared/rules.md') && buttonsIn(drawn).some((b) => b.dataset.action === 'edit' && b.dataset.path === pulled),
    drawn.slice(drawn.indexOf('claude-md'), drawn.indexOf('claude-md') + 400));
  check('a file the text only names gets a section of its own, and a button',
    drawn.includes('id="references"') && buttonsIn(drawn).some((b) => b.dataset.action === 'edit' && b.dataset.path === pointed),
    drawn.includes('id="references"'));
  check('the section says how much text is behind the pointers, since that is the point of it',
    el('content').innerHTML.includes(`<strong>${fs.statSync(pointed).size} characters</strong> of text sit behind`),
    (el('content').innerHTML.match(/<div class="section-note">[\s\S]{0,120}/) || [''])[0]);
  check('and the side nav links to it',
    el('side-nav').innerHTML.includes('#references'), el('side-nav').innerHTML.slice(0, 300));

  await openFile(pulled);
  await settle();
  check('opening the pulled-in file gives something that can be changed',
    editorText.readOnly === false && editorText.value.includes('pulled in'), editorText.value);
  await fireClick(el('editor-close'));

  await openFile(pointed);
  await settle();
  check('opening the one that is only pointed at gives something to read, with the reason it is not editable',
    editorText.readOnly === true && editorText.value.includes('pointed at') && /only points at it/.test(el('editor-msg').textContent),
    el('editor-msg').textContent);
  await fireClick(el('editor-close'));

  // back to what the rest of the file expects
  w(path.join(PROJECT, 'CLAUDE.md'), '# project rules\none\ntwo\nthree\n');
  fs.rmSync(path.join(PROJECT, 'shared'), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECT, 'docs'), { recursive: true, force: true });
}

// --- the comparison itself --------------------------------------------
const count = (rows, type) => rows.filter((r) => r.type === type).length;
check('identical text compares as no change',
  !context.diffRows('a\nb\n', 'a\nb\n').some((r) => r.type === 'del' || r.type === 'add'),
  JSON.stringify(context.diffRows('a\nb\n', 'a\nb\n')));
const oneChanged = context.diffRows('a\nb\nc\n', 'a\nB\nc\n');
check('a changed line in the middle shows as one line out and one in',
  count(oneChanged, 'del') === 1 && count(oneChanged, 'add') === 1 &&
  oneChanged.find((r) => r.type === 'del').text === 'b' && oneChanged.find((r) => r.type === 'add').text === 'B',
  JSON.stringify(oneChanged));
const added = context.diffRows('a\nc\n', 'a\nb\nc\n');
check('a line only added shows as added, with nothing removed',
  count(added, 'add') === 1 && count(added, 'del') === 0, JSON.stringify(added));
const longer = context.diffRows(
  ['x', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'y'].join('\n'),
  ['X', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'Y'].join('\n')
);
check('a long identical stretch is summed up rather than printed',
  longer.some((r) => r.type === 'skip' && /identical lines/.test(r.text)) && longer.length < 20,
  JSON.stringify(longer.map((r) => r.type)));

// --- the restart button in the stale-version banner --------------------

// The banner only appears when the files on disk are newer than the running
// server, which is not something to arrange by touching this checkout's own
// files — so the banner built above is put on the page and clicked the way the
// page would click it.
el('content').innerHTML = stale;
const restartsBefore = restartsAsked;
const requestsBefore = requests.length;
// not awaited: after asking, the page waits for the replacement to answer, and
// with the restart stubbed out here nothing ever will
clickRendered(el('content'), (d) => d.action === 'restart', 'a restart button');
await settle();
const restartRequests = requests.slice(requestsBefore).filter((r) => r.url === '/api/restart');
check('clicking it asks the server, as a POST',
  restartRequests.length === 1 && restartRequests[0].method === 'POST',
  JSON.stringify(requests.slice(requestsBefore)));
check('and the server takes that as the restart it is',
  restartsAsked === restartsBefore + 1, `${restartsAsked} vs ${restartsBefore}`);
check('and the page does not reload before the replacement answers', reloads === 0, reloads);

server.close();
if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  console.log('sandbox left in place:', SANDBOX);
} else {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`\nall ${checksRun} checks passed`);
}
process.exit(failures ? 1 : 0);
