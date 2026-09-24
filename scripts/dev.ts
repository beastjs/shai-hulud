import { spawn } from 'node:child_process';

const children = [
  spawn('bun', ['--watch', 'server/index.ts'], { stdio: 'inherit' }),
  spawn('bun', ['run', 'dev:ui'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 0));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
