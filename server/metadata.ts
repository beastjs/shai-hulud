import type { CodeMetrics, CompilationResult, ConversionMetadata, OutputFormat } from '../src/lib/types';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metrics(value: unknown): CodeMetrics {
  const source = record(value);
  const result: CodeMetrics = {};
  for (const key of ['chars', 'lines', 'tokens'] as const) {
    const count = source[key];
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) result[key] = count;
  }
  return result;
}

function compilation(value: unknown): CompilationResult {
  const source = record(value);
  return { ok: typeof source.ok === 'boolean' ? source.ok : null, error: typeof source.error === 'string' ? source.error : null };
}

export function extractMetadata(value: unknown, format: OutputFormat): ConversionMetadata {
  const source = record(value);
  const results = record(source.compilation);
  return {
    input: metrics(record(source.input).metrics),
    output: metrics(record(record(source.outputs)[format]).metrics),
    octane: compilation(results.octane),
    beast: compilation(results.beast),
  };
}

export function responseCode(value: unknown, format: OutputFormat): unknown {
  return record(record(record(value).outputs)[format]).code;
}
