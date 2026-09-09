/* ============================================================
   Interest Manager — Client-side SPA Router & App
   Step 3: Accounts / Loans Management
   ============================================================ */

(function () {
    'use strict';

    // ─── State ───────────────────────────────────────────────
    let currentCategory = 'all';
    let searchDebounceTimer = null;
    let isSaving = false;

    // ─── Currency Formatter (Indian) ─────────────────────────
    function formatRupees(paisa) {
        const rupees = paisa / 100;
        return '₹' + rupees.toLocaleString('en-IN', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
    }

    // ─── Date Formatting ─────────────────────────────────────
    // DB stores YYYY-MM-DD, UI shows DD/MM/YYYY
    function formatDateDMY(dateStr) {
        if (!dateStr) return '—';
        try {
            const parts = dateStr.split('-');
            if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
            const d = new Date(dateStr);
            return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
        } catch { return dateStr; }
    }

    function formatDateShort(dateStr) {
        if (!dateStr) return '—';
        try {
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch { return dateStr; }
    }

    // Convert DD/MM/YYYY -> YYYY-MM-DD for DB
    function dmyToISO(dmy) {
        if (!dmy) return '';
        const parts = dmy.split('/');
        if (parts.length !== 3) return dmy;
        return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }

    // Convert YYYY-MM-DD -> DD/MM/YYYY for form inputs
    function isoToDMY(iso) {
        if (!iso) return '';
        const parts = iso.split('-');
        if (parts.length !== 3) return iso;
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }

    // ─── Toast System ────────────────────────────────────────
    function getOrCreateToastContainer() {
        let c = document.getElementById('toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'toast-container';
            c.className = 'toast-container';
            document.body.appendChild(c);
        }
        return c;
    }

    function showToast(message, type = 'success', duration = 3000) {
        const container = getOrCreateToastContainer();
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icons = { success: '✓', error: '✕', info: 'ℹ' };
        toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHtml(message)}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'toastOut 250ms ease-in forwards';
            setTimeout(() => toast.remove(), 250);
        }, duration);
    }

    // ─── Utility ─────────────────────────────────────────────
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function getAvatarClass(directions) {
        if (!directions) return 'neutral';
        const d = typeof directions === 'string' ? directions : directions.join(',');
        if (d.includes('MONEY_GIVEN') && d.includes('MONEY_TAKEN')) return 'neutral';
        if (d.includes('MONEY_GIVEN')) return 'given';
        if (d.includes('MONEY_TAKEN')) return 'taken';
        return 'neutral';
    }

    function getDirectionLabel(directions) {
        if (!directions) return '';
        const d = typeof directions === 'string' ? directions : directions.join(',');
        const labels = [];
        if (d.includes('MONEY_GIVEN')) labels.push('Money Given To');
        if (d.includes('MONEY_TAKEN')) labels.push('Money Taken From');
        return labels.join(' · ');
    }

    function directionHumanLabel(dir) {
        return dir === 'MONEY_GIVEN' ? 'Money Lent' : dir === 'MONEY_TAKEN' ? 'Money Taken' : dir;
    }

    function frequencyLabel(f) {
        return (f || '').charAt(0).toUpperCase() + (f || '').slice(1).toLowerCase();
    }

    function statusBadgeClass(status) {
        switch (status) {
            case 'ACTIVE': return 'badge-active';
            case 'OVERDUE': return 'badge-overdue';
            case 'CLOSED': return 'badge-closed';
            case 'WRITTEN_OFF': return 'badge-closed';
            case 'PARTIALLY_PAID': return 'badge-given';
            default: return 'badge-active';
        }
    }

    // ─── Authentication & Session State (Part 12) ───────────
    let authToken = sessionStorage.getItem('im_auth_token') || null;
    let currentUser = null;
    try {
        currentUser = JSON.parse(sessionStorage.getItem('im_current_user') || 'null');
    } catch (_) {}

    function setAuthSession(token, user) {
        authToken = token;
        currentUser = user;
        if (token) {
            sessionStorage.setItem('im_auth_token', token);
            sessionStorage.setItem('im_current_user', JSON.stringify(user));
        } else {
            sessionStorage.removeItem('im_auth_token');
            sessionStorage.removeItem('im_current_user');
        }
        updateHeaderAuthUI();
    }

    function getAuthHeaders(customHeaders = {}) {
        const headers = { ...customHeaders };
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
        }
        return headers;
    }

    function handleUnauthorized() {
        if (authToken) {
            setAuthSession(null, null);
            showToast('Session expired. Please sign in again.', 'warning');
            renderLogin();
        }
    }

    function updateHeaderAuthUI() {
        const notifBtn = document.getElementById('btn-notifications');
        const secBtn = document.getElementById('btn-security-settings');
        const userWidget = document.getElementById('user-profile-widget');
        const userNameSpan = document.getElementById('user-display-name');
        const userRoleBadge = document.getElementById('user-role-badge');
        const fab = document.getElementById('fab-add');

        if (authToken && currentUser) {
            if (notifBtn) notifBtn.style.display = 'flex';
            if (secBtn) secBtn.style.display = 'flex';
            if (userWidget) userWidget.style.display = 'flex';
            if (userNameSpan) userNameSpan.textContent = currentUser.username;
            if (userRoleBadge) {
                userRoleBadge.textContent = currentUser.role;
                userRoleBadge.className = `role-badge role-${(currentUser.role || 'viewer').toLowerCase()}`;
            }
            if (fab) {
                fab.style.display = currentUser.role === 'VIEWER' ? 'none' : 'flex';
            }
        } else {
            if (notifBtn) notifBtn.style.display = 'none';
            if (secBtn) secBtn.style.display = 'none';
            if (userWidget) userWidget.style.display = 'none';
            if (fab) fab.style.display = 'none';
        }
    }

    // ─── API Helpers ─────────────────────────────────────────
    async function apiGet(url) {
        const res = await fetch(url, { headers: getAuthHeaders() });
        if (res.status === 401 && !url.includes('/auth/login')) {
            handleUnauthorized();
            throw new Error('Session expired or unauthorized');
        }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Request failed (${res.status})`);
        }
        return res.json();
    }

    const inFlightRequests = new Set();

    async function apiPost(url, data) {
        const reqKey = `POST:${url}:${JSON.stringify(data || {})}`;
        if (inFlightRequests.has(reqKey)) {
            throw new Error('Operation is already in progress. Please wait a moment.');
        }
        inFlightRequests.add(reqKey);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(data)
            });
            if (res.status === 401 && !url.includes('/auth/login') && !url.includes('/auth/pin/verify')) {
                handleUnauthorized();
                throw new Error('Session expired or unauthorized');
            }
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
            return body;
        } finally {
            inFlightRequests.delete(reqKey);
        }
    }

    async function apiPut(url, data) {
        const reqKey = `PUT:${url}:${JSON.stringify(data || {})}`;
        if (inFlightRequests.has(reqKey)) {
            throw new Error('Operation is already in progress. Please wait a moment.');
        }
        inFlightRequests.add(reqKey);
        try {
            const res = await fetch(url, {
                method: 'PUT',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(data)
            });
            if (res.status === 401) {
                handleUnauthorized();
                throw new Error('Session expired or unauthorized');
            }
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
            return body;
        } finally {
            inFlightRequests.delete(reqKey);
        }
    }

    async function apiDelete(url) {
        const reqKey = `DELETE:${url}`;
        if (inFlightRequests.has(reqKey)) {
            throw new Error('Operation is already in progress. Please wait a moment.');
        }
        inFlightRequests.add(reqKey);
        try {
            const res = await fetch(url, { method: 'DELETE', headers: getAuthHeaders() });
            if (res.status === 401) {
                handleUnauthorized();
                throw new Error('Session expired or unauthorized');
            }
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || body.details || `Request failed (${res.status})`);
            return body;
        } finally {
            inFlightRequests.delete(reqKey);
        }
    }

    // ─── Login Screen Rendering (12N.1, 12N.3) ───────────────
    function renderLogin() {
        const bottomNav = document.getElementById('bottom-nav');
        if (bottomNav) bottomNav.style.display = 'none';
        const fab = document.getElementById('fab-add');
        if (fab) fab.style.display = 'none';
        updateHeaderAuthUI();

        mainContent.innerHTML = `
            <div class="login-wrapper">
                <div class="login-card">
                    <div class="login-brand">
                        <div class="login-logo-circle">₹</div>
                        <h2>Interest Manager</h2>
                        <p class="login-sub">Sign in to access your financial records</p>
                    </div>

                    <form id="form-login" class="login-form">
                        <div class="form-group">
                            <label for="login-username">Username</label>
                            <input type="text" id="login-username" class="form-control" placeholder="admin / staff / viewer" autocomplete="username" required autofocus>
                        </div>
                        <div class="form-group">
                            <label for="login-password">Password</label>
                            <input type="password" id="login-password" class="form-control" placeholder="••••••••" autocomplete="current-password" required>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block btn-login" id="btn-login-submit">
                            Sign In
                        </button>
                    </form>

                    <div class="login-footer">
                        <p class="text-muted" style="font-size: 0.82rem; margin-top: 1.5rem; text-align: center;">
                            Default accounts: <code>admin</code>, <code>staff</code>, <code>viewer</code>
                        </p>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('form-login').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('login-username').value.trim();
            const password = document.getElementById('login-password').value;
            const submitBtn = document.getElementById('btn-login-submit');

            try {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Signing in…';
                const res = await apiPost('/api/auth/login', { username, password });
                if (res.success && res.token) {
                    setAuthSession(res.token, res.user);
                    showToast(`Welcome back, ${res.user.username}!`, 'success');
                    if (bottomNav) bottomNav.style.display = 'flex';
                    if (fab && res.user.role !== 'VIEWER') fab.style.display = 'flex';
                    navigate('dashboard');
                    pollNotifications();
                } else {
                    showToast(res.error || 'Authentication failed', 'error');
                }
            } catch (err) {
                showToast(err.message, 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Sign In';
            }
        });
    }

    // ─── Notification Polling & Management (12H) ─────────────
    async function pollNotifications() {
        if (!authToken) return;
        try {
            const res = await apiGet('/api/notifications/unread-count');
            const badge = document.getElementById('notification-badge');
            if (badge) {
                if (res.unread_count > 0) {
                    badge.style.display = 'flex';
                    badge.textContent = res.unread_count > 99 ? '99+' : res.unread_count;
                } else {
                    badge.style.display = 'none';
                }
            }
        } catch (_) {}
    }

    async function loadNotificationsDrawer() {
        const container = document.getElementById('notification-list');
        if (!container) return;
        container.innerHTML = '<p class="text-muted" style="text-align: center; padding: 2rem;">Loading notifications…</p>';

        try {
            const res = await apiGet('/api/notifications');
            const items = res.items || [];
            if (items.length === 0) {
                container.innerHTML = '<p class="text-muted" style="text-align: center; padding: 2rem;">No notifications yet.</p>';
                return;
            }

            container.innerHTML = items.map(n => `
                <div class="notif-item ${n.status === 'UNREAD' ? 'unread' : ''}" data-id="${n.id}">
                    <div class="notif-title">${escapeHtml(n.title)}</div>
                    <div class="notif-msg">${escapeHtml(n.message)}</div>
                    <div class="notif-time">${formatDateShort(n.created_at)}</div>
                </div>
            `).join('');

            container.querySelectorAll('.notif-item.unread').forEach(el => {
                el.addEventListener('click', async () => {
                    const id = el.dataset.id;
                    try {
                        await apiPut(`/api/notifications/${id}/read`, {});
                        el.classList.remove('unread');
                        pollNotifications();
                    } catch (_) {}
                });
            });
        } catch (err) {
            container.innerHTML = `<p class="text-muted" style="text-align: center; color: var(--accent-danger);">Failed to load notifications: ${err.message}</p>`;
        }
    }

    // ─── Route Definitions ───────────────────────────────────
    const routes = {
        dashboard:    { title: 'Dashboard',        render: renderDashboard },
        people:       { title: 'People',           render: renderPeople },
        person:       { title: 'Person Profile',   render: renderPersonProfile },
        accounts:     { title: 'Accounts',         render: renderAccounts },
        account:      { title: 'Account Detail',   render: renderAccountDetail },
        transactions: { title: 'Transactions',     render: renderTransactions },
        due:          { title: 'Due',              render: renderDue },
        reports:      { title: 'Reports',          render: renderReports },
        statement:    { title: 'Person Statement', render: renderPersonStatement }
    };

    // ─── Router ──────────────────────────────────────────────
    const mainContent = document.getElementById('main-content');

    function navigate(route, params = {}) {
        if (!authToken) {
            renderLogin();
            return;
        }

        if (!params || Object.keys(params).length === 0) {
            const parsed = parseHash();
            if (parsed.route === route) {
                params = parsed.params;
            }
        }

        const routeData = routes[route];
        if (!routeData) { navigate('dashboard'); return; }

        // Nav active highlight
        let navRoute = route;
        if (route === 'person' || route === 'statement') navRoute = 'people';
        if (route === 'account') navRoute = 'accounts';
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.route === navRoute);
        });

        updateHeaderAuthUI();
        routeData.render(params);

        let targetHash = `#/${route}`;
        if (params && params.id && !params.account_id && !params.person_id) {
            targetHash = `#/${route}/${params.id}`;
        } else if (params && Object.keys(params).length > 0) {
            const sp = new URLSearchParams(params);
            targetHash = `#/${route}?${sp.toString()}`;
        }

        if (window.location.hash !== targetHash) {
            history.pushState(null, '', targetHash);
        }
    }

    function parseHash() {
        const raw = window.location.hash.replace(/^#\/?/, '');
        const [path, queryString] = raw.split('?');
        const parts = (path || '').split('/');
        const route = parts[0] || 'dashboard';
        const params = {};
        if (parts[1]) params.id = parts[1];
        if (queryString) {
            const searchParams = new URLSearchParams(queryString);
            for (const [k, v] of searchParams.entries()) {
                params[k] = v;
            }
        }
        return { route: routes[route] ? route : 'dashboard', params };
    }

    // ═══════════════════════════════════════════════════════════
    // DASHBOARD (Part 7 & Part 13 Polish)
    // ═══════════════════════════════════════════════════════════
    async function renderDashboard() {
        mainContent.innerHTML = `
            <div class="page" id="page-dashboard">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:var(--space-md); margin-bottom:var(--space-md);">
                    <div>
                        <h2 class="page-title">Portfolio Dashboard</h2>
                        <p class="page-subtitle">Real-time lending performance, collection urgency & financial metrics</p>
                    </div>
                    <div style="display:flex; gap:var(--space-sm); flex-wrap:wrap;">
                        <button class="btn btn-secondary btn-small" id="dash-btn-person">+ Add Person</button>
                        <button class="btn btn-primary btn-small" id="dash-btn-loan">+ New Loan</button>
                        <button class="btn btn-secondary btn-small" id="dash-btn-reports">📊 Reports</button>
                    </div>
                </div>

                <!-- KPI Cards -->
                <div class="stat-grid" id="dashboard-stats" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom: var(--space-lg);">
                    <div class="stat-card">
                        <div class="stat-value accent" id="stat-people">—</div>
                        <div class="stat-label">Total People</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value accent" id="stat-accounts">—</div>
                        <div class="stat-label">Active Loans</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value given" id="stat-principal">—</div>
                        <div class="stat-label">Outstanding Principal</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" style="color:var(--accent-info, #6366f1);" id="stat-interest">—</div>
                        <div class="stat-label">Outstanding Interest</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" style="color:var(--accent-success, #10b981);" id="stat-collected">—</div>
                        <div class="stat-label">Total Collected</div>
                    </div>
                    <div class="stat-card" id="card-overdue" style="border-left: 4px solid var(--accent-danger, #ef4444);">
                        <div class="stat-value" style="color:var(--accent-danger, #ef4444);" id="stat-overdue">—</div>
                        <div class="stat-label">Overdue Amount</div>
                    </div>
                </div>

                <!-- Two-Column Section: Collection Urgency & Recent Activity -->
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: var(--space-lg);">
                    
                    <!-- Left: Due & Collection Urgency -->
                    <div class="card" style="display:flex; flex-direction:column;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:var(--space-md); border-bottom:1px solid var(--border-color); padding-bottom:var(--space-sm);">
                            <h3 style="font-size:var(--font-md); font-weight:700; margin:0; display:flex; align-items:center; gap:8px;">
                                <span>⏰</span> Collection Urgency
                            </h3>
                            <a href="#/due" class="btn btn-secondary btn-small" style="font-size:0.75rem;">View All Due →</a>
                        </div>
                        <div id="dash-due-container" style="flex:1;">
                            <div style="text-align:center; padding:var(--space-lg); color:var(--text-muted);">Loading collection status…</div>
                        </div>
                    </div>

                    <!-- Right: Recent Activity Feed -->
                    <div class="card" style="display:flex; flex-direction:column;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:var(--space-md); border-bottom:1px solid var(--border-color); padding-bottom:var(--space-sm);">
                            <h3 style="font-size:var(--font-md); font-weight:700; margin:0; display:flex; align-items:center; gap:8px;">
                                <span>📝</span> Recent Activity
                            </h3>
                            <a href="#/transactions" class="btn btn-secondary btn-small" style="font-size:0.75rem;">All Transactions →</a>
                        </div>
                        <div id="dash-activity-container" style="flex:1;">
                            <div style="text-align:center; padding:var(--space-lg); color:var(--text-muted);">Loading activity…</div>
                        </div>
                    </div>

                </div>
            </div>
        `;

        // Quick action listeners
        const btnPerson = document.getElementById('dash-btn-person');
        if (btnPerson) btnPerson.addEventListener('click', () => {
            const addPersonBtn = document.getElementById('btn-add-person');
            if (addPersonBtn) addPersonBtn.click();
            else navigate('people');
        });

        const btnLoan = document.getElementById('dash-btn-loan');
        if (btnLoan) btnLoan.addEventListener('click', () => {
            const addLoanBtn = document.getElementById('btn-add-account');
            if (addLoanBtn) addLoanBtn.click();
            else navigate('accounts');
        });

        const btnRpt = document.getElementById('dash-btn-reports');
        if (btnRpt) btnRpt.addEventListener('click', () => navigate('reports'));

        try {
            const res = await apiGet('/api/dashboard');
            const data = res.data || res;
            const summary = data.summary || {};
            const recentActivity = data.recent_activity || [];
            const dueCollection = data.due_collection || {};
            const collections = dueCollection.collections || [];

            // Populate KPIs
            document.getElementById('stat-people').textContent = summary.total_people || 0;
            document.getElementById('stat-accounts').textContent = `${summary.active_accounts || 0} / ${summary.total_accounts || 0}`;
            document.getElementById('stat-principal').textContent = formatRupees(summary.outstanding_principal_paisa || (summary.outstanding_principal * 100) || 0);
            document.getElementById('stat-interest').textContent = formatRupees(summary.outstanding_interest_paisa || (summary.outstanding_interest * 100) || 0);
            document.getElementById('stat-collected').textContent = formatRupees(summary.total_paid_paisa || (summary.total_paid * 100) || 0);
            
            const overduePaisa = (summary.overdue_amount_paisa !== undefined) ? summary.overdue_amount_paisa : (Math.round((summary.overdue_amount || 0) * 100));
            document.getElementById('stat-overdue').textContent = formatRupees(overduePaisa);

            // Populate Collection Urgency
            const dueContainer = document.getElementById('dash-due-container');
            if (collections.length === 0) {
                dueContainer.innerHTML = `
                    <div style="text-align:center; padding:var(--space-lg); color:var(--text-muted);">
                        <div style="font-size:2rem; margin-bottom:8px;">✅</div>
                        <div style="font-weight:600; color:var(--accent-success);">All Accounts In Good Standing</div>
                        <p style="font-size:var(--font-xs); margin-top:4px;">No payments are currently due or overdue.</p>
                    </div>
                `;
            } else {
                dueContainer.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:var(--space-xs);">
                        ${collections.slice(0, 5).map(c => `
                            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:var(--radius-sm);">
                                <div>
                                    <div style="font-weight:600; font-size:var(--font-sm);">${escapeHtml(c.person_name || 'Person #' + c.person_id)}</div>
                                    <div style="font-size:var(--font-xs); color:var(--text-muted);">
                                        Loan #${c.account_id} • Due: ${formatDateDMY(c.due_date)}
                                    </div>
                                </div>
                                <div style="text-align:right;">
                                    <div style="font-weight:700; color:var(--accent-danger); font-size:var(--font-sm);">${formatRupees(c.overdue_amount_paisa || Math.round(c.overdue_amount * 100))}</div>
                                    <span class="status-badge status-${(c.urgency || 'overdue').toLowerCase()}" style="font-size:0.65rem; padding:2px 6px;">${escapeHtml(c.urgency || 'OVERDUE')}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
            }

            // Populate Recent Activity Feed
            const actContainer = document.getElementById('dash-activity-container');
            if (recentActivity.length === 0) {
                actContainer.innerHTML = `
                    <div style="text-align:center; padding:var(--space-lg); color:var(--text-muted);">
                        <div style="font-size:2rem; margin-bottom:8px;">💳</div>
                        <div>No Recent Transactions</div>
                        <p style="font-size:var(--font-xs); margin-top:4px;">Disbursements and payments will appear here.</p>
                    </div>
                `;
            } else {
                actContainer.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:var(--space-xs);">
                        ${recentActivity.slice(0, 5).map(tx => {
                            const isPayment = (tx.transaction_type || '').includes('RECEIVED') || (tx.type || '').includes('RECEIVED');
                            const sign = isPayment ? '+' : '−';
                            const color = isPayment ? 'var(--accent-success)' : 'var(--accent-warning, #f59e0b)';
                            const amountPaisa = tx.amount_paisa !== undefined ? tx.amount_paisa : Math.round((tx.amount || 0) * 100);
                            return `
                                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:var(--radius-sm);">
                                    <div>
                                        <div style="font-weight:600; font-size:var(--font-sm);">${escapeHtml(tx.person_name || 'Person #' + (tx.person_id || ''))}</div>
                                        <div style="font-size:var(--font-xs); color:var(--text-muted);">
                                            ${formatDateDMY(tx.transaction_date || tx.created_at)} • ${escapeHtml(tx.transaction_type || tx.type || 'Transaction')}
                                        </div>
                                    </div>
                                    <div style="text-align:right;">
                                        <div style="font-weight:700; color:${color}; font-size:var(--font-sm);">${sign}${formatRupees(amountPaisa)}</div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }

        } catch (err) {
            console.warn('Dashboard error:', err);
            showToast('Could not load all dashboard metrics: ' + err.message, 'error');
        }
    }

    // ═══════════════════════════════════════════════════════════
    // PEOPLE LIST (from Step 2 — unchanged)
    // ═══════════════════════════════════════════════════════════
    async function renderPeople() {
        mainContent.innerHTML = `
            <div class="page" id="page-people">
                <h2 class="page-title">People</h2>
                <p class="page-subtitle">Manage contacts — borrowers & lenders</p>
                <div class="search-container">
                    <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input type="text" id="people-search" class="search-input" placeholder="Search by name or phone…" autocomplete="off">
                    <button id="search-clear" class="search-clear" aria-label="Clear search">✕</button>
                </div>
                <div class="category-tabs" id="category-tabs">
                    <button class="category-tab active" data-category="all">All <span class="tab-count" id="count-all">—</span></button>
                    <button class="category-tab" data-category="MONEY_GIVEN">Given To <span class="tab-count" id="count-given">—</span></button>
                    <button class="category-tab" data-category="MONEY_TAKEN">Taken From <span class="tab-count" id="count-taken">—</span></button>
                </div>
                <div id="people-list"><div class="loading-state"><div class="spinner"></div><p>Loading people…</p></div></div>
            </div>
        `;

        const searchInput = document.getElementById('people-search');
        const clearBtn = document.getElementById('search-clear');
        searchInput.addEventListener('input', () => {
            clearBtn.classList.toggle('visible', searchInput.value.length > 0);
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => loadPeopleList(), 300);
        });
        clearBtn.addEventListener('click', () => { searchInput.value = ''; clearBtn.classList.remove('visible'); loadPeopleList(); searchInput.focus(); });

        document.getElementById('category-tabs').addEventListener('click', (e) => {
            const tab = e.target.closest('.category-tab');
            if (!tab) return;
            currentCategory = tab.dataset.category;
            document.querySelectorAll('.category-tab').forEach(t => t.classList.toggle('active', t.dataset.category === currentCategory));
            loadPeopleList();
        });

        await loadPeopleList();
    }

    async function loadPeopleList() {
        const listEl = document.getElementById('people-list');
        if (!listEl) return;
        const searchInput = document.getElementById('people-search');
        const searchTerm = searchInput ? searchInput.value.trim() : '';

        try {
            let url = '/api/people';
            const qp = [];
            if (searchTerm) qp.push(`search=${encodeURIComponent(searchTerm)}`);
            if (currentCategory !== 'all') qp.push(`category=${currentCategory}`);
            if (qp.length) url += '?' + qp.join('&');

            const { data: allPeople } = await apiGet('/api/people');
            const { data: people } = await apiGet(url);

            const givenCount = allPeople.filter(p => p.directions && p.directions.includes('MONEY_GIVEN')).length;
            const takenCount = allPeople.filter(p => p.directions && p.directions.includes('MONEY_TAKEN')).length;
            const el = (id) => document.getElementById(id);
            if (el('count-all')) el('count-all').textContent = allPeople.length;
            if (el('count-given')) el('count-given').textContent = givenCount;
            if (el('count-taken')) el('count-taken').textContent = takenCount;

            if (!people || people.length === 0) {
                listEl.innerHTML = searchTerm
                    ? `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No people found</div><div class="empty-description">No results for "${escapeHtml(searchTerm)}"</div></div>`
                    : `<div class="empty-state"><div class="empty-icon">👥</div><div class="empty-title">No people yet</div><div class="empty-description">Add your first person to start tracking.</div><button class="empty-action" id="empty-add-btn">+ Add Person</button></div>`;
                document.getElementById('empty-add-btn')?.addEventListener('click', openAddPersonModal);
                return;
            }

            listEl.innerHTML = people.map(person => {
                const ac = getAvatarClass(person.directions);
                const accCount = person.account_count || 0;
                const total = (person.total_given || 0) + (person.total_taken || 0);
                return `
                    <div class="list-item" data-person-id="${person.id}">
                        <div class="list-avatar ${ac}">${escapeHtml(person.name.charAt(0).toUpperCase())}</div>
                        <div class="list-info">
                            <div class="list-name">${escapeHtml(person.name)}</div>
                            <div class="list-meta">${person.phone ? escapeHtml(person.phone) + ' · ' : ''}${accCount} account${accCount !== 1 ? 's' : ''}${getDirectionLabel(person.directions) ? ' · ' + getDirectionLabel(person.directions) : ''}</div>
                        </div>
                        <div class="list-amount">
                            ${total > 0 ? `<div class="amount ${ac === 'given' ? 'direction-given' : ac === 'taken' ? 'direction-taken' : ''}">${formatRupees(total)}</div>` : ''}
                            ${accCount > 0 ? `<div class="badge badge-${ac === 'given' ? 'given' : ac === 'taken' ? 'taken' : 'active'}">${accCount} acc</div>` : '<span class="badge badge-closed">New</span>'}
                        </div>
                    </div>`;
            }).join('');

            listEl.querySelectorAll('.list-item').forEach(item => {
                item.addEventListener('click', () => navigate('person', { id: item.dataset.personId }));
            });
        } catch (err) {
            listEl.innerHTML = `<div class="placeholder-card"><div class="icon">⚠️</div><h3>Could not load people</h3><p>${escapeHtml(err.message)}</p></div>`;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ADD/EDIT PERSON MODAL (from Step 2)
    // ═══════════════════════════════════════════════════════════
    function openAddPersonModal(callbackOnCreate) { openPersonFormModal(null, callbackOnCreate); }
    function openEditPersonModal(person) { openPersonFormModal(person); }

    function openPersonFormModal(person, callbackOnCreate) {
        const isEdit = !!person;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2 class="modal-title">${isEdit ? 'Edit Person' : 'Add Person'}</h2>
                    <button class="modal-close" id="pm-close" aria-label="Close">✕</button>
                </div>
                <form id="pm-form" novalidate>
                    <div class="form-group">
                        <label class="form-label">Name <span class="required">*</span></label>
                        <input type="text" id="pm-name" class="form-input" placeholder="Enter person's name" value="${isEdit ? escapeHtml(person.name) : ''}" maxlength="200" autocomplete="off">
                        <div class="form-error" id="pm-err-name">Name is required</div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Phone Number</label>
                        <input type="tel" id="pm-phone" class="form-input" placeholder="e.g. 9876543210" value="${isEdit && person.phone ? escapeHtml(person.phone) : ''}" autocomplete="off">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Address</label>
                        <textarea id="pm-address" class="form-textarea" placeholder="Optional" rows="2">${isEdit && person.address ? escapeHtml(person.address) : ''}</textarea>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Notes</label>
                        <textarea id="pm-notes" class="form-textarea" placeholder="Optional" rows="2">${isEdit && person.notes ? escapeHtml(person.notes) : ''}</textarea>
                    </div>
                    <div class="form-actions">
                        <button type="button" class="btn btn-secondary" id="pm-cancel">Cancel</button>
                        <button type="submit" class="btn btn-primary" id="pm-save">${isEdit ? 'Save Changes' : 'Add Person'}</button>
                    </div>
                </form>
            </div>`;

        document.body.appendChild(overlay);
        setTimeout(() => document.getElementById('pm-name')?.focus(), 100);

        const close = () => overlay.remove();
        document.getElementById('pm-close').addEventListener('click', close);
        document.getElementById('pm-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        document.getElementById('pm-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (isSaving) return;
            const name = document.getElementById('pm-name').value.trim();
            if (!name) { document.getElementById('pm-name').classList.add('error'); document.getElementById('pm-err-name').classList.add('visible'); document.getElementById('pm-name').focus(); return; }
            document.getElementById('pm-name').classList.remove('error'); document.getElementById('pm-err-name').classList.remove('visible');

            const saveBtn = document.getElementById('pm-save');
            isSaving = true; saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

            try {
                const payload = { name, phone: document.getElementById('pm-phone').value.trim(), address: document.getElementById('pm-address').value.trim(), notes: document.getElementById('pm-notes').value.trim() };
                if (isEdit) {
                    await apiPut(`/api/people/${person.id}`, payload);
                    showToast(`${name} updated`);
                } else {
                    const res = await apiPost('/api/people', payload);
                    showToast(`${name} added`);
                    if (callbackOnCreate) callbackOnCreate(res.data);
                }
                close();
                const parsed = parseHash();
                if (parsed.route === 'person' && isEdit) renderPersonProfile({ id: person.id });
                else if (parsed.route === 'people') loadPeopleList();
            } catch (err) {
                showToast(err.message, 'error');
                saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Person';
            } finally { isSaving = false; }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // PERSON PROFILE (updated for Step 3 — clickable accounts)
    // ═══════════════════════════════════════════════════════════
    async function renderPersonProfile(params) {
        const personId = params?.id;
        if (!personId) { navigate('people'); return; }

        mainContent.innerHTML = `<div class="page" id="page-person"><button class="back-btn" id="bp">← People</button><div class="loading-state"><div class="spinner"></div><p>Loading profile…</p></div></div>`;
        document.getElementById('bp').addEventListener('click', () => navigate('people'));

        try {
            const { data: person } = await apiGet(`/api/people/${personId}`);
            const dirLabels = person.directions || [];
            const avatarClass = dirLabels.includes('MONEY_GIVEN') && !dirLabels.includes('MONEY_TAKEN') ? 'given'
                              : dirLabels.includes('MONEY_TAKEN') && !dirLabels.includes('MONEY_GIVEN') ? 'taken' : 'neutral';

            const pageEl = document.getElementById('page-person');
            pageEl.innerHTML = `
                <button class="back-btn" id="bp2">← People</button>
                <div class="profile-header">
                    <div class="profile-avatar ${avatarClass}">${escapeHtml(person.name.charAt(0).toUpperCase())}</div>
                    <div class="profile-name">${escapeHtml(person.name)}</div>
                    <div class="profile-badges">
                        ${dirLabels.includes('MONEY_GIVEN') ? '<span class="badge badge-given">Money Given To</span>' : ''}
                        ${dirLabels.includes('MONEY_TAKEN') ? '<span class="badge badge-taken">Money Taken From</span>' : ''}
                        ${dirLabels.length === 0 ? '<span class="badge badge-closed">No Accounts</span>' : ''}
                    </div>
                    <div class="profile-actions">
                        <button class="btn btn-secondary btn-small" id="view-person-statement-btn">📄 Statement</button>
                        <button class="btn btn-secondary btn-small" id="view-person-tx-btn">📜 Transactions</button>
                        <button class="btn btn-secondary btn-small" id="edit-person-btn">✎ Edit</button>
                        <button class="btn btn-primary btn-small" id="add-account-btn">+ Add Account</button>
                        <button class="btn btn-danger btn-small" id="delete-person-btn">🗑 Delete</button>
                    </div>
                </div>

                ${person.account_count > 0 ? `
                <div class="profile-section">
                    <div class="profile-section-title">Account Summary</div>
                    <div class="account-summary-grid">
                        <div class="account-summary-card">
                            <div class="account-summary-value accent">${person.account_count}</div>
                            <div class="account-summary-label">Total Accounts</div>
                        </div>
                        <div class="account-summary-card">
                            <div class="account-summary-value accent">${formatRupees(person.total_principal || 0)}</div>
                            <div class="account-summary-label">Total Principal</div>
                        </div>
                        ${person.given_count > 0 ? `<div class="account-summary-card"><div class="account-summary-value direction-given">${formatRupees(person.total_given)}</div><div class="account-summary-label">${person.given_count} Given</div></div>` : ''}
                        ${person.taken_count > 0 ? `<div class="account-summary-card"><div class="account-summary-value direction-taken">${formatRupees(person.total_taken)}</div><div class="account-summary-label">${person.taken_count} Taken</div></div>` : ''}
                    </div>
                </div>` : ''}

                <div class="profile-section">
                    <div class="profile-section-title">Contact Details</div>
                    <div class="card">
                        <div class="profile-detail"><span class="profile-detail-label">Phone</span><span class="profile-detail-value ${person.phone ? '' : 'muted'}">${person.phone ? escapeHtml(person.phone) : 'Not provided'}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Address</span><span class="profile-detail-value ${person.address ? '' : 'muted'}">${person.address ? escapeHtml(person.address) : 'Not provided'}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Notes</span><span class="profile-detail-value ${person.notes ? '' : 'muted'}">${person.notes ? escapeHtml(person.notes) : 'None'}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Added</span><span class="profile-detail-value">${formatDateShort(person.created_at)}</span></div>
                    </div>
                </div>

                ${person.accounts && person.accounts.length > 0 ? `
                <div class="profile-section">
                    <div class="profile-section-title">Accounts (${person.accounts.length})</div>
                    ${person.accounts.map(acc => `
                        <div class="account-item clickable" data-account-id="${acc.id}">
                            <div class="account-item-header">
                                <span class="account-item-id">#${acc.id}</span>
                                <span class="account-item-amount ${acc.direction === 'MONEY_GIVEN' ? 'direction-given' : 'direction-taken'}">${formatRupees(acc.outstanding_principal)}</span>
                                <span class="badge ${statusBadgeClass(acc.status)}">${acc.status}</span>
                            </div>
                            <div class="account-item-meta">
                                ${directionHumanLabel(acc.direction)} · Principal: ${formatRupees(acc.principal)} · ${acc.interest_rate}% ${frequencyLabel(acc.interest_frequency)}
                            </div>
                            <div class="account-item-meta">
                                ${formatDateDMY(acc.start_date)} → ${formatDateDMY(acc.due_date)}
                            </div>
                        </div>
                    `).join('')}
                </div>` : `
                <div class="profile-section">
                    <div class="empty-state" style="padding:24px 16px">
                        <div class="empty-icon">📋</div>
                        <div class="empty-title">No accounts yet</div>
                        <div class="empty-description">Create an account to start tracking loans.</div>
                    </div>
                </div>`}
            `;

            document.getElementById('bp2').addEventListener('click', () => navigate('people'));
            document.getElementById('view-person-statement-btn')?.addEventListener('click', () => navigate('statement', { person_id: person.id }));
            document.getElementById('view-person-tx-btn')?.addEventListener('click', () => navigate('transactions', { person_id: person.id }));
            document.getElementById('edit-person-btn').addEventListener('click', () => openEditPersonModal(person));
            document.getElementById('add-account-btn').addEventListener('click', () => openAddAccountModal(person.id));
            document.getElementById('delete-person-btn').addEventListener('click', async () => {
                if (!confirm(`Delete ${person.name}?`)) return;
                try { await apiDelete(`/api/people/${personId}`); showToast(`${person.name} deleted`); navigate('people'); }
                catch (err) { showToast(err.message, 'error', 5000); }
            });

            // Clickable account items
            pageEl.querySelectorAll('.account-item.clickable').forEach(item => {
                item.addEventListener('click', () => navigate('account', { id: item.dataset.accountId }));
            });

        } catch (err) {
            document.getElementById('page-person').innerHTML = `<button class="back-btn" id="be">← People</button><div class="placeholder-card"><div class="icon">⚠️</div><h3>Could not load profile</h3><p>${escapeHtml(err.message)}</p></div>`;
            document.getElementById('be')?.addEventListener('click', () => navigate('people'));
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ACCOUNTS LIST
    // ═══════════════════════════════════════════════════════════
    async function renderAccounts() {
        // Load people for filter dropdown
        let peopleOptions = '';
        try {
            const { data: people } = await apiGet('/api/people');
            peopleOptions = (people || []).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
        } catch (e) { /* continue without people filter options */ }

        mainContent.innerHTML = `
            <div class="page" id="page-accounts">
                <h2 class="page-title">Accounts</h2>
                <p class="page-subtitle">All loans and financial agreements</p>

                <div class="search-container" id="account-search-container">
                    <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input type="text" id="account-search" class="search-input" placeholder="Search by name or account ID…">
                </div>

                <div class="filter-bar" id="account-filters">
                    <select id="filter-person" class="filter-select">
                        <option value="">All People</option>
                        ${peopleOptions}
                    </select>
                    <select id="filter-direction" class="filter-select">
                        <option value="">All Directions</option>
                        <option value="MONEY_GIVEN">Money Lent</option>
                        <option value="MONEY_TAKEN">Money Taken</option>
                    </select>
                    <select id="filter-status" class="filter-select">
                        <option value="">All Statuses</option>
                        <option value="ACTIVE">Active</option>
                        <option value="PARTIALLY_PAID">Partially Paid</option>
                        <option value="OVERDUE">Overdue</option>
                        <option value="CLOSED">Closed</option>
                        <option value="WRITTEN_OFF">Written Off</option>
                    </select>
                </div>

                <div class="filter-bar" id="account-sort-bar">
                    <select id="sort-by" class="filter-select">
                        <option value="created_at">Sort: Newest</option>
                        <option value="due_date">Sort: Due Date</option>
                        <option value="principal">Sort: Principal</option>
                        <option value="person_name">Sort: Person Name</option>
                    </select>
                    <button class="btn btn-secondary btn-small" id="sort-order-btn" data-order="DESC" title="Toggle sort order">↓ Desc</button>
                </div>

                <div id="accounts-list"><div class="loading-state"><div class="spinner"></div><p>Loading accounts…</p></div></div>
            </div>`;

        // Attach filter/sort listeners
        document.getElementById('filter-person').addEventListener('change', loadAccountsList);
        document.getElementById('filter-direction').addEventListener('change', loadAccountsList);
        document.getElementById('filter-status').addEventListener('change', loadAccountsList);
        document.getElementById('sort-by').addEventListener('change', loadAccountsList);

        // Sort order toggle
        document.getElementById('sort-order-btn').addEventListener('click', function () {
            const current = this.dataset.order;
            const next = current === 'DESC' ? 'ASC' : 'DESC';
            this.dataset.order = next;
            this.textContent = next === 'ASC' ? '↑ Asc' : '↓ Desc';
            loadAccountsList();
        });

        // Search with debounce
        let accSearchTimer = null;
        document.getElementById('account-search').addEventListener('input', function () {
            clearTimeout(accSearchTimer);
            accSearchTimer = setTimeout(loadAccountsList, 300);
        });

        await loadAccountsList();
    }

    async function loadAccountsList() {
        const listEl = document.getElementById('accounts-list');
        if (!listEl) return;

        const direction = document.getElementById('filter-direction')?.value || '';
        const status = document.getElementById('filter-status')?.value || '';
        const personId = document.getElementById('filter-person')?.value || '';
        const search = document.getElementById('account-search')?.value || '';
        const sortBy = document.getElementById('sort-by')?.value || 'created_at';
        const sortOrder = document.getElementById('sort-order-btn')?.dataset.order || 'DESC';

        // Show loading
        listEl.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading accounts…</p></div>`;

        try {
            const qp = [];
            if (direction) qp.push(`direction=${encodeURIComponent(direction)}`);
            if (status) qp.push(`status=${encodeURIComponent(status)}`);
            if (personId) qp.push(`person_id=${encodeURIComponent(personId)}`);
            if (search.trim()) qp.push(`search=${encodeURIComponent(search.trim())}`);
            qp.push(`sort_by=${sortBy}`);
            qp.push(`sort_order=${sortOrder}`);
            const url = '/api/accounts' + (qp.length ? '?' + qp.join('&') : '');
            const { data: accounts } = await apiGet(url);

            if (!accounts || accounts.length === 0) {
                const isFiltered = direction || status || personId || search.trim();
                listEl.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">${isFiltered ? '🔍' : '📋'}</div>
                        <div class="empty-title">${isFiltered ? 'No matching accounts' : 'No accounts yet'}</div>
                        <div class="empty-description">${isFiltered ? 'Try adjusting your filters or search.' : 'Create your first financial account to get started.'}</div>
                        ${isFiltered ? '' : '<button class="empty-action" id="empty-add-acc">+ Add Account</button>'}
                    </div>`;
                document.getElementById('empty-add-acc')?.addEventListener('click', () => openAddAccountModal());
                return;
            }

            // Render account cards
            listEl.innerHTML = accounts.map(acc => {
                const statusLabel = (acc.status || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                return `
                <div class="account-item clickable" data-account-id="${acc.id}">
                    <div class="account-item-header">
                        <div>
                            <span class="account-item-id">#${acc.id}</span>
                            <strong>${escapeHtml(acc.person_name)}</strong>
                        </div>
                        <div class="list-amount">
                            <div class="amount ${acc.direction === 'MONEY_GIVEN' ? 'direction-given' : 'direction-taken'}">${formatRupees(acc.outstanding_principal)}</div>
                        </div>
                    </div>
                    <div class="account-item-meta">
                        <span class="badge ${acc.direction === 'MONEY_GIVEN' ? 'badge-given' : 'badge-taken'}">${directionHumanLabel(acc.direction)}</span>
                        <span class="badge ${statusBadgeClass(acc.status)}">${statusLabel}</span>
                    </div>
                    <div class="account-item-meta" style="margin-top:6px">
                        Original: ${formatRupees(acc.principal)} · ${acc.interest_rate}% ${frequencyLabel(acc.interest_frequency)} · ${formatDateDMY(acc.start_date)} → ${formatDateDMY(acc.due_date)}
                    </div>
                </div>`;
            }).join('');

            listEl.querySelectorAll('.account-item').forEach(item => {
                item.addEventListener('click', () => navigate('account', { id: item.dataset.accountId }));
            });
        } catch (err) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">⚠️</div>
                    <div class="empty-title">Failed to load accounts</div>
                    <div class="empty-description">${escapeHtml(err.message)}</div>
                    <button class="empty-action" id="retry-accounts">↻ Retry</button>
                </div>`;
            document.getElementById('retry-accounts')?.addEventListener('click', loadAccountsList);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ADD ACCOUNT MODAL (with preview step)
    // ═══════════════════════════════════════════════════════════
    async function openAddAccountModal(preselectedPersonId) {
        // Load people for dropdown
        let people = [];
        try {
            const res = await apiGet('/api/people');
            people = res.data || [];
        } catch (err) {
            showToast('Could not load people list', 'error');
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <h2 class="modal-title">Add Account</h2>
                    <button class="modal-close" id="am-close" aria-label="Close">✕</button>
                </div>

                <!-- STEP 1: Form -->
                <div id="am-step-form">
                    <form id="am-form" novalidate>
                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Person <span class="required">*</span></label>
                                <select id="am-person" class="form-input">
                                    <option value="">— Select Person —</option>
                                    ${people.map(p => `<option value="${p.id}" ${p.id == preselectedPersonId ? 'selected' : ''}>${escapeHtml(p.name)}${p.phone ? ' (' + escapeHtml(p.phone) + ')' : ''}</option>`).join('')}
                                </select>
                                <div class="form-error" id="am-err-person">Person is required</div>
                            </div>
                            <button type="button" class="btn btn-secondary btn-small" id="am-new-person" style="margin-top:24px;flex-shrink:0">+ New</button>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Direction <span class="required">*</span></label>
                            <div class="radio-group" id="am-direction-group">
                                <label class="radio-card" data-value="MONEY_GIVEN">
                                    <input type="radio" name="am-direction" value="MONEY_GIVEN">
                                    <span class="radio-card-label">💸 Money Lent</span>
                                    <span class="radio-card-desc">You gave money to this person</span>
                                </label>
                                <label class="radio-card" data-value="MONEY_TAKEN">
                                    <input type="radio" name="am-direction" value="MONEY_TAKEN">
                                    <span class="radio-card-label">🤝 Money Taken</span>
                                    <span class="radio-card-desc">You took money from this person</span>
                                </label>
                            </div>
                            <div class="form-error" id="am-err-direction">Direction is required</div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Principal Amount (₹) <span class="required">*</span></label>
                                <input type="number" id="am-principal" class="form-input" placeholder="e.g. 2000" min="1" step="any" autocomplete="off">
                                <div class="form-error" id="am-err-principal">Amount must be greater than zero</div>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Interest Rate (%) <span class="required">*</span></label>
                                <input type="number" id="am-rate" class="form-input" placeholder="e.g. 15" min="0" step="any" autocomplete="off">
                                <div class="form-error" id="am-err-rate">Rate must be 0 or greater</div>
                            </div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Frequency</label>
                                <select id="am-frequency" class="form-input">
                                    <option value="DAILY">Daily</option>
                                    <option value="WEEKLY">Weekly</option>
                                    <option value="MONTHLY" selected>Monthly</option>
                                    <option value="YEARLY">Yearly</option>
                                </select>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Method</label>
                                <select id="am-method" class="form-input">
                                    <option value="SIMPLE_INTEREST" selected>Simple Interest</option>
                                </select>
                            </div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Start Date (DD/MM/YYYY) <span class="required">*</span></label>
                                <input type="text" id="am-start" class="form-input" placeholder="DD/MM/YYYY" maxlength="10" autocomplete="off">
                                <div class="form-error" id="am-err-start">Valid start date required</div>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Due Date (DD/MM/YYYY) <span class="required">*</span></label>
                                <input type="text" id="am-due" class="form-input" placeholder="DD/MM/YYYY" maxlength="10" autocomplete="off">
                                <div class="form-error" id="am-err-due">Due date must be on or after start date</div>
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Notes</label>
                            <textarea id="am-notes" class="form-textarea" placeholder="Optional notes" rows="2"></textarea>
                        </div>

                        <div class="form-actions">
                            <button type="button" class="btn btn-secondary" id="am-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary" id="am-preview-btn">Preview →</button>
                        </div>
                    </form>
                </div>

                <!-- STEP 2: Preview -->
                <div id="am-step-preview" style="display:none">
                    <div id="am-preview-content"></div>
                    <div class="form-actions">
                        <button type="button" class="btn btn-secondary" id="am-back-btn">← Back</button>
                        <button type="button" class="btn btn-primary" id="am-confirm-btn">✓ Confirm & Save</button>
                    </div>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        document.getElementById('am-close').addEventListener('click', close);
        document.getElementById('am-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        // New person button — creates person inline then refreshes dropdown
        document.getElementById('am-new-person').addEventListener('click', () => {
            openAddPersonModal((newPerson) => {
                if (newPerson) {
                    const select = document.getElementById('am-person');
                    const opt = document.createElement('option');
                    opt.value = newPerson.id;
                    opt.textContent = newPerson.name + (newPerson.phone ? ` (${newPerson.phone})` : '');
                    select.appendChild(opt);
                    select.value = newPerson.id;
                }
            });
        });

        // Auto-format date inputs (insert slashes)
        ['am-start', 'am-due'].forEach(id => {
            document.getElementById(id).addEventListener('input', (e) => {
                let v = e.target.value.replace(/[^0-9/]/g, '');
                // Auto-insert slashes
                if (v.length === 2 && !v.includes('/')) v += '/';
                else if (v.length === 5 && v.split('/').length === 2) v += '/';
                e.target.value = v;
            });
        });

        // Form validation & preview
        document.getElementById('am-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const vals = getAccountFormValues();
            if (!validateAccountForm(vals)) return;
            showAccountPreview(vals);
        });

        // Back from preview
        document.getElementById('am-back-btn').addEventListener('click', () => {
            document.getElementById('am-step-form').style.display = '';
            document.getElementById('am-step-preview').style.display = 'none';
        });

        // Confirm & save
        document.getElementById('am-confirm-btn').addEventListener('click', async () => {
            if (isSaving) return;
            const vals = getAccountFormValues();
            const confirmBtn = document.getElementById('am-confirm-btn');
            isSaving = true; confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…';

            try {
                const res = await apiPost('/api/accounts', {
                    person_id: vals.personId,
                    direction: vals.direction,
                    principal: vals.principal,
                    interest_rate: vals.rate,
                    interest_frequency: vals.frequency,
                    calculation_method: vals.method,
                    start_date: dmyToISO(vals.startDate),
                    due_date: dmyToISO(vals.dueDate),
                    notes: vals.notes
                });
                showToast(`Account #${res.data.id} created for ${escapeHtml(vals.personName)}`);
                close();

                // Refresh current view
                const parsed = parseHash();
                if (parsed.route === 'person') renderPersonProfile(parsed.params);
                else if (parsed.route === 'accounts') loadAccountsList();
                else if (parsed.route === 'dashboard') renderDashboard();
            } catch (err) {
                showToast(err.message, 'error', 5000);
                confirmBtn.disabled = false; confirmBtn.textContent = '✓ Confirm & Save';
            } finally { isSaving = false; }
        });
    }

    function getAccountFormValues() {
        const personSelect = document.getElementById('am-person');
        return {
            personId: personSelect.value,
            personName: personSelect.options[personSelect.selectedIndex]?.text || '',
            direction: document.querySelector('input[name="am-direction"]:checked')?.value || '',
            principal: document.getElementById('am-principal').value,
            rate: document.getElementById('am-rate').value,
            frequency: document.getElementById('am-frequency').value,
            method: document.getElementById('am-method').value,
            startDate: document.getElementById('am-start').value,
            dueDate: document.getElementById('am-due').value,
            notes: document.getElementById('am-notes').value.trim()
        };
    }

    function validateAccountForm(v) {
        let valid = true;
        const show = (id) => { document.getElementById(id).classList.add('visible'); valid = false; };
        const hide = (id) => { document.getElementById(id).classList.remove('visible'); };

        hide('am-err-person'); hide('am-err-direction'); hide('am-err-principal'); hide('am-err-rate'); hide('am-err-start'); hide('am-err-due');

        if (!v.personId) show('am-err-person');
        if (!v.direction) show('am-err-direction');

        const amt = Number(v.principal);
        if (!v.principal || isNaN(amt) || amt <= 0) show('am-err-principal');

        const rate = Number(v.rate);
        if (v.rate === '' || isNaN(rate) || rate < 0) show('am-err-rate');

        const startISO = dmyToISO(v.startDate);
        const dueISO = dmyToISO(v.dueDate);
        if (!v.startDate || !isValidDMY(v.startDate)) show('am-err-start');
        if (!v.dueDate || !isValidDMY(v.dueDate)) { show('am-err-due'); }
        else if (startISO && dueISO && dueISO < startISO) show('am-err-due');

        return valid;
    }

    function isValidDMY(dmy) {
        if (!dmy) return false;
        const parts = dmy.split('/');
        if (parts.length !== 3) return false;
        const d = parseInt(parts[0]), m = parseInt(parts[1]), y = parseInt(parts[2]);
        if (isNaN(d) || isNaN(m) || isNaN(y)) return false;
        if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000) return false;
        return true;
    }

    function showAccountPreview(v) {
        document.getElementById('am-step-form').style.display = 'none';
        document.getElementById('am-step-preview').style.display = '';
        const amt = Number(v.principal) * 100; // convert to paisa for display

        document.getElementById('am-preview-content').innerHTML = `
            <div class="preview-card">
                <div class="preview-title">Review Account Details</div>
                <div class="preview-row"><span class="preview-label">Person</span><span class="preview-value">${escapeHtml(v.personName)}</span></div>
                <div class="preview-row"><span class="preview-label">Direction</span><span class="preview-value"><span class="badge ${v.direction === 'MONEY_GIVEN' ? 'badge-given' : 'badge-taken'}">${directionHumanLabel(v.direction)}</span></span></div>
                <div class="preview-row"><span class="preview-label">Principal</span><span class="preview-value" style="font-weight:700;font-size:1.125rem">${formatRupees(amt)}</span></div>
                <div class="preview-row"><span class="preview-label">Interest</span><span class="preview-value">${v.rate}% / ${frequencyLabel(v.frequency).toLowerCase()}</span></div>
                <div class="preview-row"><span class="preview-label">Calculation</span><span class="preview-value">${v.method.replace('_', ' ')}</span></div>
                <div class="preview-row"><span class="preview-label">Start Date</span><span class="preview-value">${v.startDate}</span></div>
                <div class="preview-row"><span class="preview-label">Due Date</span><span class="preview-value">${v.dueDate}</span></div>
                ${v.notes ? `<div class="preview-row"><span class="preview-label">Notes</span><span class="preview-value">${escapeHtml(v.notes)}</span></div>` : ''}
                <div class="preview-row"><span class="preview-label">Status</span><span class="preview-value"><span class="badge badge-active">ACTIVE</span></span></div>
            </div>
        `;
    }

    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════
    // ACCOUNT DETAIL PAGE (Step 3C)
    // ═══════════════════════════════════════════════════════════
    async function renderAccountDetail(params) {
        const accountId = params?.id;
        if (!accountId) { navigate('accounts'); return; }

        mainContent.innerHTML = `
            <div class="page" id="page-account">
                <button class="back-btn" id="ba">← Accounts</button>
                <div class="loading-state">
                    <div class="spinner"></div>
                    <p>Loading account #${accountId}…</p>
                </div>
            </div>`;
        document.getElementById('ba')?.addEventListener('click', () => navigate('accounts'));

        try {
            const [{ data: acc }, interestBalRes] = await Promise.all([
                apiGet(`/api/accounts/${accountId}`),
                apiGet(`/api/accounts/${accountId}/interest-balance`).catch(() => ({ data: { interestRecorded: 0, interestPaid: 0, interestOutstanding: 0, records: [] } }))
            ]);
            const interestBalance = interestBalRes?.data || { interestRecorded: 0, interestPaid: 0, interestOutstanding: 0, records: [] };
            const isGiven = acc.direction === 'MONEY_GIVEN';
            const statusLabel = (acc.status || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

            document.getElementById('page-account').innerHTML = `
                <button class="back-btn" id="ba2">← Accounts</button>

                <div class="account-detail-header">
                    <div class="account-detail-id">Account #${String(acc.id).padStart(3, '0')}</div>
                    <h2 class="account-detail-title">
                        <a href="#/person/${acc.person_id}" class="link" title="View person profile">${escapeHtml(acc.person_name)}</a>
                    </h2>
                    <div class="account-detail-badges">
                        <span class="badge ${isGiven ? 'badge-given' : 'badge-taken'}">${directionHumanLabel(acc.direction)}</span>
                        <span class="badge ${statusBadgeClass(acc.status)}">${statusLabel}</span>
                    </div>
                </div>

                <div class="account-detail-amount ${isGiven ? 'direction-given' : 'direction-taken'}">
                    ${formatRupees(acc.outstanding_principal)}
                    <span class="account-detail-amount-label">Outstanding Principal</span>
                </div>

                <div class="profile-section">
                    <div class="profile-section-title">Account Configuration</div>
                    <div class="card">
                        <div class="profile-detail"><span class="profile-detail-label">Account ID</span><span class="profile-detail-value">Account #${String(acc.id).padStart(3, '0')}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Person</span><span class="profile-detail-value"><a href="#/person/${acc.person_id}" class="link">${escapeHtml(acc.person_name)}</a></span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Direction</span><span class="profile-detail-value">${directionHumanLabel(acc.direction)}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Original Principal</span><span class="profile-detail-value" style="font-weight:700">${formatRupees(acc.principal)}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Outstanding Principal</span><span class="profile-detail-value" style="font-weight:700">${formatRupees(acc.outstanding_principal)}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Interest Rate</span><span class="profile-detail-value">${acc.interest_rate}%</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Interest Frequency</span><span class="profile-detail-value">${frequencyLabel(acc.interest_frequency)}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Calculation Method</span><span class="profile-detail-value">${(acc.calculation_method || 'SIMPLE_INTEREST').replace(/_/g, ' ')}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Start Date</span><span class="profile-detail-value">${formatDateDMY(acc.start_date)}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Due Date</span><span class="profile-detail-value">${formatDateDMY(acc.due_date)}</span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Status</span><span class="profile-detail-value"><span class="badge ${statusBadgeClass(acc.status)}">${statusLabel}</span></span></div>
                        <div class="profile-detail"><span class="profile-detail-label">Notes</span><span class="profile-detail-value ${acc.notes ? '' : 'muted'}">${acc.notes ? escapeHtml(acc.notes) : 'None'}</span></div>
                    </div>
                </div>

                <!-- STEP 5I: Interest Summary & History -->
                <div class="profile-section" id="section-interest-summary">
                    <div class="profile-section-title">Interest Summary & History</div>
                    <div class="card">
                        <div class="stat-grid" style="display:grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-sm); margin-bottom: var(--space-md);">
                            <div class="stat-card" style="padding: var(--space-sm); text-align: center; background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
                                <div class="stat-value" style="font-size: 1.15rem; font-weight: 700; color: var(--text-primary);">₹${(interestBalance?.interestRecorded || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                <div class="stat-label" style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-top: 4px;">Interest Recorded</div>
                            </div>
                            <div class="stat-card" style="padding: var(--space-sm); text-align: center; background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
                                <div class="stat-value" style="font-size: 1.15rem; font-weight: 700; color: var(--accent-success);">₹${(interestBalance?.interestPaid || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                <div class="stat-label" style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-top: 4px;">Interest Paid</div>
                            </div>
                            <div class="stat-card" style="padding: var(--space-sm); text-align: center; background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
                                <div class="stat-value" style="font-size: 1.15rem; font-weight: 800; color: ${(interestBalance?.interestOutstanding || 0) > 0 ? '#f59e0b' : 'var(--accent-secondary)'};">₹${(interestBalance?.interestOutstanding || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                <div class="stat-label" style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; margin-top: 4px;">Interest Outstanding</div>
                            </div>
                        </div>

                        ${(interestBalance?.records && interestBalance.records.length > 0) ? `
                            <div class="calc-table-wrapper" style="margin-top: var(--space-sm);">
                                <table class="calc-table">
                                    <thead>
                                        <tr>
                                            <th>Period</th>
                                            <th>Recorded</th>
                                            <th>Paid</th>
                                            <th>Outstanding</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${interestBalance.records.map(r => `
                                            <tr>
                                                <td>${formatDateDMY(r.period_start)} – ${formatDateDMY(r.period_end)}</td>
                                                <td style="font-weight:600;">₹${r.interest_amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                <td style="color:var(--accent-success);">₹${r.paid_amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                <td style="font-weight:700; color:${r.outstanding_amount > 0 ? '#f59e0b' : 'var(--text-muted)'};">₹${r.outstanding_amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                <td><span class="badge ${r.status === 'PAID' ? 'badge-active' : (r.status === 'PARTIALLY_PAID' ? 'badge-pending' : 'badge-closed')}">${r.status}</span></td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        ` : `
                            <div style="font-size: 0.85rem; color: var(--text-muted); padding: var(--space-xs) 0;">
                                No interest entries recorded yet for this account.
                            </div>
                        `}
                    </div>
                </div>

                <div class="profile-section">
                    <div class="profile-section-title">Actions & Operations</div>
                    <div class="action-buttons">
                        <button class="btn btn-secondary btn-small" id="view-statement-btn">📄 Statement</button>
                        <button class="btn btn-primary btn-small" id="record-allocation-btn">⚡ Record Payment (Allocate)</button>
                        <button class="btn btn-secondary btn-small" id="record-principal-btn">💰 Principal Payment</button>
                        <button class="btn btn-secondary btn-small" id="record-interest-btn">📈 Interest Payment</button>
                        <button class="btn btn-secondary btn-small" id="record-funding-btn">💸 Initial Funding</button>
                        <button class="btn btn-secondary btn-small" id="edit-account-btn">✎ Edit Account</button>
                        <button class="btn btn-secondary btn-small" id="view-tx-btn">View Transactions</button>
                    </div>
                </div>

                <!-- STEP 5G: Interest Calculation Preview -->
                <div class="profile-section" id="section-interest-calc">
                    <div class="profile-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                        <span>Interest Calculation Preview</span>
                        <span class="badge badge-closed">Calculation preview — not yet recorded</span>
                    </div>
                    <div class="card">
                        <p class="muted" style="margin-bottom: var(--space-md); font-size: 0.875rem;">
                            Select a period to calculate simple interest across historical principal segments.
                            <br>
                            <span style="display:inline-block; margin-top:4px; color: var(--accent-secondary); font-size: 0.8rem; font-weight: 500;">
                                ℹ️ This is a read-only preview and will not record transactions or persist interest records.
                            </span>
                        </p>

                        <form id="interest-calc-form" novalidate>
                            <div class="form-row">
                                <div class="form-group form-group-grow">
                                    <label class="form-label" for="calc-start-date">Start Date (DD/MM/YYYY) <span class="required">*</span></label>
                                    <input type="text" id="calc-start-date" class="form-input" placeholder="DD/MM/YYYY" maxlength="10" autocomplete="off" value="${isoToDMY(acc.start_date)}">
                                    <div class="form-error" id="err-calc-start">Valid start date required (DD/MM/YYYY)</div>
                                </div>
                                <div class="form-group form-group-grow">
                                    <label class="form-label" for="calc-end-date">End Date (DD/MM/YYYY) <span class="required">*</span></label>
                                    <input type="text" id="calc-end-date" class="form-input" placeholder="DD/MM/YYYY" maxlength="10" autocomplete="off" value="${isoToDMY(acc.due_date || '')}">
                                    <div class="form-error" id="err-calc-end">Valid end date required (must be on or after start date)</div>
                                </div>
                            </div>

                            <div style="margin-top: var(--space-sm); display:flex; gap: var(--space-sm);">
                                <button type="submit" class="btn btn-primary" id="btn-calc-interest">
                                    📊 Calculate Interest
                                </button>
                            </div>
                        </form>

                        <div id="calc-result-container" style="margin-top: var(--space-lg); display: none;"></div>
                    </div>
                </div>
            `;

            document.getElementById('ba2')?.addEventListener('click', () => navigate('accounts'));
            document.getElementById('record-allocation-btn')?.addEventListener('click', () => {
                if (acc.direction === 'MONEY_GIVEN') {
                    openPaymentAllocationModal(acc);
                } else {
                    showToast('Payment allocation is only supported for Money Lent (MONEY_GIVEN) accounts', 'warning');
                }
            });
            document.getElementById('record-principal-btn')?.addEventListener('click', () => {
                if (acc.direction === 'MONEY_GIVEN') {
                    openRecordPrincipalPaymentModal(acc);
                } else {
                    showToast('Principal payment is only allowed for Money Lent (MONEY_GIVEN) accounts', 'warning');
                }
            });
            document.getElementById('record-interest-btn')?.addEventListener('click', () => {
                if (acc.direction === 'MONEY_GIVEN') {
                    openRecordInterestPaymentModal(acc);
                } else {
                    showToast('Interest payment is only allowed for Money Lent (MONEY_GIVEN) accounts', 'warning');
                }
            });
            document.getElementById('record-funding-btn')?.addEventListener('click', () => openRecordFundingModal(acc));
            document.getElementById('edit-account-btn')?.addEventListener('click', () => openEditAccountModal(acc));
            document.getElementById('view-statement-btn')?.addEventListener('click', () => navigate('statement', { person_id: acc.person_id, loan_id: acc.id }));
            document.getElementById('view-tx-btn')?.addEventListener('click', () => navigate('transactions', { account_id: acc.id }));

            // ─── Step 5G: Interest Calculation Preview Event Handling ───
            ['calc-start-date', 'calc-end-date'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('input', (e) => {
                        let v = e.target.value.replace(/[^0-9/]/g, '');
                        if (v.length === 2 && !v.includes('/')) v += '/';
                        else if (v.length === 5 && v.split('/').length === 2) v += '/';
                        e.target.value = v;
                    });
                }
            });

            const calcForm = document.getElementById('interest-calc-form');
            const calcBtn = document.getElementById('btn-calc-interest');
            const calcResult = document.getElementById('calc-result-container');
            const errStart = document.getElementById('err-calc-start');
            const errEnd = document.getElementById('err-calc-end');

            async function performInterestCalculation() {
                if (!calcBtn || !calcResult) return;
                if (errStart) errStart.style.display = 'none';
                if (errEnd) errEnd.style.display = 'none';

                const startVal = document.getElementById('calc-start-date')?.value?.trim() || '';
                const endVal = document.getElementById('calc-end-date')?.value?.trim() || '';

                let valid = true;
                if (!startVal || startVal.length !== 10) {
                    if (errStart) { errStart.textContent = 'Valid start date required (DD/MM/YYYY)'; errStart.style.display = 'block'; }
                    valid = false;
                }
                if (!endVal || endVal.length !== 10) {
                    if (errEnd) { errEnd.textContent = 'Valid end date required (DD/MM/YYYY)'; errEnd.style.display = 'block'; }
                    valid = false;
                }

                const startIso = dmyToISO(startVal);
                const endIso = dmyToISO(endVal);

                if (valid && startIso && endIso && endIso < startIso) {
                    if (errEnd) { errEnd.textContent = 'End date cannot be before start date'; errEnd.style.display = 'block'; }
                    valid = false;
                }

                if (!valid) return;

                calcBtn.disabled = true;
                calcBtn.textContent = 'Calculating…';
                calcResult.style.display = 'block';
                calcResult.innerHTML = `
                    <div class="loading-state" style="padding: 1.5rem 0;">
                        <div class="spinner"></div>
                        <p>Calculating interest for Account #${acc.id}…</p>
                    </div>`;

                try {
                    const res = await apiPost(`/api/accounts/${acc.id}/timeline-interest`, {
                        start_date: startIso,
                        end_date: endIso
                    });
                    const d = res.data;

                    const timeYears = d.totalElapsedDays > 0 ? (d.totalElapsedDays / 365).toFixed(4) : '0';
                    const isZeroDays = d.totalElapsedDays === 0;
                    const isZeroPrincipal = (d.openingPrincipal === 0 && d.closingPrincipal === 0);

                    let specialNotice = '';
                    if (isZeroDays) {
                        specialNotice = '<div style="margin-top:var(--space-sm); padding:var(--space-sm); background:rgba(255,255,255,0.02); border-left:3px solid var(--accent-secondary); color:var(--text-muted); font-size:0.875rem;">ℹ️ No interest for this period.</div>';
                    } else if (isZeroPrincipal) {
                        specialNotice = '<div style="margin-top:var(--space-sm); padding:var(--space-sm); background:rgba(255,255,255,0.02); border-left:3px solid var(--accent-secondary); color:var(--text-muted); font-size:0.875rem;">ℹ️ No outstanding principal.</div>';
                    }

                    let segmentsTableHtml = '';
                    let segmentsCardsHtml = '';

                    if (d.segments && d.segments.length > 0) {
                        const rows = d.segments.map(seg => {
                            const segDays = seg.elapsedDays;
                            const segRate = seg.rate;
                            const formula = `₹${seg.principal.toLocaleString('en-IN')} × ${segRate}% × (${segDays}/365)`;
                            return `
                                <tr>
                                    <td>${formatDateDMY(seg.startDate)} → ${formatDateDMY(seg.endDate)}</td>
                                    <td style="font-weight:600;">₹${seg.principal.toLocaleString('en-IN')}</td>
                                    <td>${segDays} days</td>
                                    <td>${segRate}%</td>
                                    <td style="font-family:monospace; font-size:0.75rem; color:var(--text-muted);">${formula}</td>
                                    <td style="font-weight:700; color:var(--accent-success);">₹${seg.interest.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                </tr>
                            `;
                        }).join('');

                        segmentsTableHtml = `
                            <div class="calc-table-wrapper">
                                <table class="calc-table">
                                    <thead>
                                        <tr>
                                            <th>Period</th>
                                            <th>Principal</th>
                                            <th>Days</th>
                                            <th>Rate</th>
                                            <th>Formula</th>
                                            <th>Interest</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${rows}
                                    </tbody>
                                    <tfoot>
                                        <tr>
                                            <td colspan="5" style="text-align:right;">Total Interest:</td>
                                            <td style="color:var(--accent-success); font-size:1rem;">₹${d.totalInterest.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        `;

                        const cards = d.segments.map(seg => {
                            const segDays = seg.elapsedDays;
                            const segRate = seg.rate;
                            const formula = `₹${seg.principal.toLocaleString('en-IN')} × ${segRate}% × (${segDays}/365)`;
                            return `
                                <div class="calc-segment-card">
                                    <div class="calc-segment-header">
                                        <span>${formatDateDMY(seg.startDate)} → ${formatDateDMY(seg.endDate)}</span>
                                        <span style="color:var(--accent-success); font-weight:700;">₹${seg.interest.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    </div>
                                    <div class="calc-segment-body">
                                        <div><span class="muted">Principal:</span> ₹${seg.principal.toLocaleString('en-IN')}</div>
                                        <div><span class="muted">Rate:</span> ${segRate}%</div>
                                        <div><span class="muted">Days:</span> ${segDays} days</div>
                                        <div><span class="muted">Time:</span> ${(segDays/365).toFixed(4)} yrs</div>
                                    </div>
                                    <div class="calc-segment-formula">${formula}</div>
                                </div>
                            `;
                        }).join('');

                        segmentsCardsHtml = `
                            <div class="calc-cards-wrapper">
                                ${cards}
                                <div style="display:flex; justify-content:space-between; padding:var(--space-sm); font-weight:700; background:rgba(255,255,255,0.02); border-radius:var(--radius-md);">
                                    <span>Total Interest:</span>
                                    <span style="color:var(--accent-success);">₹${d.totalInterest.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                            </div>
                        `;
                    }

                    calcResult.innerHTML = `
                        <div class="calc-summary-box">
                            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:var(--space-xs);">
                                <h4 style="margin:0; font-size:1rem; font-weight:700;">Calculation Summary</h4>
                                <span class="badge badge-closed">Calculation preview — not yet recorded</span>
                            </div>

                            <div class="calc-summary-grid">
                                <div class="calc-summary-item">
                                    <span class="calc-summary-label">Account</span>
                                    <span class="calc-summary-value">Account #${String(acc.id).padStart(3, '0')} (${escapeHtml(acc.person_name)})</span>
                                </div>
                                <div class="calc-summary-item">
                                    <span class="calc-summary-label">Principal Basis</span>
                                    <span class="calc-summary-value" title="Principal basis used by the calculation">₹${d.openingPrincipal.toLocaleString('en-IN')} <small class="muted" style="font-size:0.75rem;">(Basis)</small></span>
                                </div>
                                <div class="calc-summary-item">
                                    <span class="calc-summary-label">Interest Rate</span>
                                    <span class="calc-summary-value">${d.annualRate}%</span>
                                </div>
                                <div class="calc-summary-item">
                                    <span class="calc-summary-label">Calculation Method</span>
                                    <span class="calc-summary-value">${(d.calculationMethod || 'SIMPLE_INTEREST').replace(/_/g, ' ')}</span>
                                </div>
                                <div class="calc-summary-item">
                                    <span class="calc-summary-label">Calculation Period</span>
                                    <span class="calc-summary-value">${formatDateDMY(d.calculationStartDate)} – ${formatDateDMY(d.calculationEndDate)}</span>
                                </div>
                                <div class="calc-summary-item">
                                    <span class="calc-summary-label">Elapsed Days</span>
                                    <span class="calc-summary-value">${d.totalElapsedDays} days</span>
                                </div>
                                <div class="calc-summary-item">
                                    <span class="calc-summary-label">Time</span>
                                    <span class="calc-summary-value">${d.totalElapsedDays}/365 years (${timeYears} yrs)</span>
                                </div>
                                <div class="calc-summary-item">
                                    <span class="calc-summary-label">Total Calculated Interest</span>
                                    <span class="calc-summary-value highlight">₹${d.totalInterest.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                            </div>

                            ${specialNotice}
                        </div>

                        ${segmentsTableHtml}
                        ${segmentsCardsHtml}
                    `;

                } catch (err) {
                    calcResult.innerHTML = `
                        <div class="empty-state" style="padding: 1.5rem 0;">
                            <div class="empty-icon">⚠️</div>
                            <div class="empty-title">Calculation Failed</div>
                            <div class="empty-description">${escapeHtml(err.message || 'Failed to calculate interest')}</div>
                            <button type="button" class="btn btn-secondary btn-small" id="btn-calc-retry" style="margin-top: var(--space-sm);">↻ Try Again</button>
                        </div>`;
                    document.getElementById('btn-calc-retry')?.addEventListener('click', performInterestCalculation);
                } finally {
                    calcBtn.disabled = false;
                    calcBtn.textContent = '📊 Calculate Interest';
                }
            }

            calcForm?.addEventListener('submit', (e) => {
                e.preventDefault();
                performInterestCalculation();
            });

        } catch (err) {
            const is404 = err.message.toLowerCase().includes('not found') || err.message.includes('404');
            document.getElementById('page-account').innerHTML = `
                <button class="back-btn" id="bae">← Accounts</button>
                <div class="empty-state">
                    <div class="empty-icon">${is404 ? '🔍' : '⚠️'}</div>
                    <div class="empty-title">${is404 ? 'Account Not Found' : 'Error Loading Account'}</div>
                    <div class="empty-description">${is404 ? `No account exists with ID #${accountId}.` : escapeHtml(err.message)}</div>
                    ${is404 
                        ? `<button class="empty-action" id="btn-back-list">Back to Accounts List</button>`
                        : `<button class="empty-action" id="btn-retry-acc">↻ Retry</button>`
                    }
                </div>`;
            document.getElementById('bae')?.addEventListener('click', () => navigate('accounts'));
            document.getElementById('btn-back-list')?.addEventListener('click', () => navigate('accounts'));
            document.getElementById('btn-retry-acc')?.addEventListener('click', () => renderAccountDetail(params));
        }
    }

    // ═══════════════════════════════════════════════════════════
    // EDIT ACCOUNT MODAL
    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════
    // EDIT ACCOUNT MODAL (Step 3E)
    // ═══════════════════════════════════════════════════════════
    function openEditAccountModal(acc) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2 class="modal-title">Edit Account #${String(acc.id).padStart(3, '0')}</h2>
                    <button class="modal-close" id="ea-close" aria-label="Close">✕</button>
                </div>
                <form id="ea-form" novalidate>
                    <div class="form-row">
                        <div class="form-group form-group-grow">
                            <label class="form-label">Account ID</label>
                            <input type="text" class="form-input" value="Account #${String(acc.id).padStart(3, '0')}" disabled>
                        </div>
                        <div class="form-group form-group-grow">
                            <label class="form-label">Person</label>
                            <input type="text" class="form-input" value="${escapeHtml(acc.person_name)}" disabled>
                        </div>
                    </div>

                    <div class="form-row">
                        <div class="form-group form-group-grow">
                            <label class="form-label">Direction</label>
                            <input type="text" class="form-input" value="${directionHumanLabel(acc.direction)}" disabled>
                        </div>
                        <div class="form-group form-group-grow">
                            <label class="form-label">Original Principal</label>
                            <input type="text" class="form-input" value="${formatRupees(acc.principal)}" disabled>
                        </div>
                    </div>
                    <div class="form-hint" style="margin-top:-8px;margin-bottom:16px">Account ID, Person, Direction, and Original Principal are locked to protect financial history.</div>

                    <div class="form-row">
                        <div class="form-group form-group-grow">
                            <label class="form-label">Interest Rate (%) <span class="required">*</span></label>
                            <input type="number" id="ea-rate" class="form-input" value="${acc.interest_rate}" min="0" step="any">
                            <div class="form-error" id="ea-err-rate">Rate must be zero or greater</div>
                        </div>
                        <div class="form-group form-group-grow">
                            <label class="form-label">Interest Frequency</label>
                            <select id="ea-frequency" class="form-input">
                                <option value="DAILY" ${acc.interest_frequency === 'DAILY' ? 'selected' : ''}>Daily</option>
                                <option value="WEEKLY" ${acc.interest_frequency === 'WEEKLY' ? 'selected' : ''}>Weekly</option>
                                <option value="MONTHLY" ${acc.interest_frequency === 'MONTHLY' ? 'selected' : ''}>Monthly</option>
                                <option value="YEARLY" ${acc.interest_frequency === 'YEARLY' ? 'selected' : ''}>Yearly</option>
                            </select>
                        </div>
                    </div>

                    <div class="form-row">
                        <div class="form-group form-group-grow">
                            <label class="form-label">Calculation Method</label>
                            <select id="ea-method" class="form-input">
                                <option value="SIMPLE_INTEREST" selected>Simple Interest</option>
                            </select>
                        </div>
                        <div class="form-group form-group-grow">
                            <label class="form-label">Status</label>
                            <select id="ea-status" class="form-input">
                                <option value="ACTIVE" ${acc.status === 'ACTIVE' ? 'selected' : ''}>Active</option>
                                <option value="PARTIALLY_PAID" ${acc.status === 'PARTIALLY_PAID' ? 'selected' : ''}>Partially Paid</option>
                                <option value="OVERDUE" ${acc.status === 'OVERDUE' ? 'selected' : ''}>Overdue</option>
                                <option value="CLOSED" ${acc.status === 'CLOSED' ? 'selected' : ''}>Closed</option>
                                <option value="WRITTEN_OFF" ${acc.status === 'WRITTEN_OFF' ? 'selected' : ''}>Written Off</option>
                            </select>
                        </div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Due Date (DD/MM/YYYY) <span class="required">*</span></label>
                        <input type="text" id="ea-due" class="form-input" value="${isoToDMY(acc.due_date)}" maxlength="10">
                        <div class="form-error" id="ea-err-due">Due date must be on or after start date (${formatDateDMY(acc.start_date)})</div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Notes</label>
                        <textarea id="ea-notes" class="form-textarea" rows="2">${acc.notes ? escapeHtml(acc.notes) : ''}</textarea>
                    </div>

                    <div class="form-actions">
                        <button type="button" class="btn btn-secondary" id="ea-cancel">Cancel</button>
                        <button type="submit" class="btn btn-primary" id="ea-save">Save Changes</button>
                    </div>
                </form>
            </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        document.getElementById('ea-close').addEventListener('click', close);
        document.getElementById('ea-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        document.getElementById('ea-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (isSaving) return;

            const rateVal = document.getElementById('ea-rate').value;
            const rate = Number(rateVal);
            const dueVal = document.getElementById('ea-due').value;
            const dueISO = dmyToISO(dueVal);

            // Validation
            let valid = true;
            document.getElementById('ea-err-rate').classList.remove('visible');
            document.getElementById('ea-err-due').classList.remove('visible');

            if (rateVal === '' || isNaN(rate) || rate < 0) {
                document.getElementById('ea-err-rate').classList.add('visible');
                valid = false;
            }
            if (!dueVal || !isValidDMY(dueVal) || dueISO < acc.start_date) {
                document.getElementById('ea-err-due').classList.add('visible');
                valid = false;
            }
            if (!valid) return;

            // Confirmation before save
            const confirmed = window.confirm(`Save changes to Account #${String(acc.id).padStart(3, '0')}?`);
            if (!confirmed) return;

            const saveBtn = document.getElementById('ea-save');
            isSaving = true; saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

            try {
                await apiPut(`/api/accounts/${acc.id}`, {
                    interest_rate: rate,
                    interest_frequency: document.getElementById('ea-frequency').value,
                    calculation_method: document.getElementById('ea-method').value,
                    due_date: dueISO,
                    notes: document.getElementById('ea-notes').value.trim(),
                    status: document.getElementById('ea-status').value
                });
                showToast(`Account #${String(acc.id).padStart(3, '0')} updated successfully`);
                close();
                renderAccountDetail({ id: acc.id });
            } catch (err) {
                showToast(err.message, 'error', 5000);
                saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
            } finally { isSaving = false; }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // RECORD FUNDING MODAL (Step 4B)
    // ═══════════════════════════════════════════════════════════
    function openRecordFundingModal(acc) {
        const isGiven = acc.direction === 'MONEY_GIVEN';
        const txType = isGiven ? 'MONEY_LENT' : 'MONEY_RECEIVED';
        const txTypeLabel = isGiven ? 'Money Lent' : 'Money Received';
        const defaultRupees = acc.principal / 100;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <h2 class="modal-title">Record Initial Funding — Account #${String(acc.id).padStart(3, '0')}</h2>
                    <button class="modal-close" id="rf-close" aria-label="Close">✕</button>
                </div>

                <!-- STEP 1: Form -->
                <div id="rf-step-form">
                    <form id="rf-form" novalidate>
                        <div class="preview-card" style="margin-bottom:16px">
                            <div class="preview-row"><span class="preview-label">Account</span><span class="preview-value">Account #${String(acc.id).padStart(3, '0')} (${escapeHtml(acc.person_name)})</span></div>
                            <div class="preview-row"><span class="preview-label">Direction</span><span class="preview-value"><span class="badge ${isGiven ? 'badge-given' : 'badge-taken'}">${directionHumanLabel(acc.direction)}</span></span></div>
                            <div class="preview-row"><span class="preview-label">Original Principal</span><span class="preview-value" style="font-weight:700">${formatRupees(acc.principal)}</span></div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Transaction Type</label>
                                <input type="text" class="form-input" value="${txTypeLabel} (${txType})" disabled>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Amount (₹) <span class="required">*</span></label>
                                <input type="number" id="rf-amount" class="form-input" value="${defaultRupees}" min="1" max="${defaultRupees}" step="any">
                                <div class="form-error" id="rf-err-amount">Amount must be > 0 and ≤ original principal (${formatRupees(acc.principal)})</div>
                            </div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Method <span class="required">*</span></label>
                                <select id="rf-method" class="form-input">
                                    <option value="CASH" selected>Cash</option>
                                    <option value="UPI">UPI</option>
                                    <option value="BANK_TRANSFER">Bank Transfer</option>
                                    <option value="OTHER">Other</option>
                                </select>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Transaction Date (DD/MM/YYYY) <span class="required">*</span></label>
                                <input type="text" id="rf-date" class="form-input" value="${isoToDMY(acc.start_date)}" maxlength="10">
                                <div class="form-error" id="rf-err-date">Valid date required (DD/MM/YYYY)</div>
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Reference / UTR #</label>
                            <input type="text" id="rf-ref" class="form-input" placeholder="e.g. UPI/1234567890 or Bank Txn #">
                        </div>

                        <div class="form-group">
                            <label class="form-label">Notes</label>
                            <textarea id="rf-notes" class="form-textarea" rows="2" placeholder="Optional notes for this money movement"></textarea>
                        </div>

                        <div class="form-actions">
                            <button type="button" class="btn btn-secondary" id="rf-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary" id="rf-next">Preview →</button>
                        </div>
                    </form>
                </div>

                <!-- STEP 2: Preview & Confirm -->
                <div id="rf-step-preview" style="display:none">
                    <div id="rf-preview-content"></div>
                    <div class="form-actions" style="margin-top:20px">
                        <button type="button" class="btn btn-secondary" id="rf-back">← Back</button>
                        <button type="button" class="btn btn-primary" id="rf-confirm">✓ Confirm & Save</button>
                    </div>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        document.getElementById('rf-close').addEventListener('click', close);
        document.getElementById('rf-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        let pendingData = null;

        document.getElementById('rf-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const amt = Number(document.getElementById('rf-amount').value);
            const dateVal = document.getElementById('rf-date').value;

            let valid = true;
            document.getElementById('rf-err-amount').classList.remove('visible');
            document.getElementById('rf-err-date').classList.remove('visible');

            if (isNaN(amt) || amt <= 0 || amt > defaultRupees) {
                document.getElementById('rf-err-amount').classList.add('visible');
                valid = false;
            }
            if (!dateVal || !isValidDMY(dateVal)) {
                document.getElementById('rf-err-date').classList.add('visible');
                valid = false;
            }
            if (!valid) return;

            pendingData = {
                account_id: acc.id,
                person_id: acc.person_id,
                transaction_type: txType,
                amount: amt,
                payment_method: document.getElementById('rf-method').value,
                transaction_date: dmyToISO(dateVal),
                reference: document.getElementById('rf-ref').value.trim(),
                notes: document.getElementById('rf-notes').value.trim()
            };

            document.getElementById('rf-step-form').style.display = 'none';
            document.getElementById('rf-step-preview').style.display = '';
            document.getElementById('rf-preview-content').innerHTML = `
                <div class="preview-card">
                    <div class="preview-title">Review Transaction Details</div>
                    <div class="preview-row"><span class="preview-label">Person</span><span class="preview-value">${escapeHtml(acc.person_name)}</span></div>
                    <div class="preview-row"><span class="preview-label">Account</span><span class="preview-value">Account #${String(acc.id).padStart(3, '0')}</span></div>
                    <div class="preview-row"><span class="preview-label">Transaction Type</span><span class="preview-value"><span class="badge ${isGiven ? 'badge-given' : 'badge-taken'}">${txTypeLabel}</span></span></div>
                    <div class="preview-row"><span class="preview-label">Amount</span><span class="preview-value" style="font-weight:700;font-size:1.125rem">${formatRupees(amt * 100)}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Method</span><span class="preview-value">${pendingData.payment_method.replace('_', ' ')}</span></div>
                    <div class="preview-row"><span class="preview-label">Transaction Date</span><span class="preview-value">${formatDateDMY(pendingData.transaction_date)}</span></div>
                    ${pendingData.reference ? `<div class="preview-row"><span class="preview-label">Reference</span><span class="preview-value">${escapeHtml(pendingData.reference)}</span></div>` : ''}
                    ${pendingData.notes ? `<div class="preview-row"><span class="preview-label">Notes</span><span class="preview-value">${escapeHtml(pendingData.notes)}</span></div>` : ''}
                </div>
            `;
        });

        document.getElementById('rf-back').addEventListener('click', () => {
            document.getElementById('rf-step-preview').style.display = 'none';
            document.getElementById('rf-step-form').style.display = '';
        });

        document.getElementById('rf-confirm').addEventListener('click', async () => {
            if (!pendingData || isSaving) return;
            const confirmBtn = document.getElementById('rf-confirm');
            isSaving = true; confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…';

            try {
                await apiPost('/api/transactions', pendingData);
                showToast(`${txTypeLabel} transaction recorded successfully`);
                close();
                renderAccountDetail({ id: acc.id });
            } catch (err) {
                showToast(err.message, 'error', 5000);
                confirmBtn.disabled = false; confirmBtn.textContent = '✓ Confirm & Save';
            } finally { isSaving = false; }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // RECORD INTEREST PAYMENT MODAL (Step 4C)
    // ═══════════════════════════════════════════════════════════
    function openRecordInterestPaymentModal(acc) {
        if (acc.direction !== 'MONEY_GIVEN') {
            showToast('Interest Received payment is only allowed for Money Lent (MONEY_GIVEN) accounts', 'warning');
            return;
        }

        const todayDMY = isoToDMY(getTodayISO());
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <h2 class="modal-title">Record Interest Payment — Account #${String(acc.id).padStart(3, '0')}</h2>
                    <button class="modal-close" id="rip-close" aria-label="Close">✕</button>
                </div>

                <!-- STEP 1: Form -->
                <div id="rip-step-form">
                    <form id="rip-form" novalidate>
                        <div class="preview-card" style="margin-bottom:16px">
                            <div class="preview-row"><span class="preview-label">Account</span><span class="preview-value">Account #${String(acc.id).padStart(3, '0')} (${escapeHtml(acc.person_name)})</span></div>
                            <div class="preview-row"><span class="preview-label">Outstanding Principal</span><span class="preview-value" style="font-weight:700">${formatRupees(acc.outstanding_principal)}</span></div>
                            <div class="preview-row"><span class="preview-label">Interest Rate</span><span class="preview-value">${acc.interest_rate}% / ${acc.interest_frequency ? acc.interest_frequency.toLowerCase() : 'month'}</span></div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Type</label>
                                <input type="text" class="form-input" value="Interest Received (INTEREST_RECEIVED)" disabled>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Interest Amount (₹) <span class="required">*</span></label>
                                <input type="number" id="rip-amount" class="form-input" placeholder="e.g. 300" min="1" step="any">
                                <div class="form-error" id="rip-err-amount">Payment amount must be greater than zero</div>
                            </div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Method <span class="required">*</span></label>
                                <select id="rip-method" class="form-input">
                                    <option value="CASH" selected>Cash</option>
                                    <option value="UPI">UPI</option>
                                    <option value="BANK_TRANSFER">Bank Transfer</option>
                                    <option value="OTHER">Other</option>
                                </select>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Date (DD/MM/YYYY) <span class="required">*</span></label>
                                <input type="text" id="rip-date" class="form-input" value="${todayDMY}" maxlength="10">
                                <div class="form-error" id="rip-err-date">Valid payment date required (DD/MM/YYYY)</div>
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Reference / Receipt #</label>
                            <input type="text" id="rip-ref" class="form-input" placeholder="e.g. UPI/99887766 or Receipt #001">
                        </div>

                        <div class="form-group">
                            <label class="form-label">Notes</label>
                            <textarea id="rip-notes" class="form-textarea" rows="2" placeholder="Optional notes for this interest payment"></textarea>
                        </div>

                        <div class="form-actions">
                            <button type="button" class="btn btn-secondary" id="rip-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary" id="rip-next">Preview →</button>
                        </div>
                    </form>
                </div>

                <!-- STEP 2: Preview & Confirm -->
                <div id="rip-step-preview" style="display:none">
                    <div id="rip-preview-content"></div>
                    <div class="form-actions" style="margin-top:20px">
                        <button type="button" class="btn btn-secondary" id="rip-back">← Back</button>
                        <button type="button" class="btn btn-primary" id="rip-confirm">✓ Confirm & Save</button>
                    </div>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        document.getElementById('rip-close').addEventListener('click', close);
        document.getElementById('rip-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        let pendingData = null;

        document.getElementById('rip-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const amt = Number(document.getElementById('rip-amount').value);
            const dateVal = document.getElementById('rip-date').value;

            let valid = true;
            document.getElementById('rip-err-amount').classList.remove('visible');
            document.getElementById('rip-err-date').classList.remove('visible');

            if (isNaN(amt) || amt <= 0) {
                document.getElementById('rip-err-amount').classList.add('visible');
                valid = false;
            }
            if (!dateVal || !isValidDMY(dateVal)) {
                document.getElementById('rip-err-date').classList.add('visible');
                valid = false;
            }
            if (!valid) return;

            pendingData = {
                account_id: acc.id,
                person_id: acc.person_id,
                transaction_type: 'INTEREST_RECEIVED',
                amount: amt,
                payment_method: document.getElementById('rip-method').value,
                transaction_date: dmyToISO(dateVal),
                reference: document.getElementById('rip-ref').value.trim(),
                notes: document.getElementById('rip-notes').value.trim()
            };

            document.getElementById('rip-step-form').style.display = 'none';
            document.getElementById('rip-step-preview').style.display = '';
            document.getElementById('rip-preview-content').innerHTML = `
                <div class="preview-card">
                    <div class="preview-title">Review Interest Payment Details</div>
                    <div class="preview-row"><span class="preview-label">Person</span><span class="preview-value">${escapeHtml(acc.person_name)}</span></div>
                    <div class="preview-row"><span class="preview-label">Account</span><span class="preview-value">Account #${String(acc.id).padStart(3, '0')}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Type</span><span class="preview-value"><span class="badge badge-given">Interest Received</span></span></div>
                    <div class="preview-row"><span class="preview-label">Amount</span><span class="preview-value" style="font-weight:700;font-size:1.125rem">${formatRupees(amt * 100)}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Method</span><span class="preview-value">${pendingData.payment_method.replace('_', ' ')}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Date</span><span class="preview-value">${formatDateDMY(pendingData.transaction_date)}</span></div>
                    ${pendingData.reference ? `<div class="preview-row"><span class="preview-label">Reference</span><span class="preview-value">${escapeHtml(pendingData.reference)}</span></div>` : ''}
                    ${pendingData.notes ? `<div class="preview-row"><span class="preview-label">Notes</span><span class="preview-value">${escapeHtml(pendingData.notes)}</span></div>` : ''}
                </div>
            `;
        });

        document.getElementById('rip-back').addEventListener('click', () => {
            document.getElementById('rip-step-preview').style.display = 'none';
            document.getElementById('rip-step-form').style.display = '';
        });

        document.getElementById('rip-confirm').addEventListener('click', async () => {
            if (!pendingData || isSaving) return;
            const confirmBtn = document.getElementById('rip-confirm');
            isSaving = true; confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…';

            try {
                await apiPost('/api/transactions', pendingData);
                showToast('Interest payment recorded successfully');
                close();
                renderAccountDetail({ id: acc.id });
            } catch (err) {
                showToast(err.message, 'error', 5000);
                confirmBtn.disabled = false; confirmBtn.textContent = '✓ Confirm & Save';
            } finally { isSaving = false; }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // RECORD PRINCIPAL PAYMENT MODAL (Step 4D)
    // ═══════════════════════════════════════════════════════════
    function openRecordPrincipalPaymentModal(acc) {
        if (acc.direction !== 'MONEY_GIVEN') {
            showToast('Principal payment is only allowed for Money Lent (MONEY_GIVEN) accounts', 'warning');
            return;
        }

        const maxRupees = acc.outstanding_principal / 100;
        if (maxRupees <= 0) {
            showToast('Account outstanding principal is already ₹0 (Account fully repaid)', 'info');
            return;
        }

        const todayDMY = isoToDMY(getTodayISO());
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <h2 class="modal-title">Record Principal Payment — Account #${String(acc.id).padStart(3, '0')}</h2>
                    <button class="modal-close" id="rpp-close" aria-label="Close">✕</button>
                </div>

                <!-- STEP 1: Form -->
                <div id="rpp-step-form">
                    <form id="rpp-form" novalidate>
                        <div class="preview-card" style="margin-bottom:16px">
                            <div class="preview-row"><span class="preview-label">Account</span><span class="preview-value">Account #${String(acc.id).padStart(3, '0')} (${escapeHtml(acc.person_name)})</span></div>
                            <div class="preview-row"><span class="preview-label">Original Principal</span><span class="preview-value">${formatRupees(acc.principal)}</span></div>
                            <div class="preview-row"><span class="preview-label">Current Outstanding</span><span class="preview-value" style="font-weight:700;color:var(--accent-color)">${formatRupees(acc.outstanding_principal)}</span></div>
                            <div class="preview-row"><span class="preview-label">Interest Rate</span><span class="preview-value">${acc.interest_rate}% / ${acc.interest_frequency ? acc.interest_frequency.toLowerCase() : 'month'}</span></div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Type</label>
                                <input type="text" class="form-input" value="Principal Received (PRINCIPAL_RECEIVED)" disabled>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Principal Amount (₹) <span class="required">*</span></label>
                                <input type="number" id="rpp-amount" class="form-input" placeholder="Max ₹${maxRupees}" min="1" max="${maxRupees}" step="any">
                                <div class="form-error" id="rpp-err-amount">Amount must be > 0 and cannot exceed current outstanding (₹${maxRupees})</div>
                            </div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Method <span class="required">*</span></label>
                                <select id="rpp-method" class="form-input">
                                    <option value="CASH" selected>Cash</option>
                                    <option value="UPI">UPI</option>
                                    <option value="BANK_TRANSFER">Bank Transfer</option>
                                    <option value="OTHER">Other</option>
                                </select>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Date (DD/MM/YYYY) <span class="required">*</span></label>
                                <input type="text" id="rpp-date" class="form-input" value="${todayDMY}" maxlength="10">
                                <div class="form-error" id="rpp-err-date">Valid payment date required (DD/MM/YYYY)</div>
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Reference / UTR / Receipt #</label>
                            <input type="text" id="rpp-ref" class="form-input" placeholder="e.g. UPI/1234567890 or Bank Ref #">
                        </div>

                        <div class="form-group">
                            <label class="form-label">Notes</label>
                            <textarea id="rpp-notes" class="form-textarea" rows="2" placeholder="Optional notes for this principal repayment"></textarea>
                        </div>

                        <div class="form-actions">
                            <button type="button" class="btn btn-secondary" id="rpp-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary" id="rpp-next">Preview →</button>
                        </div>
                    </form>
                </div>

                <!-- STEP 2: Preview & Confirm -->
                <div id="rpp-step-preview" style="display:none">
                    <div id="rpp-preview-content"></div>
                    <div class="form-actions" style="margin-top:20px">
                        <button type="button" class="btn btn-secondary" id="rpp-back">← Back</button>
                        <button type="button" class="btn btn-primary" id="rpp-confirm">✓ Confirm & Save</button>
                    </div>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        document.getElementById('rpp-close').addEventListener('click', close);
        document.getElementById('rpp-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        let pendingData = null;

        document.getElementById('rpp-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const amt = Number(document.getElementById('rpp-amount').value);
            const dateVal = document.getElementById('rpp-date').value;

            let valid = true;
            document.getElementById('rpp-err-amount').classList.remove('visible');
            document.getElementById('rpp-err-date').classList.remove('visible');

            if (isNaN(amt) || amt <= 0 || amt > maxRupees) {
                document.getElementById('rpp-err-amount').classList.add('visible');
                valid = false;
            }
            if (!dateVal || !isValidDMY(dateVal)) {
                document.getElementById('rpp-err-date').classList.add('visible');
                valid = false;
            }
            if (!valid) return;

            const remainingRupees = maxRupees - amt;

            pendingData = {
                account_id: acc.id,
                person_id: acc.person_id,
                transaction_type: 'PRINCIPAL_RECEIVED',
                amount: amt,
                payment_method: document.getElementById('rpp-method').value,
                transaction_date: dmyToISO(dateVal),
                reference: document.getElementById('rpp-ref').value.trim(),
                notes: document.getElementById('rpp-notes').value.trim()
            };

            document.getElementById('rpp-step-form').style.display = 'none';
            document.getElementById('rpp-step-preview').style.display = '';
            document.getElementById('rpp-preview-content').innerHTML = `
                <div class="preview-card">
                    <div class="preview-title">Review Principal Payment Details</div>
                    <div class="preview-row"><span class="preview-label">Person</span><span class="preview-value">${escapeHtml(acc.person_name)}</span></div>
                    <div class="preview-row"><span class="preview-label">Account</span><span class="preview-value">Account #${String(acc.id).padStart(3, '0')}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Type</span><span class="preview-value"><span class="badge badge-given">Principal Received</span></span></div>
                    <div class="preview-row"><span class="preview-label">Current Outstanding</span><span class="preview-value">${formatRupees(acc.outstanding_principal)}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Amount</span><span class="preview-value" style="font-weight:700;font-size:1.125rem;color:var(--success-color)">${formatRupees(amt * 100)}</span></div>
                    <div class="preview-row"><span class="preview-label">Remaining Outstanding</span><span class="preview-value" style="font-weight:700">${formatRupees(remainingRupees * 100)}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Method</span><span class="preview-value">${pendingData.payment_method.replace('_', ' ')}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Date</span><span class="preview-value">${formatDateDMY(pendingData.transaction_date)}</span></div>
                    ${pendingData.reference ? `<div class="preview-row"><span class="preview-label">Reference</span><span class="preview-value">${escapeHtml(pendingData.reference)}</span></div>` : ''}
                    ${pendingData.notes ? `<div class="preview-row"><span class="preview-label">Notes</span><span class="preview-value">${escapeHtml(pendingData.notes)}</span></div>` : ''}
                </div>
            `;
        });

        document.getElementById('rpp-back').addEventListener('click', () => {
            document.getElementById('rpp-step-preview').style.display = 'none';
            document.getElementById('rpp-step-form').style.display = '';
        });

        document.getElementById('rpp-confirm').addEventListener('click', async () => {
            if (!pendingData || isSaving) return;
            const confirmBtn = document.getElementById('rpp-confirm');
            isSaving = true; confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…';

            try {
                await apiPost('/api/transactions', pendingData);
                showToast('Principal payment recorded successfully');
                close();
                renderAccountDetail({ id: acc.id });
            } catch (err) {
                showToast(err.message, 'error', 5000);
                confirmBtn.disabled = false; confirmBtn.textContent = '✓ Confirm & Save';
            } finally { isSaving = false; }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // PAYMENT ALLOCATION MODAL (Step 4E)
    // ═══════════════════════════════════════════════════════════
    function openPaymentAllocationModal(acc) {
        if (acc.direction !== 'MONEY_GIVEN') {
            showToast('Payment allocation is only supported for Money Lent (MONEY_GIVEN) accounts', 'warning');
            return;
        }

        const maxPrincipalRupees = acc.outstanding_principal / 100;
        const todayDMY = isoToDMY(getTodayISO());
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <h2 class="modal-title">Record Payment Allocation — Account #${String(acc.id).padStart(3, '0')}</h2>
                    <button class="modal-close" id="pa-close" aria-label="Close">✕</button>
                </div>

                <!-- STEP 1: Form -->
                <div id="pa-step-form">
                    <form id="pa-form" novalidate>
                        <div class="preview-card" style="margin-bottom:16px">
                            <div class="preview-row"><span class="preview-label">Account</span><span class="preview-value">Account #${String(acc.id).padStart(3, '0')} (${escapeHtml(acc.person_name)})</span></div>
                            <div class="preview-row"><span class="preview-label">Original Principal</span><span class="preview-value">${formatRupees(acc.principal)}</span></div>
                            <div class="preview-row"><span class="preview-label">Current Outstanding</span><span class="preview-value" style="font-weight:700;color:var(--accent-color)">${formatRupees(acc.outstanding_principal)}</span></div>
                            <div class="preview-row"><span class="preview-label">Interest Rate</span><span class="preview-value">${acc.interest_rate}% / ${acc.interest_frequency ? acc.interest_frequency.toLowerCase() : 'month'}</span></div>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Total Payment Amount (₹) <span class="required">*</span></label>
                            <input type="number" id="pa-total" class="form-input" placeholder="e.g. 800" min="1" step="any">
                            <div class="form-error" id="pa-err-total">Total payment amount must be greater than zero</div>
                        </div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Interest Portion (₹) <span class="required">*</span></label>
                                <input type="number" id="pa-interest" class="form-input" placeholder="e.g. 300" min="0" step="any" value="0">
                                <div class="form-error" id="pa-err-interest">Interest portion must be ≥ 0</div>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Principal Portion (₹) <span class="required">*</span></label>
                                <input type="number" id="pa-principal" class="form-input" placeholder="e.g. 500" min="0" max="${maxPrincipalRupees}" step="any" value="0">
                                <div class="form-error" id="pa-err-principal">Principal portion must be ≥ 0 and ≤ current outstanding (₹${maxPrincipalRupees})</div>
                            </div>
                        </div>

                        <div class="preview-row" style="background:var(--bg-card-hover);padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:0.9rem">
                            <span class="preview-label" style="font-weight:600">Allocation Status:</span>
                            <span class="preview-value" id="pa-alloc-status" style="font-weight:700">₹0 / ₹0 allocated</span>
                        </div>
                        <div class="form-error" id="pa-err-alloc" style="margin-bottom:12px">Total payment must equal Interest Portion + Principal Portion</div>

                        <div class="form-row">
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Method <span class="required">*</span></label>
                                <select id="pa-method" class="form-input">
                                    <option value="CASH" selected>Cash</option>
                                    <option value="UPI">UPI</option>
                                    <option value="BANK_TRANSFER">Bank Transfer</option>
                                    <option value="OTHER">Other</option>
                                </select>
                            </div>
                            <div class="form-group form-group-grow">
                                <label class="form-label">Payment Date (DD/MM/YYYY) <span class="required">*</span></label>
                                <input type="text" id="pa-date" class="form-input" value="${todayDMY}" maxlength="10">
                                <div class="form-error" id="pa-err-date">Valid payment date required (DD/MM/YYYY)</div>
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Reference / UTR / Receipt #</label>
                            <input type="text" id="pa-ref" class="form-input" placeholder="e.g. UPI/1234567890 or Bank Txn #">
                        </div>

                        <div class="form-group">
                            <label class="form-label">Notes</label>
                            <textarea id="pa-notes" class="form-textarea" rows="2" placeholder="Optional notes for this payment allocation"></textarea>
                        </div>

                        <div class="form-actions">
                            <button type="button" class="btn btn-secondary" id="pa-cancel">Cancel</button>
                            <button type="submit" class="btn btn-primary" id="pa-next">Preview Allocation →</button>
                        </div>
                    </form>
                </div>

                <!-- STEP 2: Preview & Confirm -->
                <div id="pa-step-preview" style="display:none">
                    <div id="pa-preview-content"></div>
                    <div class="form-actions" style="margin-top:20px">
                        <button type="button" class="btn btn-secondary" id="pa-back">← Back</button>
                        <button type="button" class="btn btn-primary" id="pa-confirm">✓ Confirm & Save</button>
                    </div>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        document.getElementById('pa-close').addEventListener('click', close);
        document.getElementById('pa-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        const totalInput = document.getElementById('pa-total');
        const interestInput = document.getElementById('pa-interest');
        const principalInput = document.getElementById('pa-principal');
        const statusSpan = document.getElementById('pa-alloc-status');

        function updateAllocationStatus() {
            const tot = Number(totalInput.value) || 0;
            const intVal = Number(interestInput.value) || 0;
            const prinVal = Number(principalInput.value) || 0;
            const sum = intVal + prinVal;
            statusSpan.textContent = `₹${sum} allocated / ₹${tot} total`;
            if (tot > 0 && Math.abs(sum - tot) < 0.001) {
                statusSpan.style.color = 'var(--success-color)';
            } else {
                statusSpan.style.color = 'var(--accent-color)';
            }
        }

        totalInput.addEventListener('input', () => {
            const tot = Number(totalInput.value) || 0;
            const intVal = Number(interestInput.value) || 0;
            if (tot > 0 && intVal === 0 && Number(principalInput.value) === 0) {
                const autoPrin = Math.min(tot, maxPrincipalRupees);
                principalInput.value = autoPrin;
                interestInput.value = tot - autoPrin;
            }
            updateAllocationStatus();
        });
        interestInput.addEventListener('input', updateAllocationStatus);
        principalInput.addEventListener('input', updateAllocationStatus);

        let pendingData = null;

        document.getElementById('pa-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const tot = Number(totalInput.value);
            const intVal = Number(interestInput.value);
            const prinVal = Number(principalInput.value);
            const dateVal = document.getElementById('pa-date').value;

            let valid = true;
            document.getElementById('pa-err-total').classList.remove('visible');
            document.getElementById('pa-err-interest').classList.remove('visible');
            document.getElementById('pa-err-principal').classList.remove('visible');
            document.getElementById('pa-err-alloc').classList.remove('visible');
            document.getElementById('pa-err-date').classList.remove('visible');

            if (isNaN(tot) || tot <= 0) {
                document.getElementById('pa-err-total').classList.add('visible');
                valid = false;
            }
            if (isNaN(intVal) || intVal < 0) {
                document.getElementById('pa-err-interest').classList.add('visible');
                valid = false;
            }
            if (isNaN(prinVal) || prinVal < 0 || prinVal > maxPrincipalRupees) {
                document.getElementById('pa-err-principal').classList.add('visible');
                valid = false;
            }
            if (valid && Math.abs((intVal + prinVal) - tot) > 0.001) {
                document.getElementById('pa-err-alloc').classList.add('visible');
                valid = false;
            }
            if (!dateVal || !isValidDMY(dateVal)) {
                document.getElementById('pa-err-date').classList.add('visible');
                valid = false;
            }
            if (!valid) return;

            const remainingRupees = maxPrincipalRupees - prinVal;

            pendingData = {
                account_id: acc.id,
                total_amount: tot,
                interest_amount: intVal,
                principal_amount: prinVal,
                payment_method: document.getElementById('pa-method').value,
                payment_date: dmyToISO(dateVal),
                reference: document.getElementById('pa-ref').value.trim(),
                notes: document.getElementById('pa-notes').value.trim()
            };

            document.getElementById('pa-step-form').style.display = 'none';
            document.getElementById('pa-step-preview').style.display = '';
            document.getElementById('pa-preview-content').innerHTML = `
                <div class="preview-card">
                    <div class="preview-title">Review Payment Allocation Details</div>
                    <div class="preview-row"><span class="preview-label">Person</span><span class="preview-value">${escapeHtml(acc.person_name)}</span></div>
                    <div class="preview-row"><span class="preview-label">Account</span><span class="preview-value">Account #${String(acc.id).padStart(3, '0')}</span></div>
                    <div class="preview-row"><span class="preview-label">Total Payment</span><span class="preview-value" style="font-weight:700;font-size:1.125rem">${formatRupees(tot * 100)}</span></div>
                    <div class="preview-row"><span class="preview-label">Interest Portion</span><span class="preview-value" style="color:var(--accent-color)">${formatRupees(intVal * 100)} (INTEREST_RECEIVED)</span></div>
                    <div class="preview-row"><span class="preview-label">Principal Portion</span><span class="preview-value" style="color:var(--success-color)">${formatRupees(prinVal * 100)} (PRINCIPAL_RECEIVED)</span></div>
                    <div class="preview-row"><span class="preview-label">Current Outstanding</span><span class="preview-value">${formatRupees(acc.outstanding_principal)}</span></div>
                    <div class="preview-row"><span class="preview-label">Remaining Principal</span><span class="preview-value" style="font-weight:700">${formatRupees(remainingRupees * 100)}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Method</span><span class="preview-value">${pendingData.payment_method.replace('_', ' ')}</span></div>
                    <div class="preview-row"><span class="preview-label">Payment Date</span><span class="preview-value">${formatDateDMY(pendingData.payment_date)}</span></div>
                    ${pendingData.reference ? `<div class="preview-row"><span class="preview-label">Reference</span><span class="preview-value">${escapeHtml(pendingData.reference)}</span></div>` : ''}
                    ${pendingData.notes ? `<div class="preview-row"><span class="preview-label">Notes</span><span class="preview-value">${escapeHtml(pendingData.notes)}</span></div>` : ''}
                </div>
            `;
        });

        document.getElementById('pa-back').addEventListener('click', () => {
            document.getElementById('pa-step-preview').style.display = 'none';
            document.getElementById('pa-step-form').style.display = '';
        });

        document.getElementById('pa-confirm').addEventListener('click', async () => {
            if (!pendingData || isSaving) return;
            const confirmBtn = document.getElementById('pa-confirm');
            isSaving = true; confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…';

            try {
                await apiPost('/api/payments/allocate', pendingData);
                showToast(`Payment of ₹${pendingData.total_amount} allocated successfully`);
                close();
                renderAccountDetail({ id: acc.id });
            } catch (err) {
                showToast(err.message, 'error', 5000);
                confirmBtn.disabled = false; confirmBtn.textContent = '✓ Confirm & Save';
            } finally { isSaving = false; }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // TRANSACTIONS / LEDGER SCREEN (Step 4F)
    // ═══════════════════════════════════════════════════════════
    function getTxTypeLabel(type) {
        switch (type) {
            case 'MONEY_LENT': return 'Money Lent';
            case 'MONEY_RECEIVED': return 'Money Received';
            case 'INTEREST_RECEIVED': return 'Interest Received';
            case 'INTEREST_PAID': return 'Interest Paid';
            case 'PRINCIPAL_RECEIVED': return 'Principal Received';
            case 'PRINCIPAL_PAID': return 'Principal Paid';
            case 'EXPENSE': return 'Expense';
            case 'LOSS': return 'Loss';
            case 'OTHER': return 'Other';
            default: return type || 'Unknown';
        }
    }

    function getTxBadgeHtml(type) {
        const label = getTxTypeLabel(type);
        let cls = 'tx-badge-other';
        if (type === 'MONEY_LENT') cls = 'tx-badge-lent';
        else if (type === 'MONEY_RECEIVED') cls = 'tx-badge-received';
        else if (type === 'INTEREST_RECEIVED') cls = 'tx-badge-int-rcv';
        else if (type === 'PRINCIPAL_RECEIVED') cls = 'tx-badge-prin-rcv';
        else if (type === 'INTEREST_PAID') cls = 'tx-badge-int-paid';
        else if (type === 'PRINCIPAL_PAID') cls = 'tx-badge-prin-paid';
        return `<span class="tx-badge ${cls}">${escapeHtml(label)}</span>`;
    }

    function formatMethodLabel(m) {
        if (!m) return 'Cash';
        if (m === 'UPI') return 'UPI';
        if (m === 'BANK_TRANSFER') return 'Bank Transfer';
        return m.charAt(0) + m.slice(1).toLowerCase().replace('_', ' ');
    }

    function openTransactionDetailModal(tx) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content modal-wide">
                <div class="modal-header">
                    <h2 class="modal-title">Transaction #${String(tx.id).padStart(3, '0')}</h2>
                    <button class="modal-close" id="txd-close" aria-label="Close">✕</button>
                </div>

                <div class="preview-card" style="margin-bottom:16px">
                    <div class="preview-row">
                        <span class="preview-label">Transaction ID</span>
                        <span class="preview-value" style="font-weight:700">#${String(tx.id).padStart(3, '0')}</span>
                    </div>
                    <div class="preview-row">
                        <span class="preview-label">Person</span>
                        <span class="preview-value"><a href="#/person/${tx.person_id}" class="link" id="txd-person-link">${escapeHtml(tx.person_name)}</a></span>
                    </div>
                    <div class="preview-row">
                        <span class="preview-label">Account</span>
                        <span class="preview-value">${tx.account_id ? `<a href="#/account/${tx.account_id}" class="link" id="txd-account-link">Account #${String(tx.account_id).padStart(3, '0')}</a>` : '<span class="muted">Account unavailable</span>'}</span>
                    </div>
                    <div class="preview-row">
                        <span class="preview-label">Transaction Type</span>
                        <span class="preview-value">${getTxBadgeHtml(tx.transaction_type)}</span>
                    </div>
                    <div class="preview-row">
                        <span class="preview-label">Amount</span>
                        <span class="preview-value" style="font-weight:700;font-size:1.25rem">${formatRupees(tx.amount)}</span>
                    </div>
                    <div class="preview-row">
                        <span class="preview-label">Payment Method</span>
                        <span class="preview-value">${formatMethodLabel(tx.payment_method)}</span>
                    </div>
                    <div class="preview-row">
                        <span class="preview-label">Transaction Date</span>
                        <span class="preview-value">${formatDateDMY(tx.transaction_date)}</span>
                    </div>
                    ${tx.payment_id ? `
                    <div class="preview-row">
                        <span class="preview-label">Payment Event ID</span>
                        <span class="preview-value"><span class="group-badge">${escapeHtml(tx.payment_id)}</span></span>
                    </div>` : ''}
                    <div class="preview-row">
                        <span class="preview-label">Reference / UTR</span>
                        <span class="preview-value ${tx.reference ? '' : 'muted'}">${tx.reference ? escapeHtml(tx.reference) : 'None'}</span>
                    </div>
                    <div class="preview-row">
                        <span class="preview-label">Notes</span>
                        <span class="preview-value ${tx.notes ? '' : 'muted'}">${tx.notes ? escapeHtml(tx.notes) : 'None'}</span>
                    </div>
                    <div class="preview-row">
                        <span class="preview-label">Created At</span>
                        <span class="preview-value muted">${tx.created_at ? tx.created_at : '—'}</span>
                    </div>
                </div>

                <div style="font-size:var(--font-xs);color:var(--text-muted);text-align:center;margin-bottom:16px">
                    🔒 Financial transaction records are immutable. Editing and deletion are disabled.
                </div>

                <div class="form-actions">
                    <button type="button" class="btn btn-primary" id="txd-ok-btn" style="width:100%">Close</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        document.getElementById('txd-close').addEventListener('click', close);
        document.getElementById('txd-ok-btn').addEventListener('click', close);
        document.getElementById('txd-person-link')?.addEventListener('click', () => { close(); navigate('person', { id: tx.person_id }); });
        document.getElementById('txd-account-link')?.addEventListener('click', () => { close(); navigate('account', { id: tx.account_id }); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }

    async function renderTransactions(params = {}) {
        mainContent.innerHTML = `
            <div class="page" id="page-transactions">
                <div class="ledger-header">
                    <div>
                        <h2 class="page-title">Transaction Ledger</h2>
                        <p class="page-subtitle">Complete historical record of all financial movements</p>
                    </div>
                </div>

                <!-- Filter Card -->
                <div class="ledger-filter-card">
                    <div class="filter-grid">
                        <div class="filter-group">
                            <label class="filter-label">Search</label>
                            <input type="text" id="tx-search" class="filter-input" placeholder="Search person, #acc, ref, id…">
                        </div>
                        <div class="filter-group">
                            <label class="filter-label">Person</label>
                            <select id="tx-filter-person" class="filter-select">
                                <option value="">All People</option>
                            </select>
                        </div>
                        <div class="filter-group">
                            <label class="filter-label">Account</label>
                            <select id="tx-filter-account" class="filter-select">
                                <option value="">All Accounts</option>
                            </select>
                        </div>
                        <div class="filter-group">
                            <label class="filter-label">Type</label>
                            <select id="tx-filter-type" class="filter-select">
                                <option value="">All Types</option>
                                <option value="MONEY_LENT">Money Lent</option>
                                <option value="MONEY_RECEIVED">Money Received</option>
                                <option value="INTEREST_RECEIVED">Interest Received</option>
                                <option value="INTEREST_PAID">Interest Paid</option>
                                <option value="PRINCIPAL_RECEIVED">Principal Received</option>
                                <option value="PRINCIPAL_PAID">Principal Paid</option>
                                <option value="EXPENSE">Expense</option>
                                <option value="LOSS">Loss</option>
                                <option value="OTHER">Other</option>
                            </select>
                        </div>
                        <div class="filter-group">
                            <label class="filter-label">Method</label>
                            <select id="tx-filter-method" class="filter-select">
                                <option value="">All Methods</option>
                                <option value="CASH">Cash</option>
                                <option value="UPI">UPI</option>
                                <option value="BANK_TRANSFER">Bank Transfer</option>
                                <option value="OTHER">Other</option>
                            </select>
                        </div>
                        <div class="filter-group">
                            <label class="filter-label">From Date</label>
                            <input type="date" id="tx-filter-from" class="filter-input">
                        </div>
                        <div class="filter-group">
                            <label class="filter-label">To Date</label>
                            <input type="date" id="tx-filter-to" class="filter-input">
                        </div>
                        <div class="filter-group">
                            <label class="filter-label">Sort</label>
                            <select id="tx-filter-sort" class="filter-select">
                                <option value="newest" selected>Newest First</option>
                                <option value="oldest">Oldest First</option>
                                <option value="amount_desc">Amount (High to Low)</option>
                                <option value="amount_asc">Amount (Low to High)</option>
                            </select>
                        </div>
                    </div>
                    <div class="filter-actions">
                        <span id="tx-results-count">Loading transactions…</span>
                        <button type="button" class="btn btn-secondary btn-small" id="tx-reset-filters">Reset Filters</button>
                    </div>
                </div>

                <!-- Ledger Content Area -->
                <div id="tx-content-area">
                    <div class="loading-state"><div class="spinner"></div><p>Loading ledger…</p></div>
                </div>
            </div>
        `;

        // Prepopulate dropdowns
        try {
            const [{ data: people }, { data: accounts }] = await Promise.all([
                apiGet('/api/people'),
                apiGet('/api/accounts')
            ]);

            const personSelect = document.getElementById('tx-filter-person');
            if (personSelect) {
                (people || []).forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name;
                    personSelect.appendChild(opt);
                });
            }

            const accountSelect = document.getElementById('tx-filter-account');
            if (accountSelect) {
                (accounts || []).forEach(a => {
                    const opt = document.createElement('option');
                    opt.value = a.id;
                    opt.textContent = `Account #${String(a.id).padStart(3, '0')} (${a.person_name} - ${formatRupees(a.principal)})`;
                    accountSelect.appendChild(opt);
                });
            }
        } catch (err) {
            console.warn('Could not populate filter dropdowns:', err);
        }

        // Apply initial params if present
        if (params.person_id) document.getElementById('tx-filter-person').value = params.person_id;
        if (params.account_id) document.getElementById('tx-filter-account').value = params.account_id;
        if (params.transaction_type) document.getElementById('tx-filter-type').value = params.transaction_type;
        if (params.payment_method) document.getElementById('tx-filter-method').value = params.payment_method;
        if (params.search) document.getElementById('tx-search').value = params.search;
        if (params.sort) document.getElementById('tx-filter-sort').value = params.sort;

        async function loadTransactions() {
            const contentArea = document.getElementById('tx-content-area');
            const countLabel = document.getElementById('tx-results-count');
            if (!contentArea) return;

            contentArea.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading ledger…</p></div>`;

            const search = document.getElementById('tx-search')?.value.trim();
            const personId = document.getElementById('tx-filter-person')?.value;
            const accountId = document.getElementById('tx-filter-account')?.value;
            const txType = document.getElementById('tx-filter-type')?.value;
            const method = document.getElementById('tx-filter-method')?.value;
            const fromDate = document.getElementById('tx-filter-from')?.value;
            const toDate = document.getElementById('tx-filter-to')?.value;
            const sort = document.getElementById('tx-filter-sort')?.value;

            const qParams = new URLSearchParams();
            if (search) qParams.set('search', search);
            if (personId) qParams.set('person_id', personId);
            if (accountId) qParams.set('account_id', accountId);
            if (txType) qParams.set('transaction_type', txType);
            if (method) qParams.set('payment_method', method);
            if (fromDate) qParams.set('start_date', fromDate);
            if (toDate) qParams.set('end_date', toDate);
            if (sort) qParams.set('sort', sort);

            try {
                const res = await apiGet(`/api/transactions?${qParams.toString()}`);
                const txs = res.data || [];

                if (countLabel) {
                    const totalPaisa = txs.reduce((sum, t) => sum + (t.amount || 0), 0);
                    countLabel.textContent = `Showing ${txs.length} transaction${txs.length === 1 ? '' : 's'} · Total Volume: ${formatRupees(totalPaisa)}`;
                }

                if (txs.length === 0) {
                    contentArea.innerHTML = `
                        <div class="empty-state" style="padding:48px 24px">
                            <div class="empty-icon">📜</div>
                            <div class="empty-title">No transactions yet</div>
                            <div class="empty-description">No financial records match your selected filters.</div>
                            <div style="margin-top:16px;display:flex;gap:12px;justify-content:center">
                                <button class="btn btn-secondary btn-small" id="tx-empty-reset">Clear Filters</button>
                                <button class="btn btn-primary btn-small" id="tx-empty-accounts">Go to Accounts</button>
                            </div>
                        </div>
                    `;
                    document.getElementById('tx-empty-reset')?.addEventListener('click', resetFilters);
                    document.getElementById('tx-empty-accounts')?.addEventListener('click', () => navigate('accounts'));
                    return;
                }

                // Table for Desktop + Cards for Mobile
                contentArea.innerHTML = `
                    <div class="ledger-table-wrapper">
                        <table class="ledger-table">
                            <thead>
                                <tr>
                                    <th>Date</th>
                                    <th>ID</th>
                                    <th>Person</th>
                                    <th>Account</th>
                                    <th>Type</th>
                                    <th style="text-align:right">Amount</th>
                                    <th>Method</th>
                                    <th>Reference / Group</th>
                                    <th style="text-align:center">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${txs.map(tx => `
                                    <tr data-tx-id="${tx.id}">
                                        <td><strong>${formatDateDMY(tx.transaction_date)}</strong></td>
                                        <td><span class="muted">#${String(tx.id).padStart(3, '0')}</span></td>
                                        <td><strong>${escapeHtml(tx.person_name)}</strong></td>
                                        <td>${tx.account_id ? `Account #${String(tx.account_id).padStart(3, '0')}` : '<span class="muted">Account unavailable</span>'}</td>
                                        <td>${getTxBadgeHtml(tx.transaction_type)}</td>
                                        <td style="text-align:right"><span class="tx-amount">${formatRupees(tx.amount)}</span></td>
                                        <td>${formatMethodLabel(tx.payment_method)}</td>
                                        <td>
                                            ${tx.reference ? `<span>${escapeHtml(tx.reference)}</span>` : ''}
                                            ${tx.payment_id ? `<span class="group-badge" title="Part of payment event ${tx.payment_id}">🔗 ${escapeHtml(tx.payment_id)}</span>` : ''}
                                            ${!tx.reference && !tx.payment_id ? '<span class="muted">—</span>' : ''}
                                        </td>
                                        <td style="text-align:center">
                                            <button class="btn btn-secondary btn-small tx-view-btn" data-tx-id="${tx.id}">View</button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>

                    <!-- Mobile Cards -->
                    <div class="ledger-cards">
                        ${txs.map(tx => `
                            <div class="ledger-card" data-tx-id="${tx.id}">
                                <div class="ledger-card-header">
                                    <div style="font-weight:700">${escapeHtml(tx.person_name)} · <span class="muted">#${String(tx.id).padStart(3, '0')}</span></div>
                                    <div>${formatDateDMY(tx.transaction_date)}</div>
                                </div>
                                <div>
                                    ${tx.account_id ? `Account #${String(tx.account_id).padStart(3, '0')}` : 'Account unavailable'} · ${formatMethodLabel(tx.payment_method)}
                                </div>
                                <div class="ledger-card-body">
                                    <div>${getTxBadgeHtml(tx.transaction_type)}</div>
                                    <div class="tx-amount">${formatRupees(tx.amount)}</div>
                                </div>
                                ${tx.reference || tx.payment_id ? `
                                <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">
                                    ${tx.reference ? `Ref: ${escapeHtml(tx.reference)} ` : ''}
                                    ${tx.payment_id ? `<span class="group-badge">🔗 ${escapeHtml(tx.payment_id)}</span>` : ''}
                                </div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                `;

                // Bind click events to open modal
                contentArea.querySelectorAll('[data-tx-id]').forEach(el => {
                    el.addEventListener('click', (e) => {
                        const txId = Number(el.dataset.txId);
                        const selectedTx = txs.find(t => t.id === txId);
                        if (selectedTx) openTransactionDetailModal(selectedTx);
                    });
                });

            } catch (err) {
                if (countLabel) countLabel.textContent = 'Error loading ledger';
                contentArea.innerHTML = `
                    <div class="empty-state" style="padding:48px 24px">
                        <div class="empty-icon">⚠️</div>
                        <div class="empty-title">Could not load transactions</div>
                        <div class="empty-description">${escapeHtml(err.message)}</div>
                        <div style="margin-top:16px">
                            <button class="btn btn-primary btn-small" id="tx-retry-btn">Retry</button>
                        </div>
                    </div>
                `;
                document.getElementById('tx-retry-btn')?.addEventListener('click', loadTransactions);
            }
        }

        function resetFilters() {
            document.getElementById('tx-search').value = '';
            document.getElementById('tx-filter-person').value = '';
            document.getElementById('tx-filter-account').value = '';
            document.getElementById('tx-filter-type').value = '';
            document.getElementById('tx-filter-method').value = '';
            document.getElementById('tx-filter-from').value = '';
            document.getElementById('tx-filter-to').value = '';
            document.getElementById('tx-filter-sort').value = 'newest';
            loadTransactions();
        }

        // Event listeners for filters
        let searchDebounce = null;
        document.getElementById('tx-search').addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(loadTransactions, 300);
        });
        document.getElementById('tx-filter-person').addEventListener('change', loadTransactions);
        document.getElementById('tx-filter-account').addEventListener('change', loadTransactions);
        document.getElementById('tx-filter-type').addEventListener('change', loadTransactions);
        document.getElementById('tx-filter-method').addEventListener('change', loadTransactions);
        document.getElementById('tx-filter-from').addEventListener('change', loadTransactions);
        document.getElementById('tx-filter-to').addEventListener('change', loadTransactions);
        document.getElementById('tx-filter-sort').addEventListener('change', loadTransactions);
        document.getElementById('tx-reset-filters').addEventListener('click', resetFilters);

        // Initial fetch
        loadTransactions();
    }
    async function renderDue() {
        mainContent.innerHTML = `
            <div class="page" id="page-due">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:var(--space-md); margin-bottom:var(--space-md);">
                    <div>
                        <h2 class="page-title">Due & Overdue Tracking</h2>
                        <p class="page-subtitle">Authoritative monitoring of upcoming maturities, grace periods & collection priorities</p>
                    </div>
                    <div style="display:flex; gap:var(--space-sm); flex-wrap:wrap;">
                        <a href="/api/export/report/due-overdue" class="btn btn-secondary btn-small" download>📥 Export Due/Overdue .xlsx</a>
                        <a href="/api/export/report/collections" class="btn btn-secondary btn-small" download>📥 Export Collections .xlsx</a>
                    </div>
                </div>

                <!-- KPI Cards -->
                <div class="stat-grid" id="due-stats" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: var(--space-lg);">
                    <div class="stat-card" style="border-left: 4px solid var(--accent-info, #6366f1);">
                        <div class="stat-value" id="due-kpi-count" style="color:var(--accent-info, #6366f1);">—</div>
                        <div class="stat-label">Loans Due Soon / Today</div>
                    </div>
                    <div class="stat-card" style="border-left: 4px solid var(--accent-warning, #f59e0b);">
                        <div class="stat-value" id="due-kpi-amount" style="color:var(--accent-warning, #f59e0b);">—</div>
                        <div class="stat-label">Total Due Amount</div>
                    </div>
                    <div class="stat-card" style="border-left: 4px solid var(--accent-danger, #ef4444);">
                        <div class="stat-value" id="overdue-kpi-count" style="color:var(--accent-danger, #ef4444);">—</div>
                        <div class="stat-label">Overdue Loans</div>
                    </div>
                    <div class="stat-card" style="border-left: 4px solid var(--accent-danger, #ef4444);">
                        <div class="stat-value" id="overdue-kpi-amount" style="color:var(--accent-danger, #ef4444);">—</div>
                        <div class="stat-label">Total Overdue Amount</div>
                    </div>
                </div>

                <!-- Filter Tabs -->
                <div style="display:flex; gap:var(--space-xs); margin-bottom:var(--space-md);">
                    <button class="btn btn-small due-tab-btn btn-primary" data-filter="all">All Actionable</button>
                    <button class="btn btn-small due-tab-btn btn-secondary" data-filter="overdue">Overdue Only</button>
                    <button class="btn btn-small due-tab-btn btn-secondary" data-filter="due">Due Only</button>
                </div>

                <!-- Collection Table Card -->
                <div class="card" style="padding:0; overflow:hidden;">
                    <div class="table-responsive">
                        <table class="data-table" id="table-due-items" style="width:100%; border-collapse:collapse;">
                            <thead>
                                <tr>
                                    <th>Borrower / Contact</th>
                                    <th>Loan ID</th>
                                    <th>Due Date</th>
                                    <th>Status / Days</th>
                                    <th style="text-align:right;">Outstanding Principal</th>
                                    <th style="text-align:right;">Outstanding Interest</th>
                                    <th style="text-align:right;">Total Actionable</th>
                                    <th style="text-align:center;">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="due-table-body">
                                <tr>
                                    <td colspan="8" style="text-align:center; padding:var(--space-xl); color:var(--text-muted);">
                                        Loading due & overdue collection records…
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        let activeFilter = 'all';
        let allItems = [];

        function renderTableRows() {
            const tbody = document.getElementById('due-table-body');
            if (!tbody) return;

            let filtered = allItems;
            if (activeFilter === 'overdue') {
                filtered = allItems.filter(i => (i.urgency || i.status || '').toUpperCase().includes('OVERDUE'));
            } else if (activeFilter === 'due') {
                filtered = allItems.filter(i => !(i.urgency || i.status || '').toUpperCase().includes('OVERDUE'));
            }

            if (filtered.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="8" style="text-align:center; padding:var(--space-xl); color:var(--text-muted);">
                            <div style="font-size:2rem; margin-bottom:8px;">🎉</div>
                            <div style="font-weight:600; font-size:var(--font-md); color:var(--accent-success);">No Actionable Loans Found</div>
                            <p style="font-size:var(--font-xs); margin-top:4px;">No loans match the selected filter.</p>
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = filtered.map(item => {
                const isOverdue = (item.urgency || item.status || '').toUpperCase().includes('OVERDUE');
                const badgeClass = isOverdue ? 'status-danger' : 'status-warning';
                const badgeText = isOverdue ? (item.days_overdue ? `${item.days_overdue}d Overdue` : 'OVERDUE') : 'DUE';
                const principalPaisa = item.outstanding_principal_paisa !== undefined ? item.outstanding_principal_paisa : Math.round((item.outstanding_principal || 0) * 100);
                const interestPaisa = item.outstanding_interest_paisa !== undefined ? item.outstanding_interest_paisa : Math.round((item.outstanding_interest || 0) * 100);
                const totalPaisa = item.overdue_amount_paisa !== undefined ? item.overdue_amount_paisa : Math.round((item.overdue_amount || (item.outstanding_principal + (item.outstanding_interest || 0))) * 100);

                return `
                    <tr>
                        <td>
                            <div style="font-weight:600;">${escapeHtml(item.person_name || 'Person #' + item.person_id)}</div>
                            <div style="font-size:var(--font-xs); color:var(--text-muted);">${escapeHtml(item.phone || item.person_phone || '')}</div>
                        </td>
                        <td>
                            <a href="#/account/${item.account_id || item.id}" style="color:var(--accent-primary); font-weight:600;">#${item.account_id || item.id}</a>
                        </td>
                        <td>${formatDateDMY(item.due_date)}</td>
                        <td>
                            <span class="status-badge ${badgeClass}" style="font-size:0.75rem;">${escapeHtml(badgeText)}</span>
                        </td>
                        <td style="text-align:right; font-weight:500;">${formatRupees(principalPaisa)}</td>
                        <td style="text-align:right; font-weight:500;">${formatRupees(interestPaisa)}</td>
                        <td style="text-align:right; font-weight:700; color:${isOverdue ? 'var(--accent-danger)' : 'var(--accent-warning)'};">
                            ${formatRupees(totalPaisa)}
                        </td>
                        <td style="text-align:center;">
                            <div style="display:inline-flex; gap:4px;">
                                <a href="#/statement?person_id=${item.person_id}" class="btn btn-secondary btn-small" title="Statement" style="padding:4px 8px; font-size:0.7rem;">Statement</a>
                                <a href="#/transactions" class="btn btn-primary btn-small" title="Record Payment" style="padding:4px 8px; font-size:0.7rem;">Pay</a>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        // Tab filter click handlers
        document.querySelectorAll('.due-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.due-tab-btn').forEach(b => {
                    b.classList.remove('btn-primary');
                    b.classList.add('btn-secondary');
                });
                btn.classList.remove('btn-secondary');
                btn.classList.add('btn-primary');
                activeFilter = btn.dataset.filter;
                renderTableRows();
            });
        });

        try {
            const [summaryRes, collRes] = await Promise.all([
                apiGet('/api/due-overdue/summary'),
                apiGet('/api/collections')
            ]);

            const summary = summaryRes.data || summaryRes;
            allItems = collRes.items || collRes.data || [];

            document.getElementById('due-kpi-count').textContent = summary.due_count || summary.due_loan_count || 0;
            document.getElementById('due-kpi-amount').textContent = formatRupees(summary.due_amount_paisa || Math.round((summary.due_amount || 0) * 100));
            document.getElementById('overdue-kpi-count').textContent = summary.overdue_count || summary.overdue_loan_count || 0;
            document.getElementById('overdue-kpi-amount').textContent = formatRupees(summary.overdue_amount_paisa || Math.round((summary.overdue_amount || 0) * 100));

            renderTableRows();
        } catch (err) {
            console.warn('Error loading due data:', err);
            const tbody = document.getElementById('due-table-body');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="8" style="text-align:center; padding:var(--space-lg); color:var(--accent-danger);">
                            Failed to load due records: ${escapeHtml(err.message)}
                        </td>
                    </tr>
                `;
            }
        }
    }
    function renderReports() {
        mainContent.innerHTML = `
            <div class="page" id="page-reports">
                <div style="margin-bottom:var(--space-md);">
                    <h2 class="page-title">Reports, Excel Exports & Data Recovery</h2>
                    <p class="page-subtitle">Authoritative financial reporting, spreadsheet exports (.xlsx), and full application backup/restore</p>
                </div>

                <!-- Section 1: Reports & Exports -->
                <div style="margin-bottom:var(--space-lg);">
                    <h3 style="font-size:var(--font-lg); font-weight:700; margin-bottom:var(--space-sm);">📊 Financial Reports & Spreadsheet Exports</h3>
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-md);">
                        
                        <!-- Statement -->
                        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
                            <div>
                                <div style="display:flex; align-items:center; gap:var(--space-md); margin-bottom:var(--space-xs);">
                                    <div style="font-size:2rem; background:rgba(99,102,241,0.15); padding:10px; border-radius:var(--radius-md);">📄</div>
                                    <div>
                                        <h3 style="font-size:var(--font-md); margin-bottom:2px;">Person Statement</h3>
                                        <p class="muted" style="font-size:var(--font-xs);">Ledger, opening/closing balance & interest</p>
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; gap:var(--space-xs); margin-top:var(--space-sm);">
                                <button class="btn btn-primary btn-small" id="rpt-btn-view-stmt" style="flex:1;">View & Export</button>
                            </div>
                        </div>

                        <!-- Loan Portfolio -->
                        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
                            <div>
                                <div style="display:flex; align-items:center; gap:var(--space-md); margin-bottom:var(--space-xs);">
                                    <div style="font-size:2rem; background:rgba(52,211,153,0.15); padding:10px; border-radius:var(--radius-md);">📈</div>
                                    <div>
                                        <h3 style="font-size:var(--font-md); margin-bottom:2px;">Loan Portfolio</h3>
                                        <p class="muted" style="font-size:var(--font-xs);">Principal, paid, balance & rates across loans</p>
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; gap:var(--space-xs); margin-top:var(--space-sm);">
                                <a href="/api/reports/loans/excel" class="btn btn-secondary btn-small" download style="flex:1; text-align:center;">📥 Export .xlsx</a>
                            </div>
                        </div>

                        <!-- People Directory -->
                        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
                            <div>
                                <div style="display:flex; align-items:center; gap:var(--space-md); margin-bottom:var(--space-xs);">
                                    <div style="font-size:2rem; background:rgba(59,130,246,0.15); padding:10px; border-radius:var(--radius-md);">👥</div>
                                    <div>
                                        <h3 style="font-size:var(--font-md); margin-bottom:2px;">People Directory</h3>
                                        <p class="muted" style="font-size:var(--font-xs);">Active loan counts, total given & taken</p>
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; gap:var(--space-xs); margin-top:var(--space-sm);">
                                <a href="/api/reports/people/excel" class="btn btn-secondary btn-small" download style="flex:1; text-align:center;">📥 Export .xlsx</a>
                            </div>
                        </div>

                        <!-- Transactions / Payments -->
                        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
                            <div>
                                <div style="display:flex; align-items:center; gap:var(--space-md); margin-bottom:var(--space-xs);">
                                    <div style="font-size:2rem; background:rgba(245,158,11,0.15); padding:10px; border-radius:var(--radius-md);">💳</div>
                                    <div>
                                        <h3 style="font-size:var(--font-md); margin-bottom:2px;">Transactions & Payments</h3>
                                        <p class="muted" style="font-size:var(--font-xs);">Complete historical transaction movements</p>
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; gap:var(--space-xs); margin-top:var(--space-sm);">
                                <a href="/api/reports/payments/excel" class="btn btn-secondary btn-small" download style="flex:1; text-align:center;">📥 Export .xlsx</a>
                            </div>
                        </div>

                        <!-- Interest Records -->
                        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
                            <div>
                                <div style="display:flex; align-items:center; gap:var(--space-md); margin-bottom:var(--space-xs);">
                                    <div style="font-size:2rem; background:rgba(139,92,246,0.15); padding:10px; border-radius:var(--radius-md);">⏳</div>
                                    <div>
                                        <h3 style="font-size:var(--font-md); margin-bottom:2px;">Interest Accruals</h3>
                                        <p class="muted" style="font-size:var(--font-xs);">Accrual periods, rates & paid/outstanding interest</p>
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; gap:var(--space-xs); margin-top:var(--space-sm);">
                                <a href="/api/reports/interest/excel" class="btn btn-secondary btn-small" download style="flex:1; text-align:center;">📥 Export .xlsx</a>
                            </div>
                        </div>

                        <!-- Due & Overdue -->
                        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
                            <div>
                                <div style="display:flex; align-items:center; gap:var(--space-md); margin-bottom:var(--space-xs);">
                                    <div style="font-size:2rem; background:rgba(239,68,68,0.15); padding:10px; border-radius:var(--radius-md);">🚨</div>
                                    <div>
                                        <h3 style="font-size:var(--font-md); margin-bottom:2px;">Due & Overdue</h3>
                                        <p class="muted" style="font-size:var(--font-xs);">Current deadlines, overdue days & amounts</p>
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; gap:var(--space-xs); margin-top:var(--space-sm);">
                                <a href="/api/reports/due-overdue/excel" class="btn btn-secondary btn-small" download style="flex:1; text-align:center;">📥 Export .xlsx</a>
                            </div>
                        </div>

                        <!-- Priority Collections -->
                        <div class="card" style="display:flex; flex-direction:column; justify-content:space-between;">
                            <div>
                                <div style="display:flex; align-items:center; gap:var(--space-md); margin-bottom:var(--space-xs);">
                                    <div style="font-size:2rem; background:rgba(236,72,153,0.15); padding:10px; border-radius:var(--radius-md);">🎯</div>
                                    <div>
                                        <h3 style="font-size:var(--font-md); margin-bottom:2px;">Priority Collections</h3>
                                        <p class="muted" style="font-size:var(--font-xs);">Overdue borrower contact list ordered by priority</p>
                                    </div>
                                </div>
                            </div>
                            <div style="display:flex; gap:var(--space-xs); margin-top:var(--space-sm);">
                                <a href="/api/reports/collections/excel" class="btn btn-secondary btn-small" download style="flex:1; text-align:center;">📥 Export .xlsx</a>
                            </div>
                        </div>

                    </div>
                </div>

                <!-- Section 2: Application Backup & Restore -->
                <div style="margin-top:var(--space-xl);">
                    <h3 style="font-size:var(--font-lg); font-weight:700; margin-bottom:var(--space-sm);">🛡️ Application Backup & Restore (Part 11)</h3>
                    <div class="card" style="border: 1px solid rgba(255,255,255,0.1);">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:var(--space-md); margin-bottom:var(--space-md);">
                            <div>
                                <h4 style="font-size:var(--font-md); font-weight:700; margin-bottom:4px;">Machine-Readable Application Backup</h4>
                                <p class="muted" style="font-size:var(--font-xs); max-width:600px;">
                                    Download a cryptographically verified SHA-256 JSON snapshot preserving all People, Loans, Transactions, Interest, and Configurations.
                                    Restoring a backup safely replaces current application data with rollback protection.
                                </p>
                            </div>
                            <div style="display:flex; gap:var(--space-sm); flex-wrap:wrap;">
                                <a href="/api/backup/export" class="btn btn-primary btn-small" download id="btn-download-backup">
                                    💾 Download Full Backup (.json)
                                </a>
                                <button class="btn btn-secondary btn-small" id="btn-trigger-restore" style="border-color:var(--accent-danger); color:var(--accent-danger);">
                                    ⚠️ Restore from Backup
                                </button>
                                <input type="file" id="backup-file-input" accept=".json" style="display:none;">
                            </div>
                        </div>

                        <!-- Backup Status Grid -->
                        <div id="backup-status-area" style="background:rgba(0,0,0,0.2); padding:var(--space-sm) var(--space-md); border-radius:var(--radius-sm); font-size:var(--font-xs);">
                            <span class="muted">Loading system backup status…</span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('rpt-btn-view-stmt')?.addEventListener('click', () => navigate('statement'));

        // Load Backup Status
        apiGet('/api/backup/status').then(res => {
            const statusArea = document.getElementById('backup-status-area');
            if (statusArea && res) {
                const c = res.entity_counts || {};
                statusArea.innerHTML = `
                    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:var(--space-sm); align-items:center;">
                        <div>
                            <strong>Active Database State:</strong>
                            ${c.people || 0} People · ${c.accounts || 0} Loans · ${c.transactions || 0} Transactions · ${c.interest_records || 0} Interest Records
                        </div>
                        <div class="muted">
                            Format Version: <strong>v${res.backup_format_version || 1}</strong>
                            ${res.last_restore ? ` · Last Restore: ${formatDateDMY(res.last_restore.split('T')[0])}` : ''}
                        </div>
                    </div>
                `;
            }
        }).catch(() => {});

        // Backup Restore Handler
        const fileInput = document.getElementById('backup-file-input');
        const triggerBtn = document.getElementById('btn-trigger-restore');

        triggerBtn?.addEventListener('click', () => {
            const ok = confirm(
                'CAUTION: Restoring a backup is a destructive operation that will completely replace the current application database with the backup snapshot.\n\nAre you sure you wish to proceed?'
            );
            if (ok) {
                fileInput.click();
            }
        });

        fileInput?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                let backupData;
                try {
                    backupData = JSON.parse(text);
                } catch {
                    showToast('Invalid backup file: Not valid JSON', 'error');
                    return;
                }

                showToast('Validating backup integrity…', 'info');
                const valRes = await apiPost('/api/backup/validate', { backup: backupData });
                if (!valRes.success) {
                    showToast(`Backup validation failed: ${valRes.error}`, 'error');
                    return;
                }

                const doubleConfirm = confirm(
                    `Backup package validated successfully!\n\nEntities in backup:\n` +
                    Object.entries(valRes.entity_counts || {}).map(([k, v]) => ` • ${k}: ${v}`).join('\n') +
                    `\n\nProceed to RESTORE now? This cannot be undone.`
                );

                if (doubleConfirm) {
                    showToast('Restoring application state…', 'info');
                    const restoreRes = await apiPost('/api/backup/restore', {
                        backup: backupData,
                        confirm: true
                    });

                    if (restoreRes.success) {
                        showToast('Restore completed successfully!', 'success');
                        setTimeout(() => navigate('dashboard'), 1000);
                    } else {
                        showToast(`Restore failed: ${restoreRes.error}`, 'error');
                    }
                }
            } catch (err) {
                showToast(`Restore failed: ${err.message}`, 'error');
            } finally {
                fileInput.value = '';
            }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 10G & 11G: PERSON STATEMENT + PDF & EXCEL VIEW
    // ═══════════════════════════════════════════════════════════
    async function renderPersonStatement(params = {}) {
        mainContent.innerHTML = `
            <div class="page" id="page-statement">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:var(--space-md); flex-wrap:wrap; gap:var(--space-sm);">
                    <div>
                        <h2 class="page-title">Person Statement</h2>
                        <p class="page-subtitle">Consolidated financial history, running balances, and PDF / Excel exports</p>
                    </div>
                    <div>
                        <button class="btn btn-secondary btn-small" id="stmt-back-btn">← Back</button>
                    </div>
                </div>

                <!-- Filter Controls Card -->
                <div class="card" style="margin-bottom: var(--space-md);">
                    <div class="filter-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
                        <div class="filter-group">
                            <label class="filter-label" for="stmt-person-select">Person <span class="required">*</span></label>
                            <select id="stmt-person-select" class="filter-select">
                                <option value="">— Select Person —</option>
                            </select>
                        </div>
                        <div class="filter-group">
                            <label class="filter-label" for="stmt-loan-select">Loan Account</label>
                            <select id="stmt-loan-select" class="filter-select">
                                <option value="">All Loans (Consolidated)</option>
                            </select>
                        </div>
                        <div class="filter-group">
                            <label class="filter-label" for="stmt-start-date">From Date</label>
                            <input type="date" id="stmt-start-date" class="filter-input">
                        </div>
                        <div class="filter-group">
                            <label class="filter-label" for="stmt-end-date">To Date</label>
                            <input type="date" id="stmt-end-date" class="filter-input">
                        </div>
                    </div>
                    <div class="filter-actions" style="margin-top:var(--space-sm); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:var(--space-xs);">
                        <button class="btn btn-primary btn-small" id="stmt-generate-btn">↻ Generate Statement</button>
                        <div style="display:flex; gap:var(--space-xs);">
                            <button class="btn btn-secondary btn-small" id="stmt-download-pdf-btn" disabled>📥 Download PDF</button>
                            <button class="btn btn-secondary btn-small" id="stmt-download-excel-btn" disabled>📊 Export Excel</button>
                        </div>
                    </div>
                </div>

                <!-- Statement Content Area -->
                <div id="stmt-content-area">
                    <div class="loading-state"><div class="spinner"></div><p>Loading person statement…</p></div>
                </div>
            </div>
        `;

        document.getElementById('stmt-back-btn')?.addEventListener('click', () => {
            const currentPId = document.getElementById('stmt-person-select')?.value || params.person_id;
            if (currentPId) navigate('person', { id: currentPId });
            else navigate('people');
        });

        const personSelect = document.getElementById('stmt-person-select');
        const loanSelect = document.getElementById('stmt-loan-select');
        const startDateInput = document.getElementById('stmt-start-date');
        const endDateInput = document.getElementById('stmt-end-date');
        const generateBtn = document.getElementById('stmt-generate-btn');
        const pdfBtn = document.getElementById('stmt-download-pdf-btn');
        const excelBtn = document.getElementById('stmt-download-excel-btn');
        const contentArea = document.getElementById('stmt-content-area');


        // Populate people dropdown
        let people = [];
        try {
            const pRes = await apiGet('/api/people');
            people = pRes.data || [];
            people.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = `${p.name}${p.phone ? ' (' + p.phone + ')' : ''}`;
                personSelect.appendChild(opt);
            });
        } catch (err) {
            console.error('Failed to load people for statement:', err);
        }

        // Set initial selected person
        let activePersonId = params.person_id || params.id || (people.length > 0 ? people[0].id : null);
        if (activePersonId && personSelect) {
            personSelect.value = activePersonId;
        }

        if (params.start_date) startDateInput.value = params.start_date;
        if (params.end_date) endDateInput.value = params.end_date;

        async function updateLoanDropdown(pId, selectedLoanId = null) {
            loanSelect.innerHTML = `<option value="">All Loans (Consolidated)</option>`;
            if (!pId) return;
            try {
                const aRes = await apiGet(`/api/accounts?person_id=${pId}`);
                const loans = aRes.data || [];
                loans.forEach(loan => {
                    const opt = document.createElement('option');
                    opt.value = loan.id;
                    opt.textContent = `Account #${String(loan.id).padStart(3, '0')} — ${loan.direction === 'MONEY_GIVEN' ? 'Lent' : 'Taken'} (${formatRupees(loan.principal)})`;
                    if (selectedLoanId && Number(selectedLoanId) === loan.id) opt.selected = true;
                    loanSelect.appendChild(opt);
                });
            } catch (err) {
                console.error('Failed to load accounts for statement:', err);
            }
        }

        personSelect.addEventListener('change', async () => {
            const pId = personSelect.value;
            await updateLoanDropdown(pId);
            loadStatement();
        });

        loanSelect.addEventListener('change', () => {
            loadStatement();
        });

        generateBtn.addEventListener('click', (e) => {
            e.preventDefault();
            loadStatement();
        });

        pdfBtn.addEventListener('click', () => {
            const pId = personSelect.value;
            if (!pId) return;
            const lId = loanSelect.value;
            const sDate = startDateInput.value;
            const eDate = endDateInput.value;
            const qp = new URLSearchParams();
            if (lId) qp.set('loan_id', lId);
            if (sDate) qp.set('start_date', sDate);
            if (eDate) qp.set('end_date', eDate);
            window.open(`/api/people/${pId}/statement/pdf?${qp.toString()}`, '_blank');
        });

        excelBtn.addEventListener('click', () => {
            const pId = personSelect.value;
            if (!pId) return;
            const lId = loanSelect.value;
            const sDate = startDateInput.value;
            const eDate = endDateInput.value;
            const qp = new URLSearchParams();
            if (lId) qp.set('loan_id', lId);
            if (sDate) qp.set('start_date', sDate);
            if (eDate) qp.set('end_date', eDate);
            window.open(`/api/people/${pId}/statement/excel?${qp.toString()}`, '_blank');
        });

        async function loadStatement() {
            const pId = personSelect.value;
            if (!pId) {
                contentArea.innerHTML = `
                    <div class="empty-state" style="padding:48px 24px">
                        <div class="empty-icon">👤</div>
                        <div class="empty-title">Select a Person</div>
                        <div class="empty-description">Please choose a person to generate their financial statement.</div>
                    </div>
                `;
                pdfBtn.disabled = true;
                excelBtn.disabled = true;
                return;
            }

            contentArea.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Calculating statement balances…</p></div>`;

            const lId = loanSelect.value;
            const sDate = startDateInput.value;
            const eDate = endDateInput.value;

            const qp = new URLSearchParams();
            if (lId) qp.set('loan_id', lId);
            if (sDate) qp.set('start_date', sDate);
            if (eDate) qp.set('end_date', eDate);

            try {
                const res = await apiGet(`/api/people/${pId}/statement?${qp.toString()}`);
                const stmt = res.data;
                pdfBtn.disabled = false;
                excelBtn.disabled = false;


                const p = stmt.person;
                const sm = stmt.summary;
                const txs = stmt.transactions || [];
                const loans = stmt.loans || [];

                contentArea.innerHTML = `
                    <!-- Person & Period Header -->
                    <div class="statement-header-card">
                        <div class="statement-person-info">
                            <h2>${escapeHtml(p.name)}</h2>
                            <div class="statement-person-meta">
                                ${p.phone ? `<span>📞 ${escapeHtml(p.phone)}</span>` : ''}
                                ${p.address ? `<span>📍 ${escapeHtml(p.address)}</span>` : ''}
                                <span>🗓 Period: <strong>${stmt.period.start_date ? formatDateDMY(stmt.period.start_date) : 'Beginning'} → ${stmt.period.end_date ? formatDateDMY(stmt.period.end_date) : 'Present'}</strong></span>
                                <span>🎯 Statement: <strong>${stmt.statement_type.replace('_', ' ')}</strong></span>
                            </div>
                        </div>
                    </div>

                    <!-- Overdue Attention Alert if applicable -->
                    ${sm.total_overdue > 0 ? `
                        <div class="statement-overdue-alert">
                            <span style="font-size:1.25rem;">⚠️</span>
                            <div>
                                <strong>Overdue Attention Required:</strong> ${formatRupees(sm.total_overdue)} is currently overdue across obligations.
                            </div>
                        </div>
                    ` : ''}

                    <!-- 6-Metric KPI Summary Grid -->
                    <div class="statement-summary-grid">
                        <div class="statement-summary-card">
                            <div class="statement-summary-lbl">Opening Balance</div>
                            <div class="statement-summary-val">${formatRupees(sm.opening_balance)}</div>
                        </div>
                        <div class="statement-summary-card">
                            <div class="statement-summary-lbl">Total Principal</div>
                            <div class="statement-summary-val">${formatRupees(sm.total_principal)}</div>
                        </div>
                        <div class="statement-summary-card">
                            <div class="statement-summary-lbl">Total Payments</div>
                            <div class="statement-summary-val" style="color:var(--accent-success)">${formatRupees(sm.total_payments)}</div>
                        </div>
                        <div class="statement-summary-card">
                            <div class="statement-summary-lbl">Total Interest</div>
                            <div class="statement-summary-val" style="color:var(--accent-secondary)">${formatRupees(sm.total_interest)}</div>
                        </div>
                        <div class="statement-summary-card ${sm.total_overdue > 0 ? 'alert' : ''}">
                            <div class="statement-summary-lbl">Overdue Amount</div>
                            <div class="statement-summary-val" style="color:${sm.total_overdue > 0 ? 'var(--accent-danger)' : 'var(--text-muted)'}">${formatRupees(sm.total_overdue)}</div>
                        </div>
                        <div class="statement-summary-card highlight">
                            <div class="statement-summary-lbl">Closing Balance</div>
                            <div class="statement-summary-val" style="color:var(--accent-primary)">${formatRupees(sm.closing_balance)}</div>
                        </div>
                    </div>

                    <!-- Associated Accounts / Loans -->
                    <div class="profile-section">
                        <div class="profile-section-title">Loan Accounts (${loans.length})</div>
                        <div class="ledger-table-wrapper" style="margin-bottom:var(--space-md); overflow-x:auto;">
                            <table class="ledger-table">
                                <thead>
                                    <tr>
                                        <th>Account</th>
                                        <th>Direction</th>
                                        <th>Principal</th>
                                        <th>Rate</th>
                                        <th>Status</th>
                                        <th>Due Date</th>
                                        <th style="text-align:right">Outstanding</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${loans.map(l => `
                                        <tr>
                                            <td><strong>Account #${String(l.id).padStart(3, '0')}</strong></td>
                                            <td><span class="badge ${l.direction === 'MONEY_GIVEN' ? 'badge-given' : 'badge-taken'}">${l.direction === 'MONEY_GIVEN' ? 'Money Lent' : 'Money Taken'}</span></td>
                                            <td>${formatRupees(l.principal)}</td>
                                            <td>${l.interest_rate}% ${frequencyLabel(l.interest_frequency)}</td>
                                            <td><span class="badge ${statusBadgeClass(l.status)}">${l.status}</span></td>
                                            <td>${formatDateDMY(l.due_date)}</td>
                                            <td style="text-align:right; font-weight:700;">${formatRupees(l.outstanding_principal)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- Transaction Ledger -->
                    <div class="profile-section">
                        <div class="profile-section-title">Transaction Ledger (${txs.length})</div>
                        ${txs.length === 0 ? `
                            <div class="empty-state" style="padding:32px 16px;">
                                <div class="empty-icon">📜</div>
                                <div class="empty-title">No transactions in this period</div>
                                <div class="empty-description">There are no financial movements recorded between the selected dates.</div>
                            </div>
                        ` : `
                            <div class="ledger-table-wrapper" style="overflow-x:auto;">
                                <table class="ledger-table">
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Account</th>
                                            <th>Type</th>
                                            <th>Reference / Notes</th>
                                            <th style="text-align:right">Debit (₹)</th>
                                            <th style="text-align:right">Credit (₹)</th>
                                            <th style="text-align:right">Running Balance</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${txs.map(tx => `
                                            <tr>
                                                <td><strong>${formatDateDMY(tx.date)}</strong></td>
                                                <td>${tx.account_id ? `Account #${String(tx.account_id).padStart(3, '0')}` : '—'}</td>
                                                <td><span class="badge ${tx.type.includes('PAYMENT') ? 'badge-active' : 'badge-pending'}">${tx.type.replace(/_/g, ' ')}</span></td>
                                                <td><span class="muted">${escapeHtml(tx.description || tx.reference || '—')}</span></td>
                                                <td style="text-align:right; color:var(--accent-danger); font-weight:600;">${tx.debit_paisa > 0 ? formatRupees(tx.debit_paisa) : '—'}</td>
                                                <td style="text-align:right; color:var(--accent-success); font-weight:600;">${tx.credit_paisa > 0 ? formatRupees(tx.credit_paisa) : '—'}</td>
                                                <td style="text-align:right; font-weight:700;">${formatRupees(tx.running_balance_paisa)}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        `}
                    </div>
                `;

            } catch (err) {
                contentArea.innerHTML = `
                    <div class="empty-state" style="padding:48px 24px">
                        <div class="empty-icon">⚠️</div>
                        <div class="empty-title">Could not load statement</div>
                        <div class="empty-description">${escapeHtml(err.message)}</div>
                    </div>
                `;
                pdfBtn.disabled = true;
                excelBtn.disabled = true;

            }
        }

        // Initialize loan dropdown and load statement
        if (activePersonId) {
            await updateLoanDropdown(activePersonId, params.loan_id);
            await loadStatement();
        }
    }

    // ─── Event Listeners ─────────────────────────────────────
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            currentCategory = 'all';
            navigate(item.dataset.route);
        });
    });

    // FAB — context-aware
    document.getElementById('fab-add').addEventListener('click', () => {
        const parsed = parseHash();
        if (parsed.route === 'accounts' || parsed.route === 'account') {
            openAddAccountModal();
        } else if (parsed.route === 'person') {
            openAddAccountModal(parsed.params.id);
        } else {
            openAddAccountModal();
        }
    });

    window.addEventListener('hashchange', () => { const p = parseHash(); navigate(p.route, p.params); });

    // ─── Part 12 UI Event Listeners ──────────────────────────
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            if (confirm('Are you sure you want to sign out?')) {
                try { await apiPost('/api/auth/logout', {}); } catch (_) {}
                setAuthSession(null, null);
                showToast('Signed out successfully.', 'info');
                renderLogin();
            }
        });
    }

    // Notification Drawer
    const notifBtn = document.getElementById('btn-notifications');
    const notifDrawer = document.getElementById('notification-drawer');
    const closeNotifBtn = document.getElementById('btn-close-notifications');
    const markAllReadBtn = document.getElementById('btn-mark-all-read');

    if (notifBtn && notifDrawer) {
        notifBtn.addEventListener('click', () => {
            notifDrawer.style.display = 'flex';
            loadNotificationsDrawer();
        });
    }
    if (closeNotifBtn && notifDrawer) {
        closeNotifBtn.addEventListener('click', () => {
            notifDrawer.style.display = 'none';
        });
    }
    if (markAllReadBtn) {
        markAllReadBtn.addEventListener('click', async () => {
            try {
                await apiPost('/api/notifications/mark-all-read', {});
                showToast('All notifications marked as read', 'success');
                loadNotificationsDrawer();
                pollNotifications();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Security Modal
    const secBtn = document.getElementById('btn-security-settings');
    const secModal = document.getElementById('security-modal');
    const closeSecBtn = document.getElementById('btn-close-security');

    if (secBtn && secModal) {
        secBtn.addEventListener('click', () => {
            secModal.style.display = 'flex';
            const pinCredLabel = document.getElementById('pin-cred-label');
            if (pinCredLabel) {
                pinCredLabel.textContent = (currentUser && currentUser.has_pin) ? 'Current Password or PIN' : 'Current Account Password';
            }
            const sessBox = document.getElementById('session-info-box');
            if (sessBox && currentUser) {
                sessBox.innerHTML = `
                    <div style="font-size: 0.85rem; line-height: 1.6;">
                        <div><strong>Logged in as:</strong> ${escapeHtml(currentUser.username)} (${escapeHtml(currentUser.role)})</div>
                        <div><strong>Token:</strong> <code>${escapeHtml(authToken ? authToken.slice(0, 8) + '…' + authToken.slice(-8) : '—')}</code></div>
                        <div style="margin-top: 8px; color: var(--accent-success); font-size: 0.8rem;">● Current Session Active</div>
                    </div>
                `;
            }
        });
    }
    if (closeSecBtn && secModal) {
        closeSecBtn.addEventListener('click', () => {
            secModal.style.display = 'none';
        });
    }

    // Security Tabs
    document.querySelectorAll('.sec-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.sec-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.sec-tab-content').forEach(c => c.style.display = 'none');
            tab.classList.add('active');
            const targetId = `sec-tab-${tab.dataset.tab}`;
            const targetEl = document.getElementById(targetId);
            if (targetEl) targetEl.style.display = 'block';
        });
    });

    // Form Change Password
    const formChangePass = document.getElementById('form-change-password');
    if (formChangePass) {
        formChangePass.addEventListener('submit', async (e) => {
            e.preventDefault();
            const curPass = document.getElementById('input-cur-password').value;
            const newPass = document.getElementById('input-new-password').value;
            try {
                const res = await apiPost('/api/auth/change-password', {
                    current_password: curPass,
                    new_password: newPass
                });
                showToast(res.message || 'Password changed successfully! Please log in again.', 'success');
                secModal.style.display = 'none';
                setAuthSession(null, null);
                renderLogin();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Form Change PIN
    const formChangePin = document.getElementById('form-change-pin');
    if (formChangePin) {
        formChangePin.addEventListener('submit', async (e) => {
            e.preventDefault();
            const cred = document.getElementById('input-pin-cred').value;
            const newPin = document.getElementById('input-new-pin').value;
            const confirmPin = document.getElementById('input-confirm-pin').value;

            if (newPin !== confirmPin) {
                showToast('New PIN and Confirm PIN do not match', 'error');
                return;
            }

            try {
                let res;
                if (!currentUser || !currentUser.has_pin) {
                    res = await apiPost('/api/auth/pin/setup', { pin: newPin, confirm_pin: confirmPin });
                } else {
                    res = await apiPost('/api/auth/pin/change', {
                        current_credential: cred,
                        new_pin: newPin,
                        confirm_pin: confirmPin
                    });
                }
                showToast('PIN configured successfully!', 'success');
                if (currentUser) currentUser.has_pin = true;
                setAuthSession(authToken, currentUser);
                secModal.style.display = 'none';
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // Notification polling (every 60s)
    setInterval(pollNotifications, 60000);
    if (authToken) pollNotifications();

    // ─── Initial Load ────────────────────────────────────────
    const initial = parseHash();
    navigate(initial.route, initial.params);

})();
