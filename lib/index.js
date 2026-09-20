/**
 * dsh-git-bash — 在 Windows 上把 DSH 的原生 bash 工具接到 Git Bash。
 *
 * 设计：不自己写工具，复用上游两个现成件——
 *   - @deepseek-ai/dsh-bash-local 的进程机制（超时、输出上限、spill、后台句柄）；
 *   - @deepseek-ai/dsh-tool-bash 的完整工具 schema、渲染与退出码标记。
 * 本插件只做一件事：继承本地 bash 执行器，把 argv 从裸 bash 换成 Git Bash 的绝对路径。
 *
 * 两者一起挂在 profile 里一个 isolate: { shell: ... } 的作用域中，于是：
 *   - 该作用域内的 ctx.shell 指向本执行器；
 *   - 宿主的 pwsh 执行器与 tool-pwsh 不受任何影响（只隔离 shell 这一个名字）；
 *   - bash 工具仍注册进共享的 tools 注册表 → 所有 agent 都能看到它。
 *
 * @module dsh-git-bash
 */
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';

/** Git Bash 默认位置；可用环境变量 DSH_GIT_BASH 覆盖。 */
const DEFAULT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';

/** 加载器读取的插件元数据。 */
export const name = 'dsh-git-bash';
export const inject = ['subprocess'];
export const Config = LocalBashExecutor.Config;

/** 本次要执行的 bash 可执行文件。 */
function bashPath() {
  return process.env.DSH_GIT_BASH || DEFAULT_BASH_PATH;
}

/**
 * 本地 bash 执行器，唯一改动是把 spawn 的 argv 换成 Git Bash。
 * runArgv / startArgv 是上游专门为子类留的 argv 替换缝。
 */
class GitBashExecutor extends LocalBashExecutor {
  async run(spec) {
    const { result } = await this.runArgv(spec, [bashPath(), '-c', spec.command]);
    return result;
  }

  async start(spec) {
    return this.startArgv(spec, [bashPath(), '-c', spec.command]);
  }
}

/**
 * 挂载执行器。
 *
 * 这里给执行器的 context 屏蔽了 inject：LocalBashExecutor 的构造函数会
 * ctx.inject([settings], ...) 注册名为 shell 的设置段，而宿主上已经有一个
 * （pwsh 执行器装的），settings 服务会以
 * settings namespace "shell" is already registered 拒绝第二次注册。
 * 本执行器的配置只来自组合条目，不需要可编辑的设置段，所以屏蔽掉即可；
 * 其余服务（subprocess 等）照常继承。
 */
export function apply(ctx, config) {
  const executorCtx = ctx.extend({ inject: () => {} });
  new GitBashExecutor(executorCtx, config);
}
