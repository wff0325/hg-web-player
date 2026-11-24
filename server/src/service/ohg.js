'use strict';
/**
 * openhongguo SDK 桥接层。
 *
 * 后端是 CommonJS，而 SDK 是 ESM-only 且加载一个 Go 编译的 wasm。Node 的 CJS
 * 可以用动态 import() 加载 ESM，因此这里把 SDK 包 vendor 在 <root>/vendor/openhongguo，
 * 进程内只加载一次 wasm、只创建一个 client（设备档案共用同一份）。
 *
 * 设计要点：
 *   1) 设备档案落在 server/config/ohg-anonymous.json，受 web-sync 的 DENY 保护，
 *      不会被内置更新覆盖；两台不同机器各自注册自己的匿名设备。
 *   2) 所有方法统一包装：SDK 抛 OpenhongguoError（带 code/retryable），这里转成
 *      { ok, data, error } 形式，HTTP 层据此决定状态码。
 *   3) 失败自动重试交给 SDK（retryAttempts + deviceResets）。
 */
const path = require('path');
const fs = require('fs');
const Config = require('../util/config');
const Log = require('../util/log');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRY = path.join(ROOT, 'vendor', 'openhongguo', 'index.js').replace(/\\/g, '/');
const PROFILE = path.join(ROOT, 'server', 'config', 'ohg-anonymous.json');
// 磁盘缓存：进程重启后仍命中，消除首页 ~8s 的冷启动（榜单/分类/批量详情）。
// 落在 server/config/ 下，受 web-sync 的 DENY 保护，不会被内置更新覆盖。
const DISK_CACHE = path.join(ROOT, 'server', 'config', 'ohg-cache.json');

let clientPromise = null;
let sdkModule = null;

/** 懒加载 SDK：首次调用时加载 wasm 并创建 client，之后复用。 */
async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const sdk = await import('file://' + ENTRY);
      sdkModule = sdk;
      fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
      const client = await sdk.createClient({
        profile: sdk.fileProfileStore(PROFILE),
        retryAttempts: 3,
        deviceResets: 2,
        timeoutMs: 30000,
      });
      return client;
    })().catch((e) => {
      clientPromise = null; // 允许下次重试
      throw e;
    });
  }
  return clientPromise;
}

/** 生成一个可 await 的代理：ohg.search(...) -> Promise<原始数据>。 */
const METHODS = [
  'discover', 'search', 'suggest', 'hotSearch', 'searchCues', 'newReleases',
  'getSeries', 'getSeriesBatch', 'listEpisodes', 'listDanmaku', 'seasons',
  'seriesRecommend', 'getAlbum', 'shortRank', 'shortFilterPanel', 'shortFilter',
  'ranking', 'rankRows', 'rankGroups', 'person', 'personWorks', 'categories',
  'categoryLanding', 'resolvePlayback', 'resetDevice',
];
// AsyncGenerator 方法（翻页遍历）需单独包装成 async generator，不能当普通 Promise 方法。
const GENERATORS = ['discoverAll', 'searchAll'];

/* ---------------- 内存缓存 ----------------
 * SDK 每次调用都要打上游（签名 + JSON 解析，单趟 0.7~1.5s）。榜单/分类/详情
 * 这类数据分钟级不变，缓存起来可让「再次加载」秒回。
 * - 不缓存 resolvePlayback：contentKey 与设备强绑定且服务端限流，每次必须现取。
 * - 同 key 并发去重：首页同时拉三个频道时，重复的 getSeriesBatch 只打一次。
 */
const CACHE_TTL = {
  hotSearch: 10 * 60e3, searchCues: 10 * 60e3, rankGroups: 10 * 60e3,
  shortFilterPanel: 10 * 60e3, categories: 10 * 60e3, categoryLanding: 5 * 60e3,
  shortRank: 3 * 60e3, rankRows: 3 * 60e3, ranking: 3 * 60e3,
  shortFilter: 3 * 60e3, discover: 3 * 60e3, search: 2 * 60e3, suggest: 2 * 60e3,
  newReleases: 5 * 60e3,
  getSeries: 5 * 60e3, getSeriesBatch: 5 * 60e3, listEpisodes: 5 * 60e3,
  seasons: 5 * 60e3, getAlbum: 5 * 60e3, seriesRecommend: 5 * 60e3,
  person: 5 * 60e3, personWorks: 5 * 60e3, listDanmaku: 5 * 60e3,
};
const NO_CACHE = new Set(['resolvePlayback', 'resetDevice']);
const cache = new Map();        // key -> { at, value }
const inflight = new Map();     // key -> Promise
let cacheHits = 0;
let cacheMisses = 0;

/* ---------------- 磁盘缓存（冷启动提速） ----------------
 * 榜单/分类/批量详情这些首页数据分钟级不变，且每次进程重启都要重新拉，
 * 是「首页冷启动 8 秒」的主因。把内存缓存按 TTL 落盘，重启后直接命中。
 * - 只落 CACHE_TTL 里声明的方法；resolvePlayback 等 NO_CACHE 永不落盘。
 * - 落盘节流 1 秒，原子写（临时文件 + rename），避免半截 JSON。
 * - 恢复时按磁盘保存时间重新计算 TTL：过期的直接丢弃。
 * - 磁盘 TTL 与内存 TTL 独立，用 runtime.sdk_disk_cache_ttl_hours 可调（默认 6h）。
 */
const DISK_FLUSH_MS = 1000;
let diskDirty = false;
let diskTimer = null;
let diskLoaded = false;
let diskEntries = 0;
let diskSaveCount = 0;

function diskTtlMs() {
  const h = Number(Config.num('runtime.sdk_disk_cache_ttl_hours', 6));
  return h * 3600e3;   // 0 = 关闭磁盘缓存（落盘与恢复都跳过）
}

function diskLoad() {
  if (diskLoaded) return;
  diskLoaded = true;
  if (diskTtlMs() <= 0) return;   // 显式关闭
  try {
    if (!fs.existsSync(DISK_CACHE)) return;
    const raw = JSON.parse(fs.readFileSync(DISK_CACHE, 'utf8'));
    const rows = Array.isArray(raw && raw.entries) ? raw.entries : [];
    const ttl = diskTtlMs();
    const now = Date.now();
    for (const row of rows) {
      if (!row || typeof row.k !== 'string' || !row.v) continue;
      if (typeof row.t !== 'number' || now - row.t >= ttl) continue; // 磁盘过期
      // 恢复进内存时把 at 记为 now，让内存 TTL 重新计时；磁盘 TTL 已在上行把关。
      cache.set(row.k, { at: now, value: row.v });
      diskEntries++;
    }
    if (rows.length) Log.info('SDK 磁盘缓存已加载 ' + diskEntries + ' 条（首页冷启动可直接命中）');
  } catch (e) {
    // 缓存损坏不影响启动，当作没有缓存
    Log.warn('SDK 磁盘缓存读取失败（忽略）：' + (e && e.message ? e.message : e));
  }
}

function diskFlush() {
  diskTimer = null;
  if (!diskDirty || diskTtlMs() <= 0) { diskDirty = false; return; }
  diskDirty = false;
  try {
    const now = Date.now();
    const entries = [];
    for (const [k, hit] of cache) {
      const m = k.split(':', 1)[0];
      if (!CACHE_TTL[m] || NO_CACHE.has(m)) continue;
      entries.push({ k, t: now, v: hit.value });
    }
    fs.mkdirSync(path.dirname(DISK_CACHE), { recursive: true });
    const tmp = DISK_CACHE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ saved_at: now, entries }));
    fs.renameSync(tmp, DISK_CACHE);
    diskEntries = entries.length;
    diskSaveCount++;
  } catch (e) {
    Log.warn('SDK 磁盘缓存落盘失败（忽略）：' + (e && e.message ? e.message : e));
  }
}

function scheduleDiskFlush() {
  diskDirty = true;
  if (diskTimer !== null) return;
  diskTimer = setTimeout(diskFlush, DISK_FLUSH_MS);
  if (diskTimer.unref) diskTimer.unref();
}

function cacheKey(m, args) {
  try { return m + ':' + JSON.stringify(args); } catch (e) { return m + ':' + String(args); }
}

function cacheGet(key, ttl) {
  if (!diskLoaded) diskLoad();
  const hit = cache.get(key);
  if (hit !== null && hit !== undefined && Date.now() - hit.at < ttl) {
    cacheHits++;
    return hit.value;
  }
  if (hit !== null && hit !== undefined) cache.delete(key); // 过期即清
  return undefined;
}

function cachePut(key, value) {
  cache.set(key, { at: Date.now(), value });
  // 上限 500 条，超出淘汰最旧
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  // 只有声明 TTL 的方法才落盘；resolvePlayback 等敏感数据不碰磁盘
  const m = key.split(':', 1)[0];
  if (CACHE_TTL[m] && !NO_CACHE.has(m)) scheduleDiskFlush();
}

const api = {};
for (const m of METHODS) {
  api[m] = async (...args) => {
    const ttl = CACHE_TTL[m];
    if (!ttl || NO_CACHE.has(m)) {
      const c = await getClient();
      return c[m](...args);
    }
    const key = cacheKey(m, args);
    const hit = cacheGet(key, ttl);
    if (hit !== undefined) return hit;
    // 同 key 正在飞行的请求直接复用
    const flying = inflight.get(key);
    if (flying !== undefined) return flying;
    cacheMisses++;
    const task = (async () => {
      const c = await getClient();
      const value = await c[m](...args);
      cachePut(key, value);
      return value;
    })();
    inflight.set(key, task);
    try { return await task; } finally { inflight.delete(key); }
  };
}

/** 缓存统计（供 /health 与验证用）。 */
function cacheStats() {
  return { entries: cache.size, hits: cacheHits, misses: cacheMisses,
    disk_entries: diskEntries, disk_saves: diskSaveCount,
    hitRate: cacheHits + cacheMisses > 0
      ? Math.round(cacheHits * 100 / (cacheHits + cacheMisses)) + '%' : '0%' };
}

/** 清空缓存（内置更新后或手动刷新用）。 */
function cacheClear() {
  cache.clear(); cacheHits = 0; cacheMisses = 0;
  // 同时清磁盘，避免更新后仍命中旧版数据
  try {
    if (fs.existsSync(DISK_CACHE)) fs.unlinkSync(DISK_CACHE);
    diskEntries = 0;
  } catch (e) { /* 忽略 */ }
}
for (const m of GENERATORS) {
  api[m] = async function* (...args) {
    const c = await getClient();
    for await (const item of c[m](...args)) yield item;
  };
}

/** 把 SDK 错误转成稳定结构，供 HTTP 层统一处理。 */
function normalizeError(e) {
  if (!e) return { code: 'UNKNOWN', message: 'unknown error', retryable: false, retryAfterMs: 0 };
  return {
    code: String(e.code || 'UNKNOWN'),
    message: String(e.message || e),
    retryable: e.retryable === true,
    retryAfterMs: Number(e.retryAfterMs || 0),
  };
}

/** 搜索筛选项常量（真人剧/漫剧/AI剧/影视剧/未看过）。 */
function searchFilters() {
  return sdkModule ? sdkModule.SearchFilter : {
    ShortPlay: 'content_type_short_play',
    Comic: 'content_type_dynamic_comic',
    AIComic: 'content_type_ai_dynamic_comic',
    Film: 'content_type_long_video',
    Unwatched: 'search_range_unread',
  };
}

/** 是否加载成功（供 /health 展示）。 */
function ready() {
  return clientPromise !== null;
}

/** 重启设备（用户主动换号）。 */
async function resetDevice() {
  await api.resetDevice();
  return true;
}

module.exports = Object.assign({}, api, {
  getClient,
  normalizeError,
  searchFilters,
  ready,
  resetDevice,
  cacheStats,
  cacheClear,
  profilePath: PROFILE,
  methods: METHODS.concat(GENERATORS),
});
