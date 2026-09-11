/**
 * backend/utils/email.js
 * 基于 QQ 邮箱 SMTP 安全通知服务 (mynotice 技能)
 * 实现用户扫码支付/提现申请时的实时业务详单邮件推送与自检
 */

const nodemailer = require('nodemailer');

let transporter = null;

/**
 * 获取或创建 nodemailer Transporter 单例
 */
function getTransporter() {
  if (!transporter) {
    const host = process.env.SMTP_HOST || 'smtp.qq.com';
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    const secure = process.env.SMTP_SECURE !== 'false';
    const user = process.env.SMTP_USER || '527194933@qq.com';
    const pass = process.env.SMTP_PASS || 'rvlehugdnsmccajh';

    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
      // 优化连接池与超时设置
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

/**
 * 格式化东八区北京时间
 */
function formatBeijingTime(dateInput = new Date()) {
  const d = new Date(dateInput);
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * 向指定邮箱发送客户扫码支付与到账核实详单邮件
 * @param {Object} order 订单数据对象
 * @param {Object} options 附加自定义选项 (触发来源、商户名称等)
 */
async function sendOrderPaymentEmail(order, options = {}) {
  try {
    const fromUser = process.env.SMTP_USER || '527194933@qq.com';
    const targetEmail = process.env.NOTIFY_EMAIL_TO || '527194933@qq.com';
    const systemName = options.systemName || '商户收款与加款核实系统';
    const triggerDesc = options.triggerDesc || '前台用户扫码付款提交 · 后台声信协同触发';

    const orderNo = order.order_no || '未知单号';
    const amount = Number(order.amount || 0).toFixed(2);
    const feeRate = Number(order.fee_rate || 0.8).toFixed(2);
    const feeAmount = Number(order.fee_amount || 0).toFixed(2);
    const settleAmount = Number(order.settle_amount || order.amount || 0).toFixed(2);

    const methodMap = {
      wechat: '微信零钱',
      alipay: '支付宝',
      bank: '银行卡',
    };
    const methodText = methodMap[order.withdraw_method] || order.withdraw_method || '未知方式';
    const withdrawName = order.withdraw_name || '客户未实名';
    const withdrawAccount = order.withdraw_account_plain || order.withdraw_account || '无账号';
    const merchantName = order.merchant_name || '合作商户收款码';
    const bankName = order.withdraw_bank ? ` (${order.withdraw_bank})` : '';

    const subject = `【新到账核实请求】扫码金额: ¥${amount} - 订单号: ${orderNo} (应打款: ¥${settleAmount})`;

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 20px 10px; background-color: #F1F5F9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid #E2E8F0;">
    <!-- 头部黑金科技感 Banner -->
    <tr>
      <td style="background: #0F172A; padding: 24px; color: #FFFFFF;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <td>
              <span style="display: inline-block; background: #F59E0B; color: #FFFFFF; font-size: 11px; font-weight: bold; padding: 3px 10px; border-radius: 6px; letter-spacing: 0.5px;">
                ⏱️ 新到账核实请求 · 待人工核验
              </span>
              <h1 style="margin: 10px 0 4px 0; font-size: 20px; font-weight: 700; color: #FFFFFF;">${systemName}</h1>
              <div style="font-size: 12px; color: #94A3B8; line-height: 1.5;">${triggerDesc} · ${formatBeijingTime()}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- 正文内容区 -->
    <tr>
      <td style="padding: 24px;">
        <!-- 金额突出卡片 -->
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; margin-bottom: 20px;">
          <tr>
            <td style="padding: 16px;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="font-size: 13px; color: #64748B; padding-bottom: 6px;">扫码付款金额：</td>
                  <td style="font-size: 14px; font-weight: 600; text-align: right; color: #0F172A;">¥${amount} 元</td>
                </tr>
                <tr>
                  <td style="font-size: 13px; color: #64748B; padding-bottom: 6px;">通道手续费率：</td>
                  <td style="font-size: 13px; text-align: right; color: #DC2626;">${feeRate}% (-¥${feeAmount} 元)</td>
                </tr>
                <tr style="border-top: 1px dashed #CBD5E1;">
                  <td style="font-size: 14px; font-weight: 700; color: #0F172A; padding-top: 10px;">应向客户打款金额：</td>
                  <td style="font-size: 22px; font-weight: 800; text-align: right; color: #059669; padding-top: 10px;">¥${settleAmount} <span style="font-size: 13px;">元</span></td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- 详细信息清单 -->
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
          <tr style="border-bottom: 1px solid #F1F5F9;">
            <td style="padding: 10px 0; color: #64748B; width: 110px;">业务订单号</td>
            <td style="padding: 10px 0; font-family: monospace; font-weight: bold; color: #0F172A;">${orderNo}</td>
          </tr>
          <tr style="border-bottom: 1px solid #F1F5F9;">
            <td style="padding: 10px 0; color: #64748B;">扫码商户通道</td>
            <td style="padding: 10px 0; font-weight: 600; color: #334155;">${merchantName}</td>
          </tr>
          <tr style="border-bottom: 1px solid #F1F5F9;">
            <td style="padding: 10px 0; color: #64748B;">客户提现方式</td>
            <td style="padding: 10px 0; font-weight: bold; color: #4F46E5;">${methodText}${bankName}</td>
          </tr>
          <tr style="border-bottom: 1px solid #F1F5F9;">
            <td style="padding: 10px 0; color: #64748B;">收款人实名</td>
            <td style="padding: 10px 0; font-weight: 600; color: #0F172A;">${withdrawName}</td>
          </tr>
          <tr style="border-bottom: 1px solid #F1F5F9;">
            <td style="padding: 10px 0; color: #64748B;">打款收款账号</td>
            <td style="padding: 10px 0; font-family: monospace; font-size: 14px; font-weight: 700; color: #1E1B4B; background: #EEF2FF; padding-left: 8px; border-radius: 4px;">
              ${withdrawAccount}
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; color: #64748B;">提交时间</td>
            <td style="padding: 10px 0; color: #64748B;">${formatBeijingTime(order.paid_at || order.created_at)}</td>
          </tr>
        </table>

        <!-- 管理员操作提醒 -->
        <div style="background: #EFF6FF; border-left: 4px solid #3B82F6; padding: 12px 14px; border-radius: 6px; font-size: 12px; color: #1E40AF; line-height: 1.6;">
          <strong>💡 人工审核操作指引：</strong><br>
          1. 请登录微信支付商户平台或银行账户，核查该时间段内是否存在 ¥${amount} 元的入账流水；<br>
          2. 核验到账无误后，请向上述客户账号 (户名: ${withdrawName}) 打款 <strong>¥${settleAmount} 元</strong>；<br>
          3. 打开管理后台 (/admin) 点击该订单的【✅ 核实到账并打款】按钮完成办结。
        </div>
      </td>
    </tr>

    <!-- 页脚 -->
    <tr>
      <td style="background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 16px 24px; text-align: center; font-size: 12px; color: #94A3B8;">
        mynotice 声信协同通知体系 · QQ 邮箱 SMTP 安全服务自动派发<br>
        目标提醒邮箱: ${targetEmail}
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    const transport = getTransporter();
    const info = await transport.sendMail({
      from: `"${systemName}" <${fromUser}>`,
      to: targetEmail,
      subject,
      html,
    });

    console.log(`[Email] 扫码核实详单邮件已成功发送至 ${targetEmail}, MessageID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('[Email Error] 发送详单邮件失败:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 发送自检/测试邮件接口
 * @param {string} toEmail 接收测试的目标邮箱
 */
async function sendTestEmail(toEmail) {
  const targetEmail = toEmail || process.env.NOTIFY_EMAIL_TO || '527194933@qq.com';
  const fromUser = process.env.SMTP_USER || '527194933@qq.com';

  const dummyOrder = {
    order_no: `TEST_ORD_${Date.now().toString().slice(-6)}`,
    amount: 1000.00,
    fee_rate: 0.8,
    fee_amount: 8.00,
    settle_amount: 992.00,
    withdraw_method: 'wechat',
    withdraw_name: '测试客户 (张伟)',
    withdraw_account: 'wx_user_13800138000',
    withdraw_account_plain: 'wx_user_13800138000',
    merchant_name: '建设银行特约商户 (聚合收款码)',
    created_at: new Date()
  };

  return await sendOrderPaymentEmail(dummyOrder, {
    systemName: '商户收款后台 (mynotice 连通性测试)',
    triggerDesc: '管理员在后台点击【发送测试邮件】触发自检',
  });
}

module.exports = {
  getTransporter,
  sendOrderPaymentEmail,
  sendTestEmail,
  formatBeijingTime,
};
