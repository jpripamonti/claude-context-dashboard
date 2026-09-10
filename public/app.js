let currentProjectPath = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `request to ${url} failed`);
  return data;
}

// --- icons (hand-drawn, monoline, no external assets) -----------------

const ICONS = {
  file: '<svg viewBox="0 0 20 20" fill="none"><path d="M6 2h6l3 3v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 2v3h3" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.5 10h5M7.5 13h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  sliders: '<svg viewBox="0 0 20 20" fill="none"><path d="M4 5h12M4 10h12M4 15h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="5" r="2" fill="var(--panel)" stroke="currentColor" stroke-width="1.4"/><circle cx="13" cy="10" r="2" fill="var(--panel)" stroke="currentColor" stroke-width="1.4"/><circle cx="9" cy="15" r="2" fill="var(--panel)" stroke="currentColor" stroke-width="1.4"/></svg>',
  box: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 2 17 6v8l-7 4-7-4V6l7-4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 10v8M10 10 3 6m7 4 7-4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  link: '<svg viewBox="0 0 20 20" fill="none"><rect x="2" y="7" width="9" height="6" rx="3" stroke="currentColor" stroke-width="1.6"/><rect x="9" y="7" width="9" height="6" rx="3" stroke="currentColor" stroke-width="1.6"/></svg>',
  bulb: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 2a5.5 5.5 0 0 0-3 10.1c.5.35.8.9.8 1.5V15h4.4v-1.4c0-.6.3-1.15.8-1.5A5.5 5.5 0 0 0 10 2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.3 17.5h3.4M8.7 19h2.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  bot: '<svg viewBox="0 0 20 20" fill="none"><rect x="4" y="7" width="12" height="9" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M10 4v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="2.6" r="1" fill="currentColor"/><circle cx="7.5" cy="11.5" r="1.1" fill="currentColor"/><circle cx="12.5" cy="11.5" r="1.1" fill="currentColor"/><path d="M7.5 14.2h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  bolt: '<svg viewBox="0 0 20 20" fill="none"><path d="M11 2 4.5 11.5H9L8 18l7.5-9.8H11l1-6.2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  db: '<svg viewBox="0 0 20 20" fill="none"><ellipse cx="10" cy="4.5" rx="6" ry="2.2" stroke="currentColor" stroke-width="1.6"/><path d="M4 4.5v5c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2v-5" stroke="currentColor" stroke-width="1.6"/><path d="M4 9.5v5c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2v-5" stroke="currentColor" stroke-width="1.6"/></svg>',
  search: '<svg viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.6"/><path d="m13.5 13.5 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  alert: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 2.5 18.5 17h-17L10 2.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14.5" r="1" fill="currentColor"/></svg>',
};

function section(id, icon, title, count, bodyHtml) {
  return `<section class="block" id="${id}">
    <h2>${ICONS[icon] || ''}<span class="section-title">${escapeHtml(title)}</span><span class="count">${count}</span></h2>
    ${bodyHtml || '<div class="empty">Nothing found here.</div>'}
  </section>`;
}

function item({ title, badges = [], path: p, desc, extra = '' }) {
  return `<div class="item">
    <div class="item-main">
      <div class="item-title">${escapeHtml(title)} ${badges.join(' ')}</div>
      ${p ? `<div class="item-path">${escapeHtml(p)}</div>` : ''}
      ${desc ? `<div class="item-desc">${escapeHtml(desc)}</div>` : ''}
      ${extra}
    </div>
  </div>`;
}

function badge(text, cls = '') {
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

function dataAttrString(dataAttrs) {
  return Object.entries(dataAttrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `data-${k}="${escapeHtml(v)}"`)
    .join(' ');
}

// state: true (on) | false (off) | null (undecided — Claude Code hasn't been asked yet)
function switchRow(action, dataAttrs, state, prefix = '', unsetLabel = 'unset') {
  const label = state === null ? unsetLabel : state ? 'on' : 'off';
  const cls = state === null ? 'unset' : state ? 'on' : '';
  return `<div class="switch-row">
    <button class="switch ${cls}" data-action="${action}" ${dataAttrString(dataAttrs)} aria-label="${escapeHtml(prefix || action)}: ${label}"></button>
    <span class="switch-label">${prefix ? `${escapeHtml(prefix)} — ` : ''}${label}</span>
  </div>`;
}

function actionButton(text, action, dataAttrs) {
  return `<button class="btn" data-action="${action}" ${dataAttrString(dataAttrs)}>${escapeHtml(text)}</button>`;
}

function editButton(filePath, text = 'Open the whole file') {
  return actionButton(text, 'edit', { path: filePath });
}

// --- settings, in words rather than JSON ------------------------------

const SETTING_LABELS = {
  permissions: 'What Claude is allowed to do',
  enabledPlugins: 'Plugins switched on or off here',
  enabledMcpjsonServers: 'Tool connections this file approves',
  disabledMcpjsonServers: 'Tool connections this file refuses',
  enableAllProjectMcpServers: 'Approve every tool connection a project offers, without asking',
  extraKnownMarketplaces: 'Extra places plugins can be installed from',
  hooks: 'Commands that run automatically',
  env: 'Environment variables handed to Claude',
  model: 'Model to use',
  effortLevel: 'How much thinking effort Claude puts in',
  tui: 'How the terminal interface is drawn',
  statusLine: 'The status line at the bottom of the terminal',
  outputStyle: 'Writing style Claude answers in',
  includeCoAuthoredBy: 'Add a co-author line to commits it makes',
  cleanupPeriodDays: 'Days of conversation history kept',
  skipWorkflowUsageWarning: 'Skip the warning about how much a workflow will cost',
  agentPushNotifEnabled: 'Notify when a background agent finishes',
  apiKeyHelper: 'Command that supplies the API key',
  forceLoginMethod: 'Force one particular way of signing in',
  disableAllHooks: 'Turn off every automatic command at once',
};

const PERMISSION_GROUPS = [
  { key: 'allow', title: 'Allowed without asking' },
  { key: 'ask', title: 'Always asks first' },
  { key: 'deny', title: 'Always refused' },
];

const TOOL_PHRASES = {
  Bash: (arg) => `Run the shell command ${arg}`,
  Read: (arg) => `Read ${arg}`,
  Edit: (arg) => `Change files at ${arg}`,
  Write: (arg) => `Write files at ${arg}`,
  WebFetch: (arg) => `Fetch web pages: ${arg}`,
  WebSearch: (arg) => `Search the web: ${arg}`,
  Glob: (arg) => `List files matching ${arg}`,
  Grep: (arg) => `Search inside files at ${arg}`,
};

// A rule is a short code like "Bash(git push:*)" or
// "mcp__github__search_issues". Say what it means in words; the exact
// code is still shown underneath, since that is what has to be typed to add one.
function describeRule(rule) {
  const mcp = rule.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Use the "${mcp[2]}" tool from the ${mcp[1]} connection`;
  const wholeServer = rule.match(/^mcp__(.+)$/);
  if (wholeServer) return `Use any tool from the ${wholeServer[1]} connection`;
  const call = rule.match(/^([A-Za-z]+)\((.*)\)$/);
  if (call) {
    const [, tool, arg] = call;
    return TOOL_PHRASES[tool] ? TOOL_PHRASES[tool](arg) : `Use ${tool} with ${arg}`;
  }
  return TOOL_PHRASES[rule] ? TOOL_PHRASES[rule]('anything') : `Use ${rule}`;
}

function renderPermissions(permissions, layerPath) {
  const groups = PERMISSION_GROUPS.map(({ key, title }) => {
    const rules = Array.isArray(permissions?.[key]) ? permissions[key] : [];
    if (!rules.length) return '';
    const rows = rules.map((rule) => `<div class="rule">
      <div class="rule-text">${escapeHtml(describeRule(rule))}<div class="rule-code">${escapeHtml(rule)}</div></div>
      ${actionButton('Remove', 'permission-remove', { file: layerPath, group: key, rule })}
    </div>`).join('');
    return `<div class="rule-group"><div class="rule-group-title">${title} <span class="count">${rules.length}</span></div>${rows}</div>`;
  }).join('');

  const adder = `<div class="rule-add">
    <input type="text" class="rule-input" data-for="${escapeHtml(layerPath)}" placeholder="Bash(git push:*)" spellcheck="false" />
    <select class="rule-group-pick" data-for="${escapeHtml(layerPath)}">
      ${PERMISSION_GROUPS.map((g) => `<option value="${g.key}">${g.title}</option>`).join('')}
    </select>
    ${actionButton('Add rule', 'permission-add', { file: layerPath })}
  </div>`;

  return (groups || '<div class="empty">No permission rules in this file.</div>') + adder;
}

function renderSettingValue(key, value, layerPath) {
  if (key === 'permissions') return renderPermissions(value, layerPath);
  if (typeof value === 'boolean') return `<div class="setting-value">${value ? 'yes' : 'no'}</div>`;
  if (typeof value === 'string' || typeof value === 'number') {
    return `<div class="setting-value">${escapeHtml(String(value))}</div>`;
  }
  if (Array.isArray(value)) {
    return `<div class="setting-value">${value.map((v) => escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))).join(', ')}</div>`;
  }
  if (value && typeof value === 'object') {
    const simple = Object.entries(value).every(([, v]) => typeof v !== 'object' || v === null);
    if (simple) {
      return `<div class="setting-value">${Object.entries(value)
        .map(([k, v]) => `<div>${escapeHtml(k)} — ${typeof v === 'boolean' ? (v ? 'on' : 'off') : escapeHtml(String(v))}</div>`)
        .join('')}</div>`;
    }
    return `<details><summary>show the details</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
  }
  return `<div class="setting-value">${escapeHtml(JSON.stringify(value))}</div>`;
}

// --- how much lands in the conversation -------------------------------

function num(n) {
  return n.toLocaleString();
}

// Characters are what is actually measured. Tokens are what the context window
// is counted in, so a rough conversion is more useful than none — but it is an
// estimate and is labelled as one.
function roughTokens(bytes) {
  const t = Math.round(bytes / 4);
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
}

const CATEGORY_ICONS = { instructions: 'file', skills: 'bulb', agents: 'bot', memory: 'db' };

function renderWeight(weight) {
  const { measuredBytes, categories, biggest, notMeasured } = weight;
  const widest = Math.max(1, ...categories.map((c) => c.bytes));

  const bars = categories.map((c) => `<div class="weigh-row">
    <div class="weigh-label">${ICONS[CATEGORY_ICONS[c.key]] || ''}<span>${escapeHtml(c.title)}</span><span class="count">${c.count}</span></div>
    <div class="weigh-bar"><div class="weigh-fill" style="width:${Math.round((c.bytes / widest) * 100)}%"></div></div>
    <div class="weigh-num">${num(c.bytes)}</div>
  </div>`).join('');

  const rows = biggest.map((b) => `<div class="weigh-item">
    <div class="weigh-item-name">${escapeHtml(b.name)}<span class="weigh-item-detail">${escapeHtml(b.detail)}</span></div>
    <div class="weigh-num">${num(b.bytes)}${b.importedBytes ? ` <span class="weigh-item-detail">of which ${num(b.importedBytes)} pulled in by "@" lines</span>` : ''}</div>
  </div>`).join('');

  const body = `
    <div class="weigh-total">
      <strong>${num(measuredBytes)}</strong> characters load before you type anything
      <span class="muted">— roughly ${roughTokens(measuredBytes)} tokens, as a rough conversion</span>
    </div>
    ${bars}
    <div class="weigh-sub">Biggest single items</div>
    ${rows || '<div class="empty">Nothing loads for this project.</div>'}
    <div class="muted weigh-note">
      ${notMeasured.toolConnections
        ? `Not counted: ${notMeasured.toolConnections} tool connection${notMeasured.toolConnections === 1 ? '' : 's'}. Each one sends the list of tools it offers, which is often the largest thing of all — measuring it would mean connecting to those servers, which this dashboard never does.`
        : 'No tool connections are switched on here, so nothing is left unmeasured.'}
      Skills and subagents count only their name and description, because that is all that goes in until one is actually used.
    </div>`;

  return section('weight', 'bolt', 'What loads before you type', `${roughTokens(measuredBytes)} tokens`, body);
}

// --- section renderers -----------------------------------------------

function importedBytes(f) {
  return f.importedFiles.reduce((n, i) => n + i.bytes, 0);
}

// One row per "@" line, resolved: what the line says, which file that turned out
// to be, and how much text it brings. A line that brings nothing gets a row too
// — a file that is not there, one that cannot be read, one an earlier line has
// already pulled in — because the whole point of the list is that an "@" line
// is a layer of instructions you cannot see from the file you are reading.
function importRows(f) {
  if (!f.importedFiles.length) return '';
  const rows = f.importedFiles.map((i) => {
    const state = i.missing
      ? '<span class="dead">nothing there — this line brings in no text</span>'
      : i.error
      ? `<span class="dead">could not be read (${escapeHtml(i.error)}) — this line brings in no text</span>`
      : i.alreadyPulledIn
      ? '<span class="muted">already pulled in above — counted once</span>'
      : `${num(i.bytes)} characters${i.level > 1 ? ` — pulled in by ${escapeHtml(i.via.split('/').pop())}, not by this file` : ''}`;
    const open = i.missing || i.error || i.alreadyPulledIn ? '' : ` ${editButton(i.path, 'Open')}`;
    return `<div class="layer" style="--depth:${i.level - 1}">
      <div class="layer-spec">@${escapeHtml(i.spec)}</div>
      <div class="layer-path">${escapeHtml(i.path)}</div>
      <div class="layer-note">${state}${open}</div>
    </div>`;
  }).join('');
  return `<div class="layers"><div class="layers-head">Pulled in by "@" lines — this text loads with the file above:</div>${rows}</div>`;
}

function renderClaudeMd(data) {
  const all = [...data.files, ...data.nested];
  const rows = all.map((f) => item({
    title: f.path.split('/').pop().replace(/\.disabled$/, ''),
    badges: [
      badge(f.label, 'accent'),
      badge(`${num(f.bytes)} characters`),
      importedBytes(f) ? badge(`+ ${num(importedBytes(f))} pulled in by "@" lines`, 'accent') : '',
      f.disabled ? badge('switched off', 'off') : '',
      f.hasTwin ? badge('a switched-off copy also exists', 'off') : '',
    ],
    path: f.realPath ? `${f.path}  →  ${f.realPath}` : f.path,
    extra: `
      ${importRows(f)}
      ${f.alsoReachableAs ? `<div class="muted">The same file also loads as ${escapeHtml(f.alsoReachableAs)} — it is one file, listed once.</div>` : ''}
      ${f.realPath ? '<div class="muted">This is a link to another file. It can be switched off here, but to change its text edit the file it points to.</div>' : ''}
      <div class="controls">
        ${switchRow('toggle-markdown', {
          path: f.path,
          global: f.label === 'global' ? 'every project' : f.label.startsWith('ancestor') ? 'every project inside that folder' : '',
        }, !f.disabled, 'loaded')}
        ${editButton(f.path)}
      </div>
    `,
  })).join('');
  return section('claude-md', 'file', 'Instructions files (CLAUDE.md)', all.length, rows);
}

const LAYER_TITLES = {
  global: 'Your settings, for every project',
  'global-local': 'Your personal settings, for every project',
  project: "This project's settings, shared with anyone who has the repo",
  'project-local': 'Your personal settings for this project',
};

// Instructions that point somewhere instead of pulling the text in. Claude Code
// loads none of this, so it is kept out of the weight and out of the CLAUDE.md
// section — but "see docs/architecture.md before touching the parser" is still
// a layer of instructions, and the point of this page is that you can see it.
function renderReferences(refs) {
  // an older server behind a newer page sends nothing here; draw no section at
  // all rather than an empty one, which would read as "nothing points anywhere"
  if (!refs || !Array.isArray(refs.files)) return '';
  const rows = refs.files.map((r) => item({
    title: r.path.split('/').pop(),
    badges: [
      badge(`${num(r.bytes)} characters`),
      r.level > 1 ? badge(`${r.level} steps from an instructions file`, 'accent') : '',
    ],
    path: r.path,
    extra: `
      <div class="item-desc">Written as "${escapeHtml(r.spec)}" in ${escapeHtml(r.via)}</div>
      <div class="controls">${editButton(r.path, 'Read it')}</div>
    `,
  })).join('');
  // The total is the point of the section on a real project: a CLAUDE.md of a
  // few thousand characters routinely has ten times that sitting a pointer away.
  const total = refs.files.reduce((n, r) => n + r.bytes, 0);
  const note = `<div class="section-note"><strong>${num(total)} characters</strong> of text sit behind these pointers.
    None of it is loaded on its own and none of it counts towards the weight above — it arrives only if Claude follows
    the pointer, which is what the wording around it is usually asking for.${
    refs.truncated ? ` Only the first ${refs.limit} are listed; there are more, so the real figure is higher.` : ''
  }</div>`;
  return section('references', 'file', 'Files the instructions point at', refs.files.length, rows ? note + rows : '');
}

function renderSettings(layers) {
  const rows = layers.map((l) => {
    const keys = Object.keys(l.data);
    const body = keys.length
      ? keys.map((key) => `<div class="setting">
          <div class="setting-name">${escapeHtml(SETTING_LABELS[key] || key)}
            ${SETTING_LABELS[key] ? `<span class="setting-key">${escapeHtml(key)}</span>` : ''}</div>
          ${renderSettingValue(key, l.data[key], l.path)}
        </div>`).join('')
      : `<div class="empty">${l.exists ? 'This file is empty.' : 'This file does not exist yet.'}</div>`;

    return item({
      title: LAYER_TITLES[l.label] || l.label,
      badges: [
        l.exists ? badge('in use', 'on') : badge('not created yet', 'off'),
        l.broken ? badge('unreadable — being ignored', 'off') : '',
      ],
      path: l.path,
      extra: `${body}
        <div class="controls">${editButton(l.path, l.exists ? 'Open the whole file' : 'Create this file')}</div>`,
    });
  }).join('');
  const existing = layers.filter((l) => l.exists).length;
  return section('settings', 'sliders', 'Settings & permissions', existing, rows);
}

const LAYER_ORDER = ['global', 'global-local', 'project', 'project-local'];

// Which settings file actually decides the outcome: the last one in the
// layering order that has an opinion at all.
function decidingLayer(states) {
  let deciding = null;
  for (const layer of LAYER_ORDER) if (states[layer] !== null) deciding = layer;
  return deciding;
}

// Two switches per plugin, because a plugin has two independent decisions:
// the global default for every project, and this project's own override.
function pluginControls(key, states, projectPath, hasOwnSettingsFile) {
  const deciding = decidingLayer(states);
  const localNote = deciding === 'global-local' || deciding === 'project-local'
    ? `<div class="muted">Neither switch decides this one: a personal "local" settings file is what actually settles it, and the dashboard can only change that by editing that file directly.</div>`
    : '';
  // When the folder being viewed has no settings file of its own that is
  // distinct from the global one — you are looking at your home folder, or at a
  // project whose settings folder is a link to the global one — a switch
  // labelled "this project" would quietly rewrite the global file. Don't offer it.
  if (!hasOwnSettingsFile) {
    return `<div class="controls">
      ${switchRow('toggle-plugin', { key, project: projectPath, scope: 'global' }, states.global, 'every project', 'not set')}
    </div>
    <div class="muted">This folder has no settings file of its own that is separate from the global one, so there is nothing to set for it alone.</div>
    ${localNote}`;
  }
  return `<div class="controls">
    ${switchRow('toggle-plugin', { key, project: projectPath, scope: 'global' }, states.global, 'every project', 'not set')}
    ${switchRow('toggle-plugin', { key, project: projectPath, scope: 'project' }, states.project, 'this project', 'follows the global setting')}
    ${states.project !== null
      ? actionButton('Follow the global setting again', 'clear-plugin-override', { key, project: projectPath, scope: 'project' })
      : ''}
  </div>
  <div class="muted">"This project" writes the project's shared settings file, which is normally committed to version control — your collaborators get it too.</div>
  ${localNote}`;
}

// A plugin named in a settings file but not installed has nothing to switch —
// only a leftover entry to delete, from whichever file still names it.
const LAYER_IN_WORDS = {
  global: 'your global settings, so this affects every project',
  'global-local': 'your personal global settings, so this affects every project',
  project: "this project's shared settings",
  'project-local': "your personal settings for this project",
};

function missingPluginControls(key, states, projectPath) {
  const deciding = decidingLayer(states);
  if (deciding === null) {
    return '<div class="muted">The entry is written in a form the dashboard does not recognise — open the settings file above to see it.</div>';
  }
  return `<div class="controls">${actionButton('Remove this leftover entry', 'clear-plugin-override', {
    key,
    project: projectPath,
    scope: deciding,
    global: deciding.startsWith('global') ? '1' : '',
  })}</div>
  <div class="muted">It would be removed from ${escapeHtml(LAYER_IN_WORDS[deciding])}.</div>`;
}

function renderPlugins(plugins, missingPlugins, projectPath, hasOwnSettingsFile) {
  const scopeLabel = { user: 'global', local: 'this project only', both: 'global + also installed here' };
  const rows = plugins.map((p) => {
    const contribCount = p.contributes.commands.length + p.contributes.agents.length + p.contributes.skills.length;
    return item({
      title: p.key,
      badges: [
        badge(`installed: ${scopeLabel[p.scope] || p.scope}`),
        p.enabled ? badge('loads here', 'on') : badge('does not load here', 'off'),
        p.version ? badge(`v${p.version}`) : '',
      ],
      path: p.installPath,
      desc: p.description,
      extra: `
        ${contribCount ? `<div class="muted">contributes: ${[
          p.contributes.commands.length ? `${p.contributes.commands.length} command(s)` : '',
          p.contributes.agents.length ? `${p.contributes.agents.length} subagent(s)` : '',
          p.contributes.skills.length ? `${p.contributes.skills.length} skill(s)` : '',
          p.contributes.hooks ? 'hooks' : '',
        ].filter(Boolean).join(', ')}</div>` : ''}
        ${pluginControls(p.key, p.states, projectPath, hasOwnSettingsFile)}
      `,
    });
  }).join('');

  const missingRows = missingPlugins.map((m) => item({
    title: m.key,
    badges: [badge('named in settings, but not installed', 'off')],
    path: m.setBy,
    desc: 'This setting has no effect — nothing by that name is installed on this machine.',
    extra: missingPluginControls(m.key, m.states, projectPath),
  })).join('');

  return section('plugins', 'box', 'Plugins', plugins.length, rows + missingRows);
}

// Two definitions of one name exist at once: the one in use, and the one this
// dashboard saved when the server was switched off here. A switch would have to
// overwrite one with the other, so the row shows both and asks which to keep.
function mcpDefinition(config) {
  return config.url || config.command || JSON.stringify(config);
}

function duplicateChoice(scope, s, projectPath) {
  return `<div class="item-desc">In use now: ${escapeHtml(mcpDefinition(s.config))}</div>
    <div class="item-desc">Saved when it was switched off here: ${escapeHtml(mcpDefinition(s.parkedDuplicate))}</div>
    <div class="muted">It was set up again after being switched off here, so there are two definitions and switching it is refused until you choose. The one you drop stays in the backup taken before the write.</div>
    <div class="controls">
      ${actionButton('Keep the one in use', 'resolve-mcp-duplicate', { name: s.name, scope, project: projectPath, keep: 'current', global: scope === 'user' ? '1' : null })}
      ${actionButton('Go back to the saved one', 'resolve-mcp-duplicate', { name: s.name, scope, project: projectPath, keep: 'saved', global: scope === 'user' ? '1' : null })}
    </div>`;
}

function renderMcp(mcp, projectPath) {
  const userRows = mcp.user.map((s) => item({
    title: s.name,
    badges: [
      badge('global — affects every project', 'accent'),
      s.parkedDuplicate ? badge('two definitions', 'off') : '',
      s.enabled ? '' : badge('switched off here', 'off'),
    ],
    desc: s.parkedDuplicate ? '' : s.config.url || s.config.command || '',
    extra: s.parkedDuplicate ? duplicateChoice('user', s, projectPath) : `<div class="controls">
      ${switchRow('toggle-mcp-user', { name: s.name, project: projectPath }, s.enabled)}
      ${actionButton('Use it only in this project', 'move-mcp', { name: s.name, project: projectPath, to: 'project' })}
    </div>
    <div class="muted">Right now it loads into every conversation you start, anywhere. Moving it here means it only loads in this project — and the list of tools it sends is usually the single biggest thing that goes in.</div>`,
  })).join('') || '<div class="empty">None.</div>';

  const sharedRows = (mcp.shared.map((s) => item({
    title: s.name,
    badges: [badge('shared via .mcp.json')],
    desc: `${s.config.url || s.config.command || ''} — ${s.reason}`,
    extra: switchRow('toggle-mcp-shared', { name: s.name, project: projectPath }, s.enabled),
  })).join('') || '<div class="empty">No .mcp.json in this project.</div>')
    + `<div class="controls">${editButton(
      mcp.mcpJsonPath || `${projectPath}/.mcp.json`,
      mcp.mcpJsonPath ? 'Edit the shared server list' : 'Create a shared server list'
    )}</div>`;

  const localRows = mcp.local.map((s) => item({
    title: s.name,
    badges: [
      badge('private to you, this project only'),
      s.parkedDuplicate ? badge('two definitions', 'off') : '',
      s.enabled ? '' : badge('switched off here', 'off'),
    ],
    desc: s.parkedDuplicate ? '' : s.config.url || s.config.command || '',
    extra: s.parkedDuplicate ? duplicateChoice('local', s, projectPath) : `<div class="controls">
      ${switchRow('toggle-mcp-local', { name: s.name, project: projectPath }, s.enabled)}
      ${actionButton('Make it available in every project', 'move-mcp', { name: s.name, project: projectPath, to: 'global', global: '1' })}
    </div>`,
  })).join('') || '<div class="empty">None.</div>';

  return `
    ${section('mcp-user', 'link', 'MCP servers — global (all projects)', mcp.user.length, userRows)}
    ${section('mcp-shared', 'link', 'MCP servers — shared with this project (.mcp.json)', mcp.shared.length, sharedRows)}
    ${section('mcp-local', 'link', 'MCP servers — private, this project only', mcp.local.length, localRows)}
  `;
}

function renderFileList(id, icon, title, list) {
  const rows = list.map((s) => {
    const isPlugin = s.scope.startsWith('plugin:');
    return item({
      title: s.name,
      badges: [
        badge(s.scope, s.scope === 'global' ? 'accent' : ''),
        s.disabled ? badge('disabled', 'off') : badge('enabled', 'on'),
        s.disabled ? '' : badge(`${num(s.startupBytes || 0)} characters loaded up front`),
      ],
      path: s.symlink ? `${s.path}  →  ${s.symlink}` : s.path,
      desc: s.description,
      extra: isPlugin
        ? `<div class="muted">Comes from a plugin, so it can be read here but not changed — switch the plugin off instead.</div>
           <div class="controls">${editButton(s.path, 'Open the whole file')}</div>`
        : `${s.symlink ? `<div class="muted">This folder is a link to somewhere else, so switching it off or editing it changes the file where it really lives.</div>` : ''}
          <div class="controls">
            ${switchRow('toggle-file', { path: s.path, scope: s.scope }, !s.disabled)}
            ${editButton(s.path)}
          </div>`,
    });
  }).join('');
  return section(id, icon, title, list.length, rows);
}

function renderHooks(hooks) {
  const rows = hooks.map((h) => {
    // id is "active:3" or "parked:0" — the position in whichever list it is in
    const index = h.id.split(':')[1];
    return item({
      title: `${h.event} — ${h.matcher}`,
      badges: [
        badge(h.sourceLabel, h.sourceLabel.startsWith('plugin:') ? '' : 'accent'),
        h.enabled ? badge('runs', 'on') : badge('switched off', 'off'),
      ],
      path: h.source,
      extra: `
        <pre>${escapeHtml(h.commands.join('\n') || '(nothing to run)')}</pre>
        ${h.editable
          ? `<div class="controls">${switchRow('toggle-hook', {
              settings: h.source, event: h.event, index, signature: h.signature, global: h.global ? '1' : '',
            }, h.enabled)}</div>`
          : '<div class="muted">Comes from a plugin — switch the plugin off to stop it.</div>'}
      `,
    });
  }).join('');
  return section('hooks', 'bolt', 'Hooks (commands that run automatically)', hooks.length, rows);
}

function renderMemory(memory) {
  if (!memory.exists) {
    return section('memory', 'db', 'Auto-loaded memory', 0, '<div class="empty">No memory directory for this project.</div>');
  }
  const rows = memory.files.map((f) => item({
    title: f.name.replace(/\.disabled$/, ''),
    badges: [f.isIndex ? badge('index', 'accent') : '', f.disabled ? badge('switched off', 'off') : ''],
    path: f.path,
    extra: `<div class="controls">
      ${switchRow('toggle-markdown', { path: f.path }, !f.disabled, 'loaded')}
      ${editButton(f.path)}
    </div>`,
  })).join('');
  return section('memory', 'db', 'Memory', memory.files.length, rows);
}

function renderWarnings(warnings) {
  if (!warnings.length) return '';
  const rows = warnings.map((w) => `<div style="margin-bottom:6px"><strong>${escapeHtml(w.path)}</strong><br>${escapeHtml(w.message)}</div>`).join('');
  return `<div class="error-banner">${ICONS.alert}<div>${rows}</div></div>`;
}

const NAV_SECTIONS = [
  { id: 'weight', icon: 'bolt', label: 'What loads' },
  { id: 'claude-md', icon: 'file', label: 'Instructions files' },
  { id: 'references', icon: 'file', label: 'Pointed at' },
  { id: 'settings', icon: 'sliders', label: 'Settings' },
  { id: 'plugins', icon: 'box', label: 'Plugins' },
  { id: 'mcp-user', icon: 'link', label: 'MCP — global' },
  { id: 'mcp-shared', icon: 'link', label: 'MCP — shared' },
  { id: 'mcp-local', icon: 'link', label: 'MCP — private' },
  { id: 'skills', icon: 'bulb', label: 'Skills' },
  { id: 'agents', icon: 'bot', label: 'Subagents' },
  { id: 'hooks', icon: 'bolt', label: 'Hooks' },
  { id: 'memory', icon: 'db', label: 'Memory' },
  { id: 'coverage', icon: 'search', label: 'What this looked at' },
];

// Where the scan went, and where it did not. A list of what loads is only worth
// something if you can also see its edges — everything here is built from the
// paths the scan itself used.
function renderCoverage(coverage) {
  // An answer that does not carry this at all (an older server behind a newer
  // page) must leave the section out. Drawing an empty one would say the scan
  // looked at nothing, which is the opposite of what this section is for.
  if (!coverage.length) return '';
  const list = (lines) => `<ul class="coverage-list">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  const body = `<div class="coverage-intro muted">Everything on this page comes from the files on the left. The ones on the right are not read, so anything they say is not reflected anywhere above.</div>`
    + coverage.map((group) => `<div class="item">
      <div class="item-main">
        <div class="item-title">${escapeHtml(group.title)}</div>
        <div class="coverage-lists">
          <div>
            <div class="coverage-head">Read</div>
            ${list(group.looked)}
          </div>
          <div>
            <div class="coverage-head not">Not read</div>
            ${list(group.notLooked)}
          </div>
        </div>
      </div>
    </div>`).join('');
  return section('coverage', 'search', 'What this looked at', coverage.length, body);
}

function renderSideNav(data) {
  const counts = {
    weight: roughTokens(data.weight.measuredBytes),
    'claude-md': data.claudeMd.files.length + data.claudeMd.nested.length,
    references: data.claudeMd.references ? data.claudeMd.references.files.length : null,
    settings: data.settingsLayers.length,
    plugins: data.plugins.length,
    'mcp-user': data.mcp.user.length,
    'mcp-shared': data.mcp.shared.length,
    'mcp-local': data.mcp.local.length,
    skills: data.skills.length,
    agents: data.agents.length,
    hooks: data.hooks.length,
    memory: data.memory.files.length,
    coverage: data.coverage ? data.coverage.length : null,
  };
  // a section that is not on the page gets no link to it
  return NAV_SECTIONS.filter((s) => counts[s.id] !== null && counts[s.id] !== undefined).map((s) => `
    <a class="nav-item" href="#${s.id}">${ICONS[s.icon]}<span>${s.label}</span><span class="nav-count">${counts[s.id]}</span></a>
  `).join('');
}

// The page comes off disk on every reload; the server keeps the code it started
// with. Update the tool without restarting it and the new page asks an old
// server for things it has never heard of — which used to end as "Cannot read
// properties of undefined". Say which it is, at the top, before anything else.
let serverMeta = null;

function staleWarning(meta) {
  if (!meta || !meta.startedAt || !meta.sourceChangedAt) return '';
  if (meta.sourceChangedAt <= meta.startedAt) return '';
  return `<div class="error-banner">${ICONS.alert}<div>This dashboard has been running since ${
    new Date(meta.startedAt).toLocaleString()
  }, and its own files changed after that (${new Date(meta.sourceChangedAt).toLocaleString()}). You are looking at the new page talking to the old server, so parts of this may be missing or wrong.
    <div class="banner-actions">${actionButton('Start it again now', 'restart', {})}</div>
  </div></div>`;
}

// The server hands the port to a fresh copy of itself, so there is a gap with
// nothing listening: reloading straight away just fails. Wait until something
// answers that started later than the server this page was talking to, and
// reload then.
async function restartDashboard(btn) {
  const previousStartedAt = serverMeta ? serverMeta.startedAt : 0;
  btn.disabled = true;
  btn.textContent = 'Starting it again…';
  let refusal = null;
  try {
    const res = await fetch('/api/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      refusal = body.error || `the dashboard answered ${res.status}`;
    }
  } catch {
    // the connection dying mid-answer is the old server going down, which is
    // what was asked for — only an answer that refuses is a failure
  }
  if (refusal) {
    btn.disabled = false;
    btn.textContent = 'Start it again now';
    alert(refusal);
    return;
  }
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const meta = await fetchJson('/api/projects');
      if (meta.startedAt > previousStartedAt) {
        location.reload();
        return;
      }
    } catch {
      /* not listening yet */
    }
  }
  btn.disabled = false;
  btn.textContent = 'Start it again now';
  alert('The dashboard did not come back. Start it again from the terminal you launched it in.');
}

function render(data) {
  document.getElementById('generated-at').textContent = `generated ${new Date(data.generatedAt).toLocaleString()}`;
  const html = [
    staleWarning(serverMeta),
    renderWarnings(data.warnings),
    renderWeight(data.weight),
    renderClaudeMd(data.claudeMd),
    renderReferences(data.claudeMd.references),
    renderSettings(data.settingsLayers),
    renderPlugins(
      data.plugins,
      data.missingPlugins,
      data.projectPath,
      data.settingsLayers.some((l) => l.label === 'project')
    ),
    renderMcp(data.mcp, data.projectPath),
    renderFileList('skills', 'bulb', 'Skills', data.skills),
    renderFileList('agents', 'bot', 'Subagents', data.agents),
    renderHooks(data.hooks),
    renderMemory(data.memory),
    renderCoverage(data.coverage || []),
  ].join('');
  document.getElementById('content').innerHTML = html;
  document.getElementById('side-nav').innerHTML = renderSideNav(data);
}

async function loadInventory(projectPath) {
  currentProjectPath = projectPath;
  document.getElementById('content').innerHTML = '<p class="muted">Loading…</p>';
  document.getElementById('side-nav').innerHTML = '';
  try {
    const data = await fetchJson(`/api/inventory?path=${encodeURIComponent(projectPath)}`);
    render(data);
  } catch (err) {
    // an old server failing to answer the new page is exactly what the stale
    // banner is about, so it has to survive the failure it warns about
    document.getElementById('content').innerHTML = staleWarning(serverMeta)
      + `<div class="error-banner">${ICONS.alert}<div>${escapeHtml(err.message)}</div></div>`;
  }
}

async function init() {
  const meta = await fetchJson('/api/projects');
  serverMeta = meta;
  const requestedPath = new URLSearchParams(location.search).get('path');
  const startPath = requestedPath || meta.defaultProjectPath;
  document.getElementById('project-path').value = startPath;
  const select = document.getElementById('known-projects');
  for (const p of meta.known) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    if (select.value && mayDiscardEdits()) {
      document.getElementById('project-path').value = select.value;
      forceCloseEditor();
      loadInventory(select.value);
    }
  });
  document.getElementById('load-btn').addEventListener('click', () => {
    if (!mayDiscardEdits()) return;
    forceCloseEditor();
    loadInventory(document.getElementById('project-path').value);
  });
  await loadInventory(startPath);
}

// --- editor ------------------------------------------------------------

// The editor holds the file AND the project it was opened for. Reading the
// current project at save time instead would send one project's path with
// another project's file if the project was switched while it was open.
let editorState = null;
let editorSaving = false;

const el = (id) => document.getElementById(id);

function editorDirty() {
  return !!editorState && editorState.writable && el('editor-text').value !== editorState.savedContent;
}

// Anything that would throw away typing asks first: closing, opening another
// file, switching project, leaving the page.
function mayDiscardEdits() {
  if (!editorDirty()) return true;
  return confirm('This file has changes you have not saved. Throw them away?');
}

async function openEditor(filePath) {
  if (!mayDiscardEdits()) return;
  const projectPath = currentProjectPath;
  el('editor-path').textContent = filePath;
  el('editor-text').value = '';
  el('editor-msg').textContent = 'Loading…';
  el('editor-versions').hidden = true;
  el('editor-history').hidden = true;
  el('editor-history').innerHTML = '';
  el('editor').hidden = false;
  try {
    const data = await fetchJson(
      `/api/file?path=${encodeURIComponent(filePath)}&project=${encodeURIComponent(projectPath)}`
    );
    editorState = {
      filePath: data.filePath,
      projectPath,
      mtimeMs: data.mtimeMs,
      writable: data.writable,
      savedContent: data.content,
    };
    el('editor-text').value = data.content;
    el('editor-text').readOnly = !data.writable;
    el('editor-save').hidden = !data.writable;
    el('editor-msg').textContent = !data.writable
      ? data.readOnlyReason || 'This file can be read here but not changed.'
      : data.exists
      ? ''
      : 'This file does not exist yet — saving will create it.';
    el('editor-text').focus();
    await refreshVersions();
  } catch (err) {
    editorState = null;
    el('editor-msg').textContent = err.message;
  }
}

function closeEditor() {
  if (!mayDiscardEdits()) return;
  forceCloseEditor();
}

// Used where the question has already been asked (switching project), so it
// isn't asked twice for the same edits.
function forceCloseEditor() {
  el('editor').hidden = true;
  el('editor-history').hidden = true;
  el('editor-history').innerHTML = '';
  editorState = null;
}

async function saveEditor() {
  // one save at a time: a second one would be sent with the modification time
  // the first has not finished replacing, and be refused as a change on disk
  if (!editorState || !editorState.writable || editorSaving) return;
  editorSaving = true;
  el('editor-save').disabled = true;
  const { filePath, projectPath } = editorState;
  const sent = el('editor-text').value;
  el('editor-msg').textContent = 'Saving…';
  try {
    const res = await postJson('/api/file/save', {
      filePath,
      projectPath,
      content: sent,
      expectedMtimeMs: editorState.mtimeMs,
    });
    // pick up the new modification time, so a second save in a row isn't
    // mistaken for someone else having changed the file underneath us
    const fresh = await fetchJson(
      `/api/file?path=${encodeURIComponent(filePath)}&project=${encodeURIComponent(projectPath)}`
    );
    if (editorState && editorState.filePath === filePath) {
      editorState.mtimeMs = fresh.mtimeMs;
      editorState.savedContent = sent;
    }
    el('editor-msg').textContent = res.backupPath
      ? `Saved. The previous version was kept at ${res.backupPath}`
      : 'Saved.';
    await refreshVersions();
    await loadInventory(currentProjectPath);
  } catch (err) {
    el('editor-msg').textContent = err.message;
  } finally {
    editorSaving = false;
    el('editor-save').disabled = false;
  }
}

// --- earlier versions of the open file ----------------------------------

let versions = [];
// whether an earlier version can be put back: not the same as whether the
// editor can save typed text, since a linked file refuses the second and
// allows the first
let versionsRestorable = false;
let versionLimits = null;

async function refreshVersions() {
  versions = [];
  versionsRestorable = false;
  versionLimits = null;
  if (!editorState) return;
  try {
    const data = await fetchJson(
      `/api/file/backups?path=${encodeURIComponent(editorState.filePath)}&project=${encodeURIComponent(editorState.projectPath)}`
    );
    versions = data.versions || [];
    versionsRestorable = !!data.restorable;
    versionLimits = data.limits || null;
  } catch {
    /* the list is a convenience: not being able to read it must not stop editing */
  }
  el('editor-versions').hidden = versions.length === 0;
  el('editor-versions').textContent = `Earlier versions (${versions.length})`;
  if (!el('editor-history').hidden) renderVersions();
}

function formatWhen(v) {
  if (!v.savedAt) return v.id;
  const at = new Date(v.savedAt);
  return at.toLocaleString();
}

function renderVersions(diffHtml = '') {
  el('editor-history').innerHTML = `
    <div class="muted">Kept automatically before each write, newest first. Putting one back is an ordinary save: what it replaces is kept too.${
      versionLimits
        ? ` Old ones are cleared as they go: at most ${versionLimits.perFile} of any one file, and ${Math.round(versionLimits.totalBytes / (1024 * 1024))} MB of them in all. The newest of a file is never cleared.`
        : ''
    }</div>
    ${versions.map((v) => `<div class="version-row">
      <span class="version-when">${escapeHtml(formatWhen(v))}${v.size === null ? '' : ` · ${v.size} characters`}</span>
      <span class="version-buttons">
        ${actionButton('See what changed', 'version-diff', { id: v.id })}
        ${versionsRestorable ? actionButton('Put this one back', 'version-restore', { id: v.id }) : ''}
      </span>
    </div>`).join('')}
    ${diffHtml}`;
}

// A plain line comparison: skip the identical beginning and end, then line up
// what is left. A very large middle is not lined up line by line — the table
// would be enormous and the result unreadable — it is shown as one block
// removed and one added.
function diffRows(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const rows = [];
  if (head) rows.push({ type: 'skip', text: `${head} identical line${head === 1 ? '' : 's'} above` });
  if (midA.length * midB.length > 4e6) {
    for (const line of midA) rows.push({ type: 'del', text: line });
    for (const line of midB) rows.push({ type: 'add', text: line });
  } else {
    rows.push(...lineUp(midA, midB));
  }
  if (tail) rows.push({ type: 'skip', text: `${tail} identical line${tail === 1 ? '' : 's'} below` });
  return collapseSame(rows);
}

function lineUp(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) rows.push({ type: 'del', text: a[i++] });
    else rows.push({ type: 'add', text: b[j++] });
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

// Long stretches of unchanged text are the point of a comparison only in that
// they are not the point: say how many there were and move on.
function collapseSame(rows, keep = 2) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > keep * 2 + 1) {
      out.push(...run.slice(0, keep));
      out.push({ type: 'skip', text: `${run.length - keep * 2} identical lines` });
      out.push(...run.slice(-keep));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const row of rows) {
    if (row.type === 'same') run.push(row);
    else {
      flush();
      out.push(row);
    }
  }
  flush();
  return out;
}

const DIFF_MARK = { del: '−', add: '+', same: ' ', skip: '' };

function renderDiff(rows) {
  if (!rows.some((r) => r.type === 'del' || r.type === 'add')) {
    return '<div class="diff"><div class="diff-line diff-same">This version is the same as what is in the editor right now.</div></div>';
  }
  return `<div class="diff">${rows.map((r) => (r.type === 'skip'
    ? `<div class="diff-skip">${escapeHtml(r.text)}</div>`
    : `<div class="diff-line diff-${r.type}">${escapeHtml(`${DIFF_MARK[r.type]} ${r.text}`)}</div>`)).join('')}</div>`;
}

async function showVersionDiff(id) {
  const old = await fetchJson(
    `/api/file/backups?path=${encodeURIComponent(editorState.filePath)}&project=${encodeURIComponent(editorState.projectPath)}&id=${encodeURIComponent(id)}`
  );
  renderVersions(renderDiff(diffRows(old.content, el('editor-text').value)));
}

async function restoreVersion(id) {
  if (editorDirty() && !confirm('This file has changes you have not saved. Put the earlier version back and throw them away?')) return;
  if (!confirm('Put this earlier version back? What is in the file now is kept as a version too, so this can be undone.')) return;
  const { filePath, projectPath } = editorState;
  el('editor-msg').textContent = 'Putting it back…';
  try {
    await postJson('/api/file/restore', { filePath, projectPath, id, expectedMtimeMs: editorState.mtimeMs });
    const fresh = await fetchJson(
      `/api/file?path=${encodeURIComponent(filePath)}&project=${encodeURIComponent(projectPath)}`
    );
    editorState.mtimeMs = fresh.mtimeMs;
    editorState.savedContent = fresh.content;
    el('editor-text').value = fresh.content;
    el('editor-msg').textContent = 'Put back. The version it replaced was kept too.';
    await refreshVersions();
    renderVersions();
    await loadInventory(currentProjectPath);
  } catch (err) {
    el('editor-msg').textContent = err.message;
  }
}

// --- actions -----------------------------------------------------------

function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Anything that changes more than the open project asks first — those switches
// sit next to per-project ones that look exactly the same.
function confirmGlobal(what, turningOn, reach = 'every project') {
  return confirm(`${what} applies to ${reach}, not just this one. Turn it ${turningOn ? 'on' : 'off'} anyway?`);
}

// One change at a time: a second click before the page has been redrawn would
// be acting on positions and states that are already out of date.
let busy = false;

document.getElementById('content').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const { action } = btn.dataset;

  if (action === 'edit') {
    openEditor(btn.dataset.path);
    return;
  }

  if (action === 'restart') {
    await restartDashboard(btn);
    return;
  }

  if (action === 'permission-add' || action === 'permission-remove') {
    const file = btn.dataset.file;
    let rule = btn.dataset.rule;
    let group = btn.dataset.group;
    if (action === 'permission-add') {
      const input = document.querySelector(`.rule-input[data-for="${CSS.escape(file)}"]`);
      const picker = document.querySelector(`.rule-group-pick[data-for="${CSS.escape(file)}"]`);
      rule = input.value.trim();
      group = picker.value;
      if (!rule) {
        input.focus();
        return;
      }
    }
    try {
      await postJson('/api/file/permission', {
        filePath: file, projectPath: currentProjectPath, group, rule,
        action: action === 'permission-add' ? 'add' : 'remove',
      });
      await loadInventory(currentProjectPath);
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  if (busy) return;
  busy = true;
  document.getElementById('content').classList.add('working');

  const nextEnabled = !btn.classList.contains('on'); // clicking an off/unset switch turns it on

  try {
    if (action === 'toggle-plugin') {
      const scope = btn.dataset.scope || 'project';
      if (scope === 'global' && !confirmGlobal('This plugin setting', nextEnabled)) return;
      await postJson('/api/toggle/plugin', {
        projectPath: btn.dataset.project, key: btn.dataset.key, enabled: nextEnabled, scope,
      });
    } else if (action === 'clear-plugin-override') {
      const scope = btn.dataset.scope || 'project';
      if (btn.dataset.global && !confirm('This entry is in your global settings, so removing it changes every project. Remove it?')) return;
      await postJson('/api/toggle/plugin', {
        projectPath: btn.dataset.project, key: btn.dataset.key, clear: true, scope,
      });
    } else if (action === 'toggle-mcp-shared') {
      const res = await postJson('/api/toggle/mcp-shared', {
        projectPath: btn.dataset.project, name: btn.dataset.name, enabled: nextEnabled,
      });
      // the write can land in one file while another one still decides
      if (res && res.note) alert(res.note);
    } else if (action === 'resolve-mcp-duplicate') {
      if (btn.dataset.global && !confirm('This connection is used in every project, so this decides which definition every project gets. Go ahead?')) return;
      await postJson('/api/mcp/resolve-duplicate', {
        scope: btn.dataset.scope, name: btn.dataset.name, keep: btn.dataset.keep, projectPath: btn.dataset.project,
      });
    } else if (action === 'toggle-mcp-local') {
      await postJson('/api/toggle/mcp-local', {
        projectPath: btn.dataset.project, name: btn.dataset.name, enabled: nextEnabled,
      });
    } else if (action === 'move-mcp') {
      if (btn.dataset.global && !confirm('This would load the connection into every conversation you start, in every project. Do that?')) return;
      await postJson('/api/mcp/move', {
        name: btn.dataset.name, to: btn.dataset.to, projectPath: btn.dataset.project,
      });
    } else if (action === 'toggle-mcp-user') {
      if (!confirmGlobal('This tool connection', nextEnabled)) return;
      await postJson('/api/toggle/mcp-user', { name: btn.dataset.name, enabled: nextEnabled });
    } else if (action === 'toggle-file') {
      if (btn.dataset.scope === 'global' && !confirmGlobal('This one', nextEnabled)) return;
      await postJson('/api/toggle/file', {
        filePath: btn.dataset.path, enabled: nextEnabled, projectPath: currentProjectPath,
      });
    } else if (action === 'toggle-markdown') {
      if (btn.dataset.global && !confirmGlobal('This instructions file', nextEnabled, btn.dataset.global)) return;
      await postJson('/api/toggle/markdown', {
        filePath: btn.dataset.path, enabled: nextEnabled, projectPath: currentProjectPath,
      });
    } else if (action === 'toggle-hook') {
      if (btn.dataset.global && !confirmGlobal('This hook', nextEnabled)) return;
      await postJson('/api/toggle/hook', {
        projectPath: currentProjectPath,
        settingsPath: btn.dataset.settings,
        event: btn.dataset.event,
        index: Number(btn.dataset.index),
        signature: btn.dataset.signature,
        enabled: nextEnabled,
      });
    }
    await loadInventory(currentProjectPath);
  } catch (err) {
    alert(err.message);
  } finally {
    busy = false;
    document.getElementById('content').classList.remove('working');
  }
});

el('editor-close').addEventListener('click', closeEditor);
el('editor-save').addEventListener('click', saveEditor);
el('editor').addEventListener('click', (ev) => {
  if (ev.target === el('editor')) closeEditor();
});
el('editor-versions').addEventListener('click', () => {
  const panel = el('editor-history');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderVersions();
});
el('editor-history').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn || !editorState) return;
  try {
    if (btn.dataset.action === 'version-diff') await showVersionDiff(btn.dataset.id);
    if (btn.dataset.action === 'version-restore') await restoreVersion(btn.dataset.id);
  } catch (err) {
    el('editor-msg').textContent = err.message;
  }
});
// the browser's own warning, for closing the tab or reloading it
window.addEventListener('beforeunload', (ev) => {
  if (editorDirty()) ev.preventDefault();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !el('editor').hidden) closeEditor();
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 's' && !el('editor').hidden) {
    ev.preventDefault();
    saveEditor();
  }
});

init();
