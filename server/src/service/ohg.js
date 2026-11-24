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

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRY = path.join(ROOT, 'vendor', 'openhongguo', 'index.js').replace(/\\/g, '/');
const PROFILE = path.join(ROOT, 'server', 'config', 'ohg-anonymous.json');

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
const api = {};
for (const m of METHODS) {
  api[m] = async (...args) => {
    const c = await getClient();
    return c[m](...args);
  };
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
  profilePath: PROFILE,
  methods: METHODS.concat(GENERATORS),
});
