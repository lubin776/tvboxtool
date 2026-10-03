// ============================================================
// TVBox 解密工具库 (JavaScript/WebCrypto 移植版)
// 修正：清洗不破坏 JSON + 中文 Unicode 还原 + 标准 JSON 输出
// ============================================================

/* ---------- 基础工具 ---------- */

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64Decode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzipDecompress(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const result = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(result);
}

async function aes128Decrypt(ciphertext, key, iv) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'AES-CBC' }, false, ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv }, cryptoKey, ciphertext
  );
  return new Uint8Array(decrypted);
}

/* ---------- 字符串感知的注释清理（不误伤 http:// ） ---------- */

function stripJsonComments(input) {
  let out = "";
  let inStr = false;
  let quote = "";
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    const n = input[i + 1];

    if (inStr) {
      out += c;
      if (c === "\\") { // 转义字符，连同下一个字符一起保留
        if (n !== undefined) { out += n; i += 2; continue; }
      }
      if (c === quote) inStr = false;
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      inStr = true; quote = c; out += c; i++;
      continue;
    }

    // 单行注释
    if (c === "/" && n === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    // 多行注释
    if (c === "/" && n === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/* ---------- 中文 Unicode 转义还原 ---------- */

// 把 \uXXXX（含中文）还原为可读字符；支持多层转义
function restoreUnicodeEscape(str) {
  if (typeof str !== "string") return str;
  let prev;
  let cur = str;
  for (let k = 0; k < 3; k++) {
    prev = cur;
    cur = cur.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
    if (cur === prev) break;
  }
  return cur;
}

// 递归还原对象里所有字符串的中文
function deepRestoreUnicode(node) {
  if (typeof node === "string") return restoreUnicodeEscape(node);
  if (Array.isArray(node)) return node.map(deepRestoreUnicode);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepRestoreUnicode(v);
    return out;
  }
  return node;
}

/* ---------- 尝试提取 JSON 片段（不改内容） ---------- */

function extractJsonFragment(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return trimmed;
  }

  const patterns = [/\{[\s\S]*\}/, /\[[\s\S]*\]/];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      try { JSON.parse(m[0]); return m[0]; } catch {}
    }
  }
  return text;
}

/* ---------- 各解密尝试 ---------- */

async function tryDecrypt2423Hex(content) {
  const match = content.match(/^2423([0-9a-fA-F]+)2324/);
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
      const text = new TextDecoder().decode(plain).trim();
      if (text.startsWith("{") || text.startsWith("[")) return text;
    } catch {}
  }
  return null;
}

async function tryDecrypt2423Plain(content) {
  const match = content.match(/^2423(.+)2324$/s);
  if (!match) return null;
  const inner = match[1];
  try {
    const decoded = atob(inner);
    if (decoded.trim().startsWith("{") || decoded.trim().startsWith("[")) return decoded.trim();
  } catch {}
  try {
    const bytes = hexToBytes(inner);
    const text = new TextDecoder().decode(bytes);
    if (text.trim().startsWith("{") || text.trim().startsWith("[")) return text.trim();
  } catch {}
  return null;
}

function tryBase64Decode(content) {
  try {
    const decoded = atob(content.replace(/-/g, '+').replace(/_/g, '/'));
    if (decoded.trim().startsWith("{") || decoded.trim().startsWith("[")) return decoded.trim();
  } catch {}
  return null;
}

async function tryGzipBase64(content) {
  try {
    const bytes = base64Decode(content);
    const decompressed = await gzipDecompress(bytes);
    const text = new TextDecoder().decode(decompressed).trim();
    if (text.startsWith("{") || text.startsWith("[")) return text;
  } catch {}
  return null;
}

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
    ];
    for (const key of keys) {
      try {
        const plain = await aes128Decrypt(cipher.buffer, key.slice(0, 16), iv);
        const text = new TextDecoder().decode(plain).trim();
        if (text.startsWith("{") || text.startsWith("[")) return text;
      } catch {}
    }
  } catch {}
  return null;
}

/* ---------- 递归查找可解密内容 ---------- */

async function findResult(rawText) {
  let content = (typeof rawText === "string" ? rawText : new TextDecoder().decode(rawText)).trim();

  content = stripJsonComments(content);
  content = restoreUnicodeEscape(content);
  content = content.trim();

  try { JSON.parse(content); return content; } catch {}

  const tries = [
    tryDecrypt2423Hex,
    tryDecrypt2423Plain,
    tryAesBase64,
    tryGzipBase64,
  ];
  for (const fn of tries) {
    const r = await fn(content);
    if (r) return r;
  }

  const r5 = tryBase64Decode(content);
  if (r5) return r5;

  if (content.includes("**")) {
    for (const part of content.split("**")) {
      const t = part.trim();
      if (t.length > 10) {
        const sub = await findResult(t);
        const s = sub.trim();
        if (s.startsWith("{") || s.startsWith("[")) return sub;
      }
    }
  }

  return content;
}

/* ---------- 路径补全 ---------- */

function absolutize(node, base) {
  if (Array.isArray(node)) return node.map(v => absolutize(v, base));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && /^(url|link|src|pic|img)$/i.test(k)) {
        try { out[k] = new URL(v, base).toString(); }
        catch { out[k] = v; }
      } else if (typeof v === "string" && /(Url|Link|URL|href)$/.test(k)) {
        try { out[k] = new URL(v, base).toString(); }
        catch { out[k] = v; }
      } else {
        out[k] = absolutize(v, base);
      }
    }
    return out;
  }
  return node;
}

/* ---------- 主入口 ---------- */

export async function decryptAndProcess(rawText, sourceUrl) {
  const decrypted = await findResult(rawText);
  const fragment = extractJsonFragment(decrypted);

  let finalObj;
  try {
    finalObj = JSON.parse(fragment);
    finalObj = deepRestoreUnicode(finalObj);
    finalObj = absolutize(finalObj, sourceUrl);
    return JSON.stringify(finalObj, null, 2);
  } catch (e) {
    return restoreUnicodeEscape(fragment);
  }
}