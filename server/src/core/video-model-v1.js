'use strict';
/**
 * video_model/v1 正式取源链路（PR beilunyang/openhongguo#25，2026-11-25）。
 *
 * 为什么需要这条链路：
 *  - 服务端自 2026-11-23 起要求播放请求**必须带 x-medusa**（真机设备布局，
 *    wire 字段 21=369），删掉该头一律回 HTTP 200 + 0 字节。这解释了之前
 *    「随机注册设备取不到、只有内置固定设备能取到」的现象——不是设备被风控，
 *    而是签名头形态不对。
 *  - 之前主链路 preload/v1（device_level=2 + dr_scene=preload）只适合预热：
 *    它会把 1080p 以下下发成 bytevc2，浏览器/ffmpeg 解不了；正式取源应走
 *    video_model/v1（旧接口）+ 完整的签名头。
 *
 * 本模块只负责「发请求 + 把响应里的 video_model 解析成 model 对象」，
 * 后续的选流/解密/缓存仍由 app-source.js 的统一流程处理。
 *
 * 签名配方（逐字对齐 PR #25 的 SignPlaybackPOST，已用独立探针实测：随机匿名
 * 设备拿到 5 档 bytevc1、删 x-medusa 立刻空体）：
 *  - query = DeviceQueryPairs(identity) + ts(秒) + _rticket(毫秒)，顺序固定；
 *  - body  = JSON 明文（非 gzip）；
 *  - 基础头来自 pure-sign.sign()（x-gorgon/khronos/helios/medusa 等）；
 *  - x-argus / x-ladon 用 playback-signature.js 的真签名覆盖 stub；
 *  - x-medusa 用真机设备布局、字段21=369（buildMedusaV5Current）；
 *  - x-helios 必须用 v5（license=646637794），v3 版会回空体。
 */
const crypto = require('crypto');
const Http = require('../util/http');
const Json = require('../util/json');
const Pure = require('./pure-sign');
const Sign = require('./playback-signature');

const BASE = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/video_model/v1/';
const V5 = require('./v5-constants');
const AID_NUM = 8662;
const LICENSE_PLAYBACK = 1611921764;   // Argus/Ladon 的 licenseId（PR #25）
const VC = '73932';                    // video_model/v1 配套 7.3.9.32 档
const VN = '7.3.9.32';
const CHANNEL = 'xiaomi_8662_64';      // 与 medusa env 的 channel 一致
const UA = 'com.phoenix.read/73932 (Linux; U; Android 16; zh_CN; '
  + '25053RT47C; Build/BP2A.250605.031.A3)';

/** DeviceQueryPairs 顺序逐字复刻 PR request.go:161，顺序是签名的一部分。 */
function devicePairs(identity) {
  const openudid = crypto.createHash('sha256')
    .update('openudid\0' + identity.device_id, 'utf8').digest('hex').slice(0, 16);
  return [
    ['iid', identity.iid], ['device_id', identity.device_id], ['ac', 'wifi'],
    ['channel', CHANNEL], ['aid', String(AID_NUM)], ['app_name', 'novelread'],
    ['cdid', identity.cdid], ['version_code', VC], ['version_name', VN],
    ['device_platform', 'android'], ['os', 'android'], ['ssmix', 'a'],
    ['device_type', '25053RT47C'], ['device_brand', 'Redmi'], ['language', 'zh'],
    ['os_api', '36'], ['os_version', '16'], ['manifest_version_code', VC],
    ['resolution', '1280x2772'], ['dpi', '520'], ['update_version_code', VC],
    ['host_abi', 'arm64-v8a'], ['dragon_device_type', 'phone'], ['pv_player', VC],
    ['compliance_status', '0'], ['need_personal_recommend', '1'],
    ['player_so_load', '1'], ['is_android_pad_screen', '0'], ['openudid', openudid],
  ];
}

function encodeQuery(pairs) {
  return pairs.map((kv) => Pure.javaUrlEncode(kv[0]) + '=' + Pure.javaUrlEncode(kv[1])).join('&');
}

/** 组装请求：试探 _rticket 命中 x-medusa f13 分支，再生成全部签名头。 */
function buildRequest(vid, identity, baseMs) {
  const body = Buffer.from(
    '{"video_id":"' + vid + '","biz_param":{"video_id_type":0,'
    + '"need_all_video_definition":true,"video_platform":3}}', 'utf8');
  const bodyHex = crypto.createHash('md5').update(body).digest('hex');
  const pairs = devicePairs(identity);

  let url = ''; let query = ''; let ts = 0; let ticket = 0; let medusa = null; let offset = -1;
  for (let i = 0; i < 1024; i++) {
    ticket = baseMs + i;
    ts = Math.floor(ticket / 1000);
    query = encodeQuery(pairs.concat([['ts', String(ts)], ['_rticket', String(ticket)]]));
    url = BASE + '?' + query;
    try {
      medusa = Pure.buildMedusaV5Current(url, body, ts, query, identity.device_id);
      offset = i;
      break;
    } catch (e) { medusa = null; }
  }
  if (medusa === null) throw new Error('video_model/v1: 1024 个 _rticket 内未命中 x-medusa f13 分支');

  const base = Pure.sign(url, body, ts);   // x-gorgon/khronos/helios(v3)/medusa 等
  const headers = Object.assign({}, base, {
    'User-Agent': UA,
    Accept: 'application/json; charset=utf-8,application/x-protobuf',
    'x-xs-from-web': '0',
    'x-ss-req-ticket': String(ticket),
    'x-tt-request-tag': 't=0;n=0',
    'sdk-version': '2',
    'passport-sdk-version': '50561',
    'x-vc-bdturing-sdk-version': '3.7.2.cn',
    'Content-Type': 'application/json; charset=UTF-8',
    'x-ss-stub': bodyHex.toUpperCase(),
    Cookie: identity.cookie || '',
    'x-khronos': String(ts),
    'x-medusa': medusa,
    'x-argus': Sign.Argus.sign(query, bodyHex, ts, AID_NUM, LICENSE_PLAYBACK,
      identity.device_id, identity.iid, crypto.randomBytes(4).readInt32LE()),
    'x-ladon': Sign.Ladon.encrypt(ts, LICENSE_PLAYBACK, AID_NUM, crypto.randomBytes(4)),
  });
  // x-helios 必须是 v5（license=646637794=V5.LICENSE）；v3 版会被回空体。
  const v5 = Pure.signPlaybackV5(BASE, Object.fromEntries(pairs), body, ts * 1000);
  headers['x-helios'] = v5.headers['x-helios'];
  return { url, query, ts, ticket, offset, headers, body };
}

/** video_model 可能是被转义的 JSON 字符串，解成对象。 */
function toObject(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  return null;
}

/**
 * 从 video_model/v1 响应里取出本集的 model 对象（含 video_list）。
 * @returns {object|null} model，失败抛错
 */
function modelFrom(j, vid) {
  if (j === null) throw new Error('video_model/v1 响应非 JSON');
  const code = Number(j.code === undefined ? j.Code : j.code);
  if (!Number.isNaN(code) && code !== 0) throw new Error('video_model/v1 业务码 ' + code);
  const data = Json.optObj(j.data);
  if (data === null) throw new Error('video_model/v1 未返回 data');
  const buckets = [data, Json.optObj(data['1004']), Json.optObj(data.video_model_data)];
  for (const bucket of buckets) {
    if (bucket === null) continue;
    const hit = toObject(bucket[vid]);
    if (hit !== null) {
      const model = toObject(hit.video_model);
      if (model !== null) return model;
      return hit;
    }
    const model = toObject(bucket.video_model);
    if (model !== null) return model;
  }
  throw new Error('video_model/v1 未返回所选分集模型');
}

/**
 * 用随机匿名设备经 video_model/v1 取本集播放模型。
 * @param {string} vid 分集 id
 * @param {object} identity 注册身份（device_id/iid/cdid/cookie）
 * @param {object|null} trace 诊断容器
 * @returns {Promise<object>} model（含 video_list）
 */
async function fetchVideoModelV1(vid, identity, trace) {
  const req = buildRequest(vid, identity, Date.now());
  if (trace !== null && trace !== undefined) {
    trace.v1 = { offset: req.offset, ts: req.ts, ticket: req.ticket, headerKeys: Object.keys(req.headers) };
  }
  const res = await Http.send({
    url: req.url, method: 'POST', timeoutMs: 20000, headers: req.headers, body: req.body,
  });
  if (trace !== null && trace !== undefined) {
    trace.v1.status = res.status;
    trace.v1.bytes = res.body.length;
  }
  if (res.status !== 200) throw new Error('video_model/v1 HTTP ' + res.status);
  if (res.body.length === 0) throw new Error('video_model/v1 空响应（x-medusa 可能被判无效）');
  const j = Json.parseObject(res.text());
  return modelFrom(j, String(vid));
}

module.exports = { fetchVideoModelV1, buildRequest, modelFrom, BASE };
