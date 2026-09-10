/**
 * backend/routes/withdraw.js
 * 提现与加款业务专用路由
 */

const express = require('express');
const router = express.Router();
const { query } = require('../models/db');
const { decrypt } = require('../utils/crypto');
const { sendWithdrawNotification } = require('../utils/notify');

/**
 * GET /api/withdraw/channels
 * 获取系统支持的出款/提现渠道与特性
 */
router.get('/channels', (req, res) => {
  return res.json({
    code: 200,
    message: '获取成功',
    data: [
      {
        id: 'wechat',
        name: '微信零钱',
        icon: 'wechat',
        desc: '实时到账，单笔支持最高 50,000 元',
        rate: '0.00%',
        instant: true
      },
      {
        id: 'alipay',
        name: '支付宝余额',
        icon: 'alipay',
        desc: '秒级到账，需已完成实名认证',
        rate: '0.00%',
        instant: true
      },
      {
        id: 'bank',
        name: '银联借记卡',
        icon: 'bank',
        desc: '支持全国各大主流商业银行与农商行',
        rate: '0.00%',
        instant: false
      }
    ]
  });
});

/**
 * POST /api/withdraw/retry/:orderNo
 * 出款失败或重发加款通知
 */
router.post('/retry/:orderNo', async (req, res, next) => {
  try {
    const { orderNo } = req.params;

    const orderRes = await query(
      `SELECT * FROM orders WHERE order_no = $1 LIMIT 1`,
      [orderNo]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({
        code: 404,
        message: '未找到订单',
        data: null
      });
    }

    const order = orderRes.rows[0];
    const plainAccount = decrypt(order.withdraw_account);

    const notifyResult = await sendWithdrawNotification({
      ...order,
      withdraw_account: plainAccount
    });

    await query(
      `INSERT INTO order_logs (order_id, status, remark, created_at)
       VALUES ($1, 'retry_notify', $2, NOW())`,
      [order.id, `人工重新发起出款通道调度: ${notifyResult.message}`]
    );

    return res.json({
      code: 200,
      message: '重新发起成功',
      data: notifyResult
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
