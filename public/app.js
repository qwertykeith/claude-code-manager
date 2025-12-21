// Claude Manager Frontend
(function() {
  let ws = null;
  let terminal = null;
  let fitAddon = null;
  let sessions = [];
  let activeSessionId = null;
  let editingSessionId = null;
  let pendingCreate = false;

  // DOM elements
  const sessionsList = document.getElementById('sessions-list');
  const archivedList = document.getElementById('archived-list');
  const archivedHeader = document.getElementById('archived-header');
  const archivedCount = document.getElementById('archived-count');
  const terminalEl = document.getElementById('terminal');
  const noSessionEl = document.getElementById('no-session');
  const newSessionBtn = document.getElementById('new-session');

  // Initialize
  function init() {
    initTerminal();
    initWebSocket();
    initEventListeners();
  }

  function initTerminal() {
    terminal = new Terminal({
      theme: {
        background: '#1a1a2e',
        foreground: '#eee',
        cursor: '#e94560',
        selection: 'rgba(233, 69, 96, 0.3)',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
    });

    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalEl);
    fitAddon.fit();

    // Handle terminal input
    terminal.onData((data) => {
      if (activeSessionId) {
        send({ type: 'input', sessionId: activeSessionId, data });
      }
    });

    // Handle resize
    window.addEventListener('resize', () => {
      if (terminal && fitAddon) {
        fitAddon.fit();
        if (activeSessionId) {
          send({
            type: 'resize',
            sessionId: activeSessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
      }
    });
  }

  function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      console.log('Connected to server');
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      console.log('Disconnected from server');
      setTimeout(initWebSocket, 2000); // Reconnect
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  function initEventListeners() {
    newSessionBtn.addEventListener('click', () => {
      pendingCreate = true;
      send({ type: 'create' });
    });

    // Close name editing on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && editingSessionId) {
        editingSessionId = null;
        renderSessions();
      }
    });

    // Toggle archived section
    archivedHeader.addEventListener('click', () => {
      archivedHeader.classList.toggle('collapsed');
      archivedList.classList.toggle('collapsed');
    });
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'sessions':
        const oldIds = new Set(sessions.map(s => s.id));
        sessions = msg.sessions;

        // Auto-focus newly created session
        if (pendingCreate) {
          const newSession = sessions.find(s => !s.archived && !oldIds.has(s.id));
          if (newSession) {
            pendingCreate = false;
            switchSession(newSession.id);
            return;
          }
        }
        renderSessions();
        break;

      case 'output':
        if (msg.sessionId === activeSessionId) {
          terminal.write(msg.data);
        }
        break;

      case 'buffer':
        if (msg.sessionId === activeSessionId) {
          terminal.clear();
          terminal.write(msg.data);
        }
        break;

      case 'status':
        const session = sessions.find((s) => s.id === msg.sessionId);
        if (session) {
          session.status = msg.status;
          renderSessions();
        }
        break;

      case 'summary':
        const sess = sessions.find((s) => s.id === msg.sessionId);
        if (sess) {
          sess.summary = msg.summary;
          sess.originalPrompt = msg.originalPrompt;
          renderSessions();
        }
        break;

      case 'reload':
        console.log('[dev] Reloading page...');
        location.reload();
        break;
    }
  }

  function renderSessions() {
    const active = sessions.filter((s) => !s.archived);
    const archived = sessions.filter((s) => s.archived);

    sessionsList.innerHTML = active.map((s) => renderSessionItem(s, false)).join('');
    archivedList.innerHTML = archived.map((s) => renderSessionItem(s, true)).join('');
    archivedCount.textContent = `(${archived.length})`;

    // Add event listeners
    document.querySelectorAll('.session-item').forEach((el) => {
      const id = el.dataset.id;
      el.addEventListener('click', (e) => {
        // Don't switch if clicking a button or input
        if (e.target.closest('button') || e.target.closest('input')) return;
        switchSession(id);
      });
    });

    document.querySelectorAll('.archive-btn-inline').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'archive', sessionId: btn.dataset.id });
      });
    });

    document.querySelectorAll('.unarchive-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        send({ type: 'unarchive', sessionId: btn.dataset.id });
      });
    });

    document.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('Delete this session?')) {
          send({ type: 'delete', sessionId: btn.dataset.id });
          if (activeSessionId === btn.dataset.id) {
            activeSessionId = null;
            showNoSession();
          }
        }
      });
    });

    document.querySelectorAll('.session-summary-text').forEach((el) => {
      el.addEventListener('dblclick', () => {
        editingSessionId = el.dataset.id;
        renderSessions();
        const input = document.querySelector(`input[data-id="${editingSessionId}"]`);
        if (input) {
          input.focus();
          input.select();
        }
      });
    });

    document.querySelectorAll('.session-name-input').forEach((input) => {
      input.addEventListener('blur', () => {
        finishRename(input.dataset.id, input.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          finishRename(input.dataset.id, input.value);
        }
      });
    });
  }

  function renderSessionItem(session, isArchived) {
    const isActive = session.id === activeSessionId;
    const isEditing = session.id === editingSessionId;

    // Only show name input when editing, otherwise show summary as main content
    const displayText = session.summary || session.name;
    const tooltipText = session.originalPrompt || displayText;
    const contentHtml = isEditing
      ? `<input type="text" class="session-name-input" data-id="${session.id}" value="${escapeHtml(session.name)}">`
      : `<span class="session-summary-text" data-id="${session.id}" title="${escapeHtml(tooltipText)}">${escapeHtml(displayText)}</span>`;

    const actions = isArchived
      ? `<button class="btn btn-small btn-ghost unarchive-btn" data-id="${session.id}">Restore</button>
         <button class="btn btn-small btn-ghost delete-btn" data-id="${session.id}">Delete</button>`
      : `<button class="archive-btn-inline" data-id="${session.id}" title="Archive">×</button>`;

    const statusBadge = session.status === 'waiting'
      ? '<span class="waiting-badge">?</span>'
      : session.status === 'draft'
        ? '<span class="draft-badge">✎</span>'
        : '';

    return `
      <li class="session-item ${isActive ? 'active' : ''}" data-id="${session.id}">
        <div class="session-row">
          <span class="status-dot ${session.status}"></span>
          ${statusBadge}
          ${contentHtml}
          <div class="session-actions-inline">${actions}</div>
        </div>
      </li>
    `;
  }

  function finishRename(id, name) {
    if (editingSessionId === id) {
      editingSessionId = null;
      if (name.trim()) {
        send({ type: 'rename', sessionId: id, name: name.trim() });
      }
      renderSessions();
    }
  }

  function switchSession(id) {
    activeSessionId = id;
    terminal.clear();
    send({ type: 'switch', sessionId: id });
    showTerminal();
    terminal.focus();
    renderSessions();

    // Send resize info
    send({
      type: 'resize',
      sessionId: id,
      cols: terminal.cols,
      rows: terminal.rows,
    });
  }

  function showTerminal() {
    terminalEl.classList.add('visible');
    noSessionEl.classList.add('hidden');
    fitAddon.fit();
  }

  function showNoSession() {
    terminalEl.classList.remove('visible');
    noSessionEl.classList.remove('hidden');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Start the app
  init();
})();
