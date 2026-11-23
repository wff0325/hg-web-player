'use strict';
/**
 * 单集取址诊断（`--probe`）。
 *
 * 为什么需要：播放失败时，旧链路只会打一行「取址失败：App 接口未返回 data」，
 * 看不出断在注册、签名、上游、解析还是选流。这个入口把同一条链路拆成 6 段，
 * 每段打印实测值（耗时、ticket、HTTP 状态、data 键、片源档位、直链主机），
 * 失败时附带原始响应片段与下一步该查什么。
 *
 * 用法：
 *   node server/src/main.js --probe 7685708510792797209
 *   node server/src/main.js --probe --series 7685690139804175384 --ep 2
 *   node server/src/main.js --probe 7685708510792797209 --quality 720p
 *   node server/src/main.js --probe 7685708510792797209 --deep     # 再跑离线解密
 *   node server/src/main.js --probe 7685708510792797209 --renditions
 *        # 打印各档「真实分辨率 + 码率 + 每像素比特」，用来判断画质是否真达标
 *   node server/src/main.js --probe <vid> --renditions --deep
 *        # 解密后直接解析 MP4 轨道，核实实际分辨率（最终判据）
 *
 * 与线上播放链路的区别：不排队、不自动重试、不吞异常——只跑一次，
 * 看到的就是上游此刻的真实反应。
 */
const fs = require('fs');
const AppSource = require('./service/app-source');
const Client = require('./service/client');
const Stream = require('./service/stream');
const Json = require('./util/json');
const Log = require('./util/log');

/** 取 `--name value` 形式的参数值；缺省返回 null。 */
function argValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  return (v === undefined || v.startsWith('--')) ? '' : v;
}

function hasFlag(args, name) {
  return args.indexOf(name) >= 0;
}

/** 毫秒显示。 */
function ms(v) {
  return (v === undefined || v === null) ? '—' : v + 'ms';
}

/** 人类可读体积。 */
function size(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

/** 终端显示宽度：CJK 与全角符号占两列。 */
function width(text) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a
      || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
  }
  return w;
}

/** 按显示宽度右侧补空格。 */
function pad(text, cols) {
  const w = width(text);
  return w >= cols ? String(text) : String(text) + ' '.repeat(cols - w);
}

function line(no, name, ok, detail) {
  console.log('  [' + no + '] ' + pad(name, 16) + (ok ? '✓' : '✗') + ' ' + detail);
}

function note(text) {
  console.log('      ' + text);
}

/** 失败时的排查建议：把上游措辞翻成「下一步该动哪里」。 */
function hintOf(error, trace) {
  const e = String(error || '');
  const at = (trace.attempts || [])[0];
  const code = at === undefined ? null : at.code;
  if (code !== null && code !== 0 && code !== undefined) {
    if (code === 101000) return '上游业务码 101000：该集不存在或已下架，换一集/换一部剧再试。';
    if (code === 100001) return '上游业务码 100001：参数或身份不被接受，先看原始响应。';
    return '上游返回业务码 ' + code + '：先看原始响应片段，再判断是参数、身份还是片源问题。';
  }
  if (/设备注册/.test(e)) {
    return '匿名注册被拒或限流（device_id 返回 0）。等 1~2 分钟再试；'
      + '频繁诊断会触发 IP 级冷却。';
  }
  if (/未返回 data/.test(e)) {
    const at = (trace.attempts || []);
    const rejected = at.filter((a) => a.status === 200 && !a.hasData);
    if (rejected.length >= 2) {
      return '两次换身份都返回 200 空体：多半是签名协议又被改了'
        + '（看下面的原始响应），或本机 IP 被上游拉黑。';
    }
    return '上游 200 但无 data：先看原始响应片段判断是空体还是错误码。';
  }
  if (/未返回所选分集/.test(e)) {
    return 'vid 不在响应里：确认分集是否已下架，或 mixed_video_id_map 的 1004 类型是否需要变。';
  }
  if (/未返回 video_model/.test(e)) {
    return '该集没有 video_model：付费集/预告集常见，换一集或换一部剧再试。';
  }
  if (/片源地址或密钥无法解析|spade|key_seed/i.test(e)) {
    return '片源在但 URL/密钥解不开：spade_a 或 key_seed 的派生方式可能变了。';
  }
  if (/兼容的 H.264\/HEVC/.test(e)) {
    return '只有非 H.264/HEVC 编码（如 AV1）：换清晰度，或打开转码。';
  }
  if (/分集编号无效/.test(e)) {
    return 'vid 必须是纯数字（1~30 位）。';
  }
  if (/HTTP \d+/.test(e)) {
    return '上游返回非 200：看状态码，403/429 是风控，5xx 是上游故障。';
  }
  return '对照下面的分段结果定位；原始响应片段是最有用的线索。';
}

/** 取位置参数里的分集编号（跳过 --xxx 及其取值）。 */
function positionalVid(args) {
  const takesValue = new Set(['--series', '--ep', '--quality']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (takesValue.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    if (/^\d+$/.test(a)) return a;
  }
  return '';
}

/** 从 series_id + 集数解析 vid。 */
async function resolveVid(args) {
  const sid = argValue(args, '--series');
  if (sid !== null && sid !== '') {
    const meta = await Client.getEpisodes(String(sid).trim());
    const want = Number.parseInt(argValue(args, '--ep') || '1', 10);
    const list = Json.optArr(meta.episodes);
    for (const eObj of list) {
      const e = Json.optObj(eObj);
      if (e !== null && Json.optLong(e.index, 0) === want) {
        return { vid: Json.optStr(e.vid, ''), title: Json.optStr(meta.title, ''), index: want };
      }
    }
    return { vid: '', title: Json.optStr(meta.title, ''), index: want, missing: true };
  }
  return { vid: positionalVid(args), title: '', index: 0 };
}

/**
 * 打印档位画质表。
 *
 * 判据用「每像素比特」（bpp = 码率 / (宽 × 高 × 帧率)）：
 * 分辨率只说明画面尺寸，bpp 才反映单位像素分到多少数据——bpp 太低就是「糊」，
 * 这时候 1080p 只是被放大出来的 1080p，观感还不如同码率的 720p。
 *
 * @param {Array} rows 档位（含 width/height/bitrate/fps）
 * @param {object} picked 当前选中的档位
 */
function printRenditions(rows, picked) {
  console.log('');
  console.log('  ---- 档位画质 ----');
  console.log('  ' + pad('标签', 8) + pad('真实分辨率', 14) + pad('编码', 10)
    + pad('码率', 11) + pad('每像素比特', 12) + pad('体积', 9) + pad('帧率', 6) + '评价');
  // 按分辨率从大到小排，便于横向比较
  const sorted = rows.slice().sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  for (const r of sorted) {
    const w = Number(r.width) || 0;
    const h = Number(r.height) || 0;
    const fps = Number(r.fps) || 30;
    const kbps = Math.round((Number(r.bitrate) || 0) / 1000);
    const bpp = (w > 0 && h > 0 && kbps > 0) ? (kbps * 1000) / (w * h * fps) : 0;
    let verdict = '—';
    if (bpp > 0) {
      if (bpp >= 0.05) verdict = '好';
      else if (bpp >= 0.03) verdict = '一般';
      else if (bpp >= 0.02) verdict = '偏低';
      else verdict = '很低';
    }
    const mark = (picked !== null && picked !== undefined && r.quality === picked.quality)
      ? '  ← 当前' : '';
    console.log('  ' + pad(String(r.quality || '?'), 8)
      + pad(w > 0 ? (w + 'x' + h) : '?', 14)
      + pad(String(r.codec || '?'), 10)
      + pad(kbps > 0 ? (kbps + 'kbps') : '?', 11)
      + pad(bpp > 0 ? bpp.toFixed(3) : '?', 12)
      + pad((Number(r.size) / 1048576).toFixed(1) + 'MB', 9)
      + pad(String(fps), 6)
      + verdict + mark);
  }
  console.log('');
  console.log('  说明：标签只是名字，真实分辨率看第二列，压缩程度看「每像素比特」（bpp）。');
  console.log('        bpp = 码率 ÷ (宽 × 高 × 帧率)。分辨率决定细节上限，bpp 决定这分辨率被压得多狠。');
  console.log('        经验阈值：≥0.05 好 / 0.03~0.05 一般 / <0.03 偏低（1080p 低于 ~1.5Mbps 基本就是压糊了）。');
  console.log('        短剧普遍 1080p 只给 0.9~1.2Mbps；bpp 相近时，小分辨率反而更「锐」（不用放大）。');
}

/** 单集诊断主流程。 */
async function run(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const quality = argValue(args, '--quality') || 'best';
  const deep = hasFlag(args, '--deep');

  Log.initEncoding();
  console.log('');
  console.log('  ============================================');
  console.log('    单集取址诊断（v5 链路）');
  console.log('  ============================================');

  const target = await resolveVid(args);
  if (target.missing) {
    console.log('  ✗ 该剧没有第 ' + target.index + ' 集');
    return 1;
  }
  if (target.vid === '') {
    console.log('  ✗ 缺少分集编号');
    console.log('    用法：--probe <vid>  或  --probe --series <series_id> --ep <集数>');
    return 1;
  }

  console.log('  vid          ' + target.vid
    + (target.title !== '' ? '（' + target.title + ' 第 ' + target.index + ' 集）' : ''));
  console.log('  主接口       ' + AppSource.VIDEO_TAB_API);
  console.log('  兜底接口     ' + AppSource.VIDEO_API);
  console.log('  清晰度       ' + quality);
  console.log('');

  // 诊断期间默认屏蔽 INFO 日志，避免「设备注册成功」插进报告中间；
  // 需要原始日志时加 --verbose。
  const verbose = hasFlag(args, '--verbose');
  const originalInfo = Log.info;
  if (!verbose) Log.info = () => {};
  let r;
  try {
    r = await AppSource.diagnose(target.vid, quality);
  } finally {
    Log.info = originalInfo;
  }
  const t = r.trace || {};
  if (t.route) {
    note('实际取址：' + (t.route === 'video-tab'
      ? 'GET video_tab' + (t.tab ? '（' + t.tab.host + '，' + size(t.tab.bytes) + '）' : '')
      : '签名 POST player/v1') + (t.tabError ? '；GET 失败：' + t.tabError : ''));
  }

  // ---- 1. 设备注册 ----
  if (t.identity === undefined) {
    line('1/6', '设备注册', false, '失败');
    note('注册接口：' + require('./service/playback-device').REGISTER_URL);
  } else {
    line('1/6', '设备注册', true, ms(t.registerMs)
      + '  device_id=' + t.identity.device_id + ' iid=' + t.identity.iid);
  }

  // ---- 2. 签名 ----
  const at0 = (t.attempts || [])[0];
  if (at0 === undefined) {
    line('2/6', '签名（v5）', false, '未执行（注册未成功）');
  } else {
    const signedKeys = at0.headerKeys.filter((k) => k.startsWith('x-') && k !== 'x-ss-stub');
    line('2/6', '签名（v5）', true, ms(at0.signMs) + '  _rticket=' + at0.ticket
      + '  头 ' + at0.headerKeys.length + ' 个（签名 ' + signedKeys.join(' ') + '）');
  }

  // ---- 3. 上游请求 ----
  if (at0 === undefined) {
    line('3/6', '上游请求', false, '未执行');
  } else {
    const okHttp = at0.status === 200 && at0.hasData;
    line('3/6', '上游请求', okHttp, 'HTTP ' + at0.status + '  ' + size(at0.bytes)
      + '  code=' + (at0.code === null ? '?' : at0.code)
      + '  data=' + (at0.hasData ? '有' : '无'));
    if (!okHttp) {
      note('原始响应：' + String(at0.snippet || '').replace(/\s+/g, ' ').slice(0, 200));
      for (const a of (t.attempts || []).slice(1)) {
        note('换身份重试：HTTP ' + a.status + '  ' + size(a.bytes)
          + '  data=' + (a.hasData ? '有' : '无') + '  device_id 已更换');
      }
    }
  }

  // ---- 4. 模型解析 ----
  const renditions = t.renditions || [];
  const code0 = at0 === undefined ? 0 : at0.code;
  if (r.ok || renditions.length > 0) {
    line('4/6', '模型解析', true, 'data=[' + (t.dataKeys || []).join(',') + ']  '
      + renditions.length + ' 档片源'
      + (t.usedFallback ? '（走 fallback_api 二次取址）' : '（直出 video_list）')
      + (t.bytevc2Compat ? '（bytevc2 兼容→codec_type=' + t.bytevc2Compat.codec_type
        + ' 拿到 ' + t.bytevc2Compat.playable + ' 档可播）' : ''));
  } else if (code0 !== 0 && code0 !== null && code0 !== undefined) {
    line('4/6', '模型解析', false, '上游 code=' + code0 + '，本集无模型'
      + (t.dataKeys && t.dataKeys.length ? '（data=[' + t.dataKeys.join(',') + ']）' : '（data 为空）'));
  } else if (at0 !== undefined && at0.hasData) {
    line('4/6', '模型解析', false, 'data=[' + (t.dataKeys || []).join(',') + '] 但没取到本集模型');
  } else {
    line('4/6', '模型解析', false, '未执行');
  }

  // ---- 5. 选流 ----
  if (r.ok) {
    line('5/6', '选流', true, r.result.definition + '  ' + size(r.result.size)
      + '  ' + (r.result.encrypt ? 'spade_a 已解出 content key' : '无加密'));
  } else {
    line('5/6', '选流', false, '未取到可用档位');
  }

  // ---- 6. 直链 ----
  if (r.ok) {
    let host = '';
    try { host = new URL(r.result.url).host; } catch (e) { host = '(解析失败)'; }
    line('6/6', '直链', true, host + (t.seedEncrypted ? '  key_seed 已解密' : ''));
    if (t.hostSpeeds && t.hostSpeeds.length > 1) {
      note('候选节点测速（各取 128KB）：');
      for (const h of t.hostSpeeds) {
        const mark = h.host === t.pickedHost ? ' ← 选中' : '';
        note('  ' + String(h.kbps).padStart(6) + 'KB/s  ' + h.host + mark);
      }
    }
    note('url: ' + r.result.url.slice(0, 120));
  } else {
    line('6/6', '直链', false, '无');
  }

  console.log('');
  if (r.ok) {
    console.log('  结果：取址成功，' + ms(r.ms));
  } else {
    console.log('  结果：取址失败，' + ms(r.ms));
    console.log('  原因：' + r.error);
    console.log('  建议：' + hintOf(r.error, t));
  }

  // ---- 可选：档位画质表（--renditions）----
  if (hasFlag(args, '--renditions') && (t.renditions || []).length > 0) {
    printRenditions(t.renditions, t.picked);
  }

  // ---- 可选：离线解密 ----
  if (deep) {
    console.log('');
    console.log('  ---- 离线解密（--deep）----');
    if (!r.ok) {
      console.log('  ✗ 取址未成功，跳过解密');
      return 1;
    }
    const t1 = Date.now();
    try {
      const file = await Stream.ensureDecrypted(target.vid, quality);
      const st = fs.statSync(file);
      const head = Buffer.alloc(16);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
      const box = head.subarray(4, 8).toString('ascii');
      const okBox = box === 'ftyp';
      console.log('  ✓ 解密完成 ' + ms(Date.now() - t1) + '  ' + size(st.size));
      console.log('    文件 ' + file);
      console.log('    ' + (okBox ? '✓' : '✗') + ' 首盒 ' + box
        + (okBox ? '（MP4 头正常）' : '（不是合法 MP4）'));
      if (!okBox) return 1;
      // 直接解析解密后的 MP4 取真实分辨率——这是「到底是不是 1080p」的最终判据，
      // 不依赖上游标签，也不依赖接口里的 vwidth/vheight 字段。
      try {
        const Mp4 = require('./core/mp4');
        const an = Mp4.analyzeEncryptedTracks(fs.readFileSync(file));
        const vt = an.tracks.find((x) => x.handler === 'vide');
        if (vt !== undefined && vt !== null) {
          console.log('    实际视频轨 ' + vt.width + 'x' + vt.height
            + '（' + vt.sampleCount + ' 个样本）');
          const declared = t.picked;
          if (declared !== null && declared !== undefined) {
            const dW = Number(declared.shortSide) || 0;
            if (dW > 0 && Math.min(vt.width, vt.height) !== dW) {
              console.log('    ⚠ 与接口标注的短边 ' + dW + ' 不一致（上游标签/字段有误）');
            }
          }
        }
      } catch (e) {
        console.log('    （解析 MP4 轨道失败：' + (e && e.message ? e.message : e) + '）');
      }
    } catch (e) {
      console.log('  ✗ 解密失败 ' + ms(Date.now() - t1));
      console.log('    原因 ' + String((e && e.message) || e));
      console.log('    建议 取址通了但解密失败：spade_a / CENC 链路变化，'
        + '或该集是纯明文（检查 /play 的 url_is_http）');
      return 1;
    }
  }

  console.log('');
  return r.ok ? 0 : 1;
}

module.exports = { run };
