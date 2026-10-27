// Quản lý dữ liệu: Tích hợp MongoDB Atlas qua Netlify Functions API và IndexedDB dự phòng.
const DB_NAME = 'nihongo-study-db';
const DB_VERSION = 2;
let dbPromise;
export let isCloudActive = false;
const tokenKey = 'nihongo_token';
function apiFetch(url, options = {}) {
  const token = localStorage.getItem(tokenKey);
  return fetch(url, { ...options, headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}
export async function restoreCloudSession() {
  if (!localStorage.getItem(tokenKey)) return null;
  const response = await apiFetch('/api/auth/session');
  if (!response.ok) { localStorage.removeItem(tokenKey); return null; }
  return (await response.json()).user;
}
export async function logoutCloud() {
  try { if (isCloudActive && localStorage.getItem(tokenKey)) await apiFetch('/api/auth/logout', { method: 'POST' }); }
  finally { localStorage.removeItem(tokenKey); }
}

function openDB() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('Trình duyệt không hỗ trợ IndexedDB.'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('lessons')) db.createObjectStore('lessons', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'username' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Không mở được cơ sở dữ liệu.'));
      req.onblocked = () => reject(new Error('Cơ sở dữ liệu đang bị khóa bởi tab khác.'));
    }).catch(error => { dbPromise = null; throw error; });
  }
  return dbPromise;
}

async function request(storeName, operation, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const isRead = operation === 'getAll' || operation === 'get';
    const tx = db.transaction(storeName, isRead ? 'readonly' : 'readwrite');
    const store = tx.objectStore(storeName);
    const req = operation === 'getAll' ? store.getAll() : store[operation](value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Không thao tác được dữ liệu.'));
    tx.onerror = () => reject(tx.error || new Error('Giao dịch dữ liệu thất bại.'));
  });
}

export async function hashPassword(plainText) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(plainText ?? ''));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ======================== API CLOUD (MongoDB) ========================

export async function checkCloudHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) { isCloudActive = false; return { ok: false }; }
    const data = await res.json();
    isCloudActive = data.ok === true && data.database === 'connected';
    return data;
  } catch (e) {
    isCloudActive = false;
    return { ok: false, error: e.message };
  }
}

export async function cloudLogin(username, password) {
  if (!isCloudActive) {
    throw new Error('Chưa kết nối được cơ sở dữ liệu. Vui lòng liên hệ quản trị viên.');
  }

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Đăng nhập thất bại.');
  localStorage.setItem(tokenKey, data.token);
  return data.user;
}

export async function cloudGetUsers() {
  if (!isCloudActive) return getUsers();
  const res = await apiFetch('/api/auth/users');
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể lấy danh sách người dùng.');
  return data.users;
}

export async function cloudCreateUser(user) {
  if (!isCloudActive) {
    user.passwordHash = await hashPassword(user.password);
    user.createdAt = Date.now();
    return putUser(user);
  }
  const res = await apiFetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể tạo tài khoản.');
  return data;
}

export async function cloudResetPassword(username, password) {
  if (!isCloudActive) {
    const user = await getUser(username);
    if (!user) throw new Error('Không tìm thấy tài khoản.');
    user.passwordHash = await hashPassword(password);
    return putUser(user);
  }
  const res = await apiFetch(`/api/auth/users/${encodeURIComponent(username)}/password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể đổi mật khẩu.');
  return data;
}

export async function cloudDeleteUser(username) {
  if (!isCloudActive) return removeUser(username);
  const res = await apiFetch(`/api/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể xóa tài khoản.');
  return data;
}

export async function cloudGetLessons() {
  if (!isCloudActive) return getImportedLessons();
  const res = await apiFetch('/api/lessons');
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể tải bài học từ MongoDB.');
  return data.lessons;
}

export async function cloudSaveLessons(lessons, username = 'admin') {
  const items = Array.isArray(lessons) ? lessons : (lessons?.lessons || [lessons]);
  if (!isCloudActive) {
    for (const l of items) {
      if (!l.createdBy) l.createdBy = username;
      await putLesson(l);
    }
    return items.length;
  }
  const res = await apiFetch('/api/lessons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessons: items, username })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể lưu bài học lên MongoDB.');
  return data.count;
}

export async function cloudDeleteLesson(id, username = '') {
  if (!isCloudActive) return removeLesson(id);
  const query = username ? `?username=${encodeURIComponent(username)}` : '';
  const res = await apiFetch(`/api/lessons/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể xóa bài học.');
  return data;
}

export async function cloudGetProgress(username) {
  if (!isCloudActive) return (await getProgress()).filter(item => item.username === username);
  const res = await apiFetch(`/api/progress?username=${encodeURIComponent(username)}`);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể tải tiến độ học tập.');
  return data.progress;
}

export async function cloudSaveProgress(record) {
  if (!isCloudActive) return putProgress(record);
  const res = await apiFetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể lưu tiến độ học tập.');
}

// ======================== LOCAL INDEXEDDB ========================

export const getImportedLessons = () => request('lessons', 'getAll');
export const putLesson = lesson => request('lessons', 'put', lesson);
export const removeLesson = id => request('lessons', 'delete', id);

export const getProgress = () => request('progress', 'getAll');
export const putProgress = item => request('progress', 'put', item);

export const getUsers = () => request('users', 'getAll');
export const getUser = username => request('users', 'get', username);
export const putUser = user => request('users', 'put', user);
export const removeUser = username => request('users', 'delete', username);

export async function initLocalAuth() {
  const users = await getUsers();
  if (!users || users.length === 0) {
    const adminUser = {
      username: 'admin',
      name: 'Quản trị viên',
      role: 'admin',
      passwordHash: await hashPassword('admin123'),
      createdAt: Date.now()
    };
    await putUser(adminUser);
    return [adminUser];
  }
  return users;
}
