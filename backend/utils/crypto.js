/**
 * backend/utils/crypto.js
 * AES-256-CBC 加密/解密工具模块
 * 用于敏感收款账户信息在 PostgreSQL 数据库中的安全加密存储与脱敏展示
 */

const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const ALGORITHM = 'aes-256-cbc';
// 确保密钥长度为 32 字节 (256 位)
const rawKey = process.env.AES_SECRET_KEY || 'c9f8a42e1d7b3056e84d2f9a1b3c5e70';
const SECRET_KEY = crypto.createHash('sha256').update(String(rawKey)).digest();

/**
 * AES-256-CBC 加密
 * @param {string} text - 明文字符串
 * @returns {string} - 格式为 ivHex:cipherHex
 */
function encrypt(text) {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
    let encrypted = cipher.update(String(text), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('[Crypto] 加密失败:', error.message);
    return text;
  }
}

/**
 * AES-256-CBC 解密
 * @param {string} encryptedText - 格式为 ivHex:cipherHex
 * @returns {string} - 解密后的明文字符串
 */
function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;
  try {
    // 检查是否符合 iv:cipher 格式
    const parts = encryptedText.split(':');
    if (parts.length !== 2) {
      return encryptedText; // 若不是加密格式则原样返回
    }
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.warn('[Crypto] 解密失败或原样返回:', error.message);
    return encryptedText;
  }
}

/**
 * 账号脱敏工具函数
 * @param {string} account - 原始账号
 * @param {string} method - 'wechat' | 'alipay' | 'bank'
 */
function maskAccount(account, method = 'wechat') {
  if (!account) return '****';
  const str = String(account);
  
  // 银行卡脱敏：保留前4位和后4位，中间星号
  if (method === 'bank' || str.length >= 16) {
    if (str.length <= 8) return str;
    const prefix = str.slice(0, 4);
    const suffix = str.slice(-4);
    return `${prefix} **** **** ${suffix}`;
  }
  
  // 手机号类脱敏：138****8000
  if (/^\d{11}$/.test(str)) {
    return str.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
  }
  
  // 邮箱脱敏：a***b@domain.com
  if (str.includes('@')) {
    const [name, domain] = str.split('@');
    if (name.length <= 2) return `${name}***@${domain}`;
    return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`;
  }
  
  // 普通微信号或字符脱敏
  if (str.length > 6) {
    return `${str.slice(0, 3)}****${str.slice(-3)}`;
  }
  return `${str.slice(0, 1)}****`;
}

module.exports = {
  encrypt,
  decrypt,
  maskAccount
};
