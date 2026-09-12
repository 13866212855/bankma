/**
 * backend/utils/tenant.js
 * mysingledomain2mul 单域名多租户与微服务网关核心解析器
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { query } = require('../models/db');

// 内存级租户元数据缓存 (TTL 30秒，保证高并发同时支持实时修改)
const tenantCache = new Map();
const CACHE_TTL = 30 * 1000;

/**
 * 获取租户信息 (带缓存)
 */
async function getTenantById(tenantId) {
  if (!tenantId) tenantId = 'default';
  const cleanId = String(tenantId).trim().toLowerCase();

  const cached = tenantCache.get(cleanId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }

  try {
    const res = await query('SELECT * FROM tenants WHERE tenant_id = $1', [cleanId]);
    let tenantData = null;
    if (res.rowCount > 0) {
      tenantData = res.rows[0];
    } else if (cleanId === 'default') {
      // 默认保障虚拟租户
      tenantData = {
        tenant_id: 'default',
        name: '默认聚合收银总台',
        description: '系统总部门户与全渠道通用收银专区',
        upstream_url: null,
        is_active: true,
        config: { theme: 'indigo', primary_color: '#4F46E5', fee_rate: 0.8 }
      };
    }

    if (tenantData) {
      tenantCache.set(cleanId, {
        timestamp: Date.now(),
        data: tenantData
      });
    }
    return tenantData;
  } catch (err) {
    console.warn(`[Tenant] 查询租户 [${cleanId}] 异常:`, err.message);
    return null;
  }
}

/**
 * 刷新某个租户缓存
 */
function invalidateTenantCache(tenantId) {
  if (tenantId) {
    tenantCache.delete(String(tenantId).trim().toLowerCase());
  } else {
    tenantCache.clear();
  }
}

/**
 * 获取所有可用租户列表
 */
async function getAllTenants(activeOnly = true) {
  try {
    const sql = activeOnly
      ? 'SELECT id, tenant_id, name, description, domain, upstream_url, is_active, config, created_at FROM tenants WHERE is_active = true ORDER BY id ASC'
      : 'SELECT id, tenant_id, name, description, domain, upstream_url, is_active, config, created_at FROM tenants ORDER BY id ASC';
    const res = await query(sql);
    return res.rows;
  } catch (err) {
    console.error('[Tenant] 获取租户列表异常:', err.message);
    return [];
  }
}

/**
 * 从请求中解析当前租户 ID
 * 优先级匹配：
 * 1. 明确的子路径路由: /t/:tenantId/... 或 /tenant/:tenantId/...
 * 2. 自定义 Header: x-tenant-id 或 x-tenant
 * 3. URL 查询参数: ?tenant=... 或 ?tenant_id=...
 * 4. Referer URL 中的 /t/:tenantId/ 路径识别
 * 5. 默认回退: 'default'
 */
function extractTenantId(req) {
  // 1. 检查子路径 (如 /t/ccb/api/... 或 /tenant/ccb/...)
  const path = req.path || req.url || '';
  const subpathMatch = path.match(/^\/(?:t|tenant)\/([a-zA-Z0-9_-]+)(?:\/|$)/i);
  if (subpathMatch && subpathMatch[1]) {
    return subpathMatch[1].toLowerCase();
  }

  // 2. 检查 Header
  const headerTenant = req.headers['x-tenant-id'] || req.headers['x-tenant'];
  if (headerTenant && typeof headerTenant === 'string' && headerTenant.trim()) {
    return headerTenant.trim().toLowerCase();
  }

  // 3. 检查 Query
  if (req.query) {
    const queryTenant = req.query.tenant || req.query.tenant_id;
    if (queryTenant && typeof queryTenant === 'string' && queryTenant.trim()) {
      return queryTenant.trim().toLowerCase();
    }
  }

  // 4. 检查 Referer / Origin
  const referer = req.headers.referer || req.headers.referrer;
  if (referer) {
    const refMatch = referer.match(/\/(?:t|tenant)\/([a-zA-Z0-9_-]+)(?:\/|\?|$)/i);
    if (refMatch && refMatch[1]) {
      return refMatch[1].toLowerCase();
    }
  }

  // 5. 默认租户
  return 'default';
}

/**
 * 多租户上下文注入与路由重写中间件
 */
async function tenantMiddleware(req, res, next) {
  try {
    const rawUrl = req.url || '';
    const subpathMatch = rawUrl.match(/^\/(?:t|tenant)\/([a-zA-Z0-9_-]+)(\/.*|$)/i);
    let subpathPrefix = '';

    let tenantId = 'default';
    if (subpathMatch && subpathMatch[1]) {
      tenantId = subpathMatch[1].toLowerCase();
      subpathPrefix = subpathMatch[0].substring(0, subpathMatch[0].length - (subpathMatch[2] ? subpathMatch[2].length : 0));
    } else {
      tenantId = extractTenantId(req);
    }

    let tenant = await getTenantById(tenantId);

    // 若指定了具体租户但数据库未找到，尝试降级到 default 或保留 tenantId
    if (!tenant) {
      tenant = await getTenantById('default') || {
        tenant_id: tenantId,
        name: `租户 (${tenantId})`,
        is_active: true
      };
    }

    req.tenantId = tenant.tenant_id || tenantId;
    req.tenant = tenant;

    // 响应头回显当前租户信息，便于前端与客户端网络感知
    res.setHeader('X-Resolved-Tenant', req.tenantId);

    // 如果配置了外部微服务 upstream_url (mysingledomain2mul)，且不是租户管理接口，则转发给对应内部容器
    if (tenant.upstream_url && !req.path.startsWith('/api/admin/tenants')) {
      return proxyToUpstream(req, res, tenant.upstream_url, subpathPrefix);
    }

    // 若带有子路径前缀 (如 /t/ccb/api/... 或 /t/ccb/scan)，重写 req.url 去掉前缀
    // 使得后续挂载的 Express 路由 /api/...、/scan、静态资源与页面能直接复用匹配
    if (subpathMatch) {
      const remaining = subpathMatch[2] || '/';
      req.originalTenantSubpath = subpathPrefix;
      req.url = remaining.startsWith('/') ? remaining : '/' + remaining;
    }

    next();
  } catch (err) {
    console.error('[Tenant Middleware Error]:', err.message);
    req.tenantId = 'default';
    next();
  }
}

/**
 * mysingledomain2mul 微服务反向代理流转发
 * 当某租户被配置了外部微服务 upstream_url (如 http://zhpj:3000 或 http://host.docker.internal:8081) 时，
 * 智能进行透明反向代理，解决单域名访问多内部容器微服务的难题！
 */
function proxyToUpstream(req, res, upstreamUrl, stripPrefix = '') {
  try {
    const targetUrl = new URL(upstreamUrl);
    let forwardPath = req.url;

    if (stripPrefix && forwardPath.startsWith(stripPrefix)) {
      forwardPath = forwardPath.slice(stripPrefix.length);
      if (!forwardPath.startsWith('/')) forwardPath = '/' + forwardPath;
    }

    const isHttps = targetUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const proxyHeaders = { ...req.headers };
    proxyHeaders['host'] = targetUrl.host;
    proxyHeaders['x-forwarded-host'] = req.headers['host'] || '';
    proxyHeaders['x-forwarded-proto'] = req.protocol || 'http';
    proxyHeaders['x-forwarded-prefix'] = stripPrefix;
    proxyHeaders['x-tenant-id'] = req.tenantId || '';

    delete proxyHeaders['connection'];

    const proxyReq = client.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: forwardPath,
      method: req.method,
      headers: proxyHeaders,
      timeout: 10000
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[Proxy Error] 转发到 upstream (${upstreamUrl}) 失败:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({
          code: 502,
          message: `微服务网关转发失败: 无法连接至该租户的上游服务 (${upstreamUrl})`,
          error: err.message
        });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({
          code: 504,
          message: `微服务网关转发超时: 上游服务响应超时 (${upstreamUrl})`
        });
      }
    });

    req.pipe(proxyReq);
  } catch (err) {
    console.error('[Proxy Handler Error]:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        code: 500,
        message: '代理处理发生异常',
        error: err.message
      });
    }
  }
}

async function resolveTenant(req) {
  const tenantId = extractTenantId(req);
  return await getTenantById(tenantId);
}

module.exports = {
  getTenantById,
  getAllTenants,
  extractTenantId,
  resolveTenant,
  tenantMiddleware,
  proxyToUpstream,
  invalidateTenantCache
};
