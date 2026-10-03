// ============================================================
// TVBox 解密工具库 (JavaScript/WebCrypto 移植版)
// - 多层循环解码：识别 → 解码 → 再识别 → 直到明文 JSON 或不再变化
// - 字符串感知注释清理（不误伤 http://）
// - 中文 Unicode 转义还原（多层）
// - 标准 JSON 输出（中文不转义）
// ============================================================

/* ================= 基础工具 ================= */

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

/* ================= 判断"是否像 JSON" ================= */

function looksLikeJson(text) {
  const t = text.trim();
  if (!t) return false;
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

/* ================= 字符串感知的注释清理 ================= */

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
      if (c === "\\") {
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

    if (c === "/" && n === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
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

/* ================= 中文 Unicode 还原 ================= */

function restoreUnicodeEscape(str) {
  if (typeof str !== "string") return str;
  let prev;
  let cur = str;
  for (let k = 0; k < 5; k++) {
    prev = cur;
    cur = cur.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
    if (cur === prev) break;
  }
  return cur;
}

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

/* ================= 单个解码器（返回 null 表示无效） ================= */

// 1) 2423xxxx2324（hex + AES）
async function decode2423Hex(content) {
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

// 2) 2423xxxx2324（plain：base64 或 hex）
async function decode2423Plain(content) {
  const match = content.match(/^2423(.+)2324$/s);
  if (!match) return null;
  const inner = match[1];

  // 尝试 base64
  try {
    const decoded = atob(inner);
    const t = decoded.trim();
    if (t.startsWith("{") || t.startsWith("[")) return t;
  } catch {}

  // 尝试 hex
  try {
    const bytes = hexToBytes(inner);
    const text = new TextDecoder().decode(bytes);
    const t = text.trim();
    if (t.startsWith("{") || t.startsWith("[")) return t;
  } catch {}

  return null;
}

// 3) URL 解码（只在含 %XX 时才返回）
function decodeUrl(content) {
  if (!/%[0-9A-Fa-f]{2}/.test(content)) return null;
  try {
    const decoded = decodeURIComponent(content);
    if (decoded !== content) return decoded;
  } catch {}
  return null;
}

// 4) AES + Base64
async function decodeAesBase64(content) {
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

// 5) Gzip + Base64
async function decodeGzipBase64(content) {
  try {
    const bytes = base64Decode(content);
    const decompressed = await gzipDecompress(bytes);
    const text = new TextDecoder().decode(decompressed).trim();
    if (text.startsWith("{") || text.startsWith("[")) return text;
  } catch {}
  return null;
}

// 6) 普通 Base64（放最后，避免误判）
function decodeBase64(content) {
  // 只处理"整体像 base64"的字符串
  const s = content.trim();
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) return null;
  if (s.length < 16) return null;
  const compact = s.replace(/\s/g, "");
  if (compact.length % 4 !== 0) return null;
  try {
    const decoded = atob(compact.replace(/-/g, '+').replace(/_/g, '/'));
    // 只接受可打印字符占比高、且看起来像结构或 JSON 的
    const t = decoded.trim();
    if (!t) return null;
    // 至少含 { 或 [ 或 < 或 常见字符
    if (t.startsWith("{") || t.startsWith("[") ||
        t.includes("{") || t.includes("[")) {
      return t;
    }
  } catch {}
  return null;
}

/* ================= 提取 JSON 片段 ================= */

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

/* ================= 核心：多层循环解码 ================= */

const MAX_ROUNDS = 8;      // 最多 8 层嵌套，防死循环
const MIN_TEXT_LEN = 6;    // 太短直接放弃

async function decodeLoop(rawText, trace) {
  let current = (typeof rawText === "string" ? rawText : new TextDecoder().decode(rawText)).trim();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // 每轮开始：先做"无损"清洗
    const before = current;

    // 注释清理
    let cleaned = stripJsonComments(current);
    if (cleaned !== current) {
      trace.push(`R${round}: stripComments`);
      current = cleaned;
    }

    // Unicode 还原
    cleaned = restoreUnicodeEscape(current);
    if (cleaned !== current) {
      trace.push(`R${round}: restoreUnicode`);
      current = cleaned;
    }

    current = current.trim();

    // 如果已经是 JSON，直接返回
    if (looksLikeJson(current)) {
      trace.push(`R${round}: 命中 JSON`);
      return current;
    }

    // 依次尝试所有解码器（顺序：越具体的越靠前）
    const decoders = [
      { name: "2423hex",    fn: decode2423Hex },
      { name: "2423plain",  fn: decode2423Plain },
      { name: "AesBase64",  fn: decodeAesBase64 },
      { name: "GzipBase64", fn: decodeGzipBase64 },
      { name: "UrlDecode",  fn: async (s) => decodeUrl(s) },
      { name: "Base64",     fn: async (s) => decodeBase64(s) },
    ];

    let advanced = false;
    for (const d of decoders) {
      try {
        const out = await d.fn(current);
        if (out && out !== current && out.length >= MIN_TEXT_LEN) {
          trace.push(`R${round}: ${d.name} (${current.length}→${out.length})`);
          current = out.trim();
          advanced = true;
          break; // 本轮有进展 → 进入下一轮重新判断
        }
      } catch {}
    }

    // 尝试 ** 分隔（作为兜底）
    if (!advanced && current.includes("**")) {
      for (const part of current.split("**")) {
        const t = part.trim();
        if (t.length > 10 && looksLikeJson(t)) {
          trace.push(`R${round}: ** 拆分命中`);
          return t;
        }
      }
    }

    // 本轮无任何进展 → 跳出循环
    if (!advanced && current === before) {
      trace.push(`R${round}: 无进展，停止`);
      break;
    }
  }

  return current;
}

/* ================= 路径补全 ================= */

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

/* ================= 主入口 ================= */

export async function decryptAndProcess(rawText, sourceUrl) {
  const trace = [];
  const decoded = await decodeLoop(rawText, trace);

  // 如果是合法 JSON，美化 + 中文还原 + 路径补全
  const fragment = extractJsonFragment(decoded);
  try {
    let obj = JSON.parse(fragment);
    obj = deepRestoreUnicode(obj);
    obj = absolutize(obj, sourceUrl);
    return JSON.stringify(obj, null, 2);
  } catch {
    // 不是合法 JSON：至少把中文还原出来
    return restoreUnicodeEscape(fragment);
  }
}