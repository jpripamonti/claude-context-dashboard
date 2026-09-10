import http from 'node:http';
import fs from 'node:fs';
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

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('application/json')) {
      reject(Object.assign(new Error('expected application/json'), { statusCode: 400 }));
      return;
    }
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      // A settings file or an instructions file is kilobytes; anything past
      // this is not a real edit, and letting it accumulate would let a local
      // program fill this process's memory. The rest is read and thrown away
      // rather than cutting the connection, so the sender gets the refusal
      // instead of a broken pipe.
      if (tooBig) return;
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        tooBig = true;
        data = '';
        reject(Object.assign(new Error(`request body is too large (over ${MAX_BODY_BYTES} bytes)`), { statusCode: 413 }));
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
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

// The banner above tells you to stop the dashboard and start it again; this is
// that, done from the page. The port is handed to a fresh process started from
// the same command line, and this one stays alive waiting for it instead of
// detaching it: the terminal the dashboard was launched from keeps owning it,
// so its output still goes there and Ctrl+C there still stops it.
function restartSelf(server) {
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    const argv = process.argv.slice(1);
    // the browser is already on this page — a second tab is not a restart
    if (!argv.includes('--no-open')) argv.push('--no-open');
    const child = spawn(process.execPath, argv, { stdio: 'inherit' });
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
// restarting itself.
export function createServer(defaultProjectPath, port, { onRestart = restartSelf } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      // Every API response carries real settings — including any keys inside an
      // MCP server's env block — so they all get the same origin check, not
      // just the ones that write.
      if (pathname.startsWith('/api/') && !isSameOrigin(req, port)) {
        return sendJson(res, 403, { error: 'request did not look like it came from this dashboard' });
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
        res.on('finish', () => onRestart(self));
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
