/** Verify configurable test hierarchies using real VS Code test items. */
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TestTree } from '../../src/test-tree';
import { selectLeaves } from '../../src/selection';
import { settings } from '../helpers';
import type { Executable, TestCase } from '../../src/types';

/** Follow an expected hierarchy and fail if a group or case is missing. */
function descend(root: vscode.TestItem, labels: string[]): vscode.TestItem {
  let current = root;
  for (const label of labels) {
    let found: vscode.TestItem | undefined;
    current.children.forEach((child) => {
      if (child.label === label) found = child;
    });
    assert(found, `Missing ${label} below ${current.label}`);
    current = found;
  }
  return current;
}

/** Check default grouping, per-executable overrides, stable refresh, and subtree selection. */
export function verifyGrouping(): void {
  const controller = vscode.tests.createTestController('grouping-check', 'Grouping checks');
  try {
    const tree = new TestTree(controller, new vscode.TestTag('debug'));
    const folder = vscode.workspace.workspaceFolders![0];
    const file = path.join(folder.uri.fsPath, 'tests/functions/generic/test_constraints.cpp');
    const cases: TestCase[] = [
      'numeric_accepts_integer',
      'cannot_redefine_IError_as_class',
      'DISABLED_ThroughputMBps',
    ].map((label, line) => ({
      name: `Functions_Generic_Constraints.${label}`,
      suite: 'Functions_Generic_Constraints',
      label,
      disabled: label.startsWith('DISABLED_'),
      source: { file, line },
    }));
    const executable: Executable = {
      id: 'grouping-executable',
      workspace: folder.uri.fsPath,
      group: 'Project',
      path: path.join(folder.uri.fsPath, 'tests_binary'),
      args: [],
      cwd: folder.uri.fsPath,
      env: {},
      timeout: 60,
      disabled: false,
      cases,
    };
    const discovery = { executables: [executable], diagnostics: [], notes: [], watchPaths: [] };
    const configuration = settings();
    const root = tree.updateFolder(folder, configuration, discovery);
    controller.items.replace([root]);
    const original = descend(root, [
      'Project',
      'tests_binary',
      'tests',
      'functions',
      'generic',
      cases[0].suite,
      cases[0].label,
    ]);
    assert.equal(original.uri?.fsPath, file);
    assert.equal(original.range?.start.line, 0);
    const id = original.id;

    executable.testGrouping = {
      groupBySplittedTestName: { splitBy: '`(?<!\\.[^.]*)_(?=[A-Z])|\\.' },
    };
    tree.bindings.clear();
    tree.updateFolder(folder, configuration, discovery);
    const group = descend(root, ['Project', 'tests_binary', 'Functions', 'Generic', 'Constraints']);
    const leaf = descend(group, [cases[0].label]);
    assert.equal(leaf.id, id, 'Grouping changes preserve execution IDs');
    const excluded = descend(group, [cases[1].label]);
    const selected = selectLeaves([root], [group], [excluded], (item) =>
      tree.bindings.has(item.id),
    );
    assert.equal(selected.length, 2);
    assert(selected.includes(leaf));
    assert.equal(tree.bindings.get(leaf.id)?.executableItem.id, executable.id);
    assert.equal(tree.bindings.get(leaf.id)?.test.name, cases[0].name);
    tree.bindings.clear();
    tree.updateFolder(folder, configuration, discovery);
    assert.equal(descend(group, [cases[0].label]), leaf, 'Unchanged refresh reuses leaf objects');
  } finally {
    controller.dispose();
  }
}
