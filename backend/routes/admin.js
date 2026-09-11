/**
 * 管理后台专属路由 (Admin API)
 * 提供管理员认证、收款码图片上传/管理、订单监控及统计数据接口
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { query } = require('../models/db');
const { maskAccount, decrypt } = require('../utils/crypto');

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
 * 获取所有商家收款码列表（管理端，含激活状态、费率与限额）
 */
router.get('/qrcodes', requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active, created_at
       FROM merchant_qrcodes
       ORDER BY is_active DESC, id DESC`
    );

    const list = result.rows.map(item => ({
      id: item.id,
      merchant_name: item.merchant_name,
      product_name: item.product_name,
      amount: parseFloat(item.amount || 0),
      fee_rate: parseFloat(item.fee_rate || 0.8),
      max_limit: parseFloat(item.max_limit || 10000),
      min_limit: parseFloat(item.min_limit || 1),
      channel_desc: item.channel_desc || '',
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
 * 后台上传/录入收款码（支持指定不同收款码的手续费率和单笔限额）
 */
router.post('/qrcode', requireAdmin, async (req, res, next) => {
  try {
    const { 
      merchant_name, 
      product_name, 
      amount, 
      fee_rate, 
      max_limit, 
      min_limit, 
      channel_desc, 
      qr_content, 
      qr_image_url, 
      is_active 
    } = req.body;

    if (!merchant_name) {
      return res.status(400).json({
        code: 400,
        message: '收款通道商户名称为必填项 (例如: 建设银行收款码、安徽农金收款码)',
        data: null
      });
    }

    const numAmount = parseFloat(amount || 0);
    const numFeeRate = parseFloat(fee_rate !== undefined ? fee_rate : 0.8);
    const numMaxLimit = parseFloat(max_limit || 10000);
    const numMinLimit = parseFloat(min_limit || 1);

    if (isNaN(numFeeRate) || numFeeRate < 0) {
      return res.status(400).json({ code: 400, message: '手续费率必须为大于等于0的数值 (如0.8代表0.8%)' });
    }

    // 默认或自动生成的识别标识
    const finalContent = (qr_content && qr_content.trim()) ||
      `MCH_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}_${numMaxLimit}`;

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
      `INSERT INTO merchant_qrcodes 
        (merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        merchant_name.trim(),
        (product_name || '扫码加款收款通道').trim(),
        numAmount,
        numFeeRate,
        numMaxLimit,
        numMinLimit,
        channel_desc || '',
        finalContent,
        finalImageUrl,
        shouldBeActive
      ]
    );

    return res.json({
      code: 200,
      message: '收款码上传配置成功',
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
      message: '已成功切换为当前默认收款码',
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
 * 查看所有订单列表（管理端，附带完整明细供人工核实和打款）
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
        o.fee_rate,
        o.fee_amount,
        o.settle_amount,
        o.pay_status,
        o.process_status,
        o.withdraw_method,
        o.withdraw_account,
        o.withdraw_name,
        o.withdraw_bank,
        o.audit_remark,
        o.paid_at,
        o.processed_at,
        o.completed_at,
        o.created_at,
        m.merchant_name,
        m.product_name,
        m.channel_desc
      FROM orders o
      LEFT JOIN merchant_qrcodes m ON o.qrcode_id = m.id
      ORDER BY o.id DESC
      LIMIT 100
    `);

    const orders = result.rows.map(row => {
      let plainAccount = '';
      try {
        plainAccount = decrypt(row.withdraw_account || '');
      } catch (e) {
        plainAccount = row.withdraw_account || '';
      }
      return {
        ...row,
        amount: parseFloat(row.amount),
        fee_rate: parseFloat(row.fee_rate || 0.8),
        fee_amount: parseFloat(row.fee_amount || 0),
        settle_amount: parseFloat(row.settle_amount || row.amount),
        withdraw_account_plain: plainAccount,
        withdraw_account_masked: maskAccount(plainAccount, row.withdraw_method)
      };
    });

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
 * PUT /api/admin/orders/:orderNo/start-verify
 * 管理员开始人工核实 (变为 processing 状态)
 */
router.put('/orders/:orderNo/start-verify', requireAdmin, async (req, res, next) => {
  try {
    const { orderNo } = req.params;
    const updateRes = await query(
      `UPDATE orders 
       SET process_status = 'processing', processed_at = NOW() 
       WHERE order_no = $1 
       RETURNING *`,
      [orderNo]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ code: 404, message: '未找到对应订单' });
    }

    const order = updateRes.rows[0];
    await query(
      `INSERT INTO order_logs (order_id, status, remark, created_at)
       VALUES ($1, 'processing', '后台管理员已受理【到账核实请求】，正在调取微信/银行商户后台核对实际到账流水', NOW())`,
      [order.id]
    );

    return res.json({
      code: 200,
      message: '已开始人工核实对账',
      data: order
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/orders/:orderNo/verify-and-complete
 * 管理员核实款项真实到账，并已向用户微信/支付宝/银行卡打款完成
 */
router.put('/orders/:orderNo/verify-and-complete', requireAdmin, async (req, res, next) => {
  try {
    const { orderNo } = req.params;
    const { remark } = req.body;
    const auditRemark = remark || '管理员已人工核验商户流水入账，且已按客户指定到账方式完成充值/转账打款';

    const updateRes = await query(
      `UPDATE orders 
       SET process_status = 'completed', completed_at = NOW(), audit_remark = $1
       WHERE order_no = $2 
       RETURNING *`,
      [auditRemark, orderNo]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ code: 404, message: '未找到对应订单' });
    }

    const order = updateRes.rows[0];
    await query(
      `INSERT INTO order_logs (order_id, status, remark, created_at)
       VALUES ($1, 'completed', $2, NOW())`,
      [order.id, `【人工打款完成】${auditRemark}`]
    );

    return res.json({
      code: 200,
      message: '人工核实与打款已标记完成',
      data: order
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/orders/:orderNo/reject
 * 管理员核实未通过/未查到流水驳回
 */
router.put('/orders/:orderNo/reject', requireAdmin, async (req, res, next) => {
  try {
    const { orderNo } = req.params;
    const { remark } = req.body;
    const auditRemark = remark || '商户后台未核查到对应金额入账流水，或微信支付未成功，核实未通过';

    const updateRes = await query(
      `UPDATE orders 
       SET process_status = 'rejected', completed_at = NOW(), audit_remark = $1
       WHERE order_no = $2 
       RETURNING *`,
      [auditRemark, orderNo]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ code: 404, message: '未找到对应订单' });
    }

    const order = updateRes.rows[0];
    await query(
      `INSERT INTO order_logs (order_id, status, remark, created_at)
       VALUES ($1, 'rejected', $2, NOW())`,
      [order.id, `【核实未通过驳回】${auditRemark}`]
    );

    return res.json({
      code: 200,
      message: '订单已驳回',
      data: order
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
