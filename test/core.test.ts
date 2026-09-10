/** Verify parsing, selection, scheduling, and launch configuration behavior. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvironment } from '../src/environment';
import { fromCTest, excluded } from '../src/discovery';
import {
  registeredCases,
  matchesFilter,
  parseList,
  parseResults,
  testArgs,
  testEnvironment,
  OutputRouter,
} from '../src/gtest';
import { debugConfiguration } from '../src/debug';
import { Scheduler } from '../src/process';
import { selectLeaves } from '../src/selection';
import { batches } from '../src/runner';
import { settings } from './helpers';

test('typed, value-parameterized and disabled Google Test names are preserved', () => {
  const tests = parseList(
    'Running main()\nMath.\n  Adds\n  DISABLED_Slow\nTyped/0.  # TypeParam = int\n  Works\nInstantiation/Values.\n  Works/0  # GetParam() = 3\n',
  );
  assert.deepEqual(
    tests.map((t) => t.name),
    ['Math.Adds', 'Math.DISABLED_Slow', 'Typed/0.Works', 'Instantiation/Values.Works/0'],
  );
  assert.equal(tests[1].disabled, true);
  assert.equal(parseList('custom executable chatter\n  not_a_test\n').length, 0);
});
test('extension selection cannot be overridden by inherited flags or sharding', () => {
  assert.deepEqual(
    testArgs(
      ['--gtest_filter=Old.*', '--gtest_output', 'xml:old', '--flag'],
      ['Suite.Test'],
      '/tmp/a b.xml',
      false,
    ),
    ['--flag', '--gtest_filter=Suite.Test', '--gtest_output=xml:/tmp/a b.xml', '--gtest_color=no'],
  );
  assert.throws(() => testArgs([], ['Suite.*'], '/tmp/results', false));
  assert.deepEqual(
    testEnvironment({ GTEST_TOTAL_SHARDS: '5', GTEST_FILTER: '*', ROS_DOMAIN_ID: '7' }),
    { ROS_DOMAIN_ID: '7' },
  );
});
test('XML distinguishes pass, failure and skip and rejects malformed results', () => {
  const results = parseResults(
    '<testsuites><testsuite><testcase classname="Math" name="Pass" time="0.25"/><testcase classname="Math" name="Fail"><failure message="assertion"/></testcase><testcase classname="Math" name="Skip"><skipped/></testcase></testsuite></testsuites>',
  );
  assert.equal(results.get('Math.Pass')?.duration, 250);
  assert.equal(results.get('Math.Fail')?.state, 'failed');
  assert.equal(results.get('Math.Skip')?.state, 'skipped');
  assert.throws(() => parseResults('<testsuites>'));
  assert.throws(() => parseResults('<something/>'));
});
test('output router handles fragmented lines and associates stderr', () => {
  const output: [string, string | undefined][] = [];
  const router = new OutputRouter((text, name) => output.push([text, name]));
  router.write('setup\n[ RU', 'stdout');
  router.write('N      ] Suite.Test\nhello\n', 'stdout');
  router.write('error\n', 'stderr');
  router.write('[       OK ] Suite.Test (0 ms)\nteardown', 'stdout');
  router.end();
  assert.equal(output[0][1], undefined);
  assert.equal(output.find(([text]) => text === 'error\n')?.[1], 'Suite.Test');
  assert.equal(output.at(-1)?.[1], undefined);
});
test('environment preserves CTest operations and ament append semantics', () => {
  assert.deepEqual(
    applyEnvironment(
      { PATH: '/system', REMOVE: 'old' },
      ['SET=one=two'],
      ['PATH=path_list_prepend:/test', 'REMOVE=unset:', 'SET=string_append:three'],
      ['PATH=/ament'],
    ),
    { PATH: '/test:/system:/ament', SET: 'one=twothree' },
  );
  assert.deepEqual(applyEnvironment({}, [], [], ['PATH=/ament']), { PATH: ':/ament' });
  assert.throws(() => applyEnvironment({}, [], ['A=unknown:x']));
});
test('ament wrapper yields native target and per-test environment', () => {
  const executable = fromCTest(
    {
      name: 'unit',
      command: [
        '/usr/bin/python3',
        '-u',
        '/opt/ros/share/ament_cmake_test/cmake/run_test.py',
        '/build/result.xml',
        '--package-name',
        'pkg',
        '--env',
        'ONE=1',
        '--append-env',
        'LD_LIBRARY_PATH=/pkg/lib',
        '--command',
        '/build/unit',
        '--gtest_output=xml:old',
      ],
      properties: [
        { name: 'LABELS', value: ['gtest'] },
        { name: 'WORKING_DIRECTORY', value: '/work' },
        { name: 'TIMEOUT', value: 99 },
      ],
    },
    '/workspace',
    '/build',
    'pkg',
    { LD_LIBRARY_PATH: '/ros/lib' },
    settings({ env: { ONE: 'override' } }),
    'pkg',
  )!;
  assert.equal(executable.path, '/build/unit');
  assert.equal(executable.cwd, '/work');
  assert.equal(executable.timeout, 99);
  assert.deepEqual(executable.args, []);
  assert.equal(executable.env.ONE, 'override');
  assert.equal(executable.env.LD_LIBRARY_PATH, '/ros/lib:/pkg/lib');
  assert.throws(
    () =>
      fromCTest(
        { name: 'custom', command: ['python3', 'custom.py', '--gtest_filter=*'] },
        '/',
        '/build',
        'p',
        {},
        settings(),
      ),
    /unsupported test wrapper/,
  );
});
test('CMake per-case registrations coalesce but distinct environments remain separate', () => {
  const entry = (filter: string, env: string) =>
    fromCTest(
      {
        name: filter,
        command: ['/build/test', `--gtest_filter=${filter}`],
        properties: [{ name: 'ENVIRONMENT', value: [env] }],
      },
      '/',
      '/build',
      'p',
      {},
      settings(),
    )!;
  assert.equal(entry('A.One', 'A=1').id, entry('A.Two', 'A=1').id);
  assert.notEqual(entry('A.One', 'A=1').id, entry('A.One', 'A=2').id);
  assert.equal(
    fromCTest(
      { name: 'pytest', command: ['python3', '-m', 'pytest'] },
      '/',
      '/build',
      'p',
      {},
      settings(),
    ),
    undefined,
  );
});
test('folder exclusion applies to descendants without matching sibling prefixes', () => {
  assert(excluded('/ws', '/ws/src/vendor/pkg', ['src/vendor']));
  assert(excluded('/ws', '/ws/src/vendor/pkg', ['src/vendor/**']));
  assert(!excluded('/ws', '/ws/src/vendor2/pkg', ['src/vendor']));
});
test('both adapters receive protected target and compatible environment shape', () => {
  const executable = fromCTest(
    { name: 'test', command: ['/b/test', '--gtest_filter=*'] },
    '/',
    '/b',
    'p',
    { ROS_DOMAIN_ID: '7' },
    settings(),
  )!;
  for (const adapter of ['lldb', 'cppdbg'] as const) {
    const config = debugConfiguration(
      adapter,
      executable,
      'Suite.One',
      '/tmp/results.xml',
      { program: '/bad', args: ['bad'], preLaunchTask: 'build', sourceMap: { '/old': '/new' } },
      'session',
    );
    assert.equal(config.type, adapter);
    assert.equal(config.program, '/b/test');
    assert.equal(config.preLaunchTask, undefined);
    assert((config.args as string[]).includes('--gtest_filter=Suite.One'));
    assert.deepEqual(
      adapter === 'lldb' ? config.env : config.environment,
      adapter === 'lldb' ? { ROS_DOMAIN_ID: '7' } : [{ name: 'ROS_DOMAIN_ID', value: '7' }],
    );
  }
});
test('scheduler bounds concurrent requests and removes cancelled queued work', async () => {
  const scheduler = new Scheduler(2);
  let active = 0,
    peak = 0;
  const work = () =>
    scheduler.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
  await Promise.all(Array.from({ length: 8 }, work));
  assert.equal(peak, 2);
  scheduler.setLimit(1);
  const first = scheduler.schedule(() => new Promise((r) => setTimeout(r, 20)));
  const abort = new AbortController();
  let ran = false;
  const queued = scheduler.schedule(async () => {
    ran = true;
  }, abort.signal);
  abort.abort();
  await assert.rejects(queued, /Cancelled/);
  await first;
  assert.equal(ran, false);
});
test('selection deduplicates and honors ancestor exclusions for direct leaf requests', () => {
  type Node = { id: string; parent?: Node; children: Node[] };
  const root: Node = { id: 'root', children: [] },
    suite: Node = { id: 'suite', parent: root, children: [] };
  const leaf: Node = { id: 'leaf', parent: suite, children: [] };
  root.children.push(suite);
  suite.children.push(leaf);
  assert.deepEqual(
    selectLeaves([root], [root, leaf], [], (n) => n === leaf),
    [leaf],
  );
  assert.deepEqual(
    selectLeaves([root], [leaf], [suite], (n) => n === leaf),
    [],
  );
});

test('batch mode distributes a large selection round-robin across process slots', () => {
  const cases = Array.from({ length: 1000 }, (_, index) => ({
    name: `Suite.Case${index}`,
    suite: 'Suite',
    label: `Case${index}`,
    disabled: false,
  }));
  const grouped = batches(cases, 'batch', 8);
  assert.equal(grouped.length, 8);
  for (let slot = 0; slot < grouped.length; slot++) {
    assert.deepEqual(
      grouped[slot],
      cases.filter((_, index) => index % 8 === slot),
    );
  }
  assert.equal(new Set(grouped.flat()).size, cases.length);
  assert.deepEqual(
    batches(cases.slice(0, 10), 'batch', 3).map((group) => group.length),
    [4, 3, 3],
  );
  assert.deepEqual(batches([], 'batch', 8), []);
  assert.equal(batches(cases, 'batch', 1).length, 1);
  assert.equal(batches(cases, 'batch', 2000).length, cases.length);
  assert.equal(batches(cases, 'executable', 8).length, 1);
  assert.equal(batches(cases, 'case', 8).length, cases.length);
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => batches(cases, 'batch', invalid), /positive integer/);
  }
});

test('batch mode retains the command-length limit', () => {
  const cases = Array.from({ length: 3 }, (_, index) => ({
    name: `Suite.${'A'.repeat(20000)}${index}`,
    suite: 'Suite',
    label: String(index),
    disabled: false,
  }));
  const grouped = batches(cases, 'batch', 1);
  assert.deepEqual(
    grouped.map((batch) => batch.length),
    [1, 1, 1],
  );
  assert.deepEqual(grouped.flat(), cases);
});

test('registration indexing preserves overlapping filters and disabled cases', () => {
  const cases = parseList('Suite.\n  One\n  Two\n  Three\n  DISABLED_Four\nOther.\n  Five\n');
  for (const registrations of [
    [],
    [
      { filter: 'Suite.One:Suite.Two', disabled: true },
      { filter: 'Suite.One', disabled: false },
    ],
    [
      { filter: 'Suite.*-Suite.Three', disabled: true },
      { filter: 'Suite.Two', disabled: false },
    ],
    [{ filter: '', disabled: false }],
    [{ filter: '-Suite.Three', disabled: false }],
    [{ filter: 'Suite.?ne', disabled: false }],
    [{ filter: 'Suite.DISABLED_Four', disabled: false }],
    [
      { filter: 'Other.Five', disabled: true },
      { filter: '*', disabled: false },
    ],
  ]) {
    const expected = cases.flatMap((test) => {
      const matches = registrations.filter((r) => matchesFilter(test.name, r.filter));
      return matches.length
        ? [{ ...test, disabled: test.disabled || matches.every((r) => r.disabled) }]
        : [];
    });
    assert.deepEqual(registeredCases(cases, registrations), expected);
  }
});

test('output routing combines adjacent lines without mixing test ownership', () => {
  const output: [string, string | undefined][] = [];
  const router = new OutputRouter((text, name) => output.push([text, name]));
  const first =
    '[ RUN      ] Suite.One\n' + 'detail\n'.repeat(1000) + '[       OK ] Suite.One (0 ms)\n';
  const second = '[ RUN      ] Suite.Two\nhello\n[       OK ] Suite.Two (0 ms)\n';
  router.write('setup\n' + first + 'between\n' + second + 'teardown\n', 'stdout');
  router.end();
  assert.deepEqual(output, [
    ['setup\n', undefined],
    [first, 'Suite.One'],
    ['between\n', undefined],
    [second, 'Suite.Two'],
    ['teardown\n', undefined],
  ]);
});

test('wildcard registrations select a large listing with exclusions and disabled overrides', () => {
  const cases = Array.from({ length: 1000 }, (_, i) => ({
    name: `Suite${i}.Test`,
    suite: `Suite${i}`,
    label: 'Test',
    disabled: i === 5,
  }));
  const registrations = cases.map((test, i) => ({
    filter: `${test.suite}.*-Suite7.*`,
    disabled: i % 2 === 0,
  }));
  registrations.push({ filter: 'Suite?.Test-Suite7.*', disabled: false });
  const selected = registeredCases(cases, registrations);
  assert.deepEqual(
    selected,
    cases
      .filter((_, i) => i !== 7)
      .map((test) => {
        const i = Number(test.suite.slice('Suite'.length));
        return { ...test, disabled: i === 5 || (i >= 10 && i % 2 === 0) };
      }),
  );
});

test('wildcard matching treats regex punctuation as literal text', () => {
  assert(matchesFilter('Suite[0].Test+value', 'Suite[0].Test+*'));
  assert(!matchesFilter('Suite0.Testvalue', 'Suite[0].Test+*'));
  assert(matchesFilter('Other.Test', 'Suite.*:Other.?est-Suite.Skip'));
  assert(!matchesFilter('Suite.Skip', 'Suite.*:Other.?est-Suite.Skip'));
});

test('output block scanning preserves owners across fragmented completion markers', () => {
  const expected: [string, string | undefined][] = [
    ['setup\n', undefined],
    [
      '[ RUN      ] Suite.One\ndetail [bracket]\nmore\n[  FAILED  ] Suite.One (0 ms)\n',
      'Suite.One',
    ],
    ['between\nplain output\n', undefined],
    ['[ RUN      ] Suite.Two\n[custom log]\nmore\n[  SKIPPED ] Suite.Two (0 ms)\n', 'Suite.Two'],
    ['teardown\npartial', undefined],
  ];
  const text = expected.map(([text]) => text).join('');
  for (const size of [1, 7, text.length]) {
    const output: typeof expected = [];
    const router = new OutputRouter((text, name) => {
      const previous = output.at(-1);
      if (previous && previous[1] === name) previous[0] += text;
      else output.push([text, name]);
    });
    for (let offset = 0; offset < text.length; offset += size) {
      router.write(text.slice(offset, offset + size), 'stdout');
    }
    router.end();
    assert.deepEqual(output, expected);
  }
});
