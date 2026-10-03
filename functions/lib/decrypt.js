// ============================================================
// decrypt.js - 严格循环：清理 → 解密 → 判断 → 循环
// ============================================================

/**
 * 清理函数：任何一次拿到文本，第一步就执行
 * 删注释、删换行回车制表、压缩空格
 */
function clean(text) {
  if (typeof text !== 'string') {
    try { text = new TextDecoder('utf-8').decode(text); } catch { text = String(text); }
  }
  // 删 // 单行注释
  text = text.replace(/\/\/.*/g, '');
  // 删 /* 多行注释 */
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // 删换行、回车、制表
  text = text.replace(/[\n\r\t]/g, '');
  // 压缩连续空格
  text = text.replace(/ {2,}/g, ' ');
  return text.trim();
}

/**
 * 判断是否是 JSON 明文
 */
function isJson(text) {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object';
  } catch {
    return false;
  }
}

/**
 * Base64 解码
 */
function b64Decode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/').trim();
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * hex 转 bytes
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * AES-128-CBC 解密
 */
async function aesDecrypt(ciphertext, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, ciphertext);
  return new TextDecoder('utf-8').decode(new Uint8Array(decrypted)).trim();
}

/**
 * 尝试 2423 系列解密
 */
async function try2423(content) {
  // hex: 2423<hex>2324
  let m = content.match(/^2423([0-9a-fA-F]+)2324$/);
  if (m) {
    const bytes = hexToBytes(m[1]);
    if (bytes.length >= 32) {
      const iv = bytes.slice(0, 16);
      const cipher = bytes.slice(16);
      const keys = [
        new TextEncoder().encode("1234567890123456"),
        new TextEncoder().encode("tvbox1234567890"),
        new TextEncoder().encode("iptvbox12345678"),
        iv,
      ];
      for (const k of keys) {
        try { return await aesDecrypt(cipher.buffer, k.slice(0, 16), iv); } catch {}
      }
    }
  }
  // plain: 2423<inner>2324
  m = content.match(/^2423(.+?)2324$/s);
  if (m) {
    const inner = m[1].trim();
    try { return new TextDecoder('utf-8').decode(b64Decode(inner)); } catch {}
    if (inner.length > 5) return inner;
  }
  return null;
}

/**
 * 尝试 AES+Base64（非2423包装）
 */
async function tryAesB64(content) {
  try {
    const bytes = b64Decode(content);
    if (bytes.length < 32) return null;
    const iv = bytes.slice(0, 16);
    const cipher = bytes.slice(16);
    const keys = [
      new TextEncoder().encode("1234567890123456"),
      new TextEncoder().encode("tvbox1234567890"),
      new TextEncoder().encode("iptvbox12345678"),
      iv,
    ];
    for (const k of keys) {
      try { return await aesDecrypt(cipher.buffer, k.slice(0, 16), iv); } catch {}
    }
  } catch {}
  return null;
}

/**
 * 尝试 Gzip+Base64
 */
async function tryGzipB64(content) {
  try {
    const bytes = b64Decode(content);
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const result = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder('utf-8').decode(result).trim();
  } catch {}
  return null;
}

/**
 * 单次解密处理：从一段清理后的文本中提取并尝试解密
 */
async function processOnce(cleanedText) {
  // 1. 尝试直接匹配 2423...2324
  const patMatch = cleanedText.match(/2423[\s\S]*?2324/);
  if (patMatch) {
    const r = await try2423(patMatch[0]);
    if (r) return r;
  }

  // 2. 提取 Base64 长串
  const b64Matches = cleanedText.match(/[A-Za-z0-9+/=_-]{20,}/g) || [];
  for (const b64 of b64Matches) {
    if (b64.startsWith('iVBOR') || b64.startsWith('89504E') || b64.startsWith('PHN2')) continue;

    // 2a. 解码后递归判断
    try {
      const decoded = new TextDecoder('utf-8').decode(b64Decode(b64));
      if (decoded.includes('2423')) {
        const r = await try2423(decoded);
        if (r) return r;
      }
      if (isJson(decoded)) return decoded;
      // 返回解码文本让外层循环继续处理
      return decoded;
    } catch {}

    // 2b. AES+Base64
    const r1 = await tryAesB64(b64);
    if (r1) return r1;

    // 2c. Gzip+Base64
    const r2 = await tryGzipB64(b64);
    if (r2) return r2;
  }

  // 3. 整体当 Base64 试一次
  try {
    const decoded = new TextDecoder('utf-8').decode(b64Decode(cleanedText));
    return decoded;
  } catch {}

  return null;
}

/**
 * 核心循环：清理 → 处理 → 判断JSON → 不是就重复
 */
async function decryptLoop(rawInput, depth = 0) {
  if (depth > 20) {
    // 超过深度，返回最后清理结果
    return clean(rawInput);
  }

  // ★ 第一步：清理（每次都先执行）
  const cleaned = clean(rawInput);

  // 已经是 JSON 明文？直接格式化返回
  if (isJson(cleaned)) {
    return JSON.stringify(JSON.parse(cleaned), null, 2);
  }

  // ★ 第二步：处理解密
  const processed = await processOnce(cleaned);

  if (!processed || processed === cleaned) {
    // 解密没产出新内容，返回当前清理结果
    return cleaned;
  }

  // ★ 第三步：判断结果
  const processedClean = clean(processed);
  if (isJson(processedClean)) {
    return JSON.stringify(JSON.parse(processedClean), null, 2);
  }

  // ★ 不是 JSON → 重复：回到第一步（清理 → 处理 → 判断）
  return decryptLoop(processed, depth + 1);
}

/**
 * 路径补全
 */
function absolutize(jsonStr, baseUrl) {
  try {
    const obj = JSON.parse(jsonStr);
    const base = new URL(baseUrl);
    function resolve(node) {
      if (Array.isArray(node)) return node.map(resolve);
      if (node && typeof node === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && /^(url|link|src|pic|img|.*Url|.*Link)$/i.test(k)) {
            try { result[k] = new URL(v, base).toString(); } catch { result[k] = v; }
          } else {
            result[k] = resolve(v);
          }
        }
        return result;
      }
      return node;
    }
    return JSON.stringify(resolve(obj), null, 2);
  } catch {
    return jsonStr;
  }
}

/**
 * 主入口
 */
export async function decryptAndProcess(rawText, sourceUrl) {
  // 循环解密（内部每一步都先 clean）
  let result = await decryptLoop(rawText, 0);

  // 最终判断：如果是 JSON 就路径补全
  const finalClean = clean(result);
  if (isJson(finalClean)) {
    return absolutize(JSON.stringify(JSON.parse(finalClean), null, 2), sourceUrl);
  }

  // 不是 JSON，返回清理后的文本
  return result;
}
