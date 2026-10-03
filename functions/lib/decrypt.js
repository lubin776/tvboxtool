// ============================================================
// TVBox 解密工具库
// 完整移植 Python 版 find_result / _try_decrypt_2423_hex / _try_decrypt_2423_plain
// + 多层循环：每轮先删注释/删空白/还原Unicode，再试解码
// ============================================================

/* ================= 基础工具 ================= */

function hexToBytes(hex) {
  if (typeof hex !== "string") throw new Error("not string");
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error("odd length");
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error("not hex");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function latin1FromHex(hex) {
  if (hex.length % 2 !== 0) throw new Error("odd hex");
  let s = "";
  for (let i = 0; i < hex.length; i += 2) {
    s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return s;
}

function rightPad(s, ch, length) {
  if (s.length >= length) return s.slice(0, length);
  return s + ch.repeat(length - s.length);
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

/* ================= 判断 ================= */

function looksLikeJson(text) {
  const t = text.trim();
  if (!t) return false;
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

/* ================= 删注释（字符串感知） ================= */

function stripComments(input) {
  let out = "";
  let inStr = false, quote = "", i = 0;
  while (i < input.length) {
    const c = input[i], n = input[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { if (n !== undefined) { out += n; i += 2; continue; } }
      if (c === quote) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < input.length && input[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

/* ================= 删所有空白 ================= */

function stripAllWhitespace(input) {
  return input.replace(/[\s\uFEFF\u200B]+/g, "");
}

/* ================= 还原 Unicode ================= */

function restoreUnicodeEscape(str) {
  if (typeof str !== "string") return str;
  let prev, cur = str;
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

/* ================= 从二进制乱码里抽可打印片段 ================= */

function extractPrintableSegments(text) {
  const found = [];

  // 1) 2423...2324 结构片段（优先）
  const re2423 = /2423[0-9a-fA-F]{8,}2324[0-9a-fA-F]{20,}/g;
  let m;
  while ((m = re2423.exec(text)) !== null) {
    found.push({ type: "2423", value: m[0] });
    if (found.length > 20) break;
  }

  // 2) base64 片段（长度 ≥ 32）
  const b64Re = /[A-Za-z0-9+/=]{32,}/g;
  while ((m = b64Re.exec(text)) !== null) {
    found.push({ type: "base64", value: m[0] });
    if (found.length > 50) break;
  }

  // 3) URL 编码片段
  const urlRe = /(?:%[0-9A-Fa-f]{2}){4,}[^\s]*/g;
  while ((m = urlRe.exec(text)) !== null) {
    found.push({ type: "url", value: m[0] });
    if (found.length > 80) break;
  }

  // 4) 内嵌 JSON
  const jsonRe = /[\[{][^\x00-\x1F]{20,}[\]}]/g;
  while ((m = jsonRe.exec(text)) !== null) {
    found.push({ type: "json", value: m[0] });
    if (found.length > 100) break;
  }

  return found;
}

/* ================= 2423 hex（完整移植 Python） ================= */

async function decode2423Hex(content) {
  const idx2423 = content.indexOf("2423");
  const idx2324 = content.indexOf("2324");
  if (idx2423 === -1 || idx2324 === -1 || idx2324 <= idx2423) return null;

  // key
  let keyRaw;
  try {
    const keyHex = content.slice(idx2423 + 4, idx2324);
    keyRaw = latin1FromHex(keyHex);
  } catch {
    return null;
  }
  const keyStr = rightPad(keyRaw, "0", 16);
  const keyBytes = new TextEncoder().encode(keyStr).slice(0, 16);

  // cipher：2324 之后 到 len-26
  const dataStart = idx2324 + 4;
  const dataEnd = content.length - 26;
  if (dataEnd <= dataStart) return null;
  const dataHex = content.slice(dataStart, dataEnd);

  // iv：末尾 26 字符
  const trimmed = content.replace(/\s+$/, "");
  const tsHex = trimmed.slice(trimmed.length - 26);
  let tsRaw;
  try {
    tsRaw = latin1FromHex(tsHex);
  } catch {
    tsRaw = tsHex;
  }
  const ivStr = rightPad(tsRaw, "0", 16);
  const ivBytes = new TextEncoder().encode(ivStr).slice(0, 16);

  // cipher bytes
  let cipherBytes;
  try {
    cipherBytes = hexToBytes(dataHex);
  } catch {
    return null;
  }
  if (cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) return null;

  try {
    const plain = await aes128Decrypt(cipherBytes.buffer, keyBytes, ivBytes);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(plain);
    return text || null;
  } catch {
    return null;
  }
}

/* ================= 2423 plain（$# / #$ 分隔） ================= */

async function decode2423Plain(S) {
  const idx2324 = S.indexOf("2324");
  const pDoll = S.indexOf("$#");
  const pSharp = S.indexOf("#$");
  if (idx2324 === -1 || pDoll === -1 || pSharp === -1) return null;
  if (pDoll >= pSharp) return null;

  let dataHex = S.slice(idx2324 + 4, pDoll).replace(/[^0-9a-fA-F]/g, "");
  if (dataHex.length % 2 !== 0) dataHex = dataHex.slice(0, -1);
  if (!dataHex) return null;

  const keyStr = rightPad(S.slice(pDoll + 2, pSharp), "0", 16);
  const ivStr = rightPad(S.slice(S.length - 13), "0", 16);
  const keyBytes = new TextEncoder().encode(keyStr).slice(0, 16);
  const ivBytes = new TextEncoder().encode(ivStr).slice(0, 16);

  let cipherBytes;
  try {
    cipherBytes = hexToBytes(dataHex);
  } catch {
    return null;
  }
  if (cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) return null;

  try {
    const plain = await aes128Decrypt(cipherBytes.buffer, keyBytes, ivBytes);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(plain);
    return text || null;
  } catch {
    return null;
  }
}

/* ================= 其他解码器 ================= */

function decodeUrl(content) {
  if (!/%[0-9A-Fa-f]{2}/.test(content)) return null;
  try {
    const d = decodeURIComponent(content);
    if (d !== content) return d;
  } catch {}
  return null;
}

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
        if (text.startsWith('{') || text.startsWith('[')) return text;
      } catch {}
    }
  } catch {}
  return null;
}

async function decodeGzipBase64(content) {
  try {
    const bytes = base64Decode(content);
    const decompressed = await gzipDecompress(bytes);
    const text = new TextDecoder().decode(decompressed).trim();
    if (text.startsWith('{') || text.startsWith('[')) return text;
  } catch {}
  return null;
}

function decodeBase64(content) {
  const s = content.trim();
  if (s.length < 16) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return null;
  if (s.length % 4 !== 0) return null;
  try {
    const decoded = atob(s);
    const t = decoded.trim();
    if (!t) return null;
    if (t.startsWith('{') || t.startsWith('[') ||
        t.startsWith('http') ||
        /^[A-Za-z0-9+/=]+$/.test(t) ||
        /%[0-9A-Fa-f]{2}/.test(t) ||
        t.includes('"') || t.includes("'")) {
      return t;
    }
  } catch {}
  return null;
}

/* ================= 提取 JSON 片段 ================= */

function extractJsonFragment(text) {
  const t = text.trim();
  if (!t) return text;
  if ((t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']'))) return t;
  const pats = [/\{[\s\S]*\}/, /\[[\s\S]*\]/];
  for (const pat of pats) {
    const m = text.match(pat);
    if (m) { try { JSON.parse(m[0]); return m[0]; } catch {} }
  }
  return text;
}

/* ============================================================
   核心：多层循环
   ============================================================ */

const MAX_ROUNDS = 12;
const MIN_TEXT_LEN = 6;

async function decodeLoop(rawText, trace) {
  let current = (typeof rawText === "string" ? rawText : new TextDecoder().decode(rawText));

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const before = current;

    // 1) 删注释
    let step = stripComments(current);
    if (step !== current) trace.push(`R${round}: 删注释`);
    current = step;

    // 2) 删所有空白
    step = stripAllWhitespace(current);
    if (step !== current) trace.push(`R${round}: 删空白 (${current.length}→${step.length})`);
    current = step;

    // 3) 还原 Unicode
    step = restoreUnicodeEscape(current);
    if (step !== current) trace.push(`R${round}: 还原Unicode`);
    current = step;

    // 4) 是 JSON？
    if (looksLikeJson(current)) {
      trace.push(`R${round}: 命中 JSON`);
      return current;
    }

    // 5) 依次尝试所有解码器（2423 优先）
    const decoders = [
      { name: "2423hex",    fn: decode2423Hex },
      { name: "2423plain",  fn: decode2423Plain },
      { name: "AesBase64",  fn: decodeAesBase64 },
      { name: "GzipBase64", fn: decodeGzipBase64 },
      { name: "UrlDecode",  fn: async s => decodeUrl(s) },
      { name: "Base64",     fn: async s => decodeBase64(s) },
    ];

    let advanced = false;
    for (const d of decoders) {
      try {
        const out = await d.fn(current);
        if (out && out !== current && out.length >= MIN_TEXT_LEN) {
          trace.push(`R${round}: ${d.name} (${current.length}→${out.length})`);
          current = out;
          advanced = true;
          break;
        }
      } catch {}
    }

    // 6) 整体无进展 → 从乱码里捞片段
    if (!advanced) {
      const segs = extractPrintableSegments(current);
      for (const seg of segs) {
        if (seg.type === "json") {
          try {
            JSON.parse(seg.value);
            trace.push(`R${round}: 捞到内嵌 JSON`);
            current = seg.value;
            advanced = true;
            break;
          } catch {}
        } else if (seg.type === "2423") {
          const out = await decode2423Hex(seg.value);
          if (out && out !== current) {
            trace.push(`R${round}: 捞到 2423 块 (${seg.value.length}→${out.length})`);
            current = out;
            advanced = true;
            break;
          }
        } else if (seg.type === "base64") {
          const out = await decodeBase64(seg.value);
          if (out && out !== current) {
            trace.push(`R${round}: 捞到 base64 片段 (${seg.value.length}→${out.length})`);
            current = out;
            advanced = true;
            break;
          }
        } else if (seg.type === "url") {
          const out = decodeUrl(seg.value);
          if (out && out !== current) {
            trace.push(`R${round}: 捞到 url 片段`);
            current = out;
            advanced = true;
            break;
          }
        }
      }
    }

    // 7) 本轮无任何变化 → 停止
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
        try { out[k] = new URL(v, base).toString(); } catch { out[k] = v; }
      } else if (typeof v === "string" && /(Url|Link|URL|href)$/.test(k)) {
        try { out[k] = new URL(v, base).toString(); } catch { out[k] = v; }
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

  const fragment = extractJsonFragment(decoded);
  try {
    let obj = JSON.parse(fragment);
    obj = deepRestoreUnicode(obj);
    obj = absolutize(obj, sourceUrl);
    return { data: JSON.stringify(obj, null, 2), trace };
  } catch {
    return { data: restoreUnicodeEscape(fragment), trace };
  }
}