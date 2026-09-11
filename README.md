# C++ Test Explorer

<img src="assets/icon.png" alt="C++ Test Explorer logo" width="128">

Google Test support for VS Code's native Testing view, by **Namo Robotics**
(`namo-robotics.cpp-test-explorer`). Runs existing C++ test binaries in Linux workspaces, including
CMake/CTest, Remote SSH, WSL, dev containers and ROS 2 colcon.

## Install and use

Run `./build-vsix.sh`, then install `cpp-test-explorer-0.1.3.vsix` using **Extensions: Install from
VSIX…**. The script installs locked dependencies, compiles and packages the extension. Requires Node
22+ and npm. Optional packaging arguments are forwarded, e.g.
`./build-vsix.sh --out /tmp/explorer.vsix`.

Build your C++ project with testing enabled, open its workspace folder, and open VS Code's Testing
view. The tree is **Workspace → Package/Project → Executable → Source folders → Suite → Case**. Run
all tests, any group, or a single case using the standard Testing actions.

Select a case to debug with **CodeLLDB** (`vadimcn.vscode-lldb`) or **C++ / GDB**
(`ms-vscode.cpptools`). Install the debugger in the remote environment when using Remote SSH, WSL or
a container. GDB must also be installed for cpptools. VS Code remembers your chosen default debug
profile.

Runs reuse the last completed discovery when workspace settings are unchanged, and automatic
refreshes wait until active runs finish. Use **C++ Test Explorer: Refresh Tests** after building if
needed. Binaries, discovered metadata, package manifests and setup scripts are watched
automatically. **C++ Test Explorer: Show Discovery Output** explains discovery problems. Test
stdout/stderr appear in Testing output; debugger output uses its Debug Console or terminal. Test
cases with source metadata support **Go to Test** navigation and native source gutter actions.
Locations come from the built binary, so rebuild and refresh after moving a test definition.
Navigation is unavailable when the binary omits source metadata or the reported file cannot be found
locally.

## Run or debug from the editor

Click the run icon beside a test's line number to run it, or right-click the icon for run and debug
actions. In this gutter menu, **Run All Tests** and **Debug All Tests** refer to the test entries
registered at that line. For a single registered case, the action targets that case.

If multiple extensions discover the same test, the gutter menu contains a submenu for each
provider's test entry. For example, **TestMate C++ → …** and **robot_math → …** can represent the
same Google Test case discovered by TestMate and C++ Test Explorer. **Run All Tests** can then run
the case through both providers. Open the desired test entry's submenu to run or debug it through
that provider, or disable the other test extension for this workspace to remove duplicate entries.

Parameterized or typed tests can also have several cases registered at one source line. Choose an
individual case's submenu to target it; C++ Test Explorer supports debugging one case at a time.

## CMake and standalone binaries

CMake discovery uses `ctest --show-only=json-v1` (CTest 3.14+). `gtest_discover_tests`,
`gtest_add_tests`, and direct Google Test registrations are supported. Per-case registrations are
combined when execution settings match. Registered filters are retained; distinct execution
environments stay separate. Native direct CTest entries without Google Test metadata are probed with
`--gtest_list_tests`; script-based non-Google-Test registrations are skipped.

```json
{
  "cppTestExplorer.buildDirectories": ["build", "out/debug"],
  "cppTestExplorer.buildConfiguration": "Debug",
  "cppTestExplorer.executables": [
    {
      "id": "standalone-unit-tests",
      "path": "bin/unit_tests",
      "group": "Standalone",
      "args": ["--application-test-mode"],
      "cwd": ".",
      "env": { "TEST_DATA": "/tmp/test-data" },
      "timeout": 120
    }
  ]
}
```

Set both `buildDirectories` and `sourceRoots` to `[]` for manual-only discovery. Manual IDs must be
unique per workspace folder. Use `package` to associate an explicit entry with a ROS package,
especially for binaries stored outside its build directory. An explicit entry overrides its
equivalent automatic registration, inheriting omitted metadata when unambiguous. Relative paths and
globs are workspace-folder-relative; paths accept `${workspaceFolder}`.

## ROS 2

Defaults are source packages below `src`, colcon builds in `build/<package>`, and automatic sourcing
of `install/setup.bash` when present. Standard `ament_add_gtest` registrations supply executable
arguments, working directory, timeout and environment.

Example `.vscode/settings.json`:

```json
{
  "cppTestExplorer.sourceRoots": ["src"],
  "cppTestExplorer.buildBase": "build",
  "cppTestExplorer.setupScripts": ["/opt/ros/lyrical/setup.bash"],
  "cppTestExplorer.exclude": ["src/vendor", "src/experimental/**"],
  "cppTestExplorer.concurrency": 4,
  "cppTestExplorer.parallelMode": "case"
}
```

Exclusions apply recursively: **every package under an ignored folder is hidden**, even when
packages are nested at different depths. `COLCON_IGNORE` also prunes an entire subtree. Associated
build artifacts and manual entries mapped to those packages remain excluded. Settings do not create
ignore files or change colcon's build selection.

The extension runs Google Test executables directly. It does not build your code, reproduce CTest
fixtures/resource allocation/custom wrappers, or write colcon result artifacts. Run `colcon test`
separately when you need those orchestration features.

## Settings

All settings are workspace-scoped and can be set per workspace folder. Relative paths and globs are
resolved against the workspace folder and accept `${workspaceFolder}`.

### CMake and manual discovery

| Setting (`cppTestExplorer.` prefix) | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `buildDirectories`                  | `["build"]` | Ordinary CMake build directories, relative to the workspace folder, for projects that do not use colcon. Each one must contain a `CTestTestfile.cmake`. Colcon package build directories are found through `buildBase` and do not need to be listed here. Set to `[]` together with `sourceRoots` for manual-only discovery through `executables`.                                                                                                                                               |
| `buildConfiguration`                | `""`        | The configuration name to pass to CTest for multi-configuration generators such as Visual Studio or Ninja Multi-Config, for example `Debug` or `Release`. Leave empty for single-configuration builds.                                                                                                                                                                                                                                                                                           |
| `ctestPath`                         | `"ctest"`   | The CTest program used to read test metadata from build directories. Set this to a full path when CTest 3.14 or newer is not on the extension host `PATH`.                                                                                                                                                                                                                                                                                                                                       |
| `executables`                       | `[]`        | Test binaries registered by hand, for cases where CMake or colcon discovery is not available. Each entry needs a unique `id` and a workspace-relative `path`, and may set a display `group`, a ROS `package` to associate with, extra `args`, a working directory `cwd`, an `env` map, a `timeout` in seconds and a per-executable `testGrouping`. An entry with the same binary as an automatic registration overrides it. See [CMake and standalone binaries](#cmake-and-standalone-binaries). |
| `exclude`                           | `[]`        | Workspace-relative folder globs to leave out of discovery. Every package below a matching folder is hidden, along with its build artifacts and any manual entries mapped to it. Folders containing a `COLCON_IGNORE` file are skipped as well.                                                                                                                                                                                                                                                   |

### Execution

| Setting (`cppTestExplorer.` prefix) | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`                       | `0`      | How many test processes may run at the same time, shared across every run request. `0` uses the number of CPU cores available to VS Code. Any positive number sets a fixed limit. When a workspace has several folders with different values, the smallest one wins.                                                                                                                         |
| `parallelMode`                      | `"case"` | How selected tests are split into processes. `"case"` starts a separate process for every test case, which gives the best isolation. `"executable"` runs all selected cases of one binary in a single process, so binaries run in parallel with each other. `"batch"` divides each binary's selected cases evenly across the concurrency limit; see [Batched execution](#batched-execution). |
| `discoveryTimeout`                  | `30`     | How many seconds discovery may take before it is abandoned. This covers listing tests from each binary and sourcing setup scripts.                                                                                                                                                                                                                                                           |
| `timeout`                           | `null`   | How many seconds a test process may run before it is killed and reported as failed. `null` uses the timeout registered with CTest, or 60 seconds if none exists. `0` disables the timeout entirely. A `timeout` on an explicit `executables` entry always overrides this value. In batch mode the timeout applies to the whole batch process.                                                |
| `runDisabled`                       | `false`  | Whether to execute tests that Google Test marks as disabled, such as `DISABLED_` prefixed cases. When `false`, disabled tests still appear in the Test Explorer but are skipped during ordinary runs. Debugging a disabled test directly always runs it, regardless of this setting.                                                                                                         |
| `env`                               | `{}`     | Extra environment variables for discovery, running and debugging, as a map of names to values. These are applied after the sourced scripts and the CTest or ament environment, so they override values from those sources. An `env` on an explicit `executables` entry is applied after this one.                                                                                            |

### Debugging and display

| Setting (`cppTestExplorer.` prefix) | Default                   | Description                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug`                             | `{"lldb":{},"cppdbg":{}}` | Extra launch configuration properties merged into the debug session for each debugger adapter. Use `lldb` for CodeLLDB and `cppdbg` for the Microsoft C++ extension. Typical overrides are `miDebuggerPath`, `sourceFileMap`, `sourceMap` or `terminal`. The program, arguments, working directory, environment and build task are managed by the extension and cannot be overridden. |
| `testGrouping`                      | `{}`                      | Optional sub-grouping: suite (default), `groupBySourceFolder`, or `groupBySplittedTestName` with a literal or regex `splitBy`. See [Test grouping](#test-grouping).                                                                                                                                                                                                                   |
| `testGroupByMode`                   | `executable` (default)    | Top-level grouping: `namespace`, `executable`, or `name`.                                                                                                                                                                                                                                                                                                                             |

### ROS 2

| Setting (`cppTestExplorer.` prefix) | Default   | Description                                                                                                                                                                                                           |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceRoots`                       | `["src"]` | Folders, relative to the workspace folder, that are scanned for ROS 2 packages. Every folder containing a `package.xml` below these roots is treated as a package. Set to `[]` to disable ROS package discovery.      |
| `buildBase`                         | `"build"` | The colcon build base, matching colcon's `--build-base` option. Each discovered package is expected to have its build directory at `<buildBase>/<package name>`, which is where its test registrations are read from. |
| `setupScripts`                      | `[]`      | Bash scripts to source, in order, before the workspace setup script. Typically this is the ROS distribution setup such as `/opt/ros/lyrical/setup.bash`. Paths may be absolute or workspace-relative.                 |
| `autoSourceWorkspace`               | `true`    | Whether to automatically source `install/setup.bash` from the workspace folder when it exists. This gives tests the ROS 2 environment for the built workspace. It runs after any configured `setupScripts`.           |

Environment order: extension host → ordered setup scripts → workspace setup → CTest/ament
environment → workspace `env` → explicit executable `env`. Discovery, running and debugging use this
environment. The extension manages selection, sharding and output-related Google Test flags. Debug
overrides cannot replace the selected target, filter, working directory, environment or run build
tasks.

Cancellation stops queued work and terminates owned process groups. Result XML files are unique per
invocation and removed afterward. Missing results, crashes and timeouts cannot appear as successful
tests. Use concurrency `1` if tests share external resources, ports or ROS node names.

## Development container

Choose **Dev Containers: Reopen in Container**. The image uses **ROS 2 Lyrical** and the default
**`ubuntu` user**. It includes Node 22, CMake, Google Test, colcon, GDB, Git, GitHub CLI, Codex and
Claude Code. Both debugger extensions are installed. The post-create command installs dependencies
and compiles the extension. Press **F5** to open an Extension Development Host.

The absolute project path is preserved inside the container to retain project history associations.
The following host paths are bind-mounted into the corresponding locations under `/home/ubuntu`:

| Host path        | Access / purpose                                                   |
| ---------------- | ------------------------------------------------------------------ |
| `~/.ssh`         | Read-only SSH keys and known hosts                                 |
| `~/.config/gh`   | Read/write GitHub CLI configuration                                |
| `~/.claude`      | Read/write Claude settings and session history                     |
| `~/.claude.json` | Read/write Claude sign-in and project state                        |
| `~/.codex`       | Read/write Codex configuration, file credentials and session state |

Data stays on the host across container rebuilds. File-backed authentication is shared; credentials
held only in the host OS keyring may still require container sign-in. Custom
`CODEX_HOME`/`CLAUDE_CONFIG_DIR` locations or absolute host-home paths in tool configurations
require corresponding adjustments. See
[Codex state locations](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations)
and [Claude configuration locations](https://code.claude.com/docs/en/settings).

Mount sources must exist before opening the container. On a new machine, initialize the tools first,
or create empty directories and a valid empty `.claude.json` if no file exists. Credentials are
never embedded in the image or overwritten by its build. Container debugging uses `SYS_PTRACE` and
an unconfined seccomp profile.

## Build and validation

```bash
npm ci
npm test
npm run compile
npm run test:extension       # needs a display; downloads VS Code if needed
./build-vsix.sh
```

On headless Linux use `xvfb-run -a npm run test:extension`. `CPP_TEST_VSCODE_PATH` can point to an
existing VS Code executable. To include real breakpoint checks, set `CPP_TEST_DEBUG_EXTENSIONS` to a
colon-separated list of installed CodeLLDB and cpptools extension directories. These checks run in
an isolated VS Code profile.

The ordinary suite builds a real CMake Google Test fixture in a temporary directory and tests
discovery, results, both scheduling modes, crashes, cancellation, setup scripts and simulated ament
metadata.

The **real ROS 2 colcon fixture** lives in `test/fixtures/ros2`. It contains `robot_math`,
`robot_geometry`, `vendor/ignored_sensor`, plus two packages at different depths under
`hidden/COLCON_IGNORE`. Run:

```bash
source /opt/ros/lyrical/setup.bash
npm run test:ros
```

This copies the fixture into a temporary workspace, builds with colcon, and checks actual ament
discovery, package grouping, parameterized tests, environment, working directory, all parallel
modes, exclusions, and that both hidden packages were never built. Temporary builds are removed
afterward. CI runs the ordinary and extension-host suites plus a ROS 2 Lyrical colcon job.

To explore the fixture manually:

```bash
cd test/fixtures/ros2
colcon build --cmake-args -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=Debug
code .
```

Set `"cppTestExplorer.exclude": ["src/vendor"]` to hide the built sensor package. The two packages
below `hidden/COLCON_IGNORE` intentionally fail configuration if colcon tries to build them.

## Code formatting

Run `npm run format` to format supported source, test, configuration, and documentation files with
Prettier. Run `npm run format:check` to check formatting without changing files; CI runs this check
too. Generated output and build directories are excluded in `.prettierignore`.

## Batched execution

Use round-robin batching to distribute one binary's selected tests across the shared process limit:

```json
{
  "cppTestExplorer.parallelMode": "batch",
  "cppTestExplorer.concurrency": 8
}
```

For 1,000 runnable cases and concurrency 8, the extension normally launches 8 processes with 125
tests each. Cases are assigned in round-robin order: the first case goes to the first group, the
second to the second group, and so on. Each executable is split separately, while the concurrency
limit is shared across all executables and requests. Very long test filters may require additional
processes to stay within command-line limits.

There is no batch-size setting. Disabled cases are skipped before grouping unless enabled. Results
and output remain associated with individual cases. The timeout applies to each whole batch process.
Stop cancels queued batches and terminates active batch processes. Debugging still runs one selected
case. The default execution mode remains `"case"`.

## Test grouping

`cppTestExplorer.testGroupByMode` selects the hierarchy below the workspace:

| Mode                   | Hierarchy                                                |
| ---------------------- | -------------------------------------------------------- |
| `namespace`            | C++ namespace → nested namespace → suite → case          |
| `executable` (default) | CMake project or ROS package → executable → suite → case |
| `name`                 | CMake project or ROS package → split test name           |

In `namespace` mode, tests declared inside `namespace delta_control { namespace testing { ... } }`
appear under **delta_control → testing**. Namespaces are read from each test definition's source
location. Global-scope tests appear under **Global namespace**; unavailable source metadata appears
under **Unknown namespace**. This is lexical source scanning, so macro-generated namespaces and
conditional compilation may not be resolved. Grouping preserves execution names and source
navigation.

All modes support split-name grouping. In `name` mode the default separator is `.`.

To split suite names into a custom hierarchy while preserving snake-case case names:

```json
{
  "cppTestExplorer.testGrouping": {
    "groupBySplittedTestName": {
      "splitBy": "`(?<!\\.[^.]*)_(?=[A-Z])|\\."
    }
  }
}
```

This displays `Functions_Generic_Constraints.numeric_accepts_integer` as **Functions → Generic →
Constraints → numeric_accepts_integer**. `splitBy` is a literal separator unless it starts with a
backtick, which makes the remainder a JavaScript regular expression. Its default is `"."`.

Use `"cppTestExplorer.testGrouping": { "groupBySuite": {} }` for the original suite grouping, or
`{}` for the default suite grouping. Use `{ "groupBySourceFolder": {} }` for source folders. Select
only one strategy. Explicit entries in `cppTestExplorer.executables` can override the workspace
strategy with their own `testGrouping` object using the same format, and can override
`testGroupByMode`.

## How it Works

The extension connects your already-built Google Test programs to VS Code's Testing view. It runs in
the workspace environment, so with Remote SSH, WSL or a dev container, discovery and test processes
run there too.

1. **Find test programs.** For each workspace folder, the extension checks the directories in
   `cppTestExplorer.buildDirectories`, which defaults to `["build"]`. For example, opening
   `/work/project` makes it check `/work/project/build/CTestTestfile.cmake`. CMake generates this
   file for tests registered with CTest, including through `gtest_discover_tests`, `gtest_add_tests`
   or `add_test`.

   When that file exists, the extension runs `ctest --show-only=json-v1` with the build directory as
   its working directory. This asks CTest to describe its registered tests without running them. The
   JSON response contains each test's command and properties. For a direct command such as
   `/work/project/build/math_tests --gtest_filter=Math.Add`, the extension takes
   `/work/project/build/math_tests` as the executable path and remembers the filter. It also reads
   arguments, working directory, environment variables and timeout from the registration. Entries
   for the same executable are combined when their execution settings match.

   Programs listed in `cppTestExplorer.executables` are added using the `path` you supply; a
   relative path such as `bin/math_tests` resolves to `/work/project/bin/math_tests`. This is how
   you expose a binary that is not registered with CTest. An explicit entry can also override a
   matching automatic registration. Missing binaries are skipped until they have been built.

   For ROS projects, the extension additionally searches `cppTestExplorer.sourceRoots` (default
   `src`) for `package.xml` files, reads each package's name and checks
   `<buildBase>/<package name>/CTestTestfile.cmake` (for example,
   `build/my_robot/CTestTestfile.cmake`). It uses the same CTest command there. For supported ament
   Google Test registrations, it extracts the binary and arguments after the wrapper's `--command`
   option. Excluded package folders and folders containing `COLCON_IGNORE` are skipped along with
   their subfolders.

2. **Prepare the environment.** The extension copies the environment variables of the VS Code
   extension host, including `PATH` and `LD_LIBRARY_PATH`. It applies CTest's `ENVIRONMENT` and
   `ENVIRONMENT_MODIFICATION` properties, then `cppTestExplorer.env`, then any `env` on the explicit
   executable entry. Later assignments override earlier ones. For example, an explicit entry with
   `"env": { "TEST_DATA": "/tmp/data" }` makes that binary see `TEST_DATA=/tmp/data` during
   discovery, running and debugging.

   If `cppTestExplorer.setupScripts` lists scripts, the extension first launches Bash, sources them
   in order and captures the resulting variables with `/usr/bin/env -0`. Those variables become the
   base for the overrides above. For ROS workspaces, `install/setup.bash` is sourced after the
   configured scripts when it exists and `autoSourceWorkspace` is enabled; environment changes from
   the ament wrapper are applied before the user overrides. Before launching Google Test, the
   extension removes inherited controls such as `GTEST_FILTER`, `GTEST_OUTPUT`, `GTEST_REPEAT` and
   sharding variables so they cannot change the selected tests or result destination.

3. **Ask each program for its tests.** The extension launches the discovered executable with its
   application arguments plus `--gtest_list_tests`, `--gtest_color=no` and
   `--gtest_output=xml:<temporary listing file>`. For example:

   ```bash
   /work/project/build/math_tests --gtest_list_tests --gtest_color=no --gtest_output=xml:/tmp/example-list/tests.xml
   ```

   The temporary directory in this example stands in for a unique directory created by the
   extension. Google Test prints suite names followed by indented case names; a `Math.` suite
   containing `Add` becomes the test name `Math.Add`. Test bodies do not run during listing. If
   CTest registered only particular filters, the extension keeps only the matching cases. A binary
   that fails to list tests, exceeds `cppTestExplorer.discoveryTimeout` or returns no cases is left
   out of the tree. Discovery errors appear in **Show Discovery Output**.

   When the listing XML includes `file` and `line` attributes, the extension matches them to those
   test names. Relative source paths are checked against the test's working directory, binary
   directory and workspace folder; for ROS tests, the package source directory is also checked. A
   location is attached only when it resolves to one existing file. VS Code uses it for **Go to
   Test** and gutter actions. The extension then registers the tests in the native Testing view,
   grouped by the selected `testGroupByMode` and `testGrouping` settings, and deletes the temporary
   listing. Tests without usable locations still appear and can run.

4. **Run the selected cases.** Selecting a suite or folder expands to its individual test cases;
   excluded selections are removed. Disabled cases are reported as skipped unless
   `cppTestExplorer.runDisabled` is enabled. The extension then groups the remaining names using
   `cppTestExplorer.parallelMode`: `case` creates one process per case, `executable` puts a binary's
   selected cases in one process, and `batch` distributes them round-robin across process slots.
   Very long name lists are split again to fit command-line limits.

   For example, running `Math.Add` and `Math.Subtract` together launches the binary with
   `--gtest_filter=Math.Add:Math.Subtract`, `--gtest_output=xml:<unique result file>` and
   `--gtest_color=no`, alongside its application arguments. Each process uses the environment from
   step 2 and its registered working directory. Without a working-directory override, a CTest entry
   uses its build directory and a manual entry uses its binary's directory, unless it inherits a
   working directory from a matching automatic registration.

   All run requests share a process queue controlled by `cppTestExplorer.concurrency`. For example,
   a limit of `4` allows four test processes at once; the rest wait. The default `0` uses available
   CPU cores, and the smallest configured limit wins in a workspace with multiple folders. The
   extension launches the binaries itself; this step does not invoke CTest or build the project.

5. **Show output and results.** While a process runs, the extension sends its standard output and
   standard error to Testing output. It recognizes Google Test lines such as `[ RUN      ] Math.Add`
   and `[       OK ] Math.Add` to associate output with the active case. Output outside a case is
   attached to the executable.

   After the process exits, the extension reads its XML result file. Each `<testcase>` supplies the
   name and duration; failure details mark it failed, skip markers mark it skipped, and a completed
   case without either is marked passed. These results update the icons, timing and failure messages
   in VS Code. A missing or unreadable file, or a selected case absent from it, produces an error.
   The extension also checks the exit code, termination signal and timeout so a crashed or
   interrupted process cannot silently count as a successful run. Temporary result files are deleted
   after processing.

   Each process has a timeout from the explicit executable's `timeout`, then
   `cppTestExplorer.timeout`, then the CTest timeout, falling back to 60 seconds. A value of `0`
   disables it. In batch mode this limit covers the whole batch. On timeout or cancellation, the
   extension sends `SIGTERM` to the process group, followed by `SIGKILL` if needed. Cancelling also
   prevents waiting jobs from starting.

6. **Debug one case.** Choosing **Debug** for `Math.Add` creates a launch configuration with the
   binary as `program`, a `--gtest_filter=Math.Add` argument, a temporary XML result path, and the
   same working directory and environment used for ordinary runs. The extension asks VS Code to
   launch it through the installed CodeLLDB (`lldb`) or C++ / GDB (`cppdbg`) adapter. Debugging a
   disabled case adds `--gtest_also_run_disabled_tests` so that case can still run.

   Properties from `cppTestExplorer.debug.lldb` or `.cppdbg`, such as source mappings, are merged
   into the launch configuration. The extension keeps control of the program, test selection,
   working directory and environment. Debugger output goes to its Debug Console or terminal. When
   the debug session ends, the extension reads the case's XML result into the Testing view and
   removes the temporary files. Cancelling asks VS Code to stop that debug session.

7. **Refresh the test list.** The extension watches discovered binary paths and metadata such as
   `CTestTestfile.cmake`, `CMakeCache.txt` and generated `*Tests.cmake` files, along with configured
   setup scripts. For ROS workspaces it also watches `package.xml`, `COLCON_IGNORE` and
   `install/setup.bash`. Creating, changing or deleting relevant files schedules another discovery
   pass. Changes to `cppTestExplorer` settings or workspace folders also schedule a refresh.

   Nearby changes are combined into one refresh, and automatic refreshes wait until active runs
   finish. The next discovery pass repeats the CTest queries and Google Test listings, then updates
   the tree while reusing existing test entries where possible. Run requests reuse the last
   completed discovery while settings remain unchanged. After a build, **C++ Test Explorer: Refresh
   Tests** lets you request discovery explicitly. Moving a test in a source file requires rebuilding
   its binary and refreshing before the stored source location can change.
