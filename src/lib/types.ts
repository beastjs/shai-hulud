export type OutputFormat = 'btsx' | 'tsrx';

export interface SourceFile {
  path: string;
  sha: string;
  size: number;
  kind: 'tsx' | 'ts';
}

export interface Scan {
  id: string;
  url: string;
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  folder: string;
  files: SourceFile[];
}

export interface JobFile {
  path: string;
  format: OutputFormat;
  output: string;
  status: 'pending' | 'running' | 'saved' | 'failed' | 'cancelled';
  error?: string;
  warning?: string;
  metadata?: ConversionMetadata;
}

export interface CodeMetrics {
  chars?: number;
  lines?: number;
  tokens?: number;
}

export interface CompilationResult {
  ok: boolean | null;
  error: string | null;
}

export interface ConversionMetadata {
  input: CodeMetrics;
  output: CodeMetrics;
  octane: CompilationResult;
  beast: CompilationResult;
}

export interface Job {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  createdAt: string;
  outputDir: string;
  source: Omit<Scan, 'files'>;
  files: JobFile[];
  error?: string;
}

export interface AppConfig {
  converterConfigured: boolean;
  converterUrl: string | null;
  outputRoot: string;
}
