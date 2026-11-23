'use strict';
/**
 * 自检套件。
 *
 * 对应原 Java SelfTest.java —— 逐条保留其 21 组回归基线，用于判断
 * 「Java→Node 反向迁移是否等价」。全部用例不依赖网络与外部服务。
 *
 * 与 Java 的差异点（仅在运行态适配层）：
 *  - System.setProperty / getProperty  ->  process.env
 *  - RandomAccessFile                   ->  fs fd + Mp4.RafStore
 *  - 后台清扫线程 daemon 判定           ->  Safeguards.sweeperActive()
 *  - 末尾运行环境打印 Java 版本          ->  打印 Node 版本
 * 断言项数与判据与 Java 一一对应。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Mp4 = require('./core/mp4');
const PureSign = require('./core/pure-sign');
const Safeguards = require('./core/safeguards');
const Spade = require('./core/spade');
const AppSource = require('./service/app-source');
const Client = require('./service/client');
const Stream = require('./service/stream');
const KeyStore = require('./core/keystore');
const Device = require('./core/device');
const Config = require('./util/config');
const Crypto = require('./util/crypto');
const Json = require('./util/json');
const Mp4Fixture = require('./mp4-fixture');

// ==================== 断言 ====================

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name + (detail === null || detail === undefined || detail === '' ? '' : '  ' + detail));
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail === null || detail === undefined || detail === '' ? '' : '  ' + detail));
  }
}

/**
 * 跳过一条断言：前提未满足时不算失败，也不计入通过数。
 * 保证「跳过」与「通过」一样可追溯。
 */
function skip(name, reason) {
  skipped++;
  console.log('  ⊘ ' + name + (reason === null || reason === undefined || reason === '' ? '' : '  ' + reason));
}

function section(title) {
  console.log('');
  console.log('=== ' + title + ' ===');
}

function hex(b) { return Crypto.hex(b); }

function unhex(h) { return Crypto.unhex(h); }

function bufEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function arrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 按 Java List.toString() 的形态输出数组：`[a, b, c]`。 */
function javaList(a) {
  return '[' + a.join(', ') + ']';
}

// ==================== 各组用例 ====================

/** 1. spade 解包：5 组运行时真值 + ver2 拒绝。 */
function spade() {
  section('1. spade -> content key 解包（对齐 5 组真值）');
  const all = Spade.selfTest();
  check('spade 解包 5 组真值', all, '');
  const k = Spade.unwrapV1(unhex('93bc1df253ba1bf7618b19c448b806f64d810afc45b715fe5eb925f26cbf12f541ba098282'), 0);
  check('输出为 32 位十六进制', Spade.isValidKey(k), k);
  const ver2 = Buffer.alloc(40);
  check('ver2 类型被拒绝', Spade.unwrapV1(ver2, 0) === null, '');
}

/** 2. AES-128-CTR 计数器构造。 */
function ctrCounter() {
  section('2. AES-128-CTR 计数器构造');
  // counter = (base_iv_high64 + index) << 64，低 64 位恒为 0
  const c0 = Mp4.ctrCounter('0000000000000001', 0);
  const c1 = Mp4.ctrCounter('0000000000000001', 1);
  const c2 = Mp4.ctrCounter('00000000000000ff', 1);
  check('counter 长度 16 字节', c0.length === 16, '');
  check('index=0 高位保留',
    hex(c0) === '00000000000000010000000000000000', hex(c0));
  check('index=1 进位到高 64 位',
    hex(c1) === '00000000000000020000000000000000', hex(c1));
  check('0xff + 1 进位正确',
    hex(c2) === '00000000000001000000000000000000', hex(c2));
}

/**
 * 3. 逐样本 IV -> CTR 计数器。
 * 回归用例：本项目实测 senc IV 为 8 字节，位于计数器高 64 位（右侧补零）。
 */
function ivToCounter() {
  section('3. 逐样本 IV -> CTR 计数器');
  const c8 = Mp4.ivToCounter('ebbde5029bbf3f29');
  check('8 字节 IV 长度 16', c8.length === 16, '');
  check('8 字节 IV 位于高 64 位',
    hex(c8) === 'ebbde5029bbf3f290000000000000000', hex(c8));
  check('与 ctrCounter(baseIv,0) 等价',
    bufEq(c8, Mp4.ctrCounter('ebbde5029bbf3f29', 0)));
  const c16 = Mp4.ivToCounter('00112233445566778899aabbccddeeff');
  check('16 字节 IV 原样保留',
    hex(c16) === '00112233445566778899aabbccddeeff', hex(c16));

  const tr = new Mp4.Track();
  tr.ivs = ['ebbde5029bbf3f29', 'ebbde5029bbf3f2a'];
  check('counterFor 优先用逐样本 IV',
    hex(Mp4.counterFor(tr, null, 1)) === 'ebbde5029bbf3f2a0000000000000000');
  check('counterFor 无 IV 时回退 base_iv',
    hex(Mp4.counterFor(new Mp4.Track(), '0000000000000005', 2))
      === '00000000000000070000000000000000');
}

/** 4. AVCC / NAL 自证。 */
function avcc() {
  section('4. AVCC / NAL 自证');
  const annexb = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 1, 0x68, 0xCE]);
  const avccBuf = Buffer.from([0, 0, 0, 2, 0x67, 0x42, 0, 0, 0, 3, 0x68, 0xCE, 0x3C]);
  const junk = Buffer.alloc(64, 0xAB);

  check('Annex-B 起始码识别', Mp4.avccSelfOk(annexb, annexb.length));
  check('AVCC 长度前缀识别', Mp4.avccSelfOk(avccBuf, avccBuf.length));
  check('随机数据拒绝', !Mp4.avccSelfOk(junk, junk.length));

  const multi = Buffer.from([
    0, 0, 0, 2, 0x67, 0x42,
    0, 0, 0, 2, 0x68, 0xCE,
    0, 0, 0, 3, 0x65, 0x88, 0x84]);
  check('多 NAL 样本整链自证', Mp4.avccSelfOk(multi, multi.length));

  const nonIdr = Buffer.from([0, 0, 0, 2, 0x06, 0x42]);
  check('nal_unit_type=0 非 IDR 分片通过', Mp4.avccSelfOk(nonIdr, nonIdr.length));

  const overflow = Buffer.from([0, 0, 0, 99, 0x65, 0x88]);
  check('长度越界拒绝', !Mp4.avccSelfOk(overflow, overflow.length));

  const badBit = Buffer.from([0, 0, 0, 2, 0x85, 0x42]);
  check('forbidden_zero_bit 置位拒绝', !Mp4.avccSelfOk(badBit, badBit.length));

  const tr = new Mp4.Track();
  tr.sampleCount = 100;
  tr.sizes = new Array(100).fill(1000);
  const probe = Mp4.pickProbeIndices(tr);
  let hasZero = false;
  let inRange = true;
  for (const i of probe) {
    if (i === 0) hasZero = true;
    if (i < 0 || i >= 100) inRange = false;
  }
  check('探测样本含 index 0 且在范围内', hasZero && inRange, '共 ' + probe.length + ' 个');
}

/** 5. AES-128-CTR 加解密往返一致性。 */
function ctrRoundTrip() {
  section('5. AES-128-CTR 加解密往返一致性');
  const key = Buffer.alloc(16);
  const ctr = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    key[i] = i;
    ctr[i] = 0xF0 + i;
  }
  const plain = Buffer.from('红果短剧 · hongguo ctr 往返测试', 'utf8');
  const enc = Crypto.aes128Ctr(key, ctr, plain);
  const dec = Crypto.aes128Ctr(key, ctr, enc);
  check('解密还原原文', bufEq(plain, dec));
  check('密文与原文不同', !bufEq(enc, plain));
}

/** 6. MP4 盒解析（构造最小合法 moov）。 */
function mp4Boxes() {
  section('6. MP4 盒解析（构造最小合法 moov）');
  const buf = Mp4Fixture.buildMinimalEncryptedMp4();
  const a = Mp4.analyzeEncryptedTracks(buf);
  check('解析出加密轨', a.tracks.length > 0, a.tracks.length + ' 条');
  if (a.tracks.length === 0) return;
  const t = a.tracks[0];
  check('handler 为 vide', t.handler === 'vide', t.handler);
  check('样本数为 2', t.sampleCount === 2, '' + t.sampleCount);
  check('逐样本 IV 已解析', t.ivs !== null && t.ivs.length === 2, '');
  check('IV 长度为 16 字节', t.ivSize === 16, '' + t.ivSize);
  // tenc 挂在 stsd→encv 内，而 encv 不在盒树的容器白名单里，
  // 因此 default_KID 读不到（与 Java 版行为一致）。不影响解密。
  check('KID 不参与解密链路（content key 来自 spade）', t.kid === null, '');

  const top = Mp4.parseBoxes(buf, 0, buf.length);
  let hasFtyp = false;
  let hasMoov = false;
  for (const b of top) {
    if (b.type === 'ftyp') hasFtyp = true;
    if (b.type === 'moov') hasMoov = true;
  }
  check('顶层含 ftyp 与 moov', hasFtyp && hasMoov, '');
}

/** 7. 端到端：逐样本 IV + content key 解密。 */
function decryptEndToEnd() {
  section('7. 端到端：content key + 逐样本 IV 解密');
  try {
    const buf = Mp4Fixture.buildMinimalEncryptedMp4();
    const a = Mp4.analyzeEncryptedTracks(buf);
    if (a.tracks.length === 0) {
      check('夹具可解析', false, '无加密轨');
      return;
    }
    const vt = a.tracks[0];
    const keyHex = Mp4Fixture.fixtureKeyHex();

    const cands = Mp4.trackBaseIvCandidates(vt);
    const vIv = Mp4.verifyVideoIv(buf, vt, keyHex, cands);
    check('verifyVideoIv 通过逐样本 IV 自证',
      vIv !== null && vIv === vt.ivs[0], '' + vIv);

    const r = Mp4.decryptTrack(buf, vt, keyHex, vIv);
    check('全部样本解密完成', r.decrypted === vt.sampleCount,
      r.decrypted + '/' + r.total);
    let allOk = true;
    for (let i = 0; i < r.decrypted; i++) {
      const off = vt.offsets[i];
      const size = vt.sizes[i];
      if (off + size > buf.length
        || !Mp4.avccSelfOk(buf.subarray(off, off + size), size)) {
        allOk = false;
        break;
      }
    }
    check('解密后每个样本 AVCC 自洽', allOk, '');

    const plains = Mp4Fixture.plainSamples();
    let restored = true;
    for (let i = 0; i < r.decrypted && i < plains.length; i++) {
      const off = vt.offsets[i];
      const size = vt.sizes[i];
      const got = buf.subarray(off, off + size);
      if (!bufEq(got, plains[i])) restored = false;
    }
    check('解密逐字节还原夹具明文', restored, '');

    const badKey = Buffer.alloc(16, 0x5A);
    const badIv = Mp4.verifyVideoIv(buf, vt, hex(badKey), cands);
    check('错误 content key 被拒绝', badIv === null, '' + badIv);
  } catch (e) {
    check('端到端解密', false, String(e.message));
  }
}

/** 8. JSON 往返（自研轻量库，含数字语义与 null 省略）。 */
function json() {
  section('8. JSON 往返与数字语义');
  try {
    const src = Json.obj();
    src.a = 1;
    src.b = '中文"引号"\n换行';
    src.c = Json.arr();
    src.d = 1.5;
    const text = Json.stringify(src);
    const back = Json.parseObject(text);
    check('整型往返为数值',
      Json.optLong(back.a, 0) === 1, '');
    check('字符串转义往返',
      '中文"引号"\n换行' === back.b, '');
    check('小数保持精度',
      Math.abs(Json.optDouble(back.d, 0) - 1.5) < 1e-9, '');

    const withNull = Json.obj();
    withNull.keep = 'v';
    withNull.drop = null;
    const s2 = Json.stringify(withNull, true);
    check('skipNulls 省略 null 字段', !s2.includes('drop'), s2);

    const num = Json.obj();
    num.x = 1.0;
    check('1.0 输出为 1', Json.stringify(num).includes('"x":1'), Json.stringify(num));
  } catch (e) {
    check('JSON 往返', false, String(e.message));
  }
}

/**
 * 9. 播放缓存路径。
 * 背景：解密末尾 remux 产出 "<vid>_<q>.play.mp4" 并删掉 raw，
 * 而早期实现只探测 "<vid>_<q>.mp4"，导致加密内容永远不命中缓存。
 */
function cachePaths() {
  section('9. 播放缓存路径：.play.mp4 变体必须参与命中判定');
  const p = Stream.cachePaths('7688396322021329982', 'best');
  check('remux 产出名与 play 路径一致',
    path.basename(p.play) === '7688396322021329982_best.play.mp4',
    path.basename(p.play));
  check('play 与 out 是不同文件', p.play !== p.out, '');
  check('raw 命名带 .raw 段',
    path.basename(p.raw).endsWith('_best.raw.mp4'),
    path.basename(p.raw));

  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cache-'));
    const saved = process.env.HONGGUO_STREAM_CACHE;
    process.env.HONGGUO_STREAM_CACHE = tmp;
    const q = Stream.cachePaths('999', 'best');
    check('空目录时 cachedPath 为空',
      Stream.cachedPath('999', 'best') === null, '');
    fs.writeFileSync(q.play, Buffer.from('x'));
    check('仅 .play.mp4 存在即命中',
      Stream.cachedPath('999', 'best') === q.play, '');
    fs.unlinkSync(q.play);
    fs.writeFileSync(q.out, Buffer.from('x'));
    check('仅 .mp4 存在即命中',
      Stream.cachedPath('999', 'best') === q.out, '');
    if (saved === undefined) delete process.env.HONGGUO_STREAM_CACHE;
    else process.env.HONGGUO_STREAM_CACHE = saved;
  } catch (e) {
    check('缓存路径命中判定', false, String(e.message));
  } finally {
    if (tmp !== null) deleteTree(tmp);
  }
}

/** 10. 设备身份 device_id（搜索接口必需）。 */
function device() {
  section('10. 设备身份 device_id（搜索接口必需）');
  const id = Client.identity();
  check('device_id 为 16 位数字',
    id.deviceId !== null && /^\d{16}$/.test(id.deviceId), id.deviceId);
  check('来源已标记',
    id.source !== null && id.source !== '', id.source);
  check('已注入 base_query',
    Client.baseQuery().device_id === id.deviceId, '');
  // upstream.base_query / session_headers 的注释键（_说明）不得泄漏
  let noUnderscoreQ = true;
  for (const k of Object.keys(Client.baseQuery())) {
    if (k.startsWith('_')) noUnderscoreQ = false;
  }
  check('base_query 无注释键泄漏', noUnderscoreQ, '');
  let noUnderscoreH = true;
  for (const k of Object.keys(Client.sessionHeaders())) {
    if (k.startsWith('_')) noUnderscoreH = false;
  }
  check('session_headers 无注释键泄漏', noUnderscoreH, '');
  check('device_id 已写入 apikeys.json（单例）',
    KeyStore.store().deviceId() === id.deviceId,
    id.source);
  try {
    const ksFile = KeyStore.store().storeFile();
    const raw = fs.existsSync(ksFile) ? fs.readFileSync(ksFile, 'utf8') : '';
    check('apikeys.json 文件内容含 device_id', raw.includes(id.deviceId), '');
  } catch (e) {
    check('apikeys.json 文件内容含 device_id', false, String(e.message));
  }

  const iid = Client.baseQuery().iid;
  check('iid 保持 0（随机 iid 会触发风控）',
    iid === null || iid === undefined || String(iid) === '0',
    iid === null || iid === undefined ? 'null' : String(iid));
}

/** 11. 本地纯代码签名。 */
function pureSign() {
  section('11. 本地纯代码签名（PureSign）');
  const base = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/'
    + '?aid=8662&device_id=1234567890123456&version_code=71532'
    + '&version_name=7.1.5.32&device_type=SM-N9860';
  const url = base + '&_rticket=1700000000000';
  const body = Buffer.from('{"biz_param":{},"mixed_video_id_map":{"1":["7686715217652223038"]}}', 'utf8');

  const h = PureSign.sign(url, body);
  check('六个签名头齐全', Object.keys(h).length === 6, javaList(Object.keys(h)));
  for (const k of ['x-gorgon', 'x-khronos', 'x-ladon', 'x-argus', 'x-helios', 'x-medusa']) {
    check('含 ' + k, h[k] !== null && h[k] !== undefined && h[k] !== '', '');
  }

  const khronos = 1700000000;
  const h2 = PureSign.sign(url, body, khronos);
  check('x-khronos 与指定时间戳一致',
    String(khronos) === h2['x-khronos'], '' + h2['x-khronos']);

  const h3 = PureSign.sign(url, null);
  check('无 body 也可签名', Object.keys(h3).length === 6, javaList(Object.keys(h3)));

  const branches = [0, 0, 0];
  let safe = 0;
  for (let off = 0; off < 32; off++) {
    const b = PureSign.branchOf(base + '&_rticket=' + (1700000000000 + off), body, khronos);
    if (b >= 0 && b <= 2) branches[b]++;
    if (b !== 1) safe++;
  }
  check('branchOf 取值在 0/1/2', branches[0] + branches[1] + branches[2] === 32,
    'b0=' + branches[0] + ' b1=' + branches[1] + ' b2=' + branches[2]);
  check('32 个 _rticket 中可避开 branch==1', safe > 0, 'safe=' + safe + '/32');
}

/** 11b. v5 播放签名（Android v04.10.03）：对齐上游独立 SDK 向量。 */
function v5Sign() {
  section('11b. v5 播放签名（Android v04.10.03）');

  // 向量来自 N3urda/hongguoTV 18c37c2 core/src/test/resources/signing-v5-f13.json，
  // 由独立 SDK 计算，覆盖 4 种时间戳末两位（决定 S 盒选段）。
  const F13 = [
    {"ts": 1800000000, "query": "97f67a81cea547c71c76702cc529330762c14971d85f3c335467579d1e9c15e3", "body": "0ff85a33ee8c8aa4f59a843d5199909f", "digest": "ca03ec7a0c2444b3dcccf33453d02579"},
    {"ts": 1800000001, "query": "959b0479339d92d4ab2c428cff3daa0349a78072e56115d2fd8181ef00ef722d", "body": "49783eb0095375c17655cdc1ff329874", "digest": "a1376d7977abbc1dbc536aae0429ac2c"},
    {"ts": 1800000002, "query": "37c02962735148636add7f1430394e36013faedcd015f1c5519773153b0efc81", "body": "c9ee9a33be57c4125ee742ee67f68cff", "digest": "acadd6dc830f1d3249c77c86d1a03ab7"},
    {"ts": 1800000003, "query": "1ec50c23a9d19b673a4b7037cc51f20b594f04d37234da13b52321f5fd1c7a18", "body": "fcd833cf4fa23db062ea04a99de1f6f1", "digest": "7f18dac9add0b303bc6fdd4bfd181b39"}
  ];
  let f13Ok = 0;
  for (const v of F13) {
    const got = PureSign.hashF13V5(Buffer.from(v.query, 'hex'), Buffer.from(v.body, 'hex'),
      Crypto.le32 ? Crypto.le32(v.ts) : le32Of(v.ts), v.ts);
    if (got.subarray(0, 16).toString('hex') === v.digest
        && got.length === 20 && (got[16] & 0x24) === 0x24) f13Ok++;
  }
  check('hashF13 v5 摘要对齐上游向量', f13Ok === F13.length, f13Ok + '/' + F13.length);
  check('hashF13 v5 输出 20 字节且校验和置 bit5', f13Ok === F13.length, '');

  // 载体向量：v5 AesV3 的 S 盒/换位/初始常量换版后仍须逐字节一致
  const CAR = [
    {"ts": 1800000000, "source": "13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a6f94b9de03284d7297bce1062b50759abfe4092e53789dc2e70c31567ba0c5ea0f34597ea3c8ed12375c81a6cbf0153a5f84a9cef3183d6287acd1f61b40658aafd4f91e43688db2d7fc21466b90b5daff24496e93b8dd02274c7196bbe0052a4f7499bee3082d52779cc1e60b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f6489aed3f81d42678cb1d6fb20456a8fb4d9fe23486d92b7dc01264b7095badf04294e7398bde2072c51769bc0e50a2f54799ec3e80d32577ca1c6eb10355a7fa4c9ee13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a", "key": "000102030405060708090a0b0c0d0e0f", "iv": "101112131415161718191a1b1c1d1e1f", "encrypted": "0653385d92a3ccf3177b608dbacbf41b3f23a8a5c2f79c4367cb90ddea1b44698fb3f8fd3243ec91b79b002d4a6b14bbdf03084d7293bce1066b70759abb640b2f53589dd2e78c33567ba0c5ea0bb45b7fa3e8e51233dc81a78bf01d2a5f04abceb3383572872cd3f65b406d9aab54f91e436885a2d37c21462b90bddaffa4496ed398dd12234c7196bbe00d3a4bf499bfa3282542779cc1e74b105d7a9bc4eb0e337875b2c36c11365ba0adcaef94395fc3a8cde217bc6387abf0fd1a3b648baf93d81552670cb1d6fb004d6a8fb4dbfe63486d92b7dc03264b5095badf84294e33b8bdf203ac51769bc0ed1a2fd4799fc3c80d2253fca3c6eb10355a7fa4c9ee13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a"},
    {"ts": 1800000001, "source": "13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a6f94b9de03284d7297bce1062b50759abfe4092e53789dc2e70c31567ba0c5ea0f34597ea3c8ed12375c81a6cbf0153a5f84a9cef3183d6287acd1f61b40658aafd4f91e43688db2d7fc21466b90b5daff24496e93b8dd02274c7196bbe0052a4f7499bee3082d52779cc1e60b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f6489aed3f81d42678cb1d6fb20456a8fb4d9fe23486d92b7dc01264b7095badf04294e7398bde2072c51769bc0e50a2f54799ec3e80d32577ca1c6eb10355a7fa4c9ee13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a", "key": "000102030405060708090a0b0c0d0e0f", "iv": "101112131415161718191a1b1c1d1e1f", "encrypted": "7253185592a7ccf3177b408dbacb74193e63a8a5d2f39c4366cb90d5fa1f44698fb3d8fd32476c91b6db00254a6f94bbde0308457293bce3076b707d9abf64092f137895d2e30c33567b80c5fa0f34597fe3e8e51237dc83a68bd0152a5b84abcff3183562832cd3f71b606d8aaf54fb1f03688db2d37c21462bb0bdcaff24496fd3b8d502274c7197bbc0052a4f749bbea3282d52771cc1e60b105d7a9fc4eb0e737875a2c76c11375ba0a5caeb14395e8388c5e217bc6186ebd0fd1a3b648baf93f81d52638cb1d7fb00457a8f34d9ff23686d92b7dc01274b509dbadf84294e3398b5f207ac51779bc0e50a2fd4799fc3c80d3257fca1c7eb10355a7fa4c9ee13385d82a7ccf1163b6085aacff4193e6388add2f71c41668bb0d5fa1f44698eb3d8fd22476c91b6db00254a"}
  ];
  let carOk = 0;
  for (const v of CAR) {
    const got = new PureSign.AesV3(Buffer.from(v.key, 'hex'), v.ts, true)
      .encrypt(Buffer.from(v.source, 'hex'), Buffer.from(v.iv, 'hex')).toString('hex');
    if (got === v.encrypted) carOk++;
  }
  check('AesV3 v5 载体加密对齐上游向量', carOk === CAR.length, carOk + '/' + CAR.length);

  // 播放签名：_rticket 抖动到分支 12、query 不带 ts、只发三个签名头
  const body = Buffer.from('{"biz_param":{},"mixed_video_id_map":{"1004":["7685708510792797209"]},'
    + '"dr_scene":"player"}', 'utf8');
  const values = {
    aid: '8662', app_name: 'novelread', version_code: '74332', version_name: '7.4.3.32',
    channel: 'vivo_8662_64', device_platform: 'android', device_type: 'PGT-AN10',
    os_version: '12', update_version_code: '74332',
    iid: '1234567890123456', cdid: '00000000-0000-4000-8000-000000000000',
    device_id: '1234567890123456',
  };
  const signed = PureSign.signPlaybackV5('https://api5-normal-sinfonlinea.fqnovel.com'
    + '/novel/player/multi_video_model/player/v1', values, body, 1800000000000);
  check('播放签名命中分支 0', PureSign.branchV5(signed.url, body, 1800000000) === 0, '');
  check('播放 query 不含 ts 参数', !/[?&]ts=/.test(signed.url), signed.url.slice(0, 90));
  check('播放 query 保留设备身份',
    signed.url.indexOf('device_id=1234567890123456') > 0, '');
  const keys = Object.keys(signed.headers).sort();
  check('播放只发 khronos/helios/medusa + 体相关头',
    keys.join(',') === 'Content-Type,x-helios,x-khronos,x-medusa,x-ss-stub', keys.join(','));
  check('x-ss-stub 为 body 的 MD5 大写',
    signed.headers['x-ss-stub'] === crypto.createHash('md5').update(body).digest('hex').toUpperCase(), '');
  check('x-khronos 与时间戳一致', signed.headers['x-khronos'] === '1800000000',
    signed.headers['x-khronos']);
  check('x-medusa 非空', typeof signed.headers['x-medusa'] === 'string'
    && signed.headers['x-medusa'].length > 40, '');
}

/** 小端 32 位。 */
function le32Of(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

/** 12. 剧集解析：title 清洗（上游 title 实为简介）。 */
function episodeTitle() {
  section('12. 剧集解析：title 清洗（上游 title 实为简介）');
  const intro = '这是一段很长的本剧简介文字';
  const vd = Json.obj();
  vd.series_intro = intro;
  vd.series_title = '测试剧';
  vd.episode_cnt = 2;
  const vl = Json.arr();

  const e1 = Json.obj();
  e1.vid_index = 1;
  e1.vid = 'v1';
  e1.title = intro;          // 与简介相同 => 应置空
  e1.duration = 100;
  vl.push(e1);

  const e2 = Json.obj();
  e2.vid_index = 2;
  e2.vid = 'v2';
  e2.title = '第 2 集';       // 正常集名 => 应保留
  e2.duration = 120;
  vl.push(e2);

  vd.video_list = vl;
  const r = Client.parseEpisodeDetail('123', vd);
  const eps = Json.optArr(r.episodes);
  check('解析出 2 集', eps.length === 2, '' + eps.length);

  const a1 = Json.optObj(eps[0]);
  const a2 = Json.optObj(eps[1]);
  check('与简介相同的 title 被置空',
    Json.optStr(a1.title, 'x') === '', '');
  check('正常集名保留',
    Json.optStr(a2.title, '') === '第 2 集', '');
  check('meta 标题取 series_title',
    Json.optStr(Json.optObj(r.meta).title, '') === '测试剧', '');
  check('按 index 升序排列',
    Json.optLong(a1.index, 0) === 1 && Json.optLong(a2.index, 0) === 2, '');
}

/** 13. 解码兼容性：默认不转码（直出 HEVC）。 */
function transcode() {
  section('13. 解码兼容性：默认不转码（直出 HEVC）');
  // ffmpeg 路径解析：托管主机常见「不许装系统包」，靠 HG_FFMPEG 指向项目内的静态版
  check('ffmpeg 路径：默认回落 PATH', Stream.resolveFfmpeg('', '') === 'ffmpeg',
    Stream.resolveFfmpeg('', ''));
  check('ffmpeg 路径：HG_FFMPEG 优先',
    Stream.resolveFfmpeg('/opt/bin/ffmpeg', '/pkg/ffmpeg') === '/opt/bin/ffmpeg',
    Stream.resolveFfmpeg('/opt/bin/ffmpeg', '/pkg/ffmpeg'));
  check('ffmpeg 路径：无环境变量时用内置包',
    Stream.resolveFfmpeg('', '/pkg/ffmpeg') === '/pkg/ffmpeg', '');
  check('ffmpeg 可用', Stream.ffmpegAvailable(), '当前：' + Stream.ffmpegBin());
  check('默认关闭转码', !Stream.transcodeEnabled(), '');
  if (Stream.transcodeEnabled()) {
    check('转码时能找到 H.264 编码器',
      Stream.h264EncoderName() !== null, '' + Stream.h264EncoderName());
  } else {
    console.log('  · 转码已关闭（HG_TRANSCODE=1 可开启 HEVC -> H.264）');
  }
}

/** 14. 本地链路密钥。 */
function keyStore() {
  section('14. 本地链路密钥');
  const ks = KeyStore.store();
  ks.ensureBootstrap();
  check('至少一把启用密钥', ks.countEnabled() >= 1, '' + ks.countEnabled());
  const first = ks.firstEnabled();
  check('首把密钥格式为 hg_ 前缀',
    first !== null && first.key.startsWith('hg_'), '');
  check('无效密钥被拒绝', !ks.isValid('hg_nonexistent'), '');
  check('空密钥被拒绝', !ks.isValid(''), '');
  const at1 = ks.ensureAdminToken();
  check('管理口令已生成（64 位 hex）', at1.length === 64, 'len=' + at1.length);
  const ks2 = KeyStore.store();
  check('管理口令持久化到 apikeys.json', at1 === ks2.ensureAdminToken(), '');
}

/** 用字节数组模拟的 HeadReader，扫描 moov。 */
function scanMoov(buf) {
  return Mp4.findMoov((off, len) => {
    if (off < 0 || off + len > buf.length) return null;
    return buf.subarray(off, off + len);
  }, buf.length);
}

/** 返回指定盒类型首字节在数组中的下标（找不到返回 -1）。 */
function indexOfType(hay, type) {
  const needle = Buffer.from(type, 'latin1');
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i - 4;
  }
  return -1;
}

/** 15. moov 定位：尾部 moov（非 faststart）必须能被正确找到。 */
function moovLocator() {
  section('15. moov 定位：尾部 moov 也能找到（流式解密前置）');
  try {
    // 头部形态（faststart）：moov 应在 ftyp 之后立刻出现
    const head = Mp4Fixture.buildMinimalEncryptedMp4();
    const hSpan = scanMoov(head);
    check('头部形态能定位 moov', hSpan !== null,
      hSpan === null ? 'null' : ('start=' + hSpan.start + ' size=' + hSpan.size));
    if (hSpan !== null) {
      check('头部形态 moov 紧跟 ftyp', hSpan.start > 0 && hSpan.start < head.length / 2,
        'start=' + hSpan.start);
    }

    // 尾部形态：moov 在文件末尾
    const tail = Mp4Fixture.buildTailMoovEncryptedMp4();
    const tSpan = scanMoov(tail);
    check('尾部形态能定位 moov', tSpan !== null,
      tSpan === null ? 'null' : ('start=' + tSpan.start + ' size=' + tSpan.size));
    if (tSpan !== null) {
      const mdatEnd = indexOfType(tail, 'mdat');
      check('尾部形态 moov 排在 mdat 之后',
        tSpan.start > mdatEnd,
        'moov@' + tSpan.start + ' > mdat@' + mdatEnd);
      check('moov 末端与文件末端一致',
        tSpan.end() === tail.length,
        tSpan.end() + '==' + tail.length);
    }

    check('头部形态解析出加密轨',
      Mp4.analyzeEncryptedTracks(head).tracks.length > 0, '');
    check('尾部形态解析出加密轨',
      Mp4.analyzeEncryptedTracks(tail).tracks.length > 0, '');

    if (tSpan !== null) {
      const moovBuf = tail.subarray(tSpan.start, tSpan.end());
      const a = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(moovBuf, tSpan.start));
      check('尾部形态 base-offset 视图可解析', a.tracks.length > 0, '');
      if (a.tracks.length > 0) {
        const vt = a.tracks[0];
        let inRange = true;
        for (let i = 0; i < vt.sampleCount; i++) {
          if (vt.offsets[i] < 0 || vt.offsets[i] + vt.sizes[i] > tail.length) {
            inRange = false;
            break;
          }
        }
        check('尾部形态样本偏移落在文件范围内（base 换算正确）', inRange, '');
      }
    }
  } catch (e) {
    check('moov 定位', false, String(e.message));
  }
}

/**
 * 16. 流式解密的内存回归。
 * 核心断言：走 RafStore（随机读写句柄）路径解密后，逐字节结果必须与
 * 整文件 Buffer 路径完全一致 —— 这是流式改造的等价性证明。
 */
function streamingDecrypt() {
  section('16. 流式解密与整文件解密结果一致');
  let tmp = null;
  try {
    const fixture = Mp4Fixture.buildMinimalEncryptedMp4();
    const keyHex = Mp4Fixture.fixtureKeyHex();

    // 基线：整文件 Buffer 路径
    const base = Buffer.from(fixture);
    const a1 = Mp4.analyzeEncryptedTracks(base);
    const vt1 = a1.tracks[0];
    const iv1 = Mp4.verifyVideoIv(base, vt1, keyHex, Mp4.trackBaseIvCandidates(vt1));
    Mp4.decryptTrack(base, vt1, keyHex, iv1);

    // 流式：moov 窗口 + fd 句柄路径
    tmp = path.join(os.tmpdir(), 'hg-stream-' + process.pid + '-' + Date.now() + '.mp4');
    fs.writeFileSync(tmp, fixture);
    {
      const fd = fs.openSync(tmp, 'r+');
      try {
        const store = new Mp4.RafStore(fd, 4096);
        const span = scanMoov(fixture);
        check('流式路径能定位 moov', span !== null, '');
        const moovBuf = fixture.subarray(span.start, span.end());
        const a2 = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(moovBuf, span.start));
        check('流式路径解析出加密轨', a2.tracks.length > 0, '');
        const vt2 = a2.tracks[0];
        check('两种路径样本数一致',
          vt1.sampleCount === vt2.sampleCount,
          vt1.sampleCount + '==' + vt2.sampleCount);
        check('两种路径样本偏移一致',
          arrEq(vt1.offsets, vt2.offsets), '');

        const iv2 = Mp4.verifyVideoIv(store, vt2, keyHex, Mp4.trackBaseIvCandidates(vt2));
        check('流式路径 IV 自证通过', iv1 === iv2, '' + iv2);
        const r2 = Mp4.decryptTrack(store, vt2, keyHex, iv2);
        check('流式路径解密样本数一致', r2.decrypted === vt1.sampleCount,
          r2.decrypted + '/' + r2.total);
      } finally {
        fs.closeSync(fd);
      }
    }
    const streamOut = fs.readFileSync(tmp);

    check('流式解密结果与整文件解密逐字节一致', bufEq(base, streamOut), '');

    let restored = true;
    const plains = Mp4Fixture.plainSamples();
    for (let i = 0; i < plains.length; i++) {
      const off = vt1.offsets[i];
      const size = vt1.sizes[i];
      if (!bufEq(streamOut.subarray(off, off + size), plains[i])) {
        restored = false;
        break;
      }
    }
    check('流式解密逐字节还原夹具明文', restored, '');
  } catch (e) {
    check('流式解密', false, String(e.message));
  } finally {
    if (tmp !== null) {
      try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
    }
  }
}

/** 17. 缓存上限与过期清扫。 */
async function cacheBounds() {
  section('17. 缓存上限与过期清扫');
  try {
    const savedMax = process.env.HG_MEM_CACHE_MAX;
    process.env.HG_MEM_CACHE_MAX = '50';
    // 注意：Safeguards 的上限在模块加载时读取，这里只验证
    // 「写入 + 读取 + 清扫」行为本身，不改配置重载。

    for (let i = 0; i < 100; i++) {
      Safeguards.cacheSet('selftest:k:' + i, 'v' + i, 3600);
    }
    const readable = Safeguards.cacheGet('selftest:k:99') !== null;
    check('缓存写入后可读回', readable, '');

    Safeguards.cacheSet('selftest:expired', 'x', 1);
    await Safeguards.sleep(1100);
    check('过期条目视为 miss（TTL 生效）',
      Safeguards.cacheGet('selftest:expired') === null, '');

    check('后台清扫线程已启动且为 daemon', Safeguards.sweeperActive(), '');

    const w = Safeguards.weigh({});
    check('weigh 对空结构返回合理值', w >= 0 && w < 4096, '' + w);

    if (savedMax === undefined) delete process.env.HG_MEM_CACHE_MAX;
    else process.env.HG_MEM_CACHE_MAX = savedMax;
  } catch (e) {
    check('缓存上限', false, String(e.message));
  }
}

/** 统计目录下的成品文件数（排除 .part/.enc 临时文件）。 */
function countCacheFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.part') && !name.endsWith('.enc')) n++;
  }
  return n;
}

/** 递归删除目录。 */
function deleteTree(dir) {
  if (dir === null || dir === undefined) return;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isDirectory()) deleteTree(p);
        else fs.unlinkSync(p);
      } catch (e) { /* 忽略 */ }
    }
    fs.rmdirSync(dir);
  } catch (e) { /* 忽略 */ }
}

/** 18. stream-cache 数量上限（超出按修改时间淘汰最旧）。 */
function streamCacheLimit() {
  section('18. stream-cache 数量上限（超出按修改时间淘汰最旧）');
  let tmp = null;
  try {
    check('上限配置键已登记（runtime.cache.max_files）',
      Config.keys().includes('runtime.cache.max_files'), '');

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-prune-'));
    const savedDir = process.env.HONGGUO_STREAM_CACHE;
    const savedMax = process.env.HONGGUO_CACHE_MAX_FILES;
    process.env.HONGGUO_STREAM_CACHE = tmp;

    const base = 1700000000000;

    const made = [];
    for (let i = 0; i < 5; i++) {
      const p = path.join(tmp, 'v' + i + '_best.play.mp4');
      fs.writeFileSync(p, Buffer.from('x'));
      const t = (base + i * 60000) / 1000;
      fs.utimesSync(p, t, t);
      made.push(p);
    }

    process.env.HONGGUO_CACHE_MAX_FILES = '3';
    const del = Stream.pruneCache();
    check('超出上限时删除最旧文件', del === 2, '删除 ' + del + ' 个');
    check('最旧的 v0 已删除', !fs.existsSync(made[0]), '');
    check('最旧的 v1 已删除', !fs.existsSync(made[1]), '');
    check('最新 3 个被保留',
      fs.existsSync(made[2]) && fs.existsSync(made[3]) && fs.existsSync(made[4]), '');
    check('清理后数量等于上限',
      countCacheFiles(tmp) === 3, '' + countCacheFiles(tmp));

    const part = path.join(tmp, 'zz_download.part');
    const enc = path.join(tmp, 'zz_ct.enc');
    fs.writeFileSync(part, Buffer.from('x'));
    fs.writeFileSync(enc, Buffer.from('x'));
    const oldT = (base - 999999) / 1000;
    fs.utimesSync(part, oldT, oldT);
    fs.utimesSync(enc, oldT, oldT);
    Stream.pruneCache();
    check('下载临时文件 .part 不被删除', fs.existsSync(part), '');
    check('密文临时文件 .enc 不被删除', fs.existsSync(enc), '');

    process.env.HONGGUO_CACHE_MAX_FILES = '5';
    let tmp2 = null;
    try {
      tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-prune2-'));
      for (let i = 0; i < 5; i++) {
        const p = path.join(tmp2, 'k' + i + '_best.play.mp4');
        fs.writeFileSync(p, Buffer.from('x'));
        const t = (base + i * 60000) / 1000;
        fs.utimesSync(p, t, t);
      }
      const d2 = Stream.pruneCache(5);
      check('恰好等于上限时不删除', d2 === 0, '删除 ' + d2 + ' 个');
    } finally {
      deleteTree(tmp2);
    }

    check('上限设为 0 时不清理', Stream.pruneCache(0) === 0, '');
    check('上限设为负数时不清理', Stream.pruneCache(-1) === 0, '');

    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-prune3-'));
    const savedDir3 = process.env.HONGGUO_STREAM_CACHE;
    process.env.HONGGUO_STREAM_CACHE = tmp3;
    check('空目录清理不报错', Stream.pruneCache() === 0, '');
    process.env.HONGGUO_STREAM_CACHE = path.join(tmp3, 'nope');
    check('目录不存在时不报错', Stream.pruneCache() === 0, '');
    process.env.HONGGUO_STREAM_CACHE = savedDir3;
    deleteTree(tmp3);

    if (savedDir === undefined) delete process.env.HONGGUO_STREAM_CACHE;
    else process.env.HONGGUO_STREAM_CACHE = savedDir;
    if (savedMax === undefined) delete process.env.HONGGUO_CACHE_MAX_FILES;
    else process.env.HONGGUO_CACHE_MAX_FILES = savedMax;
  } catch (e) {
    check('stream-cache 数量上限', false, String(e.message));
  } finally {
    if (tmp !== null) deleteTree(tmp);
  }
}

/** 18b. 滚动窗口：只保留本集 + 后两集，窗口外旧缓存被顶替。 */
function cacheWindow() {
  section('18b. 缓存滚动窗口（只留本集 + 后两集）');
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-window-'));
    const savedDir = process.env.HONGGUO_STREAM_CACHE;
    process.env.HONGGUO_STREAM_CACHE = tmp;
    const old = new Date(Date.now() - 120000).toISOString();

    // 造 5 集缓存：v1..v5，每集一个成品；v0 是正在下载中的临时文件
    for (let i = 1; i <= 5; i++) {
      const p = path.join(tmp, 'v' + i + '_best.play.mp4');
      fs.writeFileSync(p, Buffer.alloc(1024, i));
      fs.utimesSync(p, new Date(old), new Date(old));
    }
    const part = path.join(tmp, 'v0_best.part');
    fs.writeFileSync(part, Buffer.from('x'));

    const r = Stream.keepWindow(['v3', 'v4', 'v5'], 1000);
    check('窗口内三集被保留', r.kept === 3, '保留 ' + r.kept);
    check('窗口外旧缓存被删（本集+后两集顶替）', r.deleted === 2, '删除 ' + r.deleted);
    check('释放字节数已统计', r.freed === 2048, '释放 ' + r.freed);
    check('窗口外的 v1 已删除', !fs.existsSync(path.join(tmp, 'v1_best.play.mp4')), '');
    check('窗口内的 v3 仍在', fs.existsSync(path.join(tmp, 'v3_best.play.mp4')), '');
    check('下载中的 .part 不被窗口清理删除', fs.existsSync(part), '');

    // 刚落盘的窗口外文件受保护：浏览器可能还没读完，晚一轮再收
    const fresh = path.join(tmp, 'v9_best.play.mp4');
    fs.writeFileSync(fresh, Buffer.from('y'));
    const r2 = Stream.keepWindow(['v3', 'v4', 'v5'], 20000);
    check('刚写入的窗口外文件本轮不删', fs.existsSync(fresh), '');
    const r3 = Stream.keepWindow(['v3', 'v4', 'v5'], 0);
    check('保护窗口设为 0 后旧文件被删', !fs.existsSync(fresh) && r3.deleted === 1, '删除 ' + r3.deleted);

    const r4 = Stream.keepWindow([], 0);
    check('空窗口不做任何删除', r4.deleted === 0, '');
    if (savedDir === undefined) delete process.env.HONGGUO_STREAM_CACHE;
    else process.env.HONGGUO_STREAM_CACHE = savedDir;
  } catch (e) {
    check('缓存滚动窗口', false, String(e.message));
  } finally {
    if (tmp !== null) deleteTree(tmp);
  }
}

/**
 * 19. 搜索分页切片（skip 必须真正生效）。
 * 背景：searchPage 原先完全忽略 skip，每次都从上游第一页抓、
 * 返回同一批前 limit 条。这里直接验证 Page.slice 的切片与 has_more 判据。
 */
function searchPageSlice() {
  section('19. 搜索分页切片（skip 生效且 has_more 判据正确）');
  const all = [];
  for (let i = 0; i < 75; i++) all.push('item' + i);

  const p1 = Client.Page.slice(all, 0, 30, true);
  check('首屏返回 30 条', p1.items.length === 30, '' + p1.items.length);
  check('首屏为第 0..29 条', p1.items[0] === 'item0' && p1.items[29] === 'item29', '');
  check('首屏 nextSkip=30', p1.nextSkip === 30, '' + p1.nextSkip);
  check('上游有后续时 has_more=true', p1.hasMore, '');

  const p2 = Client.Page.slice(all, 30, 30, true);
  check('续页返回 30 条', p2.items.length === 30, '' + p2.items.length);
  check('续页从 item30 开始', p2.items[0] === 'item30', '');
  let overlap = false;
  for (const a of p1.items) for (const b of p2.items) if (a === b) overlap = true;
  check('续页与首页无重复条目', !overlap, overlap ? '存在重复' : '');
  check('续页 nextSkip=60', p2.nextSkip === 60, '' + p2.nextSkip);
  check('续页 has_more=true', p2.hasMore, '');

  const p3 = Client.Page.slice(all, 60, 30, true);
  check('第 3 页返回剩余 15 条', p3.items.length === 15, '' + p3.items.length);
  check('第 3 页从 item60 开始', p3.items[0] === 'item60', '');
  check('末页 has_more=false（攒不满即到末尾）', !p3.hasMore, '');
  check('末页 nextSkip=75', p3.nextSkip === 75, '' + p3.nextSkip);

  const p4 = Client.Page.slice(all, 0, 30, false);
  check('上游 has_more=false 时不谎报有更多', !p4.hasMore, '');

  const p5 = Client.Page.slice(all, 99, 30, true);
  check('skip 越界返回空列表', p5.items.length === 0, '' + p5.items.length);
  check('skip 越界 has_more=false', !p5.hasMore, '');

  const p6 = Client.Page.slice([], 0, 30, true);
  check('空结果返回空列表', p6.items.length === 0, '');
  check('空结果 has_more=false', !p6.hasMore, '');
  const p7 = Client.Page.slice(null, 0, 30, true);
  check('null 结果不抛异常', p7.items.length === 0 && !p7.hasMore, '');
}

/** 20. App 取址链路：v5 query 参数、URL 编码、URL 白名单。 */
function appSource() {
  section('20. App 取址链路：v5 query / URL 编码 / URL 白名单');

  check('javaUrlEncode: * 编码为 %2A',
    PureSign.javaUrlEncode('1280*2772') === '1280%2A2772',
    PureSign.javaUrlEncode('1280*2772'));
  check("javaUrlEncode: !'()* 全部转义",
    PureSign.javaUrlEncode("a!b'c(d)e*f") === 'a%21b%27c%28d%29e%2Af',
    PureSign.javaUrlEncode("a!b'c(d)e*f"));
  check('javaUrlEncode: 字母数字与 .-_~ 原样',
    PureSign.javaUrlEncode('novelread-7.4.3_32~x') === 'novelread-7.4.3_32~x',
    PureSign.javaUrlEncode('novelread-7.4.3_32~x'));
  check('javaUrlEncode: 空格编码为 %20',
    PureSign.javaUrlEncode('a b') === 'a%20b', PureSign.javaUrlEncode('a b'));

  const q = AppSource.PLAYBACK_QUERY;
  check('v5 query: aid=8662', q.aid === '8662', q.aid);
  check('v5 query: version_name=7.4.3.32', q.version_name === '7.4.3.32', q.version_name);
  check('v5 query: device_type=PGT-AN10', q.device_type === 'PGT-AN10', q.device_type);
  check('v5 query: os_version=12', q.os_version === '12', q.os_version);
  check('v5 query: channel=vivo_8662_64', q.channel === 'vivo_8662_64', q.channel);
  check('v5 query: 不带 ts（由签名器写 _rticket）', q.ts === undefined, String(q.ts));
  check('v5 接口走 player/v1 路径（兜底）',
    AppSource.VIDEO_API.endsWith('/multi_video_model/player/v1'), AppSource.VIDEO_API);
  check('主取址走 GET video_tab 路径',
    AppSource.VIDEO_TAB_API.endsWith('/reading/bookapi/video_tab/multi_video_model/v1/'),
    AppSource.VIDEO_TAB_API);
  check('GET 取址 UA 版本与设备注册一致（73932）',
    AppSource.VIDEO_TAB_UA.indexOf('/73932') > 0, AppSource.VIDEO_TAB_UA);
  check('GET 取址使用 video_tab 专用 UA（25053RT47C）',
    AppSource.VIDEO_TAB_UA.indexOf('25053RT47C') > 0, AppSource.VIDEO_TAB_UA);
  check('备用取址域名为 b（0.16.13 兼容档重查）',
    AppSource.VIDEO_API_HOST_ALT === 'api5-normal-sinfonlineb.fqnovel.com',
    AppSource.VIDEO_API_HOST_ALT);
  check('未启用官网低清兜底', AppSource.webPlayInfo === undefined, '已移除');

  // 选流：上游 quality_desc 与真实分辨率不一致时不能整集报错。
  // 实测有整部剧所有档短边最高 720，却把其中一档标成 1080p；
  // 旧实现按「短边 >= 请求值」硬过滤会把档位筛空，前端只能退回 360P 外链。
  const rows = [
    { quality: '540p', codec: 'bytevc1', codecRank: 1, shortSide: 540, pixels: 540 },
    { quality: '720p', codec: 'bytevc1', codecRank: 1, shortSide: 720, pixels: 720 },
    { quality: '1080p', codec: 'bytevc1', codecRank: 1, shortSide: 720, pixels: 1080 },
    { quality: '360p', codec: 'bytevc1', codecRank: 1, shortSide: 360, pixels: 360 },
    { quality: 'av1', codec: 'av1', codecRank: 2, shortSide: 1080, pixels: 1080 },
  ];
  const pick = (q) => AppSource.selectRows(rows, q);
  check('选流: 请求 1080p 但无 1080 档时降级而非报错',
    pick('1080p').length > 0 && pick('1080p')[0].shortSide === 720,
    pick('1080p').map((r) => r.quality).join(','));
  check('选流: 短边相同时优先标签更高的一档',
    pick('1080p')[0].quality === '1080p', pick('1080p')[0].quality);
  check('选流: 请求超出上限时退到最高档',
    pick('2160p')[0].quality === '1080p', pick('2160p')[0].quality);
  check('选流: 请求 360p 时优先最小可用档',
    pick('360p')[0].quality === '360p', pick('360p')[0].quality);
  check('选流: best 仍按像素优先',
    pick('best')[0].quality === '1080p', pick('best')[0].quality);
  check('选流: 剔除 AV1 等不可解编码',
    pick('best').every((r) => r.codecRank < 2), pick('best').length + ' 档');
  check('选流: 只有不可解编码时返回空（由调用方报错）',
    AppSource.selectRows([rows[4]], 'best').length === 0, '');
  // bytevc2 兼容：同剧编码不统一，全档 bytevc2 时须走 fallback 拿 h265
  check('bytevc2 判定: 全 bytevc2/bvc2 视为需兼容',
    AppSource.allBytevc2([{ codec: 'bytevc2', codecRank: 2 }, { codec: 'bvc2', codecRank: 2 }]), '');
  check('bytevc2 判定: 混合 h265 档不触发兼容',
    !AppSource.allBytevc2([{ codec: 'bytevc2', codecRank: 2 }, { codec: 'h265', codecRank: 1 }]), '');
  check('bytevc2 判定: 正常 bytevc1 不触发兼容',
    !AppSource.allBytevc2([{ codec: 'bytevc1', codecRank: 1 }]), '');
  check('bytevc2 判定: 空档位不触发兼容', AppSource.allBytevc2([]) === false, '');

  // 候选直链：上游给的是 backup_url_1/2…，旧实现只找 backup_url，等于丢了备用节点
  const cands = AppSource.urlCandidates({
    main_url: 'M', backup_url: 'B', backup_url_1: 'B1', backup_url_2: 'B2',
    backup_url_list: ['L0', 'L1'], size: 1,
  });
  check('候选直链: 读取 backup_url_N', cands.indexOf('B1') >= 0 && cands.indexOf('B2') >= 0,
    cands.join(','));
  check('候选直链: main 排第一', cands[0] === 'M', cands[0]);
  check('候选直链: 兼容 backup_url 与列表', cands.length === 6, cands.length + ' 条');

  try {
    const u = AppSource.checkedUrl('https://p3.qznovelvod.com/a/b.mp4', AppSource.VOD_DOMAINS);
    check('checkedUrl: 白名单子域放行', u.startsWith('https://'), u);
  } catch (e) {
    check('checkedUrl: 白名单子域放行', false, String(e.message));
  }
  try {
    AppSource.checkedUrl('http://qznovelvod.com/a.mp4', AppSource.VOD_DOMAINS);
    check('checkedUrl: http 被拒绝', false, '未拒绝');
  } catch (expected) {
    check('checkedUrl: http 被拒绝', true, '');
  }
  try {
    AppSource.checkedUrl('https://evil.example/a.mp4', AppSource.VOD_DOMAINS);
    check('checkedUrl: 白名单外被拒绝', false, '未拒绝');
  } catch (expected) {
    check('checkedUrl: 白名单外被拒绝', true, '');
  }

  check('cleanUrl: 转义还原',
    AppSource.cleanUrl('https:\\/\\/x.com\\u0026a.mp4') === 'https://x.com&a.mp4', '');
  check('pixelsOf: 取第一组数字', AppSource.pixelsOf('1080p 高清') === 1080, '');
  check('pixelsOf: 无数字返回 0', AppSource.pixelsOf('蓝光') === 0, '');
  try {
    AppSource.decryptSpadeUrl('bm90LWEtc3BhZGUtdXJs', Buffer.alloc(32));
    check('decryptSpadeUrl: 非法布局被拒绝', false, '未拒绝');
  } catch (expected) {
    check('decryptSpadeUrl: 非法布局被拒绝', true, '');
  }
}

// ==================== CENC 减壳用例辅助 ====================

function u32At(b, p) { return b.readUInt32BE(p); }

function u64At(b, p) { return Number(b.readBigUInt64BE(p)); }

function putU32At(b, p, v) { b.writeUInt32BE(Number(BigInt.asUintN(32, BigInt(v))), p); }

function putU64At(b, p, v) { b.writeBigUInt64BE(BigInt.asUintN(64, BigInt(v)), p); }

/**
 * 从盒树中删除指定类型的第一个盒，并同步修补祖先链尺寸（自底向上）。
 * 删盒让 moov 缩小、mdat 前移，stco 的 chunk 偏移同步 -size。
 */
function dropBox(enc, type) {
  const pos = indexOfType(enc, type);
  if (pos < 0) return null;
  const size = u32At(enc, pos);
  const chain = [];
  if (!findAncestors(Mp4.parseBoxes(enc, 0, enc.length), enc, pos, chain)) return null;
  const out = Buffer.concat([enc.subarray(0, pos), enc.subarray(pos + size)]);
  for (const b of chain) {
    putU32At(out, b.start, u32At(out, b.start) - size);
  }
  const stcoPos = indexOfType(enc, 'stco');
  if (stcoPos >= 0) {
    const outStco = stcoPos > pos ? stcoPos - size : stcoPos;
    putU32At(out, outStco + 16, u32At(enc, stcoPos + 16) - size);
  }
  return out;
}

/** 把夹具里的 stco 盒替换为等义 co64 盒（32 位偏移 -> 64 位）。 */
function toCo64(enc) {
  const stcoPos = indexOfType(enc, 'stco');
  if (stcoPos < 0) return null;
  const oldSize = u32At(enc, stcoPos);
  const count = u32At(enc, stcoPos + 12);
  const newSize = 8 + 4 + 4 + 8 * count;
  const grow = newSize - oldSize;
  const out = Buffer.alloc(enc.length + grow);
  enc.copy(out, 0, 0, stcoPos);
  putU32At(out, stcoPos, newSize);
  out.write('co64', stcoPos + 4, 4, 'latin1');
  enc.copy(out, stcoPos + 8, stcoPos + 8, stcoPos + 16); // v/f + count 原样
  for (let i = 0; i < count; i++) {
    const v = u32At(enc, stcoPos + 16 + 4 * i);
    putU64At(out, stcoPos + 16 + 8 * i, v + grow);
  }
  enc.copy(out, stcoPos + newSize, stcoPos + oldSize, enc.length);
  const chain = [];
  if (!findAncestors(Mp4.parseBoxes(enc, 0, enc.length), enc, stcoPos, chain)) return null;
  for (const b of chain) {
    putU32At(out, b.start, u32At(out, b.start) + grow);
  }
  return out;
}

/**
 * 收集盒 pos 的严格祖先链（命中目标即停，目标自身不入链；自底向上）。
 */
function findAncestors(boxes, enc, pos, chain) {
  for (const b of boxes) {
    if (b.start === pos) return true;
    if (pos <= b.start || pos >= b.end()) continue;
    let kids = b.children;
    let inner = -1;
    if (b.type === 'encv') inner = b.start + 8 + 78;
    else if (b.type === 'enca') inner = b.start + 8 + 28;
    else if (b.type === 'sinf') inner = b.start + 8;
    if (kids.length === 0 && inner >= 0) {
      kids = Mp4.parseBoxes(enc, inner, b.end());
    }
    if (findAncestors(kids, enc, pos, chain)) {
      chain.push(b);
      return true;
    }
  }
  return false;
}

/** 21. CENC 信令纯 JS 减壳（默认播放路径，不依赖 ffmpeg）。 */
function cencStrip() {
  section('21. CENC 信令纯 JS 减壳（sinf/senc 移除、stco 平移、mdat 原样）');
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-strip-'));
    const enc = Mp4Fixture.buildMinimalEncryptedMp4();
    const inPath = path.join(tmp, 'in.mp4');
    fs.writeFileSync(inPath, enc);

    const sinfPos = indexOfType(enc, 'sinf');
    const sencPos = indexOfType(enc, 'senc');
    check('夹具含 sinf 与 senc', sinfPos >= 0 && sencPos >= 0,
      'sinf@' + sinfPos + ' senc@' + sencPos);
    if (sinfPos < 0 || sencPos < 0) return;
    const delta = u32At(enc, sinfPos) + u32At(enc, sencPos);
    check('信令尺寸非零', delta > 0, 'delta=' + delta);

    const stcoPos = indexOfType(enc, 'stco');
    const mdatPos = indexOfType(enc, 'mdat');
    const oldChunk = u32At(enc, stcoPos + 16);
    const oldMdatPayload = mdatPos + 8;

    const outp = path.join(tmp, 'out.mp4');
    check('头部形态减壳成功', Mp4.stripEncryption(inPath, outp), '');
    if (!fs.existsSync(outp)) return;
    const outBytes = fs.readFileSync(outp);

    check('输出尺寸 = 原尺寸 - 信令字节',
      outBytes.length === enc.length - delta,
      outBytes.length + ' vs ' + (enc.length - delta));

    const newMdatPos = indexOfType(outBytes, 'mdat');
    check('输出仍含 mdat', newMdatPos >= 0, '@' + newMdatPos);
    if (newMdatPos >= 0) {
      const newMdatPayload = newMdatPos + 8;
      let same = outBytes.length - newMdatPayload === enc.length - oldMdatPayload;
      if (same) {
        for (let i = 0; i < enc.length - oldMdatPayload; i++) {
          if (outBytes[newMdatPayload + i] !== enc[oldMdatPayload + i]) {
            same = false;
            break;
          }
        }
      }
      check('mdat 负载逐字节一致', same, '');
    }

    const newStcoPos = indexOfType(outBytes, 'stco');
    const newChunk = u32At(outBytes, newStcoPos + 16);
    check('stco 偏移平移量正确', newChunk === oldChunk - delta,
      newChunk + ' vs ' + (oldChunk - delta));
    if (newMdatPos >= 0) {
      check('stco 指向新 mdat 负载起点',
        newChunk === newMdatPos + 8,
        newChunk + ' vs ' + (newMdatPos + 8));
    }

    const top = Mp4.parseBoxes(outBytes, 0, outBytes.length);
    let moov = null;
    for (const b of top) {
      if (b.type === 'moov') { moov = b; break; }
    }
    check('输出盒链完整（末盒为 mdat 且收尾）',
      top.length > 0 && top[top.length - 1].type === 'mdat'
        && top[top.length - 1].end() === outBytes.length
        && moov !== null, '');
    if (moov !== null) {
      let clean = true;
      let entryType = null;
      for (const trak of moov.children) {
        if (trak.type !== 'trak') continue;
        const mdia = trak.child('mdia');
        const stbl = mdia === null ? null
          : (mdia.child('minf') === null ? null : mdia.child('minf').child('stbl'));
        if (stbl === null) continue;
        if (stbl.child('senc') !== null) clean = false;
        const stsd = stbl.child('stsd');
        if (stsd !== null) {
          for (const e of stsd.children) {
            entryType = e.type;
            const kids = Mp4.parseBoxes(outBytes, e.start + 8 + 78, e.end());
            for (const c of kids) {
              if (c.type === 'sinf') clean = false;
            }
          }
        }
      }
      check('sinf 与 senc 已除净', clean, '');
      check('条目类型改回 hvc1', entryType === 'hvc1', String(entryType));
    }

    const tailIn = path.join(tmp, 'tail.mp4');
    fs.writeFileSync(tailIn, Mp4Fixture.buildTailMoovEncryptedMp4());
    const tailOut = path.join(tmp, 'tail-out.mp4');
    check('尾部 moov 形态被拒（回落 ffmpeg）', !Mp4.stripEncryption(tailIn, tailOut), '');

    const junkIn = path.join(tmp, 'junk.mp4');
    const junk = Buffer.alloc(512);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 31) & 0xff;
    fs.writeFileSync(junkIn, junk);
    const junkOut = path.join(tmp, 'junk-out.mp4');
    check('垃圾输入被拒', !Mp4.stripEncryption(junkIn, junkOut), '');
    check('垃圾输入不产生输出', !fs.existsSync(junkOut), '');

    const big = toCo64(enc);
    if (big !== null) {
      const bigIn = path.join(tmp, 'co64.mp4');
      fs.writeFileSync(bigIn, big);
      const bigOut = path.join(tmp, 'co64-out.mp4');
      check('co64 形态减壳成功', Mp4.stripEncryption(bigIn, bigOut), '');
      if (fs.existsSync(bigOut)) {
        const bo = fs.readFileSync(bigOut);
        const bStco = indexOfType(bo, 'co64');
        const bChunk = bStco >= 0 ? u64At(bo, bStco + 16) : -1;
        const bMdat = indexOfType(bo, 'mdat');
        check('co64 偏移平移且指向新 mdat',
          bChunk >= 0 && bMdat >= 0 && bChunk === bMdat + 8,
          'chunk=' + bChunk + ' mdat=' + (bMdat + 8));
      }
    }
    const noFrma = dropBox(enc, 'frma');
    if (noFrma !== null) {
      const nfIn = path.join(tmp, 'nofrma.mp4');
      fs.writeFileSync(nfIn, noFrma);
      const nfOut = path.join(tmp, 'nofrma-out.mp4');
      check('无 frma 时减壳成功（子盒推断）', Mp4.stripEncryption(nfIn, nfOut), '');
      if (fs.existsSync(nfOut)) {
        const nb = fs.readFileSync(nfOut);
        const nfStsd = indexOfType(nb, 'stsd');
        const nfType = nfStsd >= 0
          ? nb.toString('latin1', nfStsd + 8 + 8 + 4, nfStsd + 8 + 8 + 8)
          : '?';
        check('无 frma 时按 hvcC 推断为 hvc1', nfType === 'hvc1', nfType);
      }
    }
  } catch (e) {
    check('CENC 减壳', false, String(e.message));
  } finally {
    if (tmp !== null) deleteTree(tmp);
  }
}

/**
 * 22. 多连接分块下载。
 *
 * 背景：跨境/高延迟线路上红果 CDN 单连接只有 0.3~0.6MB/s，改成 Range 并发
 * 分块后通常能翻几倍。这里用本地 HTTP 服务模拟两种服务端（支持 / 忽略 Range），
 * 验证「内容逐字节一致」和「不支持 Range 时自动回退」，不依赖外网。
 */
async function parallelDownload() {
  section('22. 多连接分块下载（Range 并发 + 无 Range 回退）');
  const http = require('http');
  const Http = require('./util/http');
  const payload = crypto.randomBytes(1024 * 1024 + 12345);
  const tmp = path.join(os.tmpdir(), 'dltest_' + Date.now() + '.bin');

  const mkServer = (supportRange) => http.createServer((req, res) => {
    const range = req.headers.range;
    if (!supportRange || !range) {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] === '' ? payload.length - 1
      : Math.min(Number(m[2]), payload.length - 1);
    res.writeHead(206, {
      'content-range': 'bytes ' + start + '-' + end + '/' + payload.length,
      'content-length': String(end - start + 1),
    });
    res.end(payload.subarray(start, end + 1));
  });

  const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = (server) => new Promise((r) => server.close(r));

  const rangeServer = mkServer(true);
  const plainServer = mkServer(false);
  await listen(rangeServer);
  await listen(plainServer);
  try {
    const a = await Http.sendToFileParallel(
      'http://127.0.0.1:' + rangeServer.address().port + '/f.mp4', tmp,
      { connections: 3, timeoutMs: 20000 });
    check('分块下载：并发连接数生效', a.connections === 3, '×' + a.connections);
    check('分块下载：字节数等于总长度', a.bytes === payload.length,
      a.bytes + '/' + payload.length);
    check('分块下载：内容逐字节一致',
      fs.readFileSync(tmp).equals(payload), '');
    fs.unlinkSync(tmp);

    const b = await Http.sendToFileParallel(
      'http://127.0.0.1:' + plainServer.address().port + '/f.mp4', tmp,
      { connections: 4, timeoutMs: 20000 });
    check('无 Range 支持时回退单连接', b.connections === 1, '×' + b.connections);
    check('无 Range 回退后内容一致', fs.readFileSync(tmp).equals(payload), '');
    fs.unlinkSync(tmp);
  } catch (e) {
    check('多连接分块下载', false, String(e.message));
    try { fs.unlinkSync(tmp); } catch (ignore) { /* 忽略 */ }
  } finally {
    await close(rangeServer);
    await close(plainServer);
  }
}

/**
 * 弹幕：签名黄金向量 + 分页/清洗规则。
 *
 * 黄金向量来自参考实现（nas-backend/danmaku.py），逐字节比对——签名算法没有
 * 文档，这是唯一能证明移植正确的办法。这一组失败时不要联网碰运气，先修签名器。
 */
function danmaku() {
  section('23. 弹幕：签名向量 / 分页解析 / 清洗规则');

  const DanmakuSign = require('./service/danmaku-sign');
  const Danmaku = require('./service/danmaku');
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'core', 'fixtures', 'danmaku-sign-vectors.json'), 'utf8'));
  const vectors = fixture.vectors;

  check('向量来源标注为参考实现', fixture.source === 'nas-backend/danmaku.py',
    String(fixture.source));

  let queryOk = 0;
  let gorgonOk = 0;
  let ladonOk = 0;
  let argusOk = 0;
  for (const v of vectors) {
    const raw = DanmakuSign.buildQuery({
      stampMs: v.stamp_ms, deviceId: v.device_id, installId: v.install_id,
    });
    if (raw === v.raw_query) queryOk += 1;
    const nonce = Buffer.from(v.nonce_hex, 'hex');
    if (DanmakuSign.commentXGorgon(v.raw_query, v.stamp, nonce) === v.x_gorgon) gorgonOk += 1;
    if (DanmakuSign.commentLadon(v.aid, v.stamp, nonce.subarray(2, 6)) === v.x_ladon) ladonOk += 1;
    if (DanmakuSign.commentArgus(v.raw_query, v.stamp, nonce) === v.x_argus) argusOk += 1;
  }
  const total = vectors.length;
  check('raw query 与参考实现一致（键排序 + quote_plus）', queryOk === total,
    queryOk + '/' + total);
  check('X-Gorgon 逐字节一致', gorgonOk === total, gorgonOk + '/' + total);
  check('X-Ladon 逐字节一致', ladonOk === total, ladonOk + '/' + total);
  check('X-Argus 逐字节一致', argusOk === total, argusOk + '/' + total);

  // 防止「把结果写死」的假实现：换 nonce 必须换签名
  const v0 = vectors[0];
  const n0 = Buffer.from(v0.nonce_hex, 'hex');
  const n1 = Buffer.from(n0);
  n1[0] = (n1[0] + 1) & 0xFF;
  check('X-Gorgon 随 nonce 变化',
    DanmakuSign.commentXGorgon(v0.raw_query, v0.stamp, n0)
      !== DanmakuSign.commentXGorgon(v0.raw_query, v0.stamp, n1), '');
  check('X-Khronos 为秒级时间戳', String(v0.stamp) === String(v0.x_khronos), String(v0.x_khronos));
  check('device_id 为 19 位数字串', /^\d{19}$/.test(DanmakuSign.newDeviceId()),
    DanmakuSign.newDeviceId());

  // ---- 分页与清洗 ----
  const page = Danmaku.parsePage({
    data: {
      data_list: [
        { comment: { common: { group_id: '123456', status: '1', content: { text: '好家伙' } }, expand: { offset_time: 1200 } } },
        { comment: { common: { group_id: '123456', status: '2', content: { text: '待审核' } }, expand: { offset_time: 2000 } } },
        { comment: { common: { group_id: '999999', status: '1', content: { text: '别的视频' } }, expand: { offset_time: 3000 } } },
        { comment: { common: { group_id: '123456', status: '1', content: { text: '顶部', color: '#F00' } }, expand: { offset_time: 500, mode: 'top' } } },
      ],
      common_list_info: { has_more: true, cursor: { end_offset_time: 5000 } },
    },
  }, '123456');
  check('只收本视频且 status=1 的弹幕', page.items.length === 2, page.items.length + ' 条');
  check('offset_time 毫秒→秒', Danmaku.toSeconds(1200) === 1.2, String(Danmaku.toSeconds(1200)));
  check('分页取 common_list_info.cursor.end_offset_time', page.nextMs === 5000,
    String(page.nextMs));
  check('has_more=false 时不再翻页',
    Danmaku.parsePage({
      data: { data_list: [], common_list_info: { has_more: false, cursor: { end_offset_time: 9000 } } },
    }, '1').nextMs === null, '');
  check('颜色 #F00 归一为 #FF0000', Danmaku.normalizeColor('#F00') === '#FF0000',
    Danmaku.normalizeColor('#F00'));
  check('颜色缺省为白色', Danmaku.normalizeColor(undefined) === '#FFFFFF', '');
  check('控制字符替换为空格', Danmaku.cleanControl('a\u0001b\nc') === 'a b c',
    JSON.stringify(Danmaku.cleanControl('a\u0001b\nc')));
  check('越界时间戳丢弃', Danmaku.toSeconds(700000000) === null, '');
  check('位置缺省为 scroll', page.items[0].mode === 'scroll', page.items[0].mode);
  check('位置 top 可识别', page.items[1].mode === 'top', page.items[1].mode);
}

// ==================== 入口 ====================
async function run() {
  console.log('');
  console.log('  ============================================');
  console.log('    hongguo-api 自检');
  console.log('  ============================================');

  try {
    spade();
    ctrCounter();
    ivToCounter();
    avcc();
    ctrRoundTrip();
    mp4Boxes();
    decryptEndToEnd();
    json();
    cachePaths();
    device();
    pureSign();
    v5Sign();
    episodeTitle();
    transcode();
    keyStore();
    moovLocator();
    streamingDecrypt();
    await cacheBounds();
    streamCacheLimit();
    cacheWindow();
    searchPageSlice();
    appSource();
    cencStrip();
    danmaku();
    await parallelDownload();
  } catch (e) {
    failed++;
    console.log('  ✗ 自检异常中断：' + e);
    if (e && e.stack) console.log(e.stack);
  }

  section('运行环境');
  console.log('  上游 host     ' + Client.HOST);
  console.log('  App 源 host   ' + AppSource.VIDEO_API_HOST);
  console.log('  设备身份     ' + Client.identity().source
    + '（device_id=' + Client.identity().deviceId + '）');
  console.log('  托管模式     ' + Client.MANAGED);
  console.log('  列表免签     ' + Client.SIGN_LIST);
  console.log('  签名方式     本地纯代码签名（PureSign）');
  console.log('  ffmpeg       ' + Stream.ffmpegAvailable());
  console.log('  转码         ' + Stream.transcodeEnabled()
    + (Stream.transcodeEnabled() ? '（编码器 ' + Stream.h264EncoderName() + '）' : ''));
  console.log('  Node         ' + process.version);

  console.log('');
  const total = passed + failed;
  const verdict = failed === 0 ? ' 全部通过' : '，失败 ' + failed + ' 项';
  console.log('  结果：' + passed + '/' + total + verdict);
  if (skipped > 0) {
    console.log('  跳过 ' + skipped + ' 项（依赖运行态产物，不计入失败）');
  }
  console.log('');
  return failed === 0 ? 0 : 1;
}

module.exports = { run };
