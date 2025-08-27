// ===== Icons & footer year
function refreshIcons() {
  try { if (window.lucide && lucide.createIcons) lucide.createIcons(); } catch (_) {}
}
document.addEventListener('DOMContentLoaded', () => {
  refreshIcons();
  document.getElementById('year').innerText = new Date().getFullYear();

  // keep header version = topbar version (if present)
  try {
    const brandVer = document.getElementById('brandVersion');
    const topbarVer = document.querySelector('.app-topbar .badge');
    if (brandVer && topbarVer) brandVer.textContent = (topbarVer.textContent || '').trim();
  } catch (_) {}
});


// ===== Auth state
let authToken = localStorage.getItem('rmb_token') || null;
let currentUser = null;

const authView = document.getElementById('authView');
const appView  = document.getElementById('appView');
const userPill = document.getElementById('userPill');
const logoutBtn = document.getElementById('logoutBtn');
const adminBtn = document.getElementById('adminBtn');
const adminSection = document.getElementById('adminSection');

// ===== Toast
// ===== Toast (safe init)
let toast;
try {
  const toastEl = document.getElementById('successToast');
  toast = (window.bootstrap && toastEl)
    ? new bootstrap.Toast(toastEl)
    : { show(){}, hide(){} };  // no-op fallback
} catch (_) {
  toast = { show(){}, hide(){} };
}
function showToast(message, isError=false) {
  const t = document.getElementById('successToast');
  if (t) {
    t.classList.remove('bg-success','bg-danger');
    t.classList.add(isError ? 'bg-danger' : 'bg-success');
    const msgEl = document.getElementById('toastMessage');
    if (msgEl) msgEl.innerText = message;
  }
  toast.show?.();
}

// Use localhost base only in local dev; otherwise same-origin (empty)
// Always call same-origin (works locally when you open via the Node server,
// and works in production without CSP issues)
const API_BASE = '';



// ===== API helpers
function authHeaders() { return authToken ? { Authorization: 'Bearer ' + authToken } : {}; }
function handleUnauthorized() { doLogout(true); showToast('Session expired. Please login again.', true); return { ok:false }; }
async function apiGet(path) {
  const r = await fetch(API_BASE + path, { headers: authHeaders() });
  if (r.status === 401) return handleUnauthorized();
  return r.json();
}
async function apiPost(path, data) {
  const r = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data || {})
  });
  if (r.status === 401) return handleUnauthorized();
  return r.json();
}

// ===== Auth view toggles
const authContainer = document.getElementById('authContainer');
document.getElementById('toRegisterBtn').addEventListener('click', (e) => { e.preventDefault(); authContainer.classList.add('active'); });
document.getElementById('toLoginBtn').addEventListener('click', (e) => { e.preventDefault(); authContainer.classList.remove('active'); });

// Forms
document.getElementById('loginForm').addEventListener('submit', (e) => { e.preventDefault(); login(); });
document.getElementById('registerForm').addEventListener('submit', (e) => { e.preventDefault(); register(); });
logoutBtn.addEventListener('click', () => doLogout());

// Create bot button in modal
document.getElementById('createBotBtn').addEventListener('click', () => createBot());

// Back buttons
document.getElementById('backFromCommandsBtn').addEventListener('click', () => closeCommands());
document.getElementById('backFromErrorsBtn').addEventListener('click', () => closeErrors());
document.getElementById('adminBackBtn').addEventListener('click', () => closeAdmin());

// Admin save
document.getElementById('adminUserSaveBtn').addEventListener('click', () => adminUpdateUserSettings());

// ===== Auth flows
async function register() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value.trim();
  if (!name || !email || !password) return showToast('Fill all fields', true);

  try {
    const res = await apiPost('/auth/register', { name, email, password });
    if (!res.ok) return showToast(res.error || 'Registration failed', true);
    authToken = res.token; localStorage.setItem('rmb_token', authToken);
    currentUser = res.user; afterLogin();
  } catch (e) { showToast('Registration error', true); }
}

async function login() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  if (!email || !password) return showToast('Fill all fields', true);

  try {
    const res = await apiPost('/auth/login', { email, password });
    if (!res.ok) return showToast(res.error || 'Login failed', true);
    authToken = res.token; localStorage.setItem('rmb_token', authToken);
    currentUser = res.user; afterLogin();
  } catch (e) { showToast('Login error', true); }
}

async function restoreSession() {
  if (!authToken) return showAuth();
  try {
    const res = await apiGet('/auth/me');
    if (!res.ok) return showAuth();
    currentUser = res.user;
    afterLogin(true);
  } catch { showAuth(); }
}

function afterLogin(silent=false) {
  showApp();
  userPill.textContent = `${currentUser.name || 'User'} • ${currentUser.role || 'user'}${currentUser.plan ? ' • '+currentUser.plan : ''}`;
  showAdminButtonIfNeeded();
  if (!silent) showToast('Logged in successfully');
  loadBots();
}

function doLogout(silent=false) {
  authToken = null; currentUser = null;
  localStorage.removeItem('rmb_token');
  showAuth();
  if (!silent) showToast('Logged out');
}

function showAuth() {
  appView.style.display = 'none';
  authView.style.display = 'flex';
  refreshIcons();
}
function showApp() {
  if (adminSection) adminSection.style.display = 'none';
  authView.style.display = 'none';
  appView.style.display = 'block';
  document.getElementById('dashboardSection').style.display = 'block';
  document.getElementById('commandsSection').style.display = 'none';
  document.getElementById('errorsSection').style.display = 'none';
  refreshIcons();
}

// ---------- Bots ----------
const botsGrid = document.getElementById('botsGrid');

async function loadBots() {
  try {
    const list = await apiGet('/getBots');
    botsGrid.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
      botsGrid.innerHTML = `
        <div class="col-12">
          <div class="card">
            <div class="card-body text-center py-4">
              <i data-lucide="bot" class="text-muted mb-2" width="48" height="48"></i>
              <h5 class="text-muted">No bots created yet</h5>
              <p class="text-muted mb-0">Click "Create New Bot" to get started</p>
            </div>
          </div>
        </div>`;
      refreshIcons(); return;
    }

    list.forEach(b => {
      const col = document.createElement('div');
      col.className = 'col-12 col-md-6 col-lg-4';
      col.innerHTML = `
        <div class="card">
          <div class="card-header d-flex justify-content-between">
            <span>${escapeHtml(b.name)}</span>
            <span class="badge ${b.status === 'RUN' ? 'bg-success' : 'bg-secondary'}">${b.status}</span>
          </div>
          <div class="card-body">
            <p class="card-text"><small class="text-muted">Created: ${new Date(b.createdAt).toLocaleString()}</small></p>
            <div class="d-flex flex-wrap gap-2">
              <button class="btn btn-sm ${b.status === 'RUN' ? 'btn-warning' : 'btn-success'}"
                      data-action="toggle" data-bot-id="${b.botId}">
                <i data-lucide="${b.status === 'RUN' ? 'power-off' : 'play'}" class="me-1"></i>${b.status === 'RUN' ? 'Stop' : 'Start'}
              </button>
              <button class="btn btn-sm btn-outline-info"
                      data-action="commands" data-bot-id="${b.botId}" data-bot-name="${escapeHtml(b.name)}">
                <i data-lucide="terminal-square" class="me-1"></i>Commands
              </button>
              <button class="btn btn-sm btn-outline-danger"
                      data-action="delete" data-bot-id="${b.botId}">
                <i data-lucide="trash-2" class="me-1"></i>Delete
              </button>
              <button class="btn btn-sm btn-outline-danger"
                      data-action="errors" data-bot-id="${b.botId}" data-bot-name="${escapeHtml(b.name)}">
                <i data-lucide="alert-triangle" class="me-1"></i>Errors
              </button>
            </div>
          </div>
        </div>`;
      botsGrid.appendChild(col);
    });
    refreshIcons();
  } catch (error) {
    console.error('Error loading bots:', error);
    showToast('Error loading bots', true);
  }
}

// Event delegation for bot card buttons
// Event delegation for bot card buttons (robust to text-node clicks)
botsGrid.addEventListener('click', async (e) => {
  const el  = e.target instanceof Element ? e.target : e.target?.parentElement;
  const btn = el?.closest?.('[data-action]');
  if (!btn) return;

  const id     = btn.dataset.botId;
  const action = btn.dataset.action;
  const name   = btn.dataset.botName || '';

  if (action === 'toggle')  return toggleBot(id);
  if (action === 'delete')  return deleteBot(id);
  if (action === 'commands') return openCommands(id, name);
  if (action === 'errors')   return openErrors(id, name);
});


async function createBot() {
  const token = document.getElementById('newToken').value.trim();
  const name = document.getElementById('newName').value.trim();
  if (!token || !name) return showToast('Please fill both fields', true);

  const res = await apiPost('/createBot', { token, name });
  if (!res.ok) return showToast(res.error || 'Error creating bot', true);

  document.getElementById('newToken').value = '';
  document.getElementById('newName').value = '';
  bootstrap.Modal.getInstance(document.getElementById('createBotModal')).hide();
  showToast('Bot created successfully!');
  loadBots();
}

async function toggleBot(id) {
  try {
    const list = await apiGet('/getBots');
    const bot = Array.isArray(list) ? list.find(b => b.botId === id) : null;
    if (!bot) return showToast('Bot not found', true);
    const url = bot.status === 'RUN' ? '/stopBot' : '/startBot';
    const res = await apiPost(url, { botId: id });
    if (!res.ok) return showToast(res.error || 'Failed', true);
    showToast(`Bot ${bot.status === 'RUN' ? 'stopped' : 'started'} successfully`);
    loadBots();
  } catch (error) {
    console.error('Error toggling bot:', error);
    showToast('Error toggling bot', true);
  }
}

async function deleteBot(id) {
  if (!confirm('Are you sure you want to delete this bot?')) return;
  const res = await apiPost('/deleteBot', { botId: id });
  if (!res.ok) return showToast(res.error || 'Error deleting bot', true);
  showToast('Bot deleted successfully');
  loadBots();
}

// ---------- Commands ----------
let currentBotId = null;
let editingCommand = null;

document.getElementById('saveCommandBtn').addEventListener('click', () => saveCommand());
document.getElementById('cancelEditBtn').addEventListener('click', () => cancelEdit());

async function openCommands(botId, name) {
  currentBotId = botId;
  document.getElementById('cmdBotName').innerText = name;
  document.getElementById('dashboardSection').style.display = 'none';
  document.getElementById('commandsSection').style.display = 'block';
  document.getElementById('cmdName').value = '';
  document.getElementById('cmdCode').value = '';
  document.getElementById('editSectionTitle').innerText = 'Add New Command';
  document.getElementById('cancelEditBtn').style.display = 'none';
  editingCommand = null;
  await loadCommands();
}
function closeCommands() {
  document.getElementById('commandsSection').style.display = 'none';
  document.getElementById('dashboardSection').style.display = 'block';
}

async function loadCommands() {
  try {
    const cmds = await apiGet(`/getCommands?botId=${currentBotId}`);
    const grid = document.getElementById('cmdGrid');
    grid.innerHTML = '';
    const entries = cmds && typeof cmds === 'object' ? Object.entries(cmds) : [];

    if (entries.length === 0) {
      grid.innerHTML = `
        <div class="col-12">
          <div class="card">
            <div class="card-body text-center py-4">
              <i data-lucide="terminal-square" class="text-muted mb-2" width="48" height="48"></i>
              <h5 class="text-muted">No commands yet</h5>
              <p class="text-muted mb-0">Add your first command above</p>
            </div>
          </div>
        </div>`;
      refreshIcons(); return;
    }

    entries.forEach(([name, code]) => {
      const col = document.createElement('div');
      col.className = 'col-12 col-md-6 col-lg-4';
      col.innerHTML = `
        <div class="card">
          <div class="card-header d-flex justify-content-between">
            <span>/${escapeHtml(name)}</span>
            <div class="d-flex gap-2">
              <button class="btn btn-sm btn-outline-secondary"
                      data-action="cmd-edit" data-cmd-name="${escapeHtml(name)}"
                      data-cmd-code="${encodeURIComponent(code)}">
                <i data-lucide="edit-2" class="me-1"></i>Edit
              </button>
              <button class="btn btn-sm btn-outline-danger"
                      data-action="cmd-del" data-cmd-name="${escapeHtml(name)}">
                <i data-lucide="trash-2" class="me-1"></i>Delete
              </button>
            </div>
          </div>
          <div class="card-body">
            <pre class="small bg-light p-2 rounded" style="max-height:120px;overflow:auto">${escapeHtml(code)}</pre>
          </div>
        </div>`;
      grid.appendChild(col);
    });
    refreshIcons();
  } catch (error) {
    console.error('Error loading commands:', error);
    showToast('Error loading commands', true);
  }
}

// Delegation for command cards
document.getElementById('cmdGrid').addEventListener('click', async (e) => {
  const el  = e.target instanceof Element ? e.target : e.target?.parentElement;
  const btn = el?.closest?.('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const name   = btn.dataset.cmdName;

  if (action === 'cmd-edit') return editCmd(name, decodeURIComponent(btn.dataset.cmdCode));
  if (action === 'cmd-del')  return delCmd(name);
});


function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function editCmd(name, code) {
  editingCommand = name;
  document.getElementById('cmdName').value = name;
  document.getElementById('cmdCode').value = code;
  document.getElementById('editSectionTitle').innerText = `Edit Command /${name}`;
  document.getElementById('cancelEditBtn').style.display = 'block';
  document.getElementById('commandEditSection').scrollIntoView({ behavior: 'smooth' });
}
function cancelEdit() {
  editingCommand = null;
  document.getElementById('cmdName').value = '';
  document.getElementById('cmdCode').value = '';
  document.getElementById('editSectionTitle').innerText = 'Add New Command';
  document.getElementById('cancelEditBtn').style.display = 'none';
}

async function saveCommand() {
  const name = document.getElementById('cmdName').value.trim();
  const code = document.getElementById('cmdCode').value.trim();
  if (!name || !code) return showToast('Please fill both fields', true);

  try {
    if (editingCommand && name !== editingCommand) {
      await apiPost('/delCommand', { botId: currentBotId, name: editingCommand });
    }
    const res = await apiPost('/addCommand', { botId: currentBotId, name, code });
    if (!res.ok) return showToast(res.error || 'Error saving command', true);

    showToast(`Command /${name} ${editingCommand ? 'updated' : 'added'} successfully`);
    cancelEdit();
    await loadCommands();
  } catch (error) {
    console.error('Error saving command:', error);
    showToast('Error saving command', true);
  }
}

async function delCmd(name) {
  if (!confirm(`Are you sure you want to delete command /${name}?`)) return;
  const res = await apiPost('/delCommand', { botId: currentBotId, name });
  if (!res.ok) return showToast(res.error || 'Error deleting command', true);
  showToast(`Command /${name} deleted successfully`);
  if (editingCommand === name) cancelEdit();
  await loadCommands();
}

// ---------- Errors ----------
async function openErrors(botId, name) {
  currentBotId = botId;
  document.getElementById('errBotName').innerText = name;
  document.getElementById('dashboardSection').style.display = 'none';
  document.getElementById('errorsSection').style.display = 'block';
  await loadErrors();
}
function closeErrors() {
  document.getElementById('errorsSection').style.display = 'none';
  document.getElementById('dashboardSection').style.display = 'block';
}

async function loadErrors() {
  try {
    const errs = await apiGet(`/getErrors?botId=${currentBotId}`);
    const grid = document.getElementById('errGrid');
    grid.innerHTML = '';

    if (!Array.isArray(errs) || errs.length === 0) {
      grid.innerHTML = `
        <div class="col-12">
          <div class="card">
            <div class="card-body text-center py-4">
              <i data-lucide="alert-triangle" class="text-muted mb-2" width="48" height="48"></i>
              <h5 class="text-muted">No errors yet</h5>
              <p class="text-muted mb-0">Errors will appear here when they occur</p>
            </div>
          </div>
        </div>`;
      refreshIcons(); return;
    }

    errs.forEach(err => {
      const col = document.createElement('div');
      col.className = 'col-12';
      col.innerHTML = `
        <div class="card">
          <div class="card-header d-flex justify-content-between">
            <span>${new Date(err.timestamp).toLocaleString()}</span>
            <span class="badge bg-danger">Command: ${escapeHtml(err.command)}</span>
          </div>
          <div class="card-body">
            <pre class="small bg-light p-2 rounded" style="max-height:120px;overflow:auto">${escapeHtml(err.message)}</pre>
          </div>
        </div>`;
      grid.appendChild(col);
    });
    refreshIcons();
  } catch (error) {
    console.error('Error loading errors:', error);
    showToast('Error loading errors', true);
  }
}

// ===================== Admin =====================
let adminUsersCache = [];
let adminSelectedUser = null;

adminBtn.addEventListener('click', () => openAdmin());
document.getElementById('adminUserSearch').addEventListener('input', () => renderAdminUsersList());

function showAdminButtonIfNeeded() {
  if (currentUser?.role === 'admin') adminBtn.style.display = 'inline-block';
  else adminBtn.style.display = 'none';
}

function openAdmin() {
  document.getElementById('dashboardSection').style.display = 'none';
  document.getElementById('commandsSection').style.display = 'none';
  document.getElementById('errorsSection').style.display = 'none';
  adminSection.style.display = 'block';
  loadAdminUsers();
}

function closeAdmin() {
  adminSection.style.display = 'none';
  document.getElementById('dashboardSection').style.display = 'block';
}

async function loadAdminUsers() {
  try {
    const res = await apiGet('/admin/users');
    if (!res.ok) return showToast(res.error || 'Failed to load users', true);
    adminUsersCache = res.users || [];
    renderAdminUsersList();
  } catch (e) {
    console.error(e);
    showToast('Error loading users', true);
  }
}

function renderAdminUsersList() {
  const q = (document.getElementById('adminUserSearch').value || '').toLowerCase();
  const list = document.getElementById('adminUsersList');
  list.innerHTML = '';

  const users = adminUsersCache.filter(u =>
    (u.name || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q) ||
    (u.role || '').toLowerCase().includes(q) ||
    (u.plan || '').toLowerCase().includes(q)
  );

  if (users.length === 0) {
    list.innerHTML = `<div class="list-group-item text-muted">No users</div>`;
    return;
  }

  users.forEach(u => {
    const item = document.createElement('button');
    item.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
    item.innerHTML = `
      <div>
        <div class="fw-semibold">${escapeHtml(u.name || '(no name)')}</div>
        <div class="small text-muted">${escapeHtml(u.email || '')}</div>
      </div>
      <div class="text-end">
        <span class="badge text-bg-light me-1">${escapeHtml(u.role)}</span>
        <span class="badge text-bg-secondary me-1">${escapeHtml(u.plan)}</span>
        <span class="badge text-bg-info">${u.botCount} bots</span>
      </div>`;
    item.addEventListener('click', () => adminSelectUser(u));
    list.appendChild(item);
  });
}

async function adminSelectUser(u) {
  adminSelectedUser = u;
  const meta = document.getElementById('adminUserMeta');
  meta.textContent = `${u.name} • ${u.email} • created ${new Date(u.createdAt).toLocaleString()}`;
  document.getElementById('adminUserPlan').value = u.plan || 'free';
  document.getElementById('adminUserRole').value = u.role || 'user';

  await loadAdminUserBots(u.id);
  await loadAdminUserErrors(u.id);
}

// Admin user bots list (left column)
const adminBotsCont = document.getElementById('adminUserBots');
adminBotsCont.addEventListener('click', async (e) => {
  const el  = e.target instanceof Element ? e.target : e.target?.parentElement;
  const btn = el?.closest?.('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const botId  = btn.dataset.botId;
  const name   = btn.dataset.botName || '';

  if (action === 'toggle')   return adminToggleBot(botId, btn.dataset.botStatus);
  if (action === 'delete')   return adminDeleteBot(botId);
  if (action === 'errors')   return adminShowBotErrors(botId, name);
  if (action === 'commands') return adminViewCommands(botId);
});


async function loadAdminUserBots(userId) {
  adminBotsCont.innerHTML = `<div class="col-12 text-muted small">Loading...</div>`;
  try {
    const res = await apiGet(`/admin/user/${userId}/bots`);
    if (!res.ok) { adminBotsCont.innerHTML = `<div class="col-12 text-danger small">${escapeHtml(res.error || 'Failed to load bots')}</div>`; return; }
    adminBotsCont.innerHTML = '';
    const bots = res.bots || [];
    if (bots.length === 0) { adminBotsCont.innerHTML = `<div class="col-12 text-muted small">No bots</div>`; return; }

    bots.forEach(b => {
      const col = document.createElement('div');
      col.className = 'col-12 col-md-6';
      col.innerHTML = `
        <div class="card">
          <div class="card-header d-flex justify-content-between">
            <span>${escapeHtml(b.name)}</span>
            <span class="badge ${b.status === 'RUN' ? 'bg-success' : 'bg-secondary'}">${b.status}</span>
          </div>
          <div class="card-body">
            <p class="card-text"><small class="text-muted">Created: ${new Date(b.createdAt).toLocaleString()}</small></p>
            <div class="d-flex flex-wrap gap-2">
              <button class="btn btn-sm ${b.status === 'RUN' ? 'btn-warning' : 'btn-success'}"
                      data-action="toggle" data-bot-id="${b.botId}" data-bot-status="${b.status}">
                <i data-lucide="${b.status === 'RUN' ? 'power-off' : 'play'}" class="me-1"></i>${b.status === 'RUN' ? 'Stop' : 'Start'}
              </button>
              <button class="btn btn-sm btn-outline-danger" data-action="delete" data-bot-id="${b.botId}">
                <i data-lucide="trash-2" class="me-1"></i>Delete
              </button>
              <button class="btn btn-sm btn-outline-info" data-action="errors" data-bot-id="${b.botId}" data-bot-name="${escapeHtml(b.name)}">
                <i data-lucide="alert-triangle" class="me-1"></i>Errors
              </button>
              <button class="btn btn-sm btn-outline-secondary" data-action="commands" data-bot-id="${b.botId}">
                <i data-lucide="terminal-square" class="me-1"></i>Commands
              </button>
            </div>
          </div>
        </div>`;
      adminBotsCont.appendChild(col);
    });
    refreshIcons();
  } catch (e) {
    adminBotsCont.innerHTML = `<div class="col-12 text-danger small">Error loading bots</div>`;
  }
}

async function loadAdminUserErrors(userId) {
  const cont = document.getElementById('adminUserErrors');
  cont.innerHTML = `<div class="col-12 text-muted small">Loading...</div>`;
  try {
    const res = await apiGet(`/admin/user/${userId}/errors`);
    if (!res.ok) { cont.innerHTML = `<div class="col-12 text-danger small">${escapeHtml(res.error || 'Failed to load errors')}</div>`; return; }
    cont.innerHTML = '';
    const errs = res.errors || [];
    if (errs.length === 0) { cont.innerHTML = `<div class="col-12 text-muted small">No recent errors</div>`; return; }

    errs.slice(0, 10).forEach(err => {
      const col = document.createElement('div');
      col.className = 'col-12';
      col.innerHTML = `
        <div class="card">
          <div class="card-header d-flex justify-content-between">
            <span>${new Date(err.timestamp).toLocaleString()}</span>
            <span class="badge bg-danger">Bot: ${escapeHtml(err.botId)} • Cmd: ${escapeHtml(err.command)}</span>
          </div>
          <div class="card-body">
            <pre class="small bg-light p-2 rounded" style="max-height:120px;overflow:auto">${escapeHtml(err.message)}</pre>
          </div>
        </div>`;
      cont.appendChild(col);
    });
    refreshIcons();
  } catch (e) {
    cont.innerHTML = `<div class="col-12 text-danger small">Error loading errors</div>`;
  }
}

async function adminUpdateUserSettings() {
  if (!adminSelectedUser) return;
  const plan = document.getElementById('adminUserPlan').value;
  const role = document.getElementById('adminUserRole').value;
  try {
    const r1 = await apiPost(`/admin/user/${adminSelectedUser.id}/plan`, { plan });
    const r2 = await apiPost(`/admin/user/${adminSelectedUser.id}/role`, { role });
    if (!r1.ok || !r2.ok) return showToast('Failed saving user settings', true);
    showToast('User settings updated');
    adminSelectedUser.plan = plan;
    adminSelectedUser.role = role;
    const idx = adminUsersCache.findIndex(u => String(u.id) === String(adminSelectedUser.id));
    if (idx >= 0) adminUsersCache[idx] = adminSelectedUser;
    renderAdminUsersList();
  } catch (e) { showToast('Error saving user settings', true); }
}

async function adminToggleBot(botId, status) {
  const url = status === 'RUN' ? '/stopBot' : '/startBot';
  const res = await apiPost(url, { botId });
  if (!res.ok) return showToast(res.error || 'Failed', true);
  showToast(`Bot ${status === 'RUN' ? 'stopped' : 'started'}`);
  if (adminSelectedUser) await loadAdminUserBots(adminSelectedUser.id);
}
async function adminDeleteBot(botId) {
  if (!confirm('Delete this bot?')) return;
  const res = await apiPost('/deleteBot', { botId });
  if (!res.ok) return showToast(res.error || 'Failed to delete', true);
  showToast('Bot deleted');
  if (adminSelectedUser) {
    await loadAdminUserBots(adminSelectedUser.id);
    await loadAdminUserErrors(adminSelectedUser.id);
  }
}
async function adminShowBotErrors(botId, name) { openErrors(botId, name); }
async function adminViewCommands(botId) {
  const res = await apiGet(`/admin/user/${adminSelectedUser.id}/commands?botId=${encodeURIComponent(botId)}`);
  if (!res.ok) return showToast(res.error || 'Failed to load commands', true);
  const count = Object.keys(res.commands || {}).length;
  showToast(`This bot has ${count} command(s).`);
}



// ----- Generic dropdowns (Explore + Help) via class toggle -----
(function initDropdowns(){
  const toggles = document.querySelectorAll('.dropdown-toggle[data-dropdown]');

  function closeAll() {
    document.querySelectorAll('.dropdown-menu.is-open').forEach(m => m.classList.remove('is-open'));
    toggles.forEach(t => t.setAttribute('aria-expanded', 'false'));
  }

  toggles.forEach(btn => {
    const id = btn.dataset.dropdown;
    const menu = document.getElementById(id);
    if (!menu) return;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = menu.classList.contains('is-open');
      closeAll();
      if (!isOpen) {
        menu.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  window.addEventListener('resize', closeAll);
})();



// ===== Boot
restoreSession();
