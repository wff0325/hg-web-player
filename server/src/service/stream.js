'use strict';
/**
 * 下载 + 纯离线解密流水线。
 * 移植自 java service/Stream.java（其本身移植自 server/src/stream.js）。
 *
 * 流程：videoTrack 取 spade_a 与直链（AppSource 取址，见 videoTrack 注释）
 *      -> 下载密文 mp4
 *      -> spade 解包 content key（纯字节变换）
 *      -> AES-128-CTR 全轨解密（视频+音频各用自身逐样本 IV）
 *      -> 纯 JS 减壳剥离 CENC 信令成普通 mp4（布局不符时回落 ffmpeg remux）
 *      -> 缓存复用
 *
 * 同步 / 异步：凡发网络或文件异步 IO 的入口（videoTrack / download /
 * offlineDecrypt / ensureDecrypted / prewarm）都是 async（返回 Promise）；
 * 路径计算、缓存清理、ffmpeg 探测等纯计算保持同步。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const Mp4 = require('../core/mp4');
const Spade = require('../core/spade');
const Config = require('../util/config');
const Log = require('../util/log');
const Http = require('../util/http');
const Safeguards = require('../core/safeguards');
const AppSource = require('../service/app-source');

/** 默认保留的缓存文件数上限。 */
const CACHE_MAX_FILES = 30;

/** 缓存根目录：
 *  1) 环境变量 HONGGUO_STREAM_CACHE 直接指定缓存目录（自检/临时覆盖用）；
 *  2) 否则取 runtime.data_dir（视频缓存根，可为空），再拼 stream-cache；
 *  3) 都为空则退回 'server'（即 server/stream-cache）。
 *  统一转绝对路径：/download 会把落盘路径回给调用方，相对路径不便定位文件。 */
function cacheDir() {
  const d = Log.env('HONGGUO_STREAM_CACHE', null);
  if (d !== null) return path.resolve(d);
  const dd = Config.str('runtime.data_dir', null);
  // 默认落在 server/stream-cache（data 目录已撤销，缓存直接挂到 server 下）。
  // runtime.data_dir 语义收窄为「视频缓存根目录」，设了就以它为根。
  const base = (dd !== null) ? dd : 'server';
  return path.resolve(base, 'stream-cache');
}

/** 同键并发去重：同一集并发请求只解密一次。键为 out 路径，值为 Promise<string>。 */
const INFLIGHT = new Map();

/** 取该集指定清晰度的轨道信息。
 *  priority='low' 仅用于后台预热：取址队列里排在用户点播之后。 */
async function videoTrack(vid, quality, priority) {
  // 播放直链统一走 App 取址：player/v1 + v5 签名（详见 app-source）。
  // 2026-11-16 上游把 v3 的 multi_video_model/v1 对播放取址切成了 200 空体，
  // 现在只有 v5（Android v04.10.03 签名）能拿到 video_model。
  // 拿不到时返回 null，由 ensureDecrypted 报「无直链 / video_model」。
  return AppSource.fetch(String(vid), quality, priority);
}


/** 取缓存目录所在分区的剩余字节；dir 省略时用缓存目录；拿不到返回 null。 */
function diskFreeBytes(dir) {
  const target = (dir === undefined || dir === null || dir === '') ? cacheDir() : dir;
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(target);
    const avail = Number(st.bavail);
    const bsize = Number(st.bsize);
    if (!Number.isFinite(avail) || !Number.isFinite(bsize)) return null;
    return avail * bsize;
  } catch (e) {
    return null;
  }
}

/**
 * 写缓存前确认剩余空间。
 * 低于 runtime.min_free_mb（默认 300MB）时先激进清理（只留最近 keep 个），
 * 仍然不够就抛错，避免把磁盘写爆后连日志都写不进去（ENOSPC）。
 */
function ensureSpace(keep) {
  const dir = cacheDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 交给后续步骤报错 */ }
  const needMb = Config.num('runtime.min_free_mb', 300);
  const need = Math.max(0, needMb) * 1048576;
  if (need <= 0) return;
  let free = diskFreeBytes(dir);
  if (free === null) return;
  if (free >= need) return;
  Log.warn('磁盘剩余 ' + Math.round(free / 1048576) + 'MB，低于阈值 '
    + needMb + 'MB，开始清理旧缓存');
  pruneCache(keep === undefined ? 5 : keep);
  free = diskFreeBytes(dir);
  if (free !== null && free < need) {
    throw new Error('磁盘空间不足：剩余 ' + Math.round(free / 1048576)
      + 'MB，至少需要 ' + needMb + 'MB（可调小 runtime.min_free_mb 或清理磁盘）');
  }
}

// ==================== 下载 ====================

/** 从 URL 取主机名（只用于日志，失败返回空串）。 */
function hostOf(url) {
  try { return new URL(String(url)).host; } catch (e) { return ''; }
}

/** 分块下载的并发连接数（1 表示退回单连接）。 */
function streamConnections() {
  const raw = Log.env('HONGGUO_STREAM_CONNECTIONS',
    Config.num('runtime.download.connections', 4));
  const n = (typeof raw === 'number') ? raw : parseInt(String(raw).trim(), 10);
  if (Number.isNaN(n)) return 4;
  return Math.max(1, Math.min(8, n));
}

/** 带临时文件的下载（失败自动清理），返回写入的字节数。 */
async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  ensureSpace();
  const tmp = dest + '.part';
  const opts = {
    timeoutMs: 120000,
    headers: { 'user-agent': 'Mozilla/5.0' },
    connections: streamConnections(),
  };
  try {
    // 多连接分块落盘：跨境链路上单连接常被 RTT/丢包卡在 0.5MB/s，
    // 分块并发通常能翻几倍；服务端不支持 Range 时内部自动退回单连接。
    const out = await Http.sendToFileParallel(url, tmp, opts);
    fs.renameSync(tmp, dest);
    return { bytes: out.bytes, connections: out.connections };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignore) { /* 忽略 */ }
    // 真写满了：清空缓存再试一次，仍失败就把可读的错误抛出去
    if (/ENOSPC|no space left/i.test(String(e && e.message))) {
      Log.warn('写盘空间不足，清空缓存后重试：' + dest);
      try { pruneCache(0); } catch (ignore) { /* 忽略 */ }
      const out2 = await Http.sendToFileParallel(url, tmp, opts);
      fs.renameSync(tmp, dest);
      return { bytes: out2.bytes, connections: out2.connections };
    }
    throw e;
  }
}

// ==================== 离线解密 ====================

/** 解密结果。 */
class DecryptOut {
  constructor(path = null, key = null, tracks = 0, size = 0) {
    this.path = path;
    this.key = key;
    this.tracks = tracks;
    this.size = size;
  }
}

/** 从 fd 的 position 处读满 buf.length 字节。 */
function readFullyAt(fd, buf, position) {
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, position + got);
    if (n <= 0) throw new Error('读取越界：源数据提前结束');
    got += n;
  }
}

/** 流式复制文件（固定 64KB 缓冲，不随文件大小增长内存）。 */
function streamCopy(src, dst) {
  const inFd = fs.openSync(src, 'r');
  let outFd = null;
  try {
    outFd = fs.openSync(dst, 'w');
    const buf = Buffer.alloc(65536);
    for (;;) {
      const n = fs.readSync(inFd, buf, 0, buf.length, null);
      if (n <= 0) break;
      let written = 0;
      while (written < n) {
        written += fs.writeSync(outFd, buf, written, n - written);
      }
    }
  } finally {
    fs.closeSync(inFd);
    if (outFd !== null) fs.closeSync(outFd);
  }
}

/**
 * 纯离线解密：spadeA(base64) + 密文 mp4 -> 明文 mp4。
 *
 * 内存策略（关键）：**全程不把整个 MP4 读进堆**。
 * 1) 16 字节盒头顺读定位 moov，仅把 moov 段（几 MB）载入内存解析索引；
 * 2) 流式 copy 密文 -> outPath（调用方已把密文落在 outPath 时跳过）；
 * 3) 用 outPath 的随机读写句柄逐样本解密。
 * 因此峰值堆内存只与「moov 段大小 + 单个样本大小」有关，
 * 与视频总时长/文件大小无关（历史实现是 50~200MB/集，32 并发时会撑爆堆）。
 *
 * @returns {Promise<DecryptOut>}
 */
async function offlineDecrypt(spadeAB64, ctPath, outPath) {
  const sp = Spade.spadeToKey(spadeAB64, 0);
  const key = sp.key;
  if (!Spade.isValidKey(key)) {
    throw new Error('spade 解包失败（可能为 ver2/AES-GCM 或格式异常）');
  }

  const outSize = fs.statSync(ctPath).size;

  // ---- 1. 定位并仅加载 moov 段 ----
  let analysis;
  const raf = fs.openSync(ctPath, 'r');
  try {
    const fileLen = fs.fstatSync(raf).size;
    const moov = Mp4.findMoov(new Mp4.FileHeadReader(raf), fileLen);
    if (moov === null) throw new Error('密文文件无moov 盒（不是有效的 MP4）');
    if (moov.size > 0x7FFFFFFF - 8) {
      throw new Error('moov 段异常过大，无法载入内存');
    }
    const moovBuf = Buffer.alloc(moov.size);
    readFullyAt(raf, moovBuf, moov.start);
    analysis = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(moovBuf, moov.start));
  } finally {
    fs.closeSync(raf);
  }
  if (analysis.tracks.length === 0) throw new Error('密文文件无加密轨');

  // 视频轨用于 IV 自证；随后所有加密轨（视频+音频）统一用同一 content key 解密
  let video = null;
  for (const t of analysis.tracks) {
    if (t.handler === 'vide') { video = t; break; }
  }
  if (video === null) video = analysis.tracks[0];

  // ---- 2. 流式复制密文到 outPath（同路径时跳过：调用方已直接落在 outPath）----
  if (ctPath !== outPath) streamCopy(ctPath, outPath);

  // ---- 3. 逐样本原地解密 ----
  let decrypted = 0;
  // 样本缓冲取 256KB：足够覆盖绝大多数样本，又不会让并发时堆占用膨胀
  const out = fs.openSync(outPath, 'r+');
  try {
    const store = new Mp4.RafStore(out, 256 * 1024);

    // ⚠️ 必须先verify 再 decrypt：若顺序颠倒，样本 0 已是明文，
    // avccSelfOk 仍会通过，导致错误的 content key 被误判为合法。
    const cands = Mp4.trackBaseIvCandidates(video);
    const vIv = Mp4.verifyVideoIv(store, video, key, cands);
    if (vIv === null) {
      throw new Error('content key 与密文不匹配（spade 与该密文不对应，或为 ver2 视频）');
    }

    for (const t of analysis.tracks) {
      // 每条轨用各自的逐样本 IV；缺失时才回退到该轨的 base_iv
      let iv;
      if (t === video) {
        iv = vIv;
      } else {
        const tc = Mp4.trackBaseIvCandidates(t);
        iv = tc.length === 0 ? vIv : tc[0];
      }
      decrypted += Mp4.decryptTrack(store, t, key, iv).decrypted;
    }
  } finally {
    fs.closeSync(out);
  }

  // 尝试生成可播放成品：纯 JS 减壳，失败回落 ffmpeg remux；
  // 两条路都失败则保留已解密的原始容器（raw），调用方按 raw 返回。
  const playable = await toPlayable(outPath);

  return new DecryptOut(playable, key, decrypted, outSize);
}

/** 编码器描述。 */
class Encoder {
  constructor(name, args) {
    this.name = name;
    this.args = args;
  }
}

let cachedEncoder = null;
let encoderProbed = false;

/** 正则元字符转义（对齐 Java Pattern.quote 的语义）。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 探测本机可用的 H.264 编码器（结果缓存）。
 * 优先级：环境变量指定 > libx264 > libopenh264 > h264_qsv / h264_v4l2m2m。
 */
function h264Encoder() {
  if (encoderProbed) return cachedEncoder;
  encoderProbed = true;

  const preset = Log.env('HG_H264_ENCODER', '').trim();
  let list = '';
  try {
    const r = spawnSync(ffmpegBin(), ['-hide_banner', '-encoders'], {
      encoding: 'utf8', maxBuffer: 8 << 20,
    });
    if (r.error) return null;
    list = r.stdout || '';
  } catch (e) {
    return null;
  }
  const fl = list;
  const has = (n) => new RegExp('\\s' + escapeRe(n) + '\\s').test(fl);

  const table = [];
  if (preset !== '' && has(preset)) {
    table.push(new Encoder(preset, []));
  } else {
    table.push(new Encoder('libx264', ['-preset', 'veryfast', '-crf', '23']));
    table.push(new Encoder('libopenh264', ['-b:v', '2500k']));
    table.push(new Encoder('h264_qsv', ['-preset', 'veryfast']));
    table.push(new Encoder('h264_v4l2m2m', []));
  }
  for (const e of table) {
    if (has(e.name)) {
      // pix_fmt 与 crf 只对 x264/openh264 有意义
      e.args.push('-pix_fmt', 'yuv420p');
      cachedEncoder = e;
      return cachedEncoder;
    }
  }
  return null;
}

/** 是否开启转码：仅 HG_TRANSCODE=1（对齐原实现的开关，默认关闭）。 */
function transcodeWanted() {
  return Log.env('HG_TRANSCODE', '') === '1';
}

/** 删除文件，失败仅忽略（调用方都已有兜底路径）。 */
function deleteQuietly(f) {
  try {
    fs.unlinkSync(f);
  } catch (ignore) {
    // 忽略
  }
}

/**
 * 生成可播放成品（同步执行）。
 *
 * <p>默认路径：纯 JS 减壳（{@link Mp4#stripEncryption}）——样本数据此时
 * 已是明文，只需从 moov 删掉加密信令盒（sinf/senc/saio/saiz/pssh）并把
 * chunk 偏移平移过来，mdat 原样拷贝，**不依赖 ffmpeg**。
 * 减壳不适用（布局异常等）或显式开启转码时，回落 ffmpeg remux；
 * 两条路都失败返回 null，由调用方保留已解密的 raw 文件。
 *
 * <p>HONGGUO_PURE_STRIP=0 可强制走 ffmpeg（A/B 对比或应急回退）。
 *
 * 本函数是内部实现：等 ffmpeg 时不阻塞事件循环，故为 async（Java 版阻塞等待）。
 */
async function toPlayable(rawPath) {
  const name = path.basename(rawPath);
  const dir = path.dirname(rawPath);
  // 对齐 Node 的 path.parse().name：先剥掉最后一段扩展名，再剥 .raw 段。
  // 顺序不能反——raw 文件名是 <vid>_<q>.raw.mp4，
  // 若只去 .raw 会得到 <vid>_<q>.raw.mp4.play.mp4 这种双后缀名。
  let stem = name;
  const dot = stem.lastIndexOf('.');
  if (dot > 0) stem = stem.substring(0, dot);
  if (stem.endsWith('.raw')) stem = stem.substring(0, stem.length - 4);
  if (stem === '') stem = name;
  const out = path.join(dir, stem + '.play.mp4');

  // 转码默认关闭（HG_TRANSCODE=1 才开）
  const want = transcodeWanted();

  // ---- 默认路径：纯 JS 减壳 ----
  if (!want && Log.env('HONGGUO_PURE_STRIP', '') !== '0') {
    try {
      if (Mp4.stripEncryption(rawPath, out)) {
        deleteQuietly(rawPath);
        return out;
      }
      Log.warn('纯 JS 减壳不适用，回落 ffmpeg remux：' + path.basename(rawPath));
    } catch (e) {
      Log.warn('纯 JS 减壳异常，回落 ffmpeg remux：' + e);
    }
  }

  const enc = want ? h264Encoder() : null;
  if (want && enc === null) {
    Log.info('HG_TRANSCODE=1 但未找到可用的 H.264 编码器，本集退回 -c copy；'
      + '若浏览器不支持 HEVC 会黑屏');
  }

  const cmd = [
    '-y', '-loglevel', 'error', '-i', rawPath,
    '-c:v', enc !== null ? enc.name : 'copy',
  ];
  if (enc !== null) cmd.push(...enc.args);
  cmd.push('-c:a', enc !== null ? 'aac' : 'copy');
  if (enc !== null) cmd.push('-b:a', '128k');
  cmd.push('-movflags', '+faststart', out);

  try {
    // stderr 已合并进 stdout：限长收集（4KB），仅失败时用于诊断——
    // 旧实现整段丢弃，remux 失败时控制台只剩「remux 失败」无线索。
    const p = spawn(ffmpegBin(), cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errChunks = [];
    let errLen = 0;
    const collect = (chunk) => {
      if (errLen >= 4096) return;
      const take = chunk.length > (4096 - errLen)
        ? chunk.subarray(0, 4096 - errLen) : chunk;
      errChunks.push(Buffer.from(take));
      errLen += take.length;
    };
    p.stderr.on('data', collect);
    // stdout 读掉即可，防止管道写满挂死 ffmpeg
    p.stdout.on('data', () => { /* discard */ });

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 无超时的等待会让卡死的 ffmpeg 永久挂住请求线程
        try { p.kill('SIGKILL'); } catch (ignore) { /* 忽略 */ }
        resolve({ timeout: true });
      }, 60000);
      p.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: true });
      });
      p.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code });
      });
    });

    if (outcome.timeout) {
      Log.warn('ffmpeg remux 超时（60s）已强杀：' + path.basename(rawPath));
      return null;
    }
    if (outcome.error) {
      Log.warn('ffmpeg remux 异常（' + path.basename(rawPath) + '）');
      return null;
    }

    const ok = outcome.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
    if (!ok) {
      const detail = Buffer.concat(errChunks).toString('utf8').trim();
      Log.warn('ffmpeg remux 失败（' + path.basename(rawPath) + '）'
        + (detail === '' ? '' : '：' + detail));
      return null;
    }
    deleteQuietly(rawPath);
    return out;
  } catch (e) {
    Log.warn('ffmpeg remux 异常（' + path.basename(rawPath) + '）：' + e);
    return null;
  }
}

// ==================== 缓存 ====================

/** 缓存路径三变体（均为字符串路径）。 */
class Paths3 {
  constructor(out, play, raw) {
    this.out = out;    // 未加密直下的成品
    this.play = play;  // 加密解密 + remux 后的成品
    this.raw = raw;    // remux 前的解密产物
  }
}

/**
 * 计算某集指定清晰度的缓存路径。
 *
 * 注意 play 路径：offlineDecrypt 末尾会 remux 出「基名.play.mp4」（并删掉 raw），
 * 而基名不含.raw 段，所以加密内容最终落盘的是 <vid>_<q>.play.mp4。
 * 三个变体都必须参与命中判定，否则加密集永远命中不了缓存。
 */
function cachePaths(vid, quality) {
  const q = (quality === null || quality === undefined) ? '' : String(quality);
  let safeQ = q.replace(/[^\w]/g, '');
  if (safeQ === '') safeQ = 'best';
  const base = path.join(cacheDir(), vid + '_' + safeQ);
  return new Paths3(base + '.mp4', base + '.play.mp4', base + '.raw.mp4');
}

/** 命中缓存则返回可播放文件路径，否则 null。 */
function cachedPath(vid, quality) {
  const p = cachePaths(vid, quality);
  for (const c of [p.play, p.out, p.raw]) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).size > 0) return c;
    } catch (e) {
      // 忽略
    }
  }
  return null;
}

/**
 * 预热失败后的最大重试次数（不含首次尝试）。
 * 取址层（AppSource）已经自带瞬时故障重试，这里只留 1 次兜底：
 * 旧实现 2 次重试 + 4s/10s 退避会长时间占住预热执行位和取址队列，
 * 用户恰好在此期间点下一集时反而被拖慢。
 */
const PREWARM_MAX_RETRIES = 1;

/** 两次预热重试之间的基础间隔（毫秒）。 */
const PREWARM_RETRY_DELAY_MS = 2000;

/** 退避 + 抖动，避免与其它请求同拍。 */
function prewarmBackoff(attempt) {
  const base = PREWARM_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
  return Math.round(base + Math.random() * 800);
}

/** 预热执行体：失败时按 PREWARM_MAX_RETRIES 重试，全数失败才抛出。
 *  全程低优先级，不抢用户点播的取址位。 */
async function prewarmOnce(vid, quality) {
  let last = null;
  for (let attempt = 0; attempt <= PREWARM_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await Safeguards.sleep(prewarmBackoff(attempt));
    }
    try {
      return await ensureDecrypted(vid, quality, 'low');
    } catch (e) {
      // 还有一次兜底重试，首次失败只是过程，静默；
      // 真正失败由调用方记 WARN，避免点开新剧就刷一行「未完成」。
      last = e;
    }
  }
  throw last;
}

/** 取异常文案（对齐 Java e.getMessage()）。 */
function errMsg(e) {
  if (e === null || e === undefined) return 'null';
  return (e.message !== undefined && e.message !== null) ? String(e.message) : String(e);
}

/**
 * 预热执行位：有界，避免高频调用 /prewarm 时无限堆积。
 *
 * 背景：原实现每次调用 new Thread()，而每次预热都会跑完整的
 * 下载 + 解密（各自持一份样本缓冲）。高频调用会让线程数与内存同步膨胀。
 * Node 用「有界执行位 + 队列」实现同样的限流，队列写满时退化为
 * 调用方直接执行（对齐 Java 的 CallerRunsPolicy）。
 */
// 实测上游对「短时间内连续取 Key」很敏感：并发 4 会让多条预热连续取址，
// 反而抬高「App 接口未返回 data」的概率。前端一次只预热下一集，2 足够。
const PREWARM_MAX_CONCURRENCY = Log.envInt('HG_PREWARM_MAX_CONCURRENCY', 2);
const PREWARM_QUEUE_MAX = 64;
let prewarmActive = 0;
const prewarmQueue = [];

function runPrewarm(vid, quality) {
  prewarmActive++;
  prewarmOnce(vid, quality)
    .catch((e) => {
      // 预热只是提前备好下一集，失败不影响播放（点播时会重新取址），
      // 记一条 INFO 说明情况即可，不要报成故障。
      Log.info('预热未完成 ' + vid + '，点播时会自动重新获取：' + errMsg(e));
    })
    .finally(() => {
      prewarmActive--;
      const next = prewarmQueue.shift();
      if (next !== undefined) next();
    });
}

/** 预热：后台触发解密，不阻塞响应。 */
async function prewarm(vid, quality) {
  const hit = cachedPath(vid, quality);
  if (hit !== null) return 'cached';
  // 故意不等待：让解密在后台跑
  if (prewarmActive >= PREWARM_MAX_CONCURRENCY && prewarmQueue.length >= PREWARM_QUEUE_MAX) {
    // 执行位与队列都满：退化为当前调用同步执行，保证预热仍然生效
    try {
      await prewarmOnce(vid, quality);
    } catch (e) {
      // 预热只是提前备好下一集，失败不影响播放（点播时会重新取址），
      // 记一条 INFO 说明情况即可，不要报成故障。
      Log.info('预热未完成 ' + vid + '，点播时会自动重新获取：' + errMsg(e));
      return 'failed';
    }
    return 'warming';
  }
  const schedule = () => runPrewarm(vid, quality);
  if (prewarmActive < PREWARM_MAX_CONCURRENCY) schedule();
  else prewarmQueue.push(schedule);
  return 'warming';
}

/** 冷启动耗时超过这个值才打日志，避免正常命中缓存的播放刷屏。 */
const SLOW_LOG_MS = 1500;

/**
 * 打一行「缓存未命中 → 下载解密」的耗时拆解（取址 / 下载 / 解密）。
 *
 * 注意这行只代表缓存没命中走了完整流程，不代表"用户第一次播这一集"：
 * 换剧、窗口顶替、切清晰度都会让它再次出现。命中缓存时默认静默
 * （HG_STREAM_DEBUG=1 才打"缓存命中"行），所以日志里看不到命中不等于没命中。
 *
 * 只在超过 SLOW_LOG_MS 或 HG_STREAM_DEBUG=1 时输出——排查「首集很慢」时
 * 直接看这一行就知道是上游取址慢、CDN 慢，还是解密慢。
 */
function logTiming(vid, quality, parts, totalMs, sizeBytes) {
  if (Log.env('HG_STREAM_DEBUG', null) === null && totalMs < SLOW_LOG_MS) return;
  const mb = sizeBytes > 0 ? (sizeBytes / 1048576).toFixed(1) + 'MB' : '?';
  const speed = (parts.download > 0 && sizeBytes > 0)
    ? (sizeBytes / 1048576 / (parts.download / 1000)).toFixed(1) + 'MB/s'
    : '-';
  const conn = parts.connections ? '×' + parts.connections : '';
  const host = parts.host ? ' ' + parts.host : '';
  Log.info('缓存未命中，下载解密 vid=' + vid + ' q=' + quality + ' 合计' + totalMs + 'ms'
    + '（取址' + parts.fetch + 'ms 下载' + parts.download + 'ms@' + speed + conn
    + ' 解密' + parts.decrypt + 'ms）' + mb + host);
}

/** 确保某集已解密并落盘缓存，返回可播放 mp4 路径。
 *  priority 只影响「取直链」这一步在全局队列里的排队优先级。 */
async function ensureDecrypted(vid, quality, priority) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  ensureSpace();
  const p = cachePaths(vid, quality);

  const hit = cachedPath(vid, quality);
  if (hit !== null) {
    // 命中缓存是静默的（旧实现连 debug 都没有），排查「是不是一直在解密」
    // 时日志里只有解密、看不到命中，容易误判缓存没生效。开 HG_STREAM_DEBUG
    // 后打一行，平时不刷屏。
    if (Log.env('HG_STREAM_DEBUG', null) !== null) {
      Log.info('缓存命中 vid=' + vid + ' q=' + quality + ' ' + path.basename(hit));
    }
    // 只有残留的 raw（缺 play 成品）才需要补一次减壳/remux
    if (hit !== p.raw) return hit;
    const r = await toPlayable(p.raw);
    if (r !== null) return r;
  }

  const outKey = p.out;
  const exist = INFLIGHT.get(outKey);
  if (exist !== undefined) return exist; // 同集并发只解一次

  const task = (async () => {
    const again = cachedPath(vid, quality);
    if (again !== null && again !== p.raw) return again;

    // 分段计时：冷启动（首播）到底是卡在取址、下载还是解密，
    // 只在总耗时超过 SLOW_LOG_MS 或开了 HG_STREAM_DEBUG 时打一行，不刷屏。
    const t0 = Date.now();
    const t = await videoTrack(vid, quality, priority);
    const tFetch = Date.now() - t0;
    if (t === null || t === undefined || t.url === null
        || t.url === undefined || t.url === '') {
      throw new Error('无直链 / video_model');
    }
    if (!t.encrypt) {
      const t1 = Date.now();
      const dl = await download(t.url, p.out);
      const tDl = Date.now() - t1;
      logTiming(vid, quality,
        { fetch: tFetch, download: tDl, decrypt: 0, connections: dl.connections, host: hostOf(t.url) },
        Date.now() - t0, t.size);
      pruneCache();
      return p.out;
    }
    // 密文直接落在 raw 路径：offlineDecrypt 原地解密后原地减壳，
    // 省去旧实现里 .enc -> raw 的那次整文件拷贝（13MB/集的纯浪费）。
    const t1 = Date.now();
    const dl = await download(t.url, p.raw);
    const tDl = Date.now() - t1;
    const t2 = Date.now();
    const r = await offlineDecrypt(t.spadeA, p.raw, p.raw);
    const tDec = Date.now() - t2;
    logTiming(vid, quality,
      { fetch: tFetch, download: tDl, decrypt: tDec, connections: dl.connections, host: hostOf(t.url) },
      Date.now() - t0, t.size);
    // 减壳/remux 成功时返回 .play.mp4，失败时回退 raw
    const res = (r.path !== null && r.path !== undefined) ? r.path : p.raw;
    // 落盘完成后再清理：此时 play/raw 已是成品，不会误删半成品
    pruneCache();
    return res;
  })();
  INFLIGHT.set(outKey, task);
  try {
    return await task;
  } finally {
    INFLIGHT.delete(outKey);
  }
}

// ==================== 缓存上限清理 ====================

/**
 * 清理缓存目录，只保留最新的 limit 个成品文件。
 *
 * 按**最后修改时间**倒序保留，最旧的先删。每个 {@code <vid>_<q>} 最多留下
 * 一个成品（play > out > raw），因此实际删除数会略多于「超出的个数」。
 *
 * 两种文件不参与清理、也不会被删：
 * - {@code *.part}：下载临时文件，仍在被写；
 * - {@code *.enc}：密文临时文件，解密中且 finally 还要用。
 *
 * 上限取自 {@code runtime.cache.max_files}（配置文件，默认 CACHE_MAX_FILES），
 * 可被环境变量 {@code HONGGUO_CACHE_MAX_FILES} 覆盖；设为 0 或负数即关闭清理。
 *
 * @returns {number} 被删除的文件数
 */
function pruneCache(limit) {
  if (limit === undefined || limit === null) {
    const v = Log.env('HONGGUO_CACHE_MAX_FILES',
      Config.num('runtime.cache.max_files', CACHE_MAX_FILES));
    limit = (typeof v === 'number') ? v : parseInt(String(v).trim(), 10);
    if (Number.isNaN(limit)) limit = Config.num('runtime.cache.max_files', CACHE_MAX_FILES);
  }
  if (limit <= 0) return 0;

  const dir = cacheDir();
  // 目录不存在说明还没落过盘，无需清理
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch (e) { isDir = false; }
  if (!isDir) return 0;

  try {
    const keepable = [];
    for (const n of fs.readdirSync(dir)) {
      // 只统计成品文件（.play.mp4 / .mp4）；.raw.mp4 也以 .mp4 结尾，故一并纳入。
      if (!n.endsWith('.play.mp4') && !n.endsWith('.mp4')) continue;
      // 跳过下载/密文临时文件，避免删掉正在写或解密仍要用的
      if (n.endsWith('.part') || n.endsWith('.enc')) continue;
      const full = path.join(dir, n);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      keepable.push({ p: full, name: n, mtime: st.mtimeMs });
    }
    if (keepable.length <= limit) return 0;

    // 最后修改时间倒序：靠前的保留，靠后的（更旧）删除
    keepable.sort((a, b) => b.mtime - a.mtime);

    let deleted = 0;
    let failed = 0;
    for (let i = limit; i < keepable.length; i++) {
      const victim = keepable[i];
      try {
        fs.unlinkSync(victim.p);
        deleted++;
      } catch (e) {
        // 逐个打日志会在 60 个文件时刷屏，这里只累计，末尾汇总一行
        failed++;
      }
    }
    if (failed > 0) {
      Log.warn('缓存清理：' + failed + ' 个文件删不掉（被占用或被安全策略拦截），下次会再试');
    }
    // 正常清理不打印日志（此前每次清理都会向控制台输出一行）
    return deleted;
  } catch (e) {
    // 清理是尽力而为，失败不应影响播放
    Log.warn('缓存清理失败：' + errMsg(e));
    return 0;
  }
}

/**
 * 缓存统计（供 /cache/info）。
 * 口径与 pruneCache 保持一致：只算 .mp4 成品，跳过下载中的 .part；
 * 目录不存在时返回 0，不主动创建目录（只读接口不该有副作用）。
 *
 * @returns {{files:number, bytes:number, freeBytes:number|null}}
 */
function cacheInfo() {
  const result = { files: 0, bytes: 0, freeBytes: null };
  const dir = cacheDir();
  try { result.freeBytes = diskFreeBytes(dir); } catch (e) { /* 忽略 */ }

  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch (e) { isDir = false; }
  if (!isDir) return result;

  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.mp4') || n.endsWith('.part')) continue;
      const full = path.join(dir, n);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      result.files++;
      result.bytes += st.size;
    }
  } catch (e) {
    Log.warn('缓存统计失败：' + errMsg(e));
  }
  return result;
}

// ==================== 环境探测 ====================

let cachedFfmpeg = null;
let cachedBundled = null;

/**
 * 决定用哪个 ffmpeg 可执行文件。
 *
 * 优先级：HG_FFMPEG / config.runtime.ffmpeg → npm 包 ffmpeg-static → PATH 里的 ffmpeg。
 *
 * 为什么要这个：托管型 Node 主机通常不给装系统包，也改不了 PATH，
 * 只能把静态版 ffmpeg 传到项目目录里。旧实现写死 spawn('ffmpeg')，
 * 这种机器上永远探测不到。
 */
function resolveFfmpeg(envValue, bundled) {
  const env = String(envValue === undefined || envValue === null ? '' : envValue).trim();
  if (env !== '') return env;
  const bin = String(bundled === undefined || bundled === null ? '' : bundled).trim();
  if (bin !== '') return bin;
  return 'ffmpeg';
}

/** 可选依赖 ffmpeg-static 提供的二进制路径（装了才用，没装返回空串）。 */
function bundledFfmpeg() {
  if (cachedBundled !== null) return cachedBundled;
  try {
    const p = require('ffmpeg-static');
    cachedBundled = typeof p === 'string' ? p : '';
  } catch (e) {
    cachedBundled = '';
  }
  return cachedBundled;
}

/** 当前使用的 ffmpeg 路径（环境变量 / 配置 / 内置包 / PATH）。 */
function ffmpegBin() {
  const fromEnv = Log.env('HONGGUO_FFMPEG', Log.env('HG_FFMPEG', ''));
  return resolveFfmpeg(fromEnv || Config.str('runtime.ffmpeg', ''), bundledFfmpeg());
}

/** ffmpeg 是否可用（同步检查一次并缓存）。 */
function ffmpegAvailable() {
  if (cachedFfmpeg !== null) return cachedFfmpeg;
  try {
    const r = spawnSync(ffmpegBin(), ['-version'], { stdio: 'ignore' });
    cachedFfmpeg = !r.error && r.status === 0;
  } catch (e) {
    cachedFfmpeg = false;
  }
  return cachedFfmpeg;
}

/** 转码是否启用（HG_TRANSCODE=1 且找到编码器）。 */
function transcodeEnabled() {
  return transcodeWanted() && h264EncoderName() !== null;
}

/** 当前实际使用的 H.264 编码器名（未启用/不可用时返回 null）。 */
function h264EncoderName() {
  if (!transcodeWanted()) return null;
  if (!ffmpegAvailable()) return null;
  const e = h264Encoder();
  return e !== null ? e.name : null;
}


/**
 * 删除指定 vid（或全部）的解密缓存。
 *
 * @param {string[]} vids 要删除的分集 vid 列表；为空且 all=false 时不做任何事
 * @param {boolean} all true 表示清空整个缓存目录里的成品文件
 * @returns {{deleted:number, freed:number}} 删除文件数与释放字节数
 */
function deleteCached(vids, all) {
  const want = new Set((vids || []).map((v) => String(v).trim()).filter((v) => v !== ''));
  const result = { deleted: 0, freed: 0, failed: [] };
  if (!all && want.size === 0) return result;

  const dir = cacheDir();
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch (e) { isDir = false; }
  if (!isDir) return result;

  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith('.mp4')) continue;
    const us = n.indexOf('_');
    const vid = us > 0 ? n.substring(0, us) : '';
    if (!all && !want.has(vid)) continue;
    const full = path.join(dir, n);
    let size = 0;
    try { size = fs.statSync(full).size; } catch (e) { continue; }
    try {
      fs.unlinkSync(full);
      result.deleted++;
      result.freed += size;
    } catch (e) {
      // 失败要能被上层看见：文件被占用 / 安全策略拦截时不能假装删掉了
      result.failed.push(n);
      Log.warn('删除缓存失败 ' + n + '：' + errMsg(e));
    }
  }
  return result;
}

/**
 * 只保留指定 vid 的缓存（滚动窗口：本集 + 后两集）。
 *
 * 与 pruneCache 的区别：pruneCache 按「文件数上限 + 修改时间」淘汰，不知道哪一集
 * 正在播；keepWindow 按「分集 id 白名单」淘汰，窗口由前端在换集时给出。
 * 窗口外的成品文件一律删掉，窗口内的一动不动——所以"最多缓存三集、多了顶替"
 * 由这里保证，而不是靠调大/调小 max_files。
 *
 * 保护两类文件：
 * - *.part / *.enc：下载或解密仍在进行，删了会毁掉当前任务；
 * - 最近 RECENT_MS 内写过的成品：可能是刚落盘、浏览器还没读完的集，晚点再收。
 *
 * @param {string[]} vids 要保留的分集 id
 * @param {number} [recentMs] 近期写入保护窗口（毫秒），0 表示不保护
 * @returns {{deleted:number, freed:number, failed:string[], kept:number}}
 */
function keepWindow(vids, recentMs) {
  const want = new Set((vids || []).map((v) => String(v).trim()).filter((v) => v !== ''));
  const result = { deleted: 0, freed: 0, failed: [], kept: 0 };
  if (want.size === 0) return result;
  const recent = recentMs === undefined ? 20000 : Math.max(0, Number(recentMs) || 0);
  const now = Date.now();

  const dir = cacheDir();
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch (e) { isDir = false; }
  if (!isDir) return result;

  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith('.mp4')) continue;
    if (n.endsWith('.part') || n.endsWith('.enc')) continue;
    const us = n.indexOf('_');
    const vid = us > 0 ? n.substring(0, us) : '';
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (want.has(vid)) { result.kept++; continue; }
    if (recent > 0 && now - st.mtimeMs < recent) { result.kept++; continue; }
    try {
      fs.unlinkSync(path.join(dir, n));
      result.deleted++;
      result.freed += st.size;
      if (Log.env('HG_KEEP_DEBUG', null) !== null) {
        Log.info('窗口清理删除 ' + n + '（保留 ' + Array.from(want).join(',') + '）');
      }
    } catch (e) {
      result.failed.push(n);
      Log.warn('窗口清理删除失败 ' + n + '：' + errMsg(e));
    }
  }
  return result;
}

module.exports = {
  videoTrack,
  download,
  offlineDecrypt,
  cachePaths,
  cachedPath,
  ensureDecrypted,
  prewarm,
  pruneCache,
  keepWindow,
  cacheInfo,
  deleteCached,
  diskFreeBytes,
  ffmpegAvailable,
  ffmpegBin,
  resolveFfmpeg,
  transcodeEnabled,
  h264EncoderName,
  DecryptOut,
  Paths3,
  CACHE_MAX_FILES,
};
