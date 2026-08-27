# pi-lsp-client

Language Server Protocol integration for the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Faithful port of the LSP tool stack from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent), with shared server pool, refCount lifecycle, idle reaping, typed crash retry, and a `/lsp` inspector.

## Origin

This package is a port of the LSP tools originally written for [oh-my-openagent (omo)](https://github.com/code-yeongyu/oh-my-openagent) by Yeongyu Kim ([@code-yeongyu](https://github.com/code-yeongyu)). The omo source for the tools lives at `src/tools/lsp/` in that repository.

The same author re-licensed the ported source under MIT for distribution in the pi-coding-agent ecosystem. omo itself remains under SUL-1.0; this package's MIT scope covers only the code that ships in this repository. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Quick Demo

```text
> Diagnose my edits.

[lsp_diagnostics]
2 errors in 1 file

src/foo.ts
  14:5  Type 'string' is not assignable to type 'number'.
  27:1  Cannot find name 'unknownVar'.

3 warnings suppressed
```

```text
> Rename `oldFoo` to `newFoo` everywhere.

[lsp_prepare_rename] src/lib.ts:42:7
Rename available at 42:7-42:13 (current: "oldFoo")

[lsp_rename] src/lib.ts:42:7 → "newFoo"
✓ Applied 7 edits to 4 files
  - src/lib.ts
  - src/cli.ts
  - src/main.ts
  - test/lib.test.ts
```

## Installation

The package targets the [`pi`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) coding agent. Pi loads extensions from `~/.pi/agent/extensions/`, project `.pi/extensions/`, or via the `--extension` / `-e` CLI flag.

Pick whichever route fits:

```bash
# 1. From npm (once published)
pi install npm:@code-yeongyu/pi-lsp-client

# 2. From git (once the repository is pushed)
pi install git:github.com/code-yeongyu/pi-lsp-client

# 3. Manual placement (always works)
git clone https://github.com/code-yeongyu/pi-lsp-client ~/.pi/agent/extensions/pi-lsp-client
cd ~/.pi/agent/extensions/pi-lsp-client && npm install

# 4. Dev / one-shot test
pi -e /path/to/pi-lsp-client/src/index.ts
```

After installation, restart pi (or run `/reload` inside an interactive session). The core tools register automatically. Optional tools can be omitted from pi's tool registry with `disabledTools` in `lsp-client.json`.

## Tools

### `lsp_diagnostics`

Diagnose supported source files before running a build. With no arguments, checks source files changed in git. Use explicit paths for a bounded selection or `all: true` for the supported workspace. Errors are shown by default; warning details require `include_warnings: true`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `paths` | `string[]` (optional) | Files and/or directories. Directories are searched recursively and are independent of git state. |
| `all` | `boolean` (optional) | Diagnose the supported workspace. |
| `include_warnings` | `boolean` (optional) | Include warning details. Default `false`. |

### `lsp_goto_definition`

Jump to the definition of the symbol at a given position.

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | `string` (required) | Source file. |
| `line` | `number` (required) | 1-based line number. |
| `character` | `number` (required) | 0-based column. |

### `lsp_find_references`

Find all usages of the symbol at a given position across the entire workspace.

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | `string` (required) | Source file. |
| `line` | `number` (required) | 1-based line number. |
| `character` | `number` (required) | 0-based column. |
| `includeDeclaration` | `boolean` (optional) | Include the declaration itself. Default `true`. |

### `lsp_outline`

Show the structure and full source line ranges of one known source file. Optional `query` is a case-insensitive symbol-name filter.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` (required) | Source file. |
| `query` | `string` (optional) | Symbol-name filter. |

### `lsp_symbols`

Document outline (`scope: "document"`) or workspace-wide symbol search (`scope: "workspace"`, requires `query`).

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | `string` (required) | Source file (used as LSP context). |
| `scope` | `"document" \| "workspace"` (required) | Outline vs search. |
| `query` | `string` (optional) | Symbol name (required for workspace scope). |
| `limit` | `number` (optional) | Max results. Default 200. |

### `lsp_prepare_rename`

Validate that a rename is possible at a given position. Always run this before `lsp_rename`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | `string` (required) | Source file. |
| `line` | `number` (required) | 1-based line number. |
| `character` | `number` (required) | 0-based column. |

### `lsp_rename`

Apply a rename across the workspace. Mutates files. Runs `executionMode: "sequential"` so it never races other mutating tools.

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | `string` (required) | Source file. |
| `line` | `number` (required) | 1-based line number. |
| `character` | `number` (required) | 0-based column. |
| `newName` | `string` (required) | New symbol name. |

## Commands

### `/lsp`

Interactive inspector for the active server pool. Shows server id, root, refCount, pendingWaiters, lastUsedAt, isInitializing, alive, and command. Press `Escape` or `Ctrl-C` to close. In non-interactive mode (no TUI), prints a one-line summary instead.

### `/lsp status`

One-line summary of which servers are installed (no full inspector).

### `/lsp install <serverId>`

Run the documented install recipe for `<serverId>` (whitelisted in `AUTO_INSTALLABLE_SERVERS`). Status footer shows `Installing <id>...` while the install runs. On success, notifies; on failure, shows the install command's stderr tail.

If `<serverId>` is not in the auto-installable whitelist, the command surfaces the manual install hint from `LSP_INSTALL_HINTS` instead of running anything.

### `/lsp warmup <serverId>`

Spawn and initialize an installed server in the current working directory without waiting for any tool call. Useful before a long batch of LSP-driven work to amortize first-call latency.

## Built-in Servers

40+ language servers from omo's `BUILTIN_SERVERS`, including TypeScript (`typescript-language-server`), Python (`pyright`, `basedpyright`, `ruff`, `ty`), Go (`gopls`), Rust (`rust-analyzer`), C/C++ (`clangd`), Ruby (`ruby-lsp`), Bash (`bash-language-server`), YAML (`yaml-language-server`), Lua, Java, PHP, Dart, Swift, Kotlin, Zig, Nix, Haskell, Elixir, OCaml, Terraform, and more.

Each server has an `installed` check (PATH probe + extension probing) and an install hint (`LSP_INSTALL_HINTS`). A subset is auto-installable via `/lsp install <id>` (`AUTO_INSTALLABLE_SERVERS`).

Rust is manual-only: `/lsp install rust` prints the `rust-analyzer` install hint instead of running `rustup`. If `rust-analyzer` exits while loading `rust-src`, repair the active toolchain with `rustup component remove rust-src` and `rustup component add rust-src`, then warm up Rust again.

## Custom Servers / Configuration

Add custom servers by creating either:

- `.pi/lsp-client.json` (project-local, takes priority)
- `~/.pi/lsp-client.json` (user-global)

```jsonc
{
  "disabledTools": ["lsp_prepare_rename"],
  "lsp": {
    "my-server": {
      "command": ["my-lsp", "--stdio"],
      "extensions": [".myext"],
      "priority": 100,
      "env": { "MY_LSP_LOG": "1" },
      "requestTimeoutMs": 60000,
      "initializationTimeoutMs": 180000
    },
    "biome": {
      "disabled": true
    }
  }
}
```

`disabledTools` is merged from project and user configuration and removes those tools from pi's registry entirely. This is useful when a language server advertises a broken or unhelpful operation. Tool names are `lsp_diagnostics`, `lsp_outline`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_prepare_rename`, and `lsp_rename`. The setting is configuration-wide rather than server-specific because pi's tool registry is global for a session; use a project-local config when the policy should apply only to one repository.

`disabled: true` removes a builtin server from resolution. Project config wins over user config. Builtins are the lowest priority (only used when no project/user override exists).

## Lifecycle

- **Lazy spawn.** Servers spawn on first tool call for a matching extension. No eager warmup of the entire registry.
- **Refcount.** Each `withLspClient(...)` call increments refCount on entry and decrements in `finally`. Idle reaping fires only when refCount hits zero AND lastUsedAt is older than the idle timeout.
- **Idle timeout: 5 minutes.** Idle clients are stopped and removed from the pool.
- **Init timeout: 60 seconds by default.** A pending init older than the configured timeout is reaped, even if other callers are waiting on it. Servers can override this with `initializationTimeoutMs` in `.pi/lsp-client.json`; slow built-in servers may provide a larger timeout.
- **Request timeout: 15 seconds by default.** Servers can override this with `requestTimeoutMs` when indexing or analysis is expected to take longer.
- **Abort-aware acquisition.** `getClient(root, server, signal?)` participates in tool cancellation. If the signal aborts before init resolves, the caller is removed from the waiter list; if no callers remain, the initializing client is stopped and removed.
- **Crash retry.** When the JSON-RPC transport throws `LspConnectionClosedError` or `LspProcessExitedError` mid-call, the wrapper evicts the dead client and retries exactly once for idempotent read tools (`diagnostics`, `goto_definition`, `find_references`, `symbols`, `prepare_rename`). Mutating tools (`rename`) are never retried.
- **Tool filtering.** `disabledTools` is evaluated when the extension loads. Disabled tools are not exposed to the model, though internal post-edit diagnostics still use `lsp_diagnostics` directly.
- **Session shutdown is the primary cleanup boundary.** `pi.on("session_shutdown", ...)` starts `disposeDefaultLspManager()` without awaiting language-server shutdown (stops are idempotent, send best-effort protocol messages that may not flush before immediate process termination, and terminate the process immediately), clears the reaper interval, unregisters the process exit fallback, and clears `pi-lsp` status/widget keys. This keeps `/new` responsive while a server is indexing.
- **No raw signal handlers.** No `SIGINT`/`SIGTERM` listeners — those would fight pi's TUI shutdown. Just `process.once("exit", ...)` as a sync fallback for unexpected exits, and the disposer is called from `session_shutdown` so the listener count never grows across `/reload`.

## Cross-Platform Notes

- Subprocess spawning uses `node:child_process.spawn` everywhere. On Windows the spawn helper enables `shell: true` and includes platform-specific path probing (`PATHEXT`, `Path` casing).
- The transport uses `vscode-jsonrpc/node` directly with the spawned process's `stdin`/`stdout` streams. No Bun-specific Web stream adapter.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "LSP server '<id>' is configured but NOT INSTALLED." | Run `/lsp install <id>` if the server is in the auto-installable whitelist, otherwise install it manually using the displayed hint. |
| "No LSP server configured for extension: .ext" | Add a custom entry in `.pi/lsp-client.json` (see [Custom Servers](#custom-servers--configuration)). |
| `rust-analyzer` exited while loading `rust-src` | Run `rustup component remove rust-src` and `rustup component add rust-src` for the active toolchain, then retry the LSP tool or `/lsp warmup rust`. |
| `lsp_rename` did not retry after a server crash | This is by design. Mutating tools never auto-retry to avoid double-applying edits. Re-issue the rename manually. |
| Footer status stuck after `/reload` | File a bug. The `session_shutdown` handler clears `pi-lsp` status/widget keys. If they persist, the cleanup boundary was bypassed. |
| Stale LSP child after `/reload` | Run `/lsp` to inspect the current snapshot. If `getSnapshot()` is empty but a child process is still alive, file a bug — `stopAll()` should have killed it. |

## Development

```bash
git clone https://github.com/code-yeongyu/pi-lsp-client
cd pi-lsp-client
npm install            # install dev + peer dependencies
npm test               # run vitest
npm run typecheck      # strict tsc --noEmit
npm run check          # tsc + biome
pi -e ./src/index.ts   # smoke-test inside a real pi session
```

The test suite uses vitest. Test descriptions follow `#given .. #when .. #then` style; bodies use plain `// given / // when / // then` comments. No `any`, no enums.

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for re-license disclosure relative to omo.

## Related

- [senpi](https://github.com/code-yeongyu/senpi) — the fork/runtime these extensions are extracted from.
- [Ultraworkers Discord](https://discord.gg/PUwSMR9XNk) — community link from the senpi README.
- [Dori](https://sisyphuslabs.ai) — the product powered by senpi under the hood.

## Acknowledgements

- **Yeongyu Kim** ([@code-yeongyu](https://github.com/code-yeongyu)) — author of the original LSP tools in [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent), and of this pi port.
- **Mario Zechner** ([@badlogic](https://github.com/badlogic)) — author of [pi-mono](https://github.com/badlogic/pi-mono) and the pi-coding-agent extension API this package targets.
- **Microsoft** — author of the [vscode-jsonrpc](https://github.com/microsoft/vscode-languageserver-node) transport library used here.
