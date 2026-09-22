const ROLE_OPTIONS = [
  ['admin', 'Admin'],
  ['manager', 'Manager'],
  ['department_lead', 'Department lead'],
  ['member', 'Member'],
];
const JOB_TITLES = [
  'CEO', 'Lead backend engineer', 'Fullstack engineer', 'UI/UX designer',
  'Digital innovation lead', 'Marketing lead', 'Legal counsel', 'Operations lead',
  'Researcher', 'Community manager', 'Finance lead', 'Member',
];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) { return (name || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase(); }
function toast(message, type = 'success') {
  const el = document.getElementById('cmToast');
  if (!el) return;
  el.textContent = message;
  el.className = `cm-toast ${type} visible`;
  clearTimeout(window.cmToastTimer);
  window.cmToastTimer = setTimeout(() => el.classList.remove('visible'), 3600);
}

function showView(view) {
  document.querySelectorAll('.cm-view').forEach(v => v.style.display = 'none');
  const target = document.getElementById(`view-${view}`);
  if (target) target.style.display = 'block';
  document.querySelectorAll('.cm-nav button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  // Call object methods through their owning object. In particular, Tasks.load
  // uses `this.bindDragDrop()` after rendering the board.
  const loaders = {
    dashboard: () => Dashboard.load(),
    teams: () => Teams.load(),
    departments: () => Departments.load(),
    tasks: () => Tasks.load(),
    people: () => People.load(),
    resources: () => Resources.load(),
    admin: () => Admin.load(),
    avatar: () => AvatarPanel.load(),
  };
  if (loaders[view]) loaders[view]().catch(err => toast(err.message, 'error'));
}

async function refreshClockStatus() {
  const data = await CM.call('clockin', 'status');
  const btn = document.getElementById('clockBtn');
  const status = document.getElementById('clockStatus');
  if (data.clocked_in) {
    status.textContent = `Clocked in since ${new Date(data.since).toLocaleTimeString()}`;
    btn.textContent = 'Clock out'; btn.dataset.state = 'in';
  } else {
    status.textContent = 'Not clocked in';
    btn.textContent = 'Clock in'; btn.dataset.state = 'out';
  }
}
async function toggleClock() {
  const state = document.getElementById('clockBtn').dataset.state;
  await CM.call('clockin', state === 'in' ? 'out' : 'in', { method: 'POST' });
  refreshClockStatus(); toast(state === 'in' ? 'You are clocked out.' : 'You are clocked in.');
}

const Dashboard = {
  async load() {
    const [{ teams }, { tasks }, { roster }, { summary }, { announcements }, { events }] = await Promise.all([
      CM.call('teams', 'list'), CM.call('tasks', 'list'), CM.call('avatars', 'roster'),
      CM.call('workspace', 'summary'), CM.call('workspace', 'announcements'), CM.call('workspace', 'events'),
    ]);
    const stats = [
      ['Teams', summary.teams, '👥'], ['Departments', summary.departments, '◈'],
      ['Open tasks', tasks.filter(t => t.status !== 'done').length, '✓'],
      ['People', summary.users, '◎'],
    ];
    document.getElementById('dashboardStats').innerHTML = stats.map(([label, value, icon]) =>
      `<div class="cm-card cm-stat"><span>${icon}</span><div><strong>${value}</strong><small>${label}</small></div></div>`).join('');
    document.getElementById('rosterList').innerHTML = roster.map(r =>
      `<div class="cm-person-pill"><div class="cm-avatar-dot" style="background:${esc(r.body_color || '#6B21A8')}">${initials(r.display_name || r.name)}</div><span>${esc(r.display_name || r.name)}</span></div>`
    ).join('') || '<p class="cm-muted">No one has set up an avatar yet.</p>';
    document.getElementById('announcementList').innerHTML = announcements.slice(0, 4).map(a =>
      `<article class="cm-feed-item"><div><strong>${esc(a.title)}</strong><p>${esc(a.body)}</p></div><small>${esc(a.author)} · ${new Date(a.created_at).toLocaleDateString()}</small></article>`
    ).join('') || '<p class="cm-muted">No announcements yet.</p>';
    document.getElementById('upcomingEvents').innerHTML = events.slice(0, 4).map(e =>
      `<article class="cm-feed-item"><div><strong>${esc(e.title)}</strong><p>${new Date(e.start_at).toLocaleString()}${e.location ? ` · ${esc(e.location)}` : ''}</p></div></article>`
    ).join('') || '<p class="cm-muted">No upcoming events.</p>';
  },
};

const Teams = {
  cache: [],
  async load() {
    const [{ teams }, { departments }] = await Promise.all([CM.call('teams', 'list'), CM.call('departments', 'list')]);
    this.cache = teams;
    const grid = document.getElementById('teamsGrid');
    grid.innerHTML = teams.map(t => `
      <div class="cm-card cm-team-card">
        <div class="cm-card-top"><div><span class="cm-eyebrow">${esc(t.department_name || 'Company team')}</span><h3 style="color:${esc(t.color)}">${esc(t.name)}</h3><p>${esc(t.description || 'No description')}</p></div><span class="cm-badge medium">${t.members.length} member${t.members.length === 1 ? '' : 's'}</span></div>
        <div class="cm-member-row">${t.members.map(m => `<div class="cm-avatar-dot small" title="${esc(m.name)}" style="background:${esc(m.body_color || '#6B21A8')}">${initials(m.name)}</div>`).join('')}</div>
        <div class="cm-card-actions"><button class="cm-btn secondary" onclick="Teams.openAddMember(${t.id})">+ Add member</button></div>
      </div>`).join('') || '<div class="cm-empty">No teams yet — create the first one.</div>';
    const select = document.getElementById('teamDepartment');
    if (select) select.innerHTML = '<option value="">Company-wide</option>' + departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  },
  async openCreate() {
    const name = document.getElementById('teamName')?.value.trim() || prompt('Team name:')?.trim();
    if (!name) return;
    const description = document.getElementById('teamDescription')?.value.trim() || prompt('Short description (optional):') || '';
    const department_id = document.getElementById('teamDepartment')?.value || null;
    try {
      await CM.call('teams', 'create', { method: 'POST', body: { name, description, department_id } });
      ['teamName', 'teamDescription'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      await this.load(); toast('Team created and ready for members.');
    } catch (err) { toast(err.message, 'error'); }
  },
  async openAddMember(teamId) {
    const { users } = await CM.call('users', 'list');
    const choice = prompt(`Enter a user number to add:\n${users.map((u, i) => `${i + 1}. ${u.name} (${u.email})`).join('\n')}`);
    const user = users[parseInt(choice, 10) - 1];
    if (!user) return;
    await CM.call('teams', 'add_member', { method: 'POST', body: { team_id: teamId, user_id: user.id } });
    await this.load(); toast(`${user.name} added to the team.`);
  },
};

const Departments = {
  async load() {
    const { departments } = await CM.call('departments', 'list');
    document.getElementById('departmentsGrid').innerHTML = departments.map(d => `
      <div class="cm-card"><div class="cm-dept-mark" style="background:${esc(d.color)}"></div><span class="cm-eyebrow">Department</span><h3>${esc(d.name)}</h3><p>${esc(d.description || 'No description')}</p><div class="cm-dept-meta"><span>${d.member_count} people</span><span>${d.team_count} teams</span></div></div>
    `).join('') || '<div class="cm-empty">Create departments to organize your company.</div>';
    const selects = document.querySelectorAll('.department-select');
    selects.forEach(select => {
      const old = select.value;
      select.innerHTML = '<option value="">No department</option>' + departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
      select.value = old;
    });
  },
  async openCreate() {
    const name = document.getElementById('departmentName')?.value.trim() || prompt('Department name:')?.trim();
    if (!name) return;
    const description = document.getElementById('departmentDescription')?.value.trim() || '';
    try {
      await CM.call('departments', 'create', { method: 'POST', body: { name, description, color: '#6B21A8' } });
      ['departmentName', 'departmentDescription'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      await this.load(); toast('Department created.');
    } catch (err) { toast(err.message, 'error'); }
  },
};

const Tasks = {
  async load() {
    const { tasks } = await CM.call('tasks', 'list');
    document.querySelectorAll('.cm-kanban-col').forEach(col => {
      const body = col.querySelector('.col-body');
      body.innerHTML = tasks.filter(t => t.status === col.dataset.status).map(t => `
        <div class="cm-task-card" draggable="true" data-id="${t.id}"><h4>${esc(t.title)}</h4><div class="meta"><span class="cm-badge ${esc(t.priority)}">${esc(t.priority)}</span><span>${(t.assignees || []).length} assigned</span></div></div>`).join('') || '<span class="cm-muted">Nothing here</span>';
    });
    this.bindDragDrop();
  },
  bindDragDrop() {
    document.querySelectorAll('.cm-task-card').forEach(card => card.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', card.dataset.id)));
    document.querySelectorAll('.cm-kanban-col').forEach(col => {
      col.addEventListener('dragover', e => e.preventDefault());
      col.addEventListener('drop', async e => {
        e.preventDefault();
        await CM.call('tasks', 'update', { method: 'POST', body: { id: parseInt(e.dataTransfer.getData('text/plain'), 10), status: col.dataset.status } });
        this.load();
      });
    });
  },
  async openCreate() {
    const title = document.getElementById('taskTitle')?.value.trim() || prompt('Task title:')?.trim();
    if (!title) return;
    const priority = document.getElementById('taskPriority')?.value || 'medium';
    await CM.call('tasks', 'create', { method: 'POST', body: { title, priority, team_id: null, assignee_ids: [] } });
    const el = document.getElementById('taskTitle'); if (el) el.value = '';
    await this.load(); toast('Task added.');
  },
};

const People = {
  departments: [],
  async load() {
    const [{ users }, { departments }] = await Promise.all([CM.call('users', 'list'), CM.call('departments', 'list')]);
    this.departments = departments;
    document.getElementById('peopleTable').innerHTML = `
      <div class="cm-table-head"><span>Person</span><span>Role</span><span>Department</span><span>Status</span><span>Actions</span></div>
      ${users.map(u => `<div class="cm-table-row"><div><strong>${esc(u.name)}</strong><small>${esc(u.email)}${u.title ? ` · ${esc(u.title)}` : ''}</small></div><select onchange="People.setRole(${u.id}, this.value)" ${CM.user.role !== 'admin' ? 'disabled' : ''}>${ROLE_OPTIONS.map(([v, l]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span>${esc(u.departments || 'Unassigned')}</span><span class="cm-badge ${u.status === 'active' ? 'low' : 'urgent'}">${esc(u.status)}</span><div class="cm-inline-actions">${u.status === 'invited' ? `<button class="text-btn" onclick="People.resetInvite(${u.id})">New link</button>` : ''}<button class="text-btn" onclick="People.toggleSuspend(${u.id}, '${esc(u.status)}')">${u.status === 'active' ? 'Suspend' : 'Reactivate'}</button></div></div>`).join('')}
    `;
    const deptSelect = document.getElementById('newUserDepartment');
    if (deptSelect) deptSelect.innerHTML = '<option value="">No department</option>' + departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  },
  async create(e) {
    e.preventDefault();
    const form = e.target;
    const body = { name: form.name.value, email: form.email.value, role: form.role.value, title: form.title.value, department_ids: form.department_id.value ? [form.department_id.value] : [] };
    try {
      const result = await CM.call('users', 'create', { method: 'POST', body });
      form.reset(); document.getElementById('inviteLink').value = result.invite_url;
      document.getElementById('inviteResult').style.display = 'block';
      await this.load(); toast('User created. Copy the invite link and share it privately.');
    } catch (err) { toast(err.message, 'error'); }
  },
  async setRole(userId, role) { await CM.call('users', 'set_role', { method: 'POST', body: { user_id: userId, role } }); toast('Role updated.'); },
  async toggleSuspend(userId, status) { await CM.call('users', 'suspend', { method: 'POST', body: { user_id: userId, status: status === 'active' ? 'suspended' : 'active' } }); this.load(); },
  async resetInvite(userId) { const result = await CM.call('users', 'invite_reset', { method: 'POST', body: { user_id: userId } }); document.getElementById('inviteLink').value = result.reset_url; document.getElementById('inviteResult').style.display = 'block'; },
};

const Resources = {
  async load() {
    const [{ resources }, { leave }, { events }] = await Promise.all([CM.call('workspace', 'resources'), CM.call('workspace', 'leave_list'), CM.call('workspace', 'events')]);
    document.getElementById('resourceList').innerHTML = resources.map(r => `<a class="cm-resource" href="${esc(r.url)}" target="_blank" rel="noopener"><strong>${esc(r.name)}</strong><small>${esc(r.description || r.url)}</small></a>`).join('') || '<p class="cm-muted">No shared resources yet.</p>';
    document.getElementById('leaveList').innerHTML = leave.slice(0, 12).map(l => `<div class="cm-list-row"><div><strong>${esc(l.name)}</strong><small>${esc(l.leave_type)} · ${esc(l.start_date)} to ${esc(l.end_date)}</small></div><span class="cm-badge ${l.status === 'approved' ? 'low' : l.status === 'rejected' ? 'urgent' : 'medium'}">${esc(l.status)}</span></div>`).join('') || '<p class="cm-muted">No leave requests yet.</p>';
    document.getElementById('eventList').innerHTML = events.slice(0, 12).map(e => `<div class="cm-list-row"><div><strong>${esc(e.title)}</strong><small>${new Date(e.start_at).toLocaleString()}${e.location ? ` · ${esc(e.location)}` : ''}</small></div></div>`).join('') || '<p class="cm-muted">No events yet.</p>';
  },
  async createResource(e) { e.preventDefault(); const f = e.target; await CM.call('workspace', 'create_resource', { method: 'POST', body: { name: f.name.value, url: f.url.value, description: f.description.value } }); f.reset(); this.load(); toast('Resource shared.'); },
  async createEvent(e) { e.preventDefault(); const f = e.target; await CM.call('workspace', 'create_event', { method: 'POST', body: { title: f.title.value, start_at: f.start_at.value, location: f.location.value } }); f.reset(); this.load(); toast('Event added to the team calendar.'); },
  async requestLeave(e) { e.preventDefault(); const f = e.target; await CM.call('workspace', 'leave', { method: 'POST', body: { leave_type: f.leave_type.value, start_date: f.start_date.value, end_date: f.end_date.value, reason: f.reason.value } }); f.reset(); this.load(); toast('Leave request submitted.'); },
};

const Admin = {
  async load() {
    const { audit } = await CM.call('workspace', 'audit');
    document.getElementById('auditList').innerHTML = audit.map(a => `<div class="cm-list-row"><div><strong>${esc(a.action.replaceAll('_', ' '))}</strong><small>${esc(a.actor || 'System')} · ${esc(a.entity_type)} #${a.entity_id || ''}</small></div><time>${new Date(a.created_at).toLocaleString()}</time></div>`).join('') || '<p class="cm-muted">No audit events yet.</p>';
  },
};

const AvatarPanel = {
  async load() {
    const { avatar } = await CM.call('avatars', 'mine');
    if (!avatar) return;
    document.getElementById('avName').value = avatar.display_name;
    document.getElementById('avColor').value = avatar.body_color;
    document.getElementById('avShape').value = avatar.body_shape;
  },
  async save() {
    await CM.call('avatars', 'update', { method: 'POST', body: { display_name: document.getElementById('avName').value, body_color: document.getElementById('avColor').value, body_shape: document.getElementById('avShape').value } });
    toast('Avatar profile saved.');
  },
  async changePassword(e) {
    e.preventDefault();
    const form = e.target;
    await CM.call('auth', 'change_password', { method: 'POST', body: { current_password: form.current_password.value, new_password: form.new_password.value } });
    form.reset(); toast('Password updated.');
  },
};

window.showView = showView;
window.toggleClock = toggleClock;
window.Teams = Teams; window.Departments = Departments; window.Tasks = Tasks; window.People = People; window.Resources = Resources; window.Admin = Admin; window.AvatarPanel = AvatarPanel;

(async function init() {
  // The role in localStorage can be stale after an admin changes a user's
  // role. Refresh it from the backend before deciding which controls to show.
  try {
    const current = await CM.call('auth', 'me');
    if (current?.user) {
      CM.user = { ...CM.user, ...current.user };
      localStorage.setItem('cm_user', JSON.stringify(CM.user));
    }
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const role = String(CM.user?.role || '').trim().toLowerCase();
  const canManage = role === 'admin' || role === 'manager';
  const roleStatus = document.getElementById('roleStatus');
  if (roleStatus) roleStatus.textContent = `Access: ${role ? role.replaceAll('_', ' ') : 'unknown'}`;
  document.getElementById('welcomeName').textContent = CM.user ? `, ${CM.user.name.split(' ')[0]}` : '';
  document.getElementById('adminNavBtn').style.display = role === 'admin' ? 'flex' : 'none';
  document.querySelectorAll('[data-manager-only]').forEach(el => {
    el.style.display = canManage ? '' : 'none';
  });
  document.getElementById('onboardingBanner').style.display = localStorage.getItem('cm_onboarded') ? 'none' : 'flex';
  try { refreshClockStatus(); await Dashboard.load(); } catch (err) { toast(err.message, 'error'); }
})();

window.dismissOnboarding = () => { localStorage.setItem('cm_onboarded', '1'); document.getElementById('onboardingBanner').style.display = 'none'; };