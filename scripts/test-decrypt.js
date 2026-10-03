// 本地测试脚本：验证解密逻辑
// 用法：node scripts/test-decrypt.js

// 模拟 WebCrypto 环境（Node.js 22+ 支持）
const { webcrypto } = require('crypto');
globalThis.crypto = webcrypto;

// 模拟 DecompressionStream（Node.js 20+ 支持）
const { DecompressionStream } = require('stream/web');
globalThis.DecompressionStream = DecompressionStream;

// 动态导入解密库
async function main() {
  try {
    const { decryptAndProcess } = await import('../functions/lib/decrypt.js');
    
    // 测试 1：纯 JSON
    console.log('=== 测试 1：纯 JSON ===');
    const test1 = '{"sites":[{"key":"test","name":"测试"}],"lives":[]}';
    const r1 = await decryptAndProcess(test1, 'https://example.com/api.json');
    console.log('结果:', r1);
    console.log('');

    // 测试 2：带注释的 JSON
    console.log('=== 测试 2：带注释的 JSON ===');
    const test2 = `{
      // 这是注释
      "sites": [{"key": "abc", "name": "测试站点"}],
      /* 多行注释 */
      "lives": []
    }`;
    const r2 = await decryptAndProcess(test2, 'https://example.com/api.json');
    console.log('结果:', r2);
    console.log('');

    // 测试 3：Base64 编码的 JSON
    console.log('=== 测试 3：Base64 编码的 JSON ===');
    const test3 = btoa('{"sites":[{"key":"b64","name":"Base64测试"}],"lives":[]}');
    const r3 = await decryptAndProcess(test3, 'https://example.com/api.json');
    console.log('结果:', r3);
    console.log('');

    console.log('✅ 所有测试完成');
  } catch (err) {
    console.error('❌ 测试失败:', err.message);
    console.error(err.stack);
  }
}

main();
