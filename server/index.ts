import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { OutputFormat, Scan } from '../src/lib/types';
import { createConverter, defaultConverterUrl } from './converter';
import { HttpError, scanRepository } from './github';
import { JobStore, safePath, selectFiles } from './jobs';

const port = Number(process.env.PORT || 8788);
const converterUrl = process.env.CONVERTER_URL || defaultConverterUrl;
const endpoint = new URL(converterUrl);
if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('CONVERTER_URL must use HTTP or HTTPS.');
const outputRoot = resolve(process.env.OUTPUT_DIR || 'output');
const store = new JobStore(outputRoot, createConverter(converterUrl));
const scans = new Map<string, { scan: Scan; created: number }>();
let scanning = false;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch { throw new HttpError(400, 'Invalid JSON request.'); }
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const host = req.headers.host || '';
    if (!['127.0.0.1', 'localhost'].includes(host.split(':')[0])) throw new HttpError(403, 'Local connections only.');
    if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`, 'http://localhost:3000', 'http://127.0.0.1:3000'].includes(req.headers.origin)) {
      throw new HttpError(403, 'This local API only accepts requests from the app.');
    }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/api/config') {
      json(res, { converterConfigured: true, converterUrl: endpoint.origin + endpoint.pathname, outputRoot }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      const data = await body(req);
      if (typeof data.url !== 'string' || data.url.length > 2048) throw new HttpError(400, 'Provide a GitHub URL.');
      if (scanning) throw new HttpError(409, 'A repository scan is already running.');
      scanning = true;
      try {
        const scan = await scanRepository(data.url);
        while (scans.size >= 20) scans.delete(scans.keys().next().value!);
        scans.set(scan.id, { scan, created: Date.now() });
        json(res, scan);
      } finally { scanning = false; }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const data = await body(req);
      const entry = typeof data.scanId === 'string' ? scans.get(data.scanId) : undefined;
      if (!entry || Date.now() - entry.created > 3_600_000) throw new HttpError(400, 'Inspect the repository again before converting.');
      if (!Array.isArray(data.formats) || !data.formats.length || data.formats.some(format => format !== 'btsx' && format !== 'tsrx')) throw new HttpError(400, 'Choose BTSX, TSRX, or both.');
      if (typeof data.includeTs !== 'boolean') throw new HttpError(400, 'includeTs must be a boolean.');
      json(res, await store.start(selectFiles(entry.scan, data.selectedPaths), data.formats as OutputFormat[], data.includeTs), 202); return;
    }
    const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(cancel|retry|output|manifest))?$/);
    if (match) {
      const [, id, action] = match;
      if (req.method === 'POST' && action === 'retry') {
        await body(req); json(res, await store.retry(id), 202); return;
      }
      if (req.method === 'POST' && action === 'cancel') {
        await body(req); await store.get(id); store.cancel(id); json(res, { ok: true }); return;
      }
      if (req.method === 'GET' && !action) { json(res, await store.get(id)); return; }
      if (req.method === 'GET' && action === 'manifest') {
        res.setHeader('Content-Disposition', 'attachment; filename="manifest.json"');
        json(res, await store.get(id)); return;
      }
      if (req.method === 'GET' && action === 'output') {
        const path = url.searchParams.get('path') || '';
        const code = await store.output(id, path);
        if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()!)}`);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(code); return;
      }
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'API route not found.');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    const asset = safePath(resolve('dist'), url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    let content: Buffer;
    try { content = await readFile(asset); } catch { throw new HttpError(404, 'File not found. Run bun run build first, or use bun run dev.'); }
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': `${mime[extname(asset)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(content);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    if (status === 500) console.error(error);
    if (!res.headersSent) json(res, { error: message }, status);
    else res.end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local crawler: http://127.0.0.1:${port}`);
  console.log(`Output directory: ${outputRoot}`);
});
