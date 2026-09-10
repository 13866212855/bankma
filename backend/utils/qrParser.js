/**
 * backend/utils/qrParser.js
 * 二维码解析与规范化工具
 */

/**
 * 解析二维码内容
 * 支持 JSON 字符串、URL 查询参数、结构化纯文本以及预设代码
 * @param {string} rawContent 
 * @returns {Object|null}
 */
function parseQrContent(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    return null;
  }

  const trimmed = rawContent.trim();

  // 1. 尝试作为 JSON 解析
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.merchant_name && parsed.amount) {
        return {
          merchant_name: String(parsed.merchant_name),
          product_name: String(parsed.product_name || '特选商品'),
          amount: parseFloat(parsed.amount) || 0.01,
          qr_content: trimmed
        };
      }
    } catch {
      // 不是合法的 JSON，继续向下匹配
    }
  }

  // 2. 尝试作为 URL 解析 (如: https://pay.example.com/qr?mch=xxx&prod=xxx&amt=19.90)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('?')) {
    try {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `https://pay.local/${trimmed}`);
      const params = url.searchParams;
      const mch = params.get('mch') || params.get('merchant') || params.get('m');
      const prod = params.get('prod') || params.get('product') || params.get('p');
      const amt = params.get('amt') || params.get('amount') || params.get('a');

      if (mch && amt) {
        return {
          merchant_name: decodeURIComponent(mch),
          product_name: decodeURIComponent(prod || '消费结账'),
          amount: parseFloat(amt) || 0.01,
          qr_content: trimmed
        };
      }
    } catch {
      // 忽略 URL 解析异常
    }
  }

  // 3. 管道符分隔格式: 商家名|商品名|金额
  if (trimmed.includes('|')) {
    const parts = trimmed.split('|').map(s => s.trim());
    if (parts.length >= 3 && !isNaN(parseFloat(parts[2]))) {
      return {
        merchant_name: parts[0],
        product_name: parts[1],
        amount: parseFloat(parts[2]),
        qr_content: trimmed
      };
    }
  }

  // 4. 返回未完全结构化的原始内容，交由数据库匹配
  return {
    raw: trimmed,
    qr_content: trimmed
  };
}

module.exports = {
  parseQrContent
};
