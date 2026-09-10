/** Schedule selected Google Tests and report their output and results. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OutputRouter, parseResults, testArgs, testEnvironment } from './gtest';
import { runProcess, Scheduler } from './process';
import type { ProcessResult } from './process';
import type { CaseResult, Executable, Settings, TestCase } from './types';

/** Callbacks for test state changes and streamed process output. */
export interface RunEvents {
  started: (test: TestCase) => void;
  result: (result: CaseResult) => void;
  output: (text: string, testName?: string) => void;
}
/** Read requested outcomes and treat absent results as errors. */
export async function readResults(
  file: string,
  names: string[],
  processError?: string,
): Promise<CaseResult[]> {
  let results: Map<string, CaseResult>;
  try {
    results = parseResults(await fs.readFile(file, 'utf8'));
  } catch (e) {
    return names.map((name) => ({
      name,
      state: 'errored',
      message: processError ?? `No usable Google Test results: ${String(e)}`,
    }));
  }
  const hasFailure = names.some((name) => results.get(name)?.state === 'failed');
  return names.map((name) => {
    const result = results.get(name);
    if (!result) {
      return {
        name,
        state: 'errored',
        message:
          processError ?? 'Selected test is missing from Google Test results; refresh discovery.',
      };
    }
    if (processError && result.state !== 'failed' && !hasFailure) {
      return { ...result, state: 'errored', message: processError };
    }
    return result;
  });
}
/** Split a selection into process-sized batches for the chosen execution mode. */
export function batches(
  cases: TestCase[],
  mode: Settings['parallelMode'],
  batchSize = 25,
): TestCase[][] {
  if (mode === 'case') {
    return cases.map((test) => [test]);
  }
  if (mode === 'batch' && (!Number.isInteger(batchSize) || batchSize < 1)) {
    throw new Error('batchSize must be a positive integer');
  }
  const maxCases = mode === 'batch' ? batchSize : Infinity;
  // Avoid ARG_MAX limits in very large binaries while keeping normal runs in one process.
  const result: TestCase[][] = [];
  let batch: TestCase[] = [];
  let length = 0;
  for (const test of cases) {
    if (batch.length && (length + test.name.length > 32000 || batch.length >= maxCases)) {
      result.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(test);
    length += test.name.length + 1;
  }
  if (batch.length) {
    result.push(batch);
  }
  return result;
}
/** Run selected cases through the shared queue and report every outcome. */
export async function runExecutable(
  executable: Executable,
  cases: TestCase[],
  settings: Settings,
  scheduler: Scheduler,
  events: RunEvents,
  signal: AbortSignal,
): Promise<void> {
  const runnable = cases.filter((test) => {
    if ((test.disabled || executable.disabled) && !settings.runDisabled) {
      events.result({ name: test.name, state: 'skipped' });
      return false;
    }
    return true;
  });
  const jobs = batches(runnable, settings.parallelMode, settings.batchSize).map(async (batch) => {
    try {
      await scheduler.schedule(async () => {
        await runBatch(executable, batch, settings, events, signal);
      }, signal);
    } catch (e) {
      batch.forEach((test) =>
        events.result({
          name: test.name,
          state: signal.aborted ? 'skipped' : 'errored',
          message: String(e),
        }),
      );
    }
  });
  await Promise.all(jobs);
}

/** Execute one batch and remove its temporary result files when finished. */
async function runBatch(
  executable: Executable,
  batch: TestCase[],
  settings: Settings,
  events: RunEvents,
  signal: AbortSignal,
): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-test-explorer-'));
  const file = path.join(directory, 'results.xml');
  const router = new OutputRouter(events.output);
  try {
    batch.forEach(events.started);
    events.output(
      `Running ${executable.path} (${batch.length} case${batch.length === 1 ? '' : 's'})\n`,
    );
    const result = await runProcess(
      executable.path,
      testArgs(
        executable.args,
        batch.map((t) => t.name),
        file,
        settings.runDisabled,
      ),
      {
        cwd: executable.cwd,
        env: testEnvironment(executable.env),
        signal,
        timeout: executable.timeout,
        onOutput: (text, stream) => router.write(text, stream),
      },
    );
    router.end();
    const error = processError(result, executable.timeout);
    const results = await readResults(
      file,
      batch.map((t) => t.name),
      error,
    );
    // A signal/timeout is a process failure even if partial XML contains other failed cases.
    const interrupted = result.cancelled || result.timedOut || result.signal;
    for (const outcome of results) {
      if (error && interrupted && outcome.state === 'passed') {
        events.result({ ...outcome, state: 'errored', message: error });
      } else {
        events.result(outcome);
      }
    }
  } finally {
    router.end();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Describe an unsuccessful process termination for missing or partial test results. */
function processError(result: ProcessResult, timeout: number): string | undefined {
  if (result.cancelled) {
    return 'Test run cancelled';
  }
  if (result.timedOut) {
    return `Test process timed out after ${timeout}s`;
  }
  if (result.signal) {
    return `Test process terminated by ${result.signal}`;
  }
  if (result.code !== 0) {
    return `Test process exited with code ${result.code}`;
  }
  return undefined;
}
