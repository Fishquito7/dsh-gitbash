/**
 * 离线验证脚本：用真实 cordis + 真实 dsh-bash-local 驱动本插件，不需要启动 DSH。
 *
 * 运行前提：本包已位于某个 profile 的解析链上（例如 staged 到
 *   $DSH_HOME/profiles/web/node_modules/dsh-git-bash），并从该 profile 目录运行：
 *     node <此文件路径>
 * 检查点：宿主 shell 未被顶替 / 隔离作用域内是本执行器 / settings 段零注册 /
 *         真实 Git Bash 身份 / glob 与 $( ) 展开 / 退出码透传 / stderr 分离。
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import * as plugin from 'dsh-git-bash';

const CONFIG = {
  cwd: process.cwd(),
  timeoutMs: 30000,
  maxTimeoutMs: 60000,
  maxOutputBytes: 64000,
  maxSpillBytes: 1048576,
  graceMs: 3000,
};

function makeSubprocess() {
  return {
    spawn(spec) {
      const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: Object.assign({}, process.env, spec.env || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', function (d) { out += d.toString('utf8'); });
      child.stderr.on('data', function (d) { err += d.toString('utf8'); });
      const done = new Promise(function (resolve) {
        child.on('close', function (code, signal) { resolve({ exitCode: code, signal: signal || null }); });
      });
      const reader = function (get) {
        return { readFrom: function (offset) { return { text: get().slice(offset), nextOffset: get().length, lossy: false }; } };
      };
      return { done: done, collected: { stdout: reader(function () { return out; }), stderr: reader(function () { return err; }) }, kill: function () { child.kill(); } };
    },
  };
}

const tick = function () { return new Promise(function (r) { setTimeout(r, 60); }); };
const rows = [];
const record = function (label, value) { rows.push(String(label).padEnd(38) + ' : ' + String(value)); };

const root = new Context();
root.provide('subprocess', makeSubprocess());
let installs = 0;
root.provide('settings', {
  installSection: function () { installs += 1; throw new Error('settings namespace "shell" is already registered'); },
});
root.provide('shell', 'PWSH-EXECUTOR-PLACEHOLDER');

// ---- A) 插件路径：通过真实 cordis plugin 挂载（有 fiber） ----
const realm = root.isolate('shell');
realm.plugin(plugin, CONFIG);
await tick();
record('A1 宿主 root.shell 未变', root.shell === 'PWSH-EXECUTOR-PLACEHOLDER');
record('A2 realm.shell 是本插件执行器', realm.shell && realm.shell.constructor.name);
record('A3 settings.installSection 次数(期望0)', installs);

// ---- B) 对照：直接挂父类（不做屏蔽） ----
const realm2 = root.isolate('shell');
let bErr = 'none';
try {
  realm2.plugin(LocalBashExecutor, CONFIG);
  await tick();
  bErr = 'mounted, installSection 次数=' + installs;
} catch (e) { bErr = 'throws: ' + e.message; }
record('B1 直接挂父类的结果', bErr);
record('B2 屏蔽后总次数(应=1)', installs);

// ---- C) 真跑命令 ----
// 兼容两代 seam：新版走 resolve() + execute() -> ShellProcess.result()；
// 旧版走 resolve() + run() -> { result }。
const run = async function (command) {
  const spec = realm.shell.resolve({ command: command });
  if (typeof realm.shell.execute === 'function') {
    const proc = await realm.shell.execute(spec);
    return await proc.result();
  }
  return realm.shell.run(spec);
};

const r1 = await run('echo "argv0=$0"; uname -s; echo "bash=$BASH_VERSION"');
record('C1 shell 身份', JSON.stringify(r1.stdout.text.trim()));

const r2 = await run('printf "%s|" *.ts; echo; echo "sub=$(pwd | tr / -)"; echo "single=$notvar"');
record('C2 glob+子命令+单引号变量', JSON.stringify(r2.stdout.text.trim().slice(0, 160)));

const r3 = await run('exit 7');
record('C3 非零退出码透传', r3.exitCode);

const r5 = await run('echo out; ls /nonexistent-xyz >/dev/null');
record('C4 stderr 文本', JSON.stringify(r5.stderr.text.trim().slice(0, 90)));


// ---- D) 解析链与报错质量 ----
import { candidateBashPaths as probeCandidates, resolveBashPath as probeResolve } from 'dsh-git-bash';
try { record('D1 自动解析结果', probeResolve()); } catch (e) { record('D1 自动解析结果', 'FAIL ' + e.message.split(String.fromCharCode(10))[0]); }
record('D2 候选数量', probeCandidates().length);
record('D3 候选前两条', probeCandidates().slice(0, 2).join('  |  '));
const savedBash = process.env.DSH_GIT_BASH;
process.env.DSH_GIT_BASH = 'C:\\nope\\bash.exe';
try { probeResolve(); record('D4 显式指向不存在', '未抛错(意外)'); } catch (e) { record('D4 显式指向不存在', e.message.slice(0, 95)); }
if (savedBash === undefined) delete process.env.DSH_GIT_BASH; else process.env.DSH_GIT_BASH = savedBash;

// ---- E) 回归：上游内部方法改名/消失后，替换缝仍然生效 ----
// 直接调用基类的 execute —— 它写死了裸 "bash"，等于模拟"某个未来版本又换掉了
// executeArgv，或干脆走回基类实现"：subprocess 包装必须仍然把它换成 Git Bash。
const specBase = realm.shell.resolve({ command: 'echo "base=$0"; uname -s' });
const procBase = await LocalBashExecutor.prototype.execute.call(realm.shell, specBase);
const rBase = await procBase.result();
record('E1 基类裸 bash 仍走 Git Bash', JSON.stringify(rBase.stdout.text.trim()));
record('E2 走基类时的退出码', rBase.exitCode);

// ---- F) 收口点：spawnSpec 只换裸 bash，其余 argv 原样 ----
const specF = realm.shell.resolve({ command: 'echo hi' });
const cfgF1 = realm.shell.spawnSpec(specF, ['bash', '-c', 'echo hi'], 64000, undefined);
record('F1 裸 bash 换成解析结果', cfgF1.argv[0]);
const cfgF2 = realm.shell.spawnSpec(specF, ['git', 'status'], 64000, undefined);
record('F2 非 bash 原样透传', JSON.stringify(cfgF2.argv));
const cfgF3 = realm.shell.spawnSpec(specF, ['C:\\Program Files\\Git\\bin\\bash.exe', '-c', 'echo hi'], 64000, undefined);
record('F3 绝对路径不被动', cfgF3.argv[0]);
record('F4 spawn 配置其余字段仍在', JSON.stringify([typeof cfgF1.cwd, typeof cfgF1.stdio, cfgF1.graceMs]));

// ---- G) 自检日志：首次执行时走公开路径确认 shell 身份 ----
await tick();
await tick();
const logged = (root.logger && root.logger.buffer ? root.logger.buffer : []).map(function (m) {
  try { return JSON.stringify(m); } catch (e) { return String(m); }
}).join(' ');
record('G0 挂载日志里有解析结果', /bash\.exe ->/.test(logged));
record('G1 自检结论', /self-check ok/.test(logged) ? 'ok' : logged.slice(0, 180));

// ---- H) 行 config 的 bashPath 覆盖（模块级配置，放在最后） ----
const realm3 = root.isolate('shell');
realm3.plugin(plugin, Object.assign({}, CONFIG, { bashPath: 'C:\\nope\\explicit\\bash.exe' }));
await tick();
try {
  record('H1 bashPath 覆盖生效', '未抛错(意外): ' + probeResolve());
} catch (e) {
  record('H1 bashPath 覆盖生效', e.message.slice(0, 88));
}

console.log(rows.join(String.fromCharCode(10)));
