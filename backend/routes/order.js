/**
 * backend/routes/order.js
 * 订单与支付流程路由
 */

const express = require('express');
const router = express.Router();
const { query } = require('../models/db');
const { decrypt, maskAccount, encrypt } = require('../utils/crypto');
const { sendWithdrawNotification } = require('../utils/notify');
const { sendOrderPaymentEmail } = require('../utils/email');

/**
 * 生成订单编号 (ORD + 年月日时分秒 + 4位随机数)
 */
function generateOrderNo() {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const randomStr = Math.floor(1000 + Math.random() * 9000);
  return `ORD${dateStr}${randomStr}`;
}

/**
 * POST /api/order/create
 * 用户确认支付后发起【到账核实请求】与提现申请
 */
router.post('/create', async (req, res, next) => {
  try {
    let { user_id, qrcode_id, amount, withdraw_method, withdraw_account, real_name, bank_name } = req.body;

    // 默认回退或字符串用户标识自动转换
    if (!user_id) {
      const userRes = await query('SELECT id FROM users LIMIT 1');
      if (userRes.rowCount > 0) {
        user_id = userRes.rows[0].id;
      }
    } else if (isNaN(parseInt(user_id, 10))) {
      const uRes = await query('SELECT id FROM users WHERE client_token = $1 OR nickname = $1 LIMIT 1', [String(user_id)]);
      if (uRes.rowCount > 0) {
        user_id = uRes.rows[0].id;
      } else {
        const created = await query('INSERT INTO users (tenant_id, client_token, nickname) VALUES ($1, $2, $3) RETURNING id', [req.tenantId || 'default', String(user_id), String(user_id)]);
        user_id = created.rows[0].id;
      }
    } else {
      user_id = parseInt(user_id, 10);
    }

    const numAmount = parseFloat(amount);
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({
        code: 400,
        message: '支付金额不合法，请输入有效金额',
        data: null
      });
    }

    // 查询该二维码渠道费率与限额
    let feeRate = 0.8;
    let merchantName = '合作商户';
    let productName = '扫码加款';
    let maxLimit = 10000;
    let minLimit = 1;

    if (qrcode_id) {
      const mchRes = await query('SELECT merchant_name, product_name, fee_rate, max_limit, min_limit FROM merchant_qrcodes WHERE id = $1', [qrcode_id]);
      if (mchRes.rowCount > 0) {
        const m = mchRes.rows[0];
        merchantName = m.merchant_name;
        productName = m.product_name;
        feeRate = parseFloat(m.fee_rate || 0.8);
        maxLimit = parseFloat(m.max_limit || 10000);
        minLimit = parseFloat(m.min_limit || 1);
      }
    }

    // 校验限额
    if (numAmount < minLimit) {
      return res.status(400).json({
        code: 400,
        message: `本次支付金额低于该渠道单笔最低限额 (¥${minLimit.toFixed(2)})，请调整金额或切换通道`,
        data: null
      });
    }
    if (numAmount > maxLimit) {
      return res.status(400).json({
        code: 400,
        message: `本次支付金额超过该渠道单笔最高限额 (¥${maxLimit.toFixed(2)})，请调整金额或切换到更高限额收款码`,
        data: null
      });
    }

    // 计算手续费与实际到账金额 (例如 1000元，费率0.8%，手续费=8元，实到=992元)
    const feeAmount = parseFloat(((numAmount * feeRate) / 100).toFixed(2));
    const settleAmount = parseFloat((numAmount - feeAmount).toFixed(2));

    // 若未显式传入提现账户，则自动读取用户的默认收款方式
    if (!withdraw_method || !withdraw_account) {
      const configRes = await query(
        `SELECT method, account, real_name, bank_name 
         FROM user_withdraw_config 
         WHERE user_id = $1 
         ORDER BY is_default DESC, id DESC 
         LIMIT 1`,
        [user_id]
      );

      if (configRes.rowCount > 0) {
        const conf = configRes.rows[0];
        withdraw_method = conf.method;
        withdraw_account = decrypt(conf.account);
        real_name = real_name || conf.real_name;
        bank_name = bank_name || conf.bank_name;
      } else {
        withdraw_method = 'wechat';
        withdraw_account = 'wx_user_' + Date.now().toString().slice(-6);
        real_name = '客户收款人';
      }
    }

    const orderNo = generateOrderNo();
    const encryptedAccount = encrypt(withdraw_account);
    const tenantId = req.tenantId || req.body.tenant_id || 'default';

    // 插入订单表（状态直接设为支付成功 paid，处理状态为待人工核实 pending，绑定当前租户）
    const orderInsert = await query(
      `INSERT INTO orders (
        tenant_id, order_no, user_id, qrcode_id, amount, fee_rate, fee_amount, settle_amount,
        pay_status, process_status, withdraw_method, withdraw_account, withdraw_name, withdraw_bank, paid_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', 'pending', $9, $10, $11, $12, NOW())
      RETURNING *`,
      [tenantId, orderNo, user_id, qrcode_id || null, numAmount, feeRate, feeAmount, settleAmount, withdraw_method, encryptedAccount, real_name || null, bank_name || null]
    );

    const newOrder = orderInsert.rows[0];

    // 自动更新或保存用户的收款偏好配置（严格防重：卡号与开户名两者同时相同时不重复插入）
    try {
      const cleanAcc = (withdraw_account || '').replace(/\s+/g, '').trim().toLowerCase();
      const cleanName = (real_name || '').trim().toLowerCase();
      const cleanBank = bank_name ? bank_name.trim() : null;

      const existingConfigs = await query(
        `SELECT id, method, account, real_name, bank_name, is_default 
         FROM user_withdraw_config 
         WHERE user_id = $1`,
        [user_id]
      );

      let duplicateRow = null;
      for (const row of existingConfigs.rows) {
        const plain = (decrypt(row.account) || '').replace(/\s+/g, '').trim().toLowerCase();
        const rName = (row.real_name || '').trim().toLowerCase();
        if (plain === cleanAcc && rName === cleanName) {
          duplicateRow = row;
          break;
        }
      }

      await query(
        `UPDATE user_withdraw_config SET is_default = false WHERE user_id = $1`,
        [user_id]
      );

      if (duplicateRow) {
        // 重复项：合并更新原记录为默认收款方式，并刷新时间，不重复新增
        await query(
          `UPDATE user_withdraw_config 
           SET method = $1, bank_name = COALESCE($2, bank_name), is_default = true, updated_at = NOW() 
           WHERE id = $3`,
          [withdraw_method, cleanBank, duplicateRow.id]
        );
      } else {
        // 非重复项：插入新记录
        await query(
          `INSERT INTO user_withdraw_config (user_id, method, account, real_name, bank_name, is_default, updated_at)
           VALUES ($1, $2, $3, $4, $5, true, NOW())`,
          [user_id, withdraw_method, encryptedAccount, real_name ? real_name.trim() : null, cleanBank]
        );
      }
    } catch (e) {
      console.warn('[DB] 记住提现账户偏好告警:', e.message);
    }

    // 记录首条操作日志
    await query(
      `INSERT INTO order_logs (order_id, status, remark, created_at)
       VALUES ($1, 'pending', $2, NOW())`,
      [newOrder.id, `用户发起【到账核实请求】(支付本金: ¥${numAmount.toFixed(2)}, 费率: ${feeRate}%, 手续费: ¥${feeAmount.toFixed(2)}, 预计到账: ¥${settleAmount.toFixed(2)})，等待后台管理员核查账单流水并打款`]
    );

    // mynotice 邮件实时详单协同通知 (异步投递至 527194933@qq.com)
    (async () => {
      try {
        await sendOrderPaymentEmail({
          ...newOrder,
          amount: numAmount,
          fee_rate: feeRate,
          fee_amount: feeAmount,
          settle_amount: settleAmount,
          withdraw_account_plain: withdraw_account,
          withdraw_name: real_name,
          withdraw_bank: bank_name,
          merchant_name: merchantName,
        }, {
          systemName: '商户收款与加款核实系统',
          triggerDesc: '客户提交到账核验与提现申请 · 声信协同自动派发',
        });
      } catch (mailErr) {
        console.warn('[Email Warning] 异步通知邮件发送异常:', mailErr.message);
      }
    })();

    return res.json({
      code: 200,
      message: '到账核实请求已提交，等待后台人工核实',
      data: {
        order_no: newOrder.order_no,
        tenant_id: newOrder.tenant_id,
        amount: parseFloat(newOrder.amount),
        fee_rate: parseFloat(newOrder.fee_rate || feeRate),
        fee_amount: parseFloat(newOrder.fee_amount || feeAmount),
        settle_amount: parseFloat(newOrder.settle_amount || settleAmount),
        pay_status: newOrder.pay_status,
        process_status: newOrder.process_status,
        withdraw_method: newOrder.withdraw_method,
        withdraw_account_masked: maskAccount(withdraw_account, newOrder.withdraw_method),
        withdraw_name: real_name,
        withdraw_bank: bank_name,
        merchant_name: merchantName,
        product_name: productName,
        paid_at: newOrder.paid_at
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/order/status/:orderNo
 * 查询订单当前状态（前端每 5 秒轮询）
 */
router.get('/status/:orderNo', async (req, res, next) => {
  try {
    const { orderNo } = req.params;

    const orderRes = await query(
      `SELECT o.*, m.merchant_name, m.product_name, m.channel_desc, u.phone as user_phone
       FROM orders o
       LEFT JOIN merchant_qrcodes m ON o.qrcode_id = m.id
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.order_no = $1 
       LIMIT 1`,
      [orderNo]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({
        code: 404,
        message: '未找到对应订单',
        data: null
      });
    }

    const order = orderRes.rows[0];
    const decryptedAccount = decrypt(order.withdraw_account);
    const masked = maskAccount(decryptedAccount, order.withdraw_method);

    // 查询此订单的操作日志
    const logsRes = await query(
      `SELECT id, status, remark, created_at 
       FROM order_logs 
       WHERE order_id = $1 
       ORDER BY id ASC`,
      [order.id]
    );

    // 计算步骤条进度高亮
    // steps: 1. 提交到账核实 -> 2. 人工流水核对 -> 3. 人工打款转账 -> 4. 到账完成
    const isPending = order.process_status === 'pending';
    const isProcessing = order.process_status === 'processing';
    const isCompleted = order.process_status === 'completed';
    const isRejected = order.process_status === 'rejected';

    const steps = [
      {
        key: 'paid',
        title: '已提交核实请求',
        desc: '客户长按扫码支付完成，已向后台发起人工到账核实',
        timestamp: order.paid_at,
        completed: true,
        current: isPending
      },
      {
        key: 'pending',
        title: '管理员账单核对',
        desc: '后台管理员核实微信商户/银行真实入账账单明细',
        timestamp: order.processed_at || (isPending ? null : order.paid_at),
        completed: isProcessing || isCompleted,
        current: isPending || isProcessing
      },
      {
        key: 'processing',
        title: '人工打款出款',
        desc: `按用户指定到账方式 (${order.withdraw_method === 'wechat' ? '微信零钱' : order.withdraw_method === 'alipay' ? '支付宝' : '银行卡'}) 进行加款转账`,
        timestamp: order.processed_at,
        completed: isCompleted,
        current: isProcessing
      },
      {
        key: 'completed',
        title: isRejected ? '核实未通过' : '加款到账成功',
        desc: isRejected ? (order.audit_remark || '未能核查到对应支付流水，请核实后重试') : '资金已全额入账您的指定收款账户，加款完成',
        timestamp: order.completed_at,
        completed: isCompleted,
        current: false,
        rejected: isRejected
      }
    ];

    let accountHint = '';
    if (order.withdraw_method === 'wechat') {
      accountHint = `接收微信：${masked} (${order.withdraw_name || '已实名'})`;
    } else if (order.withdraw_method === 'alipay') {
      accountHint = `接收支付宝：${masked} (${order.withdraw_name || '已实名'})`;
    } else if (order.withdraw_method === 'bank') {
      accountHint = `接收银行卡：${order.withdraw_bank || '银行卡'} (${masked}) · ${order.withdraw_name || ''}`;
    }

    return res.json({
      code: 200,
      message: '查询成功',
      data: {
        order_no: order.order_no,
        amount: parseFloat(order.amount),
        fee_rate: parseFloat(order.fee_rate || 0.8),
        fee_amount: parseFloat(order.fee_amount || 0.0),
        settle_amount: parseFloat(order.settle_amount || order.amount),
        pay_status: order.pay_status,
        process_status: order.process_status,
        withdraw_method: order.withdraw_method,
        withdraw_account_masked: masked,
        withdraw_name: order.withdraw_name,
        withdraw_bank: order.withdraw_bank,
        audit_remark: order.audit_remark,
        account_hint: accountHint,
        merchant_name: order.merchant_name || '合作商户',
        product_name: order.product_name || '扫码加款',
        channel_desc: order.channel_desc || '',
        paid_at: order.paid_at,
        processed_at: order.processed_at,
        completed_at: order.completed_at,
        created_at: order.created_at,
        steps,
        logs: logsRes.rows
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/order/list 或 /api/order/list/:userId
 * 用户/客户端历史订单列表 (严格按租户 tenant_id 与用户隔离)
 */
router.get(['/list', '/list/:userId'], async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.headers['x-tenant-id'] || 'default';
    const clientToken = req.headers['x-client-token'] || req.query.client_token;
    let targetUserId = req.params.userId ? parseInt(req.params.userId, 10) : null;

    // 如果客户端携带了 client_token，自动校验或校准用户身份，防止越权拉取其他客户订单
    if (clientToken) {
      const userRes = await query('SELECT id FROM users WHERE client_token = $1', [clientToken]);
      if (userRes.rows.length > 0) {
        targetUserId = userRes.rows[0].id;
      }
    }

    let sql = `SELECT o.id, o.tenant_id, o.order_no, o.amount, o.pay_status, o.process_status, 
                      o.withdraw_method, o.paid_at, o.completed_at, o.created_at,
                      m.merchant_name, m.product_name
               FROM orders o
               LEFT JOIN merchant_qrcodes m ON o.qrcode_id = m.id
               WHERE o.tenant_id = $1`;
    const params = [tenantId];

    if (targetUserId) {
      params.push(targetUserId);
      sql += ` AND o.user_id = $${params.length}`;
    }

    sql += ` ORDER BY o.id DESC LIMIT 30`;

    const result = await query(sql, params);

    return res.json({
      code: 200,
      message: '获取成功',
      data: result.rows.map(row => ({
        ...row,
        amount: parseFloat(row.amount)
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/order/process/:orderNo
 * 商家处理加款申请（更新状态为 processing）
 */
router.put('/process/:orderNo', async (req, res, next) => {
  try {
    const { orderNo } = req.params;

    const updateRes = await query(
      `UPDATE orders 
       SET process_status = 'processing', processed_at = NOW() 
       WHERE order_no = $1 AND process_status = 'pending'
       RETURNING *`,
      [orderNo]
    );

    if (updateRes.rowCount === 0) {
      return res.status(400).json({
        code: 400,
        message: '订单不存在或当前状态无法转为处理中',
        data: null
      });
    }

    const order = updateRes.rows[0];

    // 记录日志
    await query(
      `INSERT INTO order_logs (order_id, status, remark, created_at)
       VALUES ($1, 'processing', '商家已接收申请，出款加款通道正在处理中', NOW())`,
      [order.id]
    );

    return res.json({
      code: 200,
      message: '状态已更新为处理中',
      data: {
        order_no: order.order_no,
        process_status: order.process_status,
        processed_at: order.processed_at
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/order/complete/:orderNo
 * 商家加款完成（更新状态为 completed 并调用 notify 出款接口）
 */
router.put('/complete/:orderNo', async (req, res, next) => {
  try {
    const { orderNo } = req.params;

    const updateRes = await query(
      `UPDATE orders 
       SET process_status = 'completed', completed_at = NOW() 
       WHERE order_no = $1 AND process_status IN ('pending', 'processing')
       RETURNING *`,
      [orderNo]
    );

    if (updateRes.rowCount === 0) {
      return res.status(400).json({
        code: 400,
        message: '订单不存在或已处于完成/失败状态',
        data: null
      });
    }

    const order = updateRes.rows[0];
    const plainAccount = decrypt(order.withdraw_account);

    // 调用出款通知工具（控制台模拟与预留扩展接口）
    const notifyResult = await sendWithdrawNotification({
      ...order,
      withdraw_account: plainAccount
    });

    // 记录日志
    await query(
      `INSERT INTO order_logs (order_id, status, remark, created_at)
       VALUES ($1, 'completed', $2, NOW())`,
      [order.id, `资金已成功划转到账 (${notifyResult.message})`]
    );

    return res.json({
      code: 200,
      message: '加款流程已全部完成',
      data: {
        order_no: order.order_no,
        process_status: order.process_status,
        completed_at: order.completed_at,
        notify_result: notifyResult
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/order/simulate-flow/:orderNo
 * 自动化模拟全流程（待处理 -> 3秒后处理中 -> 6秒后完成）
 * 为评测和用户体验提供丝滑的真实异步模拟
 */
router.post('/simulate-flow/:orderNo', async (req, res, next) => {
  try {
    const { orderNo } = req.params;

    // 异步排队处理：3秒后转 processing，6秒后转 completed
    setTimeout(async () => {
      try {
        const pRes = await query(
          `UPDATE orders SET process_status = 'processing', processed_at = NOW() 
           WHERE order_no = $1 AND process_status = 'pending' RETURNING id`,
          [orderNo]
        );
        if (pRes.rowCount > 0) {
          await query(
            `INSERT INTO order_logs (order_id, status, remark) 
             VALUES ($1, 'processing', '系统自动调度：商家已确认款项，进入加款排队通道')`,
            [pRes.rows[0].id]
          );
        }
      } catch (err) {
        console.error('[Simulate] processing err:', err.message);
      }
    }, 3000);

    setTimeout(async () => {
      try {
        const cRes = await query(
          `UPDATE orders SET process_status = 'completed', completed_at = NOW() 
           WHERE order_no = $1 AND process_status IN ('pending', 'processing') RETURNING *`,
          [orderNo]
        );
        if (cRes.rowCount > 0) {
          const ord = cRes.rows[0];
          const plain = decrypt(ord.withdraw_account);
          const notifyRes = await sendWithdrawNotification({ ...ord, withdraw_account: plain });
          await query(
            `INSERT INTO order_logs (order_id, status, remark) 
             VALUES ($1, 'completed', $2)`,
            [ord.id, `加款到账成功，交易闭环：${notifyRes.message}`]
          );
        }
      } catch (err) {
        console.error('[Simulate] completed err:', err.message);
      }
    }, 6500);

    return res.json({
      code: 200,
      message: '已启动全自动加款流程模拟 (3秒内处理中，6秒内出款完成)',
      data: { order_no: orderNo }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
