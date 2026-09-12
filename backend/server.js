/**
 * backend/server.js
 * 客户扫码提现 H5 应用 - 主后端服务
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const dns = require('dns');

// 强制全局优先使用 IPv4，彻底杜绝 Render、Heroku、AWS 等云生产环境无 IPv6 路由引发的 connect ENETUNREACH 错误
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// 加载环境变量
dotenv.config();

const { initDatabase } = require('./models/db');
const { tenantMiddleware } = require('./utils/tenant');
const qrcodeRoutes = require('./routes/qrcode');
const orderRoutes = require('./routes/order');
const withdrawRoutes = require('./routes/withdraw');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const tenantRoutes = require('./routes/tenant');

const app = express();
// 平台反向代理仅支持监听 3000 端口
const PORT = 3000;

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

/**
 * 基础请求日志中间件
 */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`[API] ${req.method} ${req.path} - ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

/**
 * 基础安全鉴权中间件 (Token 验证)
 * 检查 Authorization: Bearer <token> 或 x-api-token
 * 为了保障前端 H5 用户顺畅访问，对静态资源和常规演示接口提供智能通行
 */
const authMiddleware = (req, res, next) => {
  // 静态页面与公共查询接口免鉴权
  if (!req.path.startsWith('/api')) {
    return next();
  }

  // 预留与提供标准 Token 校验能力
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-api-token'];
  const expectedToken = process.env.API_AUTH_TOKEN || 'demo-auth-token-2026';

  // 将 token 绑定在请求对象上
  req.authToken = token;

  // 如果请求头带有自定义 Token 校验（如果开启强制校验），可在此处拦截
  // 当前为了保证前端 H5 首次扫码体验零阻碍，若未传 Token 自动赋予合法的演示凭证并放行
  if (!token) {
    req.isGuest = true;
  } else if (token === expectedToken) {
    req.isAuthenticated = true;
  }

  next();
};

app.use(authMiddleware);
// 挂载多租户网关与路由解析中间件 (mysingledomain2mul)
app.use(tenantMiddleware);

// 挂载 API 路由
app.use('/api/tenant', tenantRoutes);
app.use('/api/qrcode', qrcodeRoutes);
app.use('/api/merchant', qrcodeRoutes); // 支持 /api/merchant/qrcode 与 /api/merchant/qrcodes
app.use('/api/order', orderRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);

// 静态文件服务：托管 frontend 目录
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// 路由页面别名与回退 (支持直接访问或租户子路径 /t/:tenantId/*)
const pageRoutes = [
  { path: '/admin', file: 'admin.html' },
  { path: '/scan', file: 'scan.html' },
  { path: '/status', file: 'status.html' },
  { path: '/settings', file: 'settings.html' },
  { path: '/', file: 'index.html' }
];

pageRoutes.forEach(({ path: pagePath, file }) => {
  // 根路径直达
  app.get(pagePath, (req, res) => {
    res.sendFile(path.join(frontendPath, file));
  });
  // 租户子路径直达 /t/:tenantId/...
  if (pagePath === '/') {
    app.get(/^\/t\/[a-zA-Z0-9_-]+\/?$/, (req, res) => {
      res.sendFile(path.join(frontendPath, 'index.html'));
    });
  } else {
    app.get(`/t/:tenantId${pagePath}`, (req, res) => {
      res.sendFile(path.join(frontendPath, file));
    });
  }
});

// 健康检查端点
app.get('/api/health', (req, res) => {
  res.json({
    code: 200,
    message: '服务运行正常',
    data: {
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      service: 'Customer QR Cashout H5 Backend'
    }
  });
});

// 未匹配到的 API 404 处理
app.use(/^\/api\/.*/, (req, res) => {
  res.status(404).json({
    code: 404,
    message: `接口未找到: ${req.method} ${req.originalUrl}`,
    data: null
  });
});

// 前端 SPA / 页面 Fallback
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// 全局异常处理中间件 (统一统一返回格式 { code, message, data })
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    code: statusCode,
    message: err.message || '服务器内部异常，请稍后重试',
    data: process.env.NODE_ENV === 'development' ? err.stack : null
  });
});

// 启动服务并初始化数据库
async function startServer() {
  try {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n=============================================================');
      console.log(`🎉 客户扫码提现 H5 应用服务启动成功!`);
      console.log(`🌐 访问地址: http://0.0.0.0:${PORT}`);
      console.log(`📱 手机浏览器可通过本地局域网 IP 访问: http://[本机IP]:${PORT}`);
      console.log('=============================================================\n');
    });
  } catch (error) {
    console.error('❌ 服务启动异常:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
