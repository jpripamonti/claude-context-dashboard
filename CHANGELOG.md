# Changelog

## 0.2.0 — 2026-10-26

A security and data-safety release. Upgrading changes how you open the
dashboard; read the first section before you do.

### What you will notice

- **Open the whole address the terminal prints.** Each launch makes a random
  key and prints `http://localhost:4317/#token=…`. The page needs that key, so
  a bookmark of plain `http://localhost:4317/` shows a message asking you to
  open the printed address instead. Within a tab, reloading keeps working. The
  macOS desktop launcher picks the key up by itself.
- **Saving through a linked skill or subagent folder asks first.** If a
  project's `.claude/skills` or `.claude/agents` folder is a link to somewhere
  outside the project, saving, restoring or switching a file there now asks
  you to confirm, naming where the file really lives.
- **Some files you could edit are now read-only.** A file that a project's
  `CLAUDE.md` pulls in with an `@` line from outside the project and
  `~/.claude` (for example `@~/.bashrc`) opens in the viewer but can't be
  saved. Files your own global `CLAUDE.md` names directly stay editable.
- **One click to turn something off for one project.** A "this project"
  switch that follows the global setting now flips what is actually happening
  on the first click, instead of the second.
- **Results show in a status line** instead of pop-ups, and say which file
  was written and whether a backup was kept.
- **Sizes are labelled as bytes**, which is what was always measured.

### Security

- Every API request needs the per-launch key. Other programs and other users
  on the machine can no longer read or change your config through the
  dashboard by sending requests to `localhost` themselves.
- A cloned repository can no longer make files of yours editable by naming
  them in an `@` line, directly or through a chain of imports.
- A repository that links `.claude` to your global `~/.claude` can no longer
  turn a "this project" switch into a change to every project, under any
  spelling of that folder.
- Reading a project no longer hangs on a device or pipe named in an `@` line,
  and very large files are capped instead of read whole.
- The desktop launcher's log moved out of the world-readable `/tmp`.

### Data safety

- Saving a large file with non-ASCII text no longer corrupts characters.
- Two files can no longer share backups. Backups taken under the old naming
  are still listed for comparison but can't be put back, since which file
  they came from can't be known.
- Putting a version back restores its exact bytes.
- The check for a file changed by another Claude Code session is stronger and
  runs again just before writing.
- A file of an unexpected shape (for example a `permissions.allow` that isn't
  a list) is refused instead of overwritten.
- A malformed plugin record or server list shows a warning in its own section
  instead of taking the whole page down.
- When the backup folder is over budget, space comes back from the file using
  the most, so one large `~/.claude.json` no longer wipes everything else's
  history.

### Page

- Works at phone width; muted text and off switches meet contrast guidelines
  in light and dark themes.
- Switches are announced as switches by screen readers, focus stays in place
  after an action, and the editor keeps focus inside it while open.
- Enter in the path box loads the project, the address bar tracks the project
  you're viewing, and a mistyped path keeps the current page on screen.
- Adding a permission rule to the global settings, or one that doesn't look
  like a rule, asks first.

### Project

- Tests grew from 51 checks to 472 across three suites, and CI runs them on
  Node 18, 20 and 22 on Linux and macOS.
- `docs/reference.md` describes every behavior above.

## 0.1.0

First release.
