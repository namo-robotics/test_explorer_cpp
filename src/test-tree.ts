/** Build the workspace, executable, suite, and case items shown in Testing. */
import * as vscode from 'vscode';
import path from 'node:path';
import { stableId } from './discovery';
import type { Discovery, Executable, Settings, TestCase } from './types';

/** Connect a test item to the configuration used to run it. */
export interface Binding {
  executable: Executable;
  test: TestCase;
  folder: vscode.WorkspaceFolder;
  settings: Settings;
}

/** Reuse stable test items and track the execution data for each leaf. */
export class TestTree {
  /** Current test cases indexed by their test item IDs. */
  readonly bindings = new Map<string, Binding>();

  /** Use the controller and debug tag owned by the extension. */
  constructor(
    private readonly controller: vscode.TestController,
    private readonly debugTag: vscode.TestTag,
  ) {}

  /** Replace one workspace's children with its latest discovery results. */
  updateFolder(
    folder: vscode.WorkspaceFolder,
    settings: Settings | undefined,
    discovery: Discovery,
  ): vscode.TestItem {
    const rootId = stableId(folder.uri.toString());
    const root =
      this.controller.items.get(rootId) ??
      this.controller.createTestItem(rootId, folder.name, folder.uri);
    root.error = discovery.diagnostics.length ? discovery.diagnostics.join('\n') : undefined;
    if (!settings) {
      root.children.replace([]);
      return root;
    }
    const groups = new Map<string, vscode.TestItem>();
    const groupChildren = new Map<string, vscode.TestItem[]>();
    for (const executable of discovery.executables) {
      const groupId = stableId(rootId, executable.group);
      const group =
        groups.get(groupId) ??
        root.children.get(groupId) ??
        this.controller.createTestItem(groupId, executable.group);
      groups.set(groupId, group);
      const item = this.updateExecutable(group, executable, folder, settings);
      groupChildren.set(groupId, [...(groupChildren.get(groupId) ?? []), item]);
    }
    groups.forEach((group, id) => group.children.replace(groupChildren.get(id) ?? []));
    root.children.replace([...groups.values()]);
    return root;
  }

  /** Reuse a binary's suites and attach current run data to each test case. */
  private updateExecutable(
    group: vscode.TestItem,
    executable: Executable,
    folder: vscode.WorkspaceFolder,
    settings: Settings,
  ): vscode.TestItem {
    const item =
      group.children.get(executable.id) ??
      this.controller.createTestItem(
        executable.id,
        path.basename(executable.path),
        vscode.Uri.file(executable.path),
      );
    item.description = executable.package
      ? path.relative(folder.uri.fsPath, executable.path)
      : executable.cwd;
    const suites = new Map<string, vscode.TestItem>();
    const suiteChildren = new Map<string, vscode.TestItem[]>();
    for (const test of executable.cases) {
      const suiteId = stableId(executable.id, test.suite);
      const suite =
        suites.get(suiteId) ??
        item.children.get(suiteId) ??
        this.controller.createTestItem(suiteId, test.suite);
      suites.set(suiteId, suite);
      const id = stableId(executable.id, test.name);
      const leaf = suite.children.get(id) ?? this.controller.createTestItem(id, test.label);
      leaf.tags = [this.debugTag];
      leaf.description = test.disabled || executable.disabled ? 'disabled' : undefined;
      this.bindings.set(id, { executable, test, folder, settings });
      suiteChildren.set(suiteId, [...(suiteChildren.get(suiteId) ?? []), leaf]);
    }
    suites.forEach((suite, id) => suite.children.replace(suiteChildren.get(id) ?? []));
    item.children.replace([...suites.values()]);
    return item;
  }
}
