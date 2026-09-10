/** Shared configuration, discovery and result data used by the extension. */
/** Environment variables passed to a child process. */
export type Environment = Record<string, string>;
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
  batchSize: number;
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
  registrations?: { filter: string; disabled: boolean }[];
}
/** Discovered programs, diagnostics and files to watch for changes. */
export interface Discovery {
  executables: Executable[];
  diagnostics: string[];
  watchPaths: string[];
}
/** The reported outcome of a selected test case. */
export interface CaseResult {
  name: string;
  state: 'passed' | 'failed' | 'skipped' | 'errored';
  duration?: number;
  message?: string;
}
