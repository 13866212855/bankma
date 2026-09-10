/**
 * frontend/assets/app.js
 * 客户扫码提现 H5 应用 - 前端核心逻辑与 API 客户端
 */

// 全局 API 统一请求封装
const API = {
  baseUrl: '/api',

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const token = localStorage.getItem('qr_auth_token') || 'demo-auth-token-2026';

    const defaultHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    const config = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers
      }
    };

    try {
      const response = await fetch(url, config);
      const resData = await response.json();

      if (!response.ok || resData.code !== 200) {
        const errorMsg = resData.message || `请求异常 (状态码: ${response.status})`;
        throw new Error(errorMsg);
      }

      return resData.data;
    } catch (err) {
      console.error(`[API Error] ${endpoint}:`, err.message);
      throw err;
    }
  },

  get(endpoint) {
    return this.request(endpoint, { method: 'GET' });
  },

  post(endpoint, body) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },

  put(endpoint, body) {
    return this.request(endpoint, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined
    });
  }
};

// UI 提示工具 (Toast)
const Toast = {
  show(message, type = 'info', duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';
    if (type === 'warning') icon = '⏳';

    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error', 4000); },
  warning(msg) { this.show(msg, 'warning'); }
};

// 全局加载状态遮罩
const Loading = {
  show(text = '正在处理中...') {
    let overlay = document.getElementById('loading-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'loading-overlay';
      overlay.className = 'loading-overlay';
      overlay.innerHTML = `
        <div class="spinner"></div>
        <div class="loading-text" id="loading-text">${text}</div>
      `;
      document.body.appendChild(overlay);
    } else {
      const textElem = document.getElementById('loading-text');
      if (textElem) textElem.innerText = text;
      overlay.style.display = 'flex';
    }
  },

  hide() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }
};

// 状态管理服务
const StateService = {
  getUserId() {
    return localStorage.getItem('qr_user_id') || '1';
  },

  setUserId(id) {
    localStorage.setItem('qr_user_id', String(id));
  },

  getLastOrderNo() {
    return localStorage.getItem('qr_last_order_no') || '';
  },

  setLastOrderNo(orderNo) {
    localStorage.setItem('qr_last_order_no', orderNo);
  },

  async initUser() {
    try {
      const user = await API.get('/user/current');
      if (user && user.id) {
        this.setUserId(user.id);
        return user;
      }
    } catch {
      // 默认用户回退
    }
    return { id: 1, phone: '13800138000' };
  }
};

// 扫码器服务（结合摄像头流与本地图片上传解析）
const QRScannerService = {
  stream: null,
  scanTimer: null,
  canvas: null,
  ctx: null,

  async startCamera(videoElement, onDetected, onError) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (onError) onError(new Error('当前浏览器或环境不支持调用摄像头'));
      return;
    }

    try {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

      // 优先请求后置摄像头 (environment)
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      videoElement.srcObject = this.stream;
      await videoElement.play();

      // 开始逐帧扫描
      const scanFrame = () => {
        if (!this.stream || videoElement.readyState !== videoElement.HAVE_ENOUGH_DATA) {
          this.scanTimer = requestAnimationFrame(scanFrame);
          return;
        }

        this.canvas.width = videoElement.videoWidth;
        this.canvas.height = videoElement.videoHeight;
        this.ctx.drawImage(videoElement, 0, 0, this.canvas.width, this.canvas.height);

        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        
        // 检查全局 jsQR 是否可用
        if (typeof jsQR === 'function') {
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
          });

          if (code && code.data) {
            // 扫描成功，触发震动反馈（如果设备支持）
            if (navigator.vibrate) navigator.vibrate(100);
            this.stopCamera();
            onDetected(code.data);
            return;
          }
        }

        this.scanTimer = requestAnimationFrame(scanFrame);
      };

      this.scanTimer = requestAnimationFrame(scanFrame);

    } catch (err) {
      console.warn('[Camera] 无法开启摄像头:', err.message);
      if (onError) onError(err);
    }
  },

  stopCamera() {
    if (this.scanTimer) {
      cancelAnimationFrame(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
  },

  /**
   * 解析本地上传的图片
   */
  parseImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        return reject(new Error('未选择任何图片文件'));
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (typeof jsQR === 'function') {
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            if (code && code.data) {
              resolve(code.data);
              return;
            }
          }
          reject(new Error('未能从所选图片中识别出有效的二维码'));
        };
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }
};

// 页面导航高亮设置
function highlightNav() {
  const path = window.location.pathname;
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    const href = item.getAttribute('href');
    if (href && (path.endsWith(href) || (href === 'index.html' && (path === '/' || path.endsWith('/'))))) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  highlightNav();
  StateService.initUser();
});
