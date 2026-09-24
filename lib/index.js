/**
 * dsh-git-bash — 在 Windows 上把 DSH 的原生 bash 工具接到 Git Bash。
 *
 * 设计：不自己写工具，复用上游两个现成件——
 *   - @deepseek-ai/dsh-bash-local 的进程机制（超时、输出上限、spill、后台句柄）；
 *   - @deepseek-ai/dsh-tool-bash 的完整工具 schema、渲染与退出码标记。
 * 本插件只做两件事：自己解析 Git for Windows 里 bash.exe 的绝对路径，
 * 并保证上游最终 spawn 的就是它。
 *
 * 替换点为什么放在 spawnSpec：dsh-bash-local 的子类入口换过名字
 * （<=0.1.6 的 run/start + runArgv/startArgv → >=0.1.7-rc.1 的 execute/executeArgv），
 * 但每一条执行路径最后都要经过 spawnSpec(spec, argv, …) 把 argv 落成 spawn 配置。
 * 只依赖这个收口点，就不必跟随上游的入口命名；入口再改，也不会退回裸 bash
 * （在 Windows 上即 System32\bash.exe，一个已经废掉的 WSL 启动器）。
 * 命名过的入口仍然覆盖，作为第二道保险；两道都失效时，首次执行会走一遍
 * resolve → execute → result 的公开路径自检，并把结果写进日志，而不是让错误
 * 悄悄出现在命令输出里。
 *
 * 为什么要解析而不是写死路径：Git for Windows 的安装位置取决于安装方式与用户习惯
 * （机器级 / 用户级 / scoop / chocolatey），而且 git 安装器默认只把 Git\cmd 放进 PATH，
 * 从不放 Git\bin —— 所以裸 bash 在 Windows 上要么找不到，要么撞上 WSL 的启动器。
 *
 * 解析优先级：行 config 的 bashPath → 环境变量 DSH_GIT_BASH → 注册表 InstallPath
 *   → 常见安装位置 → PATH 反推（git.exe 同级的 ..\bin）。
 * 全程只读：不改 PATH、不改注册表、不改 DSH 自身，升级后不需要任何额外配置。
 *
 * @module dsh-git-bash
 */
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';

/** 加载器读取的插件元数据。 */
export const name = 'dsh-git-bash';
export const inject = ['subprocess'];
export const Config = LocalBashExecutor.Config;
// 测试缝：离线 harness 用它验证解析链与报错质量。
export { candidateBashPaths, resolveBashPath };

/** WSL 的 bash 启动器：路径形如 C:\Windows\System32\bash.exe —— 语义不对，必须跳过。 */
const WSL_LAUNCHER = /[\\/]System32[\\/]bash\.exe$/i;

/** 显式配置（行 config 的 bashPath），优先级最高。 */
let configuredPath;

/**
 * Git for Windows 在注册表里登记自己的安装目录，这是唯一与安装位置无关的权威来源。
 * 机器级安装写 HKLM，用户级安装写 HKCU。
 * @returns 安装目录，未登记时 undefined。
 */
function registryInstallPath() {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execFileSync('reg.exe', ['query', hive + '\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const matched = /InstallPath\s+REG_SZ\s+(.+?)\s*$/m.exec(out);
      if (matched && matched[1]) return matched[1].trim();
    } catch {}
  }
  return undefined;
}

/**
 * 按可靠性排序列出候选 bash.exe 路径。
 * @param env - 用于探测的环境变量，默认进程环境。
 * @returns 候选路径（已去重，未做存在性检查）。
 */
function candidateBashPaths(env = process.env) {
  const list = [];
  const push = (candidate) => {
    if (candidate && !list.includes(candidate)) list.push(candidate);
  };

  const install = registryInstallPath();
  if (install) {
    push(join(install, 'bin', 'bash.exe'));
    push(join(install, 'usr', 'bin', 'bash.exe'));
  }

  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  push(join(programFiles, 'Git', 'bin', 'bash.exe'));
  for (const key of ['ProgramFiles(x86)', 'ProgramW6432']) {
    const base = env[key];
    if (base) push(join(base, 'Git', 'bin', 'bash.exe'));
  }
  if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  if (env.USERPROFILE) push(join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'));
  if (env.ProgramData) push(join(env.ProgramData, 'chocolatey', 'lib', 'git', 'tools', 'bin', 'bash.exe'));

  // PATH：直接命中 bash.exe；以及从 git.exe 所在目录反推 —— Git 默认把 Git\cmd 放进 PATH。
  for (const entry of (env.PATH ?? '').split(';')) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    push(join(dir, 'bash.exe'));
    push(join(dir, '..', 'bin', 'bash.exe'));
  }
  return list;
}

/**
 * 该路径是否可以被 spawn。用 lstat 而不是 stat：Store 版应用别名是 reparse point，
 * stat 会跟到目标上，而 CreateProcess 两种形态都能启动。
 * @param path - 待检查的绝对路径。
 * @returns 是否可启动。
 */
function spawnable(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** 解析结果缓存：避免每条命令都探一次注册表；命中后仍会复核，失效即重新解析。 */
let resolved;

/**
 * 解析要执行的 bash.exe。
 * @returns 绝对路径。
 * @throws 找不到时抛出带完整排查信息的错误（不静默回退到 WSL）。
 */
function resolveBashPath() {
  const explicit = configuredPath || process.env.DSH_GIT_BASH;
  if (explicit) {
    // 显式指定优先；是路径就顺便校验一下，给出可操作的报错而不是裸 ENOENT。
    if ((explicit.includes('\\') || explicit.includes('/')) && !spawnable(explicit)) {
      const error = new Error(
        'dsh-git-bash: bashPath / DSH_GIT_BASH points at ' + explicit + ' but no such file exists.',
      );
      error.code = 'GIT_BASH_NOT_FOUND';
      throw error;
    }
    return explicit;
  }
  // 缓存命中也要复核：Git 被卸载或搬走后自动重新解析，而不是拿着旧路径一直失败。
  let stale;
  if (resolved) {
    if (spawnable(resolved)) return resolved;
    stale = resolved;
    resolved = undefined;
  }

  const tried = [];
  if (stale) tried.push(stale + '   [used earlier, no longer exists]');
  for (const candidate of candidateBashPaths()) {
    if (WSL_LAUNCHER.test(candidate)) {
      tried.push(candidate + '   [skipped: WSL launcher]');
      continue;
    }
    tried.push(candidate);
    if (spawnable(candidate)) {
      resolved = candidate;
      return candidate;
    }
  }

  const error = new Error(
    'dsh-git-bash: no Git Bash found on this machine. Tried:\n' +
      tried.map((line) => '  - ' + line).join('\n') +
      '\nInstall Git for Windows, or point this plugin at bash.exe explicitly — set the ' +
      'DSH_GIT_BASH environment variable, or write bashPath into the plugin row config.',
  );
  error.code = 'GIT_BASH_NOT_FOUND';
  throw error;
}

/** 裸 bash 名字（不含路径分隔符）。带路径的 argv 一律不动：那是调用方自己选定的 shell。 */
const BARE_BASH = /^bash(\.exe)?$/i;

/** 自检只跑一次；日志句柄在 apply() 里设。 */
let selfChecked = false;
let logger;

/** 把任意错误压成一行可读文本。 */
function errorText(error) {
  try {
    return error && error.message ? error.message : String(error);
  } catch {
    return 'unprintable error';
  }
}

/** 自检用的身份命令：bash 版本 + 平台名，两者都不是 Git Bash 的形态。 */
const IDENTITY_COMMAND = 'printf "%s|%s" "$BASH_VERSION" "$(uname -s)"';

/**
 * 首次执行时做一次自检：走一遍工具层用的公开路径（resolve → execute → result），
 * 确认命令真的跑在 Git Bash 上。上游哪天再换执行缝，日志里会直接说明原因，
 * 而不是等到命令输出乱码、退出码 1 才发现。只写日志，绝不影响命令本身。
 * @param executor - 本插件挂载的执行器（可以是被调用时的代理 receiver）。
 */
function selfCheck(executor) {
  if (selfChecked) return;
  selfChecked = true;
  void (async () => {
    try {
      const spec = executor.resolve({ command: IDENTITY_COMMAND });
      const result =
        typeof executor.execute === 'function'
          ? await (await executor.execute(spec)).result()
          : await executor.run(spec);
      const text = String(result?.stdout?.text ?? '').trim();
      if (/MSYS|MINGW|CYGWIN/i.test(text)) {
        logger?.info?.('dsh-git-bash: self-check ok — %s', text);
        return;
      }
      let resolvedPath = 'unresolved';
      try {
        resolvedPath = resolveBashPath();
      } catch {}
      logger?.warn?.(
        'dsh-git-bash: self-check FAILED — the bash tool is not running Git Bash (got "%s"). ' +
          'Upstream probably renamed the executor seam again; resolveBashPath() -> %s',
        text.slice(0, 200),
        resolvedPath,
      );
    } catch (error) {
      logger?.warn?.('dsh-git-bash: self-check failed: %s', errorText(error));
    }
  })();
}

/**
 * 把 argv 里的裸 bash 换成解析出来的 Git Bash 绝对路径；带路径的 argv 一律不动
 * （那是调用方自己选定的 shell），其余 argv 原样返回。
 * @param argv - 上游准备好的 argv。
 * @returns 可能替换了 argv[0] 的 argv。
 */
function gitBashArgv(argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string' || !BARE_BASH.test(argv[0])) return argv;
  return [resolveBashPath(), ...argv.slice(1)];
}

/**
 * 本地 bash 执行器。
 *
 * 主替换点是 spawnSpec：无论上游走新版（execute → executeArgv）还是旧版
 * （run/start → runArgv/startArgv），argv 最后都在这里落成 spawn 配置，
 * 所以只在这里把裸 bash 换成 Git Bash，就不必跟随上游的入口命名。
 *
 * 入口方法（execute / run / start）仍然覆盖一层，作为第二道保险：
 * 它们存在时直接把 Git Bash 的绝对路径递进去，spawnSpec 那层就成了空操作；
 * 哪天入口改名，基类实现照样会走到 spawnSpec，仍然命中 Git Bash。
 */
class GitBashExecutor extends LocalBashExecutor {
  /**
   * 收口点：把上游准备好的 argv 里的裸 bash 换成 Git Bash。
   * @param spec - resolve() 产出的执行规格。
   * @param argv - 上游准备的 argv。
   * @param stdoutMaxBytes - stdout 上限。
   * @param signal - 取消 / 超时信号。
   * @returns 完整 spawn 配置。
   */
  spawnSpec(spec, argv, stdoutMaxBytes, signal) {
    return super.spawnSpec(spec, gitBashArgv(argv), stdoutMaxBytes, signal);
  }

  /**
   * 新 seam（dsh >= 0.1.7-rc.1）：工具层调用 `ctx.shell.resolve()` 后
   * `ctx.shell.execute(spec)`，execute 必须返回 ShellProcess 句柄。
   * 基类的 execute 写死了裸 `bash`（在 Windows 上会命中 System32 的 WSL 启动器）。
   * @param spec - resolve() 产出的执行规格。
   * @returns ShellProcess 句柄。
   */
  async execute(spec) {
    selfCheck(this);
    if (typeof this.executeArgv === 'function') {
      return this.executeArgv(spec, [resolveBashPath(), '-c', spec.command]);
    }
    return super.execute(spec);
  }

  /**
   * 旧 seam（dsh <= 0.1.6）：run 返回 `{ result }`。
   * 保留以兼容仍走 run/start 的上游版本；新版本不会调用到。
   * @param spec - 执行规格。
   * @returns 带 result 的对象。
   */
  async run(spec) {
    selfCheck(this);
    if (typeof this.runArgv === 'function') {
      const { result } = await this.runArgv(spec, [resolveBashPath(), '-c', spec.command]);
      return result;
    }
    return super.run(spec);
  }

  /**
   * 旧 seam（dsh <= 0.1.6）：start 返回后台句柄。
   * @param spec - 执行规格。
   * @returns ShellProcess 句柄。
   */
  async start(spec) {
    if (typeof this.startArgv === 'function') {
      return this.startArgv(spec, [resolveBashPath(), '-c', spec.command]);
    }
    return super.start(spec);
  }
}

/**
 * 挂载执行器。
 *
 * 给执行器的 context 屏蔽 inject —— LocalBashExecutor 的构造函数会
 * ctx.inject([settings], ...) 注册名为 shell 的设置段，而宿主上已经有一个
 * （pwsh 执行器装的），settings 服务会以 already registered 拒绝第二次注册。
 * 本执行器的配置只来自组合条目，不需要可编辑的设置段；其余服务照常继承。
 *
 * @param ctx - 挂载点 context（位于 isolate 隔离作用域内）。
 * @param config - 组合条目配置，可含 bashPath / cwd / timeoutMs 等。
 */
export function apply(ctx, config) {
  configuredPath = config && config.bashPath ? config.bashPath : undefined;
  logger = ctx.logger;
  const executorCtx = ctx.extend({ inject: () => {} });
  new GitBashExecutor(executorCtx, config);
  try {
    logger?.info?.('dsh-git-bash: bash.exe -> %s', resolveBashPath());
  } catch (error) {
    logger?.warn?.('dsh-git-bash: %s', error.message);
  }
}
