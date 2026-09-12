/**
 * backend/routes/qrcode.js
 * 二维码识别与解析路由
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { query } = require('../models/db');
const { parseQrContent } = require('../utils/qrParser');

/**
 * POST /api/qrcode/parse
 * 解析二维码内容，返回商家/商品/金额信息
 */
router.post('/parse', async (req, res, next) => {
  try {
    const { qr_content } = req.body;

    if (!qr_content || typeof qr_content !== 'string' || !qr_content.trim()) {
      return res.status(400).json({
        code: 400,
        message: '二维码内容不能为空',
        data: null
      });
    }

    const trimmed = qr_content.trim();

    // 1. 优先查库匹配已知商户收款码
    const dbResult = await query(
      `SELECT id, merchant_name, product_name, amount, qr_content, qr_image_url, is_active
       FROM merchant_qrcodes 
       WHERE qr_content = $1 AND is_active = true 
       LIMIT 1`,
      [trimmed]
    );

    if (dbResult.rowCount > 0) {
      const merchant = dbResult.rows[0];
      return res.json({
        code: 200,
        message: '解析成功',
        data: {
          id: merchant.id,
          merchant_name: merchant.merchant_name,
          product_name: merchant.product_name,
          amount: parseFloat(merchant.amount),
          qr_content: merchant.qr_content,
          qr_image_url: merchant.qr_image_url
        }
      });
    }

    // 2. 尝试从文本、URL 或 JSON 格式中解析结构化信息
    const parsed = parseQrContent(trimmed);
    if (parsed && parsed.merchant_name && parsed.amount) {
      // 自动插入临时或新商户码
      const insertResult = await query(
        `INSERT INTO merchant_qrcodes (merchant_name, product_name, amount, qr_content)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (qr_content) DO UPDATE 
         SET merchant_name = EXCLUDED.merchant_name, 
             product_name = EXCLUDED.product_name, 
             amount = EXCLUDED.amount
         RETURNING id, merchant_name, product_name, amount, qr_content`,
        [parsed.merchant_name, parsed.product_name || '日常消费', parsed.amount, trimmed]
      );

      const m = insertResult.rows[0];
      return res.json({
        code: 200,
        message: '解析成功',
        data: {
          id: m.id,
          merchant_name: m.merchant_name,
          product_name: m.product_name,
          amount: parseFloat(m.amount),
          qr_content: m.qr_content
        }
      });
    }

    // 3. 无法识别的无效二维码
    return res.status(404).json({
      code: 404,
      message: '未识别到有效的商家收款码信息，请确认二维码无误后重试',
      data: {
        raw_content: trimmed
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/merchant/active 或 /api/qrcode/active
 * 获取前端当前主推展示的收款二维码
 */
router.get(['/active', '/merchant/active'], async (req, res, next) => {
  try {
    let result = await query(
      `SELECT id, merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active, created_at 
       FROM merchant_qrcodes 
       WHERE is_active = true 
       ORDER BY id DESC 
       LIMIT 1`
    );

    // 如果没有激活的，则取最新的一条
    if (result.rows.length === 0) {
      result = await query(
        `SELECT id, merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active, created_at 
         FROM merchant_qrcodes 
         ORDER BY id DESC 
         LIMIT 1`
      );
    }

    if (result.rows.length === 0) {
      return res.json({
        code: 200,
        message: '暂无收款码',
        data: null
      });
    }

    const item = result.rows[0];
    let imageUrl = item.qr_image_url;
    if (!imageUrl && item.qr_content) {
      imageUrl = await QRCode.toDataURL(item.qr_content, {
        width: 360,
        margin: 1
      });
    }

    return res.json({
      code: 200,
      message: '获取成功',
      data: {
        id: item.id,
        merchant_name: item.merchant_name,
        product_name: item.product_name,
        amount: parseFloat(item.amount || 0),
        fee_rate: parseFloat(item.fee_rate || 0.8),
        max_limit: parseFloat(item.max_limit || 10000),
        min_limit: parseFloat(item.min_limit || 1),
        channel_desc: item.channel_desc || '',
        qr_content: item.qr_content,
        qr_image_url: imageUrl,
        is_active: item.is_active,
        created_at: item.created_at
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/merchant/qrcodes 或 /api/qrcode/merchant/qrcodes
 * 获取所有商家收款码列表（用于前台自由切换通道与测试）
 */
router.get(['/qrcodes', '/merchant/qrcodes'], async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active, created_at 
       FROM merchant_qrcodes 
       ORDER BY is_active DESC, id ASC`
    );

    // 若未生成图片则补充生成 DataURL
    const list = await Promise.all(result.rows.map(async (item) => {
      let imageUrl = item.qr_image_url;
      if (!imageUrl) {
        imageUrl = await QRCode.toDataURL(item.qr_content, {
          width: 320,
          margin: 1
        });
      }
      return {
        id: item.id,
        merchant_name: item.merchant_name,
        product_name: item.product_name,
        amount: parseFloat(item.amount || 0),
        fee_rate: parseFloat(item.fee_rate || 0.8),
        max_limit: parseFloat(item.max_limit || 10000),
        min_limit: parseFloat(item.min_limit || 1),
        channel_desc: item.channel_desc || '',
        qr_content: item.qr_content,
        qr_image_url: imageUrl,
        is_active: item.is_active,
        created_at: item.created_at
      };
    }));

    return res.json({
      code: 200,
      message: '获取成功',
      data: list
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/merchant/qrcode
 * 后台上传/录入收款二维码（含商品信息）
 */
router.post(['/qrcode', '/merchant/qrcode'], async (req, res, next) => {
  try {
    const { merchant_name, product_name, amount, qr_content } = req.body;

    if (!merchant_name || !product_name || !amount || !qr_content) {
      return res.status(400).json({
        code: 400,
        message: '商家名称、商品名称、金额和二维码内容均为必填项',
        data: null
      });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '金额必须大于 0',
        data: null
      });
    }

    // 生成二维码图像 DataURL
    const qrImageUrl = await QRCode.toDataURL(qr_content.trim(), {
      width: 320,
      margin: 2
    });

    const result = await query(
      `INSERT INTO merchant_qrcodes (merchant_name, product_name, amount, qr_content, qr_image_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (qr_content) DO UPDATE 
       SET merchant_name = EXCLUDED.merchant_name,
           product_name = EXCLUDED.product_name,
           amount = EXCLUDED.amount,
           qr_image_url = EXCLUDED.qr_image_url
       RETURNING *`,
      [merchant_name.trim(), product_name.trim(), numAmount, qr_content.trim(), qrImageUrl]
    );

    return res.json({
      code: 200,
      message: '商家收款码保存成功',
      data: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/qrcode/generate
 * 动态实时生成二维码图片（Base64 或 SVG）
 */
router.get('/generate', async (req, res, next) => {
  try {
    const text = req.query.text || 'DEMO_QR_CODE';
    const dataUrl = await QRCode.toDataURL(String(text), {
      width: 300,
      margin: 2
    });
    return res.json({
      code: 200,
      message: '生成成功',
      data: {
        text,
        image_url: dataUrl
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
