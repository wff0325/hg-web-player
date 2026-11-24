'use strict';
/**
 * App 签名取直链，移植自 jackotom/hongguo-drama 的 src/native/app-source.js。
 *
 * 对应原 Java service/AppSource.java。
 *
 * 为什么需要这个模块：老的 multi_video_model/preload/v1 链路对部分分集
 * （实测 vid=7693917197759958040）已不再返回 video_model 数据 —— data 为 null，
 * 表现为「预热失败：无直链 / video_model」。修复方式是换一条路：
 *   1. 自带一套完整的合成真机设备身份（DEVICE 常量 + 每请求随机 iid/device_id），
 *      改打 b 域名（api5-normal-sinfonlineb）的 multi_video_model/v1；
 *   2. 响应里的 video_model 不再直接带 video_list，而是给一个 fallback_api 地址，
 *      二次 GET 才拿到 video_info.data.video_list；
 *   3. 媒体 URL 可能被 key_seed 加密（AES-128-CBC），需先解密；
 *   4. spade_a -> content key 的推导复用 Spade.unwrapV1。
 */
const crypto = require('crypto');
const zlib = require('zlib');
const PureSign = require('../core/pure-sign');
const Spade = require('../core/spade');
const Crypto = require('../util/crypto');
const Http = require('../util/http');
const Json = require('../util/json');
const Log = require('../util/log');
const PlaybackDevice = require('./playback-device');

/**
 * 播放取址接口（Android v5，v04.10.03 签名）。
 *
 * 2026-11-24 上游切换：currentApp 7.4.5.32 使用
 * multi_video_model/preload/v1 + v5 Medusa/Helios/Khronos 签名，
 * 见 core/pure-sign.js 的 signPlaybackV5。
 */
const VIDEO_API_HOST = 'reading.snssdk.com';
/** 同协议备用域名：b/hl/lf 与当前设备无关，按序尝试一次。 */
const VIDEO_API_HOST_ALT = 'api5-normal-sinfonlineb.fqnovel.com';
const VIDEO_API_HOSTS = [
  VIDEO_API_HOST,
  VIDEO_API_HOST_ALT,
  'api5-normal-hl.fqnovel.com',
  'api5-normal-lf.fqnovel.com',
];
const VIDEO_API_PATH = '/novel/player/multi_video_model/preload/v1';
const VIDEO_API = 'https://' + VIDEO_API_HOST + VIDEO_API_PATH;

/**
 * 官方 App 现行的单集取址：GET video_tab。
 *
 * 2026-11-24：currentApp 主路径已迁到 preload/v1，video_tab 退为同身份兜底；
 * 仅在 preload 全链路空响应时用当前注册身份重查本集，避免换设备烧注册配额。
 */
const VIDEO_TAB_API = 'https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/';

/** GET 取址的 query 前缀。
 *  顺序按上游 N3urda/hongguoTV 0.16.12 MobilePlayback.query() 逐字对齐：
 *  身份字段（iid/cdid/device_id）在分集字段之前，_rticket 由签名器最后追加。 */
const VIDEO_TAB_QUERY = {
  aid: '8662',
  app_name: 'novelread',
  version_code: '74532',
  version_name: '7.4.5.32',
  update_version_code: '74532',
  manifest_version_code: '74532',
  os: 'android',
  ssmix: 'a',
  channel: 'update_64',
  device_platform: 'android',
  device_type: '25053RT47C',
  device_brand: 'Redmi',
  os_version: '16',
  os_api: '36',
  ac: 'wifi',
  language: 'zh',
  host_abi: 'arm64-v8a',
};

/** GET 取址的分集参数，顺序同样对齐 videoTabRequest()。 */
const VIDEO_TAB_EXTRA = {
  video_id_type: '0',
  device_level: '1',
  need_all_video_definition: '1',
  need_mp4_align: '0',
  use_os_player: '0',
  video_platform: '1024',
  source: '0',
  from_video_id: '',
};

/** GET 取址的 UA：官方 7.3.9.32 Cronet 形态，机型随 currentApp 档。 */
const VIDEO_TAB_UA = 'com.phoenix.read/73932 (Linux; U; Android 16; zh_CN; 25053RT47C; '
  + 'Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';

/** 播放请求 UA：currentApp 使用 Android http.agent，机型/Build 与 query 同源。 */
const VIDEO_UA = 'Dalvik/2.1.0 (Linux; U; Android 16; 25053RT47C Build/BP2A.250605.031.A3)';

const VERSION_NAME = '7.4.5.32';

/**
 * beilunyang/openhongguo v0.4.1 的当前播放主链路。
 *
 * 2026-11-24 上游把真机 medusa 状态从模拟器的 377 改成 369 后，
 * 旧的 preload/v1 + device_level=2 + dr_scene=preload 整条链路开始回空包；
 * 当前 App 走 player/v1、7.4.3.32 档、device_level=1、dr_scene=player。
 * 下面这组常量与上游 PlaybackV5Pairs/PlaybackV5Body 逐字对齐，
 * 其中 _rticket 占位符的位置属于 query 顺序，不能挪到末尾。
 */
const PLAYBACK_V5_PATH = '/novel/player/multi_video_model/player/v1';
const PLAYBACK_V5_HOST = 'api5-normal-sinfonlinea.fqnovel.com';
const PLAYBACK_V5_API = 'https://' + PLAYBACK_V5_HOST + PLAYBACK_V5_PATH;
const PLAYBACK_V5_UA = 'com.phoenix.read/74332 (Linux; U; Android 14; zh_CN; '
  + '23127PN0CC; Build/UKQ1.230804.001; Cronet/TTNetVersion:8d40f833 2026-03-03 '
  + 'QuicVersion:21ac1950 2025-11-18)';
const PLAYBACK_V5_QUERY = {
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  _rticket: '',
  cdid: '',
  channel: 'xiaomi_8662_64',
  aid: '8662',
  app_name: 'novelread',
  version_code: '74332',
  version_name: '7.4.3.32',
  manifest_version_code: '74332',
  update_version_code: '74332',
  resolution: '1200*2670',
  dpi: '460',
  device_type: '23127PN0CC',
  device_brand: 'Xiaomi',
  language: 'zh',
  os_api: '34',
  os_version: '14',
  ac: 'wifi',
  host_abi: 'arm64-v8a',
  dragon_device_type: 'phone',
  pv_player: '74332',
  compliance_status: '0',
  need_personal_recommend: '1',
  player_so_load: '1',
  is_android_pad_screen: '0',
  iid: '',
  device_id: '',
};

/**
 * v5 播放接口的 query 参数。
 *
 * 2026-11-24 currentApp 档：7.4.5.32 / update_64 / 25053RT47C / Android 16。
 * 键的插入序即编码序，保持与上游一致便于排查。
 */
const PLAYBACK_QUERY = Object.assign({}, VIDEO_TAB_QUERY);

/** 请求域名白名单（他的 checkedUrl 域名表，防签名 body 被带往第三方）。 */
const API_DOMAINS = ['fqnovel.com', 'snssdk.com'];

/** 媒体 CDN 域名白名单。 */
const VOD_DOMAINS = ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com'];

/** decryptSpadeUrl 的常量段（app-source.js constants，64 字节）。 */
const URL_CONSTANTS = Crypto.unhex(
  '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58');

// ==================== 入口 ====================

/**
 * 2026-11-24 上游 currentApp 协议更新（legend0/hongguo-desktop de40ffa7 / hongguoTV main）：
 *  - 7.4.3.32 / PGT-AN10 / player/v1 + device_level=1 已被风控空响应淘汰；
 *  - 改为 7.4.5.32 / 25053RT47C / preload/v1 + device_level=2 + dr_scene=preload；
 *  - x-medusa wire 字段 21 由 377 改为 312（377 会返回 200/0B）。
 * 旧的 GET video_tab 保留为同身份兜底，但 UA/query 同步升到 currentApp 档。
 */

/**
 * 取某集的 App 直链。quality 为空 / best / auto 时按「H.264 优先、清晰度优先」
 * 自动选流；指定数值（如 1080p）时按短边尺寸升序偏好。
 *
 * @param {string} vid 分集 id
 * @param {string} [quality] 清晰度偏好
 * @param {object} [trace] 可选的分段诊断容器（--probe 用），每步把中间态写进去
 * @returns {Promise<{url,spadeA,encrypt,definition,size}>} 可播放轨道；
 *   任何一步失败都抛异常，由调用方决定是否回落老路
 */
async function fetchRaw(vid, quality, trace) {
  if (vid === null || vid === undefined || !/^\d{1,30}$/.test(String(vid))) {
    throw new Error('分集编号无效');
  }

  // ---- 1. 注册设备 + 签名 POST multi_video_model/player/v1 ----
  // 播放接口对「未注册的随机设备」返回 200 空体：必须先匿名注册设备身份，
  // 再用 v5（Medusa/Helios/Khronos）签名请求。body 用 gzip 压缩。
  const { rows, seed } = await loadModel(vid, trace);
  const ok = selectRows(rows, quality);
  if (trace !== null && trace !== undefined) {
    trace.renditions = rows.map((r) => ({
      quality: r.quality, codec: r.codec, shortSide: r.shortSide, size: r.size,
      rank: r.codecRank,
      // 真实分辨率/码率/帧率：标签（quality_desc）与真实参数经常不一致，
      // 判断「是不是真 1080p、画质够不够」只能看这几个原始字段。
      // 新 GET video_tab 把它们放在 video_meta 里，由 toRow 统一扁平化到 Row 上。
      width: r.width || Json.optInt(r.item.vwidth, 0),
      height: r.height || Json.optInt(r.item.vheight, 0),
      bitrate: r.bitrate || Json.optLong(r.item.bitrate, 0),
      fps: r.fps || Number(r.item.fps) || 0,
    }));
    trace.wantPx = wantPixels(quality);
    trace.picked = ok.length > 0
      ? { quality: ok[0].quality, shortSide: ok[0].shortSide, codec: ok[0].codec } : null;
  }
  if (ok.length === 0) {
    throw new Error('本集暂未提供兼容的 H.264/HEVC 片源');
  }

  // ---- 4. 收集该档位的所有候选直链（同一档通常给 main + backup_url_1 两个节点）----
  // 注意返回的 spadeA 契约是「原始 base64 spade_a」——解包由
  // Stream.offlineDecrypt 统一完成（老路同此约定）。这里只预解一次
  // 用于判断该候选是否可用，不回存解出的 key。
  let last = null;
  const cands = [];
  for (const r of ok) {
    const spade = firstNonEmpty(r.item.spade_a,
      Json.optStr(child(r.item, 'encrypt_info').spade_a, ''));
    let keyOk = spade === '';
    if (spade !== '') {
      keyOk = Spade.isValidKey(Spade.unwrapV1(Crypto.base64Decode(spade), 0));
    }
    if (!keyOk) continue; // spade_a 解不出合法 key 的候选不可用
    for (const raw of urlCandidates(r.item)) {
      try {
        const media = seed !== null
          ? decryptSpadeUrl(raw, seed) : cleanUrl(raw);
        const url = checkedUrl(media, VOD_DOMAINS);
        cands.push({
          url,
          spadeA: spade,
          encrypt: spade !== '',
          definition: r.quality === '' ? '?' : r.quality,
          size: r.size,
        });
      } catch (ex) {
        last = ex;
      }
    }
    // 档位优先级已由 selectRows 决定：第一个能给出候选的档位即采用，不再往下试
    if (cands.length > 0) break;
  }
  if (cands.length === 0) {
    throw new Error('本集片源地址或密钥无法解析: '
      + (last === null ? '无候选' : last.message));
  }
  if (cands.length === 1) return cands[0];
  // 多个节点：并发测一小段，用最快的（跨境链路上不同 CDN 节点能差好几倍）
  return pickFastest(cands, trace);
}

/** 候选测速用的字节数（只取一小段，够判断量级即可）。 */
const PROBE_BYTES = 64 * 1024;

/** 测一个直链的瞬时速度（KB/s）；失败返回 0。 */
async function measureSpeed(url, timeoutMs) {
  const t0 = Date.now();
  try {
    const res = await Http.send({
      url, method: 'GET', timeoutMs,
      headers: { 'user-agent': 'Mozilla/5.0', range: 'bytes=0-' + (PROBE_BYTES - 1) },
    });
    if (res.status !== 200 && res.status !== 206) return 0;
    const ms = Math.max(1, Date.now() - t0);
    return res.body.length / 1024 / (ms / 1000);
  } catch (e) {
    return 0;
  }
}

/**
 * 多个候选直链里挑最快的。
 *
 * 为什么需要：上游给同一档位两个 CDN 节点（main_url + backup_url_1），哪个快
 * 完全取决于机器所在网络——境外机器常常是备用节点更快。并发各测 64KB，
 * 取实测最快的；全部测不通时退回第一个（main），行为与旧版一致。
 *
 * @param {Array} cands 候选（含 url）
 * @param {object} [trace] 诊断容器
 * @returns {Promise<object>} 选中的候选
 */
/** 从 URL 取主机名（失败返回空串）。 */
function hostOfUrl(url) {
  try { return new URL(String(url)).host; } catch (e) { return ''; }
}

async function pickFastest(cands, trace) {
  // 同一节点上的多条链没有可比性，直接按顺序取第一条，省掉两次探测
  const hosts = new Set(cands.map((c) => hostOfUrl(c.url)));
  if (hosts.size <= 1) return cands[0];
  const speeds = await Promise.all(cands.map((c) => measureSpeed(c.url, 3000)));
  let best = 0;
  for (let i = 1; i < speeds.length; i++) {
    if (speeds[i] > speeds[best]) best = i;
  }
  if (trace !== null && trace !== undefined) {
    trace.hostSpeeds = cands.map((c, i) => ({ host: hostOfUrl(c.url), kbps: Math.round(speeds[i]) }));
    trace.pickedHost = trace.hostSpeeds[best].host;
  }
  return cands[best];
}

// ==================== 请求构造 ====================

/**
 * 取「本集的片源模型」：优先 GET video_tab，空包时回落签名 POST，
 * 必要时二次取 fallback_api，返回全部候选档位。
 *
 * 从 fetchRaw 里拆出来，好处是 `--probe` 与排障脚本可以直接拿到模型（含每档的
 * main_url / backup_url / backup_url_list），不必再走一遍选流与解密。
 *
 * @param {string} vid 分集 id
 * @param {object} [trace] 可选的分段诊断容器
 * @returns {Promise<{rows: Row[], seed: Buffer|null}>}
 */
/**
 * 上游当前主链路：player/v1 + 真机 medusa。
 *
 * 与旧 preload/v1 的区别不只是路径：query 顺序、版本档、设备画像、
 * body 的 device_level / dr_scene、medusa 环境块全部按 openhongguo v0.4.1。
 * 这里先单独跑一次；成功就直接返回，失败仍保留旧链路兜底。
 */
async function fetchPlaybackV5(vid, trace, host) {
  const api = 'https://' + (host || PLAYBACK_V5_HOST) + PLAYBACK_V5_PATH;
  const body = zlib.gzipSync(Buffer.from(Json.stringify(payloadCurrent(vid)), 'utf8'));
  if (trace !== null && trace !== undefined) {
    trace.currentBodyBytes = body.length;
    trace.currentPayload = Json.stringify(payloadCurrent(vid));
    trace.currentAttempts = [];
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const identity = attempt === 0
      ? await PlaybackDevice.getPlaybackDevice()
      : await PlaybackDevice.getPlaybackDevice(true);
    const values = Object.assign({}, PLAYBACK_V5_QUERY, {
      iid: identity.iid, cdid: identity.cdid, device_id: identity.device_id,
    });
    const signed = PureSign.signPlaybackV5Current(api, values, body, Date.now());
    const headers = Object.assign({
      'User-Agent': PLAYBACK_V5_UA,
      Accept: 'application/json; charset=utf-8,application/x-protobuf',
      'Content-Encoding': 'gzip',
      'x-ss-dp': '8662',
      lc: '101',
      'x-reading-request': String(signed.ticket) + '-'
        + String(crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff),
    }, signed.headers);
    if (identity.cookie) headers.Cookie = identity.cookie;
    const info = {
      index: attempt + 1,
      ticket: String(signed.ticket),
      headerKeys: Object.keys(signed.headers).sort(),
      host: PLAYBACK_V5_HOST,
    };
    if (trace !== null && trace !== undefined) trace.currentAttempts.push(info);
    const res = await Http.send({
      url: signed.url, method: 'POST', timeoutMs: 15000, headers, body,
    });
    info.status = res.status;
    info.bytes = res.body.length;
    if (res.status !== 200) {
      lastErr = new Error('player/v1 HTTP ' + res.status);
      continue;
    }
    const txt = res.text();
    const j = Json.parseObject(txt);
    info.code = j === null ? null : (j.code === undefined ? j.Code : j.code);
    const data = j === null ? null : Json.optObj(j.data);
    info.hasData = data !== null;
    info.snippet = txt.slice(0, 240);
    if (data !== null) {
      return playbackModelFrom(j, vid, trace);
    }
    lastErr = new Error('player/v1 未返回 data');
    if (attempt === 0) continue;
  }
  throw lastErr || new Error('player/v1 无响应');
}

/** player/v1 的 data -> video_model，兼容 data["1004"] 分组与顶层 video_model。 */
function playbackModelFrom(j, vid, trace) {
  const data = Json.optObj(j.data);
  if (data === null) throw new Error('player/v1 未返回 data');
  const buckets = [Json.optObj(data['1004']), data];
  let entry = null;
  for (const bucket of buckets) {
    if (bucket === null) continue;
    if (!isEmpty(bucket.video_model)) { entry = bucket; break; }
    const hit = Json.optObj(bucket[vid]);
    if (hit !== null && !isEmpty(hit)) { entry = hit; break; }
  }
  if (entry === null) throw new Error('player/v1 未返回所选分集');
  const model = asObject(entry.video_model);
  if (isEmpty(model)) throw new Error('player/v1 未返回 video_model');
  if (trace !== null && trace !== undefined) {
    trace.dataKeys = Object.keys(data);
    trace.route = 'player-v5';
    trace.host = PLAYBACK_V5_HOST;
  }
  return model;
}

/** player/v1 请求体：上游 device_level=1、dr_scene=player。 */
function payloadCurrent(vid) {
  const biz = Json.obj();
  biz.detail_page_version = 0;
  biz.device_level = 1;
  biz.disable_digg_stat = false;
  biz.disable_video_relate_book = false;
  biz.need_all_video_definition = true;
  biz.need_mp4_align = false;
  biz.use_os_player = false;
  biz.use_server_dns = false;
  biz.video_platform = 1024;
  const mixed = Json.obj();
  mixed['1004'] = [vid];
  const out = Json.obj();
  out.biz_param = biz;
  out.mixed_video_id_map = mixed;
  out.dr_scene = 'player';
  return out;
}

async function loadModel(vid, trace) {
  const hasPlayable = (parsed) => parsed !== null
    && parsed.rows.length > 0 && !allBytevc2(parsed.rows);
  let lastErr = null;
  let fallbackParsed = null;

  // 2026-11-24：N3urda/hongguoTV main 当前仍以 currentApp 7.4.5.32 preload/v1
  // 为主链路；openhongguo v0.4.1 的 player/v1 分支保留为显式探测用，默认不跑，
  // 避免每次播放先白等两次空响应。
  if (Log.env('HG_PLAYBACK_V5_PROBE', null) !== null) {
    try {
      const model = await fetchPlaybackV5(vid, trace);
      const parsed = await rowsFromModel(model, trace);
      if (parsed !== null && parsed.rows.length > 0) fallbackParsed = parsed;
      if (hasPlayable(parsed)) return parsed;
      lastErr = new Error('player/v1 未提供可播档位');
    } catch (e) {
      lastErr = e;
      if (trace !== null && trace !== undefined) {
        trace.currentError = String((e && e.message) || e);
      }
    }
  }

  // 主链路：currentApp 7.4.5.32 preload/v1，按官方域名表顺序尝试。
  for (const host of VIDEO_API_HOSTS) {
    try {
      const model = await loadModelPost(vid, trace, host);
      const parsed = await rowsFromModel(model, trace);
      if (parsed !== null && parsed.rows.length > 0) fallbackParsed = parsed;
      if (hasPlayable(parsed)) return parsed;
      lastErr = new Error('主接口未提供可播档位');
    } catch (e) {
      lastErr = e;
      if (trace !== null && trace !== undefined) {
        if (!Array.isArray(trace.hostErrors)) trace.hostErrors = {};
        trace.hostErrors[host] = String((e && e.message) || e);
      }
    }
  }

  // 同身份兜底：preload 全链路空响应时，用当前注册身份重查 video_tab 本集。
  try {
    const tabModel = await fetchVideoTabModel(vid, trace);
    const parsed = await rowsFromModel(tabModel, trace);
    if (parsed !== null && parsed.rows.length > 0) fallbackParsed = parsed;
    if (hasPlayable(parsed)) return parsed;
    lastErr = new Error('video_tab 兜底未提供可播档位');
  } catch (e) {
    lastErr = e;
    if (trace !== null && trace !== undefined) {
      trace.tabError = String((e && e.message) || e);
    }
  }
  if (fallbackParsed !== null) return fallbackParsed;
  throw lastErr || new Error('App 接口未提供可播档位');
}

/**
 * GET video_tab 单集取址（preload 全链路空响应时的同身份兜底）。
 * 签名与 POST 共用 v5，但 body 为 null（纯 GET），query 需带 video_id 等单集参数。
 * 返回的 video_model 是 JSON 字符串，video_list 是数组（与 POST 的对象形态不同）。
 */
async function fetchVideoTabModel(vid, trace) {
  const tReg = Date.now();
  const identity = await PlaybackDevice.getPlaybackDevice();
  if (trace !== null && trace !== undefined) {
    trace.registerMs = Date.now() - tReg;
    trace.identity = { device_id: identity.device_id, iid: identity.iid, cdid: identity.cdid };
    trace.attempts = [];
  }
  // 顺序即签名输入：base → 身份 → 分集 → 播放参数 → _rticket（签名器追加）
  const values = Object.assign({}, VIDEO_TAB_QUERY, {
    iid: identity.iid, cdid: identity.cdid, device_id: identity.device_id,
  }, { video_id: vid }, VIDEO_TAB_EXTRA);
  const tSign = Date.now();
  // GET video_tab：上游要求用「空字节体」签名（md5(空)），不是 null 的全零摘要。
  // 传空 Buffer 让 bodyMd5Of 走 md5(空)；x-ss-stub 因 body 长度为 0 不会被设置。
  const signed = PureSign.signPlaybackV5(VIDEO_TAB_API, values, Buffer.alloc(0), Date.now());
  const attemptInfo = {
    index: 1, route: 'video-tab', signMs: Date.now() - tSign,
    ticket: /_rticket=(\d+)/.exec(signed.url) !== null
      ? /_rticket=(\d+)/.exec(signed.url)[1] : '',
    headerKeys: Object.keys(signed.headers).sort(),
  };
  if (trace !== null && trace !== undefined) trace.attempts.push(attemptInfo);
  const tReq = Date.now();
  const res = await Http.send({
    url: signed.url, method: 'GET', timeoutMs: 15000,
    headers: Object.assign({
      'User-Agent': VIDEO_TAB_UA,
      Accept: 'application/json; charset=utf-8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, signed.headers),
  });
  attemptInfo.httpMs = Date.now() - tReq;
  attemptInfo.status = res.status;
  attemptInfo.bytes = res.body.length;
  if (res.status !== 200) throw new Error('video_tab HTTP ' + res.status);
  const txt = res.text();
  const j = Json.parseObject(txt);
  attemptInfo.code = j === null ? null : (j.code === undefined ? j.Code : j.code);
  attemptInfo.hasData = j !== null && Json.optObj(j.data) !== null;
  attemptInfo.snippet = txt.slice(0, 240);
  if (Json.optInt(j.Code, 0) !== 0 || Json.optInt(j.code, 0) !== 0) {
    throw new Error('video_tab 业务码 ' + String(j.code === undefined ? j.Code : j.code));
  }
  const data = Json.optObj(j.data);
  if (data === null) throw new Error('video_tab 未返回 data');
  if (trace !== null && trace !== undefined) {
    trace.dataKeys = Object.keys(data);
    trace.route = 'video-tab';
    trace.tab = { host: new URL(VIDEO_TAB_API).host, status: res.status, bytes: res.body.length };
  }
  const buckets = [Json.optObj(data.video_model_data), data];
  let entry = null;
  for (const bucket of buckets) {
    if (bucket === null) continue;
    const hit = Json.optObj(bucket[vid]);
    if (hit !== null && !isEmpty(hit)) { entry = hit; break; }
    // 单集请求偶尔只返回一个键（不是 vid）：只有唯一一条时才接受
    const keys = Object.keys(bucket);
    if (entry === null && keys.length === 1) {
      const only = Json.optObj(bucket[keys[0]]);
      if (only !== null && !isEmpty(only)) entry = only;
    }
  }
  if (entry === null) throw new Error('video_tab 未返回所选分集');
  const model = asObject(entry.video_model);
  if (isEmpty(model)) throw new Error('video_tab 未返回 video_model');
  return model;
}

/** 旧的签名 POST 链路（上游空包时不可用，作为兜底保留）。 */
async function loadModelPost(vid, trace, host) {
  const body = zlib.gzipSync(Buffer.from(Json.stringify(payload(vid)), 'utf8'));
  if (trace !== null && trace !== undefined) {
    trace.bodyBytes = body.length;
    trace.payload = Json.stringify(payload(vid));
  }
  const j = await postPlayback(body, trace, host);
  const data = Json.optObj(j.data);
  if (trace !== null && trace !== undefined) {
    trace.dataKeys = data === null ? [] : Object.keys(data);
  }
  if (Json.optInt(j.Code, 0) !== 0 || Json.optInt(j.code, 0) !== 0) {
    throw new Error('App 接口暂未提供本集播放信息');
  }
  if (data === null) {
    throw new Error('App 接口未返回 data');
  }
  // 直接模型优先：v5 把分集模型放在 data["1004"] 下，v3 是 video_model_data 或 data 本身
  const buckets = [Json.optObj(data['1004']), Json.optObj(data.video_model_data), data];
  let entry = null;
  for (const bucket of buckets) {
    if (bucket === null) continue;
    const hit = Json.optObj(bucket[vid]);
    if (hit !== null && !isEmpty(hit)) { entry = hit; break; }
  }
  if (entry === null) {
    throw new Error('App 接口未返回所选分集');
  }
  const model = asObject(entry.video_model);
  if (isEmpty(model)) {
    throw new Error('App 接口未返回 video_model');
  }
  if (trace !== null && trace !== undefined) {
    trace.route = 'post';
    trace.postHost = host || VIDEO_API_HOST;
  }
  return model;
}

/** 把模型里的 video_list 统一成数组（POST 是对象，GET video_tab 是数组）。 */
function rowsOfVideoList(v) {
  if (Array.isArray(v)) return v;
  const o = Json.optObj(v);
  return o === null ? [] : Object.keys(o).map((k) => o[k]);
}

/** 模型 → 候选档位：直接 video_list 优先，为空才走 fallback_api。 */
/**
 * 全档 bytevc2 兼容：上游部分分集（同剧编码不统一）只给字节自研的 bytevc2，
 * 浏览器/普通播放器无法解码。官方播放器会额外请求一次 fallback_api 并带上
 * codec_type=1（拿到 h265/bytevc1）。实测 codec_type=1 返回全 h265、可直接播放；
 * codec_type=0&force_codec=h264 只返回混档（部分仍 bytevc2），故以 1 为主、后者兜底。
 * 仅当「直出 video_list 全是非兼容编码」时启用，正常 bytevc1/h264 集不受影响。
 *
 * @returns {Promise<object|null>} 兼容后的 info（含 video_list / key_seed），失败返回 null
 */
async function compatibleBytevc2(model, trace) {
  const fallback = parseFallback(model.fallback_api);
  if (fallback === null || fallback === '') return null;
  const attempts = [
    { codec_type: '1' },
    { codec_type: '0', force_codec: 'h264' },
  ];
  for (const a of attempts) {
    try {
      const u = new URL(fallback);
      u.searchParams.set('codec_type', a.codec_type);
      if (a.force_codec) u.searchParams.set('force_codec', a.force_codec);
      const outer = await getPlain(checkedUrl(u.toString(), API_DOMAINS));
      const outerInfo = Json.optObj(outer.video_info);
      if (Json.optInt(outer.Code, 0) !== 0 || Json.optInt(outer.code, 0) !== 0
          || Json.optInt(outerInfo === null ? null : outerInfo.Code, 0) !== 0) continue;
      const info = outerInfo === null ? null : Json.optObj(outerInfo.data);
      if (info === null || isEmpty(info)) continue;
      const rows = rowsOfVideoList(info.video_list)
        .map((raw) => toRow(Json.optObj(raw)))
        .filter((r) => r !== null && r.codecRank < 2);
      if (rows.length === 0) continue;
      if (trace !== null && trace !== undefined) {
        trace.bytevc2Compat = { codec_type: a.codec_type, force_codec: a.force_codec || '', playable: rows.length };
      }
      return info;
    } catch (e) {
      if (trace !== null && trace !== undefined) {
        trace.bytevc2CompatError = String((e && e.message) || e);
      }
    }
  }
  return null;
}

/** 直出的所有档位是否都是浏览器无法解码的 bytevc2/bvc2。 */
function allBytevc2(rows) {
  if (rows.length === 0) return false;
  return rows.every((r) => r.codec === 'bytevc2' || r.codec === 'bvc2' || r.codecRank >= 2);
}

async function rowsFromModel(model, trace) {
  let info = model;
  const direct = rowsOfVideoList(model.video_list);
  const directRows = direct.map((raw) => toRow(Json.optObj(raw))).filter((r) => r !== null);
  const usedFallback = directRows.length === 0;
  if (trace !== null && trace !== undefined) trace.usedFallback = usedFallback;
  if (usedFallback) {
    const fallback = parseFallback(model.fallback_api);
    if (fallback === null || fallback === '') {
      throw new Error('App 接口未返回本集片源地址');
    }
    const outer = await getPlain(checkedUrl(fallback, API_DOMAINS));
    const outerInfo = Json.optObj(outer.video_info);
    if (Json.optInt(outer.Code, 0) !== 0
        || Json.optInt(outer.code, 0) !== 0
        || Json.optInt(outerInfo === null ? null : outerInfo.Code, 0) !== 0) {
      throw new Error('App 接口暂未提供本集播放信息');
    }
    info = outerInfo === null ? null : Json.optObj(outerInfo.data);
    if (info === null || isEmpty(info)) {
      throw new Error('App 接口未返回本集片源模型');
    }
  } else if (allBytevc2(directRows)) {
    // 全档 bytevc2（浏览器播不了）：按官方做法拉一次兼容档（codec_type=1 → h265）。
    const compat = await compatibleBytevc2(model, trace);
    if (compat !== null) info = compat;
  }
  // key_seed 存在说明媒体 URL 是密文，需 AES 解密
  let seed = null;
  const seedStr = Json.optStr(info.key_seed, '');
  if (seedStr !== '') {
    seed = Crypto.base64Decode(seedStr);
  }
  const rows = [];
  for (const raw of rowsOfVideoList(info.video_list)) {
    const r = toRow(Json.optObj(raw));
    if (r !== null) rows.push(r);
  }
  if (trace !== null && trace !== undefined) trace.seedEncrypted = seed !== null;
  return { rows, seed };
}

/**
 * 列出某集所有可用候选直链（已解密），供排障/测速用。
 *
 * @param {string} vid 分集 id
 * @returns {Promise<Array<{quality,codec,shortSide,size,kind,host,url}>>}
 */
async function listCandidates(vid) {
  const { rows, seed } = await loadModel(vid, null);
  const out = [];
  for (const r of rows) {
    const spade = firstNonEmpty(r.item.spade_a,
      Json.optStr(child(r.item, 'encrypt_info').spade_a, ''));
    let keyOk = true;
    if (spade !== '') {
      try {
        keyOk = Spade.isValidKey(Spade.unwrapV1(Crypto.base64Decode(spade), 0));
      } catch (e) {
        keyOk = false;
      }
    }
    const kinds = [];
    if (typeof r.item.main_url === 'string' && r.item.main_url !== '') kinds.push('main');
    if (typeof r.item.backup_url === 'string' && r.item.backup_url !== '') kinds.push('backup');
    if (Array.isArray(r.item.backup_url_list)) {
      for (let i = 0; i < r.item.backup_url_list.length; i++) kinds.push('list' + i);
    }
    const raw = urlCandidates(r.item);
    for (let i = 0; i < raw.length; i++) {
      let url = '';
      try {
        const media = seed !== null ? decryptSpadeUrl(raw[i], seed) : cleanUrl(raw[i]);
        url = checkedUrl(media, VOD_DOMAINS);
      } catch (e) {
        continue;
      }
      let host = '';
      try { host = new URL(url).host; } catch (e) { host = '?'; }
      out.push({
        quality: r.quality, codec: r.codec, shortSide: r.shortSide, size: r.size,
        kind: kinds[i] || ('c' + i), host, url, keyOk,
      });
    }
  }
  return out;
}

/** 请求体（currentApp 7.4.5.32 preload 形态）。 */
function payload(vid) {
  const biz = Json.obj();
  biz.detail_page_version = 0;
  // 2026-11-24 currentApp：device_level 2 + dr_scene=preload
  biz.device_level = 2;
  biz.disable_digg_stat = false;
  biz.disable_video_relate_book = false;
  biz.need_all_video_definition = true;
  biz.need_mp4_align = false;
  biz.use_os_player = false;
  biz.use_server_dns = false;
  biz.video_platform = 1024;
  const mixed = Json.obj();
  mixed['1004'] = [vid];
  const out = Json.obj();
  out.biz_param = biz;
  out.mixed_video_id_map = mixed;
  out.dr_scene = 'preload';
  return out;
}


/**
 * 播放取址请求：注册设备身份 + v5 签名（x-khronos / x-helios / x-medusa）+ gzip body。
 *
 * 与旧实现的区别（关键）：
 *  - 接口换成 multi_video_model/preload/v1（currentApp 7.4.5.32）；
 *  - 签名改用 v5（Android v04.10.03），只发三个签名头，v3 的 gorgon/argus/ladon 不再发送；
 *  - _rticket 由签名器抖动到「iv & 15 == 12」的分支后再签名；
 *  - 上游若仍返回空 data（身份被拒），换新设备身份重试一次。
 */
async function postPlayback(body, trace, host) {
  const api = 'https://' + (host || VIDEO_API_HOST) + VIDEO_API_PATH;
  const tReg = Date.now();
  let identity = await PlaybackDevice.getPlaybackDevice();
  if (trace !== null && trace !== undefined) {
    trace.registerMs = Date.now() - tReg;
    trace.identity = { device_id: identity.device_id, iid: identity.iid, cdid: identity.cdid };
    // 可能前面已经跑过 video_tab，保留它的诊断记录
    if (!Array.isArray(trace.attempts)) trace.attempts = [];
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const values = Object.assign({}, PLAYBACK_QUERY, {
      iid: identity.iid, cdid: identity.cdid, device_id: identity.device_id,
    });
    const tSign = Date.now();
    const signed = PureSign.signPlaybackV5(api, values, body, Date.now());
    const headers = Object.assign({
      'User-Agent': VIDEO_UA,
      Accept: 'application/json',
      'Content-Encoding': 'gzip',
    }, signed.headers);
    const attemptInfo = {
      index: attempt + 1,
      signMs: Date.now() - tSign,
      ticket: /_rticket=(\d+)/.exec(signed.url) !== null
        ? /_rticket=(\d+)/.exec(signed.url)[1] : '',
      headerKeys: Object.keys(headers).sort(),
    };
    if (trace !== null && trace !== undefined) trace.attempts.push(attemptInfo);
    const tReq = Date.now();
    const res = await Http.send({ url: signed.url, method: 'POST', timeoutMs: 15000, headers, body });
    attemptInfo.httpMs = Date.now() - tReq;
    attemptInfo.status = res.status;
    attemptInfo.bytes = res.body.length;
    if (res.status !== 200) {
      throw new Error('App 接口 HTTP ' + res.status);
    }
    const txt = res.text();
    const j = Json.parseObject(txt);
    attemptInfo.code = j === null ? null : (j.code === undefined ? j.Code : j.code);
    attemptInfo.hasData = j !== null && Json.optObj(j.data) !== null;
    attemptInfo.snippet = txt.slice(0, 240);
    if (attemptInfo.hasData) {
      return j;
    }
    // 空 data：多半是设备身份被上游拒绝，换新身份再试一次
    if (attempt === 0) {
      identity = await PlaybackDevice.getPlaybackDevice(true);
      if (trace !== null && trace !== undefined) {
        trace.identity = { device_id: identity.device_id, iid: identity.iid, cdid: identity.cdid };
      }
      continue;
    }
    throw new Error('App 接口未返回 data'
      + (Log.env('HG_APPSOURCE_DEBUG', null) !== null
        ? '（原始响应: ' + txt + '）' : ''));
  }
  throw new Error('App 接口未返回 data');
}

/** fallback_api 的普通 GET：不带签名，只带 UA（与原实现一致）。 */
async function getPlain(url) {
  const res = await Http.send({
    url, method: 'GET', timeoutMs: 15000, headers: { 'User-Agent': VIDEO_UA },
  });
  if (res.status !== 200) {
    throw new Error('fallback HTTP ' + res.status);
  }
  return Json.parseObject(res.text());
}

// ==================== 响应解析 ====================

/** video_model 可能是 JSON 字符串或对象。 */
function asObject(v) {
  if (typeof v === 'string') {
    try {
      return Json.parseObject(v);
    } catch (e) {
      return Json.obj();
    }
  }
  const m = Json.optObj(v);
  return m === null ? Json.obj() : m;
}

/** 取子对象；缺失返回空 map（Json.optObj 对 null 返回 null，链式调用会踩 NPE）。 */
function child(m, key) {
  if (m === null || m === undefined) return Json.obj();
  const c = Json.optObj(m[key]);
  return c === null ? Json.obj() : c;
}

function isEmpty(m) {
  return m === null || m === undefined || Object.keys(m).length === 0;
}

/**
 * fallback_api 可能是 URL 字符串、[url]、{"fallback_api": url}
 * 或内嵌 JSON 的字符串。
 */
function parseFallback(v) {
  if (typeof v === 'string') {
    let parsed;
    try {
      parsed = Json.parseObject(v);
    } catch (e) {
      return v;
    }
    const fb = parsed.fallback_api;
    return fb === null || fb === undefined ? v : String(fb);
  }
  if (Array.isArray(v)) {
    return v.length === 0 ? '' : String(v[0]);
  }
  const o = Json.optObj(v);
  const fb = o === null ? undefined : o.fallback_api;
  return fb === null || fb === undefined ? '' : String(fb);
}

/** 一条候选流的评分信息。 */
class Row {
  constructor(item, codec, codecRank, quality, pixels, shortSide, size) {
    this.item = item;
    this.codec = codec;
    this.codecRank = codecRank;
    this.quality = quality;
    this.pixels = pixels;
    this.shortSide = shortSide;
    this.size = size;
  }
}

function toRow(item) {
  if (item === null || isEmpty(item)) return null;
  const meta = child(item, 'video_meta');
  const codec = Json.optStr(item.codec_type,
    Json.optStr(meta.codec_type, '')).toLowerCase();
  const rankV = rank(codec);
  const quality = firstNonEmpty(
    Json.optStr(item.quality_desc, ''),
    Json.optStr(item.definition, ''),
    Json.optStr(item.height, ''),
    Json.optStr(item.vheight, ''),
    Json.optStr(meta.definition, ''));
  const px = pixelsOf(quality);
  let w = 0;
  let h = 0;
  const pairs = [
    [Json.optInt(item.vwidth, 0), Json.optInt(item.vheight, 0)],
    [Json.optInt(item.width, 0), Json.optInt(item.height, 0)],
    [Json.optInt(meta.vwidth, 0), Json.optInt(meta.vheight, 0)],
    [Json.optInt(meta.width, 0), Json.optInt(meta.height, 0)],
  ];
  for (const p of pairs) {
    if (p[0] > 0 && p[1] > 0) { w = p[0]; h = p[1]; break; }
  }
  let size = Json.optLong(meta.size, 0);
  if (size === 0) size = Json.optLong(item.size, 0);
  const row = new Row(item, codec, rankV, quality, px, Math.min(w, h), size);
  // GET video_tab 的媒体参数嵌在 video_meta 里；画质诊断统一从 Row 读，不再假设顶层字段。
  row.width = w;
  row.height = h;
  row.bitrate = Json.optLong(meta.bitrate, Json.optLong(item.bitrate, 0));
  row.fps = Number(meta.fps) || Number(item.fps) || 0;
  return row;
}

/** quality 是否表示「自动选流」。 */
function isAutoQuality(quality) {
  return quality === null || quality === undefined || quality === ''
    || quality === 'best' || quality === 'auto';
}

/** 指定清晰度对应的短边像素；自动选流返回 0。 */
function wantPixels(quality) {
  return isAutoQuality(quality) ? 0 : pixelsOf(quality);
}

/**
 * 挑出候选档位的尝试顺序。
 *
 * 规则：先剔除浏览器解不了的编码（AV1 等），再按「自动 / 指定」排序。
 *  - 自动（best/auto/空）：H.264 优先，其次像素多的；
 *  - 指定清晰度：优先「够高且最接近」，够高的一个都没有时退到当前最高档。
 *
 * 为什么不能硬过滤：上游的 quality_desc 与实际分辨率并不一致——实测有整部剧
 * 所有档的短边最高只有 720，却把其中一档标成 1080p。旧实现按「短边 >= 请求值」
 * 过滤，会把所有档筛空、整集直接报错，前端只能退回 360P 外链（又慢又常 404）。
 * 现在改成降级到最近档位，请求 1080p 拿到 720p 也比播不了强。
 *
 * @param {Row[]} rows 全部候选档
 * @param {string} quality 请求的清晰度
 * @returns {Row[]} 按尝试优先级排序；无兼容档时返回空数组
 */
function selectRows(rows, quality) {
  const compatible = rows.filter((r) => r.codecRank < 2);
  if (compatible.length === 0) return [];
  if (isAutoQuality(quality)) {
    return compatible.slice().sort((a, b) => a.codecRank !== b.codecRank
      ? a.codecRank - b.codecRank : b.pixels - a.pixels);
  }
  const want = wantPixels(quality);
  const atLeast = compatible.filter((r) => r.shortSide >= want);
  if (atLeast.length > 0) {
    // 短边相同（上游常把 720x1280 标成 1080p）时，标签更高的一般码率更高
    return atLeast.sort((a, b) => a.shortSide !== b.shortSide
      ? a.shortSide - b.shortSide : (b.pixels - a.pixels) || (a.codecRank - b.codecRank));
  }
  return compatible.slice().sort((a, b) => b.shortSide !== a.shortSide
    ? b.shortSide - a.shortSide : (b.pixels - a.pixels) || (a.codecRank - b.codecRank));
}

function rank(codec) {
  if (codec === 'h264' || codec === 'avc' || codec === 'avc1') return 0;
  if (codec === 'hevc' || codec === 'h265' || codec === 'hvc1'
      || codec === 'hev1' || codec === 'bytevc1') return 1;
  return 2;
}

/** 取字符串里第一组数字；无则 0。 */
function pixelsOf(s) {
  if (s === null || s === undefined) return 0;
  const m = /(\d+)/.exec(String(s));
  return m ? parseInt(m[1], 10) : 0;
}

/** main_url / backup_url / backup_url_N / backup_url_list 的候选序列。 */
function urlCandidates(item) {
  const out = [];
  addStr(out, item.main_url);
  addStr(out, item.backup_url);
  // 上游实际用的是 backup_url_1 / backup_url_2 …（旧实现只找 backup_url，
  // 等于把备用 CDN 节点整条丢了——境外机器上主节点慢时没有第二条路可走）
  for (const k of Object.keys(item)) {
    if (/^backup_url_\d+$/.test(k)) addStr(out, item[k]);
  }
  const list = item.backup_url_list;
  if (Array.isArray(list)) {
    for (const o of list) addStr(out, o);
  }
  return out;
}

function addStr(out, v) {
  if (typeof v === 'string' && v !== '') out.push(v);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/** 清掉上游常见的转义形式（他的 cleanUrl）。 */
function cleanUrl(value) {
  return String(value).replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
}

// ==================== URL 解密与校验 ====================

/**
 * 解密 spade URL：seed 双 sha512 派生 AES-128-CBC 密钥/IV。
 * 布局：[0]=0xa8, [1]=?, [2]=0x01, [3]=0x00, [4:]=密文（16 字节整块）。
 */
function decryptSpadeUrl(value, seed) {
  const raw = Crypto.base64Decode(value);
  if (raw.length < 5) throw new Error('spade URL 密文过短');
  if ((raw[0] & 0xff) !== 0xa8 || (raw[2] & 0xff) !== 0x01 || (raw[3] & 0xff) !== 0x00) {
    throw new Error('spade URL 头格式错误');
  }
  const cipherLength = Math.floor((raw.length - 4) / 16) * 16;
  if (cipherLength === 0) throw new Error('spade URL 无完整块');

  const h1 = crypto.createHash('sha512').update(seed).digest();
  const h2 = crypto.createHash('sha512')
    .update(Buffer.concat([h1, URL_CONSTANTS])).digest();

  const decipher = crypto.createDecipheriv('aes-128-cbc',
    h2.subarray(0, 16), h2.subarray(16, 32));
  decipher.setAutoPadding(false);
  const pt = Buffer.concat([
    decipher.update(raw.subarray(4, 4 + cipherLength)),
    decipher.final(),
  ]);

  let end = pt.length;
  if (end > 0) {
    const pad = pt[end - 1] & 0xff;
    if (pad >= 1 && pad <= 16 && pad <= end) end -= pad;
  }
  while (end > 0 && pt[end - 1] === 0) end--;
  return pt.subarray(0, end).toString('utf8');
}

/**
 * 媒体/接口 URL 白名单校验：必须 https、无用户信息、端口为 443，
 * 且 host 等于白名单域名或其子域。防签名 body 被重定向带往第三方。
 */
function checkedUrl(value, domains) {
  let u;
  try {
    u = new URL(String(value));
  } catch (e) {
    throw new Error('URL 格式无效');
  }
  const scheme = u.protocol.replace(/:$/, '');
  const host = u.hostname;
  const port = u.port;
  const portOk = port === '' || port === '443';
  let hostOk = false;
  if (host !== '') {
    for (const d of domains) {
      if (host === d || host.endsWith('.' + d)) { hostOk = true; break; }
    }
  }
  const hasUserInfo = u.username !== '' || u.password !== '';
  if (scheme !== 'https' || hasUserInfo || !portOk || !hostOk) {
    throw new Error('不受支持的服务地址: ' + value);
  }
  return u.toString();
}

/**
 * 上游 video_model 取址：优先级队列 + 瞬时失败快速重试。
 *
 * 2026-11-04 三轮共 114 个全新 vid 的对照实验结论（详见
 * work/probe_concurrency{,2,3}.js）：
 *  - 上游丢空 data 是**瞬时随机拒绝**（失败 50~100ms 即返回，成功 200~350ms），
 *    不是需要冷却的限流；「串行 + 2s 间隔」一轮 4/6、一轮 1/6、一轮 4/8，
 *    「无间隔」一轮 1/6、一轮 5/6、一轮 5/8，成功率与间隔无稳定因果关系。
 *    旧实现强制每两次取址间隔 2s，纯属白等，已去掉。
 *  - 失败后 200ms 快速重试最多 5 次：8/8 成功、单集平均 0.48s；
 *    旧的 2.2s/4.4s 退避是 8/8 但平均 2.20s，慢 4.6 倍。
 *    线上复测发现个别 vid 会被短时持续拒绝（5 次快试全丢空），
 *    故最后一次改成等 2s 兜底，最坏也只多 2s。
 *  - 单纯高并发（4~6 路同时发、各自只有一次机会）成功率只有 25~42%，
 *    所以仍保持队列一次一个任务，但不再塞人为间隔。
 *
 * 队列带优先级：播放（high）插在预热（low）前面，
 * 预热的重试不会把用户点开的那一集堵在后面。
 */
const MIN_GAP_MS = 0;         // 实测无必要的人为等待，保留常量便于回退
const RETRY_MAX = 4;          // 首次 + 4 次重试，共 5 次
const RETRY_GAP_MS = 200;     // 固定短间隔 + 小抖动，不要递增（递增只会变慢）
// 个别 vid 会被上游短时持续拒绝（实测 5 次快试仍全丢空），
// 最后一次改成等 2s 再试，兼顾「短冷却」场景；最坏也只多 2s。
const LAST_RETRY_GAP_MS = 2000;
let lastSignAt = 0;
let draining = false;
let seq = 0;
const queue = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只对瞬时故障重试；参数错误 / 片源格式问题重试也没用。 */
function isTransient(e) {
  const m = String((e && e.message) || e);
  return /未返回 data|HTTP \d+|暂未提供本集播放信息|接口未返回所选分集|timeout|timed out|ECONN|ETIMEDOUT|socket hang up|fetch failed|network/i.test(m);
}

// 官网低清兜底已按用户要求移除：取址失败时直接报错，不再静默回退 360p/网页低清源。

/** 单次取址 + 瞬时故障快速重试。 */
async function fetchWithRetry(vid, quality, priority) {
  let last = null;
  for (let i = 0; i <= RETRY_MAX; i++) {
    if (i > 0) {
      // 前几次快试覆盖瞬时随机丢空；最后一次长等覆盖短时持续拒绝
      const wait = (i === RETRY_MAX) ? LAST_RETRY_GAP_MS
        : RETRY_GAP_MS + Math.floor(Math.random() * 80);
      await sleep(wait);
    }
    try {
      return await fetchRaw(vid, quality);
    } catch (e) {
      last = e;
      if (!isTransient(e)) throw e;
      // 中间失败一律静默：上游对「新 vid 的第一次取址」经常返回空 data，
      // 自动重试基本都能拿到，打出来只会让人以为没拿到接口。
      // 只有整轮重试都没成功才记一条日志（预热还有兜底，故只记 INFO）。
      if (i === RETRY_MAX && priority !== 'low') {
        // 预热（low）由上层统一记一条，避免同一件事在两层各打一行；
        // 只有播放链路真的没拿到片源才记 WARN。
        Log.warn('取址失败 ' + vid + '（已自动重试 ' + RETRY_MAX + ' 次）：'
          + String((e && e.message) || e));
      }
    }
  }
  throw last;
}

/** 队列消费：一次只跑一个取址（间隔已由实验确认无必要，默认 0）。 */
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      const gap = Date.now() - lastSignAt;
      if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
      lastSignAt = Date.now();
      try {
        job.resolve(await job.fn());
      } catch (e) {
        job.reject(e);
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * 取某集直链。
 * @param {string} vid 分集 id
 * @param {string} quality 清晰度
 * @param {'high'|'low'} [priority] high=用户点播（默认），low=后台预热
 */
function fetch(vid, quality, priority) {
  return new Promise((resolve, reject) => {
    queue.push({
      fn: async () => fetchWithRetry(vid, quality, priority),
      priority: priority === 'low' ? 0 : 1,
      seq: ++seq,
      resolve,
      reject,
    });
    // 高优先级插队，同级保持先来先服务
    queue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
    drain();
  });
}

/**
 * 单集取址分段诊断（`--probe` 用）。
 *
 * 与 fetch 的区别：不排队、不重试、不吞异常——只跑一次，把每一步的中间态
 * 写进 trace 返回，用来定位「注册 / 签名 / 上游 / 解析 / 选流」哪一段断掉。
 *
 * @param {string} vid 分集 id
 * @param {string} [quality] 清晰度，默认 best
 * @returns {Promise<{ok:boolean, error:?string, ms:number, trace:object, result:?object}>}
 */
async function diagnose(vid, quality) {
  const trace = {};
  const t0 = Date.now();
  try {
    const result = await fetchRaw(vid, quality, trace);
    return { ok: true, error: null, ms: Date.now() - t0, trace, result };
  } catch (e) {
    return {
      ok: false,
      error: String((e && e.message) || e),
      ms: Date.now() - t0,
      trace,
      result: null,
    };
  }
}

module.exports = {
  fetch,
  fetchRaw,
  loadModel,
  listCandidates,
  diagnose,
  pixelsOf,
  allBytevc2,
  selectRows,
  wantPixels,
  urlCandidates,
  cleanUrl,
  decryptSpadeUrl,
  checkedUrl,
  VIDEO_API,
  VIDEO_API_HOST,
  VIDEO_API_HOST_ALT,
  VIDEO_API_HOSTS,
  VIDEO_API_PATH,
  VIDEO_TAB_API,
  VIDEO_UA,
  VIDEO_TAB_UA,
  VERSION_NAME,
  PLAYBACK_QUERY,
  API_DOMAINS,
  VOD_DOMAINS,
  URL_CONSTANTS,
};
