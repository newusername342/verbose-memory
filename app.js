'use strict';

// --- Data Layer ---
const STORAGE_KEY = 'cowork_tasks';

function loadTasks() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch { return []; }
}

function saveTasks(tasks) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

let tasks = loadTasks();
let currentFilter = 'all';
let editingId = null;

// --- Sanitization ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Validate that a string looks like a UUID (防止注入)
function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Sanitize imported task data to only allow known safe fields
function sanitizeTask(t) {
  const allowedPriorities = ['high', 'medium', 'low'];
  return {
    id: (typeof t.id === 'string' && isValidUUID(t.id)) ? t.id : crypto.randomUUID(),
    title: typeof t.title === 'string' ? t.title.slice(0, 500) : '',
    description: typeof t.description === 'string' ? t.description.slice(0, 2000) : '',
    priority: allowedPriorities.includes(t.priority) ? t.priority : 'medium',
    category: typeof t.category === 'string' ? t.category.slice(0, 100) : '',
    completed: t.completed === true,
    completedAt: typeof t.completedAt === 'string' ? t.completedAt : null,
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
  };
}

// --- Rendering ---
function render() {
  const list = document.getElementById('task-list');
  const filtered = filterTasks(tasks, currentFilter);

  // Stats
  const active = tasks.filter(t => !t.completed).length;
  const done = tasks.filter(t => t.completed).length;
  document.getElementById('stat-active').textContent = active;
  document.getElementById('stat-total').textContent = tasks.length;
  document.getElementById('stat-done').textContent = done;

  if (filtered.length === 0) {
    list.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.textContent = currentFilter === 'all' ? '\u{1F4CB}' : '\u{1F50D}';
    const p = document.createElement('p');
    p.innerHTML = currentFilter === 'all'
      ? 'No tasks yet.<br>Tap + to add your first task.'
      : 'No tasks match this filter.';
    empty.appendChild(icon);
    empty.appendChild(p);
    list.appendChild(empty);
    return;
  }

  // Sort: incomplete first (high > medium > low), then completed
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const sorted = [...filtered].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.completed) return new Date(b.completedAt) - new Date(a.completedAt);
    const pd = (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
    if (pd !== 0) return pd;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  // Build DOM nodes instead of innerHTML to prevent XSS
  list.innerHTML = '';
  let lastGroup = null;
  for (const task of sorted) {
    const group = task.completed ? 'Completed' : 'Active';
    if (group !== lastGroup) {
      const label = document.createElement('div');
      label.className = 'task-group-label';
      label.textContent = group;
      list.appendChild(label);
      lastGroup = group;
    }
    list.appendChild(buildTaskCard(task));
  }
}

function buildTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'task-card' + (task.completed ? ' completed' : '');
  card.dataset.id = task.id;

  const header = document.createElement('div');
  header.className = 'task-header';

  // Checkbox
  const checkbox = document.createElement('div');
  checkbox.className = 'task-checkbox';
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTask(task.id);
  });

  // Content area
  const content = document.createElement('div');
  content.className = 'task-content';
  content.addEventListener('click', () => openEditModal(task.id));

  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = task.title;
  content.appendChild(title);

  if (task.description) {
    const desc = document.createElement('div');
    desc.className = 'task-description';
    desc.textContent = task.description;
    content.appendChild(desc);
  }

  // Meta row
  const meta = document.createElement('div');
  meta.className = 'task-meta';

  const priorityTag = document.createElement('span');
  priorityTag.className = 'tag priority-' + task.priority;
  priorityTag.textContent = task.priority;
  meta.appendChild(priorityTag);

  if (task.category) {
    const catTag = document.createElement('span');
    catTag.className = 'tag category';
    catTag.textContent = task.category;
    meta.appendChild(catTag);
  }

  const dateEl = document.createElement('span');
  dateEl.className = 'task-date';
  dateEl.textContent = new Date(task.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  meta.appendChild(dateEl);

  content.appendChild(meta);
  header.appendChild(checkbox);
  header.appendChild(content);
  card.appendChild(header);
  return card;
}

function filterTasks(tasks, filter) {
  switch (filter) {
    case 'active': return tasks.filter(t => !t.completed);
    case 'completed': return tasks.filter(t => t.completed);
    case 'high': return tasks.filter(t => t.priority === 'high' && !t.completed);
    case 'medium': return tasks.filter(t => t.priority === 'medium' && !t.completed);
    case 'low': return tasks.filter(t => t.priority === 'low' && !t.completed);
    default: return tasks;
  }
}

// --- Actions ---
function toggleTask(id) {
  if (!isValidUUID(id)) return;
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;
  saveTasks(tasks);
  render();
}

function openTaskModal() {
  editingId = null;
  document.getElementById('modal-title').textContent = 'New Task';
  document.getElementById('save-btn').textContent = 'Add Task';
  document.getElementById('delete-btn').classList.add('hidden');
  document.getElementById('task-form').reset();
  document.getElementById('task-id').value = '';
  document.getElementById('task-modal').classList.add('open');
}

function openEditModal(id) {
  if (!isValidUUID(id)) return;
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  editingId = id;
  document.getElementById('modal-title').textContent = 'Edit Task';
  document.getElementById('save-btn').textContent = 'Save Changes';
  document.getElementById('delete-btn').classList.remove('hidden');
  document.getElementById('task-id').value = id;
  document.getElementById('task-title-input').value = task.title;
  document.getElementById('task-desc').value = task.description || '';
  document.getElementById('task-priority').value = task.priority;
  document.getElementById('task-category').value = task.category || '';
  document.getElementById('task-modal').classList.add('open');
}

function saveTask(e) {
  e.preventDefault();
  const title = document.getElementById('task-title-input').value.trim();
  if (!title) return;

  const allowedPriorities = ['high', 'medium', 'low'];
  const rawPriority = document.getElementById('task-priority').value;

  const data = {
    title: title.slice(0, 500),
    description: document.getElementById('task-desc').value.trim().slice(0, 2000),
    priority: allowedPriorities.includes(rawPriority) ? rawPriority : 'medium',
    category: document.getElementById('task-category').value.trim().slice(0, 100),
  };

  if (editingId) {
    const task = tasks.find(t => t.id === editingId);
    if (task) Object.assign(task, data);
  } else {
    tasks.push({
      id: crypto.randomUUID(),
      ...data,
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  saveTasks(tasks);
  closeModals();
  render();
  showToast(editingId ? 'Task updated' : 'Task added');
}

function deleteTask() {
  if (!editingId) return;
  tasks = tasks.filter(t => t.id !== editingId);
  saveTasks(tasks);
  closeModals();
  render();
  showToast('Task deleted');
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
  editingId = null;
}

// --- Sync ---
function openSyncModal() {
  document.getElementById('sync-data').value = '';
  document.getElementById('sync-modal').classList.add('open');
}

function exportTasks() {
  const json = JSON.stringify(tasks, null, 2);
  document.getElementById('sync-data').value = json;
  navigator.clipboard.writeText(json).then(() => {
    showToast('Copied to clipboard');
  }).catch(() => {
    showToast('Exported below \u2014 copy manually');
  });
}

function importTasks() {
  const raw = document.getElementById('sync-data').value.trim();
  if (!raw) { showToast('Paste JSON first'); return; }

  // Limit import size to prevent DoS
  if (raw.length > 1_000_000) {
    showToast('Import data too large');
    return;
  }

  try {
    const imported = JSON.parse(raw);
    if (!Array.isArray(imported)) throw new Error('Not an array');
    if (imported.length > 10_000) throw new Error('Too many tasks');

    const existing = new Set(tasks.map(t => t.title + '|' + t.createdAt));
    let added = 0;
    for (const t of imported) {
      const sanitized = sanitizeTask(t);
      if (!sanitized.title) continue;
      const key = sanitized.title + '|' + sanitized.createdAt;
      if (!existing.has(key)) {
        tasks.push(sanitized);
        existing.add(key);
        added++;
      }
    }
    saveTasks(tasks);
    closeModals();
    render();
    showToast(`Imported ${added} task${added !== 1 ? 's' : ''}`);
  } catch (err) {
    showToast('Invalid JSON format');
  }
}

// --- Toast ---
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// --- Event Listeners (no inline handlers) ---
document.addEventListener('DOMContentLoaded', () => {
  // Filter tabs
  document.getElementById('filters').addEventListener('click', (e) => {
    if (!e.target.classList.contains('filter-btn')) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    currentFilter = e.target.dataset.filter;
    render();
  });

  // FAB button
  document.querySelector('.fab').addEventListener('click', openTaskModal);

  // Sync button
  document.querySelector('[data-action="sync"]').addEventListener('click', openSyncModal);

  // Task form submit
  document.getElementById('task-form').addEventListener('submit', saveTask);

  // Delete button
  document.getElementById('delete-btn').addEventListener('click', deleteTask);

  // Export / Import buttons
  document.querySelector('[data-action="export"]').addEventListener('click', exportTasks);
  document.querySelector('[data-action="import"]').addEventListener('click', importTasks);

  // Close modals on overlay tap
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModals();
    });
  });

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Initial render
  render();
});
