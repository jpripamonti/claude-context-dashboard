# Pending

Known rough edges and open questions. Nothing here is known to lose data in
the ordinary case, but the first item is a claim about Claude Code that nobody
has checked, and the second and third are corners where the backup history can
be wrong or missing. Review rounds so far have fixed what they found; this is
what they left, or what the fixes themselves introduced.

## Unverified against real Claude Code

- [ ] The shared-MCP "this project" switch assumes the higher settings layer
      wins: a project-level `enabledMcpjsonServers` is taken to beat a global
      `disabledMcpjsonServers`. Nobody has confirmed that Claude Code merges
      the two lists that way; it may combine them and let "disabled" win, in
      which case the switch writes its answer and the server stays off. When
      the deciding file is a global one, the fallback writes the project's
      committed `.claude/settings.json`, not `settings.local.json`, so a
      teammate sees the change too. Needs a check against a real Claude Code
      session.

## Backups

- [ ] Adopting legacy backups: old `__`-named copies are renamed to the new
      form only when exactly one file on disk could own the name. If a
      colliding file was deleted, the survivor is the only candidate and
      claims all of the old copies, including ones that were really the
      deleted file's. The versions list can then offer text from a file that
      is not this one.
- [ ] Very long paths can exceed the 255-character filename limit for a
      backup name: the whole path is written into the name, and `%XX`
      encoding makes it up to three times longer. The write then fails at the
      copy step, which is safe (nothing is written without a backup) but
      leaves that file impossible to edit from here.
