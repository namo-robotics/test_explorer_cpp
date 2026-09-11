/** Shared configuration, discovery and result data used by the extension. */
import type { Relocation } from './relocation';
/** Environment variables passed to a child process. */
export type Environment = Record<string, string>;
/** The display hierarchy used below each test executable. */
export type TestGrouping =
  | { groupBySourceFolder?: Record<string, never> }
  | { groupBySuite: Record<string, never> }
  | { groupBySplittedTestName: { splitBy?: string } };
/** An explicitly configured Google Test program. */
export interface ManualExecutable {
  id: string;
  path: string;
  group?: string;
  package?: string;
  args?: string[];
  cwd?: string;
  env?: Environment;
  timeout?: number;
  testGrouping?: TestGrouping;
}
/** Resolved settings for one workspace folder. */
export interface Settings {
  sourceRoots: string[];
  buildBase: string;
  buildDirectories: string[];
  buildConfiguration: string;
  ctestPath: string;
  executables: ManualExecutable[];
  exclude: string[];
  setupScripts: string[];
  autoSourceWorkspace: boolean;
  env: Environment;
  concurrency: number;
  parallelMode: 'executable' | 'case' | 'batch';
  testGrouping: TestGrouping;
  discoveryTimeout: number;
  timeout: number | null;
  runDisabled: boolean;
  debug: { lldb: Record<string, unknown>; cppdbg: Record<string, unknown> };
}
/** A source file and zero-based line identifying a test definition. */
export interface SourceLocation {
  file: string;
  line: number;
}
/** A discovered Google Test case with its original filter name. */
export interface TestCase {
  name: string;
  suite: string;
  label: string;
  disabled: boolean;
  source?: SourceLocation;
}
/** A test program together with its execution environment and cases. */
export interface Executable {
  id: string;
  workspace: string;
  group: string;
  package?: string;
  path: string;
  args: string[];
  cwd: string;
  env: Environment;
  timeout: number;
  disabled: boolean;
  cases: TestCase[];
  testGrouping?: TestGrouping;
  registrations?: { filter: string; disabled: boolean }[];
  /** Workspace move detected from the build tree's CMake cache, if any. */
  relocation?: Relocation;
}
/** Discovered programs, diagnostics, informational notes and files to watch for changes. */
export interface Discovery {
  executables: Executable[];
  /** Problems that need attention; shown as an error on the workspace item. */
  diagnostics: string[];
  /** Expected conditions such as unbuilt executables; only logged to the output channel. */
  notes: string[];
  watchPaths: string[];
}
/** The reported outcome of a selected test case. */
export interface CaseResult {
  name: string;
  state: 'passed' | 'failed' | 'skipped' | 'errored';
  duration?: number;
  message?: string;
}
