/** Read and validate settings for an individual VS Code workspace folder. */
import * as vscode from 'vscode';
import os from 'node:os';
import type { Settings } from './types';

/** Read settings and reject invalid values before starting processes. */
export function settingsFor(folder: vscode.WorkspaceFolder): Settings {
  const config = vscode.workspace.getConfiguration('cppTestExplorer', folder.uri);
  const settings: Settings = {
    sourceRoots: config.get('sourceRoots', ['src']),
    buildBase: config.get('buildBase', 'build'),
    buildDirectories: config.get('buildDirectories', ['build']),
    buildConfiguration: config.get('buildConfiguration', ''),
    ctestPath: config.get('ctestPath', 'ctest'),
    executables: config.get('executables', []),
    exclude: config.get('exclude', []),
    setupScripts: config.get('setupScripts', []),
    autoSourceWorkspace: config.get('autoSourceWorkspace', true),
    env: config.get('env', {}),
    concurrency: config.get('concurrency', 0),
    parallelMode: config.get('parallelMode', 'case'),
    batchSize: config.get('batchSize', 25),
    discoveryTimeout: config.get('discoveryTimeout', 30),
    timeout: config.get('timeout', null),
    runDisabled: config.get('runDisabled', false),
    debug: config.get('debug', { lldb: {}, cppdbg: {} }),
  };
  validateSettings(settings);
  return settings;
}

/** Reject invalid configuration values and resolve automatic concurrency. */
function validateSettings(settings: Settings): void {
  if (!Number.isInteger(settings.concurrency) || settings.concurrency < 0) {
    throw new Error('concurrency must be a nonnegative integer');
  }
  settings.concurrency ||= Math.max(1, os.availableParallelism());
  if (!(settings.discoveryTimeout > 0) || !Number.isFinite(settings.discoveryTimeout)) {
    throw new Error('discoveryTimeout must be positive');
  }
  if (settings.timeout !== null && (!Number.isFinite(settings.timeout) || settings.timeout < 0)) {
    throw new Error('timeout must be null or a nonnegative number');
  }
  if (!['case', 'executable', 'batch'].includes(settings.parallelMode)) {
    throw new Error('parallelMode must be executable, case or batch');
  }
  if (!Number.isInteger(settings.batchSize) || settings.batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }
  for (const key of ['sourceRoots', 'buildDirectories', 'exclude', 'setupScripts'] as const) {
    if (!Array.isArray(settings[key]) || settings[key].some((value) => typeof value !== 'string')) {
      throw new Error(`${key} must contain strings`);
    }
  }
  if (!Array.isArray(settings.executables)) {
    throw new Error('executables must be an array');
  }
  for (const entry of settings.executables) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      typeof entry.path !== 'string' ||
      (entry.args !== undefined &&
        (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string'))) ||
      (entry.timeout !== undefined && (!Number.isFinite(entry.timeout) || entry.timeout < 0))
    ) {
      throw new Error('Invalid explicit executable configuration');
    }
  }
}
