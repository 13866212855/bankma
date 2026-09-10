/**
 * backend/routes/user.js
 * 用户配置路由
 */

const express = require('express');
const router = express.Router();
const { query } = require('../models/db');
const { encrypt, decrypt, maskAccount } = require('../utils/crypto');

/**
 * GET /api/user/current
 * 获取默认当前登录用户（演示与快速启动环境）
 */
router.get('/current', async (req, res, next) => {
  try {
    let userRes = await query('SELECT id, phone, created_at FROM users LIMIT 1');
    if (userRes.rowCount === 0) {
      const created = await query('INSERT INTO users (phone) VALUES ($1) RETURNING *', ['13800138000']);
      return res.json({
        code: 200,
        message: '获取成功',
        data: created.rows[0]
      });
    }

    return res.json({
      code: 200,
      message: '获取成功',
      data: userRes.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/user/config/:userId
 * 获取用户收款配置（返回解密后的明文与脱敏版）
 */
router.get('/config/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;

    const result = await query(
      `SELECT id, user_id, method, account, real_name, bank_name, is_default, updated_at
       FROM user_withdraw_config 
       WHERE user_id = $1 
       ORDER BY is_default DESC, id ASC`,
      [userId]
    );

    const configs = result.rows.map(item => {
      const plainAccount = decrypt(item.account);
      return {
        id: item.id,
        user_id: item.user_id,
        method: item.method,
        account: plainAccount, // 便于用户在设置表单中回显与修改
        account_masked: maskAccount(plainAccount, item.method),
        real_name: item.real_name || '',
        bank_name: item.bank_name || '',
        is_default: item.is_default,
        updated_at: item.updated_at
      };
    });

    // 提取当前默认的收款方式
    const defaultConfig = configs.find(c => c.is_default) || configs[0] || null;

    return res.json({
      code: 200,
      message: '获取收款配置成功',
      data: {
        configs,
        default_method: defaultConfig ? defaultConfig.method : 'wechat',
        default_config: defaultConfig
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/user/config
 * 新增/更新用户收款配置
 */
router.post('/config', async (req, res, next) => {
  try {
    let { user_id, method, account, real_name, bank_name, is_default } = req.body;

    if (!method || !['wechat', 'alipay', 'bank'].includes(method)) {
      return res.status(400).json({
        code: 400,
        message: '收款方式必须为 wechat、alipay 或 bank',
        data: null
      });
    }

    if (!account || typeof account !== 'string' || !account.trim()) {
      return res.status(400).json({
        code: 400,
        message: '收款账号不能为空',
        data: null
      });
    }

    if (method === 'bank' && (!bank_name || !real_name)) {
      return res.status(400).json({
        code: 400,
        message: '银行卡收款必须提供开户行名称与开户人姓名',
        data: null
      });
    }

    // 默认兜底用户
    if (!user_id) {
      const userRes = await query('SELECT id FROM users LIMIT 1');
      user_id = userRes.rowCount > 0 ? userRes.rows[0].id : 1;
    }

    // 若设为默认，先将该用户现有的其他配置 is_default 重置为 false
    if (is_default) {
      await query(
        `UPDATE user_withdraw_config SET is_default = false WHERE user_id = $1`,
        [user_id]
      );
    }

    // 对账号进行 AES 加密存储
    const encryptedAccount = encrypt(account.trim());

    // 检查此用户该收款类型是否已存在，若存在则更新，否则新增
    const checkRes = await query(
      `SELECT id FROM user_withdraw_config WHERE user_id = $1 AND method = $2 LIMIT 1`,
      [user_id, method]
    );

    let savedRow;
    if (checkRes.rowCount > 0) {
      const updateRes = await query(
        `UPDATE user_withdraw_config 
         SET account = $1, real_name = $2, bank_name = $3, is_default = $4, updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [encryptedAccount, real_name ? real_name.trim() : null, bank_name ? bank_name.trim() : null, !!is_default, checkRes.rows[0].id]
      );
      savedRow = updateRes.rows[0];
    } else {
      const insertRes = await query(
        `INSERT INTO user_withdraw_config (user_id, method, account, real_name, bank_name, is_default)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [user_id, method, encryptedAccount, real_name ? real_name.trim() : null, bank_name ? bank_name.trim() : null, !!is_default]
      );
      savedRow = insertRes.rows[0];
    }

    return res.json({
      code: 200,
      message: '收款方式保存成功',
      data: {
        id: savedRow.id,
        user_id: savedRow.user_id,
        method: savedRow.method,
        account_masked: maskAccount(account.trim(), method),
        real_name: savedRow.real_name,
        bank_name: savedRow.bank_name,
        is_default: savedRow.is_default
      }
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
