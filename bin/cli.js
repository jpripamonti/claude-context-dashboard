#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js';

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

const server = createServer(projectPath, args.port);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(`port ${args.port} is already in use — the dashboard may already be running at http://localhost:${args.port}`);
  }
  fail(String(err.message || err));
});

server.listen(args.port, '127.0.0.1', () => {
  const url = `http://localhost:${args.port}`;
  console.log(`claude-context-dashboard`);
  console.log(`  project: ${projectPath}`);
  console.log(`  url:     ${url}  (loopback only — not reachable from other machines)`);
  console.log(`  (Ctrl+C to stop)`);

  if (!args.noOpen) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      spawn(opener, [url], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
    } catch {
      /* opening the browser is a convenience, not required */
    }
  }
});
