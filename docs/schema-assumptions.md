# What this dashboard assumes about Claude Code's files

Claude Code does not publish a schema for the files it keeps under `~/.claude`,
`~/.claude.json` and a project's `.claude/` folder. Everything below was read off
one real installation — **Claude Code 2.1.x, macOS, September 2026** — and could
be different on yours, or in a later version.

`bin/check-config.js` checks this list against the files on your own machine and
tells you which ones hold. It reads and writes nothing else; see
[the README](../README.md#does-it-match-your-machine) for how to report a mismatch.

Each entry says what breaks if the assumption is wrong. Mostly, reading is the
forgiving half: a file with an unexpected shape is skipped and a section of the
page comes up empty. But not always — a few shapes (A7, A10) are walked without
being checked first, and take the whole page down rather than one section. The
half that matters is writing: a switch can write something Claude Code then
ignores, and the page reports success for a change that did not happen. Where
that is the risk, the row says so.

`bin/check-config.js` reports a line for every row here. Some of them it can only
mark **not checked** — an assumption about what Claude Code *does* with a file
cannot be settled by reading files.

| # | File | Assumed | If it's wrong |
|---|------|---------|---------------|
| A1 | `~/.claude.json` | Exists and is a JSON **object**. | Global and per-project MCP servers are not listed. It is not fatal for writing: the first switch creates the file from scratch, which is fine for a missing file and destructive-looking for one that holds something this cannot parse (the backup keeps it). |
| A2 | `~/.claude.json` → `mcpServers` | An object, server name → definition object. | Global servers are listed under nonsense keys rather than not at all. Worse on the write side: if it is an **array**, switching a server off assigns a named property that `JSON.stringify` then drops, and the definition is gone from the file (it survives only in the backup). |
| A3 | `~/.claude.json` → `projects` | An object keyed by the project's **real** absolute path — the path with every symlink resolved, which is what the dashboard looks up. | Private per-project servers are not listed, and a switch writes a second key beside the one Claude Code reads: it reports success and changes nothing. |
| A4 | `~/.claude.json` → `disabledUserMcpServers`, and `projects[p].disabledLocalMcpServers` | This dashboard's **own** shadow keys, holding servers it switched off. Claude Code ignores unknown keys here (the file is internal state, not schema-validated). | If Claude Code ever validates this file, switched-off servers could be dropped instead of parked. Their definitions are also in the backup taken before the write. |
| A5 | The four settings files: `~/.claude/settings.json`, `~/.claude/settings.local.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json` | Each is a JSON object, and these are all the layers that exist (aside from enterprise-managed settings, which are not read). | A layer that is not read means the page attributes a setting to the wrong file — and a switch writes the wrong file. |
| A6 | Settings → `enabledPlugins` | Object, `plugin@marketplace` → boolean. | Plugin switches write a key Claude Code ignores. |
| A7 | Settings → `enabledMcpjsonServers` / `disabledMcpjsonServers` / `enableAllProjectMcpServers` | Two arrays of server names and a boolean. | Servers shared through `.mcp.json` show the wrong state and their switch writes something inert. If either key holds something that cannot be iterated, the scan throws and **the whole page fails**, editor included. |
| A8 | Settings → `hooks` | Object, event name → array of `{ matcher, hooks: [{ type: "command", command }] }`. | Hooks of an unknown type are still listed, and switching one off still parks and restores it verbatim. A non-array under an event is skipped silently; a shape the switch cannot place raises a visible error rather than reporting a success. |
| A9 | Settings → `permissions` | Object with `allow` / `deny` / `ask` arrays of rule strings. | Rules are not listed. Adding one is the damage: a list that is not an array is **replaced** by a fresh one holding only the new rule, and the old rules survive only in the backup. |
| A10 | `~/.claude/plugins/installed_plugins.json` | `{ plugins: { "name@marketplace": [record, …] } }`, each record `{ scope: "user" \| "local", installPath, version }`, and `projectPath` on a `local` one. | A record that is not in an array, or without an `installPath` string, makes the scan throw: **the whole page fails**, not just the plugin list. A plugin the page never lists also never contributes its skills to the startup weight. |
| A11 | `<installPath>/.claude-plugin/plugin.json` | The plugin's manifest: `name`, `description`, `author.name`. | The plugin is listed without its description. Harmless. |
| A12 | A plugin's contents | `commands/*.md`, `agents/*.md`, `skills/<name>/SKILL.md`, `hooks/hooks.json`, in folders of those names inside `installPath` — a manifest cannot point them somewhere else. | "Contributes:" undercounts what the plugin adds, and its skills are missing from the startup weight. |
| A13 | `~/.claude/plugins/known_marketplaces.json` | Object, marketplace name → an entry carrying a `source`, which is a string on some installations and an object naming a kind (`github`, `directory`) on others. | A plugin is listed without where it came from. Harmless — the page passes this through and does not show it. |
| A14 | Skills and subagents | Skills at `<dir>/skills/<name>/SKILL.md`, subagents as flat `<dir>/agents/<name>.md`, under `~/.claude` and `<project>/.claude`. A `.disabled` suffix on either is this dashboard's own way of switching one off. | They are not listed, and the startup weight is understated. |
| A15 | Frontmatter in those files | YAML between `---` fences, with `description` as a **string** (plain or block scalar, not a list). The name comes from the folder or file name, not the frontmatter. | The entry is listed without its description, which is also the part that loads at startup, so the weight is understated. |
| A16 | `@` lines inside instructions files | `@path` pulls another file's text in, resolved against the file itself or `~`, followed five hops deep, and recognised anywhere in the file — inside a fenced code block too. | Imported text is not counted, so the page understates what loads; or text that is only an example is counted as if it loaded. |
| A17 | `<project>/.mcp.json` | `{ mcpServers: { name: definition } }`, committed with the project. | Shared servers are not listed or switchable. |
| A18 | Per-project memory | `~/.claude/projects/<the project path with every character that is not a letter or a digit turned into a dash>/memory/MEMORY.md`. | Memory notes are not listed. Getting the spelling wrong is silent and looks exactly like a project with no memory — this dashboard replaced only the slashes until September 2026, and so missed every project whose path holds a dot, an underscore or a space. |

| A19 | Enterprise-managed settings: `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `C:\ProgramData\ClaudeCode\managed-settings.json` (Windows), `/etc/claude-code/managed-settings.json` (elsewhere) | That this is where such a file lives, and that it outranks all four layers in A5. Deliberately **not read**. | On a managed machine the page can say "on" about something that file turns off. The page says so, and says whether one exists. |
| A20 | Settings precedence | global → global-local → project → project-local, later wins. | The page attributes a setting to the wrong file, and the MCP switch — which writes wherever the decision is currently made — writes the wrong one. |
| A21 | `~/.claude.json` → `projects[p]` → `enabledMcpjsonServers` / `disabledMcpjsonServers` | The same two arrays again, as a layer **below** every settings file: this is where a switch writes when no settings file has decided. | A server shared through `.mcp.json` cannot be switched at all from a project with no settings file of its own. |
| A22 | A `.disabled` suffix hides a file from Claude Code | Renaming `SKILL.md` → `SKILL.md.disabled` (same for a subagent, a `CLAUDE.md`, a memory note) is enough to stop it loading. | Every off switch that works by renaming would report success while the thing kept loading. This is the assumption with the widest blast radius and the least evidence behind it. |
| A23 | Where `CLAUDE.md` files are looked for | The global one, then every folder from the project up to `$HOME`, `CLAUDE.local.md` beside each, plus one folder deep inside the project. | The page understates what loads. It also decides what may be edited: a file Claude Code does not read could still be renamed by a switch here. |
| A24 | A plugin absent from `enabledPlugins` is off | `?? false` — no entry means not loaded. | If the real default were "on", every such plugin is missing from the page and its skills from the weight. |
| A25 | A plugin's `hooks/hooks.json` | Either `{ hooks: { … } }` or the events object written directly. | The plugin's hooks are not listed. They cannot be switched individually anyway, so this only understates. |
