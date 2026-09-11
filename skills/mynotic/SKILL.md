---
name: mynotice
description: >
  纯前端零依赖的实时声音与中文语音播报 + QQ邮箱实时详单同步协同通知技能（mynotice）。实现前台用户提交（点餐、下单、扫码付款、咨询、工单），后台/管理端实时收到清脆和弦提示音、中文语音合成播报（如“您有新的订餐订单，3号桌...”），同时指定邮箱（如 527194933@qq.com）同步接收到对应的完整客户业务详单（含菜品明细、定制口味、实付金额、就餐桌号与时间戳），实现“声、画、信”三位一体的全天候零漏单防护体系。
---

# mynotice 实时声音语音播报与邮件实时详单协同通知技能规范

在许多业务系统（如餐饮点餐、电商商城、商户管理后台、客服工作台、协同看板）中，**“前台客户下单/付款，后台管理端即时播放清脆提示音与中文语音朗读，同时老板/店员邮箱秒级收到客户详单”** 能够构筑多通道无死角的业务触达，是极其核心的商用体验点。

本技能沉淀自实战检验的协同通知方案：
1. **听觉通道（扬声器/耳麦）**：完全不需要外部 MP3/WAV 静态音频文件，利用 Web Audio API 纯算法合成和弦提示音 + SpeechSynthesis 原生中文语音合成；
2. **移动/触觉通道**：调用浏览器 Navigator.vibrate 产生震动；
3. **视觉与信道通道（邮件详单）**：在后台发出声音播报的同时，基于 QQ 邮箱 SMTP（SSL 465 端口）向指定邮箱自动推送图文并茂的完整客户订单详单。

---

## 核心技术选型与优势对比

| 方案对比 | 传统单一外链 MP3 提示音 | 🌟 mynotice 声信协同通知体系 (声音 + 中文语音 + QQ 邮箱详单) |
| :--- | :--- | :--- |
| **外部文件依赖** | 需维护 audio 文件，易 404，耗费 CDN 流量 | **零外部音频文件**，代码纯算法合成，体积 0KB |
| **网络加载延迟** | 首次播放需等待音频流下载，存在 0.5s~3s 延迟 | **毫秒级即时发声**，直接调用系统声卡驱动 |
| **动态语音内容** | 只能播死板固定录音，无法念出桌号、人名、金额 | **动态文本朗读**，智能合成“3号桌新单”、“微信到账15元” |
| **移动端/微信兼容** | 经常被浏览器 Autoplay 策略完全静音拦截 | 内置 **iOS WebKit 专有静默 Buffer 解锁机制** |
| **离开屏幕/息屏漏单** | 浏览器切后台或关电脑后完全无法察觉 | **邮件秒级推送到手机**，息屏也能收到微信/QQ邮箱弹窗通知 |
| **业务细节呈现** | 仅有“叮咚”声，必须点开电脑后台才能看菜品 | **邮件附带完整商品清单、定制口味、实付金额与收货地址** |

---

## 目录索引

- [1. 核心声音引擎代码 (`lib/sound.ts`)](#1-核心声音引擎代码)
- [2. 浏览器自动播放限制 (Autoplay Policy) 突破机制](#2-浏览器自动播放限制突破机制)
- [3. 后台/管理端新单差量轮询与播报触发模式](#3-后台管理端新单差量检测模式)
- [4. WebSocket / SSE 实时推送集成模式](#4-websocket--sse-实时推送集成)
- [5. 管理后台 UI 控制组件 (声音开关与即时测试)](#5-管理后台-ui-控制组件)
- [6. 多业务场景文案与音调模板库](#6-多业务场景模板库)
- [7. 常见坑点与故障排查 (Troubleshooting)](#7-常见坑点与排查)
- [8. 邮件实时详单通知扩展 (QQ 邮箱 SMTP 扫码支付自动发信)](#8-邮件实时详单通知扩展)

---

## 1. 核心声音引擎代码

在项目中创建 `lib/sound.ts`（或 `utils/sound.ts`），直接复制以下完整代码：

```typescript
// lib/sound.ts

let audioContext: AudioContext | null = null;
let isAudioUnlocked = false;

/**
 * 获取全局单例 AudioContext，安全兼容移动端与 WebKit 前缀
 */
export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioContext) {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      audioContext = new AudioCtx();
    }
  }
  return audioContext;
}

/**
 * 检查当前音频上下文是否处于可用活跃状态
 */
export function isAudioReady(): boolean {
  if (!audioContext) return false;
  return audioContext.state === 'running' && isAudioUnlocked;
}

/**
 * 解锁浏览器音频播放权限 (必须在任何用户交互事件中调用：如点击、登录、触控)
 * 核心：向音轨输出 1 采样点极短静音，满足 iOS Safari 与 Chrome 严苛的 Autoplay 策略
 */
export function unlockAudio(): void {
  if (typeof window === 'undefined') return;
  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx
      .resume()
      .then(() => {
        isAudioUnlocked = true;
      })
      .catch(() => {});
  } else {
    isAudioUnlocked = true;
  }

  // 播放单样本空缓冲满足 WebKit 权限激活
  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // 忽略异常
  }
}

/**
 * 纯算法动态合成清脆的商户到单/通知和弦提示音 (类似美团/微信到单音效)
 * 音阶组合: C5 (523Hz) -> E5 (659Hz) -> G5 (784Hz) -> C6 (1046Hz) -> E6 (1318Hz)
 */
export function playOrderChime(): void {
  if (typeof window === 'undefined') return;
  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  try {
    const now = ctx.currentTime;

    const notes = [
      { freq: 523.25, time: 0, dur: 0.18, gain: 0.5 },
      { freq: 659.25, time: 0.12, dur: 0.18, gain: 0.55 },
      { freq: 783.99, time: 0.24, dur: 0.18, gain: 0.6 },
      { freq: 1046.5, time: 0.36, dur: 0.45, gain: 0.7 },
      { freq: 1318.51, time: 0.55, dur: 0.4, gain: 0.55 },
    ];

    notes.forEach((n) => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = 'triangle'; // 三角波，音色温润清脆
      osc.frequency.setValueAtTime(n.freq, now + n.time);

      gainNode.gain.setValueAtTime(0.001, now + n.time);
      gainNode.gain.linearRampToValueAtTime(n.gain, now + n.time + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + n.time + n.dur);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start(now + n.time);
      osc.stop(now + n.time + n.dur);
    });
  } catch (err) {
    console.warn('[mynotice] 提示音合成异常:', err);
  }
}

/**
 * 原生中文语音合成 (TTS 朗读)
 * @param text 需要朗读的中文文本
 */
export function speakChineseText(text: string = '您有新的订单，请及时处理！'): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    // 关键：先取消任何正在排队或卡住的陈旧发音，防止长队列堆积与延迟发声
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.05; // 稍快的商用语速，利落干脆
    utterance.pitch = 1.1; // 略微提亮音调，穿透力更佳
    utterance.volume = 1.0;

    // 优先选择最佳中文女声/标准声（若设备支持）
    const voices = window.speechSynthesis.getVoices();
    const zhVoice = voices.find((v) => v.lang === 'zh-CN' || v.lang.includes('zh') || v.lang.includes('cmn'));
    if (zhVoice) {
      utterance.voice = zhVoice;
    }

    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.warn('[mynotice] 中文语音朗读异常:', err);
  }
}

/**
 * 移动端/微信震动提醒 (支持的 Android 与移动浏览器)
 */
export function triggerVibration(): void {
  if (typeof window !== 'undefined' && 'navigator' in window && 'vibrate' in navigator) {
    try {
      navigator.vibrate([200, 100, 200, 100, 300]);
    } catch {
      // 忽略平台不支持
    }
  }
}

/**
 * 完整到单提醒组合拳：
 * 步骤 1: 立即解锁与播放悦耳双和弦
 * 步骤 2: 触发硬件震动
 * 步骤 3: 延时 400ms 自然衔接中文语音播报
 *
 * @param count 新单数量
 * @param detail 动态细节 (例如: "3号桌", "外卖客户张先生")
 * @param customPrefix 自定义前缀 (默认: "您有新的订餐订单")
 */
export function alertNotification(count: number = 1, detail?: string, customPrefix: string = '您有新的订单'): void {
  unlockAudio();
  playOrderChime();
  triggerVibration();

  let msg = '';
  if (detail) {
    msg = `${customPrefix}，${detail}，请及时处理`;
  } else if (count > 1) {
    msg = `您有${count}笔新的订单，请及时处理`;
  } else {
    msg = `${customPrefix}，请及时处理`;
  }

  // 延迟 400 毫秒，等和弦提示音收尾后再开启动态语音，听感极其自然高级
  setTimeout(() => {
    speakChineseText(msg);
  }, 400);
}
```

---

## 2. 浏览器自动播放限制突破机制

### 为什么后台挂机时经常“不响”？
现代浏览器出于防骚扰考虑，规定：**页面在没有发生任何用户点击或手势前，禁止直接播放声音（`The AudioContext was not allowed to start`）**。

### 优雅的解决方案组合拳：
1. **登录即解锁**：管理员在输入账号密码点击“登录”提交时，在 `onSubmit` 中立即调用 `unlockAudio()`。
2. **Tab 切换/全局点击捕获**：在后台顶层添加透明或显式监听：
   ```tsx
   useEffect(() => {
     const handleInteraction = () => {
       unlockAudio();
     };
     window.addEventListener('click', handleInteraction, { once: true });
     window.addEventListener('touchstart', handleInteraction, { once: true });
     return () => {
       window.removeEventListener('click', handleInteraction);
       window.removeEventListener('touchstart', handleInteraction);
     };
   }, []);
   ```
3. **顶栏常驻“声音状态”按钮**：提供醒目的【🔊 声音提醒：已开启】切换按钮，用户初次进入点击该按钮试听时，即可完成永久静默授权。

---

## 3. 后台管理端新单差量检测模式

### 3.1 为什么必须用“差量检测”？
后台定时向后端接口轮询获取订单列表时，如果直接用 `length` 变化或无脑播报，会导致**初次加载页面时把全部历史订单念一遍**，或者**每轮刷新都误报**。

### 3.2 标准差量比较实现 (React Hook)
```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { alertNotification, unlockAudio } from '@/lib/sound';

export function useOrderNotifier(tenantId: string) {
  const [orders, setOrders] = useState<any[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  
  // 核心：使用 useRef 保存已知的所有订单 ID 集合
  const knownOrderIdsRef = useRef<Set<string>>(new Set());
  const isFirstLoadRef = useRef<boolean>(true);

  const pollOrders = useCallback(async () => {
    try {
      // 若页面处于后台且不需要轮询，可选择性跳过
      const res = await fetch(`/api/orders?tenant=${encodeURIComponent(tenantId)}`, {
        cache: 'no-store',
      });
      const json = await res.json();
      if (!json.success || !Array.isArray(json.data)) return;

      const currentOrders = json.data;

      // 初次加载只建立基准已知集合，绝对不触发报警声音
      if (isFirstLoadRef.current) {
        knownOrderIdsRef.current = new Set(currentOrders.map((o: any) => o.id));
        isFirstLoadRef.current = false;
        setOrders(currentOrders);
        return;
      }

      // 差量过滤：挑出之前从未见过的全新订单
      const brandNewOrders = currentOrders.filter((o: any) => !knownOrderIdsRef.current.has(o.id));

      if (brandNewOrders.length > 0) {
        const newest = brandNewOrders[0];
        
        // 组装智能提示细节
        const detail = newest.table_no
          ? `${newest.table_no}有新单`
          : newest.contact_name
            ? `客户${newest.contact_name}有新单`
            : undefined;

        if (soundEnabled) {
          alertNotification(brandNewOrders.length, detail, '您有新的业务订单');
        }
      }

      // 更新已知集合与当前列表
      knownOrderIdsRef.current = new Set(currentOrders.map((o: any) => o.id));
      setOrders(currentOrders);
    } catch (err) {
      console.warn('轮询拉取失败', err);
    }
  }, [tenantId, soundEnabled]);

  // 每隔 5 秒自动拉取一次
  useEffect(() => {
    pollOrders();
    const timer = setInterval(pollOrders, 5000);
    return () => clearInterval(timer);
  }, [pollOrders]);

  return { orders, soundEnabled, setSoundEnabled };
}
```

---

## 4. WebSocket / SSE 实时推送集成

如果系统采用了全双工 WebSocket 或服务端单向 SSE（Server-Sent Events），播报逻辑更加清晰直接：

```typescript
// 在客户端建立连接的事件回调中
socket.on('new_order', (orderData) => {
  if (isSoundEnabled) {
    const detail = orderData.tableNo ? `${orderData.tableNo}` : `金额${orderData.totalPrice}元`;
    alertNotification(1, detail, '收到新订单');
  }
  // 刷新前端卡片看板...
});
```

---

## 5. 管理后台 UI 控制组件

在后台导航栏或控制面板提供友好的用户控制与授权按钮，既满足可用性，又巧妙完成授权：

```tsx
// components/admin/SoundNoticeToggle.tsx
'use client';

import React, { useState } from 'react';
import { Volume2, VolumeX, Play } from 'lucide-react';
import { unlockAudio, alertNotification } from '@/lib/sound';

export function SoundNoticeToggle() {
  const [enabled, setEnabled] = useState(true);

  const handleToggle = () => {
    unlockAudio();
    const next = !enabled;
    setEnabled(next);
    if (next) {
      alertNotification(1, '声音提醒已开启');
    }
  };

  const handleTestNotice = () => {
    unlockAudio();
    alertNotification(1, '测试语音播报正常');
  };

  return (
    <div className="flex items-center space-x-2">
      <button
        onClick={handleToggle}
        className={`px-3 py-1.5 text-xs font-medium rounded-xl flex items-center space-x-1.5 transition-all shadow-sm ${
          enabled
            ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-amber-200'
            : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-500'
        }`}
        title={enabled ? '点击静音后台' : '点击开启声音提醒'}
      >
        {enabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
        <span>{enabled ? '声音播报开启' : '已静音'}</span>
      </button>

      {enabled && (
        <button
          onClick={handleTestNotice}
          className="px-2.5 py-1.5 text-xs text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded-xl flex items-center space-x-1 transition-colors"
          title="试听一次提示音和语音效果"
        >
          <Play className="w-3 h-3" />
          <span>测试</span>
        </button>
      )}
    </div>
  );
}
```

---

## 6. 多业务场景模板库

可直接根据不同业务调用 `alertNotification` 或 `speakChineseText`：

| 业务场景 | 触发时机 | 推荐朗读文案模板 |
| :--- | :--- | :--- |
| **餐厅扫码点餐** | 顾客在前台手机选菜付款成功 | `alertNotification(1, "5号桌加菜2份", "您有新的点餐订单")` |
| **电商/外卖配送** | 顾客提交外卖订单 | `alertNotification(1, "外卖客户王女士有新单", "您有新的外卖订单")` |
| **收银台收款** | 扫码收款到账 | `alertNotification(1, "微信支付到账 38 元", "收款成功")` |
| **排队叫号系统** | 叫下一个号码 | `speakChineseText("请 A08 号顾客到 1 号窗口取餐")` |
| **在线客服/工单** | 用户发送咨询或反馈 | `alertNotification(1, "来自微信公众号的咨询", "您有一条新的待处理消息")` |

---

## 7. 常见坑点与排查

1. **为什么手机处于“静音/震动档”时不响？**  
   - iOS iPhone 侧面的物理静音拨片拨到静音时，Safari 会阻断扬声器输出。建议提醒商户“在接单工作台平板/手机上关闭物理静音”。
2. **为什么在后台切换到其他 Tab 标签页后播报变慢或停止？**  
   - 浏览器对非活动后台标签页（Background Tab）的 `setInterval` 会节流降频至 1 分钟甚至冻结。  
   - **优化方案**：配合 Web Worker、或改用长连接 WebSocket / SSE，或在店员工作台将后台窗口设为独立前台窗口显示。
3. **语音语速过快或过慢如何调？**  
   - 在 `utterance.rate` 中调节数值（`0.8` 沉稳从容，`1.0` 正常，`1.15` 紧凑利落）。

---

## 8. “声信协同”邮件实时详单同步通知体系

在商用实战场景中，仅靠浏览器端的声音播报存在局限：如果店员离开了电脑屏幕、电脑合盖锁屏、或处于嘈杂厨房，可能会错过声音。  
因此，**mynotice 技能升级支持“声信协同”多通道机制**：
> **当后台触发声音与中文语音播报的同时，服务端自动异步向指定邮箱（如 `527194933@qq.com`）投递一份格式工整、图文并茂的客户订单业务详单。**

这样店长手机上绑定的 QQ 邮箱 / 微信邮件提醒会立刻弹窗，即使店员离店或手机息屏，也能做到**双保险、全天候零漏单**。

---

### 8.1 QQ 邮箱 SMTP 安全授权与环境变量标准

根据 QQ 邮箱官方 POP3/IMAP/SMTP 安全规范，外部第三方客户端发信必须使用独立生成的 **16位授权码**（非 QQ 登录密码）：

| 环境变量参数 | 示例推荐值 | QQ 邮箱官方协议对应说明 |
| :--- | :--- | :--- |
| **`SMTP_HOST`** | `smtp.qq.com` | 发送邮件服务器主机地址 |
| **`SMTP_PORT`** | `465` | SSL 加密端口（官方推荐 465 或 587） |
| **`SMTP_SECURE`** | `true` | 是否启用 SSL 安全传输层加密 |
| **`SMTP_USER`** | `527194933@qq.com` | 完整发信账号（用户名/邮箱地址） |
| **`SMTP_PASS`** | `rvlehugdnsmccajh` | 邮箱安全中心生成的专属 16 位客户端授权码 |
| **`NOTIFY_EMAIL_TO`** | `527194933@qq.com` | 接收订单业务详单的目标商户邮箱 |

在项目 `.env.local` 或生产平台环境变量中写入：
```env
# QQ 邮箱 SMTP 安全发信服务
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=527194933@qq.com
SMTP_PASS=rvlehugdnsmccajh
NOTIFY_EMAIL_TO=527194933@qq.com
```

---

### 8.2 核心发信模块与详单模板 (`lib/email.ts`)

采用 `nodemailer` 单例连接池，并针对国内移动端邮件客户端（QQ 邮箱 APP、微信邮件提醒、Foxmail、iPhone 邮件）进行纯内联 CSS 渲染，确保在所有终端均排版整洁。

```typescript
// lib/email.ts
import nodemailer, { type Transporter } from 'nodemailer';
import { Order } from '@/types';

let transporterInstance: Transporter | null = null;

export function getTransporter(): Transporter {
  if (!transporterInstance) {
    transporterInstance = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.qq.com',
      port: Number(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE !== 'false',
      auth: {
        user: process.env.SMTP_USER || '527194933@qq.com',
        pass: process.env.SMTP_PASS || 'rvlehugdnsmccajh',
      },
    });
  }
  return transporterInstance;
}

/**
 * 格式化东八区（北京时间）
 */
function formatBeijingTime(dateInput: string | Date = new Date()): string {
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
 * 后台触发声音播报时，同步发送客户订单详单邮件
 */
export async function sendOrderPaymentEmail(
  order: Order,
  options?: {
    restaurantName?: string;
    noteTrigger?: string;
  }
) {
  const userEmail = process.env.SMTP_USER || '527194933@qq.com';
  const targetEmail = process.env.NOTIFY_EMAIL_TO || '527194933@qq.com';
  const shopName = options?.restaurantName || '饭店点餐系统';
  const triggerDesc = options?.noteTrigger || '后台语音播报协同触发';

  const isDineIn = order.order_type === '堂食';
  const locationTitle = isDineIn ? `堂食 · ${order.table_no || '未定桌号'}` : `外卖 · ${order.delivery_contact || '顾客'}`;
  const isPaid = order.payment_status === '已支付';
  const finalPrice = Number(order.final_amount ?? order.total_amount).toFixed(2);

  // 1. 动态自适应邮件主题
  const subjectPrefix = isPaid ? '【新订单已支付】' : '【新点餐提醒】';
  const subject = `${subjectPrefix}${locationTitle} - 订单号: ${order.id} (${isPaid ? '实付' : '待收'}: ¥${finalPrice})`;

  // 2. 状态胶囊与卡片
  const statusBadge = isPaid
    ? `<span style="display:inline-block;background:#10b981;color:#fff;font-size:11px;font-weight:bold;padding:3px 8px;border-radius:6px;">✔ 新订单已支付</span>`
    : `<span style="display:inline-block;background:#f59e0b;color:#fff;font-size:11px;font-weight:bold;padding:3px 8px;border-radius:6px;">⏳ 新订单待结账</span>`;

  // 3. 菜品表格行与口味标签
  const itemsHtml = (order.items || []).map((item, idx) => `
    <tr style="border-bottom: 1px solid #f1f5f9;">
      <td style="padding: 10px 8px; font-size: 13px; text-align: center; color: #64748b;">${idx + 1}</td>
      <td style="padding: 10px 8px; font-size: 13px; font-weight: 600; color: #0f172a;">
        ${item.dish_name}
        ${item.taste ? `<div style="margin-top:2px;padding:1px 6px;background:#fef3c7;color:#92400e;border-radius:4px;font-size:11px;display:inline-block;">定制: ${item.taste}</div>` : ''}
      </td>
      <td style="padding: 10px 8px; font-size: 13px; text-align: right; color: #64748b;">¥${Number(item.price).toFixed(2)}</td>
      <td style="padding: 10px 8px; font-size: 13px; text-align: center; font-weight: bold;">×${item.quantity}</td>
      <td style="padding: 10px 8px; font-size: 13px; text-align: right; font-weight: bold; color: #e11d48;">¥${Number(item.subtotal || item.price * item.quantity).toFixed(2)}</td>
    </tr>
  `).join('');

  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head><meta charset="utf-8"><title>${subject}</title></head>
  <body style="margin: 0; padding: 20px; background-color: #f1f5f9; font-family: -apple-system, sans-serif;">
    <div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06);">
      <div style="background: #0f172a; padding: 20px 24px; color: #fff;">
        ${statusBadge}
        <h2 style="margin: 8px 0 4px 0; font-size: 18px;">${shopName} · ${isPaid ? '客户支付详单' : '新点餐备餐详单'}</h2>
        <div style="font-size: 12px; color: #94a3b8;">${triggerDesc} · 时间：${formatBeijingTime()}</div>
      </div>
      <div style="padding: 24px;">
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 16px; font-size: 13px;">
          <div><strong>就餐方式：</strong> ${isDineIn ? `堂食 (${order.table_no})` : `外卖配送 (${order.delivery_contact} / ${order.delivery_phone})`}</div>
          ${order.delivery_address ? `<div style="margin-top:4px;"><strong>送餐地址：</strong> <span style="color:#b91c1c;font-weight:bold;">${order.delivery_address}</span></div>` : ''}
          ${order.notes ? `<div style="margin-top:6px;color:#b45309;"><strong>顾客备注：</strong> ${order.notes}</div>` : ''}
        </div>
        <table width="100%" style="border-collapse: collapse; margin-bottom: 16px;">
          <thead>
            <tr style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
              <th style="padding: 8px; text-align: center;">#</th>
              <th style="padding: 8px; text-align: left;">菜品名称</th>
              <th style="padding: 8px; text-align: right;">单价</th>
              <th style="padding: 8px; text-align: center;">数量</th>
              <th style="padding: 8px; text-align: right;">小计</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align: right; border-top: 1px solid #e2e8f0; padding-top: 12px; font-size: 14px;">
          实收金额：<span style="font-size: 20px; font-weight: 800; color: #e11d48;">¥${finalPrice}</span>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;

  return getTransporter().sendMail({
    from: `"${shopName}通知" <${userEmail}>`,
    to: targetEmail,
    subject,
    html,
  });
}
```

---

### 8.3 “声信协同”双通道触发架构

为了保证顾客端操作毫秒级响应，邮件投递必须采用**异步非阻塞 (Fire-and-forget)** 模式：

```
顾客提交订单 / 点击扫码支付
         │
         ▼
[ Next.js API: POST /api/orders ]
         ├─ 1. 写入 Neon 数据库，返回 200 OK (顾客端即刻完成渲染，耗时 <50ms)
         │
         ├─ 2. 后台工作台轮询到新订单 (差量检测 brandNew.length > 0)
         │      └─ 喇叭响起清脆和弦铃声 + 中文语音播报: "您有新的点餐订单，3号桌..."
         │
         └─ 3. 服务端后台异步协程并发触发:
                └─ 调用 sendOrderPaymentEmail() 异步投递至 527194933@qq.com
                    └─ 老板手机收到 QQ 邮箱 / 微信服务号即时弹窗，附带完整详单
```

#### 后端接口联动代码示范 (`app/api/orders/route.ts`)
```typescript
// 在订单入库后，直接启动异步任务，不 await 阻塞响应
(async () => {
  try {
    const fullOrder = await getOrderById(order.id, tenantId);
    const settings = await getSettings(tenantId);
    if (fullOrder) {
      await sendOrderPaymentEmail(fullOrder, {
        restaurantName: settings?.restaurant_name,
        noteTrigger: order.payment_status === '已支付'
          ? '客户下单已扫码支付 · 后台语音同步播报'
          : '客户提交新订单 · 后台语音同步播报',
      });
    }
  } catch (err) {
    console.error('[Email Notice Error]', err);
  }
})();
```

#### 当顾客稍后完成扫码支付时的状态同步 (`app/api/orders/[id]/route.ts`)
```typescript
if (paymentStatus === '已支付') {
  (async () => {
    try {
      const updated = await getOrderById(id, tenantId);
      const settings = await getSettings(tenantId);
      if (updated) {
        await sendOrderPaymentEmail(updated, {
          restaurantName: settings?.restaurant_name,
          noteTrigger: '客户在订单详情页面完成扫码支付',
        });
      }
    } catch (err) {
      console.error('[Payment Email Notice Error]', err);
    }
  })();
}
```

---

### 8.4 管理端邮件连通性自检 API 与测试组件

为了让管理员能随时排查邮箱是否畅通，提供独立自检接口与前端一键测试能力：

1. **测试接口 (`app/api/email/test/route.ts`)**：
   ```typescript
   export async function POST(req: NextRequest) {
     const body = await req.json().catch(() => ({}));
     const target = body.toEmail || process.env.NOTIFY_EMAIL_TO || '527194933@qq.com';
     const result = await testSendEmail(target);
     return NextResponse.json(result);
   }
   ```
2. **管理后台一键触发按钮**：
   在后台设置面板提供【发送一封测试详单邮件】按钮，管理员点击后即可在 2 秒内收到一封真实带菜品排版的模拟测试邮件，确认发信账号、授权码与目标收信无误。
