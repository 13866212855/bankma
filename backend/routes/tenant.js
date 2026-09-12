/**
 * backend/routes/tenant.js
 * 多租户公共信息与切换接口 (mysingledomain2mul)
 */

const express = require('express');
const router = express.Router();
const { getAllTenants, getTenantById } = require('../utils/tenant');

/**
 * GET /api/tenant/current
 * 获取当前访问上下文所匹配的租户信息
 */
router.get('/current', async (req, res, next) => {
  try {
    const tenantId = req.tenantId || 'default';
    const tenant = await getTenantById(tenantId);

    if (!tenant) {
      return res.json({
        code: 200,
        message: '获取成功',
        data: {
          tenant_id: 'default',
          name: '总部门户',
          description: '扫码加款核心通道',
          is_active: true,
          config: {}
        }
      });
    }

    return res.json({
      code: 200,
      message: '获取成功',
      data: {
        tenant_id: tenant.tenant_id,
        name: tenant.name,
        description: tenant.description,
        is_active: tenant.is_active,
        config: typeof tenant.config === 'string' ? JSON.parse(tenant.config || '{}') : (tenant.config || {})
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tenant/list
 * 获取所有启用的租户列表（供前台租户切换器或快速通道使用）
 */
router.get('/list', async (req, res, next) => {
  try {
    const tenants = await getAllTenants(true);
    const list = tenants.map(t => ({
      tenant_id: t.tenant_id,
      name: t.name,
      description: t.description,
      config: typeof t.config === 'string' ? JSON.parse(t.config || '{}') : (t.config || {})
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

module.exports = router;
