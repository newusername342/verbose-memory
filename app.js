'use strict';

// --- Settings ---
const SETTINGS_KEY = 'claude_chat_settings';
const HISTORY_KEY = 'claude_chat_history';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch { return {}; }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// Sanitize a message to only have role + content — nothing else
function cleanMessage(msg) {
  return { role: msg.role, content: msg.content };
}

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    return raw.map(cleanMessage).filter(msg => msg.role && msg.content);
  } catch { return []; }
}

function saveHistory(h) {
  // Only store text content — strip binary file data (images, PDFs)
  const safe = h.map(msg => {
    if (msg.role === 'assistant') {
      return { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' };
    }
    // For user messages, strip non-text content parts (images, PDFs)
    if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter(p => p.type === 'text');
      return { role: msg.role, content: textParts.length === 1 ? textParts[0].text : textParts };
    }
    return cleanMessage(msg);
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(safe));
}

let settings = loadSettings();
let conversationHistory = loadHistory();
let pendingFiles = [];
let isStreaming = false;
let abortController = null;

// --- File Reading ---

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const PDF_TYPE = 'application/pdf';

function readFileAsContent(file) {
  return new Promise((resolve, reject) => {
    if (IMAGE_TYPES.includes(file.type)) {
      // Read images as base64 for the vision API
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve({
          type: 'image',
          source: {
            type: 'base64',
            media_type: file.type,
            data: base64,
          },
        });
      };
      reader.onerror = () => reject(new Error('Failed to read image: ' + file.name));
      reader.readAsDataURL(file);
    } else if (file.type === PDF_TYPE) {
      // Read PDFs as base64 document
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64,
          },
        });
      };
      reader.onerror = () => reject(new Error('Failed to read PDF: ' + file.name));
      reader.readAsDataURL(file);
    } else {
      // Read everything else as text
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          type: 'text',
          text: `--- File: ${file.name} (${formatFileSize(file.size)}) ---\n${reader.result}`,
        });
      };
      reader.onerror = () => reject(new Error('Failed to read file: ' + file.name));
      reader.readAsText(file);
    }
  });
}

// --- Markdown Rendering (lightweight) ---

function renderMarkdown(text) {
  // Escape HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return '<pre><code>' + code.trimEnd() + '</code></pre>';
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Paragraphs - split by double newlines
  html = html.replace(/\n\n+/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs and paragraphs around block elements
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>\s*(<pre>)/g, '$1');
  html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<h[123]>)/g, '$1');
  html = html.replace(/(<\/h[123]>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');

  // Line breaks within paragraphs
  html = html.replace(/\n/g, '<br>');

  return html;
}

// --- UI ---

function scrollToBottom() {
  const container = document.getElementById('chat-messages');
  container.scrollTop = container.scrollHeight;
}

function addMessageToUI(role, text, files) {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();

  const container = document.getElementById('chat-messages');
  const msg = document.createElement('div');
  msg.className = 'message ' + role;

  const roleLabel = document.createElement('div');
  roleLabel.className = 'message-role';
  roleLabel.textContent = role === 'user' ? 'You' : 'Claude';
  msg.appendChild(roleLabel);

  if (files && files.length > 0) {
    const filesDiv = document.createElement('div');
    filesDiv.className = 'message-files';
    for (const f of files) {
      const tag = document.createElement('span');
      tag.className = 'file-tag';
      tag.innerHTML = '&#128196; ' + escapeForAttr(f.name) +
        ' <span class="file-size">(' + formatFileSize(f.size) + ')</span>';
      filesDiv.appendChild(tag);
    }
    msg.appendChild(filesDiv);
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }

  msg.appendChild(bubble);
  container.appendChild(msg);
  scrollToBottom();
  return bubble;
}

function addStreamingMessage() {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();

  const container = document.getElementById('chat-messages');
  const msg = document.createElement('div');
  msg.className = 'message assistant';
  msg.id = 'streaming-msg';

  const roleLabel = document.createElement('div');
  roleLabel.className = 'message-role';
  roleLabel.textContent = 'Claude';
  msg.appendChild(roleLabel);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.id = 'streaming-bubble';
  bubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  msg.appendChild(bubble);

  container.appendChild(msg);
  scrollToBottom();
  return bubble;
}

function updateStreamingMessage(text) {
  const bubble = document.getElementById('streaming-bubble');
  if (!bubble) return;
  bubble.innerHTML = renderMarkdown(text);
  scrollToBottom();
}

function finalizeStreamingMessage(text) {
  const bubble = document.getElementById('streaming-bubble');
  if (bubble) {
    bubble.innerHTML = renderMarkdown(text);
    bubble.removeAttribute('id');
  }
  const msg = document.getElementById('streaming-msg');
  if (msg) msg.removeAttribute('id');
  scrollToBottom();
}

function addErrorMessage(text) {
  const container = document.getElementById('chat-messages');
  const msg = document.createElement('div');
  msg.className = 'message error';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  msg.appendChild(bubble);

  container.appendChild(msg);
  scrollToBottom();
}

function escapeForAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- File Preview Bar ---

function updateFilePreview() {
  const bar = document.getElementById('file-preview-bar');
  bar.innerHTML = '';

  if (pendingFiles.length === 0) {
    bar.classList.remove('has-files');
    return;
  }

  bar.classList.add('has-files');
  pendingFiles.forEach((file, i) => {
    const item = document.createElement('div');
    item.className = 'file-preview-item';

    const name = document.createElement('span');
    name.textContent = file.name + ' (' + formatFileSize(file.size) + ')';
    item.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-file';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => {
      pendingFiles.splice(i, 1);
      updateFilePreview();
      updateSendButton();
    });
    item.appendChild(removeBtn);

    bar.appendChild(item);
  });
}

// --- API Call ---

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();

  if (!text && pendingFiles.length === 0) return;
  if (isStreaming) return;

  const apiKey = settings.apiKey;
  if (!apiKey) {
    showToast('Set your API key in Settings first');
    document.getElementById('settings-modal').classList.add('open');
    return;
  }

  const model = settings.model || 'claude-sonnet-4-20250514';
  const maxTokens = settings.maxTokens || 8192;

  // Build content array for the user message
  const contentParts = [];
  const filesMeta = pendingFiles.map(f => ({ name: f.name, size: f.size }));

  // Read all files
  if (pendingFiles.length > 0) {
    try {
      const fileContents = await Promise.all(pendingFiles.map(readFileAsContent));
      contentParts.push(...fileContents);
    } catch (err) {
      addErrorMessage('Error reading files: ' + err.message);
      return;
    }
  }

  // Add text
  if (text) {
    contentParts.push({ type: 'text', text: text });
  }

  // Show user message in UI
  addMessageToUI('user', text, filesMeta);

  // Add to conversation history
  const userMessage = { role: 'user', content: contentParts.length === 1 && contentParts[0].type === 'text' ? text : contentParts };
  conversationHistory.push(userMessage);

  // Clear input and files
  input.value = '';
  input.style.height = 'auto';
  pendingFiles = [];
  updateFilePreview();
  updateSendButton();

  // Start streaming
  isStreaming = true;
  updateSendButton();
  addStreamingMessage();

  abortController = new AbortController();

  try {
    // CRITICAL: Build a clean messages array with ONLY role + content.
    // JSON.parse(JSON.stringify()) guarantees no extra properties survive.
    const apiMessages = JSON.parse(JSON.stringify(
      conversationHistory.map(cleanMessage)
    ));

    const body = {
      model: model,
      max_tokens: maxTokens,
      messages: apiMessages,
      stream: true,
    };

    if (settings.systemPrompt) {
      body.system = settings.systemPrompt;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errBody = await response.text();
      let errMsg;
      try {
        const errJson = JSON.parse(errBody);
        errMsg = errJson.error?.message || errBody;
      } catch {
        errMsg = errBody;
      }
      throw new Error(`API error ${response.status}: ${errMsg}`);
    }

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            fullText += event.delta.text;
            updateStreamingMessage(fullText);
          }

          if (event.type === 'message_stop') {
            break;
          }

          if (event.type === 'error') {
            throw new Error(event.error?.message || 'Stream error');
          }
        } catch (e) {
          if (e.message.startsWith('API error') || e.message === 'Stream error') throw e;
          // Ignore JSON parse errors for non-data lines
        }
      }
    }

    finalizeStreamingMessage(fullText);

    // Save assistant message to history
    conversationHistory.push({ role: 'assistant', content: fullText });
    saveHistory(conversationHistory);

  } catch (err) {
    if (err.name === 'AbortError') {
      finalizeStreamingMessage('*(Message cancelled)*');
    } else {
      // Remove streaming message
      const streamMsg = document.getElementById('streaming-msg');
      if (streamMsg) streamMsg.remove();
      addErrorMessage(err.message);
      // Remove the user message from history since it failed
      conversationHistory.pop();
    }
  } finally {
    isStreaming = false;
    abortController = null;
    updateSendButton();
  }
}

// --- New Chat ---

function newChat() {
  conversationHistory = [];
  saveHistory(conversationHistory);

  const container = document.getElementById('chat-messages');
  container.innerHTML = '';

  const welcome = document.createElement('div');
  welcome.className = 'welcome-state';
  welcome.id = 'welcome';
  welcome.innerHTML = '<div class="welcome-icon">&#9993;</div>' +
    '<h2>Chat with Claude</h2>' +
    '<p>Upload files of any size. Text files are sent as content, images as base64. No upload limits.</p>';
  container.appendChild(welcome);

  pendingFiles = [];
  updateFilePreview();
}

// --- Restore chat history on load ---

function restoreHistory() {
  if (conversationHistory.length === 0) return;

  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();

  for (const msg of conversationHistory) {
    if (msg.role === 'user') {
      // Extract text from content
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('\n');
      }
      addMessageToUI('user', text, []);
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      addMessageToUI('assistant', text, []);
    }
  }
}

// --- Toast ---

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// --- Send Button State ---

function updateSendButton() {
  const input = document.getElementById('message-input');
  const btn = document.getElementById('send-btn');
  const hasContent = input.value.trim().length > 0 || pendingFiles.length > 0;
  btn.disabled = !hasContent || isStreaming;
}

// --- Settings Modal ---

function openSettings() {
  document.getElementById('api-key-input').value = settings.apiKey || '';
  document.getElementById('model-select').value = settings.model || 'claude-sonnet-4-20250514';
  document.getElementById('max-tokens-input').value = settings.maxTokens || 8192;
  document.getElementById('system-prompt-input').value = settings.systemPrompt || '';
  document.getElementById('settings-modal').classList.add('open');
}

function saveSettingsForm(e) {
  e.preventDefault();
  settings.apiKey = document.getElementById('api-key-input').value.trim();
  settings.model = document.getElementById('model-select').value;
  settings.maxTokens = parseInt(document.getElementById('max-tokens-input').value) || 8192;
  settings.systemPrompt = document.getElementById('system-prompt-input').value.trim();
  saveSettings(settings);
  document.getElementById('model-indicator').textContent = settings.model;
  closeModals();
  showToast('Settings saved');
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
}

// --- Event Listeners ---

document.addEventListener('DOMContentLoaded', () => {
  // Settings
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-form').addEventListener('submit', saveSettingsForm);

  // Clear all data
  document.getElementById('clear-data-btn').addEventListener('click', () => {
    if (confirm('This will delete your API key, chat history, and all settings. Continue?')) {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(HISTORY_KEY);
      settings = {};
      conversationHistory = [];
      pendingFiles = [];
      closeModals();
      newChat();
      showToast('All data cleared');
    }
  });

  // New chat
  document.getElementById('new-chat-btn').addEventListener('click', newChat);

  // File input
  document.getElementById('file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    pendingFiles.push(...files);
    updateFilePreview();
    updateSendButton();
    e.target.value = '';
  });

  // Message input auto-resize
  const msgInput = document.getElementById('message-input');
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
    updateSendButton();
  });

  // Send on Enter (Shift+Enter for newline)
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Send button
  document.getElementById('send-btn').addEventListener('click', sendMessage);

  // Close modals on overlay tap
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModals();
    });
  });

  // Drag and drop files
  const chatArea = document.getElementById('chat-messages');
  chatArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  chatArea.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      pendingFiles.push(...files);
      updateFilePreview();
      updateSendButton();
    }
  });

  // Update model indicator
  if (settings.model) {
    document.getElementById('model-indicator').textContent = settings.model;
  }

  // Restore history
  restoreHistory();

  // Service Worker — unregister all old SWs first, then register fresh
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      const unregisterAll = registrations.map(r => r.unregister());
      return Promise.all(unregisterAll);
    }).then(() => {
      return navigator.serviceWorker.register('sw.js');
    }).catch(() => {});
  }
});
