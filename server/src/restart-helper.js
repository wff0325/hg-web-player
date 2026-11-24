'use strict';
/**
 * 重启助手：一个独立的短命进程，负责「等旧服务退干净 → 拉起新服务」。
 *
 * 为什么需要独立进程：Node 服务不能自己把自己关掉再重新拉起（退出后
 * 就没有执行体了）。所以 /sync-web 检测到后端代码更新后，先拉起本助手
 * （detached，脱离父进程存活），再让旧服务退出；助手循环的等旧 PID 消失、
 * 端口释放，然后用同一套参数 spawn 新的服务进程，随后自己退出。
 *
 * 用法（内部调用，不必手动执行）：
 *   node server/src/restart-helper.js --old-pid 1234 --port 8000 \
 *     --cwd D:/project --script server/src/main.js --args "--flag=x,--flag2"
 *
 * 关键约束：
 * - 新进程必须 detached + stdio ignore + unref，否则父进程（助手）退出时会带走的它。
 * - 等待要有上限（WAIT_MS），超时则放弃并写日志，绝不无限循环。
 * - 全程写 restart.log，便于排查「为什么没起来」。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const OLD_PID = parseInt(arg('old-pid', '0'), 10);
const PORT = parseInt(arg('port', '8000'), 10);
const CWD = arg('cwd', process.cwd());
const SCRIPT = arg('script', 'server/src/main.js');
const EXTRA_ARGS = arg('args', '');
const LOG = path.join(CWD, 'server', 'config', 'restart.log');
const WAIT_MS = 30000;          // 等旧进程退出/端口释放的总上限
const POLL_MS = 250;
const NODE = process.execPath;  // 用与旧进程相同的 node 可执行文件

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line, 'utf8');
  } catch (e) { /* 日志失败不影响重启 */ }
}

function alive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(v); } };
    sock.setTimeout(800, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.connect({ host: '127.0.0.1', port });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  log('重启助手启动 oldPid=' + OLD_PID + ' port=' + PORT + ' cwd=' + CWD);

  const deadline = Date.now() + WAIT_MS;
  // 阶段一：等旧进程退出（它是本助手的父进程，退出后本助手靠 detached 存活）
  while (Date.now() < deadline && alive(OLD_PID)) await sleep(POLL_MS);
  if (alive(OLD_PID)) { log('等待旧进程退出超时，放弃重启'); process.exit(1); }
  log('旧进程已退出');

  // 阶段二：等端口释放（旧进程退出后 socket 可能 TIME_WAIT，稍等）
  while (Date.now() < deadline && await portBusy(PORT)) await sleep(POLL_MS);
  if (await portBusy(PORT)) { log('等待端口 ' + PORT + ' 释放超时，放弃重启'); process.exit(1); }
  log('端口 ' + PORT + ' 已释放');

  // 阶段三：拉起新服务。args 用逗号分隔，逐个还原。
  const extra = EXTRA_ARGS.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const args = [SCRIPT].concat(extra);
  log('拉起新服务: ' + NODE + ' ' + args.join(' '));
  const child = spawn(NODE, args, {
    cwd: CWD,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (e) => log('spawn 新服务失败: ' + String(e && e.message || e)));
  child.unref();
  log('新服务已拉起 pid=' + child.pid + '，助手退出');
  process.exit(0);
}

main().catch((e) => { log('助手异常: ' + String(e && e.stack || e)); process.exit(1); });
