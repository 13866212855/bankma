/**
 * 管理后台专属路由 (Admin API)
 * 提供管理员认证、收款码图片上传/管理、订单监控及统计数据接口
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const crypto = require('crypto');
const { query, hashAdminPassword, verifyAdminPassword } = require('../models/db');
const { maskAccount, decrypt } = require('../utils/crypto');
const { sendTestEmail } = require('../utils/email');
const { generateTTSAudio } = require('../utils/tts');
const { getAllTenants, getTenantById, invalidateTenantCache } = require('../utils/tenant');

// 管理端会话 Session 缓存 (映射 Token -> 用户信息，支持多租户与角色隔离)
const activeAdminSessions = new Map([
  ['admin_dev_token_secret_123', {
    id: 0,
    username: 'admin',
    tenant_id: 'default',
    role: 'superadmin',
    login_time: new Date().toISOString()
  }]
]);

/**
 * 校验管理端 Token 中间件 (支持超级总台管理员与各子租户管理员)
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;
  const token = (authHeader && authHeader.replace(/^Bearer\s+/, '')) || queryToken;

  if (!token) {
    return res.status(401).json({
      code: 401,
      message: '管理员未登录或登录凭证已过期，请重新登录',
      data: null
    });
  }

  let session = activeAdminSessions.get(token);
  if (!session) {
    // 兼容历史硬编码 dev token
    if (token === 'admin_dev_token_secret_123') {
      session = {
        id: 0,
        username: 'admin',
        tenant_id: 'default',
        role: 'superadmin',
        login_time: new Date().toISOString()
      };
      activeAdminSessions.set(token, session);
    } else {
      return res.status(401).json({
        code: 401,
        message: '管理员会话已失效，请重新登录',
        data: null
      });
    }
  }

  req.adminUser = session;
  next();
}

/**
 * 仅限超级管理员 (总台 default) 的权限校验中间件
 * 注意：子租户后台并无删除订单等超管权限！
 */
function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    const isSuper = req.adminUser.role === 'superadmin' || req.adminUser.tenant_id === 'default';
    if (!isSuper) {
      return res.status(403).json({
        code: 403,
        message: '权限不足：该功能（如删除/清空订单）仅归超级管理总台所有，子租户管理后台无权执行。',
        data: null
      });
    }
    next();
  });
}

/**
 * POST /api/admin/login
 * 管理员登录接口（支持多租户独立账号与密码校验，默认初始密码 admin123，可随时独立修改）
 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password, tenant_id } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        code: 400,
        message: '请输入管理员账号和密码',
        data: null
      });
    }

    // 智能识别登录租户空间：优先使用请求体中的 tenant_id，其次 header，其次当前中间件租户，缺省 default (超级总台)
    const rawTenant = tenant_id || req.headers['x-tenant-id'] || req.query.tenant || (req.tenant && req.tenant.tenant_id) || 'default';
    const cleanTenant = rawTenant.trim().toLowerCase();
    const cleanUsername = username.trim();
    const cleanPassword = String(password).trim();

    // 查询该租户空间下的管理员账号
    let userRes = await query(
      'SELECT id, tenant_id, username, password_hash, salt, role FROM admin_users WHERE tenant_id = $1 AND username = $2',
      [cleanTenant, cleanUsername]
    );

    let user = null;
    if (userRes.rowCount > 0) {
      user = userRes.rows[0];
      const isMatch = verifyAdminPassword(cleanPassword, user.password_hash, user.salt);
      // 兼容初始迁移默认密码 admin123
      const isDefaultFallback = !isMatch && cleanPassword === 'admin123' && user.password_hash === 'admin123';
      
      if (!isMatch && !isDefaultFallback) {
        return res.status(401).json({
          code: 401,
          message: `密码错误，请核对 [${cleanTenant}] 专区的管理员密码`,
          data: null
        });
      }
    } else {
      // 首次使用自动初始化该租户下的 admin 账号
      if (cleanUsername === 'admin' && cleanPassword === 'admin123') {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = hashAdminPassword('admin123', salt);
        const role = cleanTenant === 'default' ? 'superadmin' : 'tenant_admin';
        const createRes = await query(
          `INSERT INTO admin_users (tenant_id, username, password_hash, salt, role)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, username) DO UPDATE SET password_hash = EXCLUDED.password_hash
           RETURNING id, tenant_id, username, password_hash, salt, role`,
          [cleanTenant, cleanUsername, hash, salt, role]
        );
        user = createRes.rows[0];
      } else {
        return res.status(401).json({
          code: 401,
          message: `未找到租户 [${cleanTenant}] 的管理员账号或密码错误`,
          data: null
        });
      }
    }

    // 生成安全会话 Token 并关联租户与身份权限
    const token = `admin_token_${user.tenant_id}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const sessionData = {
      id: user.id,
      username: user.username,
      tenant_id: user.tenant_id,
      role: user.role,
      is_super_admin: user.role === 'superadmin' || user.tenant_id === 'default',
      login_time: new Date().toISOString()
    };
    activeAdminSessions.set(token, sessionData);

    return res.json({
      code: 200,
      message: '登录成功',
      data: {
        token,
        username: user.username,
        tenant_id: user.tenant_id,
        role: user.role,
        is_super_admin: sessionData.is_super_admin,
        login_time: sessionData.login_time
      }
    });
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
    activeAdminSessions.delete(token);
  }
  return res.json({
    code: 200,
    message: '已安全退出登录',
    data: null
  });
});

/**
 * GET /api/admin/check
 * 校验当前登录状态与当前登录租户信息
 */
router.get('/check', requireAdmin, (req, res) => {
  return res.json({
    code: 200,
    message: '凭证有效',
    data: {
      username: req.adminUser.username,
      tenant_id: req.adminUser.tenant_id,
      role: req.adminUser.role,
      is_super_admin: req.adminUser.role === 'superadmin' || req.adminUser.tenant_id === 'default'
    }
  });
});

/**
 * PUT /api/admin/password
 * 修改当前登录管理员密码 (所有后台通用，每个子租户独立修改，修改后只对当前租户生效)
 */
router.put('/password', requireAdmin, async (req, res, next) => {
  try {
    const { old_password, new_password, confirm_password } = req.body || {};

    if (!old_password || !new_password) {
      return res.status(400).json({ code: 400, message: '请填写原密码和新密码' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ code: 400, message: '新密码长度至少需要 6 个字符' });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ code: 400, message: '两次输入的新密码不一致，请重新核对' });
    }

    const { tenant_id, username } = req.adminUser;

    // 获取当前用户记录
    const userRes = await query(
      'SELECT id, password_hash, salt FROM admin_users WHERE tenant_id = $1 AND username = $2',
      [tenant_id, username]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ code: 404, message: '未找到管理员账号' });
    }

    const user = userRes.rows[0];

    // 验证原密码
    const isMatch = verifyAdminPassword(old_password, user.password_hash, user.salt);
    const isDefaultFallback = !isMatch && old_password === 'admin123' && user.password_hash === 'admin123';
    if (!isMatch && !isDefaultFallback) {
      return res.status(400).json({ code: 400, message: '原密码错误，修改失败' });
    }

    // 生成新哈希与 Salt
    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hashAdminPassword(new_password, newSalt);

    await query(
      'UPDATE admin_users SET password_hash = $1, salt = $2, updated_at = NOW() WHERE tenant_id = $3 AND username = $4',
      [newHash, newSalt, tenant_id, username]
    );

    console.log(`[Admin] 租户 [${tenant_id}] 管理员账号 [${username}] 密码已成功更新`);

    return res.json({
      code: 200,
      message: `🎉 [${tenant_id === 'default' ? '超级总台' : tenant_id + ' 专区'}] 管理员密码修改成功！新密码已即刻生效。`,
      data: { tenant_id, username }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/tenants/:tenantId/reset-password
 * 超级管理员重置子租户管理员密码
 */
router.put('/tenants/:tenantId/reset-password', requireSuperAdmin, async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const { new_password } = req.body || {};

    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ code: 400, message: '重置密码长度至少需要 6 个字符' });
    }

    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hashAdminPassword(new_password, newSalt);

    const updateRes = await query(
      `INSERT INTO admin_users (tenant_id, username, password_hash, salt, role, updated_at)
       VALUES ($1, 'admin', $2, $3, 'tenant_admin', NOW())
       ON CONFLICT (tenant_id, username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           salt = EXCLUDED.salt,
           updated_at = NOW()
       RETURNING id, tenant_id, username`,
      [tenantId, newHash, newSalt]
    );

    return res.json({
      code: 200,
      message: `子租户 [${tenantId}] 管理员密码已成功重置！`,
      data: updateRes.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * ==================== 多租户管理 (mysingledomain2mul) ====================
 */

/**
 * GET /api/admin/tenants
 * 管理端获取所有租户列表（包含各自的二维码数量、订单数量与交易额统计）
 */
router.get('/tenants', requireAdmin, async (req, res, next) => {
  try {
    const tenantsList = await getAllTenants(false);

    // 统计各租户下的收款码数与订单统计
    const statsQuery = await query(`
      SELECT 
        tenant_id,
        COUNT(DISTINCT id) as total_orders,
        COALESCE(SUM(CASE WHEN process_status = 'completed' THEN amount ELSE 0 END), 0) as total_volume,
        COUNT(DISTINCT CASE WHEN process_status = 'pending' THEN id ELSE NULL END) as pending_orders
      FROM orders
      GROUP BY tenant_id
    `);
    const statsMap = {};
    for (const r of statsQuery.rows) {
      statsMap[r.tenant_id] = {
        total_orders: parseInt(r.total_orders, 10),
        total_volume: parseFloat(r.total_volume),
        pending_orders: parseInt(r.pending_orders, 10)
      };
    }

    const qrCountQuery = await query(`
      SELECT tenant_id, COUNT(*) as qr_count
      FROM merchant_qrcodes
      GROUP BY tenant_id
    `);
    const qrCountMap = {};
    for (const r of qrCountQuery.rows) {
      qrCountMap[r.tenant_id] = parseInt(r.qr_count, 10);
    }

    const enriched = tenantsList.map(t => ({
      id: t.id,
      tenant_id: t.tenant_id,
      name: t.name,
      description: t.description,
      domain: t.domain,
      upstream_url: t.upstream_url,
      is_active: t.is_active,
      config: typeof t.config === 'string' ? JSON.parse(t.config || '{}') : (t.config || {}),
      created_at: t.created_at,
      qr_count: qrCountMap[t.tenant_id] || 0,
      total_orders: (statsMap[t.tenant_id] && statsMap[t.tenant_id].total_orders) || 0,
      total_volume: (statsMap[t.tenant_id] && statsMap[t.tenant_id].total_volume) || 0,
      pending_orders: (statsMap[t.tenant_id] && statsMap[t.tenant_id].pending_orders) || 0
    }));

    return res.json({
      code: 200,
      message: '获取成功',
      data: {
        total: enriched.length,
        items: enriched
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/tenants
 * 创建新租户 (开辟全新专属隔离空间与子路径 /t/:tenantId/)
 */
router.post('/tenants', requireAdmin, async (req, res, next) => {
  try {
    const { tenant_id, name, description, domain, upstream_url, config, is_active } = req.body;

    if (!tenant_id || !tenant_id.trim()) {
      return res.status(400).json({ code: 400, message: '租户唯一英文标识 (tenant_id) 为必填项' });
    }
    const cleanTenantId = tenant_id.trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,30}$/.test(cleanTenantId)) {
      return res.status(400).json({ code: 400, message: '租户标识仅支持2-30位小写字母、数字、中划线或下划线' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ code: 400, message: '租户名称为必填项' });
    }

    // 检查是否已存在
    const existing = await query('SELECT id FROM tenants WHERE tenant_id = $1', [cleanTenantId]);
    if (existing.rowCount > 0) {
      return res.status(400).json({ code: 400, message: `租户标识 [${cleanTenantId}] 已存在，请更换其他标识` });
    }

    const insertRes = await query(`
      INSERT INTO tenants (tenant_id, name, description, domain, upstream_url, config, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      cleanTenantId,
      name.trim(),
      (description || '').trim(),
      (domain || '').trim() || null,
      (upstream_url || '').trim() || null,
      JSON.stringify(config || {}),
      is_active !== false
    ]);

    invalidateTenantCache(cleanTenantId);

    return res.status(201).json({
      code: 201,
      message: `租户 [${name.trim()}] 创建成功，已开辟子路径 /t/${cleanTenantId}/ 访问入口`,
      data: insertRes.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/tenants/:tenantId
 * 更新租户信息及 upstream 代理配置
 */
router.put('/tenants/:tenantId', requireAdmin, async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const { name, description, domain, upstream_url, config, is_active } = req.body;
    const cleanTenantId = tenantId.trim().toLowerCase();

    const check = await query('SELECT id, config FROM tenants WHERE tenant_id = $1', [cleanTenantId]);
    if (check.rowCount === 0) {
      return res.status(404).json({ code: 404, message: '未找到指定租户' });
    }

    const currentConfig = check.rows[0].config || {};
    const mergedConfig = config ? { ...(typeof currentConfig === 'string' ? JSON.parse(currentConfig) : currentConfig), ...config } : currentConfig;

    const updateRes = await query(`
      UPDATE tenants
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          domain = $3,
          upstream_url = $4,
          config = $5,
          is_active = COALESCE($6, is_active)
      WHERE tenant_id = $7
      RETURNING *
    `, [
      name ? name.trim() : null,
      description !== undefined ? description.trim() : null,
      domain !== undefined ? (domain ? domain.trim() : null) : null,
      upstream_url !== undefined ? (upstream_url ? upstream_url.trim() : null) : null,
      JSON.stringify(mergedConfig),
      is_active !== undefined ? Boolean(is_active) : null,
      cleanTenantId
    ]);

    invalidateTenantCache(cleanTenantId);

    return res.json({
      code: 200,
      message: '租户信息更新成功',
      data: updateRes.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/tenants/:tenantId
 * 停用/删除租户 (默认租户禁止删除)
 */
router.delete('/tenants/:tenantId', requireAdmin, async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const cleanTenantId = tenantId.trim().toLowerCase();

    if (cleanTenantId === 'default') {
      return res.status(400).json({ code: 400, message: '系统默认总部门户 (default) 为根租户，不可删除' });
    }

    const delRes = await query('DELETE FROM tenants WHERE tenant_id = $1 RETURNING *', [cleanTenantId]);
    if (delRes.rowCount === 0) {
      return res.status(404).json({ code: 404, message: '未找到对应租户' });
    }

    invalidateTenantCache(cleanTenantId);

    return res.json({
      code: 200,
      message: `租户 [${cleanTenantId}] 已成功移除`,
      data: { tenant_id: cleanTenantId }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/qrcodes
 * 获取所有商家收款码列表（管理端，支持按租户过滤、含激活状态、费率与限额）
 */
router.get('/qrcodes', requireAdmin, async (req, res, next) => {
  try {
    const filterTenant = req.query.tenant || req.query.tenant_id;
    let sql = `SELECT id, tenant_id, merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active, created_at
               FROM merchant_qrcodes`;
    const params = [];

    if (filterTenant && filterTenant !== 'all') {
      sql += ` WHERE tenant_id = $1`;
      params.push(filterTenant.trim().toLowerCase());
    }

    sql += ` ORDER BY is_active DESC, id DESC`;

    const result = await query(sql, params);

    const list = result.rows.map(item => ({
      id: item.id,
      tenant_id: item.tenant_id || 'default',
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
      tenant_id,
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

    const targetTenant = (tenant_id || req.tenantId || 'default').trim().toLowerCase();

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

    // 若设为当前展示，先将同租户下的其他二维码设为非激活
    const shouldBeActive = is_active !== false;
    if (shouldBeActive) {
      await query(`UPDATE merchant_qrcodes SET is_active = false WHERE tenant_id = $1`, [targetTenant]);
    }

    const insertResult = await query(
      `INSERT INTO merchant_qrcodes 
        (tenant_id, merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        targetTenant,
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
 * PUT /api/admin/qrcode/:id
 * 编辑已有收款码的所有参数（商户名称、手续费率、最高最低限额、参考金额、通道描述、商品名称、展示状态、更换图片等）
 */
router.put('/qrcode/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ code: 400, message: '无效的二维码 ID' });
    }

    const {
      tenant_id,
      merchant_name,
      product_name,
      amount,
      fee_rate,
      max_limit,
      min_limit,
      channel_desc,
      qr_image_url,
      is_active
    } = req.body;

    if (!merchant_name || !merchant_name.trim()) {
      return res.status(400).json({ code: 400, message: '商户名称为必填项' });
    }

    const targetTenant = (tenant_id || 'default').trim().toLowerCase();
    const numAmount = parseFloat(amount !== undefined ? amount : 0);
    const numFeeRate = parseFloat(fee_rate !== undefined ? fee_rate : 0.8);
    const numMaxLimit = parseFloat(max_limit !== undefined ? max_limit : 10000);
    const numMinLimit = parseFloat(min_limit !== undefined ? min_limit : 1);

    if (isNaN(numFeeRate) || numFeeRate < 0) {
      return res.status(400).json({ code: 400, message: '手续费率必须为大于等于0的数值' });
    }

    if (isNaN(numMaxLimit) || numMaxLimit <= 0) {
      return res.status(400).json({ code: 400, message: '单笔最高限额必须大于0' });
    }

    // 若设为当前主推展示码，先将同租户下的其余置为 false
    if (is_active) {
      await query(`UPDATE merchant_qrcodes SET is_active = false WHERE tenant_id = $1 AND id != $2`, [targetTenant, id]);
    }

    let updateQuery;
    let queryParams;

    if (qr_image_url) {
      // 换了新图片
      updateQuery = `
        UPDATE merchant_qrcodes
        SET tenant_id = $1,
            merchant_name = $2,
            product_name = $3,
            amount = $4,
            fee_rate = $5,
            max_limit = $6,
            min_limit = $7,
            channel_desc = $8,
            qr_image_url = $9,
            is_active = $10
        WHERE id = $11
        RETURNING *
      `;
      queryParams = [
        targetTenant,
        merchant_name.trim(),
        (product_name || '扫码加款收款通道').trim(),
        numAmount,
        numFeeRate,
        numMaxLimit,
        numMinLimit,
        channel_desc || '',
        qr_image_url,
        Boolean(is_active),
        id
      ];
    } else {
      // 保持原有图片
      updateQuery = `
        UPDATE merchant_qrcodes
        SET tenant_id = $1,
            merchant_name = $2,
            product_name = $3,
            amount = $4,
            fee_rate = $5,
            max_limit = $6,
            min_limit = $7,
            channel_desc = $8,
            is_active = $9
        WHERE id = $10
        RETURNING *
      `;
      queryParams = [
        targetTenant,
        merchant_name.trim(),
        (product_name || '扫码加款收款通道').trim(),
        numAmount,
        numFeeRate,
        numMaxLimit,
        numMinLimit,
        channel_desc || '',
        Boolean(is_active),
        id
      ];
    }

    const updateRes = await query(updateQuery, queryParams);
    if (updateRes.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '未找到指定收款码' });
    }

    return res.json({
      code: 200,
      message: '收款码所有参数已成功更新并生效',
      data: updateRes.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/qrcode/:id/set-active
 * 将指定二维码设为前端展示的主收款码 (作用域限定在同租户空间)
 */
router.put('/qrcode/:id/set-active', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ code: 400, message: '无效的二维码 ID' });
    }

    // 先查询当前收款码所属租户
    const checkRes = await query('SELECT tenant_id FROM merchant_qrcodes WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ code: 404, message: '未找到指定二维码' });
    }
    const currentTenant = checkRes.rows[0].tenant_id || 'default';

    // 仅将同租户下的其他收款码置为 false
    await query(`UPDATE merchant_qrcodes SET is_active = false WHERE tenant_id = $1`, [currentTenant]);

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
 * 查看所有订单列表（管理端，支持按租户过滤、附带完整明细供人工核实和打款）
 */
router.get('/orders', requireAdmin, async (req, res, next) => {
  try {
    const filterTenant = req.query.tenant || req.query.tenant_id;
    let sql = `
      SELECT 
        o.id,
        o.tenant_id,
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
    `;
    const params = [];

    if (filterTenant && filterTenant !== 'all') {
      sql += ` WHERE o.tenant_id = $1`;
      params.push(filterTenant.trim().toLowerCase());
    }

    sql += ` ORDER BY o.id DESC LIMIT 100`;

    const result = await query(sql, params);

    const orders = result.rows.map(row => {
      let plainAccount = '';
      try {
        plainAccount = decrypt(row.withdraw_account || '');
      } catch (e) {
        plainAccount = row.withdraw_account || '';
      }
      return {
        ...row,
        tenant_id: row.tenant_id || 'default',
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
 * 获取概览统计数据 (支持按租户过滤或全局汇总)
 */
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const filterTenant = req.query.tenant || req.query.tenant_id;
    const isScoped = filterTenant && filterTenant !== 'all';
    const tenantParam = isScoped ? filterTenant.trim().toLowerCase() : null;

    let qCountSql = `SELECT COUNT(*) FROM merchant_qrcodes`;
    let oCountSql = `SELECT COUNT(*) FROM orders`;
    let sumAmountSql = `SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE process_status = 'completed'`;
    let pendingCountSql = `SELECT COUNT(*) FROM orders WHERE process_status = 'pending'`;
    const params = [];

    if (isScoped) {
      qCountSql += ` WHERE tenant_id = $1`;
      oCountSql += ` WHERE tenant_id = $1`;
      sumAmountSql += ` AND tenant_id = $1`;
      pendingCountSql += ` AND tenant_id = $1`;
      params.push(tenantParam);
    }

    const qCount = await query(qCountSql, params);
    const oCount = await query(oCountSql, params);
    const sumAmount = await query(sumAmountSql, params);
    const pendingCount = await query(pendingCountSql, params);

    // 租户总数
    const tenantCountRes = await query(`SELECT COUNT(*) FROM tenants WHERE is_active = true`);

    return res.json({
      code: 200,
      message: '获取成功',
      data: {
        total_qrcodes: parseInt(qCount.rows[0].count, 10),
        total_orders: parseInt(oCount.rows[0].count, 10),
        completed_amount: parseFloat(sumAmount.rows[0].total),
        pending_orders: parseInt(pendingCount.rows[0].count, 10),
        active_tenants: parseInt(tenantCountRes.rows[0].count, 10),
        current_tenant: isScoped ? tenantParam : 'all'
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/email/test
 * 发送测试邮件自检接口 (mynotice 技能)
 */
router.post('/email/test', requireAdmin, async (req, res, next) => {
  try {
    const { to_email } = req.body || {};
    const targetEmail = to_email || process.env.NOTIFY_EMAIL_TO || '527194933@qq.com';

    console.log(`[Admin] 管理员触发邮件自检测试，发送至: ${targetEmail}`);
    const result = await sendTestEmail(targetEmail);

    if (result.success) {
      return res.json({
        code: 200,
        message: `测试邮件已通过通道 [${result.channelUsed || 'IPv4'}] 成功发送至 ${targetEmail}！请检查手机 QQ 邮箱或微信邮件提醒。`,
        data: {
          target_email: targetEmail,
          message_id: result.messageId,
          channel_used: result.channelUsed,
          sent_at: new Date().toISOString()
        }
      });
    } else {
      return res.status(500).json({
        code: 500,
        message: `邮件发送失败: ${result.error}`,
        data: null
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * 生成 1 秒 16-bit PCM 静音 WAV 缓存 Buffer (用于后台 <audio loop> 媒体保活)
 */
function createSilentWavBuffer() {
  const sampleRate = 8000;
  const numSamples = 8000;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);
  return buffer;
}
const cachedSilentWav = createSilentWavBuffer();

/**
 * 生成清脆悦耳的 4 音阶和弦到单通知 WAV Buffer
 */
function createChimeWavBuffer() {
  const sampleRate = 22050;
  const duration = 0.85;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = Buffer.alloc(44 + numSamples * 2);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  const notes = [
    { freq: 523.25, start: 0, dur: 0.25 },
    { freq: 659.25, start: 0.12, dur: 0.25 },
    { freq: 783.99, start: 0.24, dur: 0.3 },
    { freq: 1046.5, start: 0.36, dur: 0.45 }
  ];

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const n of notes) {
      if (t >= n.start && t < n.start + n.dur) {
        const dt = t - n.start;
        const env = Math.exp(-dt * 8);
        sample += Math.sin(2 * Math.PI * n.freq * dt) * env * 0.4;
      }
    }
    const intVal = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    buffer.writeInt16LE(intVal, 44 + i * 2);
  }
  return buffer;
}
const cachedChimeWav = createChimeWavBuffer();

/**
 * GET /api/admin/audio/silent.wav
 * 后台保活静音音轨 (循环播放阻止移动端/微信休眠)
 */
router.get('/audio/silent.wav', (req, res) => {
  res.set({
    'Content-Type': 'audio/wav',
    'Content-Length': cachedSilentWav.length,
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes'
  });
  res.end(cachedSilentWav);
});

/**
 * GET /api/admin/audio/chime.wav
 * 到单清脆通知音 (兼容后台媒体音频播放)
 */
router.get('/audio/chime.wav', (req, res) => {
  res.set({
    'Content-Type': 'audio/wav',
    'Content-Length': cachedChimeWav.length,
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes'
  });
  res.end(cachedChimeWav);
});

/**
 * GET /api/admin/tts
 * POST /api/admin/tts
 * 语音 TTS MP3 流分发 (支持真实 <audio> 播放，移动端切到微信后台依旧能说话)
 */
async function handleTTS(req, res, next) {
  try {
    const text = req.query.text || req.body?.text || '';
    if (!text || !text.trim()) {
      return res.status(400).json({ code: 400, message: '请提供要播报的文本' });
    }

    const audioBuf = await generateTTSAudio(text.trim());
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuf.length,
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': 'bytes'
    });
    return res.end(audioBuf);
  } catch (err) {
    console.error('[Admin TTS] 合成异常:', err.message);
    return res.status(500).json({ code: 500, message: `语音合成失败: ${err.message}` });
  }
}

router.get('/tts', handleTTS);
router.post('/tts', handleTTS);

/**
 * ========== mysingledomain2mul 多租户空间管理 API ==========
 */

/**
 * GET /api/admin/tenants
 * 获取系统中所有注册的租户空间及其微服务反代配置
 */
router.get('/tenants', requireAdmin, async (req, res, next) => {
  try {
    const tenants = await getAllTenants();
    return res.json({
      code: 200,
      message: '获取租户列表成功',
      data: tenants
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/tenants
 * 动态开通/创建新的租户空间 (支持独立上游微服务代理配置与数据隔离空间)
 */
router.post('/tenants', requireAdmin, async (req, res, next) => {
  try {
    const { tenant_id, name, description, upstream_url, config } = req.body;
    if (!tenant_id || !name) {
      return res.status(400).json({
        code: 400,
        message: '租户标识 (tenant_id) 和租户名称 (name) 不能为空'
      });
    }

    const cleanId = tenant_id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanId) {
      return res.status(400).json({
        code: 400,
        message: '租户标识格式不合法，仅支持小写英文字母、数字、下划线及连字符'
      });
    }

    const existing = await getTenantById(cleanId);
    if (existing) {
      return res.status(400).json({
        code: 400,
        message: `租户 [${cleanId}] 已存在，无法重复创建`
      });
    }

    const insertRes = await query(
      `INSERT INTO tenants (tenant_id, name, description, upstream_url, config, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [cleanId, name.trim(), description || '', upstream_url || null, JSON.stringify(config || {})]
    );

    invalidateTenantCache(cleanId);

    return res.json({
      code: 200,
      message: `租户空间 [${name}] 开通成功`,
      data: insertRes.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/tenants/:tenantId
 * 更新指定租户的配置 (包括上游微服务路由、启停状态等)
 */
router.put('/tenants/:tenantId', requireAdmin, async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const { name, description, upstream_url, is_active, config } = req.body;

    const existing = await getTenantById(tenantId);
    if (!existing) {
      return res.status(404).json({
        code: 404,
        message: `租户 [${tenantId}] 不存在`
      });
    }

    const updateRes = await query(
      `UPDATE tenants
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           upstream_url = $3,
           is_active = COALESCE($4, is_active),
           config = COALESCE($5, config)
       WHERE tenant_id = $6
       RETURNING *`,
      [name, description, upstream_url, is_active, config ? JSON.stringify(config) : null, tenantId]
    );

    invalidateTenantCache(tenantId);

    return res.json({
      code: 200,
      message: '租户配置已更新',
      data: updateRes.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/tenants/:tenantId
 * 删除租户空间
 */
router.delete('/tenants/:tenantId', requireAdmin, async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    if (tenantId === 'default') {
      return res.status(400).json({
        code: 400,
        message: '系统默认总台租户 (default) 禁止删除'
      });
    }

    await query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
    invalidateTenantCache(tenantId);

    return res.json({
      code: 200,
      message: `租户 [${tenantId}] 已成功移除`
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
