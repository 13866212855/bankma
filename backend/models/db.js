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

  // 1. 用户表
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
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

  // 3. 商家收款码表
  await query(`
    CREATE TABLE IF NOT EXISTS merchant_qrcodes (
      id SERIAL PRIMARY KEY,
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
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS fee_rate DECIMAL(6,3) DEFAULT 0.800;
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS max_limit DECIMAL(10,2) DEFAULT 10000.00;
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS min_limit DECIMAL(10,2) DEFAULT 1.00;
    ALTER TABLE merchant_qrcodes ADD COLUMN IF NOT EXISTS channel_desc VARCHAR(200);
  `);

  // 4. 订单表
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
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
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_rate DECIMAL(6,3) DEFAULT 0.000;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_amount DECIMAL(10,2) DEFAULT 0.00;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS settle_amount DECIMAL(10,2) DEFAULT 0.00;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS withdraw_name VARCHAR(100);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS withdraw_bank VARCHAR(100);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS audit_remark TEXT;
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

  // 预置演示用户与默认收款信息（方便直接体验与评测）
  try {
    const userRes = await query('SELECT id FROM users LIMIT 1');
    let defaultUserId;
    if (userRes.rowCount === 0) {
      const newUser = await query(
        'INSERT INTO users (phone) VALUES ($1) RETURNING id',
        ['13800138000']
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
          merchant_name: '中国工商银行商户e支付',
          product_name: '工行e商户特约收银通道',
          amount: 2000.00,
          fee_rate: 0.6, // 0.6% 手续费
          max_limit: 5000.00, // 单笔最多 5000 元
          min_limit: 10.00,
          channel_desc: '工行e支付·全卡种快速通道·单笔限额10~5000元',
          qr_content: 'https://mybank.icbc.com.cn/epay/icbc_code_33451',
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
            (merchant_name, product_name, amount, fee_rate, max_limit, min_limit, channel_desc, qr_content, qr_image_url, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
          [item.merchant_name, item.product_name, item.amount, item.fee_rate, item.max_limit, item.min_limit, item.channel_desc, item.qr_content, qrDataUrl]
        );
      }
      console.log('[DB] 建行、安徽农金等收款码已成功生成');
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
