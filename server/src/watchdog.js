'use strict';
/**
 * 协议巡检（`--check` / `--watch`）。
 *
 * 上游改协议时不会提前通知，表现为「搜索详情正常、一点播放就失败」。
 * 这个巡检定期真取几集址，用成功率告诉你现在还通不通：
 *
 *   node server/src/main.js --check            跑一轮，正常退出码 0，失败 1
 *   node server/src/main.js --watch            常驻，默认每 30 分钟一轮
 *   node server/src/main.js --watch 10         每 10 分钟一轮
 *
 * 失败时它会顺带查一下上游开源仓库最近的相关提交，直接给出「该看哪一次改动」，
 * 省掉自己翻 commit 的时间。
 *
 * 样本来源（按优先级）：
 *   1. config.json 的 runtime.watch.series（形如 ["7685690139804175384:1", …]）
 *   2. 自动：取榜单前两部剧的第 1 集（榜单变了也能自愈，不用维护配置）
 */
const Config = require('./util/config');
const Log = require('./util/log');
const Json = require('./util/json');
const Client = require('./service/client');
const AppSource = require('./service/app-source');
const Http = require('./util/http');
const V5Sync = require('./core/v5-sync');

/** 上游开源仓库（发现修复的地方）。 */
const UPSTREAM_REPO = V5Sync.REPO;

function two(n) { return String(n).padStart(2, '0'); }
function clock() {
  const d = new Date();
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}

/** 配置里的固定样本，解析成 [{seriesId, ep}]。 */
function configuredSamples() {
  const raw = Config.get('runtime.watch.series');
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of arr) {
    const text = String(item).trim();
    const m = /^(\d{6,30})(?::(\d+))?$/.exec(text);
    if (m) out.push({ seriesId: m[1], ep: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return out;
}

/** 自动挑样本：榜单前两部剧的第 1 集。 */
async function autoSamples() {
  // board 必须给具体值：上游要求 sub_selected_items 合法，空 board 会返回空列表
  const boards = ['recommend', 'hot', 'new'];
  let items = [];
  for (const b of boards) {
    try {
      items = await Client.rank(b, 6);
    } catch (e) {
      items = [];
    }
    if (Array.isArray(items) && items.length > 0) break;
  }
  const out = [];
  for (const raw of items) {
    const it = Json.optObj(raw);
    if (it === null) continue;
    const sid = Json.optStr(it.series_id, '');
    if (sid === '') continue;
    out.push({ seriesId: sid, ep: 1, title: Json.optStr(it.title, '') });
    if (out.length >= 2) break;
  }
  return out;
}

/** 把样本解析成 vid。 */
async function resolveSamples() {
  const configured = configuredSamples();
  let list = configured;
  if (list.length === 0) {
    try {
      list = await autoSamples();
    } catch (e) {
      return { samples: [], error: '取榜单失败：' + (e && e.message ? e.message : e) };
    }
  }
  const out = [];
  for (const s of list) {
    try {
      const meta = await Client.getEpisodes(s.seriesId);
      const eps = Json.optArr(meta.episodes);
      const hit = eps.map((x) => Json.optObj(x))
        .find((x) => x !== null && Json.optLong(x.index, 0) === s.ep);
      if (hit === null || hit === undefined) continue;
      out.push({
        vid: Json.optStr(hit.vid, ''),
        label: (Json.optStr(meta.title, '') || s.title || s.seriesId) + ' 第' + s.ep + '集',
      });
    } catch (e) {
      out.push({ vid: '', label: s.seriesId + ' 第' + s.ep + '集', error: e.message });
    }
  }
  return { samples: out, error: null };
}

/**
 * 查上游仓库最近与播放/签名相关的提交。
 * 网络不通或限流时返回空数组（不影响巡检结论）。
 */
async function upstreamHints() {
  try {
    const res = await Http.send({
      url: 'https://api.github.com/repos/' + UPSTREAM_REPO + '/commits?per_page=20',
      method: 'GET', timeoutMs: 12000,
      headers: { 'user-agent': 'hongguo-web-watch', accept: 'application/vnd.github+json' },
    });
    if (res.status !== 200) return [];
    const rows = JSON.parse(res.text());
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      const msg = (r.commit && r.commit.message ? r.commit.message : '').split('\n')[0];
      if (!/playback|sign|播放|签名|signing|v5|v\d+\.\d+/i.test(msg)) continue;
      out.push({
        sha: String(r.sha || '').slice(0, 7),
        date: (r.commit && r.commit.author && r.commit.author.date)
          ? String(r.commit.author.date).slice(0, 10) : '',
        msg,
        url: r.html_url || ('https://github.com/' + UPSTREAM_REPO + '/commit/' + r.sha),
      });
      if (out.length >= 3) break;
    }
    return out;
  } catch (e) {
    return [];
  }
}

/** 跑一轮巡检，返回 {ok, total, fails, ms}。 */
async function round(quiet) {
  const resolved = await resolveSamples();
  if (resolved.error !== null) {
    console.log('  ✗ ' + resolved.error);
    return { ok: false, total: 0, fails: [], ms: 0, fatal: resolved.error };
  }
  const samples = resolved.samples.filter((s) => s.vid !== '' || s.error !== undefined);
  if (samples.length === 0) {
    console.log('  ✗ 没有可用的巡检样本');
    return { ok: false, total: 0, fails: [], ms: 0, fatal: '无样本' };
  }

  const t0 = Date.now();
  const fails = [];
  let n = 0;
  // 巡检期间屏蔽 INFO（设备注册那行会插进结果表格里），--verbose 可放开
  const keepInfo = Log.info;
  if (!process.argv.includes('--verbose')) Log.info = () => {};
  try {
    for (const s of samples) {
      n++;
      if (s.vid === '') {
        fails.push({ label: s.label, error: s.error || '取不到分集' });
        if (!quiet) console.log('  [' + n + '/' + samples.length + '] ✗ ' + s.label + '  ' + s.error);
        continue;
      }
      const r = await AppSource.diagnose(s.vid, '1080p');
      if (r.ok) {
        if (!quiet) {
          console.log('  [' + n + '/' + samples.length + '] ✓ ' + String(r.ms).padStart(5)
            + 'ms  ' + s.label + '  ' + r.result.definition + ' '
            + (r.result.size / 1048576).toFixed(1) + 'MB');
        }
      } else {
        fails.push({ label: s.label, vid: s.vid, error: r.error });
        if (!quiet) {
          console.log('  [' + n + '/' + samples.length + '] ✗ ' + String(r.ms).padStart(5)
            + 'ms  ' + s.label);
          console.log('       ' + r.error);
        }
      }
    }
  } finally {
    Log.info = keepInfo;
  }
  return { ok: fails.length === 0, total: samples.length, fails, ms: Date.now() - t0 };
}

/** 失败时的收尾：常量健康 + 上游线索 + 下一步建议。 */
async function reportFailure() {
  console.log('');
  console.log('  上游可能又改了协议。');
  if (!V5Sync.localOk()) {
    console.log('  · 本地 v5 常量加载异常，先跑 --sync-constants');
  } else {
    console.log('  · 先试自动修常量：node server/src/main.js --sync-constants --apply');
  }
  const hints = await upstreamHints();
  if (hints.length > 0) {
    console.log('  · 上游仓库最近的相关提交：');
    for (const h of hints) {
      console.log('      ' + h.date + '  ' + h.sha + '  ' + h.msg);
      console.log('      ' + h.url);
    }
  }
  console.log('  · 仍不行就看提交里改了哪个文件，对照 server/src/service/app-source.js 的');
  console.log('    接口路径 / query 参数 / 签名版本（这三处是最常变的）。');
}

/** 一次性检查。 */
async function check() {
  console.log('');
  console.log('  ============================================');
  console.log('    协议巡检（' + clock() + '）');
  console.log('  ============================================');
  const r = await round(false);
  console.log('');
  if (r.ok) {
    console.log('  结果：' + r.total + '/' + r.total + ' 正常，' + r.ms + 'ms');
    return 0;
  }
  if (r.total === 0) {
    console.log('  结果：拿不到巡检样本（榜单/选集接口异常，或本机断网）');
    console.log('  建议：先跑 --probe <vid> 直接指定一集验证；'
      + '或在 config.json 的 runtime.watch.series 里写死样本');
    return 1;
  }
  console.log('  结果：' + (r.total - r.fails.length) + '/' + r.total + ' 正常，'
    + r.fails.length + ' 集失败');
  await reportFailure();
  return 1;
}

/** 常驻巡检。 */
async function watch(minutes) {
  const configured = Config.num('runtime.watch.interval_minutes', 30);
  const period = Math.max(1, Math.min(720, Number(minutes) || configured || 30));
  console.log('');
  console.log('  协议巡检已启动：每 ' + period + ' 分钟一轮，Ctrl+C 退出');
  console.log('');
  let lastOk = null;
  const once = async () => {
    const t = clock();
    const r = await round(true);
    const line = '[' + t + '] ' + (r.ok ? '正常' : '异常')
      + ' ' + (r.total - r.fails.length) + '/' + r.total + ' ' + r.ms + 'ms';
    if (r.ok) {
      // 只在状态翻转时打成功日志，避免刷屏
      if (lastOk !== true) Log.info(line);
    } else {
      Log.warn(line + (r.fails.length > 0 ? '：' + r.fails[0].label + ' → ' + r.fails[0].error : ''));
      if (lastOk !== false) {
        for (const f of r.fails) Log.warn('  失败样本 ' + f.label + '：' + f.error);
      }
    }
    lastOk = r.ok;
  };
  await once();
  setInterval(() => { once().catch((e) => Log.warn('巡检异常：' + e.message)); },
    period * 60 * 1000);
  return new Promise(() => { /* 常驻 */ });
}

/**
 * 服务进程内的定期巡检（默认开启，可用 runtime.watch.auto=false 关闭）。
 *
 * 只在「状态翻转」时打日志：正常时不打扰，坏了立刻在服务日志里看到一行，
 * 不用等下次想看了才发现播不了。
 *
 * @returns {NodeJS.Timeout|null} 定时器（已 unref，不会阻止进程退出）
 */
function startAuto() {
  if (Config.bool('runtime.watch.auto', true) === false) return null;
  const minutes = Config.num('runtime.watch.interval_minutes', 30);
  const period = Math.max(5, Math.min(720, Number(minutes) || 30));
  let lastOk = null;
  const tick = async () => {
    const r = await round(true);
    if (r.total === 0) return; // 拿不到样本多半是本机断网，不当成协议故障
    if (r.ok) {
      if (lastOk === false) {
        Log.info('播放链路恢复正常（巡检 ' + r.total + '/' + r.total + ' 正常）');
      }
    } else if (lastOk !== false) {
      Log.warn('播放链路异常（巡检 ' + (r.total - r.fails.length) + '/' + r.total + '）：'
        + r.fails[0].label + ' → ' + r.fails[0].error);
      Log.warn('可先试 node server/src/main.js --sync-constants --apply；'
        + '仍失败用 --probe <vid> 定位');
    }
    lastOk = r.ok;
  };
  // 启动 3 分钟后先跑一次（避开启动时的取址高峰），之后按周期
  const first = setTimeout(() => { tick().catch(() => { /* 忽略 */ }); }, 3 * 60 * 1000);
  if (first.unref) first.unref();
  const timer = setInterval(() => { tick().catch(() => { /* 忽略 */ }); }, period * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { check, watch, round, resolveSamples, startAuto };
