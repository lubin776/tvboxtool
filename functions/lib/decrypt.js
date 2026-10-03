// ============================================================
// TVBox 解密工具库 v2 - 支持混合数据剥离 + 多层套壳解密
// ============================================================

/**
 * 十六进制字符串转 Uint8Array
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
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
 * Gzip 解压
 */
async function gzipDecompress(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const result = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(result);
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
 * 判断字符串是否像 Base64
 */
function looksLikeBase64(str) {
  // 至少 20 字符，只包含 Base64 合法字符
  return str.length >= 20 && /^[A-Za-z0-9+/=_-]+$/.test(str.trim());
}

/**
 * 从混合文本中提取可能的加密段
 * 处理 PNG 头 + 文本 + Base64/2423 混合的情况
 */
function extractEncryptedSegments(text) {
  const segments = [];
  
  // 方法1：提取所有看起来像 Base64 的长串
  const base64Matches = text.match(/[A-Za-z0-9+/=_-]{20,}/g);
  if (base64Matches) {
    for (const m of base64Matches) {
      if (looksLikeBase64(m)) {
        segments.push(m);
      }
    }
  }
  
  // 方法2：提取 2423...2324 模式
  const patternMatches = text.match(/2423[\s\S]*?2324/g);
  if (patternMatches) {
    for (const m of patternMatches) {
      segments.push(m);
    }
  }
  
  // 方法3：提取 ** 分隔的段
  if (text.includes('**')) {
    const parts = text.split('**');
    for (const p of parts) {
      if (p.trim().length > 20) segments.push(p.trim());
    }
  }
  
  // 去重
  return [...new Set(segments)];
}

/**
 * 尝试 2423/2324 hex 形态解密
 */
async function tryDecrypt2423Hex(content) {
  // 匹配 2423 开头 2324 结尾
  const match = content.match(/^2423([0-9a-fA-F]+)2324$/);
  if (!match) return null;
  const hex = match[1];
  if (hex.length < 32) return null;
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
      if (text.startsWith('{') || text.startsWith('[')) return text;
    } catch {}
  }
  return null;
}

/**
 * 尝试 2423/2324 plain 形态解密
 */
async function tryDecrypt2423Plain(content) {
  const match = content.match(/^2423(.+?)2324$/s);
  if (!match) return null;
  const inner = match[1];
  // 尝试 Base64 解码 inner
  try {
    const bytes = base64Decode(inner);
    const text = new TextDecoder('utf-8').decode(bytes).trim();
    if (text.startsWith('{') || text.startsWith('[')) return text;
  } catch {}
  // 尝试直接当文本
  if (inner.trim().startsWith('{') || inner.trim().startsWith('[')) return inner.trim();
  return null;
}

/**
 * 尝试 AES-128-CBC + Base64
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
        if (text.startsWith('{') || text.startsWith('[')) return text;
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
    const decompressed = await gzipDecompress(bytes);
    const text = new TextDecoder('utf-8').decode(decompressed).trim();
    if (text.startsWith('{') || text.startsWith('[')) return text;
  } catch {}
  return null;
}

/**
 * 递归查找并解密（核心入口）
 */
async function findResult(rawInput) {
  // 转成字符串
  let content = typeof rawInput === 'string' 
    ? rawInput 
    : new TextDecoder('utf-8').decode(rawInput);
  content = content.trim();

  // 1. 先尝试直接 JSON 解析
  try {
    JSON.parse(content);
    return content;
  } catch {}

  // 2. 从混合数据中提取加密段
  const segments = extractEncryptedSegments(content);
  
  for (const seg of segments) {
    // 2a. 尝试直接是 2423 hex
    const r1 = await tryDecrypt2423Hex(seg);
    if (r1) return r1;

    // 2b. 尝试 2423 plain
    const r2 = await tryDecrypt2423Plain(seg);
    if (r2) return r2;

    // 2c. 尝试 Base64 解码后再递归
    try {
      const decoded = base64Decode(seg);
      const decodedText = new TextDecoder('utf-8').decode(decoded).trim();
      
      // 解码后是 2423 格式
      if (decodedText.startsWith('2423')) {
        const r3 = await tryDecrypt2423Hex(decodedText) || await tryDecrypt2423Plain(decodedText);
        if (r3) return r3;
      }
      
      // 解码后是 JSON
      if (decodedText.startsWith('{') || decodedText.startsWith('[')) {
        return decodedText;
      }
      
      // 解码后继续递归
      const r4 = await findResult(decodedText);
      if (r4 && (r4.trim().startsWith('{') || r4.trim().startsWith('['))) return r4;
    } catch {}

    // 2d. 尝试 AES + Base64
    const r5 = await tryAesBase64(seg);
    if (r5) return r5;

    // 2e. 尝试 Gzip + Base64
    const r6 = await tryGzipBase64(seg);
    if (r6) return r6;
  }

  // 3. 尝试直接 Base64（整体）
  try {
    const decoded = base64Decode(content);
    const decodedText = new TextDecoder('utf-8').decode(decoded).trim();
    if (decodedText.startsWith('{') || decodedText.startsWith('[')) return decodedText;
    const r = await findResult(decodedText);
    if (r) return r;
  } catch {}

  // 4. 全部失败，返回原始内容（去掉 PNG 头等非文本垃圾）
  const cleaned = content.replace(/^\s*\u0089PNG[\s\S]*?(?=[A-Za-z0-9+/=]{20,}|2423|\{)/m, '').trim();
  return cleaned;
}

/**
 * 删除注释
 */
function cleanJsonComments(text) {
  text = text.replace(/\/\/.*$/gm, '');
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return text;
}

/**
 * 提取 JSON 片段
 */
function extractJson(text) {
  text = cleanJsonComments(text);
  const patterns = [
    /\{[\s\S]*\}/,
    /\[[\s\S]*\]/,
  ];
  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) {
      try {
        JSON.parse(match[0]);
        return match[0];
      } catch {}
    }
  }
  return text;
}

/**
 * 过滤 JSON 字段
 */
function filterJson(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr);
    function clean(node) {
      if (Array.isArray(node)) {
        return node.map(clean).filter(v => v !== null && v !== undefined && v !== '');
      }
      if (node && typeof node === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(node)) {
          if (v === null || v === undefined || v === '') continue;
          result[k] = clean(v);
        }
        return result;
      }
      return node;
    }
    const cleaned = clean(obj);
    return JSON.stringify(cleaned, null, 2);
  } catch {
    return jsonStr;
  }
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
 * 主入口：拿到响应文本 → 删除注释 → 解密 → 格式化输出
 */
export async function decryptAndProcess(rawText, sourceUrl) {
  // 清理 PNG/二进制垃圾头
  let cleaned = rawText.replace(/^\s*\u0089?PNG[\s\S]*?(?=2423|MjQy|eyJ|\{)/i, '').trim();
  cleaned = cleanJsonComments(cleaned);
  
  // 递归解密
  let decrypted = await findResult(cleaned);
  
  // 提取 JSON
  let extracted = extractJson(decrypted);
  
  // 过滤 + 格式化
  let filtered = filterJson(extracted);
  
  // 路径补全 + 最终输出
  let final = absolutizeJson(filtered, sourceUrl);
  
  return final;
}
