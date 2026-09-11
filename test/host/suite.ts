/** Verify the test tree and run lifecycle inside VS Code. */
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { settingsFor } from '../../src/config';
import type { Explorer } from '../../src/extension';
import { verifyGrouping } from './grouping';
import type { DebugAdapter } from '../../src/debug';

const children = (items: vscode.TestItemCollection) => {
  const result: vscode.TestItem[] = [];
  items.forEach((item) => result.push(item));
  return result;
};
/** Exercise the extension inside a real VS Code host. */
export async function run() {
  const extension = vscode.extensions.getExtension<Explorer>('namo-robotics.cpp-test-explorer');
  assert(extension, 'Extension is installed in the test host');
  verifyGrouping();
  const configured = settingsFor(vscode.workspace.workspaceFolders![0]);
  assert.equal(configured.parallelMode, 'batch');
  assert.equal(configured.testGroupByMode, 'executable');
  assert.equal(configured.concurrency, os.availableParallelism());
  const explorer = await extension.activate();
  await explorer.refresh();
  const roots = children(explorer.controller.items);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].error, undefined);
  const groups = children(roots[0].children);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'explorer_fixture');
  assert.equal(children(groups[0].children)[0].label, 'example_tests');
  const descendants = (item: vscode.TestItem): vscode.TestItem[] =>
    children(item.children).flatMap((child) => [child, ...descendants(child)]);
  const suites = descendants(roots[0]);
  const basic = suites.find((suite) => suite.label === 'Basic')!;
  assert(basic);
  const pass = children(basic.children).find((test) => test.label === 'Pass')!;
  const fail = children(basic.children).find((test) => test.label === 'Fail')!;
  const skip = children(basic.children).find((test) => test.label === 'Skip')!;
  const source = process.env.CPP_TEST_SOURCE!;
  const sourceLines = (await fs.readFile(source, 'utf8')).split('\n');
  assert.equal(pass.uri?.fsPath, source);
  assert.equal(
    pass.range?.start.line,
    sourceLines.findIndex((line) => line.startsWith('TEST(Basic, Pass)')),
  );
  const editor = await vscode.window.showTextDocument(pass.uri!, { selection: pass.range });
  assert.equal(editor.document.uri.fsPath, source);
  assert.equal(editor.selection.start.line, pass.range!.start.line);
  const oldId = pass.id;
  await explorer.refresh();
  assert.equal(
    explorer.controller.items.get(roots[0].id),
    roots[0],
    'Refresh reuses TestItem instances',
  );
  assert.equal(basic.children.get(oldId), pass);

  await verifyCancellationDuringRefresh(explorer, pass);
  await verifyRunDuringRefresh(explorer, pass, false);
  await verifyRunDuringRefresh(explorer, pass, true);

  const recorded = new Map<string, string>();
  let output = '';
  const original = explorer.controller.createTestRun.bind(explorer.controller);
  explorer.controller.createTestRun = (...args) => {
    const real = original(...args);
    return new Proxy(real, {
      get(target, key) {
        if (['passed', 'failed', 'errored', 'skipped'].includes(String(key)))
          return (item: vscode.TestItem, ...rest: unknown[]) => {
            recorded.set(item.id, String(key));
            return (target[key as keyof vscode.TestRun] as Function).call(target, item, ...rest);
          };
        if (key === 'appendOutput')
          return (text: string, ...rest: unknown[]) => {
            output += text;
            return (target.appendOutput as Function).call(target, text, ...rest);
          };
        const value = target[key as keyof vscode.TestRun];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const token = new vscode.CancellationTokenSource();
  try {
    await vscode.commands.executeCommand('testing.runAtCursor');
    assert.deepEqual([...recorded], [[pass.id, 'passed']], 'Run at cursor selects one case');
    recorded.clear();
    editor.selection = new vscode.Selection(fail.range!.start, fail.range!.start);
    await vscode.commands.executeCommand('testing.runAtCursor');
    assert.deepEqual([...recorded], [[fail.id, 'failed']], 'Moving the cursor changes the case');
    recorded.clear();
    await explorer.run(new vscode.TestRunRequest([basic], [fail]), token.token);
    assert.equal(recorded.get(pass.id), 'passed');
    assert.equal(recorded.get(skip.id), 'skipped');
    assert(!recorded.has(fail.id));
    assert(output.includes('case stdout'));
    assert(output.includes('case stderr'));
    recorded.clear();
    await explorer.run(new vscode.TestRunRequest([fail]), token.token);
    assert.equal(recorded.get(fail.id), 'failed');
    recorded.clear();
    await explorer.run(new vscode.TestRunRequest([pass], [basic]), token.token);
    assert.equal(recorded.size, 0);
    console.log(
      'Extension host: tree, stable refresh, selection, exclusions, results and output passed.',
    );

    if (process.env.CPP_TEST_WITH_DEBUGGERS) {
      const breakpoint = new vscode.SourceBreakpoint(
        new vscode.Location(
          vscode.Uri.file(process.env.CPP_TEST_SOURCE!),
          new vscode.Position(7, 0),
        ),
      );
      vscode.debug.addBreakpoints([breakpoint]);
      try {
        for (const adapter of ['lldb', 'cppdbg'] as DebugAdapter[]) {
          let stopped = false,
            trackerError: unknown;
          const tracker = vscode.debug.registerDebugAdapterTrackerFactory(adapter, {
            createDebugAdapterTracker(session) {
              return {
                onDidSendMessage(message) {
                  if (message.type === 'event' && message.event === 'stopped') {
                    stopped = true;
                    void Promise.resolve(
                      session.customRequest('continue', { threadId: message.body.threadId }),
                    ).catch((e) => {
                      trackerError = e;
                    });
                  }
                },
              };
            },
          });
          const cancel = new vscode.CancellationTokenSource();
          const timeout = setTimeout(() => cancel.cancel(), 30000);
          try {
            recorded.clear();
            await explorer.run(new vscode.TestRunRequest([pass]), cancel.token, adapter);
            assert.equal(trackerError, undefined);
            assert(stopped, `${adapter} must hit the source breakpoint`);
            assert.equal(
              recorded.get(pass.id),
              'passed',
              `${adapter} must return Google Test results`,
            );
            console.log(`Extension host: ${adapter} breakpoint, continue and test result passed.`);
          } finally {
            clearTimeout(timeout);
            cancel.dispose();
            tracker.dispose();
          }
        }
      } finally {
        vscode.debug.removeBreakpoints([breakpoint]);
      }
    }
  } finally {
    token.dispose();
    explorer.controller.createTestRun = original;
  }
}

/** Ensure Stop releases a run even while its discovery refresh is still pending. */
async function verifyCancellationDuringRefresh(
  explorer: Explorer,
  item: vscode.TestItem,
): Promise<void> {
  const state = explorer as unknown as {
    refreshPromise: Promise<void>;
    refreshAbort?: AbortController;
    discoveredConfiguration?: string;
  };
  const previous = state.refreshPromise;
  const previousAbort = state.refreshAbort;
  const previousConfiguration = state.discoveredConfiguration;
  state.refreshAbort = new AbortController();
  state.discoveredConfiguration = undefined;
  let finishRefresh!: () => void;
  state.refreshPromise = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const cancellation = new vscode.CancellationTokenSource();
  let timer: NodeJS.Timeout | undefined;
  const running = explorer.run(new vscode.TestRunRequest([item]), cancellation.token);
  try {
    cancellation.cancel();
    const stopped = await Promise.race([
      running.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    assert(stopped, 'Cancelling a run must not wait for discovery to finish');
  } finally {
    clearTimeout(timer);
    finishRefresh();
    state.refreshPromise = previous;
    state.refreshAbort = previousAbort;
    state.discoveredConfiguration = previousConfiguration;
    await running;
    cancellation.dispose();
  }
}

/** Check that cached runs bypass background discovery, but stale settings still wait. */
async function verifyRunDuringRefresh(
  explorer: Explorer,
  item: vscode.TestItem,
  stale: boolean,
): Promise<void> {
  const state = explorer as unknown as {
    refreshPromise: Promise<void>;
    refreshAbort?: AbortController;
    discoveredConfiguration?: string;
  };
  const previous = state.refreshPromise;
  const previousAbort = state.refreshAbort;
  const previousConfiguration = state.discoveredConfiguration;
  const refreshAbort = new AbortController();
  state.refreshAbort = refreshAbort;
  if (stale) state.discoveredConfiguration = 'outdated settings';
  let finishRefresh!: () => void;
  state.refreshPromise = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const token = new vscode.CancellationTokenSource();
  let timer: NodeJS.Timeout | undefined;
  let completed = false;
  const running = explorer.run(new vscode.TestRunRequest([item]), token.token).then(() => {
    completed = true;
  });
  try {
    if (stale) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert(!completed, 'Changed settings require discovery before executing cached tests');
      assert(!refreshAbort.signal.aborted);
      state.discoveredConfiguration = previousConfiguration;
      finishRefresh();
    }
    const finished = await Promise.race([
      running.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1500);
      }),
    ]);
    assert(finished, 'Already discovered tests must not wait for unrelated background discovery');
    if (!stale)
      assert(refreshAbort.signal.aborted, 'Cached runs release background discovery slots');
  } finally {
    clearTimeout(timer);
    token.cancel();
    finishRefresh();
    state.refreshPromise = previous;
    state.refreshAbort = previousAbort;
    state.discoveredConfiguration = previousConfiguration;
    await running;
    token.dispose();
  }
}
