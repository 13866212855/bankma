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
    const clientToken = StateService.getClientToken();
    const currentUserId = StateService.getUserId();
    const currentTenantId = StateService.getTenantId();

    const defaultHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Client-Token': clientToken,
      'X-User-Id': currentUserId || '',
      'X-Tenant-Id': currentTenantId || 'default'
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
  },

  delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
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

// 状态管理服务 - 客户端唯一性标识与用户数据安全隔离
const StateService = {
  getClientToken() {
    let token = localStorage.getItem('qr_client_token');
    if (!token) {
      // 检查 Cookie 备份
      const match = document.cookie.match(/(^|;)\s*qr_client_token=([^;]+)/);
      if (match) {
        token = decodeURIComponent(match[2]);
      }
    }
    if (!token) {
      // 生成设备唯一标识 (UUID / Token)
      token = 'ct_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    }
    // 持久化双重存储 (localStorage + 长期 Cookie)
    localStorage.setItem('qr_client_token', token);
    document.cookie = `qr_client_token=${encodeURIComponent(token)}; path=/; max-age=31536000; SameSite=Lax`;
    return token;
  },

  getUserId() {
    return localStorage.getItem('qr_user_id') || '';
  },

  setUserId(id) {
    localStorage.setItem('qr_user_id', String(id));
  },

  getCurrentUser() {
    try {
      const raw = localStorage.getItem('qr_user_info');
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  },

  setCurrentUser(user) {
    if (user) {
      if (user.id) this.setUserId(user.id);
      localStorage.setItem('qr_user_info', JSON.stringify(user));
    } else {
      localStorage.removeItem('qr_user_info');
    }
  },

  getLastOrderNo() {
    return localStorage.getItem('qr_last_order_no') || '';
  },

  setLastOrderNo(orderNo) {
    localStorage.setItem('qr_last_order_no', orderNo);
  },

  getTenantId() {
    // 1. 优先从当前浏览器路径提取 (例如 /t/ccb/ 或 /tenant/ahrcu/)
    const path = window.location.pathname || '';
    const subpathMatch = path.match(/^\/(?:t|tenant)\/([a-zA-Z0-9_-]+)/i);
    if (subpathMatch && subpathMatch[1]) {
      const tid = subpathMatch[1].toLowerCase();
      localStorage.setItem('qr_tenant_id', tid);
      return tid;
    }

    // 2. 检查 URL 参数 ?tenant=...
    const urlParams = new URLSearchParams(window.location.search);
    const queryTenant = urlParams.get('tenant') || urlParams.get('tenant_id');
    if (queryTenant && queryTenant.trim()) {
      const tid = queryTenant.trim().toLowerCase();
      localStorage.setItem('qr_tenant_id', tid);
      return tid;
    }

    // 3. 检查 LocalStorage 缓存
    return localStorage.getItem('qr_tenant_id') || 'default';
  },

  setTenantId(tenantId) {
    const tid = (tenantId || 'default').trim().toLowerCase();
    localStorage.setItem('qr_tenant_id', tid);
  },

  switchTenant(tenantId) {
    this.setTenantId(tenantId);
    // 如果当前处于子路径，平滑重定向至对应租户的子路径
    const tid = (tenantId || 'default').trim().toLowerCase();
    const currentPath = window.location.pathname;
    let targetPath = '/';

    if (currentPath.includes('admin')) targetPath = tid === 'default' ? '/admin' : `/t/${tid}/admin`;
    else if (currentPath.includes('scan')) targetPath = tid === 'default' ? '/scan' : `/t/${tid}/scan`;
    else if (currentPath.includes('status')) targetPath = tid === 'default' ? '/status' : `/t/${tid}/status`;
    else if (currentPath.includes('settings')) targetPath = tid === 'default' ? '/settings' : `/t/${tid}/settings`;
    else targetPath = tid === 'default' ? '/' : `/t/${tid}/`;

    window.location.href = targetPath;
  },

  async initUser() {
    try {
      const clientToken = this.getClientToken();
      const user = await API.post('/user/init', { client_token: clientToken });
      if (user && user.id) {
        this.setCurrentUser(user);
        return user;
      }
    } catch (err) {
      console.warn('初始化客户端独立身份失败:', err);
    }
    const fallback = { id: 1, nickname: '专属客户' };
    this.setCurrentUser(fallback);
    return fallback;
  }
};

// 用户收款偏好缓存（基于 userId 独立空间，保证每个客户的常用银行卡及配置 100% 独立隔离）
const UserPreferenceService = {
  getKey(name) {
    const uid = StateService.getUserId() || 'default';
    return `qr_${name}_user_${uid}`;
  },

  getPreferences() {
    try {
      const raw = localStorage.getItem(this.getKey('pref_withdraw'));
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      method: 'wechat',
      wechat: { account: '', real_name: '' },
      alipay: { account: '', real_name: '' },
      bank: { account: '', bank_name: '', real_name: '' }
    };
  },

  saveMethod(method) {
    const prefs = this.getPreferences();
    prefs.method = method;
    localStorage.setItem(this.getKey('pref_withdraw'), JSON.stringify(prefs));
  },

  saveAccountDetails(method, details) {
    const prefs = this.getPreferences();
    prefs.method = method;
    prefs[method] = { ...(prefs[method] || {}), ...details };
    localStorage.setItem(this.getKey('pref_withdraw'), JSON.stringify(prefs));
  },

  getSavedBankCards() {
    try {
      const raw = localStorage.getItem(this.getKey('saved_bank_cards'));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {}
    // 回退：若该用户有当前银行配置则作为初始卡
    const prefs = this.getPreferences();
    if (prefs.bank && prefs.bank.account) {
      return [{
        bank_name: prefs.bank.bank_name || '储蓄卡',
        account: prefs.bank.account,
        real_name: prefs.bank.real_name || ''
      }];
    }
    return [];
  },

  saveBankCard(card) {
    if (!card || !card.account) return [];
    let list = this.getSavedBankCards();
    const cleanAccount = card.account.replace(/\s+/g, '');
    const cleanName = (card.real_name || '').trim();

    // 判重过滤：卡号和真实姓名同时相同则不重复新增，直接合并更新
    list = list.filter(item => {
      const itmAcc = (item.account || '').replace(/\s+/g, '');
      const itmName = (item.real_name || '').trim();
      return !(itmAcc.toLowerCase() === cleanAccount.toLowerCase() && itmName.toLowerCase() === cleanName.toLowerCase());
    });

    // 插入最前面作为最新使用的卡
    list.unshift({
      bank_name: (card.bank_name || '储蓄卡').trim(),
      account: cleanAccount,
      real_name: cleanName,
      updated_at: Date.now()
    });

    // 最多存储 10 张卡
    if (list.length > 10) list = list.slice(0, 10);
    localStorage.setItem(this.getKey('saved_bank_cards'), JSON.stringify(list));

    // 同时同步更新默认 bank
    this.saveAccountDetails('bank', {
      bank_name: card.bank_name,
      account: cleanAccount,
      real_name: cleanName
    });
    return list;
  },

  deleteBankCard(account, realName) {
    const cleanAccount = (account || '').replace(/\s+/g, '').toLowerCase();
    const cleanName = (realName || '').trim().toLowerCase();
    let list = this.getSavedBankCards().filter(item => {
      const itmAcc = (item.account || '').replace(/\s+/g, '').toLowerCase();
      const itmName = (item.real_name || '').trim().toLowerCase();
      if (cleanName) {
        return !(itmAcc === cleanAccount && itmName === cleanName);
      }
      return itmAcc !== cleanAccount;
    });
    localStorage.setItem(this.getKey('saved_bank_cards'), JSON.stringify(list));
    return list;
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
