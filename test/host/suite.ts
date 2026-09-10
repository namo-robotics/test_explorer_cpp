import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { Explorer } from '../../src/extension';
import type { DebugAdapter } from '../../src/debug';

const children = (items: vscode.TestItemCollection) => { const result: vscode.TestItem[] = []; items.forEach(item => result.push(item)); return result; };
/** Exercise the extension inside a real VS Code host. */
export async function run() {
  const extension = vscode.extensions.getExtension<Explorer>('namo-robotics.cpp-test-explorer');
  assert(extension, 'Extension is installed in the test host');
  const explorer = await extension.activate(); await explorer.refresh();
  const roots = children(explorer.controller.items); assert.equal(roots.length, 1);
  assert.equal(roots[0].error, undefined);
  const groups = children(roots[0].children); assert.equal(groups.length, 1);
  const binaries = children(groups[0].children); assert.equal(binaries.length, 1);
  const suites = children(binaries[0].children);
  const basic = suites.find(suite => suite.label === 'Basic')!; assert(basic);
  const pass = children(basic.children).find(test => test.label === 'Pass')!;
  const fail = children(basic.children).find(test => test.label === 'Fail')!;
  const skip = children(basic.children).find(test => test.label === 'Skip')!;
  const oldId = pass.id; await explorer.refresh();
  assert.equal(explorer.controller.items.get(roots[0].id), roots[0], 'Refresh reuses TestItem instances');
  assert.equal(basic.children.get(oldId), pass);

  const recorded = new Map<string, string>(); let output = '';
  const original = explorer.controller.createTestRun.bind(explorer.controller);
  explorer.controller.createTestRun = (...args) => {
    const real = original(...args);
    return new Proxy(real, { get(target, key) {
      if (['passed', 'failed', 'errored', 'skipped'].includes(String(key))) return (item: vscode.TestItem, ...rest: unknown[]) => {
        recorded.set(item.id, String(key)); return (target[key as keyof vscode.TestRun] as Function).call(target, item, ...rest);
      };
      if (key === 'appendOutput') return (text: string, ...rest: unknown[]) => { output += text; return (target.appendOutput as Function).call(target, text, ...rest); };
      const value = target[key as keyof vscode.TestRun]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const token = new vscode.CancellationTokenSource();
  try {
    await explorer.run(new vscode.TestRunRequest([basic], [fail]), token.token);
    assert.equal(recorded.get(pass.id), 'passed'); assert.equal(recorded.get(skip.id), 'skipped');
    assert(!recorded.has(fail.id)); assert(output.includes('case stdout')); assert(output.includes('case stderr'));
    recorded.clear();
    await explorer.run(new vscode.TestRunRequest([fail]), token.token); assert.equal(recorded.get(fail.id), 'failed');
    recorded.clear();
    await explorer.run(new vscode.TestRunRequest([pass], [basic]), token.token); assert.equal(recorded.size, 0);
    console.log('Extension host: tree, stable refresh, selection, exclusions, results and output passed.');

    if (process.env.CPP_TEST_WITH_DEBUGGERS) {
      const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(process.env.CPP_TEST_SOURCE!), new vscode.Position(7, 0)));
      vscode.debug.addBreakpoints([breakpoint]);
      try {
        for (const adapter of ['lldb', 'cppdbg'] as DebugAdapter[]) {
          let stopped = false, trackerError: unknown;
          const tracker = vscode.debug.registerDebugAdapterTrackerFactory(adapter, {
            createDebugAdapterTracker(session) { return { onDidSendMessage(message) {
              if (message.type === 'event' && message.event === 'stopped') {
                stopped = true;
                void Promise.resolve(session.customRequest('continue', { threadId: message.body.threadId })).catch(e => { trackerError = e; });
              }
            } }; },
          });
          const cancel = new vscode.CancellationTokenSource();
          const timeout = setTimeout(() => cancel.cancel(), 30000);
          try {
            recorded.clear(); await explorer.run(new vscode.TestRunRequest([pass]), cancel.token, adapter);
            assert.equal(trackerError, undefined); assert(stopped, `${adapter} must hit the source breakpoint`);
            assert.equal(recorded.get(pass.id), 'passed', `${adapter} must return Google Test results`);
            console.log(`Extension host: ${adapter} breakpoint, continue and test result passed.`);
          } finally { clearTimeout(timeout); cancel.dispose(); tracker.dispose(); }
        }
      } finally { vscode.debug.removeBreakpoints([breakpoint]); }
    }
  } finally { token.dispose(); explorer.controller.createTestRun = original; }
}
