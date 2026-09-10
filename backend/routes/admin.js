/**
 * 管理后台专属路由 (Admin API)
 * 提供管理员认证、收款码图片上传/管理、订单监控及统计数据接口
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { query } = require('../models/db');
const { maskAccount } = require('../utils/crypto');

// 简单高效的管理端 Token 缓存
const activeAdminTokens = new Set(['admin_dev_token_secret_123']);

/**
 * 校验管理端 Token 中间件
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;
  const token = (authHeader && authHeader.replace(/^Bearer\s+/, '')) || queryToken;

  if (!token || !activeAdminTokens.has(token)) {
    return res.status(401).json({
      code: 401,
      message: '管理员未登录或登录凭证已过期，请重新登录',
      data: null
    });
  }
  next();
}

/**
 * POST /api/admin/login
 * 管理员登录接口（账号: admin, 密码: admin123）
 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        code: 400,
        message: '请输入管理员账号和密码',
        data: null
      });
    }

    // 校验固定凭证 admin / admin123
    if (username.trim() === 'admin' && password === 'admin123') {
      const token = `admin_token_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      activeAdminTokens.add(token);

      return res.json({
        code: 200,
        message: '登录成功',
        data: {
          token,
          username: 'admin',
          role: 'administrator',
          login_time: new Date().toISOString()
        }
      });
    } else {
      return res.status(401).json({
        code: 401,
        message: '账号或密码错误，请重新输入',
        data: null
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/logout
 * 管理员退出登录
 */
router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.replace(/^Bearer\s+/, '');
  if (token) {
    activeAdminTokens.delete(token);
  }
  return res.json({
    code: 200,
    message: '已安全退出登录',
    data: null
  });
});

/**
 * GET /api/admin/check
 * 校验当前登录状态
 */
router.get('/check', requireAdmin, (req, res) => {
  return res.json({
    code: 200,
    message: '凭证有效',
    data: { username: 'admin', role: 'administrator' }
  });
});

/**
 * GET /api/admin/qrcodes
 * 获取所有商家收款码列表（管理端，含激活状态与创建时间）
 */
router.get('/qrcodes', requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, merchant_name, product_name, amount, qr_content, qr_image_url, is_active, created_at
       FROM merchant_qrcodes
       ORDER BY is_active DESC, id DESC`
    );

    const list = result.rows.map(item => ({
      id: item.id,
      merchant_name: item.merchant_name,
      product_name: item.product_name,
      amount: parseFloat(item.amount),
      qr_content: item.qr_content,
      qr_image_url: item.qr_image_url,
      is_active: Boolean(item.is_active),
      created_at: item.created_at
    }));

    return res.json({
      code: 200,
      message: '获取成功',
      data: {
        total: list.length,
        items: list
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/qrcode
 * 后台上传/录入供前端展示与识别的二维码图片
 */
router.post('/qrcode', requireAdmin, async (req, res, next) => {
  try {
    const { merchant_name, product_name, amount, qr_content, qr_image_url, is_active } = req.body;

    if (!merchant_name || !amount) {
      return res.status(400).json({
        code: 400,
        message: '商家名称与应付金额为必填项',
        data: null
      });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '金额必须为大于 0 的数字',
        data: null
      });
    }

    // 默认或自动生成的识别标识
    const finalContent = (qr_content && qr_content.trim()) ||
      `MCH_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}_${numAmount.toFixed(2)}`;

    // 若未直接上传图片则使用 qrcode 库由内容生成
    let finalImageUrl = qr_image_url;
    if (!finalImageUrl) {
      finalImageUrl = await QRCode.toDataURL(finalContent, {
        width: 360,
        margin: 2
      });
    }

    // 若设为当前展示，先将其他二维码设为非激活
    const shouldBeActive = is_active !== false;
    if (shouldBeActive) {
      await query(`UPDATE merchant_qrcodes SET is_active = false`);
    }

    const insertResult = await query(
      `INSERT INTO merchant_qrcodes (merchant_name, product_name, amount, qr_content, qr_image_url, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        merchant_name.trim(),
        (product_name || '扫码支付加款').trim(),
        numAmount,
        finalContent,
        finalImageUrl,
        shouldBeActive
      ]
    );

    return res.json({
      code: 200,
      message: '二维码上传保存成功',
      data: insertResult.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/qrcode/:id/set-active
 * 将指定二维码设为前端展示的主收款码
 */
router.put('/qrcode/:id/set-active', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ code: 400, message: '无效的二维码 ID' });
    }

    // 将其他二维码全部置为 false
    await query(`UPDATE merchant_qrcodes SET is_active = false`);

    // 将选中的二维码置为 true
    const result = await query(
      `UPDATE merchant_qrcodes SET is_active = true WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '未找到指定二维码' });
    }

    return res.json({
      code: 200,
      message: '已成功设为前端默认展示收款码',
      data: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/qrcode/:id
 * 删除指定二维码
 */
router.delete('/qrcode/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ code: 400, message: '无效的二维码 ID' });
    }

    const delResult = await query(`DELETE FROM merchant_qrcodes WHERE id = $1 RETURNING *`, [id]);
    if (delResult.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '二维码不存在或已被删除' });
    }

    // 如果删除了激活的二维码，且还有其他码，自动将最新的一条置为激活
    if (delResult.rows[0].is_active) {
      await query(`
        UPDATE merchant_qrcodes 
        SET is_active = true 
        WHERE id = (SELECT id FROM merchant_qrcodes ORDER BY id DESC LIMIT 1)
      `);
    }

    return res.json({
      code: 200,
      message: '收款码已成功删除',
      data: { id }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/orders
 * 查看所有订单列表
 */
router.get('/orders', requireAdmin, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        o.id,
        o.order_no,
        o.user_id,
        o.qrcode_id,
        o.amount,
        o.pay_status,
        o.process_status,
        o.withdraw_method,
        o.withdraw_account,
        o.paid_at,
        o.processed_at,
        o.completed_at,
        o.created_at,
        m.merchant_name,
        m.product_name
      FROM orders o
      LEFT JOIN merchant_qrcodes m ON o.qrcode_id = m.id
      ORDER BY o.id DESC
      LIMIT 50
    `);

    const orders = result.rows.map(row => ({
      ...row,
      amount: parseFloat(row.amount),
      withdraw_account_masked: maskAccount(row.withdraw_account || '', row.withdraw_method)
    }));

    return res.json({
      code: 200,
      message: '获取成功',
      data: orders
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/stats
 * 获取概览统计数据
 */
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const qCount = await query(`SELECT COUNT(*) FROM merchant_qrcodes`);
    const oCount = await query(`SELECT COUNT(*) FROM orders`);
    const sumAmount = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE process_status = 'completed'`);
    const pendingCount = await query(`SELECT COUNT(*) FROM orders WHERE process_status = 'pending'`);

    return res.json({
      code: 200,
      message: '获取成功',
      data: {
        total_qrcodes: parseInt(qCount.rows[0].count, 10),
        total_orders: parseInt(oCount.rows[0].count, 10),
        completed_amount: parseFloat(sumAmount.rows[0].total),
        pending_orders: parseInt(pendingCount.rows[0].count, 10)
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
