/**
 * UI rendering helpers — keeps main.js clean
 */

// ── Toast notifications ──────────────────────────────────────────────────────
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const iconSymbol = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '!' : 'i';
  
  toast.innerHTML = `
    <span class="toast-icon">${iconSymbol}</span>
    <span style="flex:1; line-height:1.4;">${message}</span>
    <button class="toast-close-btn" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; font-size:16px; margin-left:8px; line-height:1;">&times;</button>
  `;

  // Close toast on click X
  const closeBtn = toast.querySelector('.toast-close-btn');
  closeBtn.addEventListener('click', () => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 250);
  });

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  // Auto dismiss after 3.5s
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }
  }, 3500);
}

// ── Loading state ────────────────────────────────────────────────────────────
export function setLoading(buttonEl, loading, text = 'Loading…') {
  if (loading) {
    buttonEl.dataset.originalText = buttonEl.textContent;
    buttonEl.textContent = text;
    buttonEl.disabled = true;
  } else {
    buttonEl.textContent = buttonEl.dataset.originalText || 'Done';
    buttonEl.disabled = false;
  }
}

// ── Render email list ────────────────────────────────────────────────────────
// ── Render email list ────────────────────────────────────────────────────────
export function renderEmailList(emails, onSummarize, onSelectChange, onOpenDetail) {
  const list = document.getElementById('email-list');
  list.innerHTML = '';

  if (!emails || emails.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📭</div>
      <p>No emails found. Try adjusting the sender or date filter.</p>
    </div>`;
    return;
  }

  emails.forEach((email) => {
    const card = document.createElement('div');
    card.className = `email-card ${email.isSelected ? 'selected' : ''} ${email.is_summarized ? 'summarized' : ''}`;
    card.dataset.id = email.id;
    card.innerHTML = `
      <div class="email-card-header">
        <div class="email-card-header-top">
          <input type="checkbox" class="email-select-checkbox" data-id="${email.id}" ${email.isSelected ? 'checked' : ''} title="Check to club in thread" />
          <div class="email-meta" style="flex:1">
            <span class="email-from">${escHtml(email.from)}</span>
            <span class="email-date">${formatDate(email.date)}</span>
          </div>
        </div>
        <h3 class="email-subject">${escHtml(email.subject || '(No subject)')}</h3>
        <p class="email-snippet">${escHtml(email.snippet || '')}</p>
        ${(email.attachments && email.attachments.length > 0) ? `
          <div style="display:inline-flex; align-items:center; gap:5px; margin-top:6px; font-size:11.5px; color:var(--text-muted); background:rgba(255,255,255,0.04); padding:2px 8px; border-radius:4px; border:1px solid var(--border-subtle);">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            ${email.attachments.length} ${email.attachments.length === 1 ? 'attachment' : 'attachments'}
          </div>
        ` : ''}
      </div>
      <div class="email-card-footer">
        <button class="btn btn-summarize ${email.is_summarized ? 'hidden' : ''}" data-id="${email.id}">
          <span class="btn-icon">✦</span> Summarize
        </button>
        <div class="summary-badge-wrapper ${email.is_summarized ? '' : 'hidden'}" style="display:flex; align-items:center; gap:8px;">
          <span class="summary-badge">
            ${email.is_clubbed ? `✦ Summarized in Thread (${email.email_count || 'Group'})` : '✦ Summarized'}
          </span>
          <button class="btn-resummarize btn-send-summary" data-id="${email.id}" title="Delete previous summary & re-summarize">
            🔄 Re-summarize
          </button>
        </div>
      </div>
      <div class="summary-body ${email.is_summarized ? '' : 'hidden'}">
        ${email.is_summarized ? `
          <div class="summary-content">
            <div class="summary-label">✦ AI Summary</div>
            <p>${escHtml(email.summary)}</p>
          </div>
        ` : ''}
      </div>
    `;

    // Single summarize click
    const btn = card.querySelector('.btn-summarize');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onSummarize(email.id, card, false);
      });
    }

    // Re-summarize click
    const resummarizeBtn = card.querySelector('.btn-resummarize');
    if (resummarizeBtn) {
      resummarizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onSummarize(email.id, card, true);
      });
    }

    // Checkbox change handler (for thread clubbing)
    const checkbox = card.querySelector('.email-select-checkbox');
    if (checkbox) {
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) card.classList.add('selected');
        else card.classList.remove('selected');
        if (onSelectChange) onSelectChange(email.id, e.target.checked);
      });
    }

    // Card click opens full email detail modal!
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-summarize') || e.target.closest('.btn-resummarize') || e.target.closest('.email-select-checkbox') || e.target.closest('.summary-body')) {
        return;
      }
      if (onOpenDetail) onOpenDetail(email, card);
    });

    list.appendChild(card);
  });
}

// ── Inline summary in card ───────────────────────────────────────────────────
export function renderInlineSummary(card, summary, isClub = false, clubCount = 0) {
  const body = card.querySelector('.summary-body');
  const badgeWrapper = card.querySelector('.summary-badge-wrapper');
  const badge = card.querySelector('.summary-badge');
  const btn = card.querySelector('.btn-summarize');
  body.innerHTML = `
    <div class="summary-content">
      <div class="summary-label">✦ AI Summary</div>
      <p>${escHtml(summary)}</p>
    </div>
  `;
  body.classList.remove('hidden');
  if (badge) badge.textContent = isClub ? `✦ Summarized in Thread (${clubCount} Emails)` : '✦ Summarized';
  if (badgeWrapper) badgeWrapper.classList.remove('hidden');
  if (btn) btn.classList.add('hidden');
  card.classList.add('summarized');
}

// ── Render summary cards (stored) ────────────────────────────────────────────
export function renderSummaryCards(summaries, onForward, onDelete) {
  const grid = document.getElementById('summaries-grid');
  grid.innerHTML = '';

  if (!summaries || summaries.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🗂️</div>
      <p>No summaries stored yet. Summarize some emails first.</p>
    </div>`;
    return;
  }

  summaries.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'summary-card glass-card';
    const isClub = s.is_clubbed || s.email_count > 1;
    const deleteId = s.doc_id || s.message_id;
    card.innerHTML = `
      <div class="sc-header">
        <div class="sc-from">${escHtml(s.from)}</div>
        <div class="sc-date">${formatDate(s.date)}</div>
      </div>
      <h4 class="sc-subject">${escHtml(s.subject || '(No subject)')}</h4>
      <p class="sc-summary">${escHtml(s.summary)}</p>
      <div class="sc-footer" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
        <span class="sc-tag ${isClub ? 'club-tag' : ''}">
          ${isClub ? `✦ Thread Summary (${s.email_count || 'Multi'} Emails)` : '✦ Summarized'}
        </span>
        <div style="display:flex; gap:6px;">
          <button class="btn-send-summary btn-forward" data-subject="${escHtml(s.subject || '')}" data-summary="${escHtml(s.summary)}">
            ✉️ Forward
          </button>
          <button class="btn-send-summary btn-delete-card" style="color:#f87171;" data-id="${escHtml(deleteId)}" title="Delete this summary from FAISS">
            🗑️ Delete
          </button>
        </div>
      </div>
    `;

    const forwardBtn = card.querySelector('.btn-forward');
    if (forwardBtn && onForward) {
      forwardBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onForward(s.subject, s.summary);
      });
    }

    const deleteBtn = card.querySelector('.btn-delete-card');
    if (deleteBtn && onDelete) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete(deleteId, card);
      });
    }

    grid.appendChild(card);
  });
}

// ── Render search results ────────────────────────────────────────────────────
export function renderSearchResults(results, aiAnswer = '') {
  const topMatchContainer = document.getElementById('search-top-match-container');
  const otherMatchesTitle = document.getElementById('search-other-matches-title');
  const otherMatchesList = document.getElementById('search-other-matches-list');
  const initialEmpty = document.getElementById('search-initial-empty');

  if (topMatchContainer) topMatchContainer.innerHTML = '';
  if (otherMatchesList) otherMatchesList.innerHTML = '';
  if (otherMatchesTitle) otherMatchesTitle.style.display = 'none';
  if (initialEmpty) initialEmpty.style.display = 'none';

  if (!results || results.length === 0) {
    if (topMatchContainer) {
      topMatchContainer.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>No high-confidence semantic matches found. Try refining your keywords!</p>
      </div>`;
    }
    return;
  }

  // 0. Render AI Synthesized Direct Answer (RAG)
  if (aiAnswer) {
    const aiAnswerCard = document.createElement('div');
    aiAnswerCard.className = 'glass-card ai-answer-box';
    aiAnswerCard.style.border = '1px solid rgba(139, 92, 246, 0.4)';
    aiAnswerCard.style.background = 'rgba(139, 92, 246, 0.08)';
    aiAnswerCard.style.padding = '16px 20px';
    aiAnswerCard.style.borderRadius = '12px';
    aiAnswerCard.style.marginBottom = '20px';
    aiAnswerCard.style.boxShadow = '0 4px 20px rgba(139, 92, 246, 0.12)';
    aiAnswerCard.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-weight: 700; color: #a78bfa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
        <span>✨</span> AI Direct Answer
      </div>
      <p style="font-size: 14px; line-height: 1.6; color: var(--text-primary); margin: 0; font-weight: 500;">
        ${escHtml(aiAnswer)}
      </p>
    `;
    topMatchContainer.appendChild(aiAnswerCard);
  }

  // 1. Render Top-1 Best Match
  const topDoc = results[0];
  const topScore = Math.round(topDoc.score * 100);
  if (topMatchContainer) {
    const card = document.createElement('div');
    card.className = 'search-result-card glass-card best-match-card';
    card.style.border = '2px solid var(--accent-primary)';
    card.style.boxShadow = '0 8px 30px rgba(99,102,241,0.15)';
    card.style.background = 'rgba(99,102,241,0.04)';
    card.innerHTML = `
      <div style="background:var(--accent-primary); color:white; font-size:10px; font-weight:700; text-transform:uppercase; padding:3px 10px; border-radius:3px; display:inline-block; margin-bottom:12px;">🎯 Best Match (Top-1)</div>
      <div class="sr-body">
        <div class="sr-meta">
          <span class="sr-from" style="font-weight:700; color:var(--text-primary);">${escHtml(topDoc.from)}</span>
          <span class="sr-date">${formatDate(topDoc.date)}</span>
          <span class="sr-score" style="color:var(--accent-primary); font-weight:700; background:rgba(99,102,241,0.1); padding:2px 8px; border-radius:12px;">${topScore}% match</span>
        </div>
        <h3 class="sr-subject" style="font-size:16px; margin:8px 0; color:var(--text-primary); font-weight:700;">${escHtml(topDoc.subject || '(No subject)')}</h3>
        <p class="sr-summary" style="line-height:1.5; color:var(--text-secondary);">${escHtml(topDoc.summary)}</p>
      </div>
    `;
    topMatchContainer.appendChild(card);
  }

  // 2. Render other matches
  const otherDocs = results.slice(1);
  if (otherDocs.length > 0) {
    if (otherMatchesTitle) otherMatchesTitle.style.display = 'block';
    if (otherMatchesList) {
      otherDocs.forEach((r, idx) => {
        const card = document.createElement('div');
        card.className = 'search-result-card glass-card';
        const score = Math.round(r.score * 100);
        card.innerHTML = `
          <div class="sr-rank">#${idx + 2}</div>
          <div class="sr-body">
            <div class="sr-meta">
              <span class="sr-from">${escHtml(r.from)}</span>
              <span class="sr-date">${formatDate(r.date)}</span>
              <span class="sr-score">${score}% match</span>
            </div>
            <h4 class="sr-subject">${escHtml(r.subject || '(No subject)')}</h4>
            <p class="sr-summary">${escHtml(r.summary)}</p>
          </div>
        `;
        otherMatchesList.appendChild(card);
      });
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function decodeHtmlEntities(str = '') {
  const txt = document.createElement('textarea');
  txt.innerHTML = String(str);
  return txt.value;
}

export function escHtml(str) {
  if (str === null || str === undefined) return '';
  const decoded = decodeHtmlEntities(str);
  return String(decoded)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

export function renderActivityLogs(logs) {
  const container = document.getElementById('logs-list');
  if (!container) return;
  container.innerHTML = '';

  if (!logs || logs.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <p>No activity logs recorded yet.</p>
    </div>`;
    return;
  }

  const table = document.createElement('table');
  table.className = 'log-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width: 20%;">Time</th>
        <th style="width: 25%;">Action</th>
        <th style="width: 45%;">Details</th>
        <th style="width: 10%;">Status</th>
      </tr>
    </thead>
    <tbody>
      ${logs.map(log => {
        const statusClass = log.status?.toLowerCase() === 'error' ? 'error' : 'success';
        let formattedTime = log.timestamp;
        try {
          formattedTime = new Date(log.timestamp).toLocaleString('en-IN', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit'
          });
        } catch {}
        return `
          <tr>
            <td class="log-time">${formattedTime}</td>
            <td><span class="log-action-badge">${escHtml(log.action)}</span></td>
            <td class="log-details">${escHtml(log.details)}</td>
            <td><span class="log-status-badge ${statusClass}">${escHtml(log.status)}</span></td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
  container.appendChild(table);
}

// ── Render Cloudflare R2 Documents ───────────────────────────────────────────
export function renderR2Documents(documents, onDelete, onPreview) {
  const container = document.getElementById('r2-documents-grid');
  if (!container) return;
  container.innerHTML = '';

  if (!documents || documents.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1; padding: 40px 20px;">
      <div class="empty-icon">📁</div>
      <p style="font-size:15px; font-weight:600; color:var(--text-primary); margin-bottom:6px;">No documents found matching this filter.</p>
      <p style="font-size:13px; color:var(--text-muted);">Incoming email attachments and outgoing sent files will automatically appear here.</p>
    </div>`;
    return;
  }

  documents.forEach(doc => {
    const card = document.createElement('div');
    card.className = 'glass-card r2-doc-card';
    card.style.cssText = 'padding: 16px; border: 1px solid var(--border-subtle); border-radius: 12px; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; transition: transform 0.2s ease, box-shadow 0.2s ease;';

    const isIncoming = doc.direction === 'incoming';
    const directionBadge = isIncoming
      ? `<span style="background: rgba(52, 211, 153, 0.12); color: #34d399; font-weight: 700; font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(52, 211, 153, 0.25);">📥 Received</span>`
      : `<span style="background: rgba(96, 165, 250, 0.12); color: #60a5fa; font-weight: 700; font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(96, 165, 250, 0.25);">📤 Sent</span>`;

    const associatedLabel = isIncoming ? 'From' : 'To';
    const ext = (doc.filename || '').split('.').pop().toLowerCase();
    let fileIcon = '📄';
    if (['pdf'].includes(ext)) fileIcon = '📕';
    else if (['doc', 'docx'].includes(ext)) fileIcon = '📘';
    else if (['xls', 'xlsx', 'csv'].includes(ext)) fileIcon = '📗';
    else if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext)) fileIcon = '🖼️';
    else if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) fileIcon = '📦';

    let formattedSize = '';
    if (doc.size_bytes > 0) {
      if (doc.size_bytes < 1024 * 1024) {
        formattedSize = (doc.size_bytes / 1024).toFixed(1) + ' KB';
      } else {
        formattedSize = (doc.size_bytes / (1024 * 1024)).toFixed(2) + ' MB';
      }
    }

    card.innerHTML = `
      <div>
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
            <span style="font-size: 24px; line-height: 1;">${fileIcon}</span>
            <div style="min-width: 0;">
              <h4 style="margin: 0; font-size: 14px; font-weight: 700; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escHtml(doc.filename)}">
                ${escHtml(doc.filename)}
              </h4>
              ${formattedSize ? `<span style="font-size: 11px; color: var(--text-muted);">${formattedSize}</span>` : ''}
            </div>
          </div>
          ${directionBadge}
        </div>

        <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <strong style="color: var(--text-primary);">${associatedLabel}:</strong> ${escHtml(doc.associated_email || 'Inbox / Direct')}
        </div>

        <div style="font-size: 12px; color: var(--text-muted); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escHtml(doc.subject)}">
          <strong style="color: var(--text-secondary);">Subject:</strong> ${escHtml(doc.subject || 'Attachment')}
        </div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 10px; margin-top: 4px;">
        <span style="font-size: 11px; color: var(--text-muted);">${formatDate(doc.date)}</span>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn btn-secondary btn-sm btn-preview-r2" style="padding: 4px 10px; font-size: 12px; font-weight: 500; height: 28px; display: inline-flex; align-items: center; gap: 5px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            Preview
          </button>
          ${doc.download_url ? `
            <a href="${doc.download_url}" target="_blank" rel="noopener noreferrer" download="${escHtml(doc.filename)}" class="btn btn-primary btn-sm" style="text-decoration: none; padding: 4px 10px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
              ⬇️ Download
            </a>
          ` : `
            <span style="font-size: 11px; color: var(--text-muted);">No link</span>
          `}
          <button class="btn btn-ghost btn-sm btn-delete-r2" data-key="${escHtml(doc.key)}" style="padding: 4px 8px; color: #f87171; border-color: transparent;" title="Delete file from R2">
            🗑️
          </button>
        </div>
      </div>
    `;

    const previewBtn = card.querySelector('.btn-preview-r2');
    if (previewBtn && onPreview) {
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onPreview(doc);
      });
    }

    const deleteBtn = card.querySelector('.btn-delete-r2');
    if (deleteBtn && onDelete) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete(doc.key, card);
      });
    }

    container.appendChild(card);
  });
}
