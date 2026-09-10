/**
 * backend/utils/notify.js
 * 通知推送与第三方出款对接工具模块
 * 
 * 预留微信/支付宝/银行卡出款标准接口
 * 当前以高可视化的控制台日志模拟实现
 */

const { maskAccount } = require('./crypto');

/**
 * 微信商家转账到零钱通知 / 实际出款接口
 * 
 * 真实生产对接扩展点说明:
 * 1. 微信支付 API v3 接口: POST https://api.mch.weixin.qq.com/v3/transfer/batches
 * 2. 需配置: 
 *    - wechat_mchid: 微信商户号
 *    - wechat_appid: 关联 AppID
 *    - apiclient_cert.pem & apiclient_key.pem: API 证书与私钥
 *    - v3_api_key: API v3 密钥（用于验签与平台证书解密）
 * 3. 请求体示例:
 *    {
 *      "appid": process.env.WECHAT_APPID,
 *      "out_batch_no": "BATCH_" + orderNo,
 *      "batch_name": "扫码提现加款",
 *      "batch_remark": "客户扫码订单加款",
 *      "total_amount": Math.round(amount * 100), // 单位为分
 *      "total_num": 1,
 *      "transfer_detail_list": [{
 *        "out_detail_no": "DETAIL_" + orderNo,
 *        "transfer_amount": Math.round(amount * 100),
 *        "transfer_remark": "扫码提现",
 *        "openid": userWechatOpenId, // 或使用微信号转账
 *        "user_name": realName // 实名验证 (可选)
 *      }]
 *    }
 */
async function sendWechatTransfer({ account, realName, amount, orderNo }) {
  const masked = maskAccount(account, 'wechat');
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });

  console.log('\n======================================================');
  console.log('🚀 [NOTIFY / 微信出款] 触发微信转账到零钱 / 加款通知');
  console.log(`⏰ 时间: ${timestamp}`);
  console.log(`📋 订单编号: ${orderNo}`);
  console.log(`👤 收款微信: ${masked} (姓名: ${realName || '未指定'})`);
  console.log(`💰 出款金额: ¥${parseFloat(amount).toFixed(2)} 元`);
  console.log('📡 模拟调用: POST https://api.mch.weixin.qq.com/v3/transfer/batches');
  console.log('✅ 状态回报: HTTP 200 SUCCESS - 资金已实时到账微信零钱');
  console.log('======================================================\n');

  return {
    success: true,
    channel: 'wechat',
    transferNo: 'WX_TX_' + Date.now(),
    orderNo,
    amount,
    message: `已成功出款至微信账号: ${masked}`
  };
}

/**
 * 支付宝单笔转账到支付宝账户接口
 * 
 * 真实生产对接扩展点说明:
 * 1. 支付宝开放平台 OpenAPI: alipay.fund.trans.uni.transfer (单笔转账接口)
 * 2. 需引入 SDK: @alipay/easysdk 或 alipay-sdk
 * 3. 需配置:
 *    - appId: 支付宝应用 AppID
 *    - privateKey: 应用私钥
 *    - alipayPublicKey: 支付宝公钥
 * 4. 调用示例:
 *    const result = await alipaySdk.exec('alipay.fund.trans.uni.transfer', {
 *      bizContent: {
 *        out_biz_no: orderNo,
 *        trans_amount: amount.toFixed(2),
 *        product_code: 'TRANS_ACCOUNT_NO_PWD',
 *        biz_scene: 'DIRECT_TRANSFER',
 *        order_title: '扫码提现加款',
 *        payee_info: {
 *          identity: account, // 支付宝账号 (手机号或邮箱)
 *          identity_type: 'ALIPAY_LOGON_ID',
 *          name: realName
 *        }
 *      }
 *    });
 */
async function sendAlipayTransfer({ account, realName, amount, orderNo }) {
  const masked = maskAccount(account, 'alipay');
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });

  console.log('\n======================================================');
  console.log('🚀 [NOTIFY / 支付宝出款] 触发支付宝转账到账户 / 加款通知');
  console.log(`⏰ 时间: ${timestamp}`);
  console.log(`📋 订单编号: ${orderNo}`);
  console.log(`👤 收款账号: ${masked} (真实姓名: ${realName || '未指定'})`);
  console.log(`💰 出款金额: ¥${parseFloat(amount).toFixed(2)} 元`);
  console.log('📡 模拟调用: alipay.fund.trans.uni.transfer (SDK EasySDK)');
  console.log('✅ 状态回报: SUCCESS (10000) - 资金已实时到账支付宝余额');
  console.log('======================================================\n');

  return {
    success: true,
    channel: 'alipay',
    transferNo: 'ALI_TX_' + Date.now(),
    orderNo,
    amount,
    message: `已成功出款至支付宝账号: ${masked}`
  };
}

/**
 * 银联 / 银行卡企业代付打款接口
 * 
 * 真实生产对接扩展点说明:
 * 1. 银联开放平台或商业银行企业网银直连 API (B2C 代付)
 * 2. 需配置: 银行机构接入商户号、前置机签名证书、加密证书
 * 3. 参数包括: 银行卡号、开户行行号/名称、开户人姓名、金额
 */
async function sendBankTransfer({ account, bankName, realName, amount, orderNo }) {
  const masked = maskAccount(account, 'bank');
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });

  console.log('\n======================================================');
  console.log('🚀 [NOTIFY / 银行卡出款] 触发银行银联清算代付 / 加款通知');
  console.log(`⏰ 时间: ${timestamp}`);
  console.log(`📋 订单编号: ${orderNo}`);
  console.log(`🏦 收款银行: ${bankName || '银行卡'}`);
  console.log(`👤 户名: ${realName || '用户'} | 卡号: ${masked}`);
  console.log(`💰 代付金额: ¥${parseFloat(amount).toFixed(2)} 元`);
  console.log('📡 模拟调用: B2C_DirectPayTransfer Gateway');
  console.log('✅ 状态回报: 200 PROCESSED - 资金清算完毕，已发往发卡行');
  console.log('======================================================\n');

  return {
    success: true,
    channel: 'bank',
    transferNo: 'UNION_TX_' + Date.now(),
    orderNo,
    amount,
    message: `已向 ${bankName || '银行卡'} (${masked}) 发起代付`
  };
}

/**
 * 综合出款分发总调度
 * @param {Object} order - 订单对象
 */
async function sendWithdrawNotification(order) {
  const method = order.withdraw_method || 'wechat';
  const account = order.withdraw_account;
  const amount = order.amount;
  const orderNo = order.order_no;
  const realName = order.real_name;
  const bankName = order.bank_name;

  switch (method) {
    case 'alipay':
      return await sendAlipayTransfer({ account, realName, amount, orderNo });
    case 'bank':
      return await sendBankTransfer({ account, bankName, realName, amount, orderNo });
    case 'wechat':
    default:
      return await sendWechatTransfer({ account, realName, amount, orderNo });
  }
}

module.exports = {
  sendWechatTransfer,
  sendAlipayTransfer,
  sendBankTransfer,
  sendWithdrawNotification
};
