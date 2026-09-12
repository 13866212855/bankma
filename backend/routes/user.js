/**
 * backend/routes/user.js
 * 用户配置路由 - 客户端专属身份隔离、成员账号管理与收款渠道防重存储
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../models/db');
const { encrypt, decrypt, maskAccount } = require('../utils/crypto');

/**
 * 辅助检查请求是否具备管理员权限
 */
function isAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return Boolean(token && token.length > 10);
}

/**
 * 核心解析函数：根据客户端传递的唯一设备标识 (X-Client-Token) 解析并绑定独立专属用户
 * 确保每一个客户端设备拥有绝对独立的数据空间，绝不混淆、绝不串用！
 */
async function resolveClientUser(req) {
  let clientToken = req.headers['x-client-token'] || req.query.client_token;
  if (req.body && req.body.client_token) {
    clientToken = req.body.client_token;
  }

  if (clientToken && typeof clientToken === 'string' && clientToken.trim()) {
    const cleanToken = clientToken.trim();
    const existing = await query(
      'SELECT id, phone, nickname, client_token, created_at FROM users WHERE client_token = $1',
      [cleanToken]
    );
    if (existing.rowCount > 0) {
      return existing.rows[0];
    }

    // 首次使用该 Token，为其开辟独立专属用户空间
    const nickname = '专属客户 #' + cleanToken.slice(-4);
    const created = await query(
      'INSERT INTO users (client_token, nickname) VALUES ($1, $2) RETURNING id, phone, nickname, client_token, created_at',
      [cleanToken, nickname]
    );
    return created.rows[0];
  }

  // 若前端尚未生成 Token，服务端自生成一个唯一 Token
  const genToken = 'ct_' + crypto.randomBytes(16).toString('hex');
  const nickname = '专属客户 #' + genToken.slice(-4);
  const created = await query(
    'INSERT INTO users (client_token, nickname) VALUES ($1, $2) RETURNING id, phone, nickname, client_token, created_at',
    [genToken, nickname]
  );
  return created.rows[0];
}

/**
 * POST /api/user/init
 * 客户端启动初始化（识别客户端唯一性，建立独立安全空间）
 */
router.post('/init', async (req, res, next) => {
  try {
    const user = await resolveClientUser(req);
    return res.json({
      code: 200,
      message: '客户端身份初始化成功',
      data: user
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/user/current
 * 获取当前客户端绑定的用户信息
 */
router.get('/current', async (req, res, next) => {
  try {
    const user = await resolveClientUser(req);
    return res.json({
      code: 200,
      message: '获取成功',
      data: user
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/user/switch-or-bind
 * 成员管理功能：允许客户输入手机号进行快捷注册/登录绑定或切换账号
 */
router.post('/switch-or-bind', async (req, res, next) => {
  try {
    const { phone, nickname } = req.body || {};
    const clientToken = req.headers['x-client-token'] || req.body?.client_token;

    if (!phone || typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone.trim())) {
      return res.status(400).json({
        code: 400,
        message: '请输入正确的11位手机号码',
        data: null
      });
    }

    const cleanPhone = phone.trim();
    const cleanNick = nickname ? nickname.trim() : null;

    // 检查此手机号是否已存在
    const phoneUserRes = await query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);

    let targetUser;
    if (phoneUserRes.rowCount > 0) {
      // 手机号已存在：切换该设备绑定为此已有用户
      targetUser = phoneUserRes.rows[0];
      if (clientToken && typeof clientToken === 'string') {
        await query('UPDATE users SET client_token = $1 WHERE id = $2', [clientToken.trim(), targetUser.id]);
        targetUser.client_token = clientToken.trim();
      }
    } else {
      // 手机号不存在：为当前客户端用户绑定手机号并升级为正式会员
      const currentUser = await resolveClientUser(req);
      const updateRes = await query(
        'UPDATE users SET phone = $1, nickname = COALESCE($2, nickname, $3) WHERE id = $4 RETURNING *',
        [cleanPhone, cleanNick, '客户' + cleanPhone.slice(-4), currentUser.id]
      );
      targetUser = updateRes.rows[0];
    }

    return res.json({
      code: 200,
      message: `已成功绑定/切换至手机账号: ${cleanPhone}`,
      data: targetUser
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/user/config/:userId
 * 获取用户收款配置（严格隔离：只允许查看客户端自己的配置，绝不允许查看其他客户信息）
 */
router.get('/config/:userId', async (req, res, next) => {
  try {
    const clientUser = await resolveClientUser(req);
    const targetUserId = parseInt(req.params.userId, 10);

    // 严格安全越权防护 (IDOR)：若非当前客户端绑定的用户且非管理员，强制阻断访问
    if (clientUser.id !== targetUserId && !isAdmin(req)) {
      return res.status(403).json({
        code: 403,
        message: '权限拒绝：您只能查看本客户端自己的收款配置，已保护隐私安全',
        data: {
          configs: [],
          default_method: 'wechat',
          default_config: null
        }
      });
    }

    const result = await query(
      `SELECT id, user_id, method, account, real_name, bank_name, is_default, updated_at
       FROM user_withdraw_config 
       WHERE user_id = $1 
       ORDER BY is_default DESC, updated_at DESC, id DESC`,
      [clientUser.id]
    );

    // 解密并执行客户端维度的精确判重过滤（卡号与姓名两者不能同时一样）
    const seenMap = new Set();
    const configs = [];

    for (const item of result.rows) {
      const plainAccount = decrypt(item.account) || '';
      const normAcc = plainAccount.replace(/\s+/g, '').trim().toLowerCase();
      const normName = (item.real_name || '').trim().toLowerCase();
      const uniqueKey = `${normAcc}_${normName}`;

      if (!seenMap.has(uniqueKey)) {
        seenMap.add(uniqueKey);
        configs.push({
          id: item.id,
          user_id: item.user_id,
          method: item.method,
          account: plainAccount,
          account_masked: maskAccount(plainAccount, item.method),
          real_name: item.real_name || '',
          bank_name: item.bank_name || '',
          is_default: item.is_default,
          updated_at: item.updated_at
        });
      }
    }

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
 * 核心规则：收款配置的信息记录不要重复（即卡号和用户名两者不能同时一样，不然就判为重复项）
 */
router.post('/config', async (req, res, next) => {
  try {
    const clientUser = await resolveClientUser(req);
    const userId = clientUser.id; // 强制使用当前已验证的独立客户端用户 ID

    let { method, account, real_name, bank_name, is_default } = req.body;

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

    const cleanAccount = account.replace(/\s+/g, '').trim();
    const cleanRealName = (real_name || '').trim();
    const cleanBankName = bank_name ? bank_name.trim() : null;

    // 1. 若设为默认，重置该用户其他的默认标记
    if (is_default) {
      await query(
        `UPDATE user_withdraw_config SET is_default = false WHERE user_id = $1`,
        [userId]
      );
    }

    // 2. 判重规则检测：查询该用户已有收款记录，比对【卡号】与【开户用户名】
    const existingConfigs = await query(
      `SELECT id, method, account, real_name, bank_name, is_default 
       FROM user_withdraw_config 
       WHERE user_id = $1`,
      [userId]
    );

    let duplicateRow = null;
    for (const row of existingConfigs.rows) {
      const plainAcc = (decrypt(row.account) || '').replace(/\s+/g, '').trim().toLowerCase();
      const rName = (row.real_name || '').trim().toLowerCase();

      // 卡号和用户名两者同时相同，判为重复项
      if (plainAcc === cleanAccount.toLowerCase() && rName === cleanRealName.toLowerCase()) {
        duplicateRow = row;
        break;
      }
    }

    let savedRow;
    let actionMessage = '收款渠道保存成功';

    if (duplicateRow) {
      // 判定为重复项：不创建新记录，合并更新已有记录
      actionMessage = '该收款渠道已存在，已为您自动合并并更新至最新状态！';
      const updateRes = await query(
        `UPDATE user_withdraw_config 
         SET method = $1, bank_name = COALESCE($2, bank_name), is_default = $3, updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [method, cleanBankName, !!is_default, duplicateRow.id]
      );
      savedRow = updateRes.rows[0];
    } else {
      // 判定为全新记录：执行新增插入
      const encryptedAccount = encrypt(cleanAccount);
      const insertRes = await query(
        `INSERT INTO user_withdraw_config (user_id, method, account, real_name, bank_name, is_default, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [userId, method, encryptedAccount, cleanRealName || null, cleanBankName, !!is_default]
      );
      savedRow = insertRes.rows[0];
    }

    return res.json({
      code: 200,
      message: actionMessage,
      data: {
        id: savedRow.id,
        user_id: savedRow.user_id,
        method: savedRow.method,
        account_masked: maskAccount(cleanAccount, method),
        real_name: savedRow.real_name,
        bank_name: savedRow.bank_name,
        is_default: savedRow.is_default
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/user/config/:id
 * 移除某一条绑定的收款渠道
 */
router.delete('/config/:id', async (req, res, next) => {
  try {
    const clientUser = await resolveClientUser(req);
    const configId = parseInt(req.params.id, 10);

    const delRes = await query(
      'DELETE FROM user_withdraw_config WHERE id = $1 AND user_id = $2 RETURNING id',
      [configId, clientUser.id]
    );

    if (delRes.rowCount === 0) {
      return res.status(404).json({
        code: 404,
        message: '未找到该收款渠道或无权移除',
        data: null
      });
    }

    return res.json({
      code: 200,
      message: '已成功移除该收款渠道',
      data: { id: configId }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
