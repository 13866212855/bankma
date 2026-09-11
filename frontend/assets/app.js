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

// 用户收款偏好缓存（记住上一次选择的结果，保证每个用户独立）
const UserPreferenceService = {
  getPreferences() {
    try {
      const raw = localStorage.getItem('qr_user_preferred_withdraw');
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      method: 'wechat',
      wechat: { account: '13800138000', real_name: '张三' },
      alipay: { account: '13800138000', real_name: '张三' },
      bank: { account: '6222021001123456789', bank_name: '中国工商银行', real_name: '张三' }
    };
  },

  saveMethod(method) {
    const prefs = this.getPreferences();
    prefs.method = method;
    localStorage.setItem('qr_user_preferred_withdraw', JSON.stringify(prefs));
  },

  saveAccountDetails(method, details) {
    const prefs = this.getPreferences();
    prefs.method = method;
    prefs[method] = { ...(prefs[method] || {}), ...details };
    localStorage.setItem('qr_user_preferred_withdraw', JSON.stringify(prefs));
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
