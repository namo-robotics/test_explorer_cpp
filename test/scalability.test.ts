/** Exercise discovery and repeated batch and case runs of a large real Google Test binary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discover } from '../src/discovery';
import { runProcess, Scheduler } from '../src/process';
import { runExecutable } from '../src/runner';
import { hostEnvironment } from '../src/environment';
import { settings } from './helpers';

test(
  'one executable discovers and repeatedly runs 1000 randomized workloads in batch and case modes',
  { timeout: 60000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-explorer-scale-'));
    try {
      for (const args of [
        ['-S', path.resolve('test/fixtures/scalability'), '-B', path.join(root, 'build')],
        ['--build', path.join(root, 'build'), '-j2'],
      ]) {
        const result = await runProcess('cmake', args, {
          cwd: root,
          env: hostEnvironment(),
          timeout: 30,
        });
        assert.equal(result.code, 0, result.stderr || result.stdout);
      }
      const scheduler = new Scheduler(4);
      const config = settings({ parallelMode: 'batch', concurrency: 4 });
      const start = performance.now();
      const discovery = await discover(root, config, scheduler);
      t.diagnostic(`Discovery: ${(performance.now() - start).toFixed(1)} ms`);
      assert.deepEqual(discovery.diagnostics, []);
      assert.equal(discovery.executables.length, 1);
      const executable = discovery.executables[0];
      assert.equal(executable.cases.length, 1000);
      const names = new Set(executable.cases.map((test) => test.name));
      assert.equal(names.size, 1000);
      assert(executable.cases.every((test) => test.source));
      const workloads = new Map<string, string>();
      for (const mode of ['batch', 'case'] as const) {
        for (let iteration = 0; iteration < 3; iteration++) {
          const started = new Set<string>();
          const finished = new Set<string>();
          const output = new Map<string, string[]>();
          let launches = 0;
          let callbacks = 0;
          const start = performance.now();
          await runExecutable(
            executable,
            executable.cases,
            { ...config, parallelMode: mode },
            scheduler,
            {
              started: (test) => {
                assert(!started.has(test.name), 'Start each case once');
                started.add(test.name);
              },
              result: (result) => {
                assert(started.has(result.name));
                assert(!finished.has(result.name), 'Report each result once');
                assert.equal(result.state, 'passed', result.message);
                finished.add(result.name);
              },
              output: (text, name) => {
                callbacks++;
                if (text.startsWith(`Running ${executable.path} (`)) launches++;
                if (name) {
                  assert(names.has(name), `Unknown output owner: ${name}`);
                  const chunks = output.get(name) ?? [];
                  chunks.push(text);
                  output.set(name, chunks);
                }
              },
            },
            new AbortController().signal,
          );
          t.diagnostic(
            `Mode ${mode}, run ${iteration + 1}: ${(performance.now() - start).toFixed(1)} ms, ${callbacks} output callbacks`,
          );
          assert.equal(launches, mode === 'case' ? names.size : scheduler.concurrency);
          assert.deepEqual(started, names);
          assert.deepEqual(finished, names);
          for (const name of names) {
            const parameter = Number(name.slice(name.lastIndexOf('/') + 1));
            const text = output.get(name)!.join('');
            const workload =
              /^workload seed=\d+ wait_ms=\d+ iterations=\d+ lines=(\d+) checksum=\d+$/m.exec(text);
            assert(workload, 'Each case reports its reproducible workload');
            if (workloads.has(name)) assert.equal(workload[0], workloads.get(name));
            workloads.set(name, workload[0]);
            const lines = text.split('\n').filter((line) => line.startsWith('case '));
            assert.deepEqual(
              lines,
              Array.from(
                { length: Number(workload[1]) },
                (_, line) => `case ${parameter} output ${line}`,
              ),
            );
          }
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
