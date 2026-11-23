'use strict';
/**
 * 入口。
 *
 * 用法：
 *   node server/src/main.js                启动服务（默认 127.0.0.1:8000）
 *   node server/src/main.js --config       查看生效配置
 *   node server/src/main.js --stop         停掉在跑的实例
 *   node server/src/main.js --selftest     跑自检（算法回归 + 环境探测）
 *   node server/src/main.js --probe <vid>  单集取址诊断（分段打印注册/签名/上游/解析）
 *                                          加 --renditions 看各档真实分辨率与码率，
 *                                          加 --deep 解密后直接读 MP4 轨道核实分辨率
 *   node server/src/main.js --check        协议巡检（真取几集址，判断还通不通）
 *   node server/src/main.js --watch [分]   常驻巡检，默认每 30 分钟一轮
 *   node server/src/main.js --sync-constants [--apply]  从上游仓库同步 v5 协议常量
 *   node server/src/main.js --version      显示版本
 *
 * 启动即跑 API 服务：签名与解密都在进程内完成，没有第二个组件，
 * 也不再有 api.enabled 之类的启停开关。编排逻辑见 launcher；
 * 这里只保留版本号与自检两项轻量入口（外加把其余参数交给 launcher）。
 */

const Config = require('./util/config');
const Log = require('./util/log');

/**
 * 程序入口。
 *
 * @param {string[]} [argv] 命令行参数，默认取 process.argv.slice(2)
 * @returns {Promise<number>} 退出码（0 成功）
 */
async function main(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);

  // 先锁定 UTF-8 输出：所有入口（自检/签名/完整）都经由此处，
  // 否则中文 Windows 控制台会出现「红红果果」式的双重编码乱码。
  Log.initEncoding();

  for (const a of args) {
    if (a === '--version' || a === '-v') {
      // 版本号取自 package.json，详见 Config.version()
      console.log('hongguo-api ' + Config.version());
      return 0;
    }
  }

  for (const a of args) {
    if (a === '--selftest') {
      // 惰性 require：--version 等轻量入口无需拉起完整自检依赖。
      const SelfTest = require('./selftest');
      const code = await SelfTest.run();
      if (typeof code === 'number') process.exitCode = code;
      return typeof code === 'number' ? code : 0;
    }
  }

  for (const a of args) {
    if (a === '--probe') {
      // 单集取址诊断：只跑一次、不排队不重试，用于定位断在哪一段。
      const Probe = require('./probe');
      const code = await Probe.run(args);
      return typeof code === 'number' ? code : 0;
    }
  }

  for (const a of args) {
    if (a === '--sync-constants') {
      // 上游只轮换常量时（magic/license/signKey/S 盒），这条能自动修好。
      const V5Sync = require('./core/v5-sync');
      const apply = args.indexOf('--apply') >= 0;
      console.log('');
      console.log('  ============================================');
      console.log('    v5 协议常量同步');
      console.log('  ============================================');
      console.log('  上游仓库   ' + V5Sync.REPO + '（main 分支）');
      let r;
      try {
        r = await V5Sync.sync({ apply });
      } catch (e) {
        console.log('  ✗ 同步失败：' + (e && e.message ? e.message : e));
        console.log('    （需要能访问 raw.githubusercontent.com）');
        return 2;
      }
      const d = r.detail || {};
      if (d.magic !== undefined) console.log('  magic      ' + d.magic);
      if (d.license !== undefined) console.log('  license    ' + d.license);
      if (d.signKeyHead !== undefined) console.log('  signKey    ' + d.signKeyHead);
      if (d.verify !== undefined) {
        console.log('  向量校验   f13 ' + d.verify.f13 + ' 组 / 载体 ' + d.verify.carrier + ' 组');
      }
      console.log('');
      console.log('  结果：' + r.note);
      if (r.applied) {
        console.log('  下一步：重启服务，然后 node server/src/main.js --check 验一遍');
        return 0;
      }
      // 有变化但没写入 → 退出码 1，方便 cron 发现「需要人看一眼」
      return r.changed ? 1 : 0;
    }
  }

  for (const a of args) {
    if (a === '--check') {
      const Watchdog = require('./watchdog');
      const code = await Watchdog.check();
      return typeof code === 'number' ? code : 0;
    }
    if (a === '--watch') {
      const Watchdog = require('./watchdog');
      const i = args.indexOf('--watch');
      await Watchdog.watch(args[i + 1]);
      return 0;
    }
  }

  const Launcher = require('./launcher');
  await Launcher.main(args);
  return 0;
}

module.exports = { main };

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2)))
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((e) => {
      Log.error('启动失败：' + (e && e.message ? e.message : e), e);
      process.exitCode = 1;
    });
}
