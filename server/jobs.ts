import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Job, OutputFormat, Scan, SourceFile } from '../src/lib/types';
import { HttpError, readSource } from './github';
import { ConversionError, type ConversionResult } from './converter';
import { extractMetadata, responseCode } from './metadata';

export type Convert = (code: string, formats: OutputFormat[], signal: AbortSignal) => Promise<ConversionResult>;
export function selectFiles(scan: Scan, paths: unknown): Scan {
  if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string')) {
    throw new HttpError(400, 'Select at least one repository file.');
  }
  const selected = new Set(paths as string[]);
  const available = new Set(scan.files.map(file => file.path));
  if ([...selected].some(path => !available.has(path))) throw new HttpError(400, 'Selected files must belong to the inspected repository folder.');
  return { ...scan, files: scan.files.filter(file => selected.has(file.path)) };
}

export function safePath(root: string, path: string) {
  if (!path || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new HttpError(400, 'Invalid file path.');
  }
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new HttpError(400, 'Invalid file path.');
  return target;
}

export class JobStore {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  constructor(
    public outputRoot: string,
    private convert: Convert,
    private sourceReader: (scan: Scan, file: SourceFile, signal?: AbortSignal) => Promise<string> = readSource,
  ) {}

  async start(scan: Scan, formats: OutputFormat[], includeTs: boolean) {
    if (this.controllers.size) throw new HttpError(409, 'A conversion is already running. Wait for it to finish or cancel it.');
    if (!formats.length || formats.some(format => !['btsx', 'tsrx'].includes(format))) throw new HttpError(400, 'Select at least one output format.');
    const id = randomUUID();
    const { files: sources, ...source } = scan;
    const job: Job = {
      id, status: 'running', createdAt: new Date().toISOString(), source,
      outputDir: resolve(this.outputRoot, id),
      files: sources.filter(file => includeTs || file.kind === 'tsx').flatMap(file => [...new Set(formats)].map(format => ({
        path: file.path, format, output: `${format}/${file.kind === 'tsx' ? file.path.replace(/\.tsx$/, `.${format}`) : file.path}`,
        status: 'pending' as const,
      }))),
    };
    if (!job.files.length) throw new HttpError(400, 'No matching files to process.');
    // Validate all destinations before making a directory or sending source code.
    for (const file of job.files) safePath(job.outputDir, file.output);
    const destinations = job.files.map(file => file.output.toLocaleLowerCase());
    if (new Set(destinations).size !== destinations.length) throw new HttpError(400, 'Source paths collide on a case-insensitive filesystem. Choose a smaller folder.');
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.jobs.set(id, job);
    try { await this.persist(job); }
    catch (error) { this.controllers.delete(id); this.jobs.delete(id); throw error; }
    void this.run(job, scan, controller);
    return job;
  }

  private async persist(job: Job) {
    await mkdir(job.outputDir, { recursive: true });
    const manifest = resolve(job.outputDir, 'manifest.json');
    await writeFile(`${manifest}.tmp`, JSON.stringify(job, null, 2));
    await rename(`${manifest}.tmp`, manifest);
  }

  private async saveResponse(job: Job, path: string, data: unknown) {
    const responsePath = safePath(job.outputDir, `responses/${path}.json`);
    await mkdir(resolve(responsePath, '..'), { recursive: true });
    let previous: string | undefined;
    try { previous = await readFile(responsePath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous !== undefined) {
      const history = safePath(job.outputDir, `responses/${path}.history/${randomUUID()}.json`);
      await mkdir(resolve(history, '..'), { recursive: true });
      await writeFile(history, previous, 'utf8');
    }
    await writeFile(`${responsePath}.tmp`, JSON.stringify(data, null, 2), 'utf8');
    await rename(`${responsePath}.tmp`, responsePath);
  }

  private async run(job: Job, scan: Scan, controller: AbortController) {
    const { signal } = controller;
    let cachedPath = '';
    let cachedSource = '';
    let cachedResult: ConversionResult | undefined;
    let cachedError: unknown;
    try {
      for (const file of job.files) {
        if (signal.aborted) break;
        if (file.status !== 'pending') continue;
        file.status = 'running';
        try {
          if (cachedPath !== file.path) {
            cachedPath = file.path;
            cachedResult = undefined;
            cachedError = undefined;
            try {
              cachedSource = await this.sourceReader(scan, scan.files.find(source => source.path === file.path)!, signal);
              if (file.path.endsWith('.tsx')) {
                cachedResult = await this.convert(cachedSource, job.files.filter(item => item.path === file.path && ['pending', 'running'].includes(item.status)).map(item => item.format), signal);
                signal.throwIfAborted();
                await this.saveResponse(job, file.path, cachedResult.raw);
              }
            } catch (error) {
              cachedError = error;
              if (error instanceof ConversionError) await this.saveResponse(job, file.path, error.response);
            }
          }
          if (cachedError) throw cachedError;
          const converted = cachedResult?.outputs[file.format];
          if (cachedResult) file.metadata = extractMetadata(cachedResult.raw, file.format);
          if (file.path.endsWith('.tsx') && typeof converted?.code !== 'string') throw new Error(converted?.error ?? 'Missing converter output.');
          const result = file.path.endsWith('.tsx') ? converted!.code! : cachedSource;
          file.warning = converted?.warning;
          signal.throwIfAborted();
          const destination = safePath(job.outputDir, file.output);
          await mkdir(resolve(destination, '..'), { recursive: true });
          await writeFile(`${destination}.tmp`, result, 'utf8');
          await rename(`${destination}.tmp`, destination);
          file.status = 'saved';
        } catch (error) {
          file.status = signal.aborted ? 'cancelled' : 'failed';
          if (!signal.aborted) file.error = error instanceof Error ? error.message : 'Conversion failed.';
        }
        await this.persist(job);
      }
      for (const file of job.files) if (file.status === 'pending') file.status = 'cancelled';
      job.status = signal.aborted ? 'cancelled' : job.files.some(file => file.status === 'failed') ? 'failed' : 'completed';
      await this.persist(job);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Could not save the job.';
      for (const file of job.files) if (file.status === 'pending' || file.status === 'running') file.status = 'failed';
      await this.persist(job).catch(() => {});
    } finally { this.controllers.delete(job.id); }
  }

  async get(id: string): Promise<Job> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Job not found.');
    const active = this.jobs.get(id);
    if (active) return active;
    try {
      const job: Job = JSON.parse(await readFile(resolve(this.outputRoot, id, 'manifest.json'), 'utf8'));
      job.outputDir = resolve(this.outputRoot, id);
      if (job.status === 'running') {
        job.status = 'failed';
        job.error = 'The local server stopped before this run finished. Start a new run to try again.';
        for (const file of job.files) if (file.status === 'pending' || file.status === 'running') file.status = 'failed';
      }
      // Older runs keep metrics in their raw responses. Only attribute them to
      // saved files when the response's code matches the actual saved output.
      const responses = new Map<string, Promise<unknown>>();
      await Promise.all(job.files.map(async file => {
        if (file.metadata || !file.path.endsWith('.tsx') || !['saved', 'failed'].includes(file.status)) return;
        try {
          if (!responses.has(file.path)) responses.set(file.path, readFile(safePath(job.outputDir, `responses/${file.path}.json`), 'utf8').then(JSON.parse));
          const raw = await responses.get(file.path);
          if (file.status === 'saved' && responseCode(raw, file.format) !== await readFile(safePath(job.outputDir, file.output), 'utf8')) return;
          file.metadata = extractMetadata(raw, file.format);
        } catch { /* Missing or unreadable legacy metadata is shown as unavailable. */ }
      }));
      return job;
    } catch { throw new HttpError(404, 'Job not found.'); }
  }

  cancel(id: string) { this.controllers.get(id)?.abort(); }

  async retry(id: string) {
    if (this.controllers.size) throw new HttpError(409, 'A conversion is already running.');
    const job = await this.get(id);
    if (!job.files.some(file => file.status === 'failed' || file.status === 'cancelled')) throw new HttpError(400, 'No failed or cancelled files to retry.');
    const controller = new AbortController();
    // Recheck after the asynchronous disk read, before reserving the runner.
    if (this.controllers.size) throw new HttpError(409, 'A conversion is already running.');
    this.controllers.set(id, controller);
    for (const file of job.files) {
      if (file.status === 'failed' || file.status === 'cancelled') {
        file.status = 'pending'; delete file.error; delete file.warning; delete file.metadata;
      }
    }
    job.status = 'running'; delete job.error;
    this.jobs.set(id, job);
    try { await this.persist(job); }
    catch (error) { this.controllers.delete(id); job.status = 'failed'; throw error; }
    const sources: SourceFile[] = [...new Set(job.files.map(file => file.path))].map(path => ({
      path, sha: '', size: 0, kind: path.endsWith('.tsx') ? 'tsx' : 'ts',
    }));
    void this.run(job, { ...job.source, files: sources }, controller);
    return job;
  }

  async output(id: string, path: string) {
    const job = await this.get(id);
    if (!job.files.some(file => file.output === path && file.status === 'saved')) throw new HttpError(404, 'Output is not available.');
    return readFile(safePath(job.outputDir, path), 'utf8');
  }
}
