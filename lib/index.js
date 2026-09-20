/**
 * dsh-git-bash — 在 Windows 上把 DSH 的原生 bash 工具接到 Git Bash。
 *
 * 设计：不自己写工具，复用上游两个现成件——
 *   - @deepseek-ai/dsh-bash-local 的进程机制（超时、输出上限、spill、后台句柄）；
 *   - @deepseek-ai/dsh-tool-bash 的完整工具 schema、渲染与退出码标记。
 * 本插件只做一件事：继承本地 bash 执行器，把 argv 从裸 bash 换成 Git Bash 的绝对路径。
 *
 * 为什么要解析而不是写死路径：Git for Windows 的安装位置取决于安装方式与用户习惯
 * （机器级 / 用户级 / scoop / chocolatey），而且 git 安装器默认只把 Git\cmd 放进 PATH，
 * 从不放 Git\bin —— 所以裸 bash 在 Windows 上要么找不到，要么撞上 WSL 的启动器。
 *
 * 解析优先级：行 config 的 bashPath → 环境变量 DSH_GIT_BASH → 注册表 InstallPath
 *   → 常见安装位置 → PATH 反推（git.exe 同级的 ..\bin）。
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

/** 解析结果缓存，避免每条命令都探一次注册表。 */
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
  if (resolved) return resolved;

  const tried = [];
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

/**
 * 本地 bash 执行器，唯一改动是把 spawn 的 argv 换成 Git Bash。
 * runArgv / startArgv 是上游专门为子类留的 argv 替换缝。
 */
class GitBashExecutor extends LocalBashExecutor {
  async run(spec) {
    const { result } = await this.runArgv(spec, [resolveBashPath(), '-c', spec.command]);
    return result;
  }

  async start(spec) {
    return this.startArgv(spec, [resolveBashPath(), '-c', spec.command]);
  }
}

/**
 * 挂载执行器。
 *
 * 这里给执行器的 context 屏蔽了 inject：LocalBashExecutor 的构造函数会
 * ctx.inject([settings], ...) 注册名为 shell 的设置段，而宿主上已经有一个
 * （pwsh 执行器装的），settings 服务会以 already registered 拒绝第二次注册。
 * 本执行器的配置只来自组合条目，不需要可编辑的设置段，所以屏蔽掉即可；
 * 其余服务（subprocess 等）照常继承。
 *
 * @param ctx - 挂载点 context（位于 isolate 隔离作用域内）。
 * @param config - 组合条目配置，可含 bashPath / cwd / timeoutMs 等。
 */
export function apply(ctx, config) {
  configuredPath = config && config.bashPath ? config.bashPath : undefined;
  const executorCtx = ctx.extend({ inject: () => {} });
  new GitBashExecutor(executorCtx, config);
  try {
    ctx.logger?.info?.('dsh-git-bash: bash.exe -> %s', resolveBashPath());
  } catch (error) {
    ctx.logger?.warn?.('dsh-git-bash: %s', error.message);
  }
}
