/** Verify source-folder and name grouping without altering executable test names. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestGrouper, validateTestGrouping } from '../src/test-grouping';
import type { TestCase } from '../src/types';

const root = path.resolve('/workspace');
const example: TestCase = {
  name: 'Functions_Generic_Constraints.numeric_accepts_integer',
  suite: 'Functions_Generic_Constraints',
  label: 'numeric_accepts_integer',
  disabled: false,
  source: { file: path.join(root, 'tests/functions/generic/test_constraints.cpp'), line: 10 },
};

test('source grouping follows workspace-relative directories and retains suites', () => {
  const group = createTestGrouper(root, { groupBySourceFolder: {} });
  assert.deepEqual(group(example), {
    groups: ['tests', 'functions', 'generic', example.suite],
    label: example.label,
  });
  assert.deepEqual(group({ ...example, source: undefined }).groups, [
    'Unknown source',
    example.suite,
  ]);
  assert.deepEqual(
    group({ ...example, source: { file: path.join(root, 'tests.cpp'), line: 0 } }).groups,
    [example.suite],
  );
  assert.deepEqual(
    group({ ...example, source: { file: path.resolve('/external/tests.cpp'), line: 0 } }).groups,
    ['External sources', 'external', example.suite],
  );
});

test('regex grouping splits suite segments while preserving snake-case test names', () => {
  const grouping = { groupBySplittedTestName: { splitBy: '`(?<!\\.[^.]*)_(?=[A-Z])|\\.' } };
  validateTestGrouping(grouping);
  const group = createTestGrouper(root, grouping);
  for (const label of [
    'numeric_accepts_integer',
    'cannot_redefine_IError_as_class',
    'DISABLED_ThroughputMBps',
  ]) {
    const testCase = { ...example, name: `${example.suite}.${label}`, label };
    assert.deepEqual(group(testCase), { groups: ['Functions', 'Generic', 'Constraints'], label });
    assert.equal(testCase.name, `${example.suite}.${label}`);
  }
});

test('literal grouping and suite grouping preserve parameterized names', () => {
  const value = {
    ...example,
    name: 'Prefix/Values.Works/0',
    suite: 'Prefix/Values',
    label: 'Works/0',
  };
  assert.deepEqual(createTestGrouper(root, { groupBySplittedTestName: {} })(value), {
    groups: ['Prefix/Values'],
    label: 'Works/0',
  });
  assert.deepEqual(createTestGrouper(root, { groupBySuite: {} })(value), {
    groups: ['Prefix/Values'],
    label: 'Works/0',
  });
  assert.deepEqual(createTestGrouper(root, { groupBySplittedTestName: { splitBy: ':' } })(value), {
    groups: [],
    label: value.name,
  });
});

test('grouping rejects conflicting strategies and invalid patterns', () => {
  for (const value of [
    null,
    [],
    'suite',
    { unknown: {} },
    { groupBySuite: {}, groupBySourceFolder: {} },
    { groupBySplittedTestName: { splitBy: '' } },
    { groupBySplittedTestName: { splitBy: null } },
    { groupBySplittedTestName: { splitBy: '`[' } },
  ]) {
    assert.throws(() => validateTestGrouping(value));
  }
  validateTestGrouping({});
  validateTestGrouping({ groupBySourceFolder: {} });
  validateTestGrouping({ groupBySuite: {} });
});

test('empty grouping defaults to suites', () => {
  assert.deepEqual(createTestGrouper(root, {})(example), {
    groups: [example.suite],
    label: example.label,
  });
});
