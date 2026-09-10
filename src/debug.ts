/** Build debugger launch configurations for a single selected test. */
import type { Executable } from './types';
import { testArgs, testEnvironment } from './gtest';

/** The debugger adapters supported by single-case debugging. */
export type DebugAdapter = 'lldb' | 'cppdbg';
/** Create a debugger launch configuration that preserves the selected test. */
export function debugConfiguration(
  adapter: DebugAdapter,
  executable: Executable,
  name: string,
  resultFile: string,
  overrides: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  const config = { ...overrides };
  // Do not let an override build code, change the target, or redirect its environment/arguments.
  for (const key of [
    'preLaunchTask',
    'postDebugTask',
    'envFile',
    'environment',
    'env',
    'args',
    'program',
    'cwd',
    'request',
    'type',
    'name',
    'targetCreateCommands',
    'processCreateCommands',
    'customLaunchSetupCommands',
    'launchCompleteCommand',
  ]) {
    delete config[key];
  }
  return {
    ...config,
    type: adapter,
    request: 'launch',
    name: `Debug ${name}`,
    program: executable.path,
    args: testArgs(executable.args, [name], resultFile, true),
    cwd: executable.cwd,
    ...(adapter === 'lldb'
      ? { env: testEnvironment(executable.env) }
      : {
          MIMode: 'gdb',
          environment: Object.entries(testEnvironment(executable.env)).map(([name, value]) => ({
            name,
            value,
          })),
        }),
    __cppTestExplorerSession: sessionId,
  };
}
