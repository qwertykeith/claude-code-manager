// Claude Manager Frontend
(function() {
  let ws = null;
  let terminal = null;
  let fitAddon = null;
  let sessions = [];
  let activeSessionId = null;
  let editingSessionId = null;
  let pendingCreate = false;

  // Debounce utility - batches rapid calls to prevent DOM race conditions
  function debounce(fn, delay) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // Debounced render for WebSocket updates - prevents click race conditions
  const debouncedRenderSessions = debounce(() => renderSessions(), 16);

  // DOM elements
  const sessionsList = document.getElementById('sessions-list');
  const archivedList = document.getElementById('archived-list');
  const archivedHeader = document.getElementById('archived-header');
  const archivedCount = document.getElementById('archived-count');
  const terminalEl = document.getElementById('terminal');
  const noSessionEl = document.getElementById('no-session');
  const newSessionBtn = document.getElementById('new-session');
  const openVscodeBtn = document.getElementById('open-vscode');
  const usageSessionBar = document.getElementById('usage-session-bar');
  const usageSessionTime = document.getElementById('usage-session-time');
  const usageWeeklyBar = document.getElementById('usage-weekly-bar');
  const usageWeeklyTime = document.getElementById('usage-weekly-time');
  const usageSessionContainer = document.getElementById('usage-session-container');
  const usageWeeklyContainer = document.getElementById('usage-weekly-container');

  // State
  let planLimits = {};
  let currentUsage = null; // JSONL estimate fallback
  let accurateUsage = null; // From /status
  let usageSource = null; // 'claude-status' or 'jsonl-estimate'

  // Initialize
  function init() {
    initTerminal();
    initWebSocket();
    initEventListeners();
  }

  function initTerminal() {
    terminal = new Terminal({
      theme: {
        background: '#1a1a1a',
        foreground: '#e8e8e8',
        cursor: '#d97757',
        selection: 'rgba(217, 119, 87, 0.3)',
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

    openVscodeBtn.addEventListener('click', () => {
      send({ type: 'open-vscode' });
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

    // Event delegation for session list clicks (archive + selection)
    sessionsList.addEventListener('click', (e) => {
      const archiveBtn = e.target.closest('.archive-btn-inline');
      if (archiveBtn) {
        e.stopPropagation();
        const sessionId = archiveBtn.dataset.id;
        // If archiving active session, switch to another first
        if (activeSessionId === sessionId) {
          const otherSession = sessions.find(s => !s.archived && s.id !== sessionId);
          if (otherSession) {
            switchSession(otherSession.id);
          } else {
            activeSessionId = null;
            showNoSession();
          }
        }
        send({ type: 'archive', sessionId });
        return;
      }

      // Session selection
      const sessionItem = e.target.closest('.session-item');
      if (sessionItem && !e.target.closest('button') && !e.target.closest('input')) {
        switchSession(sessionItem.dataset.id);
      }
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
        debouncedRenderSessions();
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
          // Surgical DOM update - just update the status dot, don't re-render
          // This preserves hover state so clicks still work during rapid output
          updateSessionStatus(msg.sessionId, msg.status);
        }
        break;

      case 'summary':
        const sess = sessions.find((s) => s.id === msg.sessionId);
        if (sess) {
          sess.summary = msg.summary;
          sess.originalPrompt = msg.originalPrompt;
          debouncedRenderSessions();
        }
        break;

      case 'reload':
        console.log('[dev] Reloading page...');
        location.reload();
        break;

      case 'usage':
        planLimits = msg.planLimits || {};
        usageSource = msg.source || 'jsonl-estimate';
        if (msg.accurate) {
          accurateUsage = msg.accurate;
        }
        if (msg.usage) {
          currentUsage = msg.usage;
        }
        updateUsageDisplay();
        break;

      case 'context':
        const ctxSession = sessions.find(s => s.id === msg.sessionId);
        if (ctxSession) {
          ctxSession.contextPct = msg.pct;
          ctxSession.contextDisplay = msg.display;
          updateSessionContext(msg.sessionId, msg.display, msg.pct);
        }
        break;
    }
  }

  function updateUsageDisplay() {
    // Prefer accurate data, fall back to estimate
    if (accurateUsage && usageSource === 'claude-status') {
      // Accurate data from /status
      const session = accurateUsage.session || {};
      const weekAll = accurateUsage.weekAll || {};

      // Session display
      if (session.percent !== null && session.percent !== undefined) {
        const pct = session.percent;
        usageSessionBar.style.width = `${pct}%`;
        usageSessionBar.className = 'usage-bar-fill' + (pct >= 90 ? ' critical' : pct >= 70 ? ' warning' : '');
        const timeUntil = formatTimeUntil(parseResetTime(session.resetTime));
        usageSessionTime.textContent = timeUntil || '--';
        usageSessionContainer.title = `Session: ${pct}% used${session.resetTime ? ' • resets ' + session.resetTime : ''}`;
      } else {
        usageSessionBar.style.width = '0%';
        usageSessionTime.textContent = '--';
      }

      // Weekly display
      if (weekAll.percent !== null && weekAll.percent !== undefined) {
        const pct = weekAll.percent;
        usageWeeklyBar.style.width = `${pct}%`;
        usageWeeklyBar.className = 'usage-bar-fill' + (pct >= 90 ? ' critical' : pct >= 70 ? ' warning' : '');
        const timeUntil = formatTimeUntil(parseResetTime(weekAll.resetTime));
        usageWeeklyTime.textContent = timeUntil || '--';
        usageWeeklyContainer.title = `Weekly: ${pct}% used${weekAll.resetTime ? ' • resets ' + weekAll.resetTime : ''}`;
      } else {
        usageWeeklyBar.style.width = '0%';
        usageWeeklyTime.textContent = '--';
      }

    } else if (currentUsage) {
      // Fallback to JSONL estimate
      usageSessionBar.style.width = '0%';
      usageSessionTime.textContent = '~';
      usageSessionContainer.title = 'Estimate unavailable - couldn\'t fetch from Claude';
      usageWeeklyBar.style.width = '0%';
      usageWeeklyTime.textContent = '~';
      usageWeeklyContainer.title = 'Weekly data unavailable - couldn\'t fetch from Claude';

    } else {
      // No data yet
      usageSessionBar.style.width = '0%';
      usageSessionTime.textContent = '--';
      usageWeeklyBar.style.width = '0%';
      usageWeeklyTime.textContent = '--';
    }
  }

  // Surgical update for status changes - doesn't replace DOM, preserves hover state
  function updateSessionStatus(sessionId, status) {
    const sessionEl = document.querySelector(`.session-item[data-id="${sessionId}"]`);
    if (!sessionEl) return;

    // Update status dot class
    const dot = sessionEl.querySelector('.status-dot');
    if (dot) {
      dot.className = `status-dot ${status}`;
    }

    // Update badge (waiting/draft indicator)
    const meta = sessionEl.querySelector('.session-meta');
    if (meta) {
      // Remove existing badges
      meta.querySelectorAll('.waiting-badge, .draft-badge').forEach(b => b.remove());

      // Add new badge if needed
      if (status === 'waiting') {
        const badge = document.createElement('span');
        badge.className = 'waiting-badge';
        badge.textContent = '?';
        meta.insertBefore(badge, meta.firstChild);
      } else if (status === 'draft') {
        const badge = document.createElement('span');
        badge.className = 'draft-badge';
        badge.textContent = '✎';
        meta.insertBefore(badge, meta.firstChild);
      }
    }
  }

  // Surgical update for context changes
  function updateSessionContext(sessionId, display, pct) {
    const sessionEl = document.querySelector(`.session-item[data-id="${sessionId}"]`);
    if (!sessionEl) return;

    const meta = sessionEl.querySelector('.session-meta');
    if (!meta) return;

    let ctxEl = meta.querySelector('.context-indicator');
    if (!ctxEl) {
      // Create on first update - insert before session-time
      ctxEl = document.createElement('span');
      ctxEl.className = 'context-indicator';
      const timeEl = meta.querySelector('.session-time');
      if (timeEl) {
        meta.insertBefore(ctxEl, timeEl);
      } else {
        meta.appendChild(ctxEl);
      }
    }

    ctxEl.textContent = display;
    ctxEl.className = 'context-indicator' + (pct >= 95 ? ' critical' : pct >= 80 ? ' warning' : '');
  }

  function renderSessions() {
    const sortByDate = (a, b) => new Date(b.lastActivity || b.createdAt) - new Date(a.lastActivity || a.createdAt);
    const active = sessions.filter((s) => !s.archived).sort(sortByDate);
    const archived = sessions.filter((s) => s.archived).sort(sortByDate);

    sessionsList.innerHTML = active.map((s) => renderSessionItem(s, false)).join('');
    archivedList.innerHTML = archived.map((s) => renderSessionItem(s, true)).join('');
    archivedCount.textContent = `(${archived.length})`;

    // Note: session-item clicks and archive-btn-inline are handled via delegation in initEventListeners()

    document.querySelectorAll('.unarchive-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        send({ type: 'unarchive', sessionId: btn.dataset.id });
      });
    });

    document.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        send({ type: 'delete', sessionId: btn.dataset.id });
        if (activeSessionId === btn.dataset.id) {
          activeSessionId = null;
          showNoSession();
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

    const contextIndicator = session.contextDisplay
      ? `<span class="context-indicator${session.contextPct >= 95 ? ' critical' : session.contextPct >= 80 ? ' warning' : ''}">${session.contextDisplay}</span>`
      : '';

    const timeAgo = relativeTime(session.lastActivity || session.createdAt);

    return `
      <li class="session-item ${isActive ? 'active' : ''}" data-id="${session.id}">
        <div class="session-row">
          <span class="status-dot ${session.status}"></span>
          <div class="session-content">
            <div class="session-meta">
              ${statusBadge}
              ${contextIndicator}
              <span class="session-time">${timeAgo}</span>
              <div class="session-actions-inline">${actions}</div>
            </div>
            ${contentHtml}
          </div>
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

  function relativeTime(isoString) {
    if (!isoString) return '';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  // Parse reset time string and return ms until reset
  function parseResetTime(resetStr) {
    if (!resetStr) return null;
    const now = new Date();

    // Session format: "10:59pm" - assumes today or tomorrow
    const timeMatch = resetStr.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const mins = parseInt(timeMatch[2] || '0');
      const isPM = timeMatch[3].toLowerCase() === 'pm';
      if (isPM && hours !== 12) hours += 12;
      if (!isPM && hours === 12) hours = 0;

      const reset = new Date(now);
      reset.setHours(hours, mins, 0, 0);
      if (reset <= now) reset.setDate(reset.getDate() + 1);
      return reset.getTime() - now.getTime();
    }

    // Weekly format: "Jan 3, 2026, 10:59am" or "Jan 3, 10:59am"
    const dateMatch = resetStr.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})?,?\s*(\d{1,2}):?(\d{2})?\s*(am|pm)/i);
    if (dateMatch) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = months[dateMatch[1].toLowerCase().slice(0, 3)];
      const day = parseInt(dateMatch[2]);
      const year = dateMatch[3] ? parseInt(dateMatch[3]) : now.getFullYear();
      let hours = parseInt(dateMatch[4]);
      const mins = parseInt(dateMatch[5] || '0');
      const isPM = dateMatch[6].toLowerCase() === 'pm';
      if (isPM && hours !== 12) hours += 12;
      if (!isPM && hours === 12) hours = 0;

      const reset = new Date(year, month, day, hours, mins, 0, 0);
      return reset.getTime() - now.getTime();
    }

    return null;
  }

  // Format ms until reset as relative string
  function formatTimeUntil(ms) {
    if (ms === null || ms < 0) return null;
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }

  // Start the app
  init();
})();
