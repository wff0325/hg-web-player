'use strict';
/**
 * 红果 App 接口签名，纯 JS 实现（对应原 Java core/PureSign.java，
 * 不再依赖 unidbg + libmetasec_ml.so）。
 *
 * 移植自 jackotom/hongguo-drama 的 src/native/app-source.js（GPL-3.0），
 * 其签名与 spade 算法改编自 woshishiq1/drpys，经 N3urda/hongguoTV 传递。
 * 原实现用 unidbg 在 x86 上模拟 ARM64 so 计算同样的六个签名头；
 * 此处按同一算法直接计算，字节级对齐：
 *
 *   x-gorgon  : RC4 变体 + 位旋转/位反转后处理
 *   x-khronos : 秒级时间戳
 *   x-ladon   : be32(khronos) 的 base64
 *   x-argus   : le32(khronos) 的 base64
 *   x-helios  : md5 -> 64 位字表 -> 类 Feistel 变换的 base64
 *   x-medusa  : sm3(query) + md5(body) 经 hashF13 分支 -> protobuf 消息
 *               -> xmxor 混淆 -> 逆序 -> 异或 -> AesV3 加密的 base64
 *
 * 用法：sign(url, body) 传入完整 URL（含 query）与请求体，
 * 返回需要合并进请求头的签名字段。
 *
 * 注意：签名对 query 字节级敏感，URL 必须与最终发出的请求完全一致
 * （本模块只读 url 的 '?' 之后部分做 sm3，因此调用方传入什么就签什么）。
 *
 * 移植约定：Java byte[] 为有符号（-128..127），JS 用 Buffer 并在需要处
 * 以 `& 0xff` 取无符号；Java int 的 32 位溢出用 `| 0` 对齐；Java long
 * 的 64 位运算用 BigInt。
 */
const crypto = require('crypto');
const Crypto = require('../util/crypto');
const Log = require('../util/log');
const V5 = require('./v5-constants');

// SM3 由 Node 内置 crypto 提供（依赖 OpenSSL >= 1.1.1，Node >= 18 均满足）；
// 不可用时直接抛错，不做降级——x-medusa 签名链路离开 SM3 无法工作。
if (!crypto.getHashes().includes('sm3')) {
  throw new Error('当前 Node 运行时缺少 SM3 算法支持（需 OpenSSL >= 1.1.1），x-medusa 签名链路无法工作');
}

// ==================== 基础位运算（对齐 JS 的 u32 语义） ====================

function rotl(x, n) {
  const k = n & 31;
  return (((x << k) | (x >>> ((32 - k) & 31)))) | 0;
}

function ror(x, n) {
  const k = n & 31;
  return (((x >>> k) | (x << ((32 - k) & 31)))) | 0;
}

/** 8 位循环左移。 */
function rotl8(x) {
  return ((x << 4) | (x >>> 4)) & 255;
}

/** 8 位循环左移 3 位（xmxor 专用，与 rotl8 的移位数不同）。 */
function rotl8_3(x) {
  return ((x << 3) | (x >>> 5)) & 255;
}

/** 反转一个字节的 8 个位。 */
function reverseBits(value) {
  let r = 0;
  for (let i = 0; i < 8; i++) r = (r << 1) | ((value >> i) & 1);
  return r;
}

function readLe32(b, off) {
  return ((b[off] & 0xff) | ((b[off + 1] & 0xff) << 8)
    | ((b[off + 2] & 0xff) << 16) | ((b[off + 3] & 0xff) << 24)) | 0;
}

function readBe32(b, off) {
  return (((b[off] & 0xff) << 24) | ((b[off + 1] & 0xff) << 16)
    | ((b[off + 2] & 0xff) << 8) | (b[off + 3] & 0xff)) | 0;
}

function putLe32(b, off, v) {
  b[off] = v & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
  b[off + 2] = (v >>> 16) & 0xff;
  b[off + 3] = (v >>> 24) & 0xff;
}

function putBe32(b, off, v) {
  b[off] = (v >>> 24) & 0xff;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

function le32(v) {
  const b = Buffer.alloc(4);
  putLe32(b, 0, v);
  return b;
}

function be32(v) {
  const b = Buffer.alloc(4);
  putBe32(b, 0, v);
  return b;
}

/** 读 64 位小端无符号（对应 Java readU64Le，语义按无符号位型处理）。 */
function readU64Le(b, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i] & 0xff);
  return BigInt.asUintN(64, v);
}

function putU64Be(b, off, v) {
  const x = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) b[off + i] = Number((x >> BigInt(56 - 8 * i)) & 0xffn);
}

function putU64Le(b, off, v) {
  const x = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) b[off + i] = Number((x >> BigInt(8 * i)) & 0xffn);
}

/** 64 位循环右移（对应 Java Long.rotateRight）。 */
function rotr64(x, n) {
  const v = BigInt.asUintN(64, x);
  const k = BigInt(n & 63);
  if (k === 0n) return v;
  return BigInt.asUintN(64, (v >> k) | (v << (64n - k)));
}

function concat(...parts) {
  return Buffer.concat(parts);
}

/** 对应 Java slice(byte[], from, to)：返回同区间字节（此处用视图即可）。 */
function sliceBytes(b, from, to) {
  return b.subarray(from, to);
}

function xorBytes(a, b) {
  const out = Buffer.from(a);
  for (let i = 0; i < out.length; i++) out[i] = out[i] ^ b[i % b.length];
  return out;
}

function md5(data) {
  return Crypto.md5(data);
}

/**
 * body 的 MD5 摘要。
 *
 * 2026-11-23 上游协议更新：GET video_tab 签名改用「空字节摘要」md5(空)
 * = d41d8cd98f00b204e9800998ecf8427e，而不是全零 16 字节。
 * 权威参考 hongguo-drama 92df757 的 signPlaybackV5：
 *   const bodyHash = hasBody ? md5(body) : md5(Buffer.alloc(0));
 * 传全零摘要会被上游判空 data（HTTP 200 + 0 字节）。
 *
 * POST 链路都有 gzip body（length>0），此改动不影响它们。
 */
function bodyMd5Of(body) {
  if (body === null || body === undefined || body.length === 0) return md5(Buffer.alloc(0));
  return md5(body);
}

/** 当前 v5 medusa（openhongguo）对无 body 用 16 个零字节，不是 md5(空)。 */
function bodyMd5V5(body) {
  if (body === null || body === undefined || body.length === 0) return Buffer.alloc(16);
  return md5(body);
}

function sm3(data) {
  return crypto.createHash('sm3').update(data).digest();
}

function b64(data) {
  return data.toString('base64');
}

const EMPTY = Buffer.alloc(0);

// ==================== protobuf 手写编码 ====================

function varint(value) {
  // 仅签路使用非负值（负值一律走 sint 的 zigzag）
  let n = typeof value === 'bigint' ? value : BigInt(value);
  const out = [];
  while (n > 127n) {
    out.push(Number((n & 127n) | 128n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function zigzag(value) {
  return value < 0n ? ((-value) * 2n - 1n) : value * 2n;
}

/** 单个 protobuf 字段。type: string/bytes/message/float/sint/int。 */
function protoField(tag, value, type) {
  if (value === null || value === undefined) return EMPTY;
  if (type === 'string' && value === '') return EMPTY;
  let head;
  let body;
  if (type === 'bytes' || type === 'message') {
    body = value;
    head = concat(varint((BigInt(tag) << 3n) | 2n), varint(body.length));
  } else if (type === 'string') {
    body = Buffer.from(String(value), 'utf8');
    head = concat(varint((BigInt(tag) << 3n) | 2n), varint(body.length));
  } else if (type === 'float') {
    body = Buffer.alloc(4);
    body.writeFloatLE(Number(value), 0);
    head = varint((BigInt(tag) << 3n) | 5n);
  } else {
    const v = BigInt(Math.trunc(Number(value)));
    head = varint(BigInt(tag) << 3n);
    body = varint(type === 'sint' ? zigzag(v) : v);
  }
  return concat(head, body);
}

/** proto([[tag, value, type], ...]) 的紧凑写法。 */
function proto(fields) {
  const parts = [];
  for (const f of fields) {
    const type = f.length > 2 ? String(f[2]) : 'string';
    parts.push(protoField(Number(f[0]), f[1], type));
  }
  return concat(...parts);
}

// ==================== hashF13 家族 ====================

/** getIv：按字节奇偶交替混合的 32 位状态机。 */
function getIv(iv, data) {
  let value = iv;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] & 0xff;
    if ((i & 1) === 0) {
      value = ((value >>> 4) ^ value ^ (value << 6) ^ d) | 0;
    } else {
      value = ~((value >>> 7) ^ value ^ (d | (value << 12)));
    }
  }
  return value;
}

/** sumMd5：取前 12 字节的固定轮混淆，末位或 4 再异或 0x1000000。 */
function sumMd5(data) {
  let check = 0x20220420;
  for (let i = 0; i < 12; i++) {
    const temp = (i & 1) === 0 ? ((check >>> 3) ^ check) : ((check >>> 5) ^ check);
    check = (i & 1) === 0
      ? ((data[i] & 0xff) ^ (check << 7))
      : ((data[i] & 0xff) | (check << 11));
    if ((i & 1) !== 0) check = ~check;
    check = check ^ temp;
  }
  return ((check | 4) ^ 0x1000000) | 0;
}

const BRANCH2_SV = [
  0xa7aefe20, 0x7149f1d6, 0x47e4ca07, 0xe9b58f67, 0x93b924de, 0xc614d0f5, 0x38afe0ef, 0xb2bbad73,
  0xe24444c3, 0x9d3aec9b, 0xdf7b37e4, 0xd8b16d40, 0xf8ac31b8, 0x76b9a90b, 0x31d833ee, 0x953fce64,
  0x353595a4, 0x4609c13b, 0x36925008, 0x8c6d0925, 0x5df5c177, 0x1cfbf52b, 0x8a4fa7f0, 0x114ca35e,
  0x8193f984, 0x7a7a8733, 0x316ab4d5, 0x3c20cfc9, 0xa6d84453, 0x3a18500c, 0x798ec47a, 0x97a76b28,
  0x66c4ff96, 0x51716443, 0x0dd2fc3b, 0xb5696da7, 0xbbeb3ac5, 0x5c53d204, 0xd32608ce, 0x7279b9ec,
  0xf4188ecf, 0xf7d793db, 0x332cc491, 0xab76ae15, 0x9bebe727, 0x18a01384, 0x5be9f8a7, 0x5f90a754,
  0x39b663c0, 0x36673c83, 0x7c92f514, 0x9d7d94d7, 0xe2e8d9aa, 0x5f7e9ea9, 0x7abd4551, 0x569e05da,
  0x40a25632, 0x3df5a9a5, 0xbab37d80, 0x454286dc, 0x3f5d4e78, 0x03d7b75d, 0xb1fe4af7, 0xa5ab26a3];

const BRANCH2_ORDERS = Crypto.unhex(
  '0f0704000908030a060b050d0e010c02'
  + '0f05080c0009020103070e060b0a0d04'
  + '060500070c000a04080f010b0d09020e'
  + '060b02050403080101070a000d0c090e'
  + '0d070e0f0b0208030c0509010004060a'
  + '0d0902060f0b0a040807000c0503010e'
  + '0c090f07060f030e020d0405010b0a00'
  + '0c050a090e0802040407030f01060b00'
  + '0b0f0408020a0700090d06010e03050c'
  + '0b060a0508020c03070f0e090d000104'
  + '0906080f050800040a0b030d01020c0e'
  + '090d0c0604070a03030f00080105020e'
  + '01000d0f090a0b0e0402080703060c05'
  + '01080a0c0f0905060b000304020e070d'
  + '04080f000c0f0e0d0a01060207090503'
  + '040205080d0b0a0606000e0f070c0903'
  + '0a08040f000b01060d0c0709030e0502'
  + '0a070b050f00020e0108030d0c060904'
  + '0d070f08050f06040b0a0e0c09000203'
  + '0d0c020704010b0e0e08060f09050003');

function md5V3Step(kind, a, b, c, d, m, shift, constant) {
  let f;
  if (kind === 0) f = (b & c) | (~b & d);
  else if (kind === 1) f = (b & d) | (c & ~d);
  else if (kind === 2) f = b ^ c ^ d;
  else f = c ^ (b | ~d);
  return (b + rotl((a + f + m + constant) | 0, shift)) | 0;
}

/** MD5 变体：固定轮常量表 + 消息编排表驱动的 64 轮压缩。 */
function md5SumV3(message, countV2, orders, countV1) {
  const sv = new Array(BRANCH2_SV.length);
  for (let i = 0; i < sv.length; i++) sv[i] = ror(BRANCH2_SV[i], countV1);
  const start = [
    ror(0x79e0f2fb, countV2), ror(0xc8b52570, countV2),
    ror(0xebc2f8cd, countV2), ror(0x7c104d93, countV2)];
  const endCount = (countV2 + 6) & 255;
  const end = [
    ror(0x19be4866, endCount), ror(0xe85986b4, endCount),
    ror(0xe19b326e, endCount), ror(0x71d1d7d4, endCount)];
  const m = new Array(16);
  for (let i = 0; i < 16; i++) m[i] = readLe32(message, i * 4);
  let a = start[0]; let b = start[1]; let c = start[2]; let d = start[3];

  const shifts0 = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22];
  const shifts1 = [5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20];
  const shifts2 = [4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23];
  const shifts3 = [6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  for (let kind = 0; kind < 4; kind++) {
    const shifts = kind === 0 ? shifts0 : kind === 1 ? shifts1 : kind === 2 ? shifts2 : shifts3;
    const offset = kind * 16;
    for (let i = 0; i < 16; i++) {
      const phase = i & 3;
      const mm = m[orders[offset + i] & 0xff];
      const cc = sv[offset + i];
      let next;
      if (phase === 0) next = md5V3Step(kind, a, b, c, d, mm, shifts[i], cc);
      else if (phase === 1) next = md5V3Step(kind, d, a, b, c, mm, shifts[i], cc);
      else if (phase === 2) next = md5V3Step(kind, c, d, a, b, mm, shifts[i], cc);
      else next = md5V3Step(kind, b, c, d, a, mm, shifts[i], cc);
      if (phase === 0) a = next;
      else if (phase === 1) d = next;
      else if (phase === 2) c = next;
      else b = next;
    }
  }
  const ret = Buffer.alloc(16);
  putLe32(ret, 0, (start[0] + a) ^ end[0]);
  putLe32(ret, 4, (start[1] + b) ^ end[1]);
  putLe32(ret, 8, (start[2] + c) ^ end[2]);
  putLe32(ret, 12, (start[3] + d) ^ end[3]);
  return concat(ret, le32(sumMd5(ret)));
}

function branch2F13(iv, querySm3, bodyMd5, tsBytes, khronos) {
  const v = (iv & 13) * 86;
  const ivV0 = ((v >>> 15) & 255) + ((v >>> 8) & 255);
  const n1 = [0x8980f29b, 0xeb549c7f, 0xb08726db, 0xd40cb5e6, 0xe8f559e4][ivV0];
  const countV1 = (n1 + khronos + 1) & 255;
  const countV2 = (n1 + khronos) | 0;
  const shift = (countV2 + 5) & 7;
  const seed = [0x84, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8];
  const pad = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) pad[i] = ((seed[i] | (seed[i] << 8)) >> shift) & 255;
  const input = concat(querySm3, bodyMd5, tsBytes, pad,
    Crypto.unhex('a0010000'));
  const from = ivV0 << 6;
  const to = (ivV0 + 1) << 6;
  const orders = sliceBytes(BRANCH2_ORDERS, from, to);
  return md5SumV3(input, countV2, orders, countV1);
}

/** hashF13：按 iv 低 4 位选分支（0 为主分支，1 不被服务端接受，2 为备用变体）。 */
function hashF13(querySm3, bodyMd5, tsBytes, khronos) {
  const iv = getIv(getIv(getIv(0x20230928, querySm3), bodyMd5), tsBytes);
  const low = iv & 15;
  const ivV0 = (low * 171) >> 9;
  const branch = low - ivV0 * 3;
  if (branch === 2) return branch2F13(iv, querySm3, bodyMd5, tsBytes, khronos);
  if (branch !== 0) {
    return concat(sliceBytes(querySm3, 0, 16), bodyMd5,
      le32(sumMd5(concat(querySm3, bodyMd5))));
  }

  const ivV1List = [0xc4a78580, 0xb3c0fd39, 0xc58c5686, 0xc9aa3ba7, 0xf5a7adf2, 0x963c2ed1];
  const ivV1 = ivV1List[ivV0] | 0;
  const countV1 = (ivV1 + khronos + 1) & 255;
  const countV2 = (ivV1 + khronos) | 0;
  const tt02 = [
    0xebb64faf, 0x07aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
    0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
    0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
    0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
    0x617ce2a6, 0xe423417e, 0x0a40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x05b23bb3,
    0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
    0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
    0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x0284ba7, 0x08387cfa, 0x5fb37586];
  const tt = new Array(tt02.length);
  for (let i = 0; i < tt.length; i++) tt[i] = ror(tt02[i], countV1);
  const n0 = (countV2 + 2) & 7;
  const seed = [0xfa, 0x45, 0x61, 0xd7];
  // JS: Buffer.from(seed.map(...)) —— seed 仅 4 个元素，pad 为 4 字节
  const pad = Buffer.alloc(seed.length);
  for (let i = 0; i < seed.length; i++) pad[i] = ((seed[i] | (seed[i] << 8)) >> n0) & 255;
  const data = concat(querySm3, bodyMd5, tsBytes, pad, Crypto.unhex('00000000000001a0'));

  const di = new Array((data.length / 4) + 112 + 16).fill(0);
  let diLen = 0;
  for (let i = 0; i + 3 < data.length; i += 4) di[diLen++] = readBe32(data, i);
  const di0 = di[0];
  for (let i = 0; i < 112; i++) {
    const di1 = di[i + 1];
    const di14 = di[i + 14];
    const r1 = rotl(di1, 14) ^ rotl(di1, 25) ^ (di1 >>> 3);
    const r2 = rotl(di14, 13) ^ rotl(di14, 15) ^ (di14 >>> 10);
    di[diLen++] = (di0 + di[i + 9] + r1 + r2) | 0;
  }

  const initRaw = [0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f,
    984304912, 3005047866, 2874125293, 2152413264];
  const init = new Array(8);
  for (let i = 0; i < 8; i++) init[i] = ror(initRaw[i], countV2 & 31);
  const chosenTable = [
    [101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3],
    [96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4],
    [96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5],
    [99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6],
    [96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4],
    [100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5]];
  const chosen = chosenTable[ivV0];
  const d = init.slice();
  for (let i = 0; i < chosen[0]; i++) {
    const base = (ivV1 + i) | 0;
    const n0v = di[base & 127];
    const n1 = ((d[chosen[3]] ^ d[chosen[4]]) & d[chosen[1]]) ^ d[chosen[3]];
    const n2 = rotl(d[chosen[1]], 26) ^ rotl(d[chosen[1]], 21) ^ rotl(d[chosen[1]], 7);
    const n4 = (n0v + n1 + n2 + tt[base & 63] + d[chosen[5]]) | 0;
    const n5 = rotl(d[chosen[2]], 30) ^ rotl(d[chosen[2]], 19) ^ rotl(d[chosen[2]], 10);
    const n6 = (d[chosen[2]] & d[chosen[6]]) | ((d[chosen[2]] | d[chosen[6]]) & d[chosen[7]]);
    const n7 = (n5 + n6) | 0;
    const old = d[chosen[9]];
    // d.unshift(d.pop())：末元素移到队首（循环右移一格）
    const last = d[d.length - 1];
    for (let k = d.length - 1; k >= 1; k--) d[k] = d[k - 1];
    d[0] = last;
    d[chosen[10]] = (n7 + n4) | 0;
    d[chosen[8]] = (old + n4) | 0;
  }
  const ret = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) putBe32(ret, i * 4, (d[i] + init[i]) | 0);
  for (let i = 0; i < 16; i++) ret[i] = ret[i] ^ ret[i + 16];
  return concat(sliceBytes(ret, 0, 16), le32(sumMd5(sliceBytes(ret, 0, 16))));
}

// ==================== v5 hashF13（Android v04.10.03 播放签名） ====================

/**
 * v5 的 hashF13：只有一条分支（iv & 15 == 12），固定 ivV1 与固定轮表。
 *
 * 移植自 N3urda/hongguoTV 18c37c2 Signer.hashF13(mobileV5=true)。
 * 与 v3 主分支的差别：
 *  - ivV1 固定为 0x9d4a97c2，不再按 iv 查 6 组常量；
 *  - 扩展轮的 chosen 表固定为 [96,1,3,4,0,6,5,2,0,7,7]；
 *  - 折叠后的校验和额外置 bit5（sumMd5 自带 bit2，故服务端只认 &0x24==0x24）。
 *
 * @param {Buffer} querySm3 query 的 sm3（32 字节）
 * @param {Buffer} bodyMd5 body 的 md5（16 字节；无 body 时传 16 个 0）
 * @param {Buffer} tsBytes le32(khronos)
 * @param {number} khronos 秒级时间戳
 * @returns {Buffer} 20 字节（16 字节折叠摘要 + 4 字节校验和）
 */
function hashF13V5(querySm3, bodyMd5, tsBytes, khronos) {
  const ivV1 = 0x9d4a97c2 | 0;
  const countV1 = (ivV1 + khronos + 1) & 255;
  const countV2 = (ivV1 + khronos) | 0;
  const tt02 = [
    0xebb64faf, 0x07aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
    0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
    0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
    0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
    0x617ce2a6, 0xe423417e, 0x0a40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x05b23bb3,
    0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
    0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
    0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x0284ba7, 0x08387cfa, 0x5fb37586];
  const tt = new Array(tt02.length);
  for (let i = 0; i < tt.length; i++) tt[i] = ror(tt02[i], countV1);
  const shift = (countV2 + 2) & 7;
  const seed = [0xfa, 0x45, 0x61, 0xd7];
  const pad = Buffer.alloc(seed.length);
  for (let i = 0; i < seed.length; i++) pad[i] = ((seed[i] | (seed[i] << 8)) >> shift) & 255;
  const data = concat(querySm3, bodyMd5, tsBytes, pad, Crypto.unhex('00000000000001a0'));

  const di = new Array((data.length / 4) + 112 + 16).fill(0);
  let diLen = 0;
  for (let i = 0; i + 3 < data.length; i += 4) di[diLen++] = readBe32(data, i);
  for (let i = 0; i < 112; i++) {
    const x = di[i + 1];
    const y = di[i + 14];
    const r1 = rotl(x, 14) ^ rotl(x, 25) ^ (x >>> 3);
    const r2 = rotl(y, 13) ^ rotl(y, 15) ^ (y >>> 10);
    di[diLen++] = (di[i] + di[i + 9] + r1 + r2) | 0;
  }

  const initRaw = [0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f,
    984304912, 3005047866, 2874125293, 2152413264];
  const init = new Array(8);
  for (let i = 0; i < 8; i++) init[i] = ror(initRaw[i], countV2 & 31);
  const chosen = [96, 1, 3, 4, 0, 6, 5, 2, 0, 7, 7];
  const d = init.slice();
  for (let i = 0; i < chosen[0]; i++) {
    const base = (ivV1 + i) | 0;
    const n1 = ((d[chosen[3]] ^ d[chosen[4]]) & d[chosen[1]]) ^ d[chosen[3]];
    const n2 = rotl(d[chosen[1]], 26) ^ rotl(d[chosen[1]], 21) ^ rotl(d[chosen[1]], 7);
    const n4 = (di[base & 127] + n1 + n2 + tt[base & 63] + d[chosen[5]]) | 0;
    const n5 = rotl(d[chosen[2]], 30) ^ rotl(d[chosen[2]], 19) ^ rotl(d[chosen[2]], 10);
    const n6 = (d[chosen[2]] & d[chosen[6]]) | ((d[chosen[2]] | d[chosen[6]]) & d[chosen[7]]);
    const old = d[chosen[9]];
    const last = d[d.length - 1];
    for (let k = d.length - 1; k >= 1; k--) d[k] = d[k - 1];
    d[0] = last;
    d[chosen[10]] = ((n5 + n6) + n4) | 0;
    d[chosen[8]] = (old + n4) | 0;
  }
  const ret = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) putBe32(ret, i * 4, (d[i] + init[i]) | 0);
  for (let i = 0; i < 16; i++) ret[i] = ret[i] ^ ret[i + 16];
  const folded = sliceBytes(ret, 0, 16);
  // v5 校验和额外置 bit5
  return concat(folded, le32((sumMd5(folded) | 0x20) | 0));
}

// ==================== x-gorgon ====================

/** RC4 变体（KSA 只赋值不交换，PRGA 异或 s[(y+y)&255]）。 */
function rc4Gorgon(data, key) {
  const s = new Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    s[i] = s[j];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i += 1;
    const x = s[i];
    j += x;
    const y = s[j & 255];
    s[i] = y;
    out[k] = data[k] ^ s[(y + y) & 255];
  }
  return out;
}

function xGorgon(query, body, timestamp, random) {
  const q4 = sliceBytes(md5(Buffer.from(query, 'utf8')), 0, 4);
  const b4 = body === null || body === undefined
    ? Buffer.alloc(4) : sliceBytes(bodyMd5Of(body), 0, 4);
  const sdk = le32(67503104);
  const input = concat(q4, b4, Buffer.alloc(4), sdk, be32(timestamp | 0));
  const key = [0x4a, 0x40, 0x16, (random >> 8) & 255, 0x47, 0x6c, 0x01, random & 255];
  const out = rc4Gorgon(input, key);
  for (let i = 0; i < out.length; i++) {
    const value = rotl8(out[i] & 0xff);
    const next = i + 1 < out.length ? (out[i + 1] & 0xff) : (out[0] & 0xff);
    out[i] = (~(reverseBits((next ^ value) & 255) ^ 20)) & 255;
  }
  return Crypto.hex(concat(Crypto.unhex('8404'),
    Buffer.from([random & 255, (random >> 8) & 255, 0x40, 0x01]), out));
}

// ==================== AesV3（medusa 内置的 AES 变体） ====================

const SBOX = Buffer.from(
  '+n0Ia5xZs0sEXznQOEqRmQBnpiCf9U2Ccybu3xhmgzOAAxn72f6uqqmwUsYL83klTni0NqxdGieeiNu9PGPsSRXBMB/cuFbUbM3KCUPINaPvHvSW0vwOcnuUhNHqRVpiAj/TEoE0K91+5ijypUYTATsh9mE3KSoN7Yyvv51cuyR2D3XkU4nhmI2xmmVwT1RMWKtub4sjxAcRDLrPoKSO2AU9FLLadMPX577Wf95IFj6FkKFVt3dCIsmGUC4X+WQxLJvxbRxEaOPpqJOXyzJX6+Vxaq3AzMfF/WAdoi1Hp+JRaV56zgpBtpWP97mH4DoGEIq1+FvV8LyS/3wvwugbQOwb2r26mJEMsiuDQTRn+wrYdrVGBVlhI3WQhyrjUBVMrLF5667llUcEaPCGPVGLD8qO5LlO8hKCvA7V9+8oJc9bXelqVQLhM76T5/WtnT45JKji+hdX0HoNCDDWuKON/QeaxB5uImSX0h2wv0VmP2zd2yeApxHcpsVS+MC2yFwAc2B7oBkTqsk1SEvTpM2fmfMQREBUfin0Bh+iq6EvPPavhWI2IX9e3yAas7Tm/3KEj2UmlFp36kN4x0rMLBRrxuh0U/zUHM4xcAMYjJY4MonxOl/X+alpt2M3WMI7w3HLnpIBigtNiJu7T21v4P6lSd5WFgntnMEt7oF92XzRLkJbTcGmXepE/UVOG6E/0YnhfS+q26utWcuxzpooyeD2cDlK1/8w9d28VzsRjbLuALbmGlp8+d7EzS6Au7lMpZ+ECMZvQmzwJ+eLOpxR+2chdUExp8ogQyq3v9l68rX4jCwjg0+PYKAEEzcU4wHFY2ZcdIHfWL1okD3SszT0GZMyKdZJrg1L2AeerB4tC0C4crp2EHGo5FYdSP7lwkeR2ocmnR+Ia8CYviUJlzOjhRZef9xuVOn3qcjow3fQgivsAmKKkg4+sA8F8/GWeDiGNhg8JM8KtFPMYWWkx5TVFX5t73kiNRJqjlIGVXtGZFCV4gzt0xcDopuZ6xz8r9Rzafpf9ywev8jh8592gHFIqpStZPuJxmDDMrNN0uBE3V+oscdoIzTJbRJ/t+sVvqnReJOgDJKk10fjisJwqyZBmnmn2BSFj8BvVtCMEbkuPOKdzw7eA11GPs04Qw8zWtkaZWwiO/wwpojqN6K0jY5RnNZA7vn4hPSul+nKCkVnVwQvg1zVxcSCtqORmB9KrJaBbssbCQivGJVJfVTt+hYxOtq4ZvWl8f4QAQZ0zGPffCgl9s6yT4vlvIdpu4YhBwA25wtQWZsc6GJYGWHyvSdeuh3mmUI9DSq13Fsp8C1MU3tqc04/df9LoTUXVXI5INOw/e8C7Hd+5CvbkMEFnnrUUmskEw==',
  'base64');

/** JS 语义：越界读返回 0（undefined 在位运算中等价于 0）。 */
function aesSrc(data, idx) {
  return idx < data.length ? (data[idx] & 0xff) : 0;
}

function aesPut(out, idx, value) {
  if (idx >= 0 && idx < out.length) out[idx] = value & 0xff;
}

function aesMatrix(bytes) {
  const rows = new Array(4);
  for (let i = 0; i < 4; i++) {
    rows[i] = new Array(4);
    for (let j = 0; j < 4; j++) rows[i][j] = bytes[i * 4 + j] & 0xff;
  }
  return rows;
}

function aesFlat(rows) {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) b[i * 4 + j] = rows[i][j] & 0xff;
  }
  return b;
}

function aesXt(x) {
  return ((x << 1) ^ ((x & 128) !== 0 ? 0x1b : 0)) & 255;
}

function aesMix(rows) {
  for (let i = 0; i < 4; i++) {
    const t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i];
    const u = rows[0][i];
    rows[0][i] ^= t ^ aesXt(rows[0][i] ^ rows[1][i]);
    rows[1][i] ^= t ^ aesXt(rows[1][i] ^ rows[2][i]);
    rows[2][i] ^= t ^ aesXt(rows[2][i] ^ rows[3][i]);
    rows[3][i] ^= t ^ aesXt(rows[3][i] ^ u);
  }
}

/** AES 变体：S 盒按 khronos 选段、行/列换用查表、密钥扩展 12 组。 */
class AesV3 {
  /**
   * @param {Buffer} key 16 字节密钥
   * @param {number} khronos 秒级时间戳（决定选哪一段 S 盒与换位表）
   * @param {boolean} [v5] 是否使用 v04.10.03 协议表（Android v5 签名）
   * @param {Buffer} [boxOverride] 可选：用外部 S 盒（--sync-constants 校验新常量时用）
   */
  constructor(key, khronos, v5, boxOverride) {
    this.v5 = v5 === true;
    this.wordSize = khronos & 3;
    const box = (boxOverride !== null && boxOverride !== undefined)
      ? boxOverride : (this.v5 ? V5.SBOX : SBOX);
    this.box = sliceBytes(box, this.wordSize * 256, (this.wordSize + 1) * 256);
    const con2Table = this.v5
      ? [[2, 0, 3, 1], [1, 3, 2, 0], [3, 2, 1, 0], [2, 3, 1, 0]]
      : [[1, 0, 2, 3], [2, 0, 3, 1], [0, 1, 3, 2], [1, 0, 2, 3]];
    const orderTable = this.v5
      ? [
        [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
        [0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7],
        [0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7],
        [0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7]]
      : [
        [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
        [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
        [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
        [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3]];
    // 明文具化/回填用的位序表：wire 取源字节的第几位，compact 落到明文第几位
    this.wire = this.v5 ? [6, 5, 3, 4, 2, 7, 1, 0] : [5, 6, 2, 4, 3, 1, 0, 7];
    this.compact = this.v5 ? [1, 7, 3, 6, 2, 0, 4, 5] : [1, 6, 0, 7, 2, 4, 5, 3];
    this.con2 = con2Table[this.wordSize];
    this.order = orderTable[this.wordSize];
    const init = (this.v5
      ? [0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9]
      : [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f])[this.wordSize];
    const initial = Buffer.alloc(16);
    for (let i = 0; i < 4; i++) putLe32(initial, i * 4, init);
    const mk = xorBytes(initial, key);
    const expanded = concat(mk, Buffer.alloc(32));
    let rounds = 8;
    for (let i = 4; i < 12; i++) {
      const at = 4 * (i - 1);
      let a = expanded[at] & 0xff; let b = expanded[at + 1] & 0xff;
      let c = expanded[at + 2] & 0xff; let d = expanded[at + 3] & 0xff;
      if ((i & 3) === 0) {
        const t = ((init >>> (rounds & 24)) ^ (this.box[b] & 0xff)) & 255;
        b = this.box[c] & 0xff;
        c = this.box[d] & 0xff;
        d = this.box[a] & 0xff;
        a = t;
      }
      rounds += 2;
      expanded[at + 4] = (a ^ (expanded[at - 12] & 0xff)) & 0xff;
      expanded[at + 5] = (b ^ (expanded[at - 11] & 0xff)) & 0xff;
      expanded[at + 6] = (c ^ (expanded[at - 10] & 0xff)) & 0xff;
      expanded[at + 7] = (d ^ (expanded[at - 9] & 0xff)) & 0xff;
    }
    this.keys = new Array(12);
    for (let i = 0; i < 12; i++) {
      this.keys[i] = new Array(4);
      for (let j = 0; j < 4; j++) this.keys[i][j] = expanded[i * 4 + j] & 0xff;
    }
  }

  add(rows, key) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) rows[i][j] ^= key[i][j];
    }
  }

  addCon(rows, ks) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) rows[i][j] ^= ks[i][this.con2[j]];
    }
  }

  sub(rows) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) rows[i][j] = this.box[rows[i][j]] & 0xff;
    }
    const old = new Array(4);
    for (let i = 0; i < 4; i++) old[i] = rows[i].slice();
    for (let i = 0; i < 4; i++) rows[i] = old[this.con2[i]];
  }

  shift(rows) {
    const b = aesFlat(rows);
    for (let i = 0; i < 16; i++) rows[(i / 4) | 0][i % 4] = b[this.order[i]] & 0xff;
  }

  shiftCon(rows) {
    const old = new Array(4);
    for (let i = 0; i < 4; i++) old[i] = rows[i].slice();
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) rows[i][j] = old[i][this.con2[j]];
    }
  }

  block(value) {
    const rows = aesMatrix(value);
    const k0 = this.subKeys(0);
    this.addCon(rows, k0);
    for (let i = 1; i < 3; i++) {
      this.sub(rows);
      this.shift(rows);
      if (i === 1) {
        this.shiftCon(rows);
        aesMix(rows);
      }
      this.addCon(rows, this.subKeys(i * 4));
    }
    this.add(rows, this.subKeys(4));
    return aesFlat(rows);
  }

  subKeys(from) {
    const out = new Array(4);
    for (let i = 0; i < 4; i++) out[i] = this.keys[from + i].slice(0, 4);
    return out;
  }

  /** 加密：明文具化到 32 字节 -> CBC 两轮 -> 按 key 逐位回填源数据，末尾缀 key 末字节。 */
  encrypt(data, iv) {
    const plaintext = Buffer.alloc(32);
    // 位序表驱动：wire[j] 取源字节第 j 位，compact[j] 落到明文位
    for (let i = 0; i < 31; i++) {
      const at = i * 8;
      let value = 0;
      for (let j = 0; j < 8; j++) {
        value |= ((aesSrc(data, at + j) >>> this.wire[j]) & 1) << this.compact[j];
      }
      plaintext[i] = value & 0xff;
    }
    plaintext[31] = 1;
    const blocks = [];
    let previous = Buffer.from(iv);
    for (let i = 0; i < plaintext.length; i += 16) {
      const value = this.block(xorBytes(sliceBytes(plaintext, i, i + 16), previous));
      blocks.push(value);
      previous = value;
    }
    const key = concat(...blocks);
    const out = Buffer.from(data);
    for (let i = 0; i < 31; i++) {
      const at = i * 8;
      const k = key[i] & 0xff;
      // JS 语义：越界读写均静默忽略，故读用 aesSrc()、写用 aesPut()
      for (let j = 0; j < 8; j++) {
        const bit = this.wire[j];
        const bitValue = ((k >>> this.compact[j]) & 1) << bit;
        aesPut(out, at + j, (aesSrc(out, at + j) & ~(1 << bit)) | bitValue);
      }
    }
    return concat(sliceBytes(key, key.length - 1, key.length), out);
  }
}

// ==================== xmxor / keyHash / medusa / helios ====================

/** xmxor：按 key 表逐字节混淆 + 三段尾部修正。 */
function xmxor(data, key) {
  const encoded = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    const at = (i * 4) & 28;
    const d0 = key[at] & 0xff;
    const d1 = key[at + 1] & 0xff;
    let d2 = (rotl8(data[i] & 0xff) + d0);
    d2 = (~d2) ^ d1;
    d2 = rotl8_3(d2 & 0xff);
    d2 = (d2 + d1) & 255;
    d2 = (d2 ^ d0) & 255;
    encoded[data.length - i - 1] = (~d2) & 255;
  }
  const last = (encoded[encoded.length - 1] ^ encoded[encoded.length - 2]) & 255;
  const first = encoded[0] & 0xff;
  encoded[0] = ((~last) + first) & 255;
  encoded[1] = ((encoded[0] ^ encoded[encoded.length - 1] ^ 254) + encoded[1]) & 255;
  encoded[2] = (encoded[2] + (((last - first) ^ rotl8_3(encoded[1] & 0xff)) ^ 2)) & 255;
  for (let i = 0; i < encoded.length - 4; i++) {
    const temp = (rotl8_3(encoded[i + 2] & 0xff) ^ encoded[i + 1] ^ (i + 3));
    encoded[i + 3] = ((~temp) + encoded[i + 3]) & 255;
  }
  encoded[encoded.length - 1] = (encoded[encoded.length - 1] ^ encoded[encoded.length - 2]) & 255;
  let sum = 0;
  for (let i = 0; i < encoded.length - 1; i++) sum += encoded[i + 1] & 0xff;
  encoded[0] = ((encoded[0] ^ encoded[1]) + sum) & 255;
  return encoded;
}

/** keyHash：signKey || le32(random) || signKey 的 SM3，附一个由 random 派生的 4 字节种子。 */
function keyHash(signKey, random) {
  const hash = sm3(concat(signKey, le32(random), signKey));
  const d1 = (random >> 16) & 255;
  let d2 = (((d1 << 11) | (random >>> 24)) ^ (d1 >> 5) ^ d1);
  d2 = ~d2;
  return [hash, le32(d2)];
}

const MEDUSA_SIGN_KEY = Crypto.unhex(
  '8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5');
const MEDUSA_AES_KEY = Crypto.unhex('f1593376766ea98d34f31b057a9d5be4');
const MEDUSA_AES_IV = Crypto.unhex('1fe109a4125283f418de9e051a969e12');
const MEDUSA_MAGIC16 = Crypto.unhex('f7e85ffad7d7dc3bd62ac87057cf6118');
const MEDUSA_MAGIC8 = Crypto.unhex('4001000000000000');

/** 进程级 nonce（18 随机字节的 base64url）。 */
const PROCESS_NONCE = crypto.randomBytes(18).toString('base64url');
const PROCESS_STARTED = Date.now();

function randomBytes(n) {
  return crypto.randomBytes(n);
}

/** 对应 Java RND.nextInt(n)：返回 [0, n) 的整数。 */
function rndInt(n) {
  return crypto.randomInt(n);
}

/** 对应 Java RND.nextInt()：返回有符号 32 位整数。 */
function rndInt32() {
  return crypto.randomBytes(4).readInt32BE(0);
}

/**
 * 设备信息 protobuf。与 jackotom 参考实现保持一致：字段 30-36 为固定设备值
 * （25053RT47C / Redmi / Xiaomi），不跟随 query 参数，仅 deviceId/version 外部传入。
 */
function deviceProto(deviceId, version) {
  return proto([
    [1, 1, 'sint'], [2, 2, 'sint'], [3, '8662'], [4, deviceId],
    [5, PROCESS_NONCE], [6, '!noperm!'], [7, -888888, 'sint'], [8, -888888, 'sint'],
    [9, 3, 'sint'], [10, -888888, 'sint'], [11, '!notset!'],
    [12, 'Asia/Shanghai,8'], [13, 'zh_CN'], [14, 4, 'sint'],
    [16, 0, 'float'], [17, 0, 'float'], [18, 0, 'float'], [19, 0, 'float'],
    [20, 0, 'float'], [21, 0, 'float'], [22, '16'], [23, 41, 'sint'],
    [24, 36, 'sint'], [25, PROCESS_STARTED, 'sint'], [26, PROCESS_STARTED, 'sint'],
    [27, PROCESS_STARTED, 'sint'], [28, PROCESS_STARTED, 'sint'], [29, -1, 'sint'],
    [30, '25053RT47C'], [31, 'Redmi'], [32, '25053RT47C'], [33, '25053RT47C'],
    [34, 'Xiaomi'], [35, 'Redmi'], [36, 'Redmi'], [38, 31, 'sint']]);
}

/** 构造 x-medusa。 */
function buildMedusa(url, body, khronos, deviceId, version) {
  const bodyMd5 = bodyMd5Of(body);
  const query = queryOf(url);
  const querySm3 = sm3(Buffer.from(query, 'utf8'));
  const ts = le32(khronos | 0);
  const queryBodyTs = hashF13(querySm3, bodyMd5, ts, khronos);

  const messageRand = randomBytes(4);
  const messageRandU = readLe32(messageRand, 0) >>> 0;
  const envLaunch = 100 + rndInt(21);
  const envPid = 10001 + rndInt(2000);
  const env = proto([
    [1, envLaunch, 'sint'], [2, 146331399, 'sint'], [3, 146331396, 'sint'],
    [5, 7, 'sint'], [6, 'v04.06.04.03-bugfix'], [7, envPid, 'sint'],
    [12, deviceProto(deviceId, version), 'message'],
    [13, proto([
      [1, Math.floor(Date.now() / 1000), 'sint'],
      [2, -2, 'sint'], [4, 200, 'sint']]), 'message'],
    [14, version]]);
  const queryHash = sm3(concat(Buffer.from(query, 'utf8'), bodyMd5,
    Buffer.from('none', 'utf8')));

  const nested = proto([
    [1, 111, 'sint'], [2, 10, 'sint'], [3, 694367, 'sint'], [5, 586952199, 'sint']]);
  const message = proto([
    [1, MEDUSA_MAGIC16, 'bytes'], [2, 3, 'sint'], [3, messageRandU, 'sint'],
    [4, '8662'], [5, deviceId], [6, '1588093228'], [7, version],
    [8, 'v04.06.04-ml-android'], [9, 67503104, 'sint'],
    [10, MEDUSA_MAGIC8, 'bytes'], [12, khronos, 'sint'],
    [13, queryBodyTs, 'bytes'], [14, sliceBytes(querySm3, 0, 6), 'bytes'],
    [15, nested, 'message'], [16, PROCESS_NONCE], [17, khronos, 'sint'],
    [19, queryHash, 'bytes'], [20, 'none'], [21, 312, 'sint'],
    [23, env, 'message'],
    [24, '{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,'
    + '"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"",'
    + '"do":0,"tk":true}']]);

  const random = rndInt32();
  const hs = keyHash(MEDUSA_SIGN_KEY, random);
  const hash = hs[0];
  const seed = hs[1];
  let transformed = xmxor(message, hash);
  transformed = concat(MEDUSA_MAGIC8, transformed);
  // 整体逆序
  for (let i = 0, j = transformed.length - 1; i < j; i++, j--) {
    const t = transformed[i];
    transformed[i] = transformed[j];
    transformed[j] = t;
  }
  for (let i = 0; i < transformed.length; i++) {
    transformed[i] = (transformed[i] ^ seed[(~i) & 3]) & 0xff;
  }
  const check = (((querySm3[0] & 63) << 14) | 0x18000001 | ((queryBodyTs[0] & 63) << 8)) | 0;
  const xmRand = rndInt32();
  const packed = concat(Buffer.from([0x35]), le32(xmRand), le32(check), transformed,
    Buffer.from([(random >> 16) & 255, (random >> 24) & 255]));
  const encrypted = new AesV3(MEDUSA_AES_KEY, khronos).encrypt(packed, MEDUSA_AES_IV);
  const versionBytes = Crypto.unhex('03000000f7e85ffad7d7dc3bd62ac87057cf6118');
  const prefix = Buffer.alloc(20);
  for (let i = 0; i < 20; i += 4) {
    // JS: u32(version.readUInt32LE(i) ^ khronos) 后 writeUInt32LE
    putLe32(prefix, i, (readLe32(versionBytes, i) ^ (khronos | 0)));
  }
  return b64(concat(prefix,
    Buffer.from([random & 255, (random >> 8) & 255, 0, 1]), encrypted));
}

/**
 * 构造 v5 x-medusa（Android v04.10.03）。
 *
 * 移植自 N3urda/hongguoTV 18c37c2 Signer.medusaV5。与 v3 的差别：
 *  - 明文结构整体换版（magic / license / 字段集合都不同），env 只保留 4 个字段；
 *  - flags 由 8 字节零填充代替 v3 的 0x4001000000000000；
 *  - keyHash 用 v5 协议密钥，AesV3 用 v5 表（S 盒/换位/初始常量全换）；
 *  - 前缀为 le32(5) 与 16 字节 magic 异或时间戳，首字节 0xca。
 *
 * @param {string} url 完整 URL（含 query），签名只取 '?' 之后的部分
 * @param {Buffer|null} body 请求体（gzip 后的原始字节）
 * @param {number} khronos 秒级时间戳
 * @param {object} identity 注册身份 + 版本参数（device_id / version_name / os_version / device_type / channel）
 * @returns {string} base64 的 x-medusa
 */
function buildMedusaV5(url, body, khronos, identity, field21) {
  const who = identity || {};
  // 2026-11-20 上游双端点分化：video_model/v1 旧端点配套 field21=377，
  // multi_video_model/* 新端点配套 field21=312。缺省 312 保持既有链路不变。
  const field21Value = (field21 === undefined || field21 === null) ? V5.FIELD21 : field21;
  const query = sm3(Buffer.from(queryOf(url), 'utf8'));
  const bodyMd5 = bodyMd5Of(body);
  const f13 = hashF13V5(query, bodyMd5, le32(khronos | 0), khronos);
  const flags = Buffer.alloc(8);
  const version = String(who.version_name || '');
  const deviceType = String(who.device_type || '25053RT47C');

  // 2026-11-24 校正：buildMedusaV5 对应 N3urda/hongguoTV 的 Signer.medusaV5()
  // （field21=312、message field15=1/1/1/1、env=[6,8,12,14] 均为 v5 形态），
  // 其 deviceInfo 是精简 14 字段版：1/2/3/4/5/6/12/13/22/25/30/31/32/34。
  // 之前误把 medusa()（老链路 7.4.3.32）里 deviceProto() 的完整 30+ 字段
  // （7/8/9/10/11/14/16-21/23/24/26-29/33/35/36/38）混进来，字段集合对不上，
  // 服务端按「签名设备画像与 query 不一致」判空，回 HTTP 200 + 0 字节。
  // 注意 field22 用注册身份的 os_version，field25 用进程启动时间，
  // field31/34 固定 HONOR，field30/32 用 device_type —— 与上游逐字一致。
  const deviceInfo = proto([
    [1, 1, 'sint'], [2, 2, 'sint'], [3, '8662'], [4, String(who.device_id || '0')],
    [5, PROCESS_NONCE], [6, '!noperm!'],
    [12, 'Asia/Shanghai,8'], [13, 'zh_CN'],
    [22, String(who.os_version || '16')], [25, PROCESS_STARTED, 'sint'],
    [30, deviceType], [31, 'HONOR'], [32, deviceType], [34, 'HONOR']]);
  const env = proto([
    [6, 'v04.10.03.04-bugfix'], [8, String(who.channel || 'update_64')],
    [12, deviceInfo, 'message'], [14, version]]);
  const message = proto([
    [1, V5.MAGIC16, 'bytes'], [2, 5, 'sint'], [3, rndInt32() >>> 0, 'sint'],
    [4, '8662'], [5, String(who.device_id || '0')], [6, V5.LICENSE], [7, version],
    [8, 'v04.10.03-ml-android'], [9, 0x040a0300, 'sint'],
    [10, flags, 'bytes'], [12, khronos, 'sint'], [13, f13, 'bytes'],
    [14, sliceBytes(query, 0, 6), 'bytes'],
    [15, proto([[1, 1, 'sint'], [2, 1, 'sint'], [3, 1, 'sint'], [5, 1, 'sint']]), 'message'],
    [17, khronos, 'sint'], [20, 'none'], [21, field21Value, 'sint'], [23, env, 'message'],
    [24, '{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,'
    + '"kd":0,"dyn":"","do":1,"tk":true}']]);

  const nonce = rndInt32();
  const hash = sm3(concat(V5.SIGN_KEY, le32(nonce), V5.SIGN_KEY));
  const high = (nonce >>> 16) & 255;
  const seed = le32(~((((high << 11) | (nonce >>> 24)) ^ (high >>> 5) ^ high)) | 0);

  let transformed = concat(flags, xmxor(message, hash));
  transformed = Buffer.from(transformed).reverse();
  for (let i = 0; i < transformed.length; i++) {
    transformed[i] = (transformed[i] ^ seed[(~i) & 3]) & 0xff;
  }
  const check = (0x18000001 | ((query[0] & 63) << 14) | ((f13[0] & 63) << 8)) | 0;
  const packed = concat(Buffer.from([0xca]), le32(rndInt32()), le32(check), transformed,
    Buffer.from([(nonce >>> 16) & 255, (nonce >>> 24) & 255]));
  // AesV3 要求明文 >= 248 字节；结构固定，正常都在 250 上下
  const encrypted = new AesV3(md5(sliceBytes(V5.SIGN_KEY, 0, 16)), khronos, true)
    .encrypt(packed, md5(sliceBytes(V5.SIGN_KEY, 16, 32)));

  const prefix = concat(le32(5), V5.MAGIC16);
  const tsBytes = le32(khronos | 0);
  for (let i = 0; i < prefix.length; i++) prefix[i] = (prefix[i] ^ tsBytes[i & 3]) & 0xff;
  return b64(concat(prefix,
    Buffer.from([nonce & 255, (nonce >>> 8) & 255, 0, 1]), encrypted));
}

/** helios：md5 ASCII 化 -> 64 位字表 -> 34 轮扩展 -> 分组类 Feistel。 */
function helios(khronos) {
  return heliosWith(khronos, rndInt32());
}

/** 可注入 random 的 helios（默认重载用 rndInt32()）。license 缺省为 v3 的 1588093228。 */
function heliosWith(khronos, random, license) {
  const digest = md5(concat(le32(random), Buffer.from('8662', 'utf8')));
  const hex = digest.toString('hex');
  const ascii = Buffer.from(hex, 'ascii');
  const words = new Array(4);
  for (let i = 0; i < 4; i++) words[i] = readU64Le(ascii, i * 8);

  // JS: words.splice(0,2) 后每轮 push 一个、shift 一个，队列恒长 2。
  // 用双端队列精确模拟：b8 始终取「最早入队未消费」的元素。
  const queue = [words[2], words[3]];
  let b0 = words[0];
  let b8 = words[1];
  const table = new Array(35);
  table[0] = words[0];
  for (let i = 0; i < 34; i++) {
    let x8 = BigInt.asUintN(64, rotr64(b8, 8) + b0);
    x8 = BigInt.asUintN(64, x8 ^ BigInt(i));
    queue.push(x8);
    x8 = BigInt.asUintN(64, x8 ^ rotr64(b0, 61));
    table[i + 1] = x8;
    b0 = x8;
    b8 = queue.shift();
  }
  const text = String(khronos) + '-' + (license || '1588093228') + '-8662';
  const tb = Buffer.from(text, 'utf8');
  const padLen = Math.floor((tb.length + 1 + 15) / 16) * 16;
  const pad = Buffer.alloc(padLen);
  pad.fill((16 - (tb.length % 16)) & 0xff);
  tb.copy(pad, 0);

  const output = [];
  for (let at = 0; at < pad.length; at += 16) {
    let a = readU64Le(pad, at);
    let b = readU64Le(pad, at + 8);
    for (let i = 0; i < 34; i++) {
      b = BigInt.asUintN(64, table[i] ^ BigInt.asUintN(64, a + rotr64(b, 8)));
      a = BigInt.asUintN(64, b ^ rotr64(a, 61));
    }
    const block = Buffer.alloc(16);
    // JS: block.writeBigUInt64LE —— 小端写入
    putU64Le(block, 0, a);
    putU64Le(block, 8, b);
    output.push(block);
  }
  const all = [le32(random), ...output];
  return b64(concat(...all));
}

// ==================== 分支判定与入口 ====================

/** 与 hashF13 相同的分支计算；branch==1 时服务端不认，调用方应抖动 _rticket 避开。 */
function branchOf(url, body, khronos) {
  const bodyMd5 = bodyMd5Of(body);
  const q = sm3(Buffer.from(queryOf(url), 'utf8'));
  const iv = getIv(getIv(getIv(0x20230928, q), bodyMd5), le32(khronos | 0));
  const low = iv & 15;
  return low - (((low * 171) >> 9) * 3);
}

function queryOf(url) {
  const i = url.indexOf('?');
  return i < 0 ? '' : url.substring(i + 1);
}

/**
 * 计算一组签名头。
 *
 * @param {string} url  完整 URL（含 query），必须与最终请求一致
 * @param {Buffer|null} body 请求体字节；GET 传 null
 * @param {number} [khronos] 可选的秒级时间戳；缺省取当前时间
 * @returns {object} 需要合并进请求头的字段（x-gorgon / x-khronos / x-ladon / x-argus / x-helios / x-medusa）
 */
function sign(url, body, khronos) {
  const ts = (khronos === undefined || khronos === null)
    ? Math.floor(Date.now() / 1000) : khronos;
  const gorgonRandom = rndInt(65536);
  const query = queryOf(url);
  const out = {};
  out['x-gorgon'] = xGorgon(query, body, ts, gorgonRandom);
  out['x-khronos'] = String(ts);
  out['x-ladon'] = b64(be32(ts | 0));
  out['x-argus'] = b64(le32(ts | 0));
  out['x-helios'] = helios(ts);
  out['x-medusa'] = buildMedusa(url, body, ts,
    paramOf(query, 'device_id', '0'),
    paramOf(query, 'version_name', '7.1.3.32'));
  return out;
}

function paramOf(query, key, fallback) {
  for (const kv of query.split('&')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    if (kv.substring(0, eq) === key) {
      const v = kv.substring(eq + 1);
      if (v.length > 0) return v;
    }
  }
  return fallback;
}

// ==================== v5 播放签名入口 ====================

/** URLEncoder.encode(v, "UTF-8") 的等价实现（空格 %20、~ 保留、!'()* 转义）。 */
function javaUrlEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

/** 按插入序拼 query（键值都走 javaUrlEncode）。 */
function encodeQuery(values) {
  return Object.entries(values)
    .map(([k, v]) => javaUrlEncode(k) + '=' + javaUrlEncode(v))
    .join('&');
}

/** v5 分支判定：只有 iv & 15 == 12 才被服务端接受（其余一律拒）。 */
function branchV5(url, body, khronos) {
  const bodyMd5 = bodyMd5Of(body);
  const q = sm3(Buffer.from(queryOf(url), 'utf8'));
  const iv = getIv(getIv(getIv(0x20230928, q), bodyMd5), le32(khronos | 0));
  return (iv & 15) === 12 ? 0 : 1;
}

/** v5 播放接口只保留这三个签名头（其余由请求方显式设置）。 */
const V5_HEADER_ALLOW = new Set(['x-khronos', 'x-helios', 'x-medusa']);

/**
 * 生成 v5 播放请求（最终 URL + 头）。
 *
 * v5 的分支由 _rticket 决定，所以必须「先抖动 _rticket 再签名」：
 * 逐个 ticket 试算，直到 iv&15==12，再以该 query 生成 medusa。
 * 其余 query 参数原样保留，签名不会改动分集号或设备身份。
 *
 * @param {string} base 接口地址（不含 query）
 * @param {object} values query 参数（插入序即编码序）
 * @param {Buffer|null} body gzip 后的请求体
 * @param {number} [now] 毫秒时间戳；缺省取当前时间
 * @returns {{url:string, headers:object}}
 */
function signPlaybackV5(base, values, body, now, field21) {
  const baseMs = (now === undefined || now === null) ? Date.now() : now;
  const ts = Math.floor(baseMs / 1000);
  for (let offset = 0; offset <= 1023; offset++) {
    const ticket = baseMs + offset;
    const query = encodeQuery(Object.assign({}, values, { _rticket: String(ticket) }));
    const url = base + '?' + query;
    if (branchV5(url, body, ts) !== 0) continue;

    const headers = {
      'x-ss-req-ticket': String(ticket),
      'sdk-version': '2',
      'x-xs-from-web': '0',
      'x-khronos': String(ts),
      'x-ladon': b64(be32(ts | 0)),
      'x-argus': b64(le32(ts | 0)),
      'x-gorgon': xGorgon(query, body, ts, rndInt(65536)),
      'x-helios': heliosWith(ts, rndInt32(), V5.LICENSE),
      'x-medusa': buildMedusaV5(url, body, ts, values, field21),
    };
    for (const k of Object.keys(headers)) {
      if (!V5_HEADER_ALLOW.has(k)) delete headers[k];
    }
    if (body != null && body.length > 0) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['x-ss-stub'] = md5(body).toString('hex').toUpperCase();
    }
    return { url, headers };
  }
  throw new Error('无法生成 v5 播放签名（1024 个 ticket 内未命中分支）');
}

// ==================== 当前 openhongguo 主链路（player/v1 真机 medusa） ====================
//
// 2026-11-24：beilunyang/openhongguo v0.4.1 把播放签名切换到真机形态：
//  - 真机 medusa 状态字段 21 = 369，模拟器 377 会被服务端回 HTTP 200 + 0 字节；
//  - env 里补上 PID/PPID/时钟/存储/安装时间，message field 15 用真机计数器；
//  - message field 24 的 JSON 也要带 sts/lp/fl。
// 下面这一组函数只服务 player/v1 主链路；旧的 preload/v1 与 video_tab
// 签名保持原样，作为兜底，避免一次性把可用退路全换掉。

const MEDUSA_DEVICE_FLAGS = Buffer.from([0x04, 0x05, 0, 0, 0, 0, 0, 0]);
const MEDUSA_EMULATOR_FLAGS = Buffer.from([0x08, 0, 0, 0, 0, 0, 0, 0]);
const MEDUSA_INSTALL_ANCHOR = 1795440816000;
const MEDUSA_ENV_VERSION = 'v04.10.03.04-bugfix';
const MEDUSA_SDK_VERSION = 'v04.10.03-ml-android';
const MEDUSA_SDK_CODE = 0x040a0300;
const MEDUSA_NOTSET = '!notset!';
const MEDUSA_NOPERM = '!noperm!';
const MEDUSA_NOPERM_INT = -888888;
const MEDUSA_UNSET = 694367;

let medusaProcessEnv = null;
let medusaCounter = 0;

function nextMedusaCount() {
  if (medusaCounter === 0) {
    medusaCounter = 20 + (Math.floor(Date.now() * 1000) % 100);
  }
  return ++medusaCounter;
}

function processMedusaEnv() {
  if (medusaProcessEnv !== null) return medusaProcessEnv;
  const now = Date.now();
  medusaProcessEnv = Object.freeze({
    PID: 3000 + (Math.floor(now * 1000) % 25000),
    PPID: 500 + (Math.floor(now * 40) % 700),
    LaunchMillis: now,
    Clock18: 766353820,
    Clock19: 16,
    Clock20: -1072050540,
    Channel: 'xiaomi_8662_64',
    UnH: 2398682137,
    Sts: 27,
    Fkd: 1963693275,
    Pd: 1442983616,
    Lp: '2|520830913092|521433182354|2078052786776|1081701896',
    Fl: '0|0|2523408538|2586339478|997724116|0|0|0|0|606600138',
    Status: V5.FIELD21,
  });
  return medusaProcessEnv;
}

/** SDK 的 rand() 是 31 位；上游明确把 medusa 随机量掩到 0x7fffffff。 */
function rndUint31() {
  return crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
}

/** 从 query 里的设备字段推导稳定的“真机环境”，与 openhongguo medusaDeviceOf 对齐。 */
function medusaDeviceOf(query, deviceId) {
  const model = paramOf(query, 'device_type', '');
  if (model === '') return null;
  const h = crypto.createHash('sha256')
    .update('medusa-device\0' + deviceId, 'utf8').digest();
  const pick = (i, n) => (readLe32(h, i * 4) >>> 0) % n;
  const storages = [106.83, 108.57, 229.36, 233.91, 487.62];
  const memories = [5.37, 7.42, 11.18, 15.07];
  const storage = storages[pick(0, storages.length)] + pick(1, 400) / 1000;
  const memory = memories[pick(2, memories.length)] + pick(3, 90) / 1000;
  const day = 24 * 60 * 60 * 1000;
  return {
    AppVersion: paramOf(query, 'version_name', ''),
    Model: model,
    Brand: paramOf(query, 'device_brand', ''),
    OSVersion: paramOf(query, 'os_version', ''),
    InstallMillis: MEDUSA_INSTALL_ANCHOR - day - pick(4, 20 * day),
    StorageGB: storage,
    StorageFreeGB: storage * (0.25 + pick(5, 500) / 1000),
    MemoryGB: memory,
    MemoryFreeGB: 0.35 + pick(6, 900) / 1000,
  };
}

function strField(tag, value) {
  return [tag, value === '' || value === null || value === undefined ? MEDUSA_NOTSET : value, 'string'];
}

function medusaDeviceBlock(deviceId, env, nowMillis) {
  const d = env.Device;
  return proto([
    [1, 1, 'sint'],
    [3, '8662', 'string'],
    [4, deviceId, 'string'],
    [5, MEDUSA_NOTSET, 'string'],
    [6, MEDUSA_NOPERM, 'string'],
    [7, MEDUSA_NOPERM_INT, 'sint'],
    [8, MEDUSA_NOPERM_INT, 'sint'],
    [9, 2, 'sint'],
    [10, MEDUSA_NOPERM_INT, 'sint'],
    [11, MEDUSA_NOTSET, 'string'],
    [12, 'Asia/Shanghai,8', 'string'],
    [13, 'zh_CN', 'string'],
    [14, 8, 'sint'],
    [16, d.StorageGB, 'float'],
    [17, d.StorageFreeGB, 'float'],
    [18, d.MemoryGB, 'float'],
    [19, d.MemoryFreeGB, 'float'],
    [20, d.StorageGB * 2, 'float'],
    [21, d.StorageFreeGB * 2, 'float'],
    strField(22, d.OSVersion),
    [23, 60, 'sint'],
    [24, 10, 'sint'],
    [25, d.InstallMillis, 'sint'],
    [26, env.LaunchMillis + 540, 'sint'],
    [27, d.InstallMillis, 'sint'],
    [28, nowMillis, 'sint'],
    [29, 1, 'sint'],
    strField(30, d.Model),
    strField(31, d.Brand),
    [32, MEDUSA_NOTSET, 'string'],
    [33, MEDUSA_NOTSET, 'string'],
    [34, MEDUSA_NOTSET, 'string'],
    strField(35, d.Brand),
    [36, MEDUSA_NOTSET, 'string'],
    [38, 3, 'sint'],
    [40, env.LaunchMillis, 'sint'],
  ]);
}

function medusaV5EnvCurrent(ts, deviceId, env, rnd) {
  const uptime = Math.max(1, ts - Math.floor(env.LaunchMillis / 1000));
  return proto([
    [1, uptime, 'sint'],
    [6, MEDUSA_ENV_VERSION, 'string'],
    [7, env.PID, 'sint'],
    [8, env.Channel, 'string'],
    [12, medusaDeviceBlock(deviceId, env, ts * 1000 + (rnd.Message % 1000)), 'message'],
    [13, EMPTY, 'bytes'],
    [14, env.Device && env.Device.AppVersion ? env.Device.AppVersion : MEDUSA_NOTSET, 'string'],
    [15, env.PPID, 'sint'],
    [18, ts + env.Clock18, 'sint'],
    [19, ts + env.Clock19, 'sint'],
    [20, ts + env.Clock20, 'sint'],
  ]);
}

function medusaV5JsonCurrent(env) {
  return '{"cmr":16777216,"cmr2":16777216,"un_h":' + env.UnH
    + ',"vpn":0,"sts":' + env.Sts
    + ',"kd":0,"fkd":' + env.Fkd
    + ',"pd":' + env.Pd
    + ',"lp":' + JSON.stringify(env.Lp)
    + ',"fl":' + JSON.stringify(env.Fl)
    + ',"dyn":"","do":0,"tk":true}';
}

/** 8 位循环右移（variant 5 的 padding 用）。 */
function ror8(value, count) {
  const n = count & 7;
  return (((value >> n) | (value << (8 - n))) & 255) >>> 0;
}

// f13V5 variant 5（MD5 压缩）常量，来自 openhongguo sign/f13_v5.go。
const F13_V5_IV = [0x79e0f2fb, 0xc8b52570, 0xebc2f8cd, 0x7c104d93];
const F13_V5_FINAL = [0x19be4866, 0xe85986b4, 0xe19b326e, 0x71d1d7d4];
const F13_V5_PAD = [0x84, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8];
const F13_V5_K = [
  0xa7aefe20, 0x7149f1d6, 0x47e4ca07, 0xe9b58f67, 0x93b924de, 0xc614d0f5, 0x38afe0ef, 0xb2bbad73,
  0xe24444c3, 0x9d3aec9b, 0xdf7b37e4, 0xd8b16d40, 0xf8ac31b8, 0x76b9a90b, 0x31d833ee, 0x953fce64,
  0x6a6b2b48, 0x8c138276, 0x6d24a010, 0x18da124b, 0xbbeb82ee, 0x39f7ea56, 0x149f4fe1, 0x229946bc,
  0x0327f309, 0xf4f50e66, 0x62d569aa, 0x78419f92, 0x4db088a7, 0x7430a018, 0xf31d88f4, 0x2f4ed651,
  0x9b13fe59, 0x45c5910d, 0x374bf0ec, 0xd5a5b69e, 0xefaceb16, 0x714f4811, 0x4c98233b, 0xc9e6e7b1,
  0xd0623b3f, 0xdf5e4f6f, 0xccb31244, 0xaddab856, 0x6faf9c9e, 0x62804e10, 0x6fa7e29d, 0x7e429d51,
  0xcdb31e01, 0xb339e419, 0xe497a8a3, 0xebeca6bc, 0x1746cd57, 0xfbf4f54a, 0xd5ea2a8b, 0xb4f02ed2,
  0x0512b192, 0xefad4d29, 0xd59bec05, 0x2a1436e2, 0xfaea73c1, 0x1ebdbae8, 0x8ff257bd, 0x2d59351d,
];
const F13_V5_ORDER = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  0, 10, 5, 14, 3, 4, 15, 13, 6, 1, 12, 8, 9, 7, 11, 2,
  8, 10, 3, 1, 14, 3, 7, 2, 5, 0, 13, 9, 11, 4, 15, 12,
  8, 9, 15, 10, 2, 6, 5, 13, 13, 1, 7, 3, 11, 14, 4, 12,
];
const F13_V5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function f13V5HeadMd5(querySm3, bodyMd5, ts) {
  const input = concat(querySm3, bodyMd5, le32(ts | 0));
  const pad = Buffer.alloc(8);
  for (let i = 0; i < F13_V5_PAD.length; i++) {
    pad[i] = ror8(F13_V5_PAD[i], (ts - 1) & 7);
  }
  const w = (at) => readLe32(input, at) >>> 0;
  const m = [
    w(36), w(32), readLe32(pad, 0) >>> 0, w(24),
    w(40), w(28), readLe32(pad, 4) >>> 0, w(44),
    w(0), w(4), w(8), 0x1a0,
    w(48), w(16), w(20), w(12),
  ];
  const iv = F13_V5_IV.map((v) => ror(v, (ts + 2) & 31));
  let a = iv[0]; let b = iv[1]; let c = iv[2]; let d = iv[3];
  for (let i = 0; i < 64; i++) {
    let f;
    const round = Math.floor(i / 16);
    if (round === 0) f = (d ^ (b & (c ^ d))) | 0;
    else if (round === 1) f = (c ^ (d & (b ^ c))) | 0;
    else if (round === 2) f = (b ^ c ^ d) | 0;
    else f = (c ^ (b | ~d)) | 0;
    const k = ror(F13_V5_K[i], (ts + 3 + round) & 31);
    const x = (a + f + m[F13_V5_ORDER[i]] + k) | 0;
    a = d;
    d = c;
    c = b;
    b = (b + rotl(x, F13_V5_SHIFT[i])) | 0;
  }
  const state = [a, b, c, d];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    putLe32(out, i * 4, ((iv[i] + state[i]) ^ ror(F13_V5_FINAL[i], (ts + 8) & 31)) | 0);
  }
  return out;
}

function f13V5Tail(head) {
  let h = 0x20220420;
  for (let i = 0; i < 8; i++) {
    const cb = head[i] & 0xff;
    if ((i & 1) === 0) h = (((h << 7) ^ cb ^ (h >>> 3) ^ h)) | 0;
    else h = ~(((h << 11) | cb) ^ (h >>> 5) ^ h) | 0;
  }
  const out = le32(h);
  out[0] &= 0xdb;
  out[3] ^= 1;
  return out;
}

/** 与 openhongguo f13V5 一致：返回 variant 5/12 的 20 字节，其他分支返回 null。 */
function hashF13V5Full(querySm3, bodyMd5, ts) {
  const iv = getIv(getIv(getIv(0x20230928, querySm3), bodyMd5), le32(ts | 0));
  const variant = iv & 15;
  if (variant !== 5 && variant !== 12) return null;
  const head = variant === 5
    ? f13V5HeadMd5(querySm3, bodyMd5, ts)
    : sliceBytes(hashF13V5(querySm3, bodyMd5, le32(ts | 0), ts), 0, 16);
  return concat(head, f13V5Tail(head));
}

function medusaInputCurrent(query, body, ts) {
  const q = sm3(Buffer.from(query, 'utf8'));
  const f13 = hashF13V5Full(q, bodyMd5V5(body), ts);
  if (f13 === null) return null;
  return { querySM3: q, f13, ts };
}

/** 模拟器布局的 device block（env.Device 为空时），按 openhongguo medusaV5Device。 */
function medusaDeviceEmulatorCurrent(deviceId, env) {
  const out = [];
  out.push([1, 1, 'sint'], [3, '8662', 'string'], [4, deviceId, 'string']);
  for (let tag = 5; tag <= 40; tag++) {
    if (tag === 5 || tag === 6 || (tag >= 11 && tag <= 13) || tag === 15
        || tag === 22 || (tag >= 30 && tag <= 37)) {
      out.push([tag, MEDUSA_NOTSET, 'string']);
    } else if ((tag >= 7 && tag <= 10) || tag === 14 || (tag >= 23 && tag <= 25)
        || tag === 27 || tag === 29 || tag === 38) {
      out.push([tag, -999999, 'sint']);
    } else if (tag >= 16 && tag <= 21) {
      out.push([tag, -999999, 'float']);
    } else if (tag === 26 || tag === 28 || tag === 40) {
      out.push([tag, env.LaunchMillis, 'sint']);
    }
  }
  return proto(out);
}

function medusaEnvGeneric(ts, deviceId, env, rnd) {
  if (env.Device !== null && env.Device !== undefined) {
    return medusaV5EnvCurrent(ts, deviceId, Object.assign({}, env, {
      Device: env.Device,
    }), rnd);
  }
  return proto([
    [6, MEDUSA_ENV_VERSION, 'string'],
    [7, env.PID, 'sint'],
    [8, env.Channel, 'string'],
    [12, medusaDeviceEmulatorCurrent(deviceId, env), 'message'],
    [13, EMPTY, 'bytes'],
    [14, MEDUSA_NOTSET, 'string'],
    [15, env.PPID, 'sint'],
    [18, ts + env.Clock18, 'sint'],
    [19, ts + env.Clock19, 'sint'],
    [20, ts + env.Clock20, 'sint'],
  ]);
}

/** 可传入固定 env/rnd，供上游测试向量逐字节比对。 */
function medusaMessageCurrent(input, deviceId, env, rnd) {
  const device = env.Device === null || env.Device === undefined ? null : env.Device;
  const flags = device === null ? MEDUSA_EMULATOR_FLAGS : MEDUSA_DEVICE_FLAGS;
  const counters = device === null
    ? [[1, MEDUSA_UNSET, 'sint'], [2, MEDUSA_UNSET, 'sint'],
      [3, MEDUSA_UNSET, 'sint'], [5, MEDUSA_UNSET, 'sint']]
    : [[1, env.Counter || 1, 'sint'], [2, 5, 'sint'],
      [3, MEDUSA_UNSET, 'sint'], [5, MEDUSA_UNSET, 'sint']];
  const fields = [
    [1, V5.MAGIC16, 'bytes'],
    [2, 5, 'sint'],
    [3, rnd.Message, 'sint'],
    [4, '8662', 'string'],
    [5, deviceId, 'string'],
    [6, V5.LICENSE, 'string'],
  ];
  if (device !== null && device.AppVersion) fields.push([7, device.AppVersion, 'string']);
  fields.push(
    [8, MEDUSA_SDK_VERSION, 'string'],
    [9, MEDUSA_SDK_CODE, 'sint'],
    [10, flags, 'bytes'],
    [12, input.ts, 'sint'],
    [13, input.f13, 'bytes'],
    [14, input.querySM3.subarray(0, 6), 'bytes'],
    [15, proto(counters), 'message'],
    [17, input.ts, 'sint'],
    [20, 'none', 'string'],
    [21, env.Status, 'sint'],
    [23, medusaEnvGeneric(input.ts, deviceId, env, rnd), 'message'],
    [24, medusaV5JsonCurrent(env), 'string']);
  return proto(fields);
}

/** 可传入固定 env/rnd，供上游测试向量逐字节比对。 */
function assembleMedusaV5Current(input, deviceId, env, rnd) {
  const device = env.Device === null || env.Device === undefined ? null : env.Device;
  const flags = device === null ? MEDUSA_EMULATOR_FLAGS : MEDUSA_DEVICE_FLAGS;
  const message = medusaMessageCurrent(input, deviceId, env, rnd);

  const hash = sm3(concat(V5.SIGN_KEY, le32(rnd.Key), V5.SIGN_KEY));
  const high = (rnd.Key >>> 16) & 255;
  const seed = le32(~((((high << 11) | (rnd.Key >>> 24)) ^ (high >>> 5) ^ high)) | 0);
  let transformed = concat(flags, xmxor(message, hash));
  transformed = Buffer.from(transformed).reverse();
  for (let i = 0; i < transformed.length; i++) {
    transformed[i] = (transformed[i] ^ seed[(~i) & 3]) & 0xff;
  }
  const check = (0x18000001 | ((input.querySM3[0] & 63) << 14)
    | ((input.f13[0] & 63) << 8)) | 0;
  const packed = concat(Buffer.from([0xca]), le32(rnd.Packed), le32(check), transformed,
    Buffer.from([(rnd.Key >>> 16) & 255, (rnd.Key >>> 24) & 255]));
  const encrypted = new AesV3(md5(V5.SIGN_KEY.subarray(0, 16)), input.ts, true)
    .encrypt(packed, md5(V5.SIGN_KEY.subarray(16, 32)));
  const prefix = concat(le32(5), V5.MAGIC16);
  const tsBytes = le32(input.ts | 0);
  for (let i = 0; i < prefix.length; i++) prefix[i] = (prefix[i] ^ tsBytes[i & 3]) & 0xff;
  return b64(concat(prefix,
    Buffer.from([rnd.Key & 255, (rnd.Key >>> 8) & 255, 0, 1]), encrypted));
}

/** 按 openhongguo v0.4.1 的真机布局构造 x-medusa（player/v1 主链路）。 */
function buildMedusaV5Current(url, body, ts, query, deviceId) {
  const input = medusaInputCurrent(query, body, ts);
  if (input === null) throw new Error('x-medusa 命中不支持的 f13 分支');
  const id = String(deviceId || '0');
  const baseEnv = processMedusaEnv();
  const device = medusaDeviceOf(query, id);
  const env = Object.assign({}, baseEnv, {
    Device: device,
    Counter: device === null ? 1 : nextMedusaCount(),
  });
  const rnd = {
    Message: rndUint31(),
    Key: rndUint31(),
    Packed: rndUint31(),
  };
  return assembleMedusaV5Current(input, id, env, rnd);
}

/**
 * player/v1 主链路签名。values 里必须预置 `_rticket` 占位符，
 * 因为它的位置属于 query 顺序的一部分（openhongguo 抓包在第 4 位）。
 */
function signPlaybackV5Current(base, values, body, now) {
  const baseMs = (now === undefined || now === null) ? Date.now() : now;
  const ts = Math.floor(baseMs / 1000);
  const vals = Object.assign({}, values);
  const deviceId = String(vals.device_id || '0');
  for (let offset = 0; offset <= 1023; offset++) {
    vals._rticket = String(baseMs + offset);
    const query = encodeQuery(vals);
    const url = base + '?' + query;
    if (branchV5(url, body, ts) !== 0) continue;
    const headers = {
      'x-khronos': String(ts),
      'x-helios': heliosWith(ts, rndUint31(), V5.LICENSE),
      'x-medusa': buildMedusaV5Current(url, body, ts, query, deviceId),
      'x-xs-from-web': '0',
    };
    if (body !== null && body.length > 0) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['x-ss-stub'] = md5(body).toString('hex').toUpperCase();
    }
    return { url, headers, query, ticket: baseMs + offset };
  }
  throw new Error('无法生成 player/v1 播放签名（1024 个 ticket 内未命中分支）');
}

module.exports = {
  sign,
  branchOf,
  signPlaybackV5,
  signPlaybackV5Current,
  branchV5,
  hashF13V5,
  buildMedusaV5,
  buildMedusaV5Current,
  medusaInputCurrent,
  medusaMessageCurrent,
  assembleMedusaV5Current,
  javaUrlEncode,
  xmxor,
  AesV3,
};
