/**
 * frontend/assets/sound.js
 * 纯前端零依赖实时声音与中文语音播报引擎 (mynotice 技能)
 * 
 * 包含:
 * 1. Web Audio API 纯算法合成清脆和弦提示音 (零 MP3 依赖)
 * 2. SpeechSynthesis 原生中文语音合成 TTS
 * 3. 浏览器与 iOS Safari / 微信 Autoplay 策略穿透机制
 * 4. 移动端震动反馈 (Navigator.vibrate)
 */

(function(window) {
  let audioContext = null;
  let isAudioUnlocked = false;

  /**
   * 获取全局单例 AudioContext，安全兼容移动端与 WebKit 前缀
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
   * 检查当前音频上下文是否已就绪
   */
  function isAudioReady() {
    if (!audioContext) return false;
    return audioContext.state === 'running' && isAudioUnlocked;
  }

  /**
   * 解锁浏览器音频播放权限 (在点击、登录、触控交互中调用)
   * 核心：向音轨输出 1 采样点极短静音，满足 iOS Safari 与 Chrome 严苛的 Autoplay 策略
   */
  function unlockAudio() {
    if (typeof window === 'undefined') return;
    const ctx = getAudioContext();
    if (!ctx) return;

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
    } catch (e) {
      // 忽略已激活时的微小异常
    }
  }

  /**
   * 纯算法动态合成清脆的商户到单/通知和弦提示音 (类似美团/微信到单音效)
   * 音阶组合: C5 (523Hz) -> E5 (659Hz) -> G5 (784Hz) -> C6 (1046Hz) -> E6 (1318Hz)
   */
  function playOrderChime() {
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
   * @param {string} text 需要朗读的中文文本
   */
  function speakChineseText(text = '您有新的订单，请及时处理！') {
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
  function triggerVibration() {
    if (typeof window !== 'undefined' && 'navigator' in window && 'vibrate' in navigator) {
      try {
        navigator.vibrate([200, 100, 200, 100, 300]);
      } catch (e) {
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
   * @param {number} count 新单数量
   * @param {string} detail 动态细节 (例如: "支付1000元，张伟申请提现")
   * @param {string} customPrefix 自定义前缀 (默认: "您有新的扫码核实订单")
   */
  function alertNotification(count = 1, detail, customPrefix = '您有新的扫码核实订单') {
    unlockAudio();
    playOrderChime();
    triggerVibration();

    let msg = '';
    if (detail) {
      msg = `${customPrefix}，${detail}，请及时核查打款`;
    } else if (count > 1) {
      msg = `您有${count}笔新的核实订单，请及时处理`;
    } else {
      msg = `${customPrefix}，请及时核验打款`;
    }

    setTimeout(() => {
      speakChineseText(msg);
    }, 400);
  }

  // 挂载到全局
  window.MyNoticeSound = {
    getAudioContext,
    isAudioReady,
    unlockAudio,
    playOrderChime,
    speakChineseText,
    triggerVibration,
    alertNotification
  };

  // 全局首次交互自动静默激活
  const unlockEvents = ['click', 'touchstart', 'keydown'];
  const onFirstTouch = function() {
    unlockAudio();
    unlockEvents.forEach(evt => window.removeEventListener(evt, onFirstTouch, true));
  };
  unlockEvents.forEach(evt => window.addEventListener(evt, onFirstTouch, true));

})(window);
