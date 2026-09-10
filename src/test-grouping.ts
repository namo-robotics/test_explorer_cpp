/** Choose display groups without changing the Google Test names used for execution. */
import path from 'node:path';
import type { TestCase, TestGrouping } from './types';

/** Display groups and the leaf label for one test case. */
export interface GroupedTest {
  groups: string[];
  label: string;
}

/** Check grouping settings and reject invalid regular expressions before discovery. */
export function validateTestGrouping(value: unknown): asserts value is TestGrouping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('testGrouping must select one grouping strategy');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return;
  if (entries.length !== 1) throw new Error('testGrouping must select one grouping strategy');
  const [strategy, options] = entries[0];
  if (
    !['groupBySourceFolder', 'groupBySuite', 'groupBySplittedTestName'].includes(strategy) ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new Error('Invalid testGrouping strategy');
  }
  const keys = Object.keys(options);
  if (strategy === 'groupBySplittedTestName') {
    if (keys.some((key) => key !== 'splitBy'))
      throw new Error('Unknown split-name grouping option');
    const { splitBy = '.' } = options as { splitBy?: unknown };
    if (typeof splitBy !== 'string' || !splitBy || splitBy === '`') {
      throw new Error('testGrouping splitBy must be a nonempty string');
    }
    try {
      splitPattern(splitBy);
    } catch {
      throw new Error('testGrouping splitBy contains an invalid regular expression');
    }
  } else if (keys.length) {
    throw new Error('This testGrouping strategy takes no options');
  }
}

/** Interpret a leading backtick as a JavaScript regular expression. */
function splitPattern(splitBy: string): string | RegExp {
  return splitBy.startsWith('`') ? new RegExp(splitBy.slice(1)) : splitBy;
}

/** Compile a grouping strategy once for all cases in an executable. */
export function createTestGrouper(
  root: string,
  grouping: TestGrouping,
): (test: TestCase) => GroupedTest {
  if ('groupBySplittedTestName' in grouping) {
    const pattern = splitPattern(grouping.groupBySplittedTestName.splitBy ?? '.');
    return (test) => {
      const parts = test.name
        .split(pattern)
        .filter((part) => typeof part === 'string' && part.length > 0);
      return { groups: parts.slice(0, -1), label: parts.at(-1) ?? test.name };
    };
  }
  if ('groupBySuite' in grouping) {
    return (test) => ({ groups: [test.suite], label: test.label });
  }
  return (test) => {
    if (!test.source) return { groups: ['Unknown source', test.suite], label: test.label };
    const directory = path.dirname(test.source.file);
    const relative = path.relative(root, directory);
    const outside =
      relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    const folders = outside
      ? ['External sources', ...directory.split(path.sep).filter(Boolean)]
      : relative.split(path.sep).filter(Boolean);
    return { groups: [...folders, test.suite], label: test.label };
  };
}
