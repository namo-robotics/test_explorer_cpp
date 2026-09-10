/** Interpret Google Test listings, filters, output and result files. */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { CaseResult, TestCase } from './types';

/** Read suite and case names from Google Test listing output. */
export function parseList(output: string): TestCase[] {
  let suite = '';
  const cases = new Map<string, TestCase>();
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (/^[^\s]+\.$/.test(line)) suite = line.slice(0, -1);
    else if (suite && /^\s{2}\S+$/.test(line)) {
      const label = line.trim(), name = `${suite}.${label}`;
      cases.set(name, { name, suite, label, disabled: /(^|[/.])DISABLED_/.test(name) });
    } else if (line.trim()) suite = '';
  }
  return [...cases.values()];
}

/** The extension owns all flags which alter selection, repetition, or result destinations. */
export function cleanArgs(args: string[]): string[] {
  const owned = /^--gtest_(filter|output|list_tests|also_run_disabled_tests|repeat|shuffle|random_seed|brief|color)(=|$)/;
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (owned.test(args[i])) {
      if (!args[i].includes('=') && /--gtest_(filter|output|repeat|random_seed|color)$/.test(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) i++;
    } else result.push(args[i]);
  }
  return result;
}
/** Create exact test-selection arguments and a dedicated result destination. */
export function testArgs(args: string[], names: string[], resultFile: string, runDisabled: boolean): string[] {
  if (!names.length || names.some(name => /[:*?\-\r\n]/.test(name))) throw new Error('Cannot express selection as exact Google Test names');
  return [...cleanArgs(args), `--gtest_filter=${names.join(':')}`, `--gtest_output=xml:${resultFile}`, '--gtest_color=no',
    ...(runDisabled ? ['--gtest_also_run_disabled_tests'] : [])];
}
/** Remove inherited Google Test settings that could change the requested run. */
export function testEnvironment(env: Record<string, string>): Record<string, string> {
  const result = { ...env };
  // Inherited Google Test flags must not silently suppress or repeat requested tests.
  for (const key of ['GTEST_FILTER', 'GTEST_OUTPUT', 'GTEST_REPEAT', 'GTEST_TOTAL_SHARDS', 'GTEST_SHARD_INDEX', 'GTEST_SHARD_STATUS_FILE', 'GTEST_ALSO_RUN_DISABLED_TESTS', 'GTEST_SHUFFLE', 'GTEST_BRIEF', 'GTEST_LIST_TESTS']) delete result[key];
  return result;
}
/** Match a Google Test name against positive and negative wildcard filters. */
export function matchesFilter(name: string, filter: string): boolean {
  const separator = filter.indexOf('-');
  const positive = separator < 0 ? filter : filter.slice(0, separator);
  const negative = separator < 0 ? '' : filter.slice(separator + 1);
  const matches = (pattern: string) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(name);
  return (positive || '*').split(':').some(matches) && !negative.split(':').filter(Boolean).some(matches);
}
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
/** Validate Google Test XML and extract individual case outcomes. */
export function parseResults(xml: string): Map<string, CaseResult> {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed Google Test XML result');
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, processEntities: false }).parse(xml);
  const root = doc.testsuites ?? (doc.testsuite ? { testsuite: doc.testsuite } : undefined);
  if (!root) throw new Error('Missing Google Test XML test suites');
  const results = new Map<string, CaseResult>();
  for (const suite of array(root.testsuite)) {
    for (const test of array(suite.testcase)) {
      if (typeof test.name !== 'string' || typeof test.classname !== 'string') throw new Error('Invalid Google Test XML test case');
      const name = `${test.classname}.${test.name}`;
      const failures = [...array(test.failure), ...array(test.error)];
      const skipped = test.status === 'notrun' || test.result === 'suppressed' || test.result === 'skipped' || test.skipped !== undefined;
      const state = failures.length ? 'failed' : skipped ? 'skipped' : 'passed';
      results.set(name, { name, state, duration: Number.isFinite(Number(test.time)) ? Number(test.time) * 1000 : undefined,
        message: failures.map(f => typeof f === 'string' ? f : f.message ?? f['#text'] ?? 'Test assertion failed').join('\n\n') || undefined });
    }
  }
  return results;
}

/** Incremental stdout demultiplexing, including lines split across pipe chunks. */
export class OutputRouter {
  private pending = '';
  private current: string | undefined;
  /** Create a router that sends output to its matching test case. */
  constructor(private emit: (text: string, testName?: string) => void) {}
  /** Consume a chunk of standard output or standard error. */
  write(text: string, stream: 'stdout' | 'stderr') {
    if (stream === 'stderr') { this.emit(text, this.current); return; }
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      this.line(this.pending.slice(0, end + 1)); this.pending = this.pending.slice(end + 1);
    }
    // Bound buffering when a test emits an extremely long line.
    if (this.pending.length > 16384) { this.emit(this.pending, this.current); this.pending = ''; }
  }
  private line(line: string) {
    const start = /^\[ RUN\s+\] (\S+)/.exec(line);
    if (start) this.current = start[1];
    this.emit(line, this.current);
    if (/^\[\s*(OK|FAILED|SKIPPED)\s*\]/.test(line)) this.current = undefined;
  }
  /** Flush any remaining partial line. */
  end() { if (this.pending) this.emit(this.pending, this.current); this.pending = ''; }
}
