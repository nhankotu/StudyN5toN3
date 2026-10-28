// Quản lý dữ liệu: Tích hợp MongoDB Atlas qua Netlify Functions API và IndexedDB dự phòng.
const DB_NAME = 'nihongo-study-db';
const DB_VERSION = 2;
let dbPromise;
export let isCloudActive = false;
const tokenKey = 'nihongo_token';
async function apiFetch(url, options = {}) {
  const token = localStorage.getItem(tokenKey);
  const response = await fetch(url, { ...options, headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (response.status === 401 && token) {
    localStorage.removeItem(tokenKey);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('nihongo-session-expired'));
  }
  return response;
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

export let lastHealthData = null;

export async function checkCloudHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) {
      isCloudActive = false;
      const text = await res.text().catch(() => '');
      lastHealthData = { ok: false, error: `HTTP ${res.status}: ${res.statusText}`, text };
      console.error('[CloudHealth] HTTP Error:', lastHealthData);
      return lastHealthData;
    }
    const data = await res.json();
    isCloudActive = data.ok === true && data.database === 'connected';
    lastHealthData = data;
    if (!isCloudActive) {
      console.error('[CloudHealth] DB Error from /api/health:', data);
    }
    return data;
  } catch (e) {
    isCloudActive = false;
    lastHealthData = { ok: false, error: e.message };
    console.error('[CloudHealth] Fetch error:', e);
    return lastHealthData;
  }
}

export async function cloudLogin(username, password) {
  if (!isCloudActive) {
    const detail = lastHealthData?.message || lastHealthData?.error || '';
    throw new Error('Chưa kết nối được cơ sở dữ liệu' + (detail ? `: ${detail}` : '. Vui lòng liên hệ quản trị viên.'));
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
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB.');
  const res = await apiFetch('/api/auth/users');
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể lấy danh sách người dùng.');
  return data.users;
}

export async function cloudCreateUser(user) {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể tạo tài khoản.');
  const res = await apiFetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể tạo tài khoản.');
  return data;
}

export async function cloudResetPassword(username, password = '', temporary = false) {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể đặt lại mật khẩu.');
  const res = await apiFetch(`/api/auth/users/${encodeURIComponent(username)}/password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, temporary })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể đổi mật khẩu.');
  return data;
}

export async function cloudChangePassword(newPassword, oldPassword = '') {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể đổi mật khẩu.');
  const res = await apiFetch('/api/auth/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword, oldPassword })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể đổi mật khẩu.');
  return data;
}

export async function cloudDeleteUser(username) {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể xóa tài khoản.');
  const res = await apiFetch(`/api/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể xóa tài khoản.');
  return data;
}

export async function cloudGetLessons() {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể tải bài học.');
  const res = await apiFetch('/api/lessons');
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể tải bài học từ MongoDB.');
  return data.lessons;
}

export async function cloudGetLesson(id) {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB.');
  const res = await apiFetch(`/api/lessons/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể tải bài học.');
  return data.lesson;
}

export async function cloudSaveLessons(lessons, username = 'admin') {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể lưu bài học.');
  const items = Array.isArray(lessons) ? lessons : (lessons?.lessons || [lessons]);
  const res = await apiFetch('/api/lessons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessons: items, username })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể lưu bài học lên MongoDB.');
  return data.count;
}

export async function cloudUpdateLesson(id, lesson) {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể cập nhật bài học.');
  const res = await apiFetch(`/api/lessons/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lesson)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể cập nhật bài học.');
  return data;
}

export async function cloudDeleteLesson(id, username = '') {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể xóa bài học.');
  const query = username ? `?username=${encodeURIComponent(username)}` : '';
  const res = await apiFetch(`/api/lessons/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể xóa bài học.');
  return data;
}

export async function cloudGetProgress(username) {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể tải tiến độ học tập.');
  const res = await apiFetch(`/api/progress?username=${encodeURIComponent(username)}`);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || 'Không thể tải tiến độ học tập.');
  return data.progress;
}

export async function cloudSaveProgress(record) {
  if (!isCloudActive) throw new Error('Chưa kết nối cơ sở dữ liệu MongoDB. Không thể lưu tiến độ học tập.');
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
