'use strict';
/**
 * 匿名播放设备注册。
 *
 * 移植自 jackotom/hongguo-drama 的 src/native/playback-device.js（GPL-3.0-only）。
 *
 * 为什么需要：红果 App 的播放取址接口（现为 multi_video_model/player/v1）对
 * 「未注册的随机设备身份」直接返回 200 + 0 字节。目录/搜索不受影响，只有播放
 * 取址被拦。修复方式是先向官方 device_register 端点匿名注册一台设备，拿到
 * device_id / install_id / cdid，再用这套身份去请求播放接口。
 *
 * 注册请求是「加密二进制」而非 JSON：gzip(JSON) -> sha512 摘要 + AES-128-CBC
 * 加密 -> 自定义帧头。响应里给 device_id / install_id（含 *_str 字符串形式）。
 *
 * 身份只存在进程内存，不落盘；重启后重新注册。失败缓存 10 秒，避免并发重试风暴。
 */
const crypto = require('crypto');
const { gzipSync } = require('zlib');
const Http = require('../util/http');
const Log = require('../util/log');

const REGISTER_URL = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/'
  + '?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';

/** 注册请求的 KDF 盐（协议常量，非账号凭据）。 */
const KDF_SALT = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');

let cached = null;          // { device_id, iid, cdid }
let inflight = null;        // Promise
let retryAfter = 0;         // 失败冷却截止时间

/** 从注册响应里取 device_id / install_id，优先 *_str，拒绝零值与非数字。 */
function responseId(response, name) {
  const preferred = response && response[name + '_str'];
  const value = (preferred === undefined || preferred === null || preferred === '')
    ? (response ? response[name] : undefined) : preferred;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  }
  return typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value)
    ? value : '';
}

/** 组装注册请求的加密二进制体。 */
function buildRegisterBody() {
  const now = Date.now();
  const cdid = crypto.randomUUID();
  const header = {
    display_name: '红果免费短剧', update_version_code: 73932, manifest_version_code: 73932,
    app_version_minor: '7.3.9.32', aid: 8662, channel: 'update_64', package: 'com.phoenix.read',
    app_version: '7.3.9.32', version_code: 73932, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
    sdk_target_version: 29, git_hash: '3a88f4e', os: 'Android', os_version: '16', os_api: 36,
    device_model: '25053RT47C', device_brand: 'Redmi', device_manufacturer: 'Redmi',
    cpu_abi: 'arm64-v8a', release_build: 'b5e187f', density_dpi: 520, display_density: 'mdpi',
    resolution: '1280x2772', language: 'zh', timezone: 8, access: 'wifi', not_request_sender: 0,
    carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'eng.root.20231116.160340',
    rom_version: 'W528JS release-keys', cdid, sig_hash: '56a962410c494bbaf0b58dba20cae56f',
    openudid: crypto.randomBytes(8).toString('hex'), clientudid: crypto.randomUUID(),
    ipv6_list: [], region: 'CN', tz_name: 'Asia/Shanghai', tz_offset: 28800, sim_region: 'cn',
    sim_serial_number: [], oaid_may_support: false, req_id: crypto.randomUUID(),
    device_platform: 'android',
    custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' },
    pre_installed_channel: '', apk_first_install_time: now, is_system_app: 0, sdk_flavor: 'china', guest_mode: 0,
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify({ magic_tag: 'ss_app_log', header, _gen_time: now })));
  const random = crypto.randomBytes(32);
  const derived = crypto.createHash('sha512').update(Buffer.concat([
    crypto.createHash('sha512').update(random).digest(), KDF_SALT,
  ])).digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
  const plaintext = Buffer.concat([crypto.createHash('sha512').update(compressed).digest(), compressed]);
  const data = Buffer.concat([
    Buffer.from('746305100000', 'hex'), random, cipher.update(plaintext), cipher.final(),
  ]);
  const headers = {
    'User-Agent': 'com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)',
    Accept: 'application/json', 'Content-Type': 'application/octet-stream;tt-data=a',
    'log-encode-type': 'gzip', 'x-ss-dp': '8662', 'x-ss-req-ticket': String(now),
    'x-vc-bdturing-sdk-version': '4.0.3.cn', lc: '101', 'sdk-version': '2',
    'passport-sdk-version': '5051452', 'x-neptune': '-8|50:51:59:30:40:47:49:39',
    'x-ss-stub': crypto.createHash('md5').update(data).digest('hex').toUpperCase(),
  };
  return { data, headers, cdid };
}

/** 真正发起一次注册。 */
async function registerOnce() {
  const { data, headers, cdid } = buildRegisterBody();
  const res = await Http.send({
    url: REGISTER_URL, method: 'POST', timeoutMs: 15000, headers, body: data,
  });
  const txt = res.text();
  if (res.status !== 200) throw new Error('设备注册 HTTP ' + res.status);
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('设备注册响应不是 JSON'); }
  const code = Number(j.code === undefined ? (j.Code === undefined ? 0 : j.Code) : j.code);
  if (code !== 0) throw new Error('设备注册被拒绝（' + code + '）');
  const device_id = responseId(j, 'device_id');
  const iid = responseId(j, 'install_id');
  if (!device_id || !iid) throw new Error('设备注册未返回有效身份');
  Log.info('匿名播放设备注册成功 device_id=' + device_id + ' install_id=' + iid);
  return Object.freeze({ device_id, iid, cdid });
}

/**
 * 取当前进程的播放设备身份（懒注册，并发共享，失败冷却 10 秒）。
 * @param {boolean} [renew] 传 true 表示上一个身份被上游拒绝，强制换新。
 */
async function getPlaybackDevice(renew) {
  if (renew) { cached = null; inflight = null; }
  if (cached !== null) return cached;
  if (Date.now() < retryAfter) throw new Error('匿名设备注册冷却中，请稍后重试');
  if (inflight !== null) return inflight;
  inflight = registerOnce().then((id) => {
    cached = id;
    retryAfter = 0;
    inflight = null;
    return id;
  }).catch((e) => {
    retryAfter = Date.now() + 10000;
    inflight = null;
    throw e;
  });
  return inflight;
}

module.exports = { getPlaybackDevice, registerOnce, REGISTER_URL, KDF_SALT };
