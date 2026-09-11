/**
 * frontend/assets/sound.js
 * 纯前端零依赖实时声音与中文语音播报引擎 (mynotice 技能 · 后台保活与微信穿透版)
 * 
 * 核心特性:
 * 1. 【双轨语音播报引擎】：
 *    - 优先真实 HTML5 <audio> 播放服务端 MP3 TTS 媒体流（在 iOS/Android 切到微信、息屏或后台标签页时仍能清晰发声！）
 *    - 原生 SpeechSynthesis 作为离线/前端即时回退保障
 * 2. 【无声音频死循环保活 (Silent Audio Loop)】：
 *    - 在用户首次交互或激活保活后，持续运行循环静音音轨与 MediaSession
 *    - 告知移动操作系统“该网页正在播放后台媒体”，彻底杜绝 iOS Safari / Android Chrome 切换到微信后的 JS 冻结
 * 3. 【Web Worker 独立线程定时心跳】：
 *    - 绕过移动端后台对主线程 setInterval 的严重节流（从 60s 挂起恢复为毫秒级准时唤醒）
 * 4. 【高解析度订单信息语音格式化】：
 *    - 自动完整提取：客户姓名、扫码支付/商户方式、提现方式（微信/支付宝/银行卡）、账号（逐位清晰念读）、付款本金与实打金额
 * 5. 【Web Notification 系统通知横幅】：
 *    - 即使在微信打字聊天，手机顶部也会滑出系统提现待核实卡片，点击一键唤回管理后台
 * 6. 【移动端硬件震动反馈 (Navigator.vibrate)】
 */

(function(window) {
  let audioContext = null;
  let isAudioUnlocked = false;
  let isKeepaliveActive = false;
  let keepaliveAudioEl = null;
  let voiceAudioEl = null;
  let chimeAudioEl = null;
  let titleFlashInterval = null;
  let originalDocumentTitle = document.title || '后台管理 - 扫码支付与人工核实系统';

  /**
   * 初始化隐蔽 DOM 真实音频播放器 (用于穿透移动端后台媒体播放机制)
   */
  function initAudioElements() {
    if (typeof document === 'undefined') return;

    // 1. 无声保活循环播放器
    if (!keepaliveAudioEl) {
      keepaliveAudioEl = document.getElementById('mynotice-keepalive-player');
      if (!keepaliveAudioEl) {
        keepaliveAudioEl = document.createElement('audio');
        keepaliveAudioEl.id = 'mynotice-keepalive-player';
        keepaliveAudioEl.loop = true;
        keepaliveAudioEl.playsInline = true;
        keepaliveAudioEl.preload = 'auto';
        keepaliveAudioEl.setAttribute('playsinline', '');
        keepaliveAudioEl.setAttribute('webkit-playsinline', '');
        keepaliveAudioEl.src = '/api/admin/audio/silent.wav';
        keepaliveAudioEl.style.display = 'none';
        document.body.appendChild(keepaliveAudioEl);
      }
    }

    // 2. 真实 MP3 语音播放器 (切到微信后，此元素能最高优先级占用音频通道发声)
    if (!voiceAudioEl) {
      voiceAudioEl = document.getElementById('mynotice-voice-player');
      if (!voiceAudioEl) {
        voiceAudioEl = document.createElement('audio');
        voiceAudioEl.id = 'mynotice-voice-player';
        voiceAudioEl.playsInline = true;
        voiceAudioEl.preload = 'auto';
        voiceAudioEl.setAttribute('playsinline', '');
        voiceAudioEl.setAttribute('webkit-playsinline', '');
        voiceAudioEl.style.display = 'none';
        document.body.appendChild(voiceAudioEl);
      }
    }

    // 3. 到单和弦铃声播放器
    if (!chimeAudioEl) {
      chimeAudioEl = document.getElementById('mynotice-chime-player');
      if (!chimeAudioEl) {
        chimeAudioEl = document.createElement('audio');
        chimeAudioEl.id = 'mynotice-chime-player';
        chimeAudioEl.playsInline = true;
        chimeAudioEl.preload = 'auto';
        chimeAudioEl.src = '/api/admin/audio/chime.wav';
        chimeAudioEl.setAttribute('playsinline', '');
        chimeAudioEl.setAttribute('webkit-playsinline', '');
        chimeAudioEl.style.display = 'none';
        document.body.appendChild(chimeAudioEl);
      }
    }
  }

  /**
   * 获取全局单例 AudioContext
   */
  function getAudioContext() {
    if (typeof window === 'undefined') return null;
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioContext = new AudioCtx();
      }
    }
    return audioContext;
  }

  /**
   * 检查当前音频状态
   */
  function isAudioReady() {
    if (!audioContext) return isKeepaliveActive;
    return (audioContext.state === 'running' && isAudioUnlocked) || isKeepaliveActive;
  }

  /**
   * 解锁浏览器音频播放权限并激活后台保活 Session
   */
  function unlockAudio() {
    if (typeof window === 'undefined') return;
    initAudioElements();

    const ctx = getAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          isAudioUnlocked = true;
        }).catch(() => {});
      } else {
        isAudioUnlocked = true;
      }

      try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
      } catch (e) {}
    }

    // 尝试激活后台静音保活流
    enableBackgroundKeepalive();
  }

  /**
   * 启动后台无声音频循环保活与 MediaSession
   * 关键原理：正在播放 audio 的网页在 iOS/Android 中被视为活跃媒体应用，切到微信不会被冻结
   */
  function enableBackgroundKeepalive() {
    initAudioElements();
    if (!keepaliveAudioEl) return false;

    // 设置媒体元数据，在手机锁屏与通知栏展示驻留卡片
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '扫码提现后台自动监听中',
          artist: '实时声音与语音打款提醒',
          album: '商户收款管理中心'
        });
        navigator.mediaSession.playbackState = 'playing';

        navigator.mediaSession.setActionHandler('play', () => {
          if (keepaliveAudioEl) keepaliveAudioEl.play().catch(() => {});
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          if (keepaliveAudioEl) keepaliveAudioEl.play().catch(() => {});
        });
      } catch (e) {
        console.warn('[mynotice] MediaSession 注册忽略:', e);
      }
    }

    const playPromise = keepaliveAudioEl.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        isKeepaliveActive = true;
        console.log('[mynotice] ✅ 后台媒体保活已成功激活！即使切换到微信也不会中断监听与播报');
      }).catch((err) => {
        console.log('[mynotice] 保活流待用户手势激活:', err.message);
      });
    }
    return isKeepaliveActive;
  }

  /**
   * 播放清脆和弦到单音
   */
  function playOrderChime() {
    initAudioElements();

    // 优先通过真实 <audio> 播放 (切到微信后真实 audio 有最高发声权限)
    if (chimeAudioEl) {
      try {
        chimeAudioEl.currentTime = 0;
        const p = chimeAudioEl.play();
        if (p !== undefined) {
          p.catch(() => {});
        }
      } catch (e) {}
    }

    // 同时 Web Audio API 算法合成作为高保真叠加
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

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.freq, now + n.time);

        gainNode.gain.setValueAtTime(0.001, now + n.time);
        gainNode.gain.linearRampToValueAtTime(n.gain, now + n.time + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + n.time + n.dur);

        osc.connect(gainNode);
        gainNode.connect(ctx.destination);

        osc.start(now + n.time);
        osc.stop(now + n.time + n.dur);
      });
    } catch (err) {}
  }

  /**
   * 将账号转换为 TTS 清晰发音的文本格式
   * 将紧凑数字串添加间隔，如 "13800138000" -> "1 3 8 0 0 1 3 8 0 0 0"，防止被读成百亿大数字
   * 对银行卡等长串做四位一组清晰间隔
   */
  function formatAccountForSpeech(account, method = 'alipay') {
    if (!account) return '未提供';
    const clean = String(account).trim();

    // 若是纯手机号/支付宝账号 (11位数字)
    if (/^\d{11}$/.test(clean)) {
      return clean.split('').join(' ');
    }

    // 若是银行卡 (16~19位数字)
    if (/^\d{15,20}$/.test(clean)) {
      // 提取后四位，并逐位朗读前四与后四
      const tail = clean.slice(-4).split('').join(' ');
      const head = clean.slice(0, 4).split('').join(' ');
      return `卡号前四位 ${head}，尾号 ${tail}，全号 ${clean.split('').join(' ')}`;
    }

    // 其他含有数字的账号，将数字部分逐位加空格，符号如@转读为“艾特”或“点”
    let spoken = clean
      .replace(/@/g, ' 艾特 ')
      .replace(/\./g, ' 点 ')
      .replace(/([0-9])/g, ' $1 ');

    return spoken.replace(/\s+/g, ' ').trim();
  }

  /**
   * 格式化提现方式中文读音
   */
  function formatMethodForSpeech(method, bankName) {
    if (method === 'wechat') return '微信零钱';
    if (method === 'alipay') return '支付宝';
    if (method === 'bank') return bankName ? `${bankName}卡` : '银行卡';
    return method || '指定账户';
  }

  /**
   * 生成包含【客户姓名、扫码方式、提现方式、账号、金额】的极致精细化播报语
   */
  function formatOrderVoiceText(order, count = 1) {
    if (!order) {
      return count > 1 ? `您有 ${count} 笔新的核实订单，请及时处理` : '您有新的扫码核实订单，请及时核查打款';
    }

    const name = order.withdraw_name || '客户';
    const payVal = Number(order.amount || 0).toFixed(2);
    const settleVal = Number(order.settle_amount || order.amount || 0).toFixed(2);
    const merchant = order.merchant_name || '商户收款码';
    const method = formatMethodForSpeech(order.withdraw_method, order.withdraw_bank);
    const plainAcct = order.withdraw_account_plain || order.withdraw_account || '';
    const spokenAcct = formatAccountForSpeech(plainAcct, order.withdraw_method);

    if (count > 1) {
      return `您有 ${count} 笔新的核实订单！最新一笔客户：${name}，通过 ${merchant} 支付 ${payVal} 元，申请提现到 ${method}，账号：${spokenAcct}，应打款 ${settleVal} 元，请及时核查打款！`;
    }

    return `您有新的扫码核实订单！客户：${name}，使用 ${merchant} 扫码支付 ${payVal} 元，申请提现到 ${method}，账号：${spokenAcct}，应打款 ${settleVal} 元，请及时核查打款！`;
  }

  /**
   * 核心：通过真 HTML5 <audio> 播报服务端 MP3 TTS (后台切到微信依旧有声音)
   */
  function playServerTTSAudio(text) {
    initAudioElements();
    if (!voiceAudioEl) {
      speakChineseFallback(text);
      return;
    }

    const ttsUrl = `/api/admin/tts?text=${encodeURIComponent(text)}`;
    voiceAudioEl.src = ttsUrl;
    voiceAudioEl.currentTime = 0;

    const playPromise = voiceAudioEl.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        console.log('[mynotice] 真实音频流正在发声播报 (切到微信可听)');
      }).catch((err) => {
        console.warn('[mynotice] 真实音频流播报受阻，切换至本地语音合成:', err.message);
        speakChineseFallback(text);
      });
    }
  }

  /**
   * 本地 SpeechSynthesis 兜底朗读
   */
  function speakChineseFallback(text) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.05;
      utterance.pitch = 1.05;
      utterance.volume = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const zhVoice = voices.find(v => v.lang === 'zh-CN' || v.lang.includes('zh') || v.lang.includes('cmn'));
      if (zhVoice) {
        utterance.voice = zhVoice;
      }

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('[mynotice] 本地 TTS 兜底异常:', e);
    }
  }

  /**
   * 移动端震动
   */
  function triggerVibration() {
    if (typeof window !== 'undefined' && 'navigator' in window && 'vibrate' in navigator) {
      try {
        navigator.vibrate([300, 150, 300, 150, 400]);
      } catch (e) {}
    }
  }

  /**
   * 请求并弹出 Web Notification 桌面/手机通知栏横幅
   */
  function triggerSystemNotification(title, body) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      try {
        const notif = new Notification(title, {
          body,
          icon: '/favicon.ico',
          badge: '/favicon.ico',
          vibrate: [300, 150, 300],
          tag: 'mynotice-order-alert',
          renotify: true
        });
        notif.onclick = function() {
          window.focus();
          notif.close();
        };
      } catch (e) {}
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  }

  /**
   * 网页标题高频闪烁提醒
   */
  function flashTitle(newTitle) {
    if (titleFlashInterval) clearInterval(titleFlashInterval);
    let flag = true;
    titleFlashInterval = setInterval(() => {
      document.title = flag ? `【🔔 ${newTitle}】` : originalDocumentTitle;
      flag = !flag;
    }, 800);

    // 50 秒后自动恢复
    setTimeout(() => {
      if (titleFlashInterval) {
        clearInterval(titleFlashInterval);
        titleFlashInterval = null;
        document.title = originalDocumentTitle;
      }
    }, 50000);
  }

  /**
   * 完整到单提醒超级组合拳 (支持后台与切到微信运行)
   * @param {Object} order 最新单条订单完整对象 (包含 amount, withdraw_name, withdraw_method, withdraw_account_plain, merchant_name)
   * @param {number} count 新到订单数量
   */
  function alertOrderNotification(order, count = 1) {
    unlockAudio();
    playOrderChime();
    triggerVibration();

    const voiceText = formatOrderVoiceText(order, count);

    // 延时 400ms 等和弦铃声尾音自然过渡后，播报人声
    setTimeout(() => {
      playServerTTSAudio(voiceText);
    }, 450);

    // 系统桌面与手机锁屏通知横幅
    const payVal = order ? Number(order.amount).toFixed(2) : '0.00';
    const user = order ? (order.withdraw_name || '客户') : '客户';
    const notifTitle = `【新到账提现申请】¥${payVal} - ${user}`;
    const notifBody = order 
      ? `通道: ${order.merchant_name || '商户码'} | 方式: ${formatMethodForSpeech(order.withdraw_method, order.withdraw_bank)} (${order.withdraw_account_plain || ''})`
      : `您有 ${count} 笔新待核实提现订单`;

    triggerSystemNotification(notifTitle, notifBody);
    flashTitle(`新单到账 ¥${payVal}`);
  }

  /**
   * 创建 Web Worker 独立线程心跳定时器
   * 彻底规避主线程切换至微信后的 setInterval 节流
   */
  function createWorkerTimer(callback, intervalMs = 4500) {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
      return setInterval(callback, intervalMs);
    }

    try {
      const workerBlob = new Blob([`
        let timer = null;
        self.onmessage = function(e) {
          if (e.data === 'start') {
            if (timer) clearInterval(timer);
            timer = setInterval(function() {
              self.postMessage('tick');
            }, ${intervalMs});
          } else if (e.data === 'stop') {
            if (timer) clearInterval(timer);
            timer = null;
          }
        };
      `], { type: 'application/javascript' });

      const workerUrl = URL.createObjectURL(workerBlob);
      const worker = new Worker(workerUrl);

      worker.onmessage = function(e) {
        if (e.data === 'tick') {
          callback();
        }
      };

      worker.postMessage('start');

      // 监听页面切换可见度，切回前台时立即执行一次补偿检测
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          callback();
        }
      });

      return {
        stop: () => {
          worker.postMessage('stop');
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
        }
      };
    } catch (e) {
      console.warn('[mynotice] Web Worker 定时器退回常规 setInterval:', e);
      return setInterval(callback, intervalMs);
    }
  }

  // 挂载全局 API
  window.MyNoticeSound = {
    getAudioContext,
    isAudioReady,
    unlockAudio,
    enableBackgroundKeepalive,
    playOrderChime,
    playServerTTSAudio,
    speakChineseFallback,
    triggerVibration,
    triggerSystemNotification,
    formatAccountForSpeech,
    formatMethodForSpeech,
    formatOrderVoiceText,
    alertOrderNotification,
    createWorkerTimer
  };

  // 全局首次交互时静默激活保活与音频
  const unlockEvents = ['click', 'touchstart', 'keydown'];
  const onFirstTouch = function() {
    unlockAudio();
    unlockEvents.forEach(evt => window.removeEventListener(evt, onFirstTouch, true));
  };
  unlockEvents.forEach(evt => window.addEventListener(evt, onFirstTouch, true));

  // 页面加载完成后自动初始化播放器 DOM
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initAudioElements);
    } else {
      initAudioElements();
    }
  }

})(window);
