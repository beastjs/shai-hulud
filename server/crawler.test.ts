import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkConverter, converterUrl, createConverter } from './converter';
import { parseGitHubUrl, readSource, scanRepository, type Fetcher } from './github';
import { JobStore, safePath, selectFiles, type Convert } from './jobs';
import { extractMetadata } from './metadata';
import type { Job, Scan } from '../src/lib/types';

function mockFetch(routes: Record<string, unknown>, calls: string[] = []): Fetcher {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    calls.push(path);
    if (!(path in routes)) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(routes[path]);
  }) as Fetcher;
}
const blob = (path: string, mode = '100644') => ({ path, type: 'blob', mode, sha: path, size: 20 });
const scan: Scan = {
  id: 'scan', url: 'https://github.com/org/repo/tree/main/ui', owner: 'org', repo: 'repo', ref: 'main', commit: 'fixed', folder: 'ui',
  files: [{ path: 'nested/a.tsx', sha: 'a', size: 20, kind: 'tsx' }, { path: 'types.ts', sha: 'b', size: 20, kind: 'ts' }],
};
async function finish(store: JobStore, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = await store.get(id);
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Job did not finish');
}

test('accepts public repository/folder links and rejects unsupported hosts and file links', () => {
  assert.equal(parseGitHubUrl('https://github.com/org/repo.git/').repo, 'repo');
  assert.deepEqual(parseGitHubUrl('https://github.com/org/repo/tree/main/ui').tail, ['main', 'ui']);
  for (const url of ['http://github.com/org/repo', 'https://github.com.evil.test/org/repo', 'https://github.com/org/repo/blob/main/a.tsx', 'https://user@github.com/org/repo', 'bad-url']) {
    assert.throws(() => parseGitHubUrl(url));
  }
});

test('resolves branches with slashes, pins the commit, and includes only regular TS/TSX files', async () => {
  const result = await scanRepository('https://github.com/org/repo/tree/feature/new/ui', mockFetch({
    '/repos/org/repo': { private: false, default_branch: 'main' },
    '/repos/org/repo/commits/feature%2Fnew': { sha: 'fixed', commit: { tree: { sha: 'root' } } },
    '/repos/org/repo/git/trees/root': { truncated: false, tree: [{ path: 'ui', type: 'tree', sha: 'ui' }] },
    '/repos/org/repo/git/trees/ui?recursive=1': { truncated: false, tree: [blob('button.tsx'), blob('types.ts'), blob('README.md'), blob('link.tsx', '120000'), blob('nested/use.ts')] },
  }));
  assert.equal(result.ref, 'feature/new');
  assert.equal(result.commit, 'fixed');
  assert.equal(result.folder, 'ui');
  assert.deepEqual(result.files.map(file => file.path), ['button.tsx', 'nested/use.ts', 'types.ts']);
});

test('falls back to individual subtrees when GitHub truncates a recursive listing', async () => {
  const result = await scanRepository('https://github.com/org/repo', mockFetch({
    '/repos/org/repo': { private: false, default_branch: 'main' },
    '/repos/org/repo/commits/main': { sha: 'fixed', commit: { tree: { sha: 'root' } } },
    '/repos/org/repo/git/trees/root?recursive=1': { truncated: true, tree: [blob('partial.tsx')] },
    '/repos/org/repo/git/trees/root': { truncated: false, tree: [blob('a.tsx'), { path: 'nested', type: 'tree', sha: 'child' }] },
    '/repos/org/repo/git/trees/child': { truncated: false, tree: [blob('b.ts')] },
  }));
  assert.deepEqual(result.files.map(file => file.path), ['a.tsx', 'nested/b.ts']);
});

test('rejects private repositories and reports GitHub rate limits', async () => {
  await assert.rejects(scanRepository('https://github.com/org/repo', mockFetch({ '/repos/org/repo': { private: true } })), /only accepts public/);
  await assert.rejects(scanRepository('https://github.com/org/repo', (async () => new Response('', { status: 429 })) as Fetcher), /rate limit/);
});

test('source downloads use the pinned commit and correctly encode paths', async () => {
  let requested = '';
  const source = await readSource(scan, { ...scan.files[0], path: 'with space/a.tsx' }, undefined, (async url => {
    requested = String(url); return new Response('source code');
  }) as Fetcher);
  assert.equal(source, 'source code');
  assert.equal(requested, 'https://raw.githubusercontent.com/org/repo/fixed/ui/with%20space/a.tsx');
});

test('converter uses the actual API contract and retains compilation diagnostics', async () => {
  const raw = { ok: true, outputs: { btsx: { code: 'p hi', diagnostics: ['review'] }, tsrx: { code: '<p>hi</p>' } }, compilation: { beast: { ok: false } } };
  const converter = createConverter('https://converter.test/api/converter', (async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { code: 'source', outputs: ['btsx', 'tsrx'] });
    return Response.json(raw);
  }) as Fetcher);
  const result = await converter('source', ['btsx', 'tsrx'], new AbortController().signal);
  assert.equal(result.outputs.btsx?.code, 'p hi');
  assert.match(result.outputs.btsx?.warning ?? '', /compilation error/);
  assert.deepEqual(result.raw, raw);
  const malformed = createConverter('https://converter.test', (async () => Response.json({ ok: true, outputs: {} })) as Fetcher);
  assert.match((await malformed('x', ['tsrx'], new AbortController().signal)).outputs.tsrx?.error ?? '', /no outputs.tsrx.code/);
});

test('converter rejects HTTP errors and non-JSON responses', async () => {
  for (const response of [Response.json({ error: 'bad code' }, { status: 422 }), new Response('<html>error</html>', { status: 502 })]) {
    const converter = createConverter('https://converter.test', (async () => response.clone()) as Fetcher, async () => {});
    await assert.rejects(converter('x', ['btsx'], new AbortController().signal), /Converter/);
  }
});

test('saves both formats with one conversion, copies TS unchanged, persists raw response and reloads manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-test-'));
  try {
    let conversions = 0;
    let reads = 0;
    const convert: Convert = async (_code, formats) => {
      conversions++;
      assert.deepEqual(formats, ['btsx', 'tsrx']);
      return { outputs: { btsx: { code: 'p hi' }, tsrx: { code: '<p>hi</p>' } }, raw: { ok: true } };
    };
    const store = new JobStore(dir, convert, async (_scan, file) => { reads++; return file.kind === 'ts' ? 'export type T = string;\n' : 'tsx source'; });
    const job = await store.start(scan, ['btsx', 'tsrx'], true);
    const done = await finish(store, job.id);
    assert.equal(done.status, 'completed');
    assert.equal(conversions, 1);
    assert.equal(reads, 2);
    assert.equal(done.files.length, 4);
    assert.equal(await store.output(job.id, 'btsx/nested/a.btsx'), 'p hi');
    assert.equal(await store.output(job.id, 'tsrx/types.ts'), 'export type T = string;\n');
    assert.deepEqual(JSON.parse(await readFile(join(done.outputDir, 'responses/nested/a.tsx.json'), 'utf8')), { ok: true });
    assert.equal((await new JobStore(dir, convert).get(job.id)).status, 'completed');
    await assert.rejects(store.output(job.id, '../manifest.json'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('records one file failure and continues processing subsequent files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-test-'));
  try {
    const store = new JobStore(dir, async () => { throw new Error('converter down'); }, async () => 'source');
    const done = await finish(store, (await store.start(scan, ['btsx', 'tsrx'], true)).id);
    assert.equal(done.status, 'failed');
    assert.deepEqual(done.files.map(file => file.status), ['failed', 'failed', 'saved', 'saved']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancels an in-flight conversion and does not write its output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-test-'));
  try {
    const store = new JobStore(dir, async (_code, _formats, signal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(new Error('cancelled'));
        else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      return { outputs: {}, raw: null };
    }, async () => 'source');
    const job = await store.start(scan, ['btsx'], true);
    await assert.rejects(store.start(scan, ['btsx'], true), /already running/);
    store.cancel(job.id);
    const done = await finish(store, job.id);
    assert.equal(done.status, 'cancelled');
    assert.ok(done.files.every(file => file.status === 'cancelled'));
    await assert.rejects(store.output(job.id, 'btsx/nested/a.btsx'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects traversal and case-colliding paths before starting a run', async () => {
  for (const path of ['../escape', '/absolute', 'a/../../bad', 'a\\bad', '.', 'a//b']) assert.throws(() => safePath('/tmp/output', path));
  const store = new JobStore('/tmp/unused-shai-tests', async () => ({ outputs: {}, raw: null }));
  await assert.rejects(store.start({ ...scan, files: [{ ...scan.files[0], path: '../bad.tsx' }] }, ['btsx'], false), /Invalid file path/);
  await assert.rejects(store.start({ ...scan, files: [{ ...scan.files[0], path: 'A.tsx' }, { ...scan.files[0], path: 'a.tsx' }] }, ['btsx'], false), /collide/);
});

test('preserves code when the API reports ok:false and retries transient failures with backoff', async () => {
  let requests = 0;
  const pauses: number[] = [];
  const converter = createConverter('https://converter.test', (async () => {
    requests++;
    if (requests === 1) return new Response('busy', { status: 503 });
    if (requests === 2) return new Response('busy', { status: 429, headers: { 'Retry-After': '4' } });
    return Response.json({ ok: false, outputs: { btsx: { code: 'p hi' } }, compilation: { beast: { ok: true }, octane: { ok: false } } });
  }) as Fetcher, async milliseconds => { pauses.push(milliseconds); });
  const result = await converter('source', ['btsx'], new AbortController().signal);
  assert.equal(requests, 3);
  assert.deepEqual(pauses, [1000, 4000]);
  assert.equal(result.outputs.btsx?.code, 'p hi');
  assert.match(result.outputs.btsx?.warning ?? '', /validation warnings/);
});

test('retry processes only failed outputs and retains saved outputs across a server restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-test-'));
  try {
    const initial = new JobStore(dir, async () => ({ outputs: { btsx: { code: 'original' }, tsrx: { error: 'temporary' } }, raw: {} }), async () => 'source');
    const first = await finish(initial, (await initial.start(scan, ['btsx', 'tsrx'], true)).id);
    assert.equal(first.status, 'failed');
    let calls = 0;
    const restarted = new JobStore(dir, async (_code, formats) => {
      calls++;
      assert.deepEqual(formats, ['tsrx']);
      return { outputs: { tsrx: { code: 'recovered' } }, raw: {} };
    }, async () => 'source');
    const done = await finish(restarted, (await restarted.retry(first.id)).id);
    assert.equal(done.status, 'completed');
    assert.equal(calls, 1);
    assert.equal(await restarted.output(done.id, 'btsx/nested/a.btsx'), 'original');
    assert.equal(await restarted.output(done.id, 'tsrx/nested/a.tsrx'), 'recovered');
    assert.equal((await readdir(join(done.outputDir, 'responses/nested/a.tsx.history'))).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('selected jobs never read, convert, or copy unchecked files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-selection-test-'));
  try {
    const reads: string[] = [];
    let conversions = 0;
    const store = new JobStore(dir, async () => {
      conversions++;
      return { outputs: { btsx: { code: 'p selected' } }, raw: {} };
    }, async (_scan, file) => { reads.push(file.path); return 'source'; });
    const selected = selectFiles(scan, ['nested/a.tsx']);
    const done = await finish(store, (await store.start(selected, ['btsx'], true)).id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(reads, ['nested/a.tsx']);
    assert.equal(conversions, 1);
    assert.deepEqual(done.files.map(file => file.output), ['btsx/nested/a.btsx']);
    assert.equal(scan.files.length, 2);
    await assert.rejects(readFile(join(done.outputDir, 'btsx/types.ts')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('selection rejects empty, malformed, and unknown paths, and deduplicates valid paths', () => {
  for (const paths of [undefined, [], 'nested/a.tsx', [42], ['not-in-scan.tsx'], ['../escape.tsx']]) {
    assert.throws(() => selectFiles(scan, paths));
  }
  assert.deepEqual(selectFiles(scan, ['types.ts', 'types.ts']).files.map(file => file.path), ['types.ts']);
});

test('metrics preserve per-format values and distinguish Octane from Beast compilation', () => {
  const raw = {
    input: { metrics: { chars: 100, lines: 10, tokens: 0 } },
    outputs: { btsx: { metrics: { chars: 80, lines: 8, tokens: 12 } }, tsrx: { metrics: { chars: 90, lines: 9, tokens: 15 } } },
    compilation: { beast: { ok: true }, octane: { ok: false, error: 'Invalid export' } },
  };
  const btsx = extractMetadata(raw, 'btsx');
  assert.deepEqual(btsx.input, { chars: 100, lines: 10, tokens: 0 });
  assert.equal(btsx.output.lines, 8);
  assert.equal(extractMetadata(raw, 'tsrx').output.lines, 9);
  assert.equal(btsx.beast.ok, true);
  assert.deepEqual(btsx.octane, { ok: false, error: 'Invalid export' });
  const missing = extractMetadata({ ok: true, outputs: { btsx: { metrics: { chars: -1, tokens: '12', lines: null } } } }, 'btsx');
  assert.deepEqual(missing.output, {});
  assert.equal(missing.octane.ok, null);
});

test('new runs persist metrics in manifests without depending on the raw response for display', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-metadata-test-'));
  try {
    const raw = { input: { metrics: { lines: 12 } }, outputs: { btsx: { code: 'p hi', metrics: { lines: 2 } } }, compilation: { octane: { ok: true } } };
    const convert: Convert = async () => ({ outputs: { btsx: { code: 'p hi' } }, raw });
    const store = new JobStore(dir, convert, async () => 'source');
    const done = await finish(store, (await store.start(selectFiles(scan, ['nested/a.tsx']), ['btsx'], false)).id);
    assert.equal(done.files[0].metadata?.output.lines, 2);
    assert.equal(done.files[0].metadata?.octane.ok, true);
    await rm(join(done.outputDir, 'responses'), { recursive: true });
    const restored = await new JobStore(dir, convert).get(done.id);
    assert.deepEqual(restored.files[0].metadata, done.files[0].metadata);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy runs recover matching saved metadata and never claim success from a different output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-legacy-metadata-test-'));
  try {
    const raw = { outputs: { btsx: { code: 'p hi', metrics: { tokens: 2 } } }, compilation: { octane: { ok: true } } };
    const convert: Convert = async () => ({ outputs: { btsx: { code: 'p hi' } }, raw });
    const store = new JobStore(dir, convert, async () => 'source');
    const done = await finish(store, (await store.start(selectFiles(scan, ['nested/a.tsx']), ['btsx'], false)).id);
    const manifest = JSON.parse(await readFile(join(done.outputDir, 'manifest.json'), 'utf8'));
    delete manifest.files[0].metadata;
    await writeFile(join(done.outputDir, 'manifest.json'), JSON.stringify(manifest));
    assert.equal((await new JobStore(dir, convert).get(done.id)).files[0].metadata?.octane.ok, true);
    await writeFile(join(done.outputDir, 'responses/nested/a.tsx.json'), JSON.stringify({ ...raw, outputs: { btsx: { code: 'different code' } } }));
    assert.equal((await new JobStore(dir, convert).get(done.id)).files[0].metadata, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runs and records the chosen converter endpoint, including on retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-test-'));
  try {
    const used: string[] = [];
    const endpoint = (target: 'remote' | 'local', code: string | null) => ({
      target, url: `http://${target}.test/api/converter`,
      convert: (async () => { used.push(target); return code === null ? { outputs: { btsx: { error: 'down' } }, raw: {} } : { outputs: { btsx: { code } }, raw: {} }; }) as Convert,
    });
    const store = new JobStore(dir, async () => { throw new Error('default converter must not run'); }, async () => 'source');
    const first = await finish(store, (await store.start(scan, ['btsx'], false, endpoint('remote', null))).id);
    assert.deepEqual(first.converter, { target: 'remote', url: 'http://remote.test/api/converter' });
    const done = await finish(store, (await store.retry(first.id, endpoint('local', 'p local'))).id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(used, ['remote', 'local']);
    assert.equal((await new JobStore(dir, async () => ({ outputs: {}, raw: null })).get(done.id)).converter?.target, 'local');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('accepts only loopback local converter URLs', () => {
  assert.equal(converterUrl('http://localhost:8787/api/converter', true), 'http://localhost:8787/api/converter');
  assert.equal(converterUrl('http://[::1]:8787/api/converter', true), 'http://[::1]:8787/api/converter');
  assert.equal(converterUrl('https://converter.test/api/converter'), 'https://converter.test/api/converter');
  for (const url of ['https://converter.test/api/converter', 'http://user:pw@localhost:8787/', 'file:///etc/passwd', 'nope']) {
    assert.throws(() => converterUrl(url, true));
  }
});

test('treats only JSON answers as the converter API when checking an endpoint', async () => {
  const api = await checkConverter('http://localhost:8787/api/converter', (async () => Response.json({ error: 'Use POST.' }, { status: 405 })) as Fetcher);
  assert.equal(api.ok, true);
  const page = await checkConverter('http://localhost:8080/api/converter', (async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })) as Fetcher);
  assert.equal(page.ok, false);
  assert.match(page.error ?? '', /text\/html \(HTTP 200\), not the converter API/);
  const down = await checkConverter('http://localhost:9/api/converter', (async () => { throw new TypeError('fetch failed'); }) as Fetcher);
  assert.deepEqual(down, { ok: false, error: 'Nothing is listening at this address.' });
});

test('reports outputs saved by earlier runs across folders and never converts them again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shai-existing-test-'));
  try {
    const formatsSent: string[][] = [];
    const store = new JobStore(dir, async (_code, formats) => {
      formatsSent.push(formats);
      return { outputs: { btsx: { code: 'p b' }, tsrx: { code: '<p>t</p>' } }, raw: {} };
    }, async () => 'source');
    assert.deepEqual(await store.existing(scan), {});
    await finish(store, (await store.start(selectFiles(scan, ['nested/a.tsx']), ['btsx'], true)).id);
    // The same file seen from the repository root, with a differently cased owner.
    const parent: Scan = { ...scan, owner: 'Org', folder: '', files: scan.files.map(file => ({ ...file, path: `ui/${file.path}` })) };
    assert.deepEqual(await store.existing(parent), { 'ui/nested/a.tsx': ['btsx'] });
    assert.deepEqual(await store.existing({ ...parent, ref: 'dev' }), {});
    await assert.rejects(store.start(selectFiles(parent, ['ui/nested/a.tsx']), ['btsx'], true), /already in the output folder/);
    const done = await finish(store, (await store.start(selectFiles(parent, ['ui/nested/a.tsx']), ['btsx', 'tsrx'], true)).id);
    assert.deepEqual(done.files.map(file => file.output), ['tsrx/ui/nested/a.tsrx']);
    assert.deepEqual(formatsSent, [['btsx'], ['tsrx']]);
    assert.deepEqual(await store.existing(scan), { 'nested/a.tsx': ['btsx', 'tsrx'] });
    // Outputs removed from disk no longer count.
    await rm(join(done.outputDir, 'tsrx'), { recursive: true });
    assert.deepEqual(await store.existing(scan), { 'nested/a.tsx': ['btsx'] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
