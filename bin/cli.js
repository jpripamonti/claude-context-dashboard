#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, takeTokenFromEnv } from '../src/server.js';

const USAGE = `claude-context — dashboard for what Claude Code loads in a project

Usage: claude-context [options]

Options:
  -p, --path <dir>   project to inspect (default: current directory)
      --port <n>     port to serve on (default: 4317)
      --no-open      don't open the browser automatically
  -h, --help         show this message
`;

function parseArgs(argv) {
  const args = { port: 4317, path: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '--path' || a === '-p') {
      args.path = argv[++i];
      if (!args.path) fail('--path needs a directory');
    } else if (a === '--port') {
      args.port = Number(argv[++i]);
      if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) fail('--port needs a number between 1 and 65535');
    } else if (a === '--no-open') {
      args.noOpen = true;
    } else {
      fail(`unknown option: ${a}`);
    }
  }
  return args;
}

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const projectPath = path.resolve(args.path);

// A restart hands this launch's key over in the environment, so the tab that
// asked for the restart keeps working; taking it also removes it from this
// process's environment, so nothing started from here inherits it.
const handedOver = takeTokenFromEnv();

startServer({ projectPath, port: args.port, ...(handedOver ? { token: handedOver } : {}) }).then(({ url }) => {
  console.log(`claude-context-dashboard`);
  console.log(`  project: ${projectPath}`);
  console.log(`  url:     ${url}`);
  console.log(`           (loopback only — not reachable from other machines; the part after # is this launch's key,`);
  console.log(`            so open the whole address, and do not share it)`);
  console.log(`  (Ctrl+C to stop)`);

  if (!args.noOpen) openBrowser(url);
}, (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(`port ${args.port} is already in use — the dashboard may already be running at http://localhost:${args.port}`);
  }
  fail(String(err.message || err));
});

// The browser is not handed the address itself: whatever is given to the
// opener sits in its command line, and the browser's if this launches it,
// where any user on the machine can read it with `ps`. It is handed a file
// only this user can read, which sends the tab on to the real address.
function openBrowser(url) {
  let target = url;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-context-'));
    const file = path.join(dir, 'open.html');
    const json = JSON.stringify(url).replace(/</g, '\\u003c');
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>claude-context-dashboard</title><script>location.replace(${json})</script>`, { mode: 0o600 });
    target = file;
    const cleanUp = () => fs.rmSync(dir, { recursive: true, force: true });
    // long enough for a browser that has to start first
    setTimeout(cleanUp, 120000).unref();
    process.on('exit', cleanUp);
  } catch {
    /* no private file to be had: fall back to the address itself */
  }
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(opener, process.platform === 'win32' ? ['""', `"${target}"`] : [target], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
  } catch {
    /* opening the browser is a convenience, not required */
  }
}
