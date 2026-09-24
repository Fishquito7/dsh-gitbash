# dsh-gitbash

<p align="center">
  <b>A real bash tool for DSH on Windows: call bash directly, with no pwsh escaping and no quoting hell.</b>
</p>

<p align="center">
  <b>English</b> · <a href="README.md">中文</a>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square">
  <img alt="harness" src="https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square">
  <img alt="deps" src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square">
</p>

---

## What this plugin solves

**On Windows, DSH hard-wires its shell to PowerShell.** There is no bash tool in the catalog at all, so whenever a model wants to run bash it has to go the long way around:

```powershell
# The reality: the command has to survive two parsers
& "C:\Program Files\Git\bin\bash.exe" -lc "echo \"dollar=\$HOME\" ; ls *.ts | head -3"
```

Quotes, backslashes, `$` and single quotes all mean different things in the two dialects, so getting it right is largely luck. **After installing this plugin, the same command looks like this:**

```bash
echo "dollar=$HOME"; ls *.ts | head -3
```

The command string goes straight to `bash -c` and is parsed by bash rules exactly once.

---

## Four advantages

| # | Advantage | Details |
|---|---|---|
| 1 | **No new preset required** | Install once at the profile layer; `ptc`, `standard` and `cordis` presets stay untouched and every session picks it up. |
| 2 | **Lands directly in the callable tool list** | Native presentation gains a `bash` function definition; PTC presentation automatically gains a `tools.bash(...)` binding. No wrapper tool to write. |
| 3 | **No extra escaping, bash called directly** | The `pwsh -Command` hop disappears, and with it a whole class of accidents: `$(...)`, globs, single-quoted literals and backslashes all behave as bash defines them. |
| 4 | **The model chooses bash or PowerShell** | Both coexist without interfering: commands, pipes, `grep`/`sed`/`find` and scripts go to bash; the registry, services, process handles and native Windows paths stay on pwsh. |

---

## Before and after

| | Before | After |
|---|---|---|
| Tool catalog | `pwsh` only (bash is disabled by a platform gate) | `pwsh` + `bash` |
| Path to bash | pwsh → bash (two parsers) | bash (one parser) |
| Preset changes | — | None; install once at the profile layer |
| Effect on pwsh | — | None, it keeps working exactly as before |

---

## Install

> Replace `web` with the profile you actually use (the Web UI ships one named `web`).

### Option 1: GitHub Release tarball

```powershell
dsh plugin --profile web add "https://github.com/Fishquito7/dsh-gitbash/releases/latest/download/dsh-git-bash.tgz"
```

`releases/latest/download/` always points at the newest release. To pin a version, use the tag-qualified URL:

```text
https://github.com/Fishquito7/dsh-gitbash/releases/download/v0.1.0/dsh-git-bash-0.1.0.tgz
```

> **Fallback: install straight from the GitHub repository**
>
> ```powershell
> dsh plugin --profile web add "github:Fishquito7/dsh-gitbash"
> ```
>
> This path goes through pnpm directly, and some environments refuse it under their build-script policy (pnpm reports `ignored build scripts` and similar). If that happens, go back to Option 1.

### Option 2: local install

You already downloaded the tarball, or you want to install a local source directory:

```powershell
# a local tarball
dsh plugin --profile web add "file:C:/path/to/dsh-git-bash-0.1.0.tgz"

# a local source directory (while editing)
dsh plugin --profile web add "file:C:/path/to/dsh-gitbash"
```

### Restart DSH

A newly installed bundle is a new module root and is **not hot-reloaded**, so the `bash` tool appears only after a host restart.

### Verify

After the restart, the plugin panel should show `git-bash-executor` and `git-bash-tool` as running. Then ask the model to run:

```bash
echo "argv0=$0"; uname -s; echo "bash=$BASH_VERSION"
# expected: /usr/bin/bash, MINGW64_NT-..., bash 5.x
```

---

## Upgrade

pnpm will not re-fetch a dependency it already has, so upgrade by **removing first**:

```powershell
dsh plugin --profile web remove dsh-git-bash
dsh plugin --profile web add "https://github.com/Fishquito7/dsh-gitbash/releases/latest/download/dsh-git-bash.tgz"
```

Then restart DSH. To pin a version, swap the URL for the tag-qualified form.

---
## Uninstall and rollback

```powershell
dsh plugin --profile web remove dsh-git-bash
# then restart DSH
```

If anything misbehaves, you can instead switch off just the `git-bash-executor` and `git-bash-tool` rows in the panel and restart — the tool and the executor are separable.

---

## Configuration

| Item | Meaning |
|---|---|
| `bashPath` (row `config`) | Explicit absolute path to `bash.exe`; highest priority |
| `DSH_GIT_BASH` | The same override through the environment |
| Row `config` | All upstream `dsh-bash-local` fields are accepted: `cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs` |

**No configuration is needed.** Git can live almost anywhere depending on install flavour (machine-wide, per-user, scoop, chocolatey), so the plugin looks for it in order:

> row `config` `bashPath` → environment `DSH_GIT_BASH` → the `InstallPath` value under `HKLM` / `HKCU` `SOFTWARE\GitForWindows` → `%ProgramFiles%\Git\bin` → `%ProgramFiles(x86)%` → `%ProgramW6432%` → `%LOCALAPPDATA%\Programs\Git\bin` (per-user installs) → scoop → chocolatey → `bash.exe` in each PATH entry, plus `..\bin\bash.exe` next to any `git.exe`.
>
> That last one matters: **Git's installer puts `Git\cmd` on PATH and never `Git\bin`** — which is exactly why a bare `bash` is not found on Windows.
>
> If every candidate fails, the plugin does **not** fall back to WSL's `bash` (a Linux process in another kernel, wrong semantics); it reports an error listing every path it tried.

---

## How it works

In one sentence: **a tool only advertises a capability; the thing that actually runs the command is the `ctx.shell` service — and a process can bind `ctx.shell` only once. So we open a separate `isolate` isolation scope and put a second binding in it.**

Three facts unpack that:

**1. A tool advertises; it does not execute.**
A tool is essentially a specification: its name, its parameters, how its result is rendered. All it does internally is hand the command over with `ctx.shell.run(...)`. **It has no idea whether bash or PowerShell sits underneath.**

**2. `ctx.shell` is what really runs commands, and it is hard-wired.**
`shell` is a service in DSH. On Windows it is hard-wired to the PowerShell executor, and the bash tool itself is switched off by a platform gate — which is why `pwsh` is the only shell tool in the catalog.
On top of that, one DSH process allows **exactly one implementation per service name**; hanging a second one on the same name fails loudly. That is why you cannot simply "add a bash".

**3. Our approach: an `isolate` isolation scope holds the second binding.**
`isolate` is how a composition declares an **isolation scope** (picture a small box): inside that scope the name `shell` is **bound to a different implementation** — **the name is unchanged, only the key behind it differs** — and everything outside the scope is untouched.
Inside the isolation scope we mount two things:

1. an executor that hands commands to Git Bash — added by this plugin, about 30 lines of core code;
2. the **stock upstream bash tool** — zero changes. It still just calls `ctx.shell.run(...)`; inside the isolation scope, that call lands on Git Bash.

```text
host (untouched)   tool-pwsh ──► ctx.shell (host scope)       = PowerShell executor
isolate scope      tool-bash ──► ctx.shell (isolation scope)  = Git Bash executor   ← this plugin
                   ↑ upstream code, unchanged   ↑ same service name, two isolate bindings
```

**The result is two tools, two bindings, no interference**: the stock `tool-pwsh` points at the **host `ctx.shell`** (the PowerShell executor), while the `tool-bash` row we added points at the **isolation-scope `ctx.shell`** (the Git Bash executor) — the same tool code, bound to different isolates, yields two different shells.

**Why not simply rewrite a bash tool?** Because the upstream tool carries a lot of logic: argument validation, timeouts, output truncation and spill files, background jobs and their wiring, `[stderr]` and `[exit code: N]` rendering. Since it is designed to know only `ctx.shell` and nothing about any specific shell, replacing the service under its feet turns it into a bash tool automatically — a few hundred lines saved, and zero drift from upstream.

---

## Boundaries and known limitations

- **No file sandboxing**: commands run with the DSH process authority and never produce `[sandbox: file access denied]`. The reason is practical — Git Bash is an MSYS2 process that needs fork, pipes and a private temp directory, which behaves unreliably under the Windows restricted token, so sandboxing is deliberately not wired in.
- **Bound to one choke point, not to upstream entry-point names**: `dsh-bash-local`'s subclass entry points have already been renamed once (`run`/`start` + `runArgv`/`startArgv` → `execute`/`executeArgv`), yet every execution path still funnels through `spawnSpec(spec, argv, …)` to turn an argv into a spawn config. The plugin swaps the bare `bash` for the resolved Git Bash exactly there, so another rename of an entry point cannot silently fall back to bare `bash`; the named entry points are overridden as a second layer. On first use it also walks the public path (`resolve` → `execute` → `result`) and logs the shell identity — should upstream ever move the choke point too, the log says `self-check FAILED` instead of letting command output come back garbled.
- **Read-only, no environment changes**: resolution only reads the registry and reverse-engineers `PATH`; it never edits `PATH`, the registry or DSH itself, so a DSH upgrade needs no reconfiguration.
- **`file:` dependencies are copies, not symlinks**: after editing the code you must `remove` → `add` → restart for the change to take effect.
- **Windows only**: on POSIX platforms DSH already ships a bash tool, so this plugin has nothing to add.

---

## FAQ

**Q: The panel shows an executor row and a tool row — do I need both?**
Yes. The executor provides the shell service; the tool consumes it. Turning off only the executor makes the bash tool disappear (it becomes pending rather than erroring).

**Q: The tool did not show up after installing.**
Check in order: (1) did you restart DSH; (2) are both rows running; (3) does `dsh --profile web --dump-config` exit cleanly.

**Q: Does it replace pwsh?**
No. The isolation scope only affects the single name `shell`, and only inside the isolation scope. Both tools are verified to work side by side.

**Q: Why Git Bash by default, and not WSL bash?**

Because Git Bash is a **native Windows process**, while WSL bash is a Linux process in another kernel. For "run a command inside a Windows workspace", the former is simply the right tool:

| | Git Bash (this plugin) | WSL bash |
|---|---|---|
| Process | native Windows process (MSYS2 runtime) | Linux process on the WSL kernel |
| Workspace path | `C:\...\proj` ↔ `/c/.../proj`, **the same directory** | must be written `/mnt/c/...`; `$HOME` is a Linux home |
| DSH file tools (`read`/`edit`/`glob`) | operate on **the same files**, one path model | split path model, the model must translate paths |
| File I/O | native NTFS | `/mnt/c` goes through a forwarding layer; small-file work is notably slower |
| Real Linux toolchain | ✗ no fork / apt / systemd, and MSYS rewrites path-looking arguments | ✅ complete |

In one line: **working in a Windows workspace → Git Bash; needing a real Linux environment → run the whole DSH inside WSL** (then the shell, the file tools and the paths are all Linux-native and consistent). "DSH on Windows plus WSL bash" is the worst of both: the shell lives in Linux while the file tools live in Windows.

This also explains why upstream disables `dsh-bash-local` outright on win32: a bare `bash` has no well-defined meaning on Windows — it may be the WSL launcher, or it may not exist at all.

**Q: Git is not installed on C:, or lives somewhere unusual — will the plugin find it?**

Yes. The first link in the chain has nothing to do with install location: Git for Windows registers itself under `HKLM\SOFTWARE\GitForWindows` (`HKCU` for per-user installs) in the `InstallPath` value. The full order is in the Configuration section above. If nothing is found, the error lists every path that was tried and tells you how to set `bashPath` or `DSH_GIT_BASH` explicitly.

**Q: Can I switch to a different bash?**
Set the `DSH_GIT_BASH` environment variable to any bash executable.

---

## Development

```text
dsh-gitbash/      # repository name; the package stays dsh-git-bash
├─ cordis.patch.yml   # composition patch: isolation scope + two rows
├─ lib/index.js       # the executor plugin (~30 lines of core code)
├─ test/harness.mjs   # offline harness driven by a real cordis, no DSH boot needed
├─ package.json       # zero dependencies
└─ README.md
```

Offline verification (the package must already sit on a profile resolution chain, e.g. installed under `$DSH_HOME/profiles/web/node_modules/`):

```bash
node test/harness.mjs
```

The harness checks that the host shell was not replaced, that the isolation scope resolves to this executor, that no settings section is registered twice, that the shell really is Git Bash, that globs and `$(...)` expand, that exit codes propagate, that stderr is separated, that the `spawnSpec` choke point still swaps a bare `bash` for Git Bash (the path taken after an upstream entry-point rename), and what the first-use self-check reports.

Packaging:

```bash
npm pack   # produces dsh-git-bash-0.1.0.tgz
```

---

## License

[MIT](LICENSE)
