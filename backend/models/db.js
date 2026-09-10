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
      amount DECIMAL(10,2) NOT NULL,
      qr_content TEXT UNIQUE NOT NULL,  -- 二维码解码内容
      qr_image_url TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 4. 订单表
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_no VARCHAR(50) UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      qrcode_id INTEGER REFERENCES merchant_qrcodes(id) ON DELETE SET NULL,
      amount DECIMAL(10,2) NOT NULL,
      pay_status VARCHAR(20) DEFAULT 'paid',       -- paid
      process_status VARCHAR(20) DEFAULT 'pending', -- pending | processing | completed | failed
      withdraw_method VARCHAR(20),
      withdraw_account VARCHAR(255),
      paid_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
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

    // 预置商家收款码
    const qrRes = await query('SELECT COUNT(*) FROM merchant_qrcodes');
    if (parseInt(qrRes.rows[0].count, 10) === 0) {
      console.log('[DB] 初始化预置演示商家二维码...');
      const sampleCodes = [
        {
          merchant_name: '瑞幸咖啡 (朝阳大悦城店)',
          product_name: '提神生椰拿铁 (大杯/半糖)',
          amount: 9.90,
          qr_content: 'MCH_LUCKIN_COFFEE_001_9.90',
        },
        {
          merchant_name: '全家便利店 (中关村南路店)',
          product_name: '日式厚切猪排便当 + 乌龙茶',
          amount: 28.50,
          qr_content: 'MCH_FAMILYMART_BENTO_002_28.50',
        },
        {
          merchant_name: '喜茶 (三里屯太古里店)',
          product_name: '多肉葡萄 (首选绿妍)',
          amount: 19.00,
          qr_content: 'MCH_HEYTEA_GRAPE_003_19.00',
        },
        {
          merchant_name: '华为数码专卖店',
          product_name: '66W SuperCharge 闪充数据线',
          amount: 69.00,
          qr_content: 'MCH_HUAWEI_CABLE_004_69.00',
        }
      ];

      for (const item of sampleCodes) {
        // 生成二维码 Base64 图片存储在 qr_image_url
        const qrDataUrl = await QRCode.toDataURL(item.qr_content, {
          width: 320,
          margin: 2,
          color: {
            dark: '#1E1B4B',
            light: '#FFFFFF'
          }
        });

        await query(
          `INSERT INTO merchant_qrcodes (merchant_name, product_name, amount, qr_content, qr_image_url)
           VALUES ($1, $2, $3, $4, $5)`,
          [item.merchant_name, item.product_name, item.amount, item.qr_content, qrDataUrl]
        );
      }
      console.log('[DB] 预置演示商家二维码已生成');
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
