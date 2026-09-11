/**
 * backend/utils/tts.js
 * 服务端中文语音 TTS 极速合成与流式分发引擎 (配合 mynotice 技能与后台保活)
 * 
 * 作用:
 * 1. 提供稳定、清晰、自然的中文语音 MP3 流
 * 2. 绕过移动端/iOS 在切换至微信等后台应用时抑制 window.speechSynthesis 的系统限制
 * 3. 真实 <audio> 媒体流在移动端后台播放具有高系统优先级，确保切到微信也能清晰发声
 * 4. 内置内存 LRU 缓存，相同播报内容毫秒级极速响应
 */

const https = require('https');

// 内存音频缓存 (上限 100 条常用播报)
const ttsCache = new Map();
const MAX_CACHE_SIZE = 100;

/**
 * 从可靠的中文 TTS 服务源获取音频片段
 * @param {string} text 需要合成的中文文本
 * @returns {Promise<Buffer>} MP3 音频二进制数据
 */
function fetchTTSChunk(text) {
  return new Promise((resolve, reject) => {
    if (!text || !text.trim()) {
      return resolve(Buffer.alloc(0));
    }

    const cleanText = text.trim();
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=zh-CN&client=tw-ob`;

    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'audio/mpeg, audio/*',
        'Referer': 'https://translate.google.com/'
      },
      timeout: 8000
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`TTS 服务响应状态码异常: ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('TTS 网络请求超时'));
    });
  });
}

/**
 * 获取完整中文朗读音频 (支持智能按标点分段并合并)
 * @param {string} fullText 完整朗读句子
 * @returns {Promise<Buffer>} MP3 音频二进制
 */
async function generateTTSAudio(fullText) {
  if (!fullText || typeof fullText !== 'string') {
    throw new Error('朗读文本不能为空');
  }

  const text = fullText.trim();
  if (ttsCache.has(text)) {
    return ttsCache.get(text);
  }

  // 若文本小于 120 字，直接单次请求
  if (text.length <= 120) {
    const audioBuffer = await fetchTTSChunk(text);
    if (audioBuffer && audioBuffer.length > 0) {
      if (ttsCache.size >= MAX_CACHE_SIZE) {
        const firstKey = ttsCache.keys().next().value;
        ttsCache.delete(firstKey);
      }
      ttsCache.set(text, audioBuffer);
    }
    return audioBuffer;
  }

  // 超过 120 字时，按中文逗号/句号/分号智能切片
  const segments = text.split(/([，。！；？,\.!\?;])/).filter(Boolean);
  const chunks = [];
  let current = '';

  for (let i = 0; i < segments.length; i++) {
    if ((current + segments[i]).length > 100) {
      if (current.trim()) chunks.push(current.trim());
      current = segments[i];
    } else {
      current += segments[i];
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const buffers = [];
  for (const chunk of chunks) {
    const buf = await fetchTTSChunk(chunk);
    if (buf && buf.length > 0) {
      buffers.push(buf);
    }
  }

  const combined = Buffer.concat(buffers);
  if (combined.length > 0) {
    if (ttsCache.size >= MAX_CACHE_SIZE) {
      const firstKey = ttsCache.keys().next().value;
      ttsCache.delete(firstKey);
    }
    ttsCache.set(text, combined);
  }

  return combined;
}

module.exports = {
  generateTTSAudio
};
