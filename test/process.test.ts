/** Verify cancellation of processes whose descendants retain output pipes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, Scheduler } from '../src/process';
import { hostEnvironment } from '../src/environment';

test('cancellation finishes even when a detached descendant holds the output pipes', async () => {
  const abort = new AbortController();
  let descendant: number | undefined;
  let cancelledAt = 0;
  let output = '';
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {
      detached: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    console.log('READY ' + child.pid);
    setInterval(() => {}, 1000);
  `;
  try {
    const result = await runProcess(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: hostEnvironment(),
      signal: abort.signal,
      timeout: 10,
      onOutput(text) {
        output += text;
        const ready = /READY (\d+)/.exec(output);
        if (ready && !descendant) {
          descendant = Number(ready[1]);
          cancelledAt = Date.now();
          abort.abort();
        }
      },
    });
    assert(descendant, 'The descendant must start before cancellation');
    assert.equal(result.cancelled, true);
    assert(
      Date.now() - cancelledAt < 3000,
      'Cancellation must not wait for inherited output pipes',
    );
  } finally {
    if (descendant) {
      try {
        process.kill(-descendant, 'SIGKILL');
      } catch {}
    }
  }
});

test('cancelling a large queue preserves unrelated jobs and releases the queue', async () => {
  const scheduler = new Scheduler(1);
  let release!: () => void;
  const active = scheduler.schedule(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const abort = new AbortController();
  let started = 0;
  const queued = Array.from({ length: 1000 }, () =>
    scheduler.schedule(async () => {
      started++;
    }, abort.signal),
  );
  const settled = Promise.allSettled(queued);
  const unrelated = scheduler.schedule(async () => 'finished');
  abort.abort();
  const results = await settled;
  assert(results.every((result) => result.status === 'rejected'));
  assert.equal(started, 0);
  release();
  await active;
  assert.equal(await unrelated, 'finished');
});
