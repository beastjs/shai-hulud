import { useEffect, useRef, useState } from 'octane';
import type { AppConfig, Job, OutputFormat, Scan } from './types';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data as T;
}
export const exampleUrl = 'https://github.com/keenthemes/reui/tree/main/registry/bases/base/ui';

export function useCrawler() {
  const [url, setUrl] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [formats, setFormats] = useState<OutputFormat[]>(['btsx']);
  const [includeTs, setIncludeTs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<{ path: string; code: string } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [outputPath, setOutputPath] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api<AppConfig>('/config').then(value => { if (alive) setConfig(value); }).catch(() => {
      if (alive) setError('Cannot reach the local server. Start the app with bun run dev.');
    });
    const id = localStorage.getItem('shai-hulud:last-job');
    if (id) api<Job>(`/jobs/${id}`).then(value => {
      if (alive) {
        setJob(value);
        setUrl(value.source.url);
        setFormats([...new Set(value.files.map(file => file.format))]);
        setIncludeTs(value.files.some(file => file.path.endsWith('.ts')));
      }
    }).catch(() => localStorage.removeItem('shai-hulud:last-job'));
    return () => { alive = false; };
  }, []);

  const jobId = job?.id;
  const running = job?.status === 'running';
  useEffect(() => {
    if (!jobId || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<Job>(`/jobs/${jobId}`);
        if (stopped) return;
        setJob(value); setError('');
        if (value.status === 'running') timer = setTimeout(poll, 800);
      } catch {
        if (!stopped) {
          setError('Connection interrupted. Reconnecting to the local server…');
          timer = setTimeout(poll, 2500);
        }
      }
    };
    timer = setTimeout(poll, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [jobId, running]);

  useEffect(() => {
    if (!outputPath || !jobId) { setPreview(null); return; }
    const controller = new AbortController();
    setPreviewLoading(true); setPreviewError(''); setPreview(null);
    fetch(`/api/jobs/${jobId}/output?path=${encodeURIComponent(outputPath)}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Could not load the saved file.'); return response.text(); })
      .then(code => { setPreview({ path: outputPath, code }); setPreviewLoading(false); })
      .catch(error => { if (!controller.signal.aborted) { setPreviewError(error.message); setPreviewLoading(false); } });
    return () => controller.abort();
  }, [jobId, outputPath]);

  async function crawl() {
    setBusy(true); setError(''); setScan(null); setPreview(null); setOutputPath('');
    try {
      const result = await api<Scan>('/scan', { url });
      setScan(result); setJob(null); setFilter('');
      setSelectedPaths(new Set(result.files.map(file => file.path)));
      localStorage.removeItem('shai-hulud:last-job');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not inspect this folder.'); }
    finally { setBusy(false); }
  }
  async function convert() {
    if (!scan || !selectedFiles.length) return;
    setBusy(true); setError(''); setPreview(null); setOutputPath('');
    try {
      const result = await api<Job>('/jobs', { scanId: scan.id, formats, includeTs, selectedPaths: selectedFiles.map(file => file.path) });
      setJob(result); localStorage.setItem('shai-hulud:last-job', result.id);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not start conversion.'); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!job) return;
    try { await api(`/jobs/${job.id}/cancel`, {}); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not cancel the run.'); }
  }
  async function retry() {
    if (!job) return;
    setBusy(true); setError('');
    try { setJob(await api<Job>(`/jobs/${job.id}/retry`, {})); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not retry the run.'); }
    finally { setBusy(false); }
  }
  async function copyCode() {
    if (!preview) return;
    try { await navigator.clipboard.writeText(preview.code); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { setPreviewError('Clipboard unavailable. Select the code or download the file.'); }
  }
  function toggleFormat(format: OutputFormat) {
    setFormats(current => current.includes(format) ? current.filter(value => value !== format) : [...current, format]);
  }
  const files = scan?.files ?? [];
  const eligibleFiles = files.filter(file => includeTs || file.kind === 'tsx');
  const selectedFiles = eligibleFiles.filter(file => selectedPaths.has(file.path));
  const allSelected = eligibleFiles.length > 0 && selectedFiles.length === eligibleFiles.length;
  const partiallySelected = selectedFiles.length > 0 && !allSelected;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = partiallySelected;
  }, [partiallySelected, scan, job]);
  function toggleFile(path: string) {
    setSelectedPaths(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }
  function toggleAll() {
    setSelectedPaths(current => {
      const next = new Set(current);
      for (const file of eligibleFiles) {
        if (allSelected) next.delete(file.path); else next.add(file.path);
      }
      return next;
    });
  }
  function chooseFiles() { setJob(null); setPreview(null); setOutputPath(''); }
  const saved = job?.files.filter(file => file.status === 'saved').length ?? 0;
  const failed = job?.files.filter(file => file.status === 'failed').length ?? 0;
  const finished = job?.files.filter(file => !['running', 'pending'].includes(file.status)).length ?? 0;
  const rows = job ? job.files.map(file => ({ ...file, kind: file.path.endsWith('.tsx') ? 'tsx' : 'ts' })) : files.map(file => ({
    ...file, output: file.path, format: '' as const, status: 'ready' as const, error: undefined, metadata: undefined,
  }));
  return {
    url, setUrl: (value: string) => { setUrl(value); setScan(null); }, scan, source: scan ?? job?.source,
    job, config, formats, includeTs, setIncludeTs, busy, error, filter, setFilter,
    preview, previewError, previewLoading, outputPath, setOutputPath, copied, running,
    crawl, convert, cancel, retry, copyCode, toggleFormat, saved, failed, finished,
    selectedPaths, selectedCount: selectedFiles.length, eligibleCount: eligibleFiles.length,
    allSelected, selectAllRef, toggleFile, toggleAll, chooseFiles,
    rows: rows.filter(file => file.path.toLowerCase().includes(filter.toLowerCase())),
    tsxCount: files.filter(file => file.kind === 'tsx').length,
    tsCount: files.filter(file => file.kind === 'ts').length,
  };
}
