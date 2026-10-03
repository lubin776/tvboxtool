/**
 * 1. 清理函数：删掉注释、换行、空格
 */
function cleanText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\/\*[\s\S]*?\*\//g, '') // 删注释
    .replace(/\n|\r|\t/g, '')       // 删换行/制表符
    .replace(/\s+/g, '')             // 删多余空格
    .trim();
}

/**
 * 2. 判断是否是明文 JSON
 */
function isJson(str) {
  if (!str) return false;
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * 3. 判断是否是乱码/二进制垃圾（包含替换字符或过多控制字符）
 */
function isGarbage(str) {
  if (str.includes('�')) return true;
  // 统计不可见控制字符比例
  const ctrlChars = (str.match(/[\x00-\x1F\x7F]/g) || []).length;
  if (ctrlChars > str.length * 0.3) return true;
  return false;
}

/**
 * 4. 安全的 Base64 解码（防止乱码）
 */
function safeBase64Decode(b64) {
  try {
    // 清洗非 Base64 字符
    const cleanB64 = b64.replace(/[^A-Za-z0-9+/=]/g, '').padEnd(Math.ceil(b64.length / 4) * 4, '=');
    // 浏览器/CF Workers 环境标准解法
    const binStr = atob(cleanB64);
    const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
    const text = new TextDecoder('utf-8').decode(bytes);
    
    // 如果解出来是乱码，返回 null 让外层尝试其他解密方式
    if (isGarbage(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * 5. 单次解密处理
 */
async function processOnce(cleaned) {
  // 跳过明显的二进制垃圾（如 PNG 头）
  if (cleaned.startsWith('iVBOR') || cleaned.startsWith('89504E')) return null;

  // 尝试提取 2423 特征
  const patMatch = cleaned.match(/2423[\s\S]*?2324/);
  if (patMatch) {
    const r = await tryDecrypt2423(patMatch[0]); // 你的 2423 解密逻辑
    if (r && !isGarbage(r)) return r;
  }

  // 尝试提取 Base64 长串
  const b64Matches = cleaned.match(/[A-Za-z0-9+/=_-]{20,}/g) || [];
  for (const b64 of b64Matches) {
    const decoded = safeBase64Decode(b64);
    if (decoded) {
      if (isJson(decoded)) return decoded;
      // 解出来是文本但不是 JSON，返回让它继续循环解密
      return decoded; 
    }
    
    // 尝试 AES / Gzip（你的原有逻辑）
    const r1 = await tryAesB64(b64);
    if (r1 && !isGarbage(r1)) return r1;
    
    const r2 = await tryGzipB64(b64);
    if (r2 && !isGarbage(r2)) return r2;
  }

  return null;
}

/**
 * 6. 核心循环：清理 → 处理 → 判断 → 重复
 */
async function decryptLoop(input, depth = 0) {
  if (depth > 10) return cleanText(input); // 超过10层强制退出

  // 第一步：清理（删注释、换行、空格）
  const cleaned = cleanText(input);

  // 如果是明文 JSON，直接格式化返回
  if (isJson(cleaned)) {
    return JSON.stringify(JSON.parse(cleaned), null, 2);
  }

  // 熔断：如果是乱码/二进制，直接终止循环
  if (isGarbage(cleaned)) {
    return '解密失败：响应为二进制乱码，无可用明文';
  }

  // 第二步：处理解密
  const processed = await processOnce(cleaned);
  if (!processed || processed === cleaned) {
    return cleaned || '解密失败：无法识别的数据格式';
  }

  // 第三步：判断结果，不是 JSON 就重复（回到清理步骤）
  const processedClean = cleanText(processed);
  if (isJson(processedClean)) {
    return JSON.stringify(JSON.parse(processedClean), null, 2);
  }

  // 重复循环
  return decryptLoop(processed, depth + 1);
}

/**
 * 7. 主入口（对接 Fetch）
 */
export async function decryptAndProcess(rawResponse, sourceUrl) {
  // 关键：响应必须作为二进制 ArrayBuffer 接收，不能直接 .text()
  const buffer = await rawResponse.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  
  // 尝试把原始二进制直接当文本读一次（应对直接返回文本的情况）
  let rawText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  
  // 如果原始响应就是乱码，尝试直接走 AES/Gzip 二进制解密
  if (isGarbage(rawText)) {
    // 这里可以插入你直接对 bytes 进行 AES/Gzip 解密的逻辑
    // 如果解密成功返回文本，再进入循环
  }

  const result = await decryptLoop(rawText, 0);
  return result;
}
