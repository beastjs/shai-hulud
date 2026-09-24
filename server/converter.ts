import { setTimeout as delay } from 'node:timers/promises';
import type { OutputFormat } from '../src/lib/types';
import { HttpError, type Fetcher } from './github';

export const defaultConverterUrl = 'https://playground.beastjs.workers.dev/api/converter';
// `wrangler dev` in the converter project serves the Worker's /api routes here.
export const defaultLocalConverterUrl = 'http://localhost:8787/api/converter';
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validates a converter endpoint. A local endpoint must be on this machine. */
export function converterUrl(value: unknown, local = false) {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new HttpError(400, 'Converter URL is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, 'Converter URL must use HTTP or HTTPS without credentials.');
  }
  if (local && !loopbackHosts.has(url.hostname)) throw new HttpError(400, 'A local converter must run on localhost, 127.0.0.1 or [::1].');
  return url.href;
}

/** The endpoint without its query string, for display and manifests. */
export function publicUrl(value: string) {
  const url = new URL(value);
  return url.origin + url.pathname;
}

/**
 * The converter answers GET with a 405 JSON error, while web pages and UI dev
 * servers answer with HTML, so only a JSON response counts as the API.
 */
export async function checkConverter(url: string, fetcher: Fetcher = fetch): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const started = performance.now();
  try {
    const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    await response.body?.cancel();
    const latencyMs = Math.round(performance.now() - started);
    const type = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (type.includes('json')) return { ok: true, latencyMs };
    return { ok: false, latencyMs, error: `Answered with ${type || 'a non-JSON response'} (HTTP ${response.status}), not the converter API.` };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, error: timedOut ? 'No response within 4 seconds.' : 'Nothing is listening at this address.' };
  }
}
export interface ConversionResult {
  outputs: Partial<Record<OutputFormat, { code?: string; error?: string; warning?: string }>>;
  raw: unknown;
}
export class ConversionError extends Error {
  constructor(message: string, public response: unknown) { super(message); }
}

type Pause = (milliseconds: number, signal: AbortSignal) => Promise<void>;
const pause: Pause = async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); };

export function createConverter(url: string, fetcher: Fetcher = fetch, wait: Pause = pause) {
  return async (code: string, formats: OutputFormat[], signal: AbortSignal): Promise<ConversionResult> => {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, outputs: formats }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      });
      if (![429, 502, 503, 504].includes(response.status) || attempt === 2) break;
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
      const dateDelay = retryAfter && !seconds ? Date.parse(retryAfter) - Date.now() : 0;
      const backoff = Math.min(30_000, Math.max(seconds * 1000, Number.isFinite(dateDelay) ? dateDelay : 0, 1000 * 2 ** attempt));
      await response.body?.cancel();
      await wait(backoff, signal);
    }
    const text = await response!.text();
    let data: any;
    try { data = JSON.parse(text); }
    catch {
      const message = text.includes('Worker exceeded resource limits')
        ? 'Converter Worker exceeded its resource limits (HTTP 503). See the saved response; the converter may need more resources.'
        : `Converter returned a non-JSON response (${response!.status}).`;
      throw new ConversionError(message, { status: response!.status, body: text });
    }
    if (!response!.ok) {
      throw new ConversionError(`Converter: ${typeof data?.error === 'string' ? data.error.slice(0, 1000) : `request failed (${response!.status})`}`, data);
    }
    // The API can return ok:false alongside useful code when validation fails.
    const outputs: ConversionResult['outputs'] = {};
    for (const format of formats) {
      const output = data?.outputs?.[format];
      if (typeof output?.code !== 'string') {
        outputs[format] = { error: typeof data?.error === 'string' ? data.error.slice(0, 1000) : `Converter response has no outputs.${format}.code string.` };
        continue;
      }
      const compilation = data?.compilation?.[format === 'btsx' ? 'beast' : 'octane'];
      const warnings: string[] = [];
      if (compilation?.ok === false) warnings.push('Converter reported a compilation error. Review the saved JSON response.');
      else if (data?.ok === false) warnings.push('Converter returned code with validation warnings. Review the saved JSON response.');
      if (Array.isArray(output.diagnostics) && output.diagnostics.length) warnings.push(`${output.diagnostics.length} converter diagnostic(s); see saved JSON.`);
      outputs[format] = { code: output.code, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
    }
    return { outputs, raw: data };
  };
}
