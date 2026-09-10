# Pending

Known rough edges, none of which lose data. Three rounds of adversarial review
have been done; everything they found is fixed except the list below.

## Smaller

- [ ] A path containing a newline makes its backups invisible and unprunable:
      `BACKUP_NAME`'s `(.*)` doesn't match `\n`
      ([src/toggle.js#L11](src/toggle.js#L11)), so `listBackups` reports none
      while copies pile up. The check it replaced handled this.
- [ ] Turning something off for one project takes two clicks: the "this
      project" switch starts at "follows the global setting", and the first
      click writes `true` before the second writes `false`. An undecided switch
      should go to the opposite of what is happening now.
- [ ] Version rows label `stat().size` as "characters"; it is bytes.

- [ ] A malformed `installed_plugins.json` or a non-iterable
      `enabledMcpjsonServers` takes the whole page down, not just its section:
      `scanPlugins` calls `records.some(...)` and `sharedMcpState` iterates the
      key without checking either first. Both are noted in
      [docs/schema-assumptions.md](docs/schema-assumptions.md) (A7, A10) as
      damage the page does not contain.
- [ ] Adding a permission rule to a `permissions.allow` that is not an array
      replaces it with a fresh array holding only the new rule; the old rules
      survive only in the backup. Same for a `mcpServers` that is an array:
      switching a server off assigns a named property that `JSON.stringify`
      drops, and the definition is gone from the file.

## Tests

- [ ] Nothing checks that the editor panel shows the version limits — deleting
      the whole `versionLimits ? … : ''` interpolation from `renderVersions`
      leaves both suites passing. Only the API half is covered.
- [ ] The two guards in `test/editor.test.mjs` (unknown element id, button not
      found) `throw`, so the run aborts and the remaining checks never run. They
      should fail a check and carry on.
- [ ] Brittle matching in the same file: `knownIds` only finds ids written with
      double quotes, `buttonsIn` breaks on a literal `>` inside an attribute,
      and `data-([a-z-]+)` would miss a data attribute containing a digit.
