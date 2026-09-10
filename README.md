# C++ Test Explorer

<img src="assets/icon.png" alt="C++ Test Explorer logo" width="128">

Google Test support for VS Code's native Testing view, by **Namo Robotics** (`namo-robotics.cpp-test-explorer`). Runs existing C++ test binaries in Linux workspaces, including ROS 2 colcon, CMake/CTest, Remote SSH, WSL and dev containers.

## Install and use

Run `./build-vsix.sh`, then install `cpp-test-explorer-0.1.3.vsix` using **Extensions: Install from VSIX…**. The script installs locked dependencies, compiles and packages the extension. Requires Node 22+ and npm. Optional packaging arguments are forwarded, e.g. `./build-vsix.sh --out /tmp/explorer.vsix`.

Build your C++ project with testing enabled, open its workspace folder, and open VS Code's Testing view. The tree is **Workspace → Package/Project → Executable → Suite → Case**. Run all tests, any group, or a single case using the standard Testing actions.

Select a case to debug with **CodeLLDB** (`vadimcn.vscode-lldb`) or **C++ / GDB** (`ms-vscode.cpptools`). Install the debugger in the remote environment when using Remote SSH, WSL or a container. GDB must also be installed for cpptools. VS Code remembers your chosen default debug profile.

Use **C++ Test Explorer: Refresh Tests** after building if needed. Binaries, discovered metadata, package manifests and setup scripts are watched automatically. **C++ Test Explorer: Show Discovery Output** explains discovery problems. Test stdout/stderr appear in Testing output; debugger output uses its Debug Console or terminal. Test cases with source metadata support **Go to Test** navigation and native source gutter actions. Locations come from the built binary, so rebuild and refresh after moving a test definition. Navigation is unavailable when the binary omits source metadata or the reported file cannot be found locally.

## ROS 2

Defaults are source packages below `src`, colcon builds in `build/<package>`, and automatic sourcing of `install/setup.bash` when present. Standard `ament_add_gtest` registrations supply executable arguments, working directory, timeout and environment.

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

Exclusions apply recursively: **every package under an ignored folder is hidden**, even when packages are nested at different depths. `COLCON_IGNORE` also prunes an entire subtree. Associated build artifacts and manual entries mapped to those packages remain excluded. Settings do not create ignore files or change colcon's build selection.

The extension runs Google Test executables directly. It does not build your code, reproduce CTest fixtures/resource allocation/custom wrappers, or write colcon result artifacts. Run `colcon test` separately when you need those orchestration features.

## CMake and standalone binaries

CMake discovery uses `ctest --show-only=json-v1` (CTest 3.14+). `gtest_discover_tests`, `gtest_add_tests`, and direct Google Test registrations are supported. Per-case registrations are combined when execution settings match. Registered filters are retained; distinct execution environments stay separate. Native direct CTest entries without Google Test metadata are probed with `--gtest_list_tests`; script-based non-Google-Test registrations are skipped.

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

Set both `buildDirectories` and `sourceRoots` to `[]` for manual-only discovery. Manual IDs must be unique per workspace folder. Use `package` to associate an explicit entry with a ROS package, especially for binaries stored outside its build directory. An explicit entry overrides its equivalent automatic registration, inheriting omitted metadata when unambiguous. Relative paths and globs are workspace-folder-relative; paths accept `${workspaceFolder}`.

## Execution settings

| Setting (`cppTestExplorer.` prefix) | Default                   | Behavior                                                                                                                                |
| ----------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`                       | `0`                       | Auto: up to 4 available CPUs. Positive values set a shared process limit. The smallest resolved limit applies in multi-root workspaces. |
| `parallelMode`                      | `"case"`                  | One process per case; `"executable"` parallelizes binaries.                                                                             |
| `discoveryTimeout`                  | `30`                      | Seconds for discovery and sourcing setup files.                                                                                         |
| `timeout`                           | `null`                    | Registered timeout or 60 seconds. `0` disables it. Explicit executable timeout takes precedence.                                        |
| `runDisabled`                       | `false`                   | Show disabled cases but skip ordinary runs; enable to run them. Explicit debugging enables disabled tests.                              |
| `autoSourceWorkspace`               | `true`                    | Source `install/setup.bash` after configured `setupScripts`.                                                                            |
| `env`                               | `{}`                      | Workspace environment overrides.                                                                                                        |
| `ctestPath`                         | `"ctest"`                 | CTest executable.                                                                                                                       |
| `debug`                             | `{"lldb":{},"cppdbg":{}}` | Adapter overrides, e.g. `miDebuggerPath`, `sourceFileMap`, `sourceMap` or `terminal`.                                                   |

Environment order: extension host → ordered setup scripts → workspace setup → CTest/ament environment → workspace `env` → explicit executable `env`. Discovery, running and debugging use this environment. The extension manages selection, sharding and output-related Google Test flags. Debug overrides cannot replace the selected target, filter, working directory, environment or run build tasks.

Cancellation stops queued work and terminates owned process groups. Result XML files are unique per invocation and removed afterward. Missing results, crashes and timeouts cannot appear as successful tests. Use concurrency `1` if tests share external resources, ports or ROS node names.

## Development container

Choose **Dev Containers: Reopen in Container**. The image uses **ROS 2 Lyrical** and the default **`ubuntu` user**. It includes Node 22, CMake, Google Test, colcon, GDB, Git, GitHub CLI, Codex and Claude Code. Both debugger extensions are installed. The post-create command installs dependencies and compiles the extension. Press **F5** to open an Extension Development Host.

The absolute project path is preserved inside the container to retain project history associations. The following host paths are bind-mounted into the corresponding locations under `/home/ubuntu`:

| Host path        | Access / purpose                                                   |
| ---------------- | ------------------------------------------------------------------ |
| `~/.ssh`         | Read-only SSH keys and known hosts                                 |
| `~/.config/gh`   | Read/write GitHub CLI configuration                                |
| `~/.claude`      | Read/write Claude settings and session history                     |
| `~/.claude.json` | Read/write Claude sign-in and project state                        |
| `~/.codex`       | Read/write Codex configuration, file credentials and session state |

Data stays on the host across container rebuilds. File-backed authentication is shared; credentials held only in the host OS keyring may still require container sign-in. Custom `CODEX_HOME`/`CLAUDE_CONFIG_DIR` locations or absolute host-home paths in tool configurations require corresponding adjustments. See [Codex state locations](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations) and [Claude configuration locations](https://code.claude.com/docs/en/settings).

Mount sources must exist before opening the container. On a new machine, initialize the tools first, or create empty directories and a valid empty `.claude.json` if no file exists. Credentials are never embedded in the image or overwritten by its build. Container debugging uses `SYS_PTRACE` and an unconfined seccomp profile.

## Build and validation

```bash
npm ci
npm test
npm run compile
npm run test:extension       # needs a display; downloads VS Code if needed
./build-vsix.sh
```

On headless Linux use `xvfb-run -a npm run test:extension`. `CPP_TEST_VSCODE_PATH` can point to an existing VS Code executable. To include real breakpoint checks, set `CPP_TEST_DEBUG_EXTENSIONS` to a colon-separated list of installed CodeLLDB and cpptools extension directories. These checks run in an isolated VS Code profile.

The ordinary suite builds a real CMake Google Test fixture in a temporary directory and tests discovery, results, both scheduling modes, crashes, cancellation, setup scripts and simulated ament metadata.

The **real ROS 2 colcon fixture** lives in `test/fixtures/ros2`. It contains `robot_math`, `robot_geometry`, `vendor/ignored_sensor`, plus two packages at different depths under `hidden/COLCON_IGNORE`. Run:

```bash
source /opt/ros/lyrical/setup.bash
npm run test:ros
```

This copies the fixture into a temporary workspace, builds with colcon, and checks actual ament discovery, package grouping, parameterized tests, environment, working directory, both parallel modes, exclusions, and that both hidden packages were never built. Temporary builds are removed afterward. CI runs the ordinary and extension-host suites plus a ROS 2 Lyrical colcon job.

To explore the fixture manually:

```bash
cd test/fixtures/ros2
colcon build --cmake-args -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=Debug
code .
```

Set `"cppTestExplorer.exclude": ["src/vendor"]` to hide the built sensor package. The two packages below `hidden/COLCON_IGNORE` intentionally fail configuration if colcon tries to build them.

## Code formatting

Run `npm run format` to format supported source, test, configuration, and documentation files with Prettier. Run `npm run format:check` to check formatting without changing files; CI runs this check too. Generated output and build directories are excluded in `.prettierignore`.
