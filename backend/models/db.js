/**
 * backend/models/db.js
 * 数据库连接与自动初始化模块
 * 使用 PostgreSQL (Neon Serverless)
 */

const { Pool } = require('pg');
const dotenv = require('dotenv');
const QRCode = require('qrcode');

dotenv.config();

const connectionString = process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_MNZpYDS1BbT0@ep-nameless-hall-ay5yzr3w-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err.message);
});

/**
 * 统一参数化查询封装
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.DEBUG_SQL === 'true') {
      console.log('[SQL]', { text, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('[DB Query Error]', error.message, '\nQuery:', text);
    throw error;
  }
}

/**
 * 获取连接客户端（用于事务）
 */
async function getClient() {
  const client = await pool.connect();
  return client;
}

/**
 * 初始化数据库表结构与基础演示数据
 */
async function initDatabase() {
  console.log('[DB] 开始检查并初始化数据库表结构...');

  // 0. 多租户体系表 (mysingledomain2mul 单域名多租户架构)
  await query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(255),
      domain VARCHAR(100),
      upstream_url VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      config JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_tenant_id ON tenants(tenant_id);
  `);

  // 1. 用户表 (支持基于客户端设备唯一标识 client_token 隔离与手机号绑定登录，并支持租户空间划分)
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(50) DEFAULT 'default',
      client_token VARCHAR(100) UNIQUE,
      phone VARCHAR(50),
      nickname VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'default';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS client_token VARCHAR(100);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(100);
    ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_client_token ON users(client_token) WHERE client_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
  `);

  // 2. 用户收款配置表
  await query(`
    CREATE TABLE IF NOT EXISTS user_withdraw_config (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      method VARCHAR(20) NOT NULL,  -- 'wechat' | 'alipay' | 'bank'
      account VARCHAR(255) NOT NULL, -- AES 加密存储
      real_name VARCHAR(100),
      bank_name VARCHAR(100),
      is_default BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 3. 商家收款码表 (多租户隔离)
  await query(`
    CREATE TABLE IF NOT EXISTS merchant_qrcodes (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(50) DEFAULT 'default',
      merchant_name VARCHAR(100) NOT NULL,
      product_name VARCHAR(200) NOT NULL,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      fee_rate DECIMAL(6,3) NOT NULL DEFAULT 0.800, -- 手续费百分比 (如 0.8 代表 0.8%，千分之八)
      max_limit DECIMAL(10,2) NOT NULL DEFAULT 10000.00, -- 单笔限额最高
      min_limit DECIMAL(10,2) NOT NULL DEFAULT 1.00, -- 单笔限额最低
      channel_desc VARCHAR(200), -- 渠道通道特性
      qr_content TEXT UNIQUE NOT NULL,  -- 二维码解码内容
      qr_image_url TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 平滑迁移已有表结构字段
  await query(`
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'default';
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS fee_rate DECIMAL(6,3) DEFAULT 0.800;
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS max_limit DECIMAL(10,2) DEFAULT 10000.00;
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS min_limit DECIMAL(10,2) DEFAULT 1.00;
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS channel_desc VARCHAR(200);
    CREATE INDEX IF NOT EXISTS idx_merchant_qrcodes_tenant_id ON merchant_qrcodes(tenant_id);
  `);

  // 4. 订单表 (多租户隔离)
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(50) DEFAULT 'default',
      order_no VARCHAR(50) UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      qrcode_id INTEGER REFERENCES merchant_qrcodes(id) ON DELETE SET NULL,
      amount DECIMAL(10,2) NOT NULL,
      fee_rate DECIMAL(6,3) DEFAULT 0.000,
      fee_amount DECIMAL(10,2) DEFAULT 0.00,
      settle_amount DECIMAL(10,2) DEFAULT 0.00,
      pay_status VARCHAR(20) DEFAULT 'paid',       -- paid
      process_status VARCHAR(20) DEFAULT 'pending', -- pending (待人工核实) | processing (核实处理中) | completed (已核实并打款到账) | rejected (核实未通过)
      withdraw_method VARCHAR(20),
      withdraw_account VARCHAR(255),
      withdraw_name VARCHAR(100),
      withdraw_bank VARCHAR(100),
      audit_remark TEXT,
      paid_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 平滑迁移订单表字段
  await query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(50) DEFAULT 'default';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_rate DECIMAL(6,3) DEFAULT 0.000;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_amount DECIMAL(10,2) DEFAULT 0.00;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS settle_amount DECIMAL(10,2) DEFAULT 0.00;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS withdraw_name VARCHAR(100);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS withdraw_bank VARCHAR(100);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS audit_remark TEXT;
    CREATE INDEX IF NOT EXISTS idx_orders_tenant_id ON orders(tenant_id);
  `);

  // 5. 操作日志表
  await query(`
    CREATE TABLE IF NOT EXISTS order_logs (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      status VARCHAR(50) NOT NULL,
      remark TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('[DB] 数据库表结构初始化完成');

  // 预置默认多租户 (mysingledomain2mul)
  try {
    const tenantsList = [
      {
        tenant_id: 'default',
        name: '默认聚合收银总台',
        description: '系统总部门户，全银行渠道与聚合支付通道通用收银专区',
        upstream_url: null,
        config: { theme: 'indigo', primary_color: '#4F46E5', fee_rate: 0.8 }
      },
      {
        tenant_id: 'ccb',
        name: '中国建设银行特约商户专区',
        description: '建设银行商户专线聚合通道，支持信用卡与大额消费加款',
        upstream_url: null,
        config: { theme: 'blue', primary_color: '#0066B3', fee_rate: 0.8 }
      },
      {
        tenant_id: 'ahrcu',
        name: '安徽农金·金农信e付专区',
        description: '农村信用社/农商银行惠民小额专线，低手续费快捷收单',
        upstream_url: null,
        config: { theme: 'emerald', primary_color: '#059669', fee_rate: 0.5 }
      },
      {
        tenant_id: 'icbc',
        name: '中国工商银行商户e支付专区',
        description: '工商银行特约收银通道，全卡种支持与快速对账结算',
        upstream_url: null,
        config: { theme: 'red', primary_color: '#C7000B', fee_rate: 0.6 }
      }
    ];

    for (const t of tenantsList) {
      await query(`
        INSERT INTO tenants (tenant_id, name, description, upstream_url, config, is_active)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (tenant_id) DO UPDATE
        SET name = EXCLUDED.name,
            description = EXCLUDED.description,
            config = EXCLUDED.config
      `, [t.tenant_id, t.name, t.description, t.upstream_url, JSON.stringify(t.config)]);
    }
    console.log('[DB] 预置多租户 (default, ccb, ahrcu, icbc) 检验就绪');

    // 将历史收款码自动归集到对应租户
    await query(`UPDATE merchant_qrcodes SET tenant_id = 'ccb' WHERE merchant_name ILIKE '%建设银行%' AND (tenant_id IS NULL OR tenant_id = 'default')`);
    await query(`UPDATE merchant_qrcodes SET tenant_id = 'ahrcu' WHERE merchant_name ILIKE '%安徽农金%' AND (tenant_id IS NULL OR tenant_id = 'default')`);
    await query(`UPDATE merchant_qrcodes SET tenant_id = 'icbc' WHERE merchant_name ILIKE '%工商银行%' AND (tenant_id IS NULL OR tenant_id = 'default')`);
  } catch (tErr) {
    console.warn('[DB] 预置租户数据警告:', tErr.message);
  }

  // 预置演示用户与默认收款信息（方便直接体验与评测）
  try {
    const userRes = await query('SELECT id FROM users LIMIT 1');
    let defaultUserId;
    if (userRes.rowCount === 0) {
      const newUser = await query(
        'INSERT INTO users (phone, tenant_id) VALUES ($1, $2) RETURNING id',
        ['13800138000', 'default']
      );
      defaultUserId = newUser.rows[0].id;
      console.log(`[DB] 预置测试用户创建成功，ID: ${defaultUserId}`);
      
      // 预置微信与支付宝默认收款账号（采用 AES 加密，在业务层解密显示）
      const { encrypt } = require('../utils/crypto');
      await query(`
        INSERT INTO user_withdraw_config (user_id, method, account, real_name, is_default)
        VALUES 
          ($1, 'wechat', $2, '张伟', true),
          ($1, 'alipay', $3, '张伟', false)
      `, [defaultUserId, encrypt('wx_user_13800138000'), encrypt('13800138000')]);
    } else {
      defaultUserId = userRes.rows[0].id;
    }

    // 预置多渠道银行/商户收款码 (建行、安徽农金、工行等)
    const qrRes = await query('SELECT COUNT(*) FROM merchant_qrcodes');
    if (parseInt(qrRes.rows[0].count, 10) === 0) {
      console.log('[DB] 初始化预置建行、安徽农金等多渠道收款码...');
      const sampleCodes = [
        {
          tenant_id: 'ccb',
          merchant_name: '中国建设银行特约商户 (聚合收款)',
          product_name: '扫码消费加款·建行专线通道',
          amount: 1000.00,
          fee_rate: 0.8, // 0.8% 手续费 (1000元需8元)
          max_limit: 10000.00, // 单笔最多 10000 元
          min_limit: 10.00,
          channel_desc: '建行聚合码·支持信用卡/花呗·单笔限额10~10000元',
          qr_content: 'https://qr.ccb.com/mch/ccb_pay_online_889021',
        },
        {
          tenant_id: 'ahrcu',
          merchant_name: '安徽农金特约商户 (金农信e付)',
          product_name: '日常消费·农金惠民收款码',
          amount: 500.00,
          fee_rate: 0.5, // 0.5% 手续费 (500元需2.5元)
          max_limit: 500.00, // 单笔最多 500 元
          min_limit: 1.00,
          channel_desc: '安徽农金·低手续费0.5%·单笔限额1~500元',
          qr_content: 'https://pay.ahrcu.com/mch/ahrcu_pay_667812',
        },
        {
          tenant_id: 'icbc',
          merchant_name: '中国工商银行商户e支付',
          product_name: '工行e商户特约收银通道',
          amount: 2000.00,
          fee_rate: 0.6, // 0.6% 手续费
          max_limit: 5000.00, // 单笔最多 5000 元
          min_limit: 10.00,
          channel_desc: '工行e支付·全卡种快速通道·单笔限额10~5000元',
          qr_content: 'https://mybank.icbc.com.cn/epay/icbc_code_33451',
        },
        {
          tenant_id: 'default',
          merchant_name: '官方收银总台 (全卡种通用)',
          product_name: '日常扫码快速加款通道',
          amount: 100.00,
          fee_rate: 0.8,
          max_limit: 20000.00,
          min_limit: 1.00,
          channel_desc: '全渠道通用码·微信/支付宝/银联云闪付·免审核秒到',
          qr_content: 'https://pay.example.com/qr/default_cashout_code_001',
        }
      ];

      for (const item of sampleCodes) {
        const qrDataUrl = await QRCode.toDataURL(item.qr_content, {
          width: 360,
          margin: 2,
          color: {
            dark: '#0F172A',
            light: '#FFFFFF'
          }
        });

        await query(
          `INSERT INTO merchant_qrcodes 
            (tenant_id, merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
           ON CONFLICT (qr_content) DO UPDATE
           SET tenant_id = EXCLUDED.tenant_id,
               merchant_name = EXCLUDED.merchant_name,
               product_name = EXCLUDED.product_name,
               amount = EXCLUDED.amount,
               fee_rate = EXCLUDED.fee_rate,
               max_limit = EXCLUDED.max_limit,
               min_limit = EXCLUDED.min_limit,
               channel_desc = EXCLUDED.channel_desc,
               qr_image_url = EXCLUDED.qr_image_url`,
          [item.tenant_id, item.merchant_name, item.product_name, item.amount, item.fee_rate, item.max_limit, item.min_limit, item.channel_desc, item.qr_content, qrDataUrl]
        );
      }
      console.log('[DB] 建行、安徽农金、工行等各租户专属收款码已成功就绪');
    }
  } catch (err) {
    console.warn('[DB] 预置数据检查警告 (非致命):', err.message);
  }
}

module.exports = {
  pool,
  query,
  getClient,
  initDatabase,
};
