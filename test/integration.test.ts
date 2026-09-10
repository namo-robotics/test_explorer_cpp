/** Verify discovery and execution against real Google Test binaries. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { discover } from '../src/discovery';
import { runProcess, Scheduler } from '../src/process';
import { runExecutable, readResults } from '../src/runner';
import { workspaceEnvironment, hostEnvironment } from '../src/environment';
import type { CaseResult, Executable } from '../src/types';
import { settings } from './helpers';

let root: string, binary: string, executable: Executable;
const command = (program: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${program}: ${output}`)),
    );
  });
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp explorer tests '));
  await command('cmake', [
    '-S',
    path.resolve('test/fixtures/cmake'),
    '-B',
    path.join(root, 'build'),
    '-DCMAKE_BUILD_TYPE=Debug',
  ]);
  await command('cmake', ['--build', path.join(root, 'build'), '-j2']);
  binary = path.join(root, 'build/example_tests');
  const discovery = await discover(root, settings(), new Scheduler(2));
  assert.equal(discovery.diagnostics.length, 0, discovery.diagnostics.join('\n'));
  assert.equal(discovery.executables.length, 1);
  executable = discovery.executables[0];
});
after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('real CMake Google Test discovery preserves all cases and stable IDs', async () => {
  assert.equal(executable.group, 'explorer_fixture');
  assert.equal(executable.cases.length, 10);
  assert(executable.cases.some((c) => c.name === 'Numbers/Values.Positive/0'));
  assert(executable.cases.some((c) => c.name === 'Typed/0.Works'));
  const again = await discover(root, settings(), new Scheduler(2));
  assert.equal(again.executables[0].id, executable.id);
});
test('real discovery locates ordinary, disabled, typed and parameterized definitions', async () => {
  const file = path.resolve('test/fixtures/cmake/tests.cpp');
  const lines = (await fs.readFile(file, 'utf8')).split('\n');
  for (const [name, definition] of [
    ['Basic.Pass', 'TEST(Basic, Pass)'],
    ['Basic.DISABLED_Optional', 'TEST(Basic, DISABLED_Optional)'],
    ['Numbers/Values.Positive/0', 'TEST_P(Values, Positive)'],
    ['Numbers/Values.Positive/1', 'TEST_P(Values, Positive)'],
    ['Typed/0.Works', 'TYPED_TEST(Typed, Works)'],
  ]) {
    const testCase = executable.cases.find((testCase) => testCase.name === name);
    assert.deepEqual(
      testCase?.source,
      { file, line: lines.findIndex((line) => line.startsWith(definition)) },
      name,
    );
  }
});
for (const mode of ['executable', 'case', 'batch'] as const)
  test(`real runs report pass/fail/skip, output and disabled cases in ${mode} mode`, async () => {
    const results: CaseResult[] = [],
      output: string[] = [];
    await runExecutable(
      executable,
      executable.cases.filter((c) => c.suite === 'Basic'),
      settings({ parallelMode: mode }),
      new Scheduler(2),
      { started: () => {}, result: (r) => results.push(r), output: (text) => output.push(text) },
      new AbortController().signal,
    );
    assert.equal(results.length, 4, 'Every selected case receives exactly one result');
    const launches = output.filter((text) => text.startsWith(`Running ${executable.path} (`));
    assert.equal(launches.length, mode === 'case' ? 3 : mode === 'batch' ? 2 : 1);
    const states = Object.fromEntries(results.map((r) => [r.name, r.state]));
    assert.deepEqual(states, {
      'Basic.DISABLED_Optional': 'skipped',
      'Basic.Pass': 'passed',
      'Basic.Fail': 'failed',
      'Basic.Skip': 'skipped',
    });
    assert(output.join('').includes('case stdout'));
    assert(output.join('').includes('case stderr'));
  });
test('explicit disabled test execution and exact individual selection', async () => {
  const results: CaseResult[] = [];
  await runExecutable(
    executable,
    executable.cases.filter((c) => c.disabled),
    settings({ runDisabled: true }),
    new Scheduler(1),
    { started: () => {}, result: (r) => results.push(r), output: () => {} },
    new AbortController().signal,
  );
  assert.deepEqual(
    results.map((r) => r.state),
    ['passed'],
  );
});
test('crashes and timeouts cannot pass without XML', async () => {
  for (const name of ['Process.Crash', 'Process.Slow']) {
    const results: CaseResult[] = [];
    await runExecutable(
      { ...executable, timeout: name.endsWith('Crash') ? 5 : 0.05 },
      executable.cases.filter((c) => c.name === name),
      settings(),
      new Scheduler(1),
      { started: () => {}, result: (r) => results.push(r), output: () => {} },
      new AbortController().signal,
    );
    assert.equal(results[0].state, 'errored');
    assert.match(results[0].message!, name.endsWith('Crash') ? /SIGABRT/ : /timed out/);
  }
  assert.equal((await readResults('/missing/result.xml', ['A.B']))[0].state, 'errored');
  const malformed = path.join(root, 'bad.xml');
  await fs.writeFile(malformed, '<testsuites>');
  assert.equal((await readResults(malformed, ['A.B']))[0].state, 'errored');
});
test('cancellation stops running processes and skips queued cases', async () => {
  const abort = new AbortController();
  const process = runProcess('/bin/bash', ['-c', 'sleep 30 & wait'], {
    cwd: root,
    env: hostEnvironment(),
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 50);
  const result = await process;
  assert.equal(result.cancelled, true);
  const cancelled = new AbortController();
  cancelled.abort();
  const results: CaseResult[] = [];
  await runExecutable(
    executable,
    executable.cases.filter((c) => c.name === 'Basic.Pass'),
    settings(),
    new Scheduler(1),
    {
      started: () => assert.fail('Cancelled work started'),
      result: (r) => results.push(r),
      output: () => {},
    },
    cancelled.signal,
  );
  assert.equal(results[0].state, 'skipped');
});
test('Bash setup paths are literal, scripts run in order, and chatter is separated', async () => {
  const first = path.join(root, 'setup $(literal).bash');
  await fs.writeFile(first, 'export EXPLORER_ENV=first\necho setup chatter\n');
  await fs.mkdir(path.join(root, 'install'));
  await fs.writeFile(
    path.join(root, 'install/setup.bash'),
    'export EXPLORER_ENV="$EXPLORER_ENV:workspace"\n',
  );
  const env = await workspaceEnvironment(
    root,
    settings({ setupScripts: [first], autoSourceWorkspace: true }),
  );
  assert.equal(env.EXPLORER_ENV, 'first:workspace');
  assert.equal(env['setup chatter'], undefined);
  await assert.rejects(
    workspaceEnvironment(root, settings({ setupScripts: ['missing.bash'] })),
    /Could not source/,
  );
});
test('manual binary discovery works without CMake and supersedes the equivalent automatic entry', async () => {
  const discovery = await discover(
    root,
    settings({ executables: [{ id: 'manual', path: binary, group: 'Custom' }] }),
    new Scheduler(2),
  );
  assert.equal(discovery.executables.length, 1);
  assert.equal(discovery.executables[0].group, 'Custom');
  const standalone = await discover(
    root,
    settings({ buildDirectories: [], executables: [{ id: 'standalone', path: binary }] }),
    new Scheduler(1),
  );
  assert.equal(standalone.executables[0].cases.length, 10);
});
test('manual entries preserve distinct automatic execution environments', async () => {
  const build = path.join(root, 'environments');
  await fs.mkdir(build);
  await fs.writeFile(
    path.join(build, 'CTestTestfile.cmake'),
    ['first', 'second']
      .map(
        (value) =>
          `add_test(${value} "${binary}" "--gtest_filter=Basic.Pass")\nset_tests_properties(${value} PROPERTIES ENVIRONMENT "EXPLORER_VARIANT=${value}" WORKING_DIRECTORY "${build}")\n`,
      )
      .join(''),
  );
  const config = settings({ buildDirectories: [build] });
  const automatic = await discover(root, config, new Scheduler(2));
  assert.equal(automatic.diagnostics.length, 0, automatic.diagnostics.join('\n'));
  assert.equal(automatic.executables.length, 2);
  const matched = await discover(
    root,
    {
      ...config,
      executables: [
        {
          id: 'manual',
          path: binary,
          cwd: build,
          env: { EXPLORER_VARIANT: 'first' },
          group: 'Custom',
        },
      ],
    },
    new Scheduler(2),
  );
  assert.equal(matched.diagnostics.length, 0, matched.diagnostics.join('\n'));
  assert.equal(matched.executables.length, 2);
  assert.equal(
    matched.executables.find((e) => e.env.EXPLORER_VARIANT === 'first')?.group,
    'Custom',
  );
  const second = automatic.executables.find((e) => e.env.EXPLORER_VARIANT === 'second')!;
  assert.deepEqual(
    matched.executables.find((e) => e.id === second.id),
    second,
  );
  const unmatched = await discover(
    root,
    {
      ...config,
      executables: [
        { id: 'standalone', path: binary, cwd: build, env: { EXPLORER_VARIANT: 'third' } },
      ],
    },
    new Scheduler(2),
  );
  assert.equal(unmatched.diagnostics.length, 0, unmatched.diagnostics.join('\n'));
  assert.equal(unmatched.executables.length, 3);
  for (const original of automatic.executables) {
    assert.deepEqual(
      unmatched.executables.find((e) => e.id === original.id),
      original,
    );
  }
});
test('ROS package grouping, ament metadata, folder ignores and stale manual build exclusion', async () => {
  const ros = path.join(root, 'ros');
  for (const [name, source] of [
    ['alpha', 'src/alpha'],
    ['beta', 'src/beta'],
    ['ignored', 'src/vendor/ignored'],
    ['colcon_hidden', 'src/hidden/colcon_hidden'],
    ['nested_hidden', 'src/hidden/deeper/nested_hidden'],
  ]) {
    const dir = path.join(ros, source),
      build = path.join(ros, 'build', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(build, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.xml'), `<package><name>${name}</name></package>`);
    await fs.writeFile(
      path.join(build, 'CMakeCache.txt'),
      `CMAKE_HOME_DIRECTORY:INTERNAL=${dir}\n`,
    );
    await fs.writeFile(
      path.join(build, 'CTestTestfile.cmake'),
      `add_test(unit "/usr/bin/python3" "-u" "/opt/ros/share/ament_cmake_test/cmake/run_test.py" "unused.xml" "--package-name" "${name}" "--env" "PACKAGE=${name}" "--command" "${binary}" "--gtest_output=xml:old")\nset_tests_properties(unit PROPERTIES LABELS "gtest" WORKING_DIRECTORY "${build}")\n`,
    );
  }
  await fs.writeFile(path.join(ros, 'src/hidden/COLCON_IGNORE'), '');
  const discovery = await discover(
    ros,
    settings({
      exclude: ['src/vendor'],
      executables: [{ id: 'excluded', path: binary, package: 'ignored' }],
    }),
    new Scheduler(2),
  );
  assert.equal(discovery.diagnostics.length, 0, discovery.diagnostics.join('\n'));
  assert.deepEqual(discovery.executables.map((e) => e.group).sort(), ['alpha', 'beta']);
  assert.equal(discovery.executables.find((e) => e.group === 'alpha')?.env.PACKAGE, 'alpha');
  const explicitIgnoredBuild = await discover(
    ros,
    settings({
      exclude: ['src/vendor'],
      buildDirectories: ['build/ignored', 'build/colcon_hidden', 'build/nested_hidden'],
    }),
    new Scheduler(2),
  );
  assert.deepEqual(explicitIgnoredBuild.executables.map((e) => e.group).sort(), ['alpha', 'beta']);
  const nestedRoot = await discover(
    ros,
    settings({ sourceRoots: ['src/hidden/deeper'], buildDirectories: ['build/nested_hidden'] }),
    new Scheduler(1),
  );
  assert.equal(
    nestedRoot.executables.length,
    0,
    'An explicit nested source root must not bypass COLCON_IGNORE',
  );
});
test('suite-level failures cannot leave every selected case passed or skipped', async () => {
  const file = path.join(root, 'suite-failure.xml');
  await fs.writeFile(
    file,
    '<testsuites><testsuite><testcase classname="Suite" name="Case" result="skipped"/><testcase classname="Suite" name=""><failure message="setup failure"/></testcase></testsuite></testsuites>',
  );
  const results = await readResults(file, ['Suite.Case'], 'Test process exited with code 1');
  assert.equal(results[0].state, 'errored');
});

test('builds without CTest metadata are silent and become discoverable after testing is configured', async () => {
  const workspace = path.join(root, 'metadata-later');
  const source = path.join(workspace, 'src', 'harness');
  const build = path.join(workspace, 'build', 'harness');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(build, { recursive: true });
  await fs.writeFile(path.join(source, 'package.xml'), '<package><name>harness</name></package>');
  const configuration = settings({ buildDirectories: ['build/harness'] });
  const scheduler = new Scheduler(2);

  const initial = await discover(workspace, configuration, scheduler);
  assert.deepEqual(initial.diagnostics, []);
  assert.deepEqual(initial.executables, []);
  assert(initial.watchPaths.includes(path.join(build, 'CTestTestfile.cmake')));

  await fs.writeFile(
    path.join(build, 'CTestTestfile.cmake'),
    `add_test(harness "${binary}" "--gtest_filter=Basic.Pass")\n`,
  );
  const configured = await discover(workspace, configuration, scheduler);
  assert.deepEqual(configured.diagnostics, []);
  assert.equal(configured.executables.length, 1);
  assert.equal(configured.executables[0].group, 'harness');
  assert.deepEqual(
    configured.executables[0].cases.map((test) => test.name),
    ['Basic.Pass'],
  );
});

test('successful empty listings are skipped silently while failed listings still report errors', async () => {
  for (const script of ['', 'console.log("No tests registered")', 'process.exit(1)']) {
    const discovery = await discover(
      root,
      settings({
        sourceRoots: [],
        buildDirectories: [],
        executables: [{ id: 'empty-listing', path: process.execPath, args: ['-e', script, '--'] }],
      }),
      new Scheduler(1),
    );
    assert.deepEqual(discovery.executables, []);
    assert(discovery.watchPaths.includes(process.execPath));
    if (script === 'process.exit(1)') {
      assert.equal(discovery.diagnostics.length, 1);
      assert.match(discovery.diagnostics[0], /Google Test listing failed/);
    } else {
      assert.deepEqual(discovery.diagnostics, []);
    }
  }
});

test('cancelling a batch stops its process and skips batches still in the queue', async () => {
  const selected = ['Process.Slow', 'Basic.Pass', 'Basic.Fail'].map((name) =>
    executable.cases.find((testCase) => testCase.name === name)!,
  );
  const abort = new AbortController();
  const results: CaseResult[] = [];
  const started: string[] = [];
  let launches = 0;
  const scheduler = new Scheduler(2);
  let release!: () => void;
  const occupied = scheduler.schedule(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  try {
    await runExecutable(
      executable,
      selected,
      settings({ parallelMode: 'batch' }),
      scheduler,
      {
        started: (testCase) => started.push(testCase.name),
        result: (result) => results.push(result),
        output: (text) => {
          if (text.startsWith(`Running ${executable.path} (`)) launches++;
          if (/\[ RUN\s+\] Process.Slow/.test(text)) abort.abort();
        },
      },
      abort.signal,
    );
  } finally {
    release();
    await occupied;
  }
  assert(abort.signal.aborted, 'Cancel while a test in the first batch is running');
  assert.equal(launches, 1);
  assert.deepEqual(started, ['Process.Slow', 'Basic.Fail']);
  assert.equal(results.length, selected.length);
  assert.equal(new Set(results.map((result) => result.name)).size, selected.length);
  assert.equal(results.find((result) => result.name === 'Basic.Pass')?.state, 'skipped');
});
