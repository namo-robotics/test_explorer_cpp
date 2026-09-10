/** Verify source navigation metadata and graceful fallback for unavailable sources. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { attachSourceLocations, parseSourceLocations } from '../src/test-locations';
import { parseList } from '../src/gtest';

test('listing locations preserve exact names and decode XML paths', () => {
  const locations = parseSourceLocations(`<testsuites>
    <testsuite name="Prefix/Values"><testcase name="Works/0" file="test &amp; cases.cpp" line="12"/></testsuite>
    <testsuite name="Typed/0"><testcase name="Works" file="typed.cpp" line="3"/></testsuite>
    <testsuite name="Basic">
      <testcase name="DISABLED_Optional" file="basic.cpp" line="1"/>
      <testcase name="Unknown"/>
      <testcase name="Invalid" file="basic.cpp" line="0"/>
      <testcase name="Fraction" file="basic.cpp" line="1.5"/>
    </testsuite>
  </testsuites>`);
  assert.deepEqual(
    [...locations],
    [
      ['Prefix/Values.Works/0', { file: 'test & cases.cpp', line: 11 }],
      ['Typed/0.Works', { file: 'typed.cpp', line: 2 }],
      ['Basic.DISABLED_Optional', { file: 'basic.cpp', line: 0 }],
    ],
  );
  assert.throws(() => parseSourceLocations('<testsuites>'), /Malformed/);
});

test('missing metadata and ambiguous paths retain runnable cases without navigation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-locations-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await fs.mkdir(first);
    await fs.mkdir(second);
    const file = path.join(first, 'tests.cpp');
    await fs.writeFile(file, '// Test source\n');
    const xmlFile = path.join(root, 'listing.xml');
    const cases = parseList('Basic.\n  Pass\n');
    const original = structuredClone(cases);

    await attachSourceLocations(cases, xmlFile, [first]);
    assert.deepEqual(cases, original);
    await fs.writeFile(xmlFile, '<invalid');
    await attachSourceLocations(cases, xmlFile, [first]);
    assert.deepEqual(cases, original);

    await fs.writeFile(
      xmlFile,
      '<testsuites><testsuite name="Basic"><testcase name="Pass" file="tests.cpp" line="1"/></testsuite></testsuites>',
    );
    await attachSourceLocations(cases, xmlFile, [first, first, second]);
    assert.deepEqual(cases[0].source, { file, line: 0 });

    await fs.writeFile(path.join(second, 'tests.cpp'), '// Another test source\n');
    const ambiguous = structuredClone(original);
    await attachSourceLocations(ambiguous, xmlFile, [first, second]);
    assert.deepEqual(ambiguous, original);

    await fs.rm(file);
    await fs.rm(path.join(second, 'tests.cpp'));
    await attachSourceLocations(ambiguous, xmlFile, [first, second]);
    assert.deepEqual(ambiguous, original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
