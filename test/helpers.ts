import type { Settings } from '../src/types';
/** Provide a complete test configuration with selected overrides. */
export function settings(overrides: Partial<Settings> = {}): Settings {
  return { sourceRoots: ['src'], buildBase: 'build', buildDirectories: ['build'], buildConfiguration: '', ctestPath: 'ctest',
    executables: [], exclude: [], setupScripts: [], autoSourceWorkspace: false, env: {}, concurrency: 2,
    parallelMode: 'executable', discoveryTimeout: 30, timeout: null, runDisabled: false, debug: { lldb: {}, cppdbg: {} }, ...overrides };
}
