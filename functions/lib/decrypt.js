// ============================================================
// TVBox 解密工具库 (JavaScript/WebCrypto 移植版)
// 完整移植自 Python 原版逻辑
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
 * Uint8Array 转十六进制字符串
 */
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Base64 解码（支持 URL-safe）
 */
function base64Decode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
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
 * 尝试 2423/2324 hex 形态解密
 */
async function tryDecrypt2423Hex(content, sourceUrl) {
  const match = content.match(/^2423([0-9a-fA-F]+)2324/);
  if (!match) return null;
  const hex = match[1];
  if (hex.length < 32) return null;
  const bytes = hexToBytes(hex);
  // 前16字节IV，16字节后开始是密文
  const iv = bytes.slice(0, 16);
  const cipher = bytes.slice(16);
  // 尝试多种 key 派生
  const keys = [
    new TextEncoder().encode("1234567890123456"),
    new TextEncoder().encode("tvbox1234567890"),
    new TextEncoder().encode("iptvbox12345678"),
    iv,
  ];
  for (const key of keys) {
    try {
      const plain = await aes128Decrypt(cipher.buffer, key.slice(0, 16), iv);
      const text = new TextDecoder().decode(plain).trim();
      if (text.startsWith('{') || text.startsWith('[')) return text;
    } catch {}
  }
  return null;
}

/**
 * 尝试 2423/2324 plain 形态解密
 */
async function tryDecrypt2423Plain(content, sourceUrl) {
  const match = content.match(/^2423(.+)2324$/s);
  if (!match) return null;
  const inner = match[1];
  try {
    const decoded = atob(inner);
    if (decoded.trim().startsWith('{') || decoded.trim().startsWith('[')) return decoded.trim();
  } catch {}
  // 尝试 hex
  try {
    const bytes = hexToBytes(inner);
    const text = new TextDecoder().decode(bytes);
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) return text.trim();
  } catch {}
  return null;
}

/**
 * 尝试 Base64 解码
 */
function tryBase64Decode(content) {
  try {
    const decoded = atob(content.replace(/-/g, '+').replace(/_/g, '/'));
    if (decoded.trim().startsWith('{') || decoded.trim().startsWith('[')) return decoded.trim();
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
    const text = new TextDecoder().decode(decompressed).trim();
    if (text.startsWith('{') || text.startsWith('[')) return text;
  } catch {}
  return null;
}

/**
 * 尝试 AES-128-CBC + Base64
 */
async function tryAesBase64(content, sourceUrl) {
  try {
    const bytes = base64Decode(content);
    if (bytes.length < 32) return null;
    const iv = bytes.slice(0, 16);
    const cipher = bytes.slice(16);
    const keys = [
      new TextEncoder().encode("1234567890123456"),
      new TextEncoder().encode("tvbox1234567890"),
      new TextEncoder().encode("iptvbox12345678"),
    ];
    for (const key of keys) {
      try {
        const plain = await aes128Decrypt(cipher.buffer, key.slice(0, 16), iv);
        const text = new TextDecoder().decode(plain).trim();
        if (text.startsWith('{') || text.startsWith('[')) return text;
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * 递归查找并解密（对应 Python 的 find_result）
 * 拿到响应文本后，先删除注释换行和空格再处理
 */
async function findResult(rawBytes, sourceUrl) {
  // 如果输入是 bytes，转成 string
  let content = typeof rawBytes === 'string' ? rawBytes : new TextDecoder().decode(rawBytes);
  content = content.trim();

  // 0. 先删除注释换行和空格
  content = cleanJsonComments(content);
  content = collapseWhitespace(content);

  // 1. 先尝试直接 JSON 解析
  try {
    JSON.parse(content);
    return content;
  } catch {}

  // 2. 尝试 2423/2324 hex
  const r1 = await tryDecrypt2423Hex(content, sourceUrl);
  if (r1) return r1;

  // 3. 尝试 2423/2324 plain
  const r2 = await tryDecrypt2423Plain(content, sourceUrl);
  if (r2) return r2;

  // 4. 尝试 AES + Base64
  const r3 = await tryAesBase64(content, sourceUrl);
  if (r3) return r3;

  // 5. 尝试 Gzip + Base64
  const r4 = await tryGzipBase64(content);
  if (r4) return r4;

  // 6. 尝试 Base64
  const r5 = tryBase64Decode(content);
  if (r5) return r5;

  // 7. 尝试 ** 分隔符
  if (content.includes('**')) {
    const parts = content.split('**');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 10) {
        const sub = await findResult(trimmed, sourceUrl);
        if (sub && (sub.trim().startsWith('{') || sub.trim().startsWith('['))) return sub;
      }
    }
  }

  // 8. 如果什么都不是，返回原始内容
  return content;
}

/**
 * 删除注释（对应 Python 的 clean_json_comments）
 */
function cleanJsonComments(text) {
  // 删除 // 单行注释
  text = text.replace(/\/\/.*$/gm, '');
  // 删除 /* */ 多行注释
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return text;
}

/**
 * 压缩空白（对应 Python 的 collapse_whitespace）
 */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 提取 JSON 片段（对应 Python 的 extract_json）
 */
function extractJson(text) {
  text = cleanJsonComments(text);
  // 尝试找到 { } 或 [ ] 的完整 JSON
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
 * 过滤 JSON 字段（对应 Python 的 filter_json）
 */
function filterJson(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr);
    // 递归过滤空值
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
 * 路径补全（对应 Python 的 absolutize_json）
 */
function absolutizeJson(jsonStr, baseUrl) {
  try {
    const obj = JSON.parse(jsonStr);
    const base = new URL(baseUrl);
    function resolve(node) {
      if (Array.isArray(node)) {
        return node.map(resolve);
      }
      if (node && typeof node === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && (k === 'url' || k === 'link' || k === 'src' || k === 'pic' || k === 'img' || k.endsWith('Url') || k.endsWith('Link'))) {
            try {
              result[k] = new URL(v, base).toString();
            } catch {
              result[k] = v;
            }
          } else {
            result[k] = resolve(v);
          }
        }
        return result;
      }
      return node;
    }
    const resolved = resolve(obj);
    return JSON.stringify(resolved, null, 2);
  } catch {
    return jsonStr;
  }
}

/**
 * 主入口：解密并处理（对应 Python 的 decrypt_and_process）
 * 拿到响应文本后 → 删除注释换行空格 → 处理 → 格式化输出
 */
export async function decryptAndProcess(rawText, sourceUrl) {
  // Step 1: 删除注释
  let cleaned = cleanJsonComments(rawText);
  // Step 2: 递归解密（过程中会压缩空白）
  let decrypted = await findResult(cleaned, sourceUrl);
  // Step 3: 提取 JSON 片段
  let extracted = extractJson(decrypted);
  // Step 4: 过滤字段 + 格式化
  let filtered = filterJson(extracted);
  // Step 5: 路径补全 + 最终格式化输出
  let final = absolutizeJson(filtered, sourceUrl);
  return final;
}
