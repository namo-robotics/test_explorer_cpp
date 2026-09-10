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

test('streaming without capture preserves all output from a verbose process', async () => {
  const streamed = { stdout: '', stderr: '' };
  const repetitions = 1000;
  const line = 'Verbose test output '.repeat(50) + '\n';
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      `
      const line = ${JSON.stringify(line)};
      for (let i = 0; i < ${repetitions}; i++) {
        process.stdout.write(line);
        process.stderr.write(line);
      }
    `,
    ],
    {
      cwd: process.cwd(),
      env: hostEnvironment(),
      maxOutput: 0,
      onOutput: (text, stream) => {
        streamed[stream] += text;
      },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.truncated, true);
  assert.equal(streamed.stdout, line.repeat(repetitions));
  assert.equal(streamed.stderr, line.repeat(repetitions));
});

test('bounded capture retains the tail while streaming complete output', async () => {
  const streamed = { stdout: '', stderr: '' };
  const result = await runProcess(
    process.execPath,
    ['-e', "process.stdout.write('abcdefgh'); process.stderr.write('12345678')"],
    {
      cwd: process.cwd(),
      env: hostEnvironment(),
      maxOutput: 4,
      onOutput: (text, stream) => {
        streamed[stream] += text;
      },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'efgh');
  assert.equal(result.stderr, '5678');
  assert.equal(result.truncated, true);
  assert.deepEqual(streamed, { stdout: 'abcdefgh', stderr: '12345678' });
});

for (const limit of [31, 65537, 4 * 1024 * 1024]) {
  test(`capture preserves Unicode output and trims chunk boundaries at limit ${limit}`, async () => {
    const chunks: Record<'stdout' | 'stderr', string[]> = { stdout: [], stderr: [] };
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        `
      const { once } = require('node:events');
      (async () => {
        for (let i = 0; i < 128; i++) {
          const text = i + ':α🙂'.repeat(2048) + '\\n';
          for (const stream of [process.stdout, process.stderr]) {
            if (!stream.write(text)) await once(stream, 'drain');
          }
        }
      })();
    `,
      ],
      {
        cwd: process.cwd(),
        env: hostEnvironment(),
        maxOutput: limit,
        timeout: 10,
        onOutput: (text, stream) => chunks[stream].push(text),
      },
    );
    const expected = Array.from({ length: 128 }, (_, i) => i + ':α🙂'.repeat(2048) + '\n').join('');
    assert.equal(result.code, 0);
    assert.equal(result.truncated, expected.length > limit);
    for (const stream of ['stdout', 'stderr'] as const) {
      assert.equal(chunks[stream].join(''), expected);
      assert.equal(result[stream], expected.slice(-limit));
    }
  });
}

test('an empty process does not mark captured output as truncated', async () => {
  const result = await runProcess(process.execPath, ['-e', ''], {
    cwd: process.cwd(),
    env: hostEnvironment(),
    maxOutput: 0,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.truncated, false);
});
