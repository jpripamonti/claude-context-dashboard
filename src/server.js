import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory, listKnownProjects } from './scan.js';
import {
  togglePlugin,
  clearPluginOverride,
  toggleMcpShared,
  toggleMcpLocal,
  toggleMcpUser,
  moveMcpServer,
  resolveMcpDuplicate,
  toggleFile,
  toggleMarkdown,
  toggleHook,
  readEditableFile,
  writeEditableFile,
  updatePermissionRule,
  listBackups,
  readBackup,
  restoreBackup,
} from './toggle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Even bound to loopback, any other page open in the same browser can still
// try to POST here — so state-changing requests are only accepted when they
// look like they came from this dashboard's own page: a matching Host, an
// Origin that (if present at all) matches too, and a JSON content type
// (a real cross-origin browser request can't send that without a CORS
// preflight, which this server doesn't answer for foreign origins).
function isSameOrigin(req, port) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  if (!req.headers.host || !allowedHosts.has(req.headers.host)) return false;
  if (req.headers.origin) {
    const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
    if (!allowedOrigins.has(req.headers.origin)) return false;
  }
  return true;
}

// --- the launch key ------------------------------------------------------
//
// The checks above stop a web page in the browser. They do nothing against a
// program on this machine — another user's, or a tool allowed to reach
// localhost — which can send any Host and Origin it likes. So every /api/
// request also has to carry a key made fresh at each launch, which only the
// terminal that started the dashboard and the tab it opened ever see: it
// travels in the address's #fragment (never sent to a server, never in a log
// or a Referer), and the page sends it back in a header.
export const TOKEN_HEADER = 'x-dashboard-token';
// how a restart hands the key to the process that replaces this one: the
// environment, which only this user can read, rather than the command line,
// which every user on the machine can see in `ps`
export const TOKEN_ENV = 'CLAUDE_DASHBOARD_TOKEN';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Takes the key a restart handed over, and removes it from this process's
// environment, so nothing this process starts later inherits it by accident.
// Anything not shaped like a key this code made is ignored.
export function takeTokenFromEnv(env = process.env) {
  const t = env[TOKEN_ENV];
  delete env[TOKEN_ENV];
  return typeof t === 'string' && TOKEN_SHAPE.test(t) ? t : null;
}

// Compared as hashes so that neither the length nor any prefix of the key can
// be learned from how long a wrong one takes to refuse.
function hasToken(req, token) {
  const sent = req.headers[TOKEN_HEADER];
  if (typeof sent !== 'string' || !sent) return false;
  const a = crypto.createHash('sha256').update(sent).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

const NO_TOKEN_MESSAGE =
  'This tab does not have the key for this dashboard. Open the address the terminal printed when the dashboard started — the whole of it, including the part after "#token=".';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('application/json')) {
      reject(Object.assign(new Error('expected application/json'), { statusCode: 400 }));
      return;
    }
    // Kept as bytes and decoded once at the end. Decoding each piece as it
    // arrived split any character that straddled two pieces — a long file full
    // of "—" came back with a few of them turned into U+FFFD — and counted
    // characters against a limit stated in bytes.
    const chunks = [];
    let received = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      // A settings file or an instructions file is kilobytes; anything past
      // this is not a real edit, and letting it accumulate would let a local
      // program fill this process's memory. The rest is read and thrown away
      // rather than cutting the connection, so the sender gets the refusal
      // instead of a broken pipe.
      if (tooBig) return;
      received += chunk.length;
      chunks.push(chunk);
      if (received > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error(`request body is too large (over ${MAX_BODY_BYTES} bytes)`), { statusCode: 413 }));
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const data = Buffer.concat(chunks).toString('utf8');
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(Object.assign(err, { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const relPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, relPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const STARTED_AT = Date.now();

// A dashboard left running keeps the code it started with in memory, while the
// page it serves comes off disk every time you reload. Update the tool without
// restarting it and you get the new page talking to the old server, which
// answers without the things that page now asks for — one missing field and
// the page dies with something unreadable. These two numbers let it say what
// actually happened instead.
function sourceChangedAt() {
  let newest = 0;
  for (const dir of [__dirname, PUBLIC_DIR]) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        newest = Math.max(newest, fs.statSync(path.join(dir, entry.name)).mtimeMs);
      } catch {
        /* it went away while we were looking */
      }
    }
  }
  return newest;
}

// The open tab holds this launch's key, so the replacement is handed the same
// one — through its environment, never its arguments.
export function restartCommand(token, argv = process.argv, env = process.env) {
  const args = argv.slice(1);
  // the browser is already on this page — a second tab is not a restart
  if (!args.includes('--no-open')) args.push('--no-open');
  return { command: process.execPath, args, options: { stdio: 'inherit', env: { ...env, [TOKEN_ENV]: token } } };
}

// The banner above tells you to stop the dashboard and start it again; this is
// that, done from the page. The port is handed to a fresh process started from
// the same command line, and this one stays alive waiting for it instead of
// detaching it: the terminal the dashboard was launched from keeps owning it,
// so its output still goes there and Ctrl+C there still stops it.
function restartSelf(server, { token } = {}) {
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    const { command, args, options } = restartCommand(token);
    const child = spawn(command, args, options);
    child.on('error', (err) => {
      console.error(`could not start the dashboard again: ${err.message}`);
      process.exit(1);
    });
    child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
    // this process is now only a waiter, so a stop aimed at it has to reach
    // the process actually serving the dashboard
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  };
  server.close(replace);
  // close() only stops new connections. The browser holds this one open, and
  // the replacement cannot take the port until it is gone.
  server.closeIdleConnections?.();
  // a request still in flight somewhere else would hold it open indefinitely
  setTimeout(() => {
    if (!replaced) server.closeAllConnections?.();
  }, 500);
}

// onRestart is here so the tests can watch the endpoint without the test run
// restarting itself. There is no server without a key: leaving it out is a
// mistake, not a way to switch the check off. A port of 0 means "whatever the
// listener was given", read off the connection.
export function createServer(defaultProjectPath, port, { onRestart = restartSelf, token } = {}) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) throw new Error('createServer needs a token from newToken()');
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      // Every API response carries real settings — including any keys inside an
      // MCP server's env block — so they all get the same origin check, not
      // just the ones that write.
      if (pathname.startsWith('/api/') && !isSameOrigin(req, port || req.socket.localPort)) {
        return sendJson(res, 403, { error: 'request did not look like it came from this dashboard' });
      }
      if (pathname.startsWith('/api/') && !hasToken(req, token)) {
        return sendJson(res, 403, { error: NO_TOKEN_MESSAGE, reason: 'token' });
      }

      if (req.method === 'GET' && pathname === '/api/inventory') {
        const projectPath = url.searchParams.get('path') || defaultProjectPath;
        return sendJson(res, 200, buildInventory(projectPath));
      }

      if (req.method === 'GET' && pathname === '/api/projects') {
        return sendJson(res, 200, {
          defaultProjectPath,
          known: listKnownProjects(),
          startedAt: STARTED_AT,
          sourceChangedAt: sourceChangedAt(),
        });
      }

      // Reading a file back, for the editor
      if (req.method === 'GET' && pathname === '/api/file') {
        const filePath = url.searchParams.get('path');
        const projectPath = url.searchParams.get('project') || defaultProjectPath;
        return sendJson(res, 200, readEditableFile({ filePath, projectPath }));
      }

      // earlier versions of one file, from the backups every write already takes
      if (req.method === 'GET' && pathname === '/api/file/backups') {
        const filePath = url.searchParams.get('path');
        const projectPath = url.searchParams.get('project') || defaultProjectPath;
        const id = url.searchParams.get('id');
        if (id) return sendJson(res, 200, readBackup({ filePath, projectPath, id }));
        return sendJson(res, 200, listBackups({ filePath, projectPath }));
      }

      // Restart, from the button in the stale-version banner. Nothing is read
      // from the body, but reading it is what enforces the JSON content type
      // that keeps another page in the browser from posting here.
      if (req.method === 'POST' && pathname === '/api/restart') {
        await readJsonBody(req);
        const self = req.socket.server;
        // the answer has to be out the door before the socket is torn down
        res.on('finish', () => onRestart(self, { token }));
        return sendJson(res, 200, { ok: true, startedAt: STARTED_AT });
      }

      if (req.method === 'POST' && (pathname.startsWith('/api/toggle/') || pathname.startsWith('/api/file/') || pathname.startsWith('/api/mcp/'))) {
        if (pathname === '/api/file/save') {
          const { filePath, projectPath, content, expectedMtimeMs } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...writeEditableFile({ filePath, projectPath, content, expectedMtimeMs }) });
        }
        if (pathname === '/api/file/restore') {
          const { filePath, projectPath, id, expectedMtimeMs } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...restoreBackup({ filePath, projectPath, id, expectedMtimeMs }) });
        }
        if (pathname === '/api/file/permission') {
          const { filePath, projectPath, group, rule, action } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...updatePermissionRule({ filePath, projectPath, group, rule, action }) });
        }
        if (pathname === '/api/toggle/plugin') {
          const { projectPath, key, enabled, scope, clear } = await readJsonBody(req);
          if (clear) return sendJson(res, 200, { ok: true, ...clearPluginOverride({ projectPath, key, scope }) });
          return sendJson(res, 200, { ok: true, ...togglePlugin({ projectPath, key, enabled, scope }) });
        }
        if (pathname === '/api/toggle/markdown') {
          const { projectPath, filePath, enabled } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...toggleMarkdown({ projectPath, filePath, enabled }) });
        }
        if (pathname === '/api/toggle/hook') {
          const { projectPath, settingsPath, event, index, enabled, signature } = await readJsonBody(req);
          return sendJson(res, 200, {
            ok: true,
            ...toggleHook({ projectPath, settingsPath, event, index, enabled, signature }),
          });
        }
        if (pathname === '/api/toggle/mcp-shared') {
          const { projectPath, name, enabled } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...toggleMcpShared({ projectPath, name, enabled }) });
        }
        if (pathname === '/api/toggle/mcp-local') {
          const { projectPath, name, enabled } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...toggleMcpLocal({ projectPath, name, enabled }) });
        }
        if (pathname === '/api/mcp/resolve-duplicate') {
          const { scope, projectPath, name, keep } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...resolveMcpDuplicate({ scope, projectPath, name, keep }) });
        }
        if (pathname === '/api/mcp/move') {
          const { name, to, projectPath } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...moveMcpServer({ name, to, projectPath }) });
        }
        if (pathname === '/api/toggle/mcp-user') {
          const { name, enabled } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...toggleMcpUser({ name, enabled }) });
        }
        if (pathname === '/api/toggle/file') {
          const { filePath, enabled, projectPath } = await readJsonBody(req);
          return sendJson(res, 200, { ok: true, ...toggleFile({ filePath, enabled, projectPath }) });
        }
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'unknown endpoint' });
      }

      return serveStatic(req, res, pathname);
    } catch (err) {
      return sendJson(res, err.statusCode || 500, { error: String(err.message || err) });
    }
  });
}

// What the command line and the tests both start: always on loopback only, so
// the address the tests check is the address users get. Resolves once it is
// listening, with the address to open — key included.
export function startServer({ projectPath, port = 0, token = newToken(), onRestart } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(projectPath, port, { token, ...(onRestart ? { onRestart } : {}) });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const actual = server.address().port;
      resolve({ server, token, port: actual, url: `http://localhost:${actual}/#token=${token}` });
    });
  });
}
