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

const { startServer } = await import('../src/server.js');

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
const { server, token: TOKEN } = await startServer({ projectPath: PROJECT, port: PORT, onRestart: () => { restartsAsked++; } });
const BASE = `http://127.0.0.1:${PORT}`;
// for the requests this file makes itself; the page's own carry whatever key
// the page found, which is the point of several checks below
const T = { 'X-Dashboard-Token': TOKEN };

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
// either quote: an id written id='x' is just as real to the browser
const idsIn = (html) => new Set([...html.matchAll(/\sid\s*=\s*(?:"([^"]+)"|'([^']+)')/g)].map((m) => m[1] ?? m[2]));
const knownIds = idsIn(markup);

// which button was last given keyboard focus, as { id of the element it was
// drawn in, its data attributes } — read from what the page drew
let focused = null;

let elements = new Map();
function makeEl(id) {
  const classes = new Set();
  const attributes = {};
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    title: '',
    hidden: false,
    disabled: false,
    readOnly: false,
    inert: false,
    handlers: {},
    attributes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
    appendChild() {},
    focus() { focused = { id, dataset: null }; },
    querySelector: () => null,
    // the buttons this element drew, as the browser would hand them back
    querySelectorAll(selector) {
      if (selector !== 'button[data-action]') return [];
      return buttonsIn(this.innerHTML).map((b) => ({
        dataset: b.dataset,
        classList: { contains: (c) => b.classes.includes(c) },
        focus: () => { focused = { id, dataset: b.dataset }; },
      }));
    },
  };
}
// Asking for an id the page does not have fails a check rather than throwing:
// the page catches errors in most handlers and turns them into a message, so a
// throw here could be swallowed and the run would carry on looking fine.
const el = (id) => {
  if (!knownIds.has(id)) {
    check(`the page only asks for elements index.html has (#${id})`, false, `#${id} is not in index.html`);
    return makeEl(id);
  }
  if (!elements.has(id)) elements.set(id, makeEl(id));
  return elements.get(id);
};

const documentHandlers = {};
const windowHandlers = {};
// the permission-rule boxes are found by selector, not id: one per settings
// file, so a stand-in is kept per data-for value
const ruleBoxes = new Map();
const ruleBox = (kind, file) => {
  const k = `${kind}|${file}`;
  if (!ruleBoxes.has(k)) ruleBoxes.set(k, { value: kind === 'pick' ? 'allow' : '', focus() {} });
  return ruleBoxes.get(k);
};
const document = {
  getElementById: el,
  createElement: () => makeEl('created'),
  querySelector(selector) {
    const m = selector.match(/^\.rule-(input|group-pick)\[data-for="(.*)"\]$/);
    return m ? ruleBox(m[1] === 'input' ? 'input' : 'pick', m[2]) : null;
  },
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

// what the page asked for, so a check can say where a request went. No key is
// added here: a request carries one only if the page put it there.
const requests = [];
const fetchShim = async (url, opts = {}) => {
  const absolute = url.startsWith('http') ? url : BASE + url;
  requests.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: { ...(opts.headers || {}) } });
  return fetch(absolute, { ...opts, headers: { Origin: BASE, ...(opts.headers || {}) } });
};

// sessionStorage, one per page load, as a tab has
const makeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
};
const storage = makeStorage();

let reloads = 0;
const addresses = [];
let confirmAnswer = true;
const asked = [];
const alerted = [];

// Opened the way the terminal's address opens it — the key in the fragment —
// and on a project already in the address, which taking the key out must keep.
const startSearch = `?path=${encodeURIComponent(PROJECT)}`;
let lastLocation = null;
const pageGlobals = ({ hash, search, sessionStorage }) => ({
  document,
  window: windowStub,
  location: (lastLocation = { pathname: '/', search, hash, reload: () => { reloads++; } }),
  history: { replaceState: (state, title, url) => addresses.push(String(url)) },
  sessionStorage,
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
const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const context = vm.createContext(pageGlobals({ hash: `#token=${TOKEN}`, search: startSearch, sessionStorage: storage }));
vm.runInContext(appSource, context, { filename: 'app.js' });

// The page draws its buttons as HTML text, so a click is aimed by reading that
// text back: the same data attributes and classes a real button would carry.
// Making them up here instead would let a renamed action pass unnoticed.
const unescapeHtml = (s2) =>
  s2.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// Attributes one by one, quoted either way: a ">" inside a quoted value (an
// aria-label, a rule like "Bash(x > y)") does not end the tag, and a data-
// name may carry digits.
function attributesOf(text) {
  const attrs = {};
  for (const a of text.matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[a[1].toLowerCase()] = unescapeHtml(a[2] ?? a[3] ?? a[4] ?? '');
  }
  return attrs;
}

function buttonsIn(html) {
  return [...html.matchAll(/<button\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map((m) => {
    const attrs = attributesOf(m[1]);
    const dataset = {};
    for (const [name, value] of Object.entries(attrs)) {
      if (name.startsWith('data-')) dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
    return { dataset, classes, attrs };
  }).filter((b) => b.dataset.action);
}

// a button that is not there fails a check and the run goes on, so one
// renamed action reports itself instead of hiding every check after it
const clickRendered = (target, pick, what = 'a button') => {
  const found = buttonsIn(target.innerHTML).find((b) => pick(b.dataset, b.classes));
  if (!found) {
    check(`${what} is among the buttons #${target.id} drew`, false, target.innerHTML.slice(0, 200));
    return Promise.resolve([]);
  }
  const button = {
    dataset: found.dataset,
    classList: { contains: (c) => found.classes.includes(c) },
    closest: () => button,
  };
  return Promise.all((target.handlers.click || []).map((fn) => fn({ target: button })));
};
const openFile = (p2) => clickRendered(el('content'), (d) => d.action === 'edit' && d.path === p2, `an edit button for ${p2}`);
const fireClick = (target) => Promise.all((target.handlers.click || []).map((fn) => fn({ target })));
// what pressing Enter in the path box, or clicking Load, does: submit the form
let submitsPrevented = 0;
const submitProject = () => Promise.all((el('project-form').handlers.submit || [])
  .map((fn) => fn({ target: el('project-form'), preventDefault: () => { submitsPrevented++; } })));

// --- the stand-in itself ----------------------------------------------
// It reads the page's own markup, so it has to read it the way a browser does.
{
  const parsed = buttonsIn('<button class="btn" aria-label="a > b" data-action="x" data-step2="two" data-for-file=\'q\'>go</button>');
  check('the stand-in reads a button whose attributes hold ">", digits and single quotes',
    parsed.length === 1 && parsed[0].dataset.action === 'x' && parsed[0].dataset.step2 === 'two' && parsed[0].dataset.forFile === 'q',
    JSON.stringify(parsed));
  check('and finds ids written with either quote',
    idsIn(`<div id="a"></div><span id='b'></span><i data-id="c"></i>`).has('b') && !idsIn('<i data-id="c"></i>').has('c'));
}

const settle = () => new Promise((r) => setTimeout(r, 60));
const projectMd = path.join(PROJECT, 'CLAUDE.md');
const otherMd = path.join(OTHER, 'CLAUDE.md');
const editorText = el('editor-text');
const editor = el('editor');

// init() runs when the script is loaded; wait for the first inventory
for (let i = 0; i < 100 && !el('content').innerHTML.includes('block'); i++) await settle();
check('the page loads the project it was started for',
  requests.some((r) => r.url.startsWith(`/api/inventory?path=${encodeURIComponent(PROJECT)}`)), JSON.stringify(requests));

// --- the launch key ------------------------------------------------------
check('the key in the address goes out with every request the page makes',
  requests.length >= 2 && requests.every((r) => r.headers['X-Dashboard-Token'] === TOKEN), JSON.stringify(requests.map((r) => r.headers)));
check('it is taken out of the address at once, keeping the project the address names',
  addresses[0] === `/${startSearch}` && !addresses.some((a) => a.includes('#') || a.includes(TOKEN)), JSON.stringify(addresses));
check('sizes are called bytes, which is what they count, not characters',
  /bytes of text load before you type anything/.test(el('content').innerHTML) && !/\d characters\b/.test(el('content').innerHTML),
  (el('content').innerHTML.match(/.{60}\d characters.{20}/) || [''])[0]);
check('and kept for the tab, so a reload of that address still works',
  [...storage.data.values()].includes(TOKEN), JSON.stringify([...storage.data.keys()]));

// --- what the markup promises -------------------------------------------
{
  const form = (markup.match(/<form\b[^>]*id="project-form"[^>]*>([\s\S]*?)<\/form>/) || [])[1] || '';
  check('the path box and the Load button sit in one form, so Enter in the box loads',
    /id="project-path"/.test(form) && /<button\b[^>]*id="load-btn"[^>]*type="submit"|<button\b[^>]*type="submit"[^>]*id="load-btn"/.test(form), form);
  check('the path box and the recent-projects list each have a name a screen reader can say',
    /<input\b[^>]*id="project-path"[^>]*aria-label="[^"]+"/.test(markup) && /<select\b[^>]*id="known-projects"[^>]*aria-label="[^"]+"/.test(markup));
  check('the editor says it is a modal dialog',
    /role="dialog"[^>]*aria-modal="true"|aria-modal="true"[^>]*role="dialog"/.test(markup));
  check('and there is a status line that is read out when it changes',
    /<[^>]*id="status-line"[^>]*aria-live="polite"/.test(markup) && /id="status-line"[^>]*class="status-line"|class="status-line"[^>]*id="status-line"/.test(markup));
  // the drawn page, not the markup: every switch says it is one, and whether it is on
  const switches = buttonsIn(el('content').innerHTML).filter((b) => b.classes.includes('switch'));
  check('every switch on the page is announced as a switch, on or off',
    switches.length > 0 && switches.every((b) => b.attrs.role === 'switch' && (b.attrs['aria-checked'] === 'true' || b.attrs['aria-checked'] === 'false')),
    JSON.stringify(switches.map((b) => b.attrs).slice(0, 3)));
  check('loading puts the project in the address, so a reload comes back to it',
    addresses.at(-1) === `?path=${encodeURIComponent(PROJECT)}`, JSON.stringify(addresses));
}

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
check('without spelling out the copy\'s whole path in the footer',
  /Earlier versions/.test(el('editor-msg').textContent) && !el('editor-msg').textContent.includes('.claude-context-dashboard'),
  el('editor-msg').textContent);
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
await submitProject();
await settle();
check('switching project with unsaved typing asks first', asked.length === 1, JSON.stringify(asked));
check('and saying no stays where you were, with the editor still open',
  editor.hidden === false && !requests.some((r) => r.url.includes(encodeURIComponent(OTHER))),
  JSON.stringify(requests.map((r) => r.url)));

confirmAnswer = true;
asked.length = 0;
await submitProject();
await settle();
check('saying yes closes the editor and loads the other project',
  editor.hidden === true && requests.some((r) => r.url.startsWith(`/api/inventory?path=${encodeURIComponent(OTHER)}`)),
  JSON.stringify(requests.map((r) => r.url)));
check('and the unsaved typing was not written anywhere',
  fs.readFileSync(projectMd, 'utf8') === '# saved twice at once\n' && fs.readFileSync(otherMd, 'utf8') === '# the other project\n');

// a save already on its way keeps the file and project it started with, even
// if the project is switched underneath it
el('project-path').value = PROJECT;
await submitProject();
await settle();
await openFile(projectMd);
await settle();
editorText.value = '# written while switching\n';
requests.length = 0;
const saving = context.saveEditor();
el('project-path').value = OTHER;
await submitProject();
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
await submitProject();
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
check('it says how many are kept, from the limits the server sent',
  /at most \d+ of any one file, and \d+ MB of them in all/.test(el('editor-history').innerHTML),
  el('editor-history').innerHTML.slice(0, 400));
check('and a version\'s size is given in bytes, which is what is measured',
  /· [\d,.\s]+ bytes/.test(el('editor-history').innerHTML) && !/· \d+ characters/.test(el('editor-history').innerHTML),
  (el('editor-history').innerHTML.match(/version-when">[^<]*/) || [''])[0]);

const list = await (await fetch(`${BASE}/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`, { headers: { Origin: BASE, ...T } })).json();
const newest = list.versions[0];
check('the row for a version carries the id the page will send back',
  buttonsIn(el('editor-history').innerHTML).some((b) => b.dataset.action === 'version-diff' && b.dataset.id === newest.id),
  JSON.stringify(buttonsIn(el('editor-history').innerHTML).map((b) => b.dataset)).slice(0, 200));
await clickRendered(el('editor-history'), (d) => d.action === 'version-diff' && d.id === newest.id, 'the compare button');
await settle();
const shown = el('editor-history').innerHTML;
check('comparing a version marks what went and what came',
  shown.includes('− line two') && shown.includes('+ line two changed'), shown.slice(shown.indexOf('diff'), 400));
check('and says which side is the earlier version',
  /class="diff-legend"/.test(shown) && /− only in the version from/.test(shown) && /\+ only in the editor now/.test(shown),
  shown.slice(0, 300));

asked.length = 0;
await clickRendered(el('editor-history'), (d) => d.action === 'version-restore' && d.id === newest.id, 'the restore button');
await settle();
check('putting a version back asks first, then writes it',
  asked.length === 1 && fs.readFileSync(projectMd, 'utf8') === '# version A\nline one\nline two\n', JSON.stringify(asked));
check('and the editor shows what is now in the file',
  editorText.value === '# version A\nline one\nline two\n', JSON.stringify(editorText.value));
check('what it replaced was kept as a version too',
  (await (await fetch(`${BASE}/api/file/backups?path=${encodeURIComponent(projectMd)}&project=${encodeURIComponent(PROJECT)}`, { headers: { Origin: BASE, ...T } })).json()).versions.length > list.versions.length);

// A copy taken under the old naming (/ written as __) may be another file's,
// so it is listed to compare but offers no way to put it back.
{
  const legacyName = projectMd.replace(/[\\/]/g, '__') + '.2020-01-01T00-00-00-000Z.bak';
  w(path.join(HOME, '.claude-context-dashboard', 'backups', legacyName), '# from the old naming\n');
  await context.refreshVersions();
  if (el('editor-history').hidden) await fireClick(el('editor-versions'));
  const rows = el('editor-history').innerHTML;
  const legacyButtons = buttonsIn(rows).filter((b) => b.dataset.id === legacyName);
  check('an old-style copy is listed, marked as possibly another file\'s',
    legacyButtons.some((b) => b.dataset.action === 'version-diff') && /may belong to another file/.test(rows), rows.slice(-600));
  check('and it has no button to put it back',
    !legacyButtons.some((b) => b.dataset.action === 'version-restore'), JSON.stringify(legacyButtons.map((b) => b.dataset)));
}

// --- a file that can be read but not written --------------------------
const pluginSkill = path.join(HOME, '.claude', 'plugins', 'cache', 'demo', 'skills', 'thing', 'SKILL.md');
w(pluginSkill, '---\nname: thing\ndescription: from a plugin\n---\nplugin body\n');
w(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: { 'demo@market': [{ scope: 'user', version: '1.0.0', installPath: path.join(HOME, '.claude', 'plugins', 'cache', 'demo') }] },
}, null, 2));
w(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': true } }, null, 2));
await submitProject();
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
w(path.join(PROJECT, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs' }, fresh: { command: 'fresh' } } }, null, 2));
w(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({
  enabledPlugins: { 'demo@market': true },
  disabledMcpjsonServers: ['docs'],
}, null, 2));
el('project-path').value = PROJECT;
await submitProject();
await settle();
{
  // nothing decides "fresh": it does not load until Claude Code has asked, so
  // it is off in effect and says why in plain words
  const html = el('content').innerHTML;
  const fresh = buttonsIn(html).find((b) => b.dataset.action === 'toggle-mcp-shared' && b.dataset.name === 'fresh');
  check('a shared server nobody has decided on reads as off, in words rather than "unset"',
    fresh?.attrs['aria-checked'] === 'false' && fresh.dataset.next === 'true' && /not decided yet/.test(fresh.attrs['aria-label']) &&
    !/switch-label">[^<]*\bunset\b/i.test(html), JSON.stringify(fresh));
}
alerted.length = 0;
await clickRendered(el('content'), (d) => d.action === 'toggle-mcp-shared' && d.name === 'docs', 'the shared-server switch');
await settle();
check('the page shows what the switch had to say, in the status line rather than a pop-up',
  alerted.length === 0 && /every project/.test(el('status-line').textContent) && !el('status-line').classList.contains('error'),
  JSON.stringify({ alerted, status: el('status-line').textContent }));
check('and the status line names the file it wrote',
  el('status-line').textContent.startsWith(`Written to ${path.join(PROJECT, '.claude', 'settings.json')}.`),
  el('status-line').textContent);
check('and the switch changed this project without touching the file that applies to all of them',
  JSON.parse(fs.readFileSync(path.join(PROJECT, '.claude', 'settings.json'), 'utf8')).enabledMcpjsonServers?.includes('docs') &&
  JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')).disabledMcpjsonServers.includes('docs'),
  fs.readFileSync(path.join(PROJECT, '.claude', 'settings.json'), 'utf8'));

// --- a "this project" switch that is following the global one -----------
// demo@market is on in the global settings and this project says nothing, so
// in effect it is on here: the first click has to turn it off, not "on" again.
{
  const drawn = buttonsIn(el('content').innerHTML)
    .find((b) => b.dataset.action === 'toggle-plugin' && b.dataset.key === 'demo@market' && b.dataset.scope === 'project');
  check('an undecided "this project" switch that follows a global on reads as on',
    drawn?.attrs['aria-checked'] === 'true' && drawn.classes.includes('unset'), JSON.stringify(drawn));
  requests.length = 0;
  focused = null;
  await clickRendered(el('content'), (d) => d.action === 'toggle-plugin' && d.key === 'demo@market' && d.scope === 'project', 'the plugin\'s project switch');
  await settle();
  const sent = requests.find((r) => r.url === '/api/toggle/plugin');
  check('and its first click switches it off', sent?.body.enabled === false, JSON.stringify(sent));
  check('which is what lands in the project\'s settings',
    JSON.parse(fs.readFileSync(path.join(PROJECT, '.claude', 'settings.json'), 'utf8')).enabledPlugins?.['demo@market'] === false);
  check('after the redraw, focus is back on the same switch',
    focused?.id === 'content' && focused.dataset?.action === 'toggle-plugin' && focused.dataset.key === 'demo@market' && focused.dataset.scope === 'project',
    JSON.stringify(focused));

  // the global switch: asks, and the question names the plugin
  asked.length = 0;
  confirmAnswer = false;
  requests.length = 0;
  await clickRendered(el('content'), (d) => d.action === 'toggle-plugin' && d.key === 'demo@market' && d.scope === 'global', 'the plugin\'s global switch');
  await settle();
  check('a switch for every project asks first, naming what it is about',
    asked.length === 1 && asked[0].includes('demo@market') && !requests.some((r) => r.url === '/api/toggle/plugin'),
    JSON.stringify(asked));
  confirmAnswer = true;
  await clickRendered(el('content'), (d) => d.action === 'toggle-plugin' && d.key === 'demo@market' && d.scope === 'global', 'the plugin\'s global switch');
  await settle();
  check('a write to a file under home is reported with ~ in the status line, and that a copy was kept',
    el('status-line').textContent.startsWith('Written to ~/.claude/settings.json.') && !el('status-line').textContent.includes(HOME) &&
    /copy of what it held before was kept/.test(el('status-line').textContent),
    el('status-line').textContent);
}

// --- ~ is for showing, never for sending ---------------------------------
{
  const globalMd = path.join(HOME, '.claude', 'CLAUDE.md');
  const drawn = el('content').innerHTML;
  check('paths under home are shown with ~',
    drawn.includes('~/.claude/CLAUDE.md') && !drawn.includes(`>${globalMd}<`), drawn.slice(drawn.indexOf('claude-md'), drawn.indexOf('claude-md') + 300));
  check('while the buttons still carry the full path',
    buttonsIn(drawn).some((b) => b.dataset.action === 'edit' && b.dataset.path === globalMd));
  requests.length = 0;
  focused = null;
  await openFile(globalMd);
  await settle();
  check('opening one asks for it by its full path, and the editor shows it with ~',
    requests.some((r) => r.url === `/api/file?path=${encodeURIComponent(globalMd)}&project=${encodeURIComponent(PROJECT)}`) &&
    el('editor-path').textContent === '~/.claude/CLAUDE.md', JSON.stringify({ urls: requests.map((r) => r.url), shown: el('editor-path').textContent }));
  check('while the editor is open, the page behind it cannot be reached',
    el('layout').inert === true && el('top-bar').inert === true);
  await fireClick(el('editor-close'));
  check('and closing it gives the page back, with focus on the button that opened it',
    el('layout').inert === false && el('top-bar').inert === false &&
    focused?.dataset?.action === 'edit' && focused.dataset.path === globalMd, JSON.stringify(focused));
}

// --- permission rules ---------------------------------------------------
{
  check('rules in the shapes the page can describe are taken as rules',
    ['Bash', 'Bash(git push:*)', 'Read(./src/**)', 'mcp__github__search_issues', 'mcp__github', 'WebFetch(domain:example.com)']
      .every((r) => context.ruleLooksValid(r)));
  check('and a typo is not', ['nonsense rule (((', 'Bash(git push', 'bash git push', ''].every((r) => !context.ruleLooksValid(r)));

  const globalSettings = path.join(HOME, '.claude', 'settings.json');
  const before = JSON.parse(fs.readFileSync(globalSettings, 'utf8'));
  w(globalSettings, JSON.stringify({ ...before, permissions: { allow: [] } }, null, 2));
  el('project-path').value = PROJECT;
  await submitProject();
  await settle();
  const original = fs.readFileSync(globalSettings, 'utf8');

  ruleBox('input', globalSettings).value = 'nonsense rule (((';
  asked.length = 0;
  confirmAnswer = false;
  await clickRendered(el('content'), (d) => d.action === 'permission-add' && d.file === globalSettings, 'the global file\'s Add rule button');
  await settle();
  check('a rule that does not look like one asks before it is written',
    asked.length === 1 && /does not look like a rule/.test(asked[0]) && asked[0].includes('nonsense rule (((') && fs.readFileSync(globalSettings, 'utf8') === original, JSON.stringify(asked));

  ruleBox('input', globalSettings).value = 'Bash(git status)';
  asked.length = 0;
  await clickRendered(el('content'), (d) => d.action === 'permission-add' && d.file === globalSettings, 'the global file\'s Add rule button');
  await settle();
  check('a rule for the global file asks too, since it applies everywhere, and saying no writes nothing',
    asked.length === 1 && /every project/.test(asked[0]) && asked[0].includes('Bash(git status)') && fs.readFileSync(globalSettings, 'utf8') === original,
    JSON.stringify(asked));
  confirmAnswer = true;
  asked.length = 0;
  await clickRendered(el('content'), (d) => d.action === 'permission-add' && d.file === globalSettings, 'the global file\'s Add rule button');
  await settle();
  check('and saying yes writes it, and says so',
    JSON.parse(fs.readFileSync(globalSettings, 'utf8')).permissions.allow.includes('Bash(git status)') && /Written to/.test(el('status-line').textContent),
    el('status-line').textContent);
  asked.length = 0;
  confirmAnswer = false;
  await clickRendered(el('content'), (d) => d.action === 'permission-remove' && d.file === globalSettings && d.rule === 'Bash(git status)', 'the rule\'s Remove button');
  await settle();
  check('removing one from the global file asks first as well',
    asked.length === 1 && JSON.parse(fs.readFileSync(globalSettings, 'utf8')).permissions.allow.includes('Bash(git status)'), JSON.stringify(asked));
  confirmAnswer = true;
}

// --- a path that is not a project ---------------------------------------
{
  const shownBefore = el('content').innerHTML;
  const addressesBefore = addresses.length;
  el('project-path').value = path.join(SANDBOX, 'no-such-folder');
  submitsPrevented = 0;
  await submitProject();
  await settle();
  check('submitting the path form does not send the browser anywhere', submitsPrevented === 1, submitsPrevented);
  check('a path that cannot be loaded says so in the status line',
    el('status-line').classList.contains('error') && el('status-line').textContent.includes('no-such-folder'),
    el('status-line').textContent);
  check('and leaves the page you were on in place, address included',
    el('content').innerHTML === shownBefore && addresses.length === addressesBefore, el('content').innerHTML.slice(0, 160));
  requests.length = 0;
  await clickRendered(el('content'), (d) => d.action === 'toggle-plugin' && d.key === 'demo@market' && d.scope === 'project', 'the plugin\'s project switch');
  await settle();
  check('and a switch on that page still acts on, and reloads, the project it belongs to',
    requests.some((r) => r.url === `/api/inventory?path=${encodeURIComponent(PROJECT)}`) &&
    !requests.some((r) => r.url.includes('no-such-folder')), JSON.stringify(requests.map((r) => r.url)));
  el('project-path').value = OTHER;
  await submitProject();
  await settle();
  check('a project that does load clears the old error and moves the address',
    el('status-line').textContent === '' && addresses.at(-1) === `?path=${encodeURIComponent(OTHER)}`,
    JSON.stringify({ status: el('status-line').textContent, address: addresses.at(-1) }));
  el('project-path').value = PROJECT;
  await submitProject();
  await settle();
}

// --- an old server behind a new page -----------------------------------
check('nothing is said when the server is at least as new as its files',
  context.staleWarning({ startedAt: 2000, sourceChangedAt: 1000 }) === '' &&
  context.staleWarning(null) === '' && context.staleWarning({ startedAt: 2000 }) === '',
  JSON.stringify(context.staleWarning({ startedAt: 2000, sourceChangedAt: 1000 })));
const stale = context.staleWarning({ startedAt: 1000, sourceChangedAt: 2000 });
check('and when it is older, the page says so and offers to start it again',
  /running since/.test(stale) && buttonsIn(stale).some((b) => b.dataset.action === 'restart'), stale);

// the page must not die on an answer that is missing something it now asks for
const full = await (await fetch(`${BASE}/api/inventory?path=${encodeURIComponent(PROJECT)}`, { headers: { Origin: BASE, ...T } })).json();
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
  await submitProject();
  await settle();

  const drawn = el('content').innerHTML;
  check('a file an @ line pulls in gets its own row on the page, not just a number',
    drawn.includes('shared/rules.md') && buttonsIn(drawn).some((b) => b.dataset.action === 'edit' && b.dataset.path === pulled),
    drawn.slice(drawn.indexOf('claude-md'), drawn.indexOf('claude-md') + 400));
  check('a file the text only names gets a section of its own, and a button',
    drawn.includes('id="references"') && buttonsIn(drawn).some((b) => b.dataset.action === 'edit' && b.dataset.path === pointed),
    drawn.includes('id="references"'));
  check('the section says how much text is behind the pointers, since that is the point of it',
    el('content').innerHTML.includes(`<strong>${fs.statSync(pointed).size} bytes</strong> of text sit behind`),
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
check('the restart carries the key too, so the replacement knows the page',
  restartRequests.length === 1 && restartRequests[0].headers['X-Dashboard-Token'] === TOKEN, JSON.stringify(restartRequests[0]?.headers));

// --- loading the page again -----------------------------------------------
// A fresh page each time: its own elements and its own requests. The first
// page is done with — nothing below clicks it.
const bootAgain = async ({ hash, search, sessionStorage }) => {
  elements = new Map();
  requests.length = 0;
  addresses.length = 0;
  const page = vm.createContext(pageGlobals({ hash, search, sessionStorage }));
  vm.runInContext(appSource, page, { filename: 'app.js' });
  for (let i = 0; i < 100 && !el('content').innerHTML && !el('status-line').textContent; i++) await settle();
  await settle();
};
// a reload: the address no longer has the key, the tab's storage does
await bootAgain({ hash: '', search: startSearch, sessionStorage: storage });
check('a reload of the address without the key still loads, from the key kept for the tab',
  el('content').innerHTML.includes('block') && requests.length >= 2 && requests.every((r) => r.headers['X-Dashboard-Token'] === TOKEN),
  JSON.stringify({ status: el('status-line').textContent, headers: requests.map((r) => r.headers) }));
// a tab with no key at all, and one whose storage cannot be used
await bootAgain({ hash: '', search: '', sessionStorage: makeStorage() });
check('a page without the key says, in its status line, to open the address the terminal printed',
  /terminal printed/.test(el('status-line').textContent) && el('status-line').classList.contains('error') &&
  !requests.some((r) => r.url.startsWith('/api/inventory')),
  JSON.stringify({ status: el('status-line').textContent, urls: requests.map((r) => r.url) }));
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
await bootAgain({ hash: `#token=${TOKEN}`, search: '', sessionStorage: broken });
check('storage that refuses does not stop the key in the address from working',
  el('content').innerHTML.includes('block') && requests.every((r) => r.headers['X-Dashboard-Token'] === TOKEN) && addresses[0] === '/',
  JSON.stringify({ status: el('status-line').textContent, addresses }));
// a different key in the address beats a stale one kept for the tab
await bootAgain({ hash: `#token=${TOKEN}`, search: '', sessionStorage: makeStorage({ 'claude-context-dashboard.token': 'stale-key-from-an-earlier-launch' }) });
check('a key in the address wins over an older one kept for the tab',
  requests.length >= 1 && requests.every((r) => r.headers['X-Dashboard-Token'] === TOKEN), JSON.stringify(requests.map((r) => r.headers)));

// a new key arrives in the address while storage refuses it: no reload (the
// reloaded tab would have no key at all), the page carries on with the key it holds
{
  await bootAgain({ hash: `#token=${TOKEN}`, search: '', sessionStorage: broken });
  const fresh = 'second-launch-key';
  const reloadsBefore = reloads;
  const handler = windowHandlers.hashchange[windowHandlers.hashchange.length - 1];
  lastLocation.hash = `#token=${fresh}`;
  requests.length = 0;
  handler();
  for (let i = 0; i < 50 && !requests.length; i++) await settle();
  await settle();
  check('a new key with storage refusing does not reload the tab', reloads === reloadsBefore, `${reloads} vs ${reloadsBefore}`);
  check('and the next request carries the new key',
    requests.length >= 1 && requests.every((r) => r.headers['X-Dashboard-Token'] === fresh), JSON.stringify(requests.map((r) => r.headers)));
}

server.close();
if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  console.log('sandbox left in place:', SANDBOX);
} else {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`\nall ${checksRun} checks passed`);
}
process.exit(failures ? 1 : 0);
