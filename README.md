# dsh-gitbash

<p align="center">
  <b>给 DSH 在 Windows 上装一个真正的 bash 工具：调用 bash 不用再经过 pwsh 转义，告别转义地狱。</b>
</p>

<p align="center">
  <a href="README.en.md">English</a> · <b>中文</b>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square">
  <img alt="harness" src="https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square">
  <img alt="deps" src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square">
</p>

---

## 这个插件解决什么

**DSH 在 Windows 上把 shell 写死了只能用 PowerShell。** 工具列表里根本没有 bash 这个工具，于是模型想跑一段 bash，只能绕道：

```powershell
# 真实写照：命令必须穿过 PowerShell 和 bash 两层解析
& "C:\Program Files\Git\bin\bash.exe" -lc "echo \"dollar=\$HOME\" ; ls *.ts | head -3"
```

引号、反斜杠、`$`、单引号在两套规则里含义不同，写对一次全靠运气。**装本插件之后，同样的命令长这样：**

```bash
echo "dollar=$HOME"; ls *.ts | head -3
```

命令字符串直达 `bash -c`，只按 bash 的规则解释一遍。

---

## 四个优势

| # | 优势 | 说明 |
|---|---|---|
| 1 | **无需新增或切换预设** | 装到 profile 一层即可，`ptc` / `standard` / `cordis` 等预设都不用动，所有会话直接生效。 |
| 2 | **直接进入可调用工具列表** | native 呈现下多出一个 `bash` 函数定义；PTC 呈现下自动多出一个 `tools.bash(...)` 绑定。不需要写任何包装工具。 |
| 3 | **无需额外转义，直调 bash** | 不再需要 `pwsh -Command` 套一层，少一层解析就少一类事故：`$(...)`、通配符、单引号字面量、反斜杠全部按 bash 规则工作。 |
| 4 | **bash 与 PowerShell 由模型自选** | 两者并存、互不影响：跑命令、管道、`grep`/`sed`/`find`/脚本走 bash；注册表、服务、进程句柄、Windows 原生路径继续走 pwsh。 |

---

## 装上前后对比

| | 装之前 | 装之后 |
|---|---|---|
| 工具目录 | 只有 `pwsh`（bash 被平台开关关掉了） | `pwsh` + `bash` |
| 跑 bash 的路径 | pwsh → bash（两层解析） | bash（一层） |
| 需要改预设吗 | —— | 不需要，profile 层装一次即可 |
| pwsh 是否受影响 | —— | 完全不受影响，照旧可用 |

---

## 安装

> `--profile` 后面换成你实际使用的 profile 名（Web 界面默认是 `web`）。

### 方式一：GitHub Release tarball

```powershell
dsh plugin --profile web add "https://github.com/Fishquito7/dsh-gitbash/releases/latest/download/dsh-git-bash.tgz"
```

`releases/latest/download/` 永远指向最新一版。要锁版本就换成带 tag 的地址，例如：

```text
https://github.com/Fishquito7/dsh-gitbash/releases/download/v0.1.0/dsh-git-bash-0.1.0.tgz
```

> **备选：直接从 GitHub 仓库安装**
>
> ```powershell
> dsh plugin --profile web add "github:Fishquito7/dsh-gitbash"
> ```
>
> 这条路会直接走 pnpm 的依赖流程，部分环境会因为构建脚本策略被拒（pnpm 报 `ignored build scripts` 之类）。装不上就回到方式一。

### 方式二：本地安装

已经手动下载了 tarball，或者要装本地源码目录：

```powershell
# 本地 tarball
dsh plugin --profile web add "file:C:/path/to/dsh-git-bash-0.1.0.tgz"

# 本地源码目录（边改边试）
dsh plugin --profile web add "file:C:/path/to/dsh-gitbash"
```

### 然后重启 DSH

新装的 bundle 属于"新模块根"，**不在热重载范围**，必须重启 host 才会出现 `bash` 工具。

### 验证

重启后看一眼插件面板：`git-bash-executor` 与 `git-bash-tool` 都应为"运行中"。再让模型跑一下：

```bash
echo "argv0=$0"; uname -s; echo "bash=$BASH_VERSION"
# 期望：/usr/bin/bash、MINGW64_NT-...、bash 5.x
```

---

## 卸载与回滚

```powershell
dsh plugin --profile web remove dsh-git-bash
# 然后重启 DSH
```

面板里出现异常时，也可以只关掉 `git-bash-executor` / `git-bash-tool` 两个开关再重启 —— 工具与执行器是分离的。

---

## 配置

| 项 | 说明 |
|---|---|
| `DSH_GIT_BASH` | Git Bash 可执行文件的绝对路径。默认 `C:\Program Files\Git\bin\bash.exe`。 |
| 行 `config` | 沿用上游 `dsh-bash-local` 的全部字段：`cwd`、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs`。 |

---

## 原理

**工具只负责"暴露能力"，真正执行命令的是 `ctx.shell` 这个服务；而一个进程里 `ctx.shell` 只能绑一个实现，所以我们用一个 `isolate` 隔离作用域来放第二份绑定。**

拆开看是三件事：

**① 工具只暴露，不执行。**
工具（tool）本质是一张"说明书"：叫什么名字、有哪些参数、怎么渲染结果。它内部只会写一句 `ctx.shell.run(...)`，把命令交出去。**它完全不知道底下是 bash 还是 PowerShell。**

**② 真正干活的是 `ctx.shell`，而它被绑死了。**
DSH 里的 `shell` 是一个服务。Windows 上它被绑死到 PowerShell 执行器，同时 bash 工具被平台开关关掉 —— 所以你看到的工具列表里只有 `pwsh`。
而且一个 DSH 进程里，**同一个服务名只允许一个实现**，硬挂第二个会直接报错。这就是"不能简单再加一个 bash"的原因。

**③ 我们的做法：用一个 `isolate` 隔离作用域，做第二份绑定。**
`isolate` 是组合里声明**隔离作用域**的写法（直观理解就是「一个小盒子」）：在**隔离作用域**内，`shell` 这个名字**重新绑到另一个实现** —— **名字没变，只是绑的键不同**；隔离作用域之外完全不受影响。
隔离作用域里我们放两样东西：

1. 一个"把命令交给 Git Bash 执行"的执行器 —— 本插件新增，核心约 20 行；
2. **上游原版**的 bash 工具 —— 零改动。它照旧只写 `ctx.shell.run(...)`，只不过在隔离作用域里，这句话落到了 Git Bash 上。

```text
宿主（原样不动）    tool-pwsh ──► ctx.shell（宿主作用域）  = PowerShell 执行器
isolate 隔离作用域  tool-bash ──► ctx.shell（隔离作用域）  = Git Bash 执行器   ← 本插件新增
                    ↑ 上游代码零改动      ↑ 同一个服务名，两份不同的 isolate 绑定
```

**结果就是两个工具、两份绑定、互不干扰**：原版 `tool-pwsh` 指向**宿主的 `ctx.shell`**（PowerShell 执行器），我们新增的 `tool-bash` 指向**隔离作用域里的 `ctx.shell`**（Git Bash 执行器）—— 同一份工具代码，绑在不同的 isolate 上，就得到两个不同的 shell。

**为什么不干脆重写一个 bash 工具？** 因为上游那个工具的逻辑很厚：参数校验、超时、输出截断与落盘、后台任务与作业接线、`[stderr]` 与 `[exit code: N]` 渲染。而它本来就是"只认 `ctx.shell`、不认具体 shell"的设计 —— 换掉它脚下的服务，它就自动变成 bash 工具。少写几百行，也永远不会和上游漂移。

---

## 边界与已知限制

- **不经过文件沙箱**：命令以 DSH 进程自身的权限执行，不会产生 `[sandbox: file access denied]` 之类的提示。原因很实际 —— Git Bash 是 MSYS2 进程，在 Windows 受限令牌下需要 fork、管道与私有临时目录，行为不可靠，因此有意不接沙箱。
- **依赖上游内部接口**：执行器复用了上游 `dsh-bash-local` 提供的 argv 替换缝。若 DSH 大版本改动该接口，需要同步更新本插件。
- **`file:` 依赖是拷贝，不是软链**：改完代码后要 `remove` → `add` → 重启才会生效。
- **仅 Windows 需要**：POSIX 平台上 DSH 本来就有 bash 工具，装这个插件没有意义。

---

## 常见问题

**Q：面板里的执行器和工具两行，需要都开着吗？**
需要。执行器提供 shell 服务，工具消费它。只关执行器的话，bash 工具会因为等不到服务而消失（不是报错，而是 pending）。

**Q：装完工具没出现？**
按顺序检查：① 是否重启过 DSH；② 两行是否都在运行中；③ `dsh --profile web --dump-config` 是否能正常输出组合（退出码 0）。

**Q：会顶掉 pwsh 吗？**
不会。隔离作用域只影响 `shell` 这一个名字，且只在隔离作用域内生效。实测两者可以同时使用。

**Q：为什么默认用 Git Bash，而不是 WSL 的 bash？**

因为 Git Bash 是**原生 Windows 进程**，而 WSL 的 bash 是另一个内核里的 Linux 进程。对「在 Windows 工作区里跑命令」这件事，前者才是对的工具：

| | Git Bash（本插件） | WSL bash |
|---|---|---|
| 进程形态 | 原生 Windows 进程（MSYS2 运行时） | Linux 进程，跑在 WSL 的 Linux 内核上 |
| 工作区路径 | `C:\...\proj` ↔ `/c/.../proj`，**同一个目录** | 要写成 `/mnt/c/...`，`$HOME` 是 Linux 家目录 |
| 与 DSH 文件工具（`read`/`edit`/`glob`） | 操作**同一批文件**，路径模型一致 | 路径模型分裂，模型要自己翻译路径 |
| 文件 I/O | 原生 NTFS | `/mnt/c` 走转发，小文件密集操作明显更慢 |
| 真 Linux 工具链 | ✗ 无 fork / apt / systemd，MSYS 还会改写形似路径的参数 | ✅ 完整 |

顺带这也解释了上游为什么直接在 win32 上禁用 `dsh-bash-local`：裸 `bash` 在 Windows 上语义并不明确 —— 可能是 WSL 启动器，也可能根本不存在。

**Q：想换成别的 bash 怎么办？**
设置环境变量 `DSH_GIT_BASH` 指向任意 bash 可执行文件即可。

---

## 开发

```text
dsh-gitbash/      # 仓库名；包名仍是 dsh-git-bash
├─ cordis.patch.yml   # 组合补丁：隔离作用域 + 两行声明
├─ lib/index.js       # 执行器插件（核心约 20 行）
├─ test/harness.mjs   # 离线验证脚本（真实 cordis 驱动，无需启动 DSH）
├─ package.json       # 零依赖
└─ README.md
```

离线验证（本包需先位于某个 profile 的解析链上，例如已安装到 `$DSH_HOME/profiles/web/node_modules/`）：

```bash
node test/harness.mjs
```

脚本会检查：宿主 shell 未被顶替、隔离作用域内解析到本执行器、设置段零重复注册、真实 Git Bash 身份、通配符与 `$(...)` 展开、退出码透传、stderr 分离。

打包：

```bash
npm pack   # 产出 dsh-git-bash-0.1.0.tgz
```

---

## 许可

[MIT](LICENSE)
