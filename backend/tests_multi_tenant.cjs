const http = require('http');
const express = require('express');
const { query, initDatabase } = require('./models/db.js');
const { tenantMiddleware } = require('./utils/tenant.js');
const qrRouter = require('./routes/qrcode.js');
const orderRouter = require('./routes/order.js');
const userRouter = require('./routes/user.js');
const adminRouter = require('./routes/admin.js');

async function runTests() {
  console.log('=== 开始多租户全面测试 (mysingledomain2mul) ===\n');
  await initDatabase();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(tenantMiddleware);

  app.use('/api/user', userRouter);
  app.use('/api/qrcode', qrRouter);
  app.use('/api/order', orderRouter);
  app.use('/api/admin', adminRouter);

  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[测试服务器] 已启动在端口: ${port}`);

  async function request(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, text };
    }
  }

  let passed = 0;
  let failed = 0;
  function assert(condition, testName) {
    if (condition) {
      console.log(`✅ [通过] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [失败] ${testName}`);
      failed++;
    }
  }

  try {
    // 1. 测试租户识别机制: Header, Subpath, Query
    console.log('\n--- 1. 租户识别测试 (Header, Subpath, Query) ---');
    const resHeader = await request('/api/qrcode/active', { headers: { 'X-Tenant-Id': 'ccb' } });
    assert(resHeader.status === 200, 'Header X-Tenant-Id 路由成功');

    const resSubpath = await request('/t/ahrcu/api/qrcode/active');
    assert(resSubpath.status === 200, 'Subpath /t/:tenantId/ 路由成功');

    const resQuery = await request('/api/qrcode/active?tenant=icbc');
    assert(resQuery.status === 200, 'Query param ?tenant= 路由成功');

    // 2. 测试租户元数据
    console.log('\n--- 2. 租户元数据检查 ---');
    const tenantsRes = await query('SELECT tenant_id, name FROM tenants ORDER BY tenant_id ASC');
    const tenantIds = tenantsRes.rows.map(r => r.tenant_id);
    assert(tenantIds.includes('default'), '存在 default 租户');
    assert(tenantIds.includes('ccb'), '存在 ccb 租户');
    assert(tenantIds.includes('ahrcu'), '存在 ahrcu 租户');
    assert(tenantIds.includes('icbc'), '存在 icbc 租户');

    // 3. 跨租户收款码隔离
    console.log('\n--- 3. 跨租户收款码数据隔离测试 ---');
    const ccbQr = await request('/api/qrcode/active', { headers: { 'X-Tenant-Id': 'ccb' } });
    assert(ccbQr.data.code === 200 && (ccbQr.data.data.tenant_id === 'ccb' || ccbQr.data.data.tenant_id === 'default'), 'CCB 空间独立获取收款码');

    // 4. 订单跨租户创建与数据防泄露
    console.log('\n--- 4. 订单跨租户隔离与防穿透测试 ---');
    const orderPayloadCcb = {
      user_id: 'test_user_ccb_001',
      amount: 888.00,
      withdraw_type: 'alipay',
      withdraw_account: 'ccb_user@alipay.com',
      withdraw_name: '建行测试客户'
    };
    const ccbOrderRes = await request('/t/ccb/api/order/create', {
      method: 'POST',
      body: JSON.stringify(orderPayloadCcb)
    });
    assert(ccbOrderRes.data.code === 200 && ccbOrderRes.data.data.tenant_id === 'ccb', 'CCB 租户成功创建订单并绑定 tenant_id=ccb');
    const ccbOrderNo = ccbOrderRes.data.data.order_no;

    const orderPayloadIcbc = {
      user_id: 'test_user_icbc_002',
      amount: 666.00,
      withdraw_type: 'wechat',
      withdraw_account: 'icbc_wx_pay',
      withdraw_name: '工行测试客户'
    };
    const icbcOrderRes = await request('/t/icbc/api/order/create', {
      method: 'POST',
      body: JSON.stringify(orderPayloadIcbc)
    });
    assert(icbcOrderRes.data.code === 200 && icbcOrderRes.data.data.tenant_id === 'icbc', 'ICBC 租户成功创建订单并绑定 tenant_id=icbc');
    const icbcOrderNo = icbcOrderRes.data.data.order_no;

    // 验证隔离性: CCB 空间无法查询 ICBC 订单
    const ccbOrderList = await request('/api/order/list', { headers: { 'X-Tenant-Id': 'ccb' } });
    const ccbHasIcbcOrder = ccbOrderList.data.data.some(o => o.order_no === icbcOrderNo);
    const ccbHasCcbOrder = ccbOrderList.data.data.some(o => o.order_no === ccbOrderNo);
    assert(ccbHasCcbOrder === true, 'CCB 空间可正常检索本租户订单');
    assert(ccbHasIcbcOrder === false, 'CCB 空间被严格隔离，绝不泄露 ICBC 订单');

    // 验证隔离性: ICBC 空间无法查询 CCB 订单
    const icbcOrderList = await request('/t/icbc/api/order/list');
    const icbcHasCcbOrder = icbcOrderList.data.data.some(o => o.order_no === ccbOrderNo);
    const icbcHasIcbcOrder = icbcOrderList.data.data.some(o => o.order_no === icbcOrderNo);
    assert(icbcHasIcbcOrder === true, 'ICBC 空间可正常检索本租户订单');
    assert(icbcHasCcbOrder === false, 'ICBC 空间被严格隔离，绝不泄露 CCB 订单');

    // 5. 测试多租户管理 API (动态开通新租户)
    console.log('\n--- 5. 动态开通租户生命周期测试 ---');
    const loginRes = await request('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    assert(loginRes.data.code === 200 && loginRes.data.data.token, '管理员登录验证成功');
    const token = loginRes.data.data.token;
    const adminHeaders = { 'Authorization': `Bearer ${token}` };

    const newTenantRes = await request('/api/admin/tenants', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        tenant_id: 'boc_test',
        name: '中国银行测试专区',
        description: 'BOC微服务与租户隔离专区'
      })
    });
    assert([200, 201].includes(newTenantRes.data?.code), '管理员动态开通新租户 boc_test 成功');

    // 在新租户下创建订单并验证隔离
    const bocOrderRes = await request('/t/boc_test/api/order/create', {
      method: 'POST',
      body: JSON.stringify({
        user_id: 'test_user_boc',
        amount: 999.00,
        withdraw_type: 'bank',
        withdraw_account: '6217000011112222',
        withdraw_name: '中行客户'
      })
    });
    assert(bocOrderRes.data.code === 200 && bocOrderRes.data.data.tenant_id === 'boc_test', '新动态租户 boc_test 路由与订单入库正常');

    // 清理测试数据
    await query("DELETE FROM orders WHERE tenant_id = 'boc_test' OR order_no IN ($1, $2)", [ccbOrderNo, icbcOrderNo]);
    await query("DELETE FROM tenants WHERE tenant_id = 'boc_test'");
    console.log('\n[测试环境] 测试数据已安全清理');

  } catch (err) {
    console.error('测试异常:', err);
    failed++;
  } finally {
    server.close();
    console.log(`\n=== 多租户全面测试完成: 通过 ${passed} 项, 失败 ${failed} 项 ===`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
