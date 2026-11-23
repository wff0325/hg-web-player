// 红果官方弹幕抓取（带视频时间轴的真弹幕）。
//
// 接口：POST https://api5-normal-sinfonlineb.fqnovel.com/novel/commentapi/comment/list/{vid}/v1/
// 每条弹幕带 offset_time（毫秒），除以 1000 就是投放时间。
//
// 移植自 jackotom/hongguo-drama 的 src/native/danmaku.js（其分页与解析逻辑
// 又来自 dawei233/hongguo-drama 的 nas-backend/danmaku.py / guoapp Go 版）。
// 与上游的区别：传输层换成项目自己的 util/http（不引 axios），设备指纹落在
// server/config/danmaku-device.json。
//
// ## 失败语义（重要）
//
// 「源不可用」和「本集真的没有弹幕」是两件事，任何情况下都不能互相冒充：
//   · 拿不到 → success:false + error 里写清原因，notice 沿用错误说明；
//   · 拿到了但是空 → success:true + notice:'本集暂无弹幕'。
// 界面上必须照这个显示，否则用户会以为这集没人发弹幕。
//
// ## 不可控依赖
//
// 这不是公开接口，需要伪造官方客户端签名头。上游随时可能改算法/改参数/封禁，
// 本模块不保证长期可用；所有失败都返回对象，绝不抛异常，调用方必须有降级路径。

'use strict';

const fs = require('fs');
const path = require('path');
const Http = require('../util/http');
const Log = require('../util/log');
const sign = require('./danmaku-sign');

const BASE_URL = 'https://api5-normal-sinfonlineb.fqnovel.com';
const COMMENT_PATH = (vid) => '/novel/commentapi/comment/list/' + encodeURIComponent(vid) + '/v1/';

// 冒充官方 Android 客户端；UA 与签名参数必须成套，不能只改一个。
const USER_AGENT = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; '
  + 'Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 '
  + 'QuicVersion:c67e9834 2025-09-08)';

const MAX_TEXT_LEN = 200;               // 超长文本直接丢弃（正常弹幕不会这么长）
const MAX_TIME_SECONDS = 604800;        // 7 天，超出视为脏数据
const PAGE_COUNT = 90;                  // 单次向上游要的条数
const MAX_PAGES = 40;                   // 分页上限，防死循环
const MAX_ITEMS = 3000;                 // 单集上限，防内存失控
const REQUEST_TIMEOUT = 20000;
const EFFECTIVE_DURATION_MS = 3600000;  // 单次请求声明的「剧集时长」
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;  // 上游窗口上限，超过会被拒
const MAX_EMPTY_PAGES = 2;              // 连续空页就停：上游偶尔 has_more=true 却一直给空
const PAGE_GAP_MS = 120;                // 相邻分页间隔，别把上游打急
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const CACHE_TTL_OK = 5 * 60 * 1000;
const CACHE_TTL_FAIL = 15 * 1000;
const CACHE_MAX = 64;

const cache = new Map();
const pending = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 设备指纹 ──────────────────────────────────────────────────────────────

/** 上游按匿名标识分配弹幕子集，跨重启必须复用同一份标识。 */
const IDENTITY_FILE = path.join('server', 'config', 'danmaku-device.json');
let identity = null;

function loadIdentity() {
  if (identity !== null) return identity;
  const create = () => ({ deviceId: sign.newDeviceId(), installId: sign.newDeviceId() });
  try {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      saved = create();
      fs.writeFileSync(IDENTITY_FILE, JSON.stringify(saved), { mode: 0o600 });
    }
    if (typeof saved.deviceId !== 'string' || typeof saved.installId !== 'string'
        || !/^\d{19}$/.test(saved.deviceId) || !/^\d{19}$/.test(saved.installId)) {
      throw new Error('invalid identity');
    }
    identity = { deviceId: saved.deviceId, installId: saved.installId };
  } catch (e) {
    const err = new Error('弹幕本机配置读取或保存失败');
    err.code = 'DANMAKU_IDENTITY_IO';
    throw err;
  }
  return identity;
}

/** 仅供自检：覆盖进程内设备指纹。 */
function setDeviceIdentity(value) { identity = value; }

// ── 解析（对齐参考实现的清洗规则） ────────────────────────────────────────

const asText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
};

/** 归一成 #RRGGBB，拿不到用白色。 */
function normalizeColor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return '#FFFFFF';
    return '#' + (value & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '#FFFFFF';
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) {
      return '#' + [...text.slice(1)].map((c) => c + c).join('').toUpperCase();
    }
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) return '#FFFFFF';
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return '#' + (parsed & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
    }
  }
  return '#FFFFFF';
}

/**
 * 归一成 scroll / top / bottom。
 *
 * 红果评论接口目前**不下发**位置字段，实测恒为 scroll。保留多 holder 的兜底
 * 识别，是给上游将来补字段留的口子，不要因为「反正总是 scroll」就删掉。
 */
function normalizeMode(...holders) {
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of ['mode', 'danmaku_type', 'position', 'fix_type', 'danmaku_position']) {
      const value = holder[key];
      if (value === null || value === undefined) continue;
      const token = asText(value).trim().toLowerCase();
      if (['top', '2', 'fix_top', '顶部'].includes(token)) return 'top';
      if (['bottom', '3', 'fix_bottom', '底部'].includes(token)) return 'bottom';
    }
  }
  return 'scroll';
}

/** 控制字符与行分隔符换成空格，避免污染渲染层。 */
function cleanControl(text) {
  let out = '';
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    out += code < 0x20 || code === 0x7f || char === '\u2028' || char === '\u2029' ? ' ' : char;
  }
  return out.trim();
}

/** 毫秒 → 秒，并挡掉越界值。 */
function toSeconds(value) {
  if (typeof value !== 'number'
      && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const seconds = num / 1000;
  if (seconds < 0 || seconds > MAX_TIME_SECONDS) return null;
  return seconds;
}

/**
 * 解析一页，返回 { items, nextMs, hasMore }。
 *
 * 分页信号有两个来源，实测都出现过：
 *   1. data.extra.next_query_danmaku_list_time —— 参考实现用的就是这个；
 *   2. data.common_list_info（has_more + cursor.end_offset_time）。
 * 实测响应里 extra 常常是空对象，真正的「还有没有」写在 common_list_info 里。
 * 只认第 1 个的话，extra 一空就会把「还有更多」误判成「没有了」，整集只剩首页。
 * 两个都读，显式的 has_more:false 优先。
 */
function parsePage(payload, vid) {
  const empty = { items: [], nextMs: null, hasMore: null };
  if (!payload || typeof payload !== 'object') return empty;
  const data = payload.data;
  if (!data || typeof data !== 'object') return empty;
  const rows = Array.isArray(data.data_list) ? data.data_list : [];

  let nextMs = null;
  let hasMore = null;

  const extra = data.extra;
  if (extra && typeof extra === 'object') {
    const raw = asText(extra.next_query_danmaku_list_time).trim();
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) nextMs = parsed;
    }
  }

  const info = data.common_list_info;
  if (info && typeof info === 'object') {
    const flag = info.has_more;
    if (typeof flag === 'boolean') hasMore = flag;
    else if (typeof flag === 'string') hasMore = ['1', 'true', 'yes'].includes(flag.trim().toLowerCase());
    else if (asText(flag)) hasMore = !['0', 'false', 'no'].includes(asText(flag));

    let cursor = info.cursor;
    if (typeof cursor === 'string' && cursor.trim().startsWith('{')) {
      try { cursor = JSON.parse(cursor); } catch (e) { cursor = null; }
    }
    if (cursor && typeof cursor === 'object') {
      for (const key of ['end_offset_time', 'next_offset_time', 'offset']) {
        const candidate = Number.parseInt(cursor[key], 10);
        if (!Number.isFinite(candidate)) continue;
        if (nextMs === null || candidate > nextMs) nextMs = candidate;
        break;
      }
    }
  }

  // 明确说没有更多了，就别再翻（此时即便有 cursor 也不该继续）
  if (hasMore === false) nextMs = null;

  const items = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const comment = raw.comment;
    if (!comment || typeof comment !== 'object') continue;
    const common = comment.common && typeof comment.common === 'object' ? comment.common : {};

    // 只收本视频、且状态正常的弹幕：别的值会把待审核/已折叠的脏数据混进来
    const groupId = asText(common.group_id);
    if (groupId && groupId !== vid) continue;
    if (asText(common.status) !== '1') continue;

    const content = common.content;
    const text = asText(content && typeof content === 'object' ? content.text : null);

    const expand = comment.expand && typeof comment.expand === 'object' ? comment.expand : {};
    let timeRaw = expand.offset_time;
    if (timeRaw === null || timeRaw === undefined) timeRaw = comment.offset_time;

    let colorRaw;
    for (const holder of [content, common, expand, comment]) {
      if (!holder || typeof holder !== 'object') continue;
      for (const key of ['color', 'font_color', 'text_color', 'col']) {
        if (holder[key] !== null && holder[key] !== undefined) {
          colorRaw = holder[key];
          break;
        }
      }
      if (colorRaw !== undefined) break;
    }

    items.push({
      text,
      timeRaw,
      color: normalizeColor(colorRaw),
      // 参考实现只看 raw / comment 两层；这里把 expand 也纳入，纯属放宽识别范围
      // （上游当前不下发位置字段，恒为 scroll，多认一层不会误判成 top/bottom）。
      mode: normalizeMode(raw, comment, expand),
    });
  }

  if (nextMs !== null && nextMs <= 0) nextMs = null;
  return { items, nextMs, hasMore };
}

// ── 请求 ──────────────────────────────────────────────────────────────────

function buildBody(vid, bookId, start, duration) {
  return {
    comment_source: 601,
    server_channel: 1000,
    group_id: vid,
    group_type: 30,
    comment_type: 20,
    sort: 1,
    count: PAGE_COUNT,
    cursor: '',
    aid: 8662,
    compliance_status: 0,
    business_param: {
      book_id: bookId,
      start_offset_time: start,
      playlet_item_duration: duration,
      need_danmaku_guide_type: [1, 3, 4, 2],
    },
  };
}

/**
 * 请求一个时间窗口。
 *
 * 时间戳与 nonce 在同一个函数里生成并共用：签名是对 query 字符串算的，
 * query 里含 _rticket（毫秒），而 X-Khronos 用的是秒，三者不一致就是无效签名。
 */
async function requestWindow({ vid, bookId, start, duration }) {
  const stampMs = Date.now();
  const stamp = Math.floor(stampMs / 1000);
  const nonce = require('crypto').randomBytes(sign.NONCE_BYTES);
  const { deviceId, installId } = loadIdentity();

  const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
  const url = BASE_URL + COMMENT_PATH(vid) + '?' + rawQuery;
  const headers = Object.assign({
    'user-agent': USER_AGENT,
    accept: 'application/json',
    'X-XS-From-Web': '0',
    'Sdk-Version': '2',
    'content-type': 'application/json; charset=utf-8',
    'Comment-Source': '601',
    'Server-Channel': '1000',
  }, sign.signCommentHeaders({ rawQuery, stamp, nonce }));

  const res = await Http.send({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(vid, bookId, start, duration)),
    timeoutMs: REQUEST_TIMEOUT,
    followRedirect: false,
  });

  if (res.status < 200 || res.status >= 300) {
    const err = new Error('弹幕接口 HTTP ' + res.status);
    err.httpStatus = res.status;
    throw err;
  }
  const body = res.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('弹幕响应过大');
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    throw new Error('弹幕接口返回了非 JSON 内容');
  }
  const code = payload ? payload.code : undefined;
  if ((code !== 0 && code !== '0') || !Array.isArray(payload.data && payload.data.data_list)) {
    const err = new Error('弹幕接口响应无效');
    err.upstreamCode = code === undefined ? (payload && payload.Code) : code;
    err.upstreamMessage = (payload && (payload.message || payload.Message)) || '';
    throw err;
  }
  return payload;
}

// ── 对外接口 ──────────────────────────────────────────────────────────────

/**
 * 汇总成最终返回值。
 *
 * 所有出口都走这里：源不可用、被限流、部分成功都要经过同一个地方计算 notice，
 * 否则某条分支提前 return 就会把「拿不到」显示成「本集没有弹幕」。
 */
function finalize({ seriesId, vid, items, truncated, error }) {
  let notice;
  if (error) notice = error;
  else if (truncated) notice = '弹幕较多，本次仅载入前 ' + items.length + ' 条';
  else if (!items.length) notice = '本集暂无弹幕';
  else notice = '';
  return {
    success: !error,
    source: 'official',
    series_id: seriesId,
    episode_id: vid,
    items,
    total: items.length,
    truncated: Boolean(truncated),
    partial: Boolean(error) && items.length > 0,
    error: error || '',
    notice,
  };
}

/** 按 limit 裁剪后再算一次说明：裁剪只改「多少条」，不改「为什么是这些条」。 */
function present(result, items, limit) {
  if (items.length <= limit) return Object.assign({}, result, { items, total: items.length });
  const sliced = items.slice(0, limit);
  return Object.assign({}, result, {
    items: sliced,
    total: sliced.length,
    truncated: true,
    notice: result.error ? result.notice : '弹幕较多，本次仅载入前 ' + sliced.length + ' 条',
  });
}

/**
 * 抓取一集的官方弹幕。
 *
 * @param {object} options
 * @param {string} options.seriesId 剧集 ID（business_param.book_id）
 * @param {string} options.vid      本集视频 ID（group_id）。两者不同，填错会被上游拒。
 * @param {number} [options.limit]  返回条数上限（默认 MAX_ITEMS）
 * @param {boolean} [options.fresh] 绕过缓存（界面上的「重试」用）
 * @returns {Promise<object>} 任何异常都转成 success:false + 中文说明，不抛出
 */
async function fetchDanmaku(options) {
  const opt = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const seriesId = typeof opt.seriesId === 'string' ? opt.seriesId.trim() : '';
  const vid = typeof opt.vid === 'string' ? opt.vid.trim() : '';
  const limit = opt.limit === undefined ? MAX_ITEMS : opt.limit;
  const bookId = typeof opt.bookId === 'string' && opt.bookId.trim() !== ''
    ? opt.bookId.trim() : seriesId;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ITEMS) {
    return finalize({ seriesId, vid, items: [], error: '弹幕请求参数无效' });
  }
  if (!/^\d{6,30}$/.test(seriesId) || !/^\d{6,30}$/.test(vid)) {
    return finalize({ seriesId, vid, items: [], error: '仅红果来源的剧集支持弹幕' });
  }

  const cacheKey = seriesId + ':' + vid;
  const hit = cache.get(cacheKey);
  // fresh 供「重试」使用：失败结果有 15 秒 TTL，不绕过的话点了重试只会再拿到
  // 同一条缓存失败，看起来像按钮没反应。
  if (hit && hit.expires > Date.now() && opt.fresh !== true) {
    return present(hit.result, hit.items, limit);
  }
  if (pending.has(cacheKey)) {
    const shared = await pending.get(cacheKey);
    return present(shared.result, shared.items, limit);
  }

  const task = (async () => {
    const collected = [];
    const seen = new Set();
    let start = 0;
    let duration = EFFECTIVE_DURATION_MS;
    let emptyPages = 0;
    let truncated = false;
    let failure = '';

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        if (page > 0) await sleep(PAGE_GAP_MS);

        let payload;
        try {
          payload = await requestWindow({ vid, bookId, start, duration });
        } catch (error) {
          // 错误说明要让用户能判断：发生了什么、试过什么、还能做什么。
          // 首页失败说明源不可用；后续页失败保留已拿到的部分，不把整集判死。
          failure = error && error.code === 'DANMAKU_IDENTITY_IO'
            ? '弹幕本机配置读取或保存失败，请检查 server/config 目录权限后重试'
            : collected.length
              ? '后续弹幕加载中断，已保留已获取的部分'
              : error && error.httpStatus
                ? '弹幕接口不可用（HTTP ' + error.httpStatus + '），已用官方签名请求'
                : error && error.upstreamCode
                  ? '弹幕接口拒绝了请求（' + error.upstreamCode
                    + (error.upstreamMessage ? ' ' + error.upstreamMessage : '') + '）'
                  : '弹幕接口暂不可用（已用官方签名请求），请稍后重试';
          Log.warn('弹幕抓取失败 vid=' + vid + '：' + (error && error.message));
          break;
        }

        const pageResult = parsePage(payload, vid);
        const pageItems = pageResult.items;
        let nextMs = pageResult.nextMs;
        const hasMore = pageResult.hasMore;
        if (pageItems.length) emptyPages = 0;
        else emptyPages += 1;

        for (const item of pageItems) {
          const seconds = toSeconds(item.timeRaw);
          if (seconds === null) continue;
          const text = cleanControl(item.text);
          if (!text || text.length > MAX_TEXT_LEN) continue;
          const key = seconds.toFixed(3) + '|' + text;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push({ time: seconds, text, color: item.color, mode: item.mode });
          if (collected.length >= MAX_ITEMS) break;
        }

        if (collected.length >= MAX_ITEMS) {
          truncated = true;
          break;
        }
        if (nextMs === null) {
          if (hasMore === true) {
            truncated = true;
            if (!collected.length) failure = '弹幕接口未返回有效分页，请稍后重试';
          }
          break;
        }
        if (nextMs <= start || nextMs > MAX_TIME_SECONDS * 1000
            || emptyPages >= MAX_EMPTY_PAGES || page === MAX_PAGES - 1) {
          truncated = true;
          if (!collected.length) failure = '弹幕接口未返回有效分页，请稍后重试';
          break;
        }
        start = nextMs;
        // 上游拒绝超过 24 小时的窗口，所以 duration 向后延时要封顶
        duration = Math.min(Math.max(duration, start + EFFECTIVE_DURATION_MS), MAX_DURATION_MS);
      }
    } catch (error) {
      failure = '弹幕处理失败，请稍后重试';
      Log.warn('弹幕解析异常 vid=' + vid + '：' + (error && error.message));
    }

    collected.sort((a, b) => a.time - b.time);

    // 缓存完整结果与完整列表；limit 只在呈现时裁剪，避免缓存被「半截」结果污染。
    const result = finalize({ seriesId, vid, items: collected, truncated, error: failure });
    cache.set(cacheKey, {
      expires: Date.now() + (failure ? CACHE_TTL_FAIL : CACHE_TTL_OK),
      items: collected,
      result,
    });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { result, items: collected };
  })();

  pending.set(cacheKey, task);
  try {
    const done = await task;
    return present(done.result, done.items, limit);
  } finally {
    if (pending.get(cacheKey) === task) pending.delete(cacheKey);
  }
}

/** 仅供自检：清空缓存与在途状态。 */
function resetDanmakuCache() {
  cache.clear();
  pending.clear();
}

module.exports = {
  fetchDanmaku,
  parsePage,
  normalizeColor,
  normalizeMode,
  cleanControl,
  toSeconds,
  buildBody,
  requestWindow,
  resetDanmakuCache,
  setDeviceIdentity,
  BASE_URL,
  COMMENT_PATH,
  USER_AGENT,
  MAX_ITEMS,
  MAX_TEXT_LEN,
  MAX_TIME_SECONDS,
  PAGE_COUNT,
};
