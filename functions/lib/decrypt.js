// ============================================================
// TVBox 解密库 v3 - 严格流程：清理 → 判断 → 解密 → 循环
// ============================================================

/**
 * 第一步：清理文本（删注释、换行、回车、制表、压缩空格）
 * 任何拿到手的文本都先过这个函数
 */
function cleanText(text) {
  if (typeof text !== 'string') {
    try { text = new TextDecoder('utf-8').decode(text); } catch { text = String(text); }
  }
  // 删 // 单行注释
  text = text.replace(/\/\/.*/g, '');
  // 删 /* 多行注释 */
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // 删换行、回车、制表
  text = text.replace(/[\n\r\t]/g, '');
  // 压缩连续空格为单个空格
  text = text.replace(/ {2,}/g, ' ');
  return text.trim();
}

/**
 * 判断是否是 JSON 明文（对象或数组）
 */
function isPlainJson(text) {
  try {
    const obj = JSON.parse(text);
    if (obj && (typeof obj === 'object')) return true;
  } catch {}
  return false;
}

/**
 * Base64 解码（支持 URL-safe）
 */
function base64Decode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/').trim();
  while (s.length % 4) s += '=';
  try {
    const binary = atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new Error('Base64 解码失败');
  }
}

/**
 * 十六进制转 bytes
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
async function aes128Decrypt(ciphertext, key, iv) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'AES-CBC' }, false, ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv }, cryptoKey, ciphertext
  );
  return new Uint8Array(decrypted);
}

/**
 * 尝试 2423 系列解密
 */
async function tryDecrypt2423(content) {
  // hex 形态: 2423<hex>2324
  let match = content.match(/^2423([0-9a-fA-F]+)2324$/);
  if (match) {
    const hex = match[1];
    if (hex.length >= 32) {
      try {
        const bytes = hexToBytes(hex);
        const iv = bytes.slice(0, 16);
        const cipher = bytes.slice(16);
        const keys = [
          new TextEncoder().encode("1234567890123456"),
          new TextEncoder().encode("tvbox1234567890"),
          new TextEncoder().encode("iptvbox12345678"),
          iv,
        ];
        for (const key of keys) {
          try {
            const plain = await aes128Decrypt(cipher.buffer, key.slice(0, 16), iv);
            const text = new TextDecoder('utf-8').decode(plain).trim();
            if (text.length > 5) return text;
          } catch {}
        }
      } catch {}
    }
  }

  // plain 形态: 2423<base64_or_text>2324
  match = content.match(/^2423(.+?)2324$/s);
  if (match) {
    const inner = match[1].trim();
    // 尝试 inner 是 Base64
    try {
      const bytes = base64Decode(inner);
      const text = new TextDecoder('utf-8').decode(bytes).trim();
      if (text.length > 5) return text;
    } catch {}
    // 直接返回
    if (inner.length > 5) return inner;
  }

  return null;
}

/**
 * 尝试 AES + Base64（非 2423 包装）
 */
async function tryAesBase64(content) {
  try {
    const bytes = base64Decode(content);
    if (bytes.length < 32) return null;
    const iv = bytes.slice(0, 16);
    const cipher = bytes.slice(16);
    const keys = [
      new TextEncoder().encode("1234567890123456"),
      new TextEncoder().encode("tvbox1234567890"),
      new TextEncoder().encode("iptvbox12345678"),
      iv,
    ];
    for (const key of keys) {
      try {
        const plain = await aes128Decrypt(cipher.buffer, key.slice(0, 16), iv);
        const text = new TextDecoder('utf-8').decode(plain).trim();
        if (text.length > 5) return text;
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * 尝试 Gzip + Base64
 */
async function tryGzipBase64(content) {
  try {
    const bytes = base64Decode(content);
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const result = await new Response(ds.readable).arrayBuffer();
    const text = new TextDecoder('utf-8').decode(result).trim();
    if (text.length > 5) return text;
  } catch {}
  return null;
}

/**
 * 核心递归：清理 → 判断 → 解密 → 循环
 */
async function deepDecrypt(rawInput, depth = 0) {
  if (depth > 15) {
    // 超过递归深度，返回清理后的文本
    return cleanText(rawInput);
  }

  // ===== 第一步：清理 =====
  const cleaned = cleanText(rawInput);

  // ===== 第二步：判断是否是 JSON 明文 =====
  if (isPlainJson(cleaned)) {
    // 格式化输出
    try {
      const obj = JSON.parse(cleaned);
      return JSON.stringify(obj, null, 2);
    } catch {
      return cleaned;
    }
  }

  // ===== 第三步：不是明文，尝试提取加密段 =====

  // 3a. 提取所有看起来像 Base64 的长串
  const b64Matches = cleaned.match(/[A-Za-z0-9+/=_-]{20,}/g) || [];
  for (const b64 of b64Matches) {
    // 跳过明显是 PNG 头或其他垃圾
    if (b64.startsWith('iVBOR') || b64.startsWith('89504E')) continue;

    try {
      const decoded = base64Decode(b64);
      const decodedText = new TextDecoder('utf-8').decode(decoded);

      // 解码后是 2423 格式 → 解密
      if (decodedText.includes('2423')) {
        const decrypted = await tryDecrypt2423(decodedText);
        if (decrypted) {
          const result = await deepDecrypt(decrypted, depth + 1);
          if (isPlainJson(cleanText(result))) return result;
        }
      }

      // 解码后直接是 JSON
      if (isPlainJson(cleanText(decodedText))) {
        return JSON.stringify(JSON.parse(cleanText(decodedText)), null, 2);
      }

      // 解码后继续递归
      const result = await deepDecrypt(decodedText, depth + 1);
      if (isPlainJson(cleanText(result))) return result;
    } catch {}

    // 尝试 AES + Base64
    try {
      const aesResult = await tryAesBase64(b64);
      if (aesResult) {
        const result = await deepDecrypt(aesResult, depth + 1);
        if (isPlainJson(cleanText(result))) return result;
      }
    } catch {}

    // 尝试 Gzip + Base64
    try {
      const gzipResult = await tryGzipBase64(b64);
      if (gzipResult) {
        const result = await deepDecrypt(gzipResult, depth + 1);
        if (isPlainJson(cleanText(result))) return result;
      }
    } catch {}
  }

  // 3b. 直接匹配 2423...2324 模式
  const patternMatches = cleaned.match(/2423[\s\S]*?2324/g) || [];
  for (const pat of patternMatches) {
    const decrypted = await tryDecrypt2423(pat);
    if (decrypted) {
      const result = await deepDecrypt(decrypted, depth + 1);
      if (isPlainJson(cleanText(result))) return result;
    }
  }

  // 3c. 尝试整体 Base64
  try {
    const decoded = base64Decode(cleaned);
    const decodedText = new TextDecoder('utf-8').decode(decoded);
    const result = await deepDecrypt(decodedText, depth + 1);
    if (isPlainJson(cleanText(result))) return result;
  } catch {}

  // ===== 全部失败，返回清理后的文本 =====
  return cleaned;
}

/**
 * 路径补全
 */
function absolutizeJson(jsonStr, baseUrl) {
  try {
    const obj = JSON.parse(jsonStr);
    const base = new URL(baseUrl);
    function resolve(node) {
      if (Array.isArray(node)) return node.map(resolve);
      if (node && typeof node === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && (k === 'url' || k === 'link' || k === 'src' || k === 'pic' || k === 'img' || k.endsWith('Url') || k.endsWith('Link'))) {
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
 * 主入口：decryptAndProcess
 * 流程：拿到原始文本 → 清理 → 递归解密 → 路径补全 → 返回
 */
export async function decryptAndProcess(rawText, sourceUrl) {
  // 递归解密（内部每一步都会先 cleanText）
  let result = await deepDecrypt(rawText, 0);

  // 最终清理一次
  const finalCleaned = cleanText(result);

  // 如果是 JSON，做路径补全
  if (isPlainJson(finalCleaned)) {
    try {
      const formatted = JSON.stringify(JSON.parse(finalCleaned), null, 2);
      return absolutizeJson(formatted, sourceUrl);
    } catch {
      return result;
    }
  }

  // 不是 JSON，返回清理后的文本（至少没有换行空格了）
  return result;
}
