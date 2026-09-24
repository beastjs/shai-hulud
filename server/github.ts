import { randomUUID } from 'node:crypto';
import type { Scan, SourceFile } from '../src/lib/types';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type TreeEntry = { path: string; sha: string; type: string; mode: string; size?: number };
type Tree = { tree: TreeEntry[]; truncated: boolean };
type Commit = { sha: string; commit: { tree: { sha: string } } };
export type Fetcher = typeof fetch;

export function parseGitHubUrl(input: string) {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new HttpError(400, 'Paste a full https://github.com repository or folder URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) {
    throw new HttpError(400, 'Only public https://github.com links are supported.');
  }
  let parts: string[];
  try { parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent); }
  catch { throw new HttpError(400, 'The URL contains invalid encoding.'); }
  const [owner, rawRepo, action, ...tail] = parts;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) ||
      (action && (action !== 'tree' || tail.length === 0)) ||
      parts.some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) {
    throw new HttpError(400, 'Use a repository URL or a /tree/branch/folder URL.');
  }
  return { owner, repo, tail, url: url.href };
}

export function githubClient(fetcher: Fetcher = fetch) {
  return async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetcher(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'shai-hulud-local-crawler',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new HttpError(429, 'GitHub rate limit or access restriction. Try later, or set GITHUB_TOKEN in .env for a higher limit.');
      }
      throw new HttpError(response.status, `GitHub returned ${response.status}. Check that the repository, branch, and folder are public and exist.`);
    }
    return response.json() as Promise<T>;
  };
}

export async function scanRepository(input: string, fetcher: Fetcher = fetch): Promise<Scan> {
  const parsed = parseGitHubUrl(input);
  const { owner, repo, tail } = parsed;
  const request = githubClient(fetcher);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const metadata = await request<{ private: boolean; default_branch: string }>(base);
  if (metadata.private) throw new HttpError(400, 'This crawler only accepts public repositories.');
  let ref = metadata.default_branch;
  let folder = '';
  let commit: Commit | undefined;
  // Resolve the longest valid ref so branches containing slashes work too.
  for (let length = tail.length; length > 0; length--) {
    const candidate = tail.slice(0, length).join('/');
    try {
      commit = await request<Commit>(`${base}/commits/${encodeURIComponent(candidate)}`);
      ref = candidate;
      folder = tail.slice(length).join('/');
      break;
    } catch (error) {
      if (!(error instanceof HttpError) || ![404, 422].includes(error.status)) throw error;
    }
  }
  if (!commit && tail.length) throw new HttpError(404, 'The branch or tag in this link could not be found.');
  commit ??= await request<Commit>(`${base}/commits/${encodeURIComponent(ref)}`);
  let treeSha = commit.commit.tree.sha;
  for (const segment of folder.split('/').filter(Boolean)) {
    const tree = await request<Tree>(`${base}/git/trees/${treeSha}`);
    if (tree.truncated) throw new HttpError(422, 'GitHub returned an incomplete folder listing. Choose a smaller folder.');
    const child = tree.tree.find(entry => entry.path === segment && entry.type === 'tree');
    if (!child) throw new HttpError(404, `Folder not found: ${folder}`);
    treeSha = child.sha;
  }
  const files: SourceFile[] = [];
  function collect(entries: TreeEntry[], prefix: string) {
    for (const entry of entries) {
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !/\.tsx?$/.test(entry.path)) continue;
      files.push({ path: prefix + entry.path, sha: entry.sha, size: entry.size ?? 0, kind: entry.path.endsWith('.tsx') ? 'tsx' : 'ts' });
    }
  }
  const recursive = await request<Tree>(`${base}/git/trees/${treeSha}?recursive=1`);
  if (!recursive.truncated) collect(recursive.tree, '');
  else {
    const queue = [{ sha: treeSha, prefix: '' }];
    while (queue.length) {
      const next = queue.shift()!;
      const tree = await request<Tree>(`${base}/git/trees/${next.sha}`);
      if (tree.truncated) throw new HttpError(422, 'GitHub returned an incomplete listing. Choose a smaller folder.');
      collect(tree.tree, next.prefix);
      for (const entry of tree.tree) if (entry.type === 'tree') queue.push({ sha: entry.sha, prefix: next.prefix + entry.path + '/' });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { id: randomUUID(), url: parsed.url, owner, repo, ref, commit: commit.sha, folder, files };
}

export async function readSource(scan: Scan, file: SourceFile, signal?: AbortSignal, fetcher: Fetcher = fetch) {
  if (file.size > 2_000_000) throw new Error('File exceeds the 2 MB source limit.');
  // Raw content at the resolved commit avoids one REST request per source file.
  const path = [scan.owner, scan.repo, scan.commit, ...[scan.folder, file.path].filter(Boolean).join('/').split('/')].map(encodeURIComponent).join('/');
  const response = await fetcher(`https://raw.githubusercontent.com/${path}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not read source (${response.status}).`);
  const source = await response.text();
  if (Buffer.byteLength(source) > 2_000_000) throw new Error('File exceeds the 2 MB source limit.');
  return source;
}
