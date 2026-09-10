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
  /** Maximum captured characters per stream; zero streams output without retaining it. */
  maxOutput?: number;
}
/** Captured output and termination details from an owned child process. */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  timedOut: boolean;
  truncated: boolean;
}
/** Retain an output tail without copying previously captured text on every chunk. */
class OutputTail {
  private chunks: string[] = [];
  private head = 0;
  private length = 0;
  /** Whether output has exceeded the capture limit. */
  truncated = false;

  /** Set the maximum number of retained characters. */
  constructor(private readonly limit: number) {}

  /** Append decoded text and release chunks outside the retained tail. */
  append(text: string): void {
    if (!text) return;
    this.truncated ||= this.length + text.length > this.limit;
    if (this.limit === 0) return;
    if (text.length >= this.limit) {
      this.chunks = [text.slice(-this.limit)];
      this.head = 0;
      this.length = this.limit;
      return;
    }
    this.chunks.push(text);
    this.length += text.length;
    while (this.length > this.limit) {
      const first = this.chunks[this.head];
      const excess = this.length - this.limit;
      if (first.length <= excess) {
        this.length -= first.length;
        this.chunks[this.head++] = '';
      } else {
        this.chunks[this.head] = first.slice(excess);
        this.length -= excess;
      }
    }
    if (this.head > this.chunks.length / 2) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  /** Join the retained chunks when the process finishes. */
  text(): string {
    return this.chunks.slice(this.head).join('');
  }
}
/** Run a program without a shell and terminate its process group when cancelled. */
export function runProcess(
  program: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new Error('Cancelled'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const limit = options.maxOutput ?? 8 * 1024 * 1024;
    const capture = { stdout: new OutputTail(limit), stderr: new OutputTail(limit) };
    let cancelled = false;
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
            child.kill(signal);
          }
        }
      }
    };
    const stop = () => {
      kill('SIGTERM');
      escalation ??= setTimeout(() => {
        kill('SIGKILL');
        // Detached descendants can retain these pipes after the test process exits.
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeout * 1000)
      : undefined;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const output = (text: string, stream: 'stdout' | 'stderr') => {
      options.onOutput?.(text, stream);
      capture[stream].append(text);
    };
    child.stdout.on('data', (data) => output(decoders.stdout.write(data), 'stdout'));
    child.stderr.on('data', (data) => output(decoders.stderr.write(data), 'stderr'));
    const cleanup = () => {
      clearTimeout(timer);
      // A descendant may outlive the parent after SIGTERM. Keep escalation armed.
      if (!cancelled && !timedOut) {
        clearTimeout(escalation);
      }
      escalation?.unref();
      options.signal?.removeEventListener('abort', abort);
    };
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code, signal) => {
      output(decoders.stdout.end(), 'stdout');
      output(decoders.stderr.end(), 'stderr');
      cleanup();
      resolve({
        stdout: capture.stdout.text(),
        stderr: capture.stderr.text(),
        code,
        signal,
        cancelled,
        timedOut,
        truncated: capture.stdout.truncated || capture.stderr.truncated,
      });
    });
    if (options.signal?.aborted) {
      abort();
    }
  });
}

interface Job {
  task: () => Promise<unknown>;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
}

/** Queued work sharing one cancellation listener. */
interface SignalJobs {
  jobs: Set<Job>;
  abort: () => void;
}
/** One scheduler is shared by discovery and every run, across workspace folders. */
export class Scheduler {
  private active = 0;
  private queue = new Set<Job>();
  private signals = new Map<AbortSignal, SignalJobs>();
  /** Create a queue with a shared process limit. */
  constructor(private limit: number) {}
  /** The shared process limit used when distributing tests into batches. */
  get concurrency(): number {
    return this.limit;
  }
  /** Change the limit for subsequent queued work. */
  setLimit(limit: number) {
    this.limit = Math.max(1, limit);
    this.pump();
  }
  /** Queue work and remove it promptly if cancelled before it starts. */
  schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Cancelled'));
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = { task, resolve, reject, signal };
      this.queue.add(job);
      this.watchCancellation(job);
      this.pump();
    });
  }
  /** Share a cancellation listener across all queued jobs in the same request. */
  private watchCancellation(job: Job): void {
    const signal = job.signal;
    if (!signal) return;
    let group = this.signals.get(signal);
    if (!group) {
      group = { jobs: new Set(), abort: () => this.cancelQueued(signal) };
      this.signals.set(signal, group);
      signal.addEventListener('abort', group.abort, { once: true });
    }
    group.jobs.add(job);
  }

  /** Remove cancelled work without repeatedly scanning and shifting the queue. */
  private cancelQueued(signal: AbortSignal): void {
    const group = this.signals.get(signal);
    if (!group) return;
    signal.removeEventListener('abort', group.abort);
    this.signals.delete(signal);
    for (const job of group.jobs) {
      this.queue.delete(job);
      job.reject(new Error('Cancelled'));
    }
  }

  /** Release queued cancellation tracking when a job starts. */
  private unwatchCancellation(job: Job): void {
    const signal = job.signal;
    if (!signal) return;
    const group = this.signals.get(signal);
    if (!group) return;
    group.jobs.delete(job);
    if (!group.jobs.size) {
      signal.removeEventListener('abort', group.abort);
      this.signals.delete(signal);
    }
  }

  private pump() {
    while (this.active < this.limit && this.queue.size) {
      const job = this.queue.values().next().value!;
      this.queue.delete(job);
      this.unwatchCancellation(job);
      this.active++;
      Promise.resolve()
        .then(() => {
          if (job.signal?.aborted) {
            throw new Error('Cancelled');
          }
          return job.task();
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
