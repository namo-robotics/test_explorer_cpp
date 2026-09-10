/** Verify discovery and execution in a real colcon workspace. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discover } from '../../src/discovery';
import { hostEnvironment } from '../../src/environment';
import { runProcess, Scheduler } from '../../src/process';
import { runExecutable } from '../../src/runner';
import type { CaseResult } from '../../src/types';
import { settings } from '../helpers';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-explorer-colcon-'));
  try {
    await fs.cp(path.resolve('test/fixtures/ros2/src'), path.join(root, 'src'), {
      recursive: true,
    });
    const build = await runProcess(
      'colcon',
      [
        'build',
        '--base-paths',
        'src',
        '--cmake-args',
        '-DBUILD_TESTING=ON',
        '-DCMAKE_BUILD_TYPE=Debug',
      ],
      {
        cwd: root,
        env: hostEnvironment(),
        timeout: 180,
        onOutput: (text) => process.stdout.write(text),
      },
    );
    assert.equal(
      build.code,
      0,
      'Source a ROS 2 environment with ament_cmake_gtest before running this test',
    );
    for (const hidden of ['hidden_package', 'another_hidden_package']) {
      await assert.rejects(
        fs.access(path.join(root, 'build', hidden)),
        `${hidden} must not be built`,
      );
    }
    const scheduler = new Scheduler(2);
    const config = settings({ autoSourceWorkspace: true });
    const all = await discover(root, config, scheduler);
    assert.deepEqual(all.diagnostics, []);
    assert.deepEqual(all.executables.map((e) => e.group).sort(), [
      'ignored_sensor',
      'robot_geometry',
      'robot_math',
    ]);
    assert.equal(
      all.executables.reduce((n, e) => n + e.cases.length, 0),
      6,
    );
    const excluded = await discover(
      root,
      settings({
        autoSourceWorkspace: true,
        exclude: ['src/vendor'],
        executables: [
          {
            id: 'ignored-manual',
            path: 'build/ignored_sensor/sensor_tests',
            package: 'ignored_sensor',
          },
        ],
      }),
      scheduler,
    );
    assert.deepEqual(excluded.diagnostics, []);
    assert.deepEqual(excluded.executables.map((e) => e.group).sort(), [
      'robot_geometry',
      'robot_math',
    ]);
    for (const mode of ['executable', 'case', 'batch'] as const) {
      const results: CaseResult[] = [];
      let output = '';
      await Promise.all(
        excluded.executables.map((executable) =>
          runExecutable(
            executable,
            executable.cases,
            settings({ parallelMode: mode, batchSize: 2 }),
            scheduler,
            {
              started: () => {},
              result: (result) => results.push(result),
              output: (text) => {
                output += text;
              },
            },
            new AbortController().signal,
          ),
        ),
      );
      assert.equal(results.length, 5);
      assert(
        results.every((r) => r.state === 'passed'),
        JSON.stringify(results),
      );
      assert(output.includes('robot_math output'));
    }
    console.log(
      'ROS 2 colcon: real ament discovery, package grouping, environment, cwd, all parallel modes and folder exclusions passed.',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
