/** Run cancellable child processes and share a bounded execution queue. */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Environment } from './types';

/** Execution options for an owned child process. */
export interface ProcessOptions {
  cwd: string;
  env: Environment;
  signal?: AbortSignal;
  timeout?: number;
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
  maxOutput?: number;
}
/** Captured output and termination details from an owned child process. */
export interface ProcessResult {
  stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null;
  cancelled: boolean; timedOut: boolean; truncated: boolean;
}
/** Run a program without a shell and terminate its process group when cancelled. */
export function runProcess(program: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new Error('Cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', cancelled = false, timedOut = false, truncated = false;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); } }
    };
    const stop = () => {
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 1000);
    };
    const abort = () => { cancelled = true; stop(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = options.timeout ? setTimeout(() => { timedOut = true; stop(); }, options.timeout * 1000) : undefined;
    const limit = options.maxOutput ?? 8 * 1024 * 1024;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const output = (text: string, stream: 'stdout' | 'stderr') => {
      options.onOutput?.(text, stream);
      if (stream === 'stdout') { truncated ||= stdout.length + text.length > limit; stdout = (stdout + text).slice(-limit); }
      else { truncated ||= stderr.length + text.length > limit; stderr = (stderr + text).slice(-limit); }
    };
    child.stdout.on('data', data => output(decoders.stdout.write(data), 'stdout'));
    child.stderr.on('data', data => output(decoders.stderr.write(data), 'stderr'));
    const cleanup = () => {
      clearTimeout(timer);
      // A descendant may outlive the parent after SIGTERM. Keep escalation armed.
      if (!cancelled && !timedOut) clearTimeout(escalation);
      escalation?.unref();
      options.signal?.removeEventListener('abort', abort);
    };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, signal) => {
      output(decoders.stdout.end(), 'stdout'); output(decoders.stderr.end(), 'stderr'); cleanup();
      resolve({ stdout, stderr, code, signal, cancelled, timedOut, truncated });
    });
    if (options.signal?.aborted) abort();
  });
}

interface Job { task: () => Promise<unknown>; resolve: (v: any) => void; reject: (e: Error) => void; signal?: AbortSignal; abort: () => void }
/** One scheduler is shared by discovery and every run, across workspace folders. */
export class Scheduler {
  private active = 0;
  private queue: Job[] = [];
  /** Create a queue with a shared process limit. */
  constructor(private limit: number) {}
  /** Change the limit for subsequent queued work. */
  setLimit(limit: number) { this.limit = Math.max(1, limit); this.pump(); }
  /** Queue work and remove it promptly if cancelled before it starts. */
  schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('Cancelled'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { task, resolve, reject, signal, abort: () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) { this.queue.splice(index, 1); reject(new Error('Cancelled')); }
      } };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.pump();
    });
  }
  private pump() {
    while (this.active < this.limit && this.queue.length) {
      const job = this.queue.shift()!;
      job.signal?.removeEventListener('abort', job.abort);
      this.active++;
      Promise.resolve().then(() => {
        if (job.signal?.aborted) throw new Error('Cancelled');
        return job.task();
      }).then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
    }
  }
}
