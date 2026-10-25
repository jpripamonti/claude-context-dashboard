# Pending

Known rough edges and open questions. Nothing here is known to lose data in
the ordinary case, but the item below is a claim about Claude Code that nobody
has checked. Review rounds so far have fixed what they found; this is
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
