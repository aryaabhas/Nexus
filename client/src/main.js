import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { firebaseConfig } from './firebase-config.js';
import {
  verifyToken,
  fetchEmails,
  summarizeEmails,
  summarizeEmailClub,
  sendEmail,
  getSummaries,
  searchEmails,
  getKnowledgeGraph,
  getGraphAnalytics,
  askGraph,
  rebuildKnowledgeGraph,
  deleteSummary,
  getActivityLogs,
  getReplies,
  dismissReply,
  getThread,
  getScratchpad,
  saveScratchpad,
  getR2Documents,
  deleteR2Document,
  syncR2InboxAttachments,
} from './api.js';
import { GraphVisualizer } from './graph-visualizer.js';
import './style.css';
import {
  showToast,
  setLoading,
  renderEmailList,
  renderInlineSummary,
  renderSummaryCards,
  renderSearchResults,
  renderActivityLogs,
  renderR2Documents,
} from './ui.js';

// ── Firebase setup ────────────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/gmail.readonly');
provider.addScope('https://www.googleapis.com/auth/gmail.send');
provider.addScope('https://www.googleapis.com/auth/gmail.compose');

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let oauthToken = localStorage.getItem('gmail_oauth_token') || null;
let oauthTokenTime = parseInt(localStorage.getItem('gmail_oauth_token_time') || '0', 10);
let idToken = null;        // Firebase ID token (for backend auth guard)
let emailCache = [];       // Raw emails from last fetch

const inFlightSummaries = new Set();
let isSummarizingClub = false;
let isSummarizingAll = false;

function saveOauthToken(token) {
  oauthToken = token;
  oauthTokenTime = Date.now();
  localStorage.setItem('gmail_oauth_token', token);
  localStorage.setItem('gmail_oauth_token_time', oauthTokenTime.toString());
}

function clearOauthToken() {
  oauthToken = null;
  oauthTokenTime = 0;
  localStorage.removeItem('gmail_oauth_token');
  localStorage.removeItem('gmail_oauth_token_time');
}

async function getOrRefreshOauthToken(forceRefresh = false) {
  const age = Date.now() - oauthTokenTime;
  const isExpired = !oauthToken || age > 45 * 60 * 1000; // 45 minutes

  if (!isExpired && !forceRefresh) {
    return oauthToken;
  }

  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const newToken = credential.accessToken;
    saveOauthToken(newToken);
    if (result.user) {
      idToken = await result.user.getIdToken();
    }
    return newToken;
  } catch (err) {
    clearOauthToken();
    throw new Error('Please authorize Gmail access to proceed.');
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginSection   = document.getElementById('login-section');
const appSection     = document.getElementById('app-section');
const userAvatar     = document.getElementById('user-avatar');
const userName       = document.getElementById('user-name');
const userEmail      = document.getElementById('user-email');
const signInBtn      = document.getElementById('sign-in-btn');
const signOutBtn     = document.getElementById('sign-out-btn');
const senderInput    = document.getElementById('sender-filter');
const datePresetFilter = document.getElementById('date-preset-filter');
const customDateContainer = document.getElementById('custom-date-container');
const startDateInput = document.getElementById('start-date-input');
const endDateInput   = document.getElementById('end-date-input');
const fetchBtn       = document.getElementById('fetch-btn');
const summarizeAllBtn= document.getElementById('summarize-all-btn');
const refreshBtn     = document.getElementById('refresh-summaries-btn');
const searchInput    = document.getElementById('search-input');
const searchBtn      = document.getElementById('search-btn');
const tabBtns        = document.querySelectorAll('.tab-btn');
const tabPanels      = document.querySelectorAll('.tab-panel');

// CRM / Profiles DOM refs
const crmProfileSearch = document.getElementById('crm-profile-search');
const profilesList     = document.getElementById('profiles-list');
const profileDetailCard = document.getElementById('profile-detail-card');

// Kanban / Operations Board DOM refs
const addKanbanTaskBtn = document.getElementById('add-kanban-task-btn');
const taskModal        = document.getElementById('task-modal');
const closeTaskModalBtn = document.getElementById('close-task-modal-btn');
const taskIdInput      = document.getElementById('task-id-input');
const taskTitleInput   = document.getElementById('task-title-input');
const taskDescInput    = document.getElementById('task-desc-input');
const taskStatusSelect = document.getElementById('task-status-select');
const taskDeleteBtn    = document.getElementById('task-delete-btn');
const taskCancelBtn    = document.getElementById('task-cancel-btn');
const taskSaveBtn      = document.getElementById('task-save-btn');
const replyModalConvertTaskBtn = document.getElementById('reply-modal-convert-task-btn');

const kanbanTodo       = document.getElementById('kanban-todo');
const kanbanInprogress = document.getElementById('kanban-inprogress');
const kanbanDone       = document.getElementById('kanban-done');
const todoCount        = document.getElementById('todo-count');
const inprogressCount  = document.getElementById('inprogress-count');
const doneCount        = document.getElementById('done-count');

// Toggle custom date picker visibility when "Custom Date Range" is selected
if (datePresetFilter) {
  datePresetFilter.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      customDateContainer?.classList.remove('hidden');
    } else {
      customDateContainer?.classList.add('hidden');
    }
  });
}
const rebuildGraphBtn= document.getElementById('rebuild-graph-btn');
const graphCanvas    = document.getElementById('graph-canvas');
const graphInspector = document.getElementById('graph-inspector');
const inspectorIcon  = document.getElementById('inspector-icon');
const inspectorTitle = document.getElementById('inspector-title');
const inspectorType  = document.getElementById('inspector-type');
const inspectorBody  = document.getElementById('inspector-body');
const filterCheckboxes = document.querySelectorAll('[data-filter]');

// Club Action Bar DOM elements
const clubActionBar    = document.getElementById('club-action-bar');
const clubCountBadge   = document.getElementById('club-count-badge');
const selectAllBtn     = document.getElementById('select-all-btn');
const clearSelectionBtn= document.getElementById('clear-selection-btn');
const summarizeClubBtn = document.getElementById('summarize-club-btn');

let graphVisualizer   = null;
let selectedMessageIds = new Set();

// ── Email Selection & Club Bar Handlers ────────────────────────────────────────
function updateSelectionState() {
  const count = selectedMessageIds.size;
  if (count > 0) {
    if (clubCountBadge) clubCountBadge.textContent = `${count} email${count > 1 ? 's' : ''} selected`;
    if (clubActionBar) clubActionBar.classList.remove('hidden');
  } else {
    if (clubActionBar) clubActionBar.classList.add('hidden');
  }
}

function handleSelectChange(messageId, isChecked) {
  if (isChecked) {
    selectedMessageIds.add(messageId);
  } else {
    selectedMessageIds.delete(messageId);
  }
  const cached = emailCache.find((e) => e.id === messageId);
  if (cached) cached.isSelected = isChecked;
  updateSelectionState();
}

// Select All / Clear Selection / Summarize Club Click Listeners
if (selectAllBtn) {
  selectAllBtn.addEventListener('click', () => {
    selectedMessageIds.clear();
    emailCache.forEach((e) => {
      e.isSelected = true;
      selectedMessageIds.add(e.id);
    });
    renderEmailList(emailCache, handleSingleSummarize, handleSelectChange, openEmailDetailModal);
    updateSelectionState();
  });
}

if (clearSelectionBtn) {
  clearSelectionBtn.addEventListener('click', () => {
    selectedMessageIds.clear();
    emailCache.forEach((e) => (e.isSelected = false));
    renderEmailList(emailCache, handleSingleSummarize, handleSelectChange, openEmailDetailModal);
    updateSelectionState();
  });
}

if (summarizeClubBtn) {
  summarizeClubBtn.addEventListener('click', async () => {
    if (isSummarizingClub) return;
    const ids = Array.from(selectedMessageIds);
    if (!ids.length) return;

    isSummarizingClub = true;
    summarizeClubBtn.disabled = true;

    try {
      await getOrRefreshOauthToken();
    } catch (err) {
      showToast('You must authorize Gmail access to summarize.', 'error');
      isSummarizingClub = false;
      summarizeClubBtn.disabled = false;
      return;
    }

    setLoading(summarizeClubBtn, true, `Summarizing ${ids.length}…`);
    try {
      idToken = await currentUser.getIdToken();
      const res = await summarizeEmailClub(ids, oauthToken, idToken);

      showToast(`Clubbed & summarized ${res.email_count || ids.length} emails!`, 'success');

      // Update email cache items
      emailCache.forEach((e) => {
        if (ids.includes(e.id)) {
          e.is_summarized = true;
          e.is_clubbed = true;
          e.email_count = res.email_count;
          e.summary = res.summary;
          
          const card = document.querySelector(`.email-card[data-id="${e.id}"]`);
          if (card) {
            renderInlineSummary(card, res.summary, true, res.email_count);
          }
        }
      });

      // Clear selection
      selectedMessageIds.clear();
      emailCache.forEach((e) => (e.isSelected = false));
      renderEmailList(emailCache, handleSingleSummarize, handleSelectChange, openEmailDetailModal);
      updateSelectionState();
    } catch (err) {
      showToast(err.message || 'Failed to summarize group', 'error');
    } finally {
      isSummarizingClub = false;
      setLoading(summarizeClubBtn, false, '✦ Summarize Group');
    }
  });
}

// Compose Modal DOM refs
const openComposeBtn   = document.getElementById('open-compose-btn');
const composeModal     = document.getElementById('compose-modal');
const closeComposeBtn  = document.getElementById('close-compose-btn');
const cancelComposeBtn = document.getElementById('cancel-compose-btn');
const sendEmailBtn     = document.getElementById('send-email-btn');
const composeToInput   = document.getElementById('compose-to');
const composeSubjectInput = document.getElementById('compose-subject');
const composeBodyText  = document.getElementById('compose-body-text');

// Attachment DOM refs
const addAttachmentBtn = document.getElementById('add-attachment-btn');
const composeFileInput = document.getElementById('compose-file-input');
const attachmentsPreview = document.getElementById('attachments-preview');

let composeFiles = [];

function renderAttachmentPreviews() {
  if (!attachmentsPreview) return;
  attachmentsPreview.innerHTML = '';
  
  composeFiles.forEach((file, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `
      <span>📎</span>
      <span class="attachment-chip-name" title="Click to preview ${file.name}" style="cursor:pointer;">${file.name}</span>
      <button type="button" class="remove-file-btn" data-index="${idx}">&times;</button>
    `;

    chip.querySelector('.attachment-chip-name').addEventListener('click', (e) => {
      e.stopPropagation();
      const objUrl = URL.createObjectURL(file);
      if (activePreviewBlobUrl) {
        try { URL.revokeObjectURL(activePreviewBlobUrl); } catch (_) {}
      }
      activePreviewBlobUrl = objUrl;
      openFilePreview({
        name: file.name,
        url: objUrl,
        downloadUrl: objUrl,
        contentType: file.type,
        size: file.size,
        meta: `${formatAttachmentSize(file.size)} · Outgoing File`,
        blob: file
      });
    });
    
    chip.querySelector('.remove-file-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      composeFiles.splice(idx, 1);
      renderAttachmentPreviews();
    });
    
    attachmentsPreview.appendChild(chip);
  });
}

if (addAttachmentBtn && composeFileInput) {
  addAttachmentBtn.addEventListener('click', () => {
    composeFileInput.click();
  });

  composeFileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      composeFiles = [...composeFiles, ...files];
      renderAttachmentPreviews();
      composeFileInput.value = '';
    }
  });
}

function openCompose(to = '', subject = '', body = '', clearAttachments = true) {
  if (composeToInput) composeToInput.value = to;
  if (composeSubjectInput) composeSubjectInput.value = subject;
  if (composeBodyText) composeBodyText.value = body;
  if (clearAttachments) {
    composeFiles = [];
  }
  renderAttachmentPreviews();
  
  // Hide AI Panel by default on open
  const aiPanel = document.getElementById('ai-draft-assist-panel');
  if (aiPanel) aiPanel.classList.add('hidden');
  const aiDesc = document.getElementById('ai-draft-description');
  if (aiDesc) aiDesc.value = '';
  
  if (composeModal) composeModal.classList.remove('hidden');
}

function closeCompose() {
  if (composeModal) composeModal.classList.add('hidden');
  if (composeToInput) composeToInput.value = '';
  if (composeSubjectInput) composeSubjectInput.value = '';
  if (composeBodyText) composeBodyText.value = '';
  
  // Clean up AI Panel fields
  const aiPanel = document.getElementById('ai-draft-assist-panel');
  if (aiPanel) aiPanel.classList.add('hidden');
  const aiDesc = document.getElementById('ai-draft-description');
  if (aiDesc) aiDesc.value = '';
  
  composeFiles = [];
  renderAttachmentPreviews();
}

function handleForwardSummary(subject, summary) {
  const fwdSubject = subject ? (subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`) : 'Fwd: Email Summary';
  const fwdBody = `Hi,\n\nHere is an AI summary of the email thread:\n\n${summary}\n\nSent via Email Tracker Workspace`;
  openCompose('', fwdSubject, fwdBody);
}

if (openComposeBtn) {
  openComposeBtn.addEventListener('click', () => openCompose());
}

if (closeComposeBtn) {
  closeComposeBtn.addEventListener('click', closeCompose);
}

// Wire AI Draft Assist Panel Buttons
const aiDraftToggleBtn = document.getElementById('ai-draft-assist-toggle-btn');
const aiDraftPanel = document.getElementById('ai-draft-assist-panel');
const aiDraftGenerateBtn = document.getElementById('ai-draft-generate-btn');

if (aiDraftToggleBtn && aiDraftPanel) {
  aiDraftToggleBtn.addEventListener('click', () => {
    aiDraftPanel.classList.toggle('hidden');
  });
}

if (aiDraftGenerateBtn) {
  aiDraftGenerateBtn.addEventListener('click', async () => {
    const persona = document.getElementById('ai-draft-persona').value;
    const description = document.getElementById('ai-draft-description').value.trim();
    const recipient = document.getElementById('compose-to').value.trim();
    
    if (!description) {
      showToast('Please provide a brief product or service description.', 'error');
      return;
    }
    
    setLoading(aiDraftGenerateBtn, true, 'Drafting…');
    try {
      idToken = await currentUser.getIdToken();
      const res = await fetch('/api/emails/draft', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          persona: persona,
          product_description: description,
          recipient_email: recipient || null,
          additional_context: ''
        })
      });
      
      if (!res.ok) throw new Error('Failed to generate draft email');
      
      const data = await res.json();
      if (data.status === 'success' && data.draft) {
        if (composeSubjectInput) composeSubjectInput.value = data.draft.subject || '';
        if (composeBodyText) composeBodyText.value = data.draft.body || '';
        showToast('AI Draft generated successfully!', 'success');
        // Hide panel after success
        if (aiDraftPanel) aiDraftPanel.classList.add('hidden');
      } else {
        throw new Error('Malformed draft payload returned from server');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(aiDraftGenerateBtn, false);
    }
  });
}

if (cancelComposeBtn) {
  cancelComposeBtn.addEventListener('click', closeCompose);
}

if (composeModal) {
  composeModal.addEventListener('click', (e) => {
    if (e.target === composeModal) closeCompose();
  });
}

// ── Full Email Detail Modal Refs & Handlers ────────────────────────────────────
const emailDetailModal       = document.getElementById('email-detail-modal');
const closeDetailModalBtn    = document.getElementById('close-detail-modal-btn');
const modalCloseBottomBtn    = document.getElementById('modal-close-bottom-btn');
const modalEmailSubject      = document.getElementById('modal-email-subject');
const modalEmailFrom         = document.getElementById('modal-email-from');
const modalEmailDate         = document.getElementById('modal-email-date');
const modalSummaryBox        = document.getElementById('modal-summary-box');
const modalEmailSummary      = document.getElementById('modal-email-summary');
const modalEmailBody         = document.getElementById('modal-email-body');
const modalSummarizeBtn      = document.getElementById('modal-summarize-btn');
const modalScheduleBtn       = document.getElementById('modal-schedule-btn');
const modalForwardBtn        = document.getElementById('modal-forward-btn');

let activeModalEmail = null;
let activeModalCard  = null;

if (modalScheduleBtn) {
  modalScheduleBtn.addEventListener('click', () => {
    if (!activeModalEmail) return;
    const emailToSchedule = activeModalEmail;
    closeEmailDetailModal();

    const textToScan = (emailToSchedule.subject || '') + ' ' + (emailToSchedule.summary || '') + ' ' + (emailToSchedule.snippet || '') + ' ' + (emailToSchedule.body || '');
    const detectedDateStr = parseTargetDateFromText(textToScan, emailToSchedule.date);

    openCalendarModal({
      id: '',
      title: emailToSchedule.subject || '',
      date: detectedDateStr,
      time: '10:00',
      category: inferEventCategory(textToScan),
      description: '',
      notifyBefore: 15
    });
  });
}

function openEmailDetailModal(email, card) {
  activeModalEmail = email;
  activeModalCard  = card;

  if (modalEmailSubject) modalEmailSubject.textContent = email.subject || '(No subject)';
  if (modalEmailFrom) modalEmailFrom.textContent = email.from || 'Unknown';
  if (modalEmailDate) modalEmailDate.textContent = email.date || '';
  if (modalEmailBody) modalEmailBody.textContent = email.body || email.snippet || '(No content available)';

  if (email.is_summarized && email.summary) {
    if (modalEmailSummary) modalEmailSummary.textContent = email.summary;
    if (modalSummaryBox) modalSummaryBox.classList.remove('hidden');
    if (modalSummarizeBtn) modalSummarizeBtn.classList.add('hidden');
  } else {
    if (modalSummaryBox) modalSummaryBox.classList.add('hidden');
    if (modalSummarizeBtn) modalSummarizeBtn.classList.remove('hidden');
  }

  // Populate attachments section
  const attSection = document.getElementById('modal-attachments-section');
  const attCount = document.getElementById('modal-attachments-count');
  const attList = document.getElementById('modal-attachments-list');
  const attachments = email.attachments || [];

  if (attSection && attCount && attList) {
    if (attachments.length > 0) {
      attSection.classList.remove('hidden');
      attCount.textContent = attachments.length;
      attList.innerHTML = '';

      attachments.forEach(att => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:6px; gap:10px;';
        
        const ext = (att.filename.split('.').pop() || '').toUpperCase();
        const sizeStr = att.size ? formatAttachmentSize(att.size) : '';

        item.innerHTML = `
          <div style="display:flex; align-items:center; gap:8px; min-width:0; flex:1;">
            <span style="font-size:10px; font-weight:700; background:rgba(255,255,255,0.08); padding:2px 5px; border-radius:3px; color:var(--text-secondary);">${escHtml(ext || 'FILE')}</span>
            <div style="min-width:0;">
              <div style="font-size:12.5px; font-weight:500; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escHtml(att.filename)}">${escHtml(att.filename)}</div>
              ${sizeStr ? `<span style="font-size:11px; color:var(--text-muted);">${sizeStr}</span>` : ''}
            </div>
          </div>
          <div style="display:flex; gap:6px; flex-shrink:0;">
            <button type="button" class="btn btn-secondary btn-sm btn-preview-att" style="height:28px; padding:0 10px; font-size:11.5px; display:inline-flex; align-items:center; gap:4px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              Preview
            </button>
            <button type="button" class="btn btn-ghost btn-sm btn-download-att" title="Download" style="height:28px; padding:0 8px; font-size:11.5px; display:inline-flex; align-items:center; gap:4px; color:var(--text-muted);">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
          </div>
        `;

        item.querySelector('.btn-preview-att').addEventListener('click', (e) => {
          e.stopPropagation();
          previewAttachment(email.id, att.attachmentId, att.filename, email.from, email.subject);
        });

        item.querySelector('.btn-download-att').addEventListener('click', (e) => {
          e.stopPropagation();
          downloadAttachment(email.id, att.attachmentId, att.filename);
        });

        attList.appendChild(item);
      });
    } else {
      attSection.classList.add('hidden');
      attList.innerHTML = '';
    }
  }

  if (emailDetailModal) emailDetailModal.classList.remove('hidden');
}

function closeEmailDetailModal() {
  if (emailDetailModal) emailDetailModal.classList.add('hidden');
  const attSection = document.getElementById('modal-attachments-section');
  if (attSection) attSection.classList.add('hidden');
  const attList = document.getElementById('modal-attachments-list');
  if (attList) attList.innerHTML = '';
  activeModalEmail = null;
  activeModalCard  = null;
}

if (closeDetailModalBtn) closeDetailModalBtn.addEventListener('click', closeEmailDetailModal);
if (modalCloseBottomBtn) modalCloseBottomBtn.addEventListener('click', closeEmailDetailModal);
if (emailDetailModal) {
  emailDetailModal.addEventListener('click', (e) => {
    if (e.target === emailDetailModal) closeEmailDetailModal();
  });
}

if (modalSummarizeBtn) {
  modalSummarizeBtn.addEventListener('click', async () => {
    if (!activeModalEmail || !activeModalCard) return;
    setLoading(modalSummarizeBtn, true, 'Summarizing…');
    try {
      await handleSingleSummarize(activeModalEmail.id, activeModalCard);
      // Update modal UI
      activeModalEmail.is_summarized = true;
      if (modalEmailSummary) modalEmailSummary.textContent = activeModalEmail.summary;
      if (modalSummaryBox) modalSummaryBox.classList.remove('hidden');
      if (modalSummarizeBtn) modalSummarizeBtn.classList.add('hidden');
    } catch (err) {
      showToast(err.message || 'Summarization failed', 'error');
    } finally {
      setLoading(modalSummarizeBtn, false, '✦ Summarize This Email');
    }
  });
}

if (modalForwardBtn) {
  modalForwardBtn.addEventListener('click', () => {
    if (!activeModalEmail) return;
    const subj = activeModalEmail.subject || '';
    const summaryOrSnippet = activeModalEmail.summary || activeModalEmail.snippet || '';
    closeEmailDetailModal();
    handleForwardSummary(subj, summaryOrSnippet);
  });
}

const modalReplyBtn = document.getElementById('modal-reply-btn');
if (modalReplyBtn) {
  modalReplyBtn.addEventListener('click', () => {
    if (!activeModalEmail) return;
    
    // Parse sender email address from "From: Name <email@domain.com>" format
    let replyTo = '';
    const fromHeader = activeModalEmail.from || '';
    const bracketMatch = fromHeader.match(/<([^>]+)>/);
    if (bracketMatch && bracketMatch[1]) {
      replyTo = bracketMatch[1].trim();
    } else {
      replyTo = fromHeader.trim();
    }

    const originalSubject = activeModalEmail.subject || '';
    const reSubject = originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`;
    const cleanSnippet = activeModalEmail.snippet || '';
    const originalDate = activeModalEmail.date || '';
    const replyBody = `\n\nOn ${originalDate}, ${fromHeader} wrote:\n> ${cleanSnippet}`;

    closeEmailDetailModal();
    openCompose(replyTo, reSubject, replyBody);
  });
}

if (sendEmailBtn) {
  sendEmailBtn.addEventListener('click', async () => {
    const to = composeToInput?.value.trim();
    const subject = composeSubjectInput?.value.trim();
    const body = composeBodyText?.value.trim();

    if (!to || !subject) {
      showToast('Please enter recipient email and subject.', 'error');
      return;
    }

    try {
      await getOrRefreshOauthToken();
    } catch (err) {
      showToast('You must authorize Gmail access to send emails.', 'error');
      return;
    }

    setLoading(sendEmailBtn, true, 'Sending…');
    try {
      idToken = await currentUser.getIdToken();
      await sendEmail(oauthToken, idToken, to, subject, body, composeFiles);
      showToast(`Email sent successfully to ${to}!`, 'success');
      closeCompose();
    } catch (err) {
      const errMsg = err.message || '';
      const isAuthErr = errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('PERMISSION') || errMsg.includes('SCOPE') || errMsg.includes('invalid_grant');
      if (isAuthErr) {
        showToast('Gmail send permission expired or requires authorization. Re-authenticating…', 'warning');
        try {
          const result = await signInWithPopup(auth, provider);
          const credential = GoogleAuthProvider.credentialFromResult(result);
          oauthToken = credential.accessToken;
          saveOauthToken(oauthToken);
          idToken = await result.user.getIdToken();
          await sendEmail(oauthToken, idToken, to, subject, body, composeFiles);
          showToast(`Email sent successfully to ${to}!`, 'success');
          closeCompose();
        } catch (retryErr) {
          showToast(retryErr.message || 'Send failed', 'error');
        }
      } else {
        showToast(errMsg || 'Failed to send email', 'error');
      }
    } finally {
      setLoading(sendEmailBtn, false, 'Send Email');
    }
  });
}

// Window Focus Listener: sync data when the user returns to the tab
window.addEventListener('focus', () => {
  if (currentUser) {
    console.log('[Sync] Browser window focused. Checking replies and updating graph in background...');
    checkReplies();
    loadGraph();
  }
});

// Manual Sync Button Click
const manualSyncBtn = document.getElementById('manual-sync-btn');
if (manualSyncBtn) {
  manualSyncBtn.addEventListener('click', async () => {
    setLoading(manualSyncBtn, true, 'Syncing…');
    try {
      showToast('Syncing inbox from Gmail...', 'info');
      await checkReplies();
      await loadGraph();
      showToast('Inbox synced successfully!', 'success');
    } catch (err) {
      showToast(err.message || 'Sync failed', 'error');
    } finally {
      setLoading(manualSyncBtn, false, '🔄 Sync Inbox');
    }
  });
}

// ── Auth state listener ───────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    idToken = await user.getIdToken();
    showApp(user);
    loadCalendarEvents();
    checkReplies();
    // Auto-fetch emails on login / page load so they display by default
    performEmailFetch(true);
  } else {
    currentUser = null;
    oauthToken = null;
    idToken = null;
    showLogin();
  }
});

// ── Auth actions ──────────────────────────────────────────────────────────────
signInBtn.addEventListener('click', async () => {
  setLoading(signInBtn, true, 'Signing in…');
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    oauthToken = credential.accessToken;
    localStorage.setItem('gmail_oauth_token', oauthToken);
    // Backend token verification
    idToken = await result.user.getIdToken();
    await verifyToken(idToken);
    showToast('Signed in successfully!', 'success');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Sign-in failed', 'error');
    setLoading(signInBtn, false);
  }
});

signOutBtn.addEventListener('click', async () => {
  localStorage.removeItem('gmail_oauth_token');
  await signOut(auth);
  showToast('Signed out', 'info');
});

// ── Tab navigation ─────────────────────────────────────────────────────────────
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach((b) => b.classList.remove('active'));
    tabPanels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${target}`).classList.add('active');

    if (target === 'graph') {
      loadGraph();
    } else if (target === 'logs') {
      loadActivityLogs();
    } else if (target === 'scratchpad') {
      loadScratchpadContent();
    } else if (target === 'profiles') {
      loadProfiles();
    } else if (target === 'kanban') {
      loadKanbanBoard();
    }
  });
});

// ── Knowledge Graph logic ──────────────────────────────────────────────────────
async function loadGraph() {
  if (!graphCanvas) return;
  if (!graphVisualizer) {
    graphVisualizer = new GraphVisualizer(graphCanvas, handleNodeSelect);
  }
  try {
    idToken = await currentUser.getIdToken();
    const analytics = await getGraphAnalytics(idToken);
    
    // Set nodes, edges, and anomalies into force-directed visualizer engine
    graphVisualizer.setData(analytics.nodes || [], analytics.edges || [], analytics.anomalies || []);

    // Render PageRank Leaderboard
    renderPageRankLeaderboard(analytics.top_entities || []);

    // Render Risk Anomalies
    renderGraphAnomalies(analytics.anomalies || []);

  } catch (err) {
    showToast(err.message || 'Failed to load Knowledge Graph', 'error');
  }
}

function renderPageRankLeaderboard(topEntities) {
  const container = document.getElementById('pagerank-leaderboard-list');
  if (!container) return;

  if (!topEntities || topEntities.length === 0) {
    container.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">No centrality metrics calculated.</div>';
    return;
  }

  const icons = { sender: '👤', email: '✉️', organization: '🏢', topic: '🏷️', action_item: '⚡' };
  
  container.innerHTML = topEntities.map((e) => {
    const icon = icons[e.type] || '📌';
    const percent = Math.round((e.pagerank || 0.2) * 100);
    return `
      <div class="pagerank-item" data-node-id="${e.id}" style="padding:8px 10px; background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); cursor:pointer; transition:all 0.15s ease;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span style="font-size:12.5px; font-weight:600; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:170px;">
            ${icon} ${e.label}
          </span>
          <span style="font-size:11px; font-weight:700; color:var(--accent-primary);">${e.pagerank}</span>
        </div>
        <div style="height:4px; width:100%; background:rgba(255,255,255,0.08); border-radius:2px; overflow:hidden;">
          <div style="height:100%; width:${percent}%; background:var(--accent-primary);"></div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.pagerank-item').forEach((item) => {
    item.addEventListener('click', () => {
      const nodeId = item.dataset.nodeId;
      if (graphVisualizer) graphVisualizer.panToNode(nodeId);
    });
  });
}

function renderGraphAnomalies(anomalies) {
  const container = document.getElementById('anomalies-list');
  const countBadge = document.getElementById('anomalies-count-badge');
  if (countBadge) countBadge.textContent = anomalies ? anomalies.length : 0;
  if (!container) return;

  if (!anomalies || anomalies.length === 0) {
    container.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">No structural risks detected.</div>';
    return;
  }

  container.innerHTML = anomalies.map((a) => {
    const isHigh = a.severity === 'HIGH';
    const badgeColor = isHigh ? '#ef4444' : '#f59e0b';
    return `
      <div class="anomaly-card" style="padding:10px; background:rgba(239, 68, 68, 0.04); border:1px solid rgba(239, 68, 68, 0.2); border-radius:var(--radius-sm); display:flex; flex-direction:column; gap:4px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:12px; font-weight:700; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:180px;">⚠️ ${a.title}</span>
          <span style="font-size:9.5px; font-weight:700; background:${badgeColor}; color:#fff; padding:1px 5px; border-radius:3px;">${a.severity}</span>
        </div>
        <div style="font-size:11.5px; color:var(--text-secondary); line-height:1.4;">${a.description}</div>
        <div style="display:flex; justify-content:flex-end; margin-top:4px;">
          <button class="focus-anomaly-btn btn btn-ghost btn-sm" data-target-id="${a.target_node_id}" style="padding:2px 6px; font-size:11px; color:var(--accent-primary);">🎯 Focus in Graph</button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.focus-anomaly-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.targetId;
      if (graphVisualizer && targetId) graphVisualizer.panToNode(targetId);
    });
  });
}

// ── Ask the Graph AI Handlers ──────────────────────────────────────────────────
const askGraphInput = document.getElementById('ask-graph-input');
const askGraphBtn = document.getElementById('ask-graph-btn');
const askGraphResponseBox = document.getElementById('ask-graph-response-box');
const askGraphResponseText = document.getElementById('ask-graph-response-text');
const closeAskGraphResponseBtn = document.getElementById('close-ask-graph-response-btn');

async function handleAskGraph() {
  if (!askGraphInput) return;
  const query = askGraphInput.value.trim();
  if (!query) {
    showToast('Please type a question to ask the Knowledge Graph.', 'warning');
    return;
  }

  setLoading(askGraphBtn, true, '✦ Analyzing…');
  try {
    idToken = await currentUser.getIdToken();
    const res = await askGraph(query, idToken);

    if (askGraphResponseBox && askGraphResponseText) {
      askGraphResponseText.textContent = res.answer || 'No answer generated by graph AI.';
      askGraphResponseBox.classList.remove('hidden');
    }
  } catch (err) {
    showToast(err.message || 'Failed to query graph AI', 'error');
  } finally {
    setLoading(askGraphBtn, false, '✦ Ask AI');
  }
}

if (askGraphBtn) askGraphBtn.addEventListener('click', handleAskGraph);
if (askGraphInput) {
  askGraphInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAskGraph();
    }
  });
}
if (closeAskGraphResponseBtn && askGraphResponseBox) {
  closeAskGraphResponseBtn.addEventListener('click', () => {
    askGraphResponseBox.classList.add('hidden');
  });
}

function handleNodeSelect(node) {
  if (!node) {
    if (graphInspector) graphInspector.classList.add('hidden');
    return;
  }
  if (graphInspector) graphInspector.classList.remove('hidden');

  const icons = { sender: '👤', email: '✉️', organization: '🏢', topic: '🏷️', action_item: '⚡' };
  if (inspectorIcon) inspectorIcon.textContent = icons[node.type] || '📌';
  if (inspectorTitle) inspectorTitle.textContent = node.label || 'Node Detail';
  if (inspectorType) inspectorType.textContent = node.type || 'Entity';

  let html = '';
  if (node.metadata) {
    if (node.metadata.subject) html += `<div class="inspector-field"><div class="inspector-label">Subject</div><div class="inspector-val">${node.metadata.subject}</div></div>`;
    if (node.metadata.summary) html += `<div class="inspector-field"><div class="inspector-label">Summary</div><div class="inspector-val">${node.metadata.summary}</div></div>`;
    if (node.metadata.date) html += `<div class="inspector-field"><div class="inspector-label">Date</div><div class="inspector-val">${node.metadata.date}</div></div>`;
    if (node.metadata.raw) html += `<div class="inspector-field"><div class="inspector-label">Address</div><div class="inspector-val">${node.metadata.raw}</div></div>`;
  }

  // Action Item Track Completion Status
  if (node.type === 'action_item') {
    const isCompleted = localStorage.getItem('graph_action_completed_' + node.id) === 'true';
    html += `
      <div style="margin-top: 16px; padding: 12px; background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);">
        <div class="inspector-label" style="margin-bottom:8px;">Task Tracker</div>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:var(--text-primary);">
          <input type="checkbox" id="action-item-checkbox" data-node-id="${node.id}" ${isCompleted ? 'checked' : ''} style="cursor:pointer;" />
          <span style="user-select:none;">Mark as Completed</span>
        </label>
      </div>
    `;
  }

  if (inspectorBody) {
    inspectorBody.innerHTML = html || '<p>Node connected in graph.</p>';
    
    // Hook change event to save completion state
    const chk = inspectorBody.querySelector('#action-item-checkbox');
    if (chk) {
      chk.addEventListener('change', (e) => {
        localStorage.setItem('graph_action_completed_' + node.id, e.target.checked);
        showToast(e.target.checked ? 'Action item marked as completed.' : 'Action item marked as pending.', 'success');
      });
    }
  }
}

// Filter chips toggle
filterCheckboxes.forEach((cb) => {
  cb.addEventListener('change', (e) => {
    const filterType = e.target.dataset.filter;
    const parentChip = e.target.closest('.chip');
    if (e.target.checked) parentChip?.classList.add('active');
    else parentChip?.classList.remove('active');

    if (graphVisualizer) {
      graphVisualizer.setFilter(filterType, e.target.checked);
    }
  });
});

const graphSearchInput = document.getElementById('graph-search-input');
if (graphSearchInput) {
  graphSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (graphVisualizer) {
        graphVisualizer.setSearchQuery(e.target.value.trim());
      }
    }
  });
}


// Rebuild graph button
if (rebuildGraphBtn) {
  rebuildGraphBtn.addEventListener('click', async () => {
    setLoading(rebuildGraphBtn, true, 'Rebuilding…');
    try {
      idToken = await currentUser.getIdToken();
      const res = await rebuildKnowledgeGraph(idToken);
      showToast(`Graph rebuilt with ${res.nodes_count || 0} nodes`, 'success');
      loadGraph();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(rebuildGraphBtn, false);
    }
  });
}


// Extract email fetching logic to a reusable function
async function performEmailFetch(silent = false) {
  try {
    await getOrRefreshOauthToken();
  } catch (err) {
    if (!silent) showToast('You must authorize Gmail access to fetch emails.', 'error');
    return;
  }

  const sender = senderInput.value.trim();
  const preset = datePresetFilter ? datePresetFilter.value : 'all';
  let days = null;
  let startDate = '';
  let endDate = '';

  if (preset === 'custom') {
    startDate = startDateInput ? startDateInput.value : '';
    endDate = endDateInput ? endDateInput.value : '';
  } else if (preset !== 'all') {
    days = parseInt(preset, 10);
  }

  if (!silent) setLoading(fetchBtn, true, 'Fetching…');
  try {
    idToken = await currentUser.getIdToken();
    selectedMessageIds.clear();
    updateSelectionState();
    const data = await fetchEmails(oauthToken, idToken, sender, days, startDate, endDate, 20);
    emailCache = data.emails || [];
    renderEmailList(emailCache, handleSingleSummarize, handleSelectChange, openEmailDetailModal);
    if (!silent) showToast(`Fetched ${emailCache.length} emails`, 'success');
    checkReplies();
    
    // Only enable "Summarize All" if there is at least one unsummarized email
    const unsummarized = emailCache.filter(e => !e.is_summarized);
    summarizeAllBtn.disabled = unsummarized.length === 0;
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('403')) {
      if (!silent) showToast('Refreshing Gmail session…', 'warning');
      try {
        await getOrRefreshOauthToken(true);
        const data = await fetchEmails(oauthToken, idToken, sender, days, startDate, endDate, 20);
        emailCache = data.emails || [];
        renderEmailList(emailCache, handleSingleSummarize, handleSelectChange, openEmailDetailModal);
        if (!silent) showToast(`Fetched ${emailCache.length} emails`, 'success');
        checkReplies();
      } catch (retryErr) {
        if (!silent) showToast('Gmail session expired. Please sign in again.', 'error');
      }
    } else {
      if (!silent) showToast(err.message, 'error');
    }
  } finally {
    if (!silent) setLoading(fetchBtn, false);
  }
}

// ── Fetch emails ──────────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', () => performEmailFetch(false));

// Automatically poll Gmail inbox list updates every 60 seconds (when authenticated)
setInterval(() => {
  if (currentUser && oauthToken) {
    performEmailFetch(true);
  }
}, 60000);

// ── Summarize / Re-summarize single email ─────────────────────────────────────
async function handleSingleSummarize(messageId, card, force = false) {
  if (inFlightSummaries.has(messageId)) return;
  inFlightSummaries.add(messageId);

  const btn = card ? (card.querySelector('.btn-resummarize') || card.querySelector('.btn-summarize')) : null;
  if (btn) {
    btn.disabled = true;
    setLoading(btn, true, force ? 'Re-summarizing…' : 'Summarizing…');
  }

  try {
    idToken = await currentUser.getIdToken();
    const data = await summarizeEmails([messageId], oauthToken, idToken, force);
    const result = data.results?.[0];
    
    if (result?.summary) {
      if (card) renderInlineSummary(card, result.summary);
      showToast(force ? 'Re-summarized & updated in FAISS ✓' : 'Summary stored in FAISS ✓', 'success');
      
      // Update cache
      const cached = emailCache.find(e => e.id === messageId);
      if (cached) {
        cached.is_summarized = true;
        cached.summary = result.summary;
        
        const unsummarized = emailCache.filter(e => !e.is_summarized);
        summarizeAllBtn.disabled = unsummarized.length === 0;
      }
      if (activeModalEmail && activeModalEmail.id === messageId) {
        activeModalEmail.summary = result.summary;
        activeModalEmail.is_summarized = true;
      }
    } else if (result?.status && result.status.includes('error')) {
      showToast(result.status, 'error');
    } else if (result?.status === 'already_stored' && !force) {
      showToast('Already stored in FAISS', 'info');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    inFlightSummaries.delete(messageId);
    if (btn) setLoading(btn, false, force ? '🔄 Re-summarize' : '✦ Summarize');
  }
}

// ── Delete summary ─────────────────────────────────────────────────────────────
async function handleDeleteSummary(messageId, card) {
  try {
    idToken = await currentUser.getIdToken();
    await deleteSummary(messageId, idToken);
    showToast('Summary deleted from FAISS', 'success');
    if (card) card.remove();
    
    // Update cache
    const cached = emailCache.find(e => e.id === messageId);
    if (cached) {
      cached.is_summarized = false;
      cached.summary = '';
    }
  } catch (err) {
    showToast(err.message || 'Failed to delete summary', 'error');
  }
}

// ── Summarize all fetched emails ──────────────────────────────────────────────
summarizeAllBtn.addEventListener('click', async () => {
  if (isSummarizingAll) return;
  const unsummarized = emailCache.filter(e => !e.is_summarized);
  if (unsummarized.length === 0) {
    showToast('All emails are already summarized!', 'info');
    return;
  }

  isSummarizingAll = true;
  summarizeAllBtn.disabled = true;
  
  try {
    await getOrRefreshOauthToken();
  } catch (err) {
    showToast('You must authorize Gmail access to summarize.', 'error');
    isSummarizingAll = false;
    summarizeAllBtn.disabled = false;
    return;
  }

  setLoading(summarizeAllBtn, true, 'Summarizing All…');
  try {
    idToken = await currentUser.getIdToken();
    const ids = unsummarized.map((e) => e.id);
    const data = await summarizeEmails(ids, oauthToken, idToken);
    
    data.results?.forEach((r) => {
      const card = document.querySelector(`.email-card[data-id="${r.message_id}"]`);
      if (card && r.summary) {
        renderInlineSummary(card, r.summary);
        const cached = emailCache.find(e => e.id === r.message_id);
        if (cached) {
          cached.is_summarized = true;
          cached.summary = r.summary;
        }
      }
    });
    
    summarizeAllBtn.disabled = true; // All done now
    showToast(`Summarized ${data.results?.length || 0} emails`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    isSummarizingAll = false;
    setLoading(summarizeAllBtn, false);
  }
});

// ── Load stored summaries ─────────────────────────────────────────────────────
refreshBtn.addEventListener('click', loadSummaries);

async function loadSummaries() {
  setLoading(refreshBtn, true, 'Loading…');
  try {
    idToken = await currentUser.getIdToken();
    const data = await getSummaries(idToken);
    renderSummaryCards(data.summaries || [], handleForwardSummary, handleDeleteSummary);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setLoading(refreshBtn, false);
  }
}

// ── Semantic search ───────────────────────────────────────────────────────────
searchBtn.addEventListener('click', handleSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSearch();
});

async function handleSearch() {
  const query = searchInput.value.trim();
  if (!query) return;
  const limitEl = document.getElementById('search-limit');
  const limit = limitEl ? parseInt(limitEl.value, 10) : 5;
  setLoading(searchBtn, true, 'Searching…');
  try {
    idToken = await currentUser.getIdToken();
    const data = await searchEmails(query, idToken, limit);
    renderSearchResults(data.results || [], data.answer || '');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setLoading(searchBtn, false);
  }
}

// ── DOM refs for header state ─────────────────────────────────────────────────
const headerGuest = document.getElementById('header-guest');
const headerUser = document.getElementById('header-user');

// ── UI show/hide ──────────────────────────────────────────────────────────────
function showApp(user) {
  loginSection.classList.add('hidden');
  appSection.classList.remove('hidden');
  
  if (headerGuest) headerGuest.classList.add('hidden');
  if (headerUser) headerUser.classList.remove('hidden');

  userAvatar.src = user.photoURL || '';
  userAvatar.alt = user.displayName || '';
  userName.textContent = user.displayName || 'User';
  userEmail.textContent = user.email || '';
  setLoading(signInBtn, false);
  loadScratchpadContent();
}

function showLogin() {
  loginSection.classList.remove('hidden');
  appSection.classList.add('hidden');

  if (headerGuest) headerGuest.classList.remove('hidden');
  if (headerUser) headerUser.classList.add('hidden');
}

// ── Activity Logs Logic ──────────────────────────────────────────────────────
const refreshLogsBtn = document.getElementById('refresh-logs-btn');
if (refreshLogsBtn) {
  refreshLogsBtn.addEventListener('click', loadActivityLogs);
}

async function loadActivityLogs() {
  const btn = document.getElementById('refresh-logs-btn');
  if (btn) setLoading(btn, true, 'Loading…');
  try {
    idToken = await currentUser.getIdToken();
    const data = await getActivityLogs(idToken);
    renderActivityLogs(data.logs || []);
  } catch (err) {
    showToast(err.message || 'Failed to load activity logs', 'error');
  } finally {
    if (btn) setLoading(btn, false);
  }
}

// ── Reply Notifications Logic ───────────────────────────────────────────────
const notificationCenter = document.getElementById('notification-center');
const notificationBellBtn = document.getElementById('notification-bell-btn');
const notificationBadge = document.getElementById('notification-badge');
const notificationDropdown = document.getElementById('notification-dropdown');
const notificationDropdownList = document.getElementById('notification-dropdown-list');
const shownAlertMsgIds = new Set();

// Reply Detailed Modal DOM refs
const replyDetailModal = document.getElementById('reply-detail-modal');
const closeReplyModalBtn = document.getElementById('close-reply-modal-btn');
const replyModalSubject = document.getElementById('reply-modal-subject');
const replyModalSender = document.getElementById('reply-modal-sender');
const replyModalThreadHistory = document.getElementById('reply-modal-thread-history');
const replyModalDismissBtn = document.getElementById('reply-modal-dismiss-btn');
const replyModalSummarizeBtn = document.getElementById('reply-modal-summarize-btn');
const replyModalComposeBtn = document.getElementById('reply-modal-compose-btn');
const replyModalCloseBtn = document.getElementById('reply-modal-close-btn');

let activeReplyAlert = null;

if (notificationBellBtn && notificationDropdown) {
  notificationBellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    notificationDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!notificationDropdown.classList.contains('hidden') && !notificationDropdown.contains(e.target) && e.target !== notificationBellBtn) {
      notificationDropdown.classList.add('hidden');
    }
  });
}

function closeReplyModal() {
  if (replyDetailModal) replyDetailModal.classList.add('hidden');
  activeReplyAlert = null;
}

if (closeReplyModalBtn) closeReplyModalBtn.addEventListener('click', closeReplyModal);
if (replyModalCloseBtn) replyModalCloseBtn.addEventListener('click', closeReplyModal);

if (replyModalDismissBtn) {
  replyModalDismissBtn.addEventListener('click', async () => {
    if (!activeReplyAlert) return;
    setLoading(replyModalDismissBtn, true, 'Dismissing…');
    try {
      idToken = await currentUser.getIdToken();
      await dismissReply(idToken, activeReplyAlert.thread_id);
      showToast('Alert dismissed successfully.', 'success');
      
      // Dismiss active floating notification card if visible
      const floatingCard = notificationCenter?.querySelector(`.notification-alert[data-thread-id="${activeReplyAlert.thread_id}"]`);
      if (floatingCard) {
        floatingCard.style.transform = 'translateX(120%)';
        floatingCard.style.opacity = '0';
        setTimeout(() => floatingCard.remove(), 300);
      }
      
      closeReplyModal();
      checkReplies();
    } catch (err) {
      showToast(err.message || 'Dismiss failed', 'error');
    } finally {
      setLoading(replyModalDismissBtn, false, 'Dismiss Reply Alert');
    }
  });
}

if (replyModalComposeBtn) {
  replyModalComposeBtn.addEventListener('click', () => {
    if (!activeReplyAlert) return;
    const reSubject = activeReplyAlert.subject.toLowerCase().startsWith('re:') ? activeReplyAlert.subject : `Re: ${activeReplyAlert.subject}`;
    closeReplyModal();
    openCompose(activeReplyAlert.reply_from, reSubject, `\n\nOn ${activeReplyAlert.sent_time}, ${activeReplyAlert.reply_from} wrote:\n> ${activeReplyAlert.reply_snippet}`);
  });
}

if (replyModalSummarizeBtn) {
  replyModalSummarizeBtn.addEventListener('click', async () => {
    if (!activeReplyAlert) return;
    setLoading(replyModalSummarizeBtn, true, 'Summarizing…');
    try {
      idToken = await currentUser.getIdToken();
      await getOrRefreshOauthToken();
      
      // Fetch thread messages to get ID
      const threadData = await getThread(oauthToken, idToken, activeReplyAlert.thread_id);
      const messages = threadData.messages || [];
      if (messages.length === 0) {
        throw new Error('No messages found in this thread.');
      }
      
      // Summarize the latest reply message
      const latestMsg = messages[messages.length - 1];
      const summaryRes = await summarizeEmails([latestMsg.id], oauthToken, idToken, true);
      showToast('Thread reply summarized and stored in FAISS!', 'success');
      closeReplyModal();
    } catch (err) {
      showToast(err.message || 'Summarization failed', 'error');
    } finally {
      setLoading(replyModalSummarizeBtn, false, '✦ Summarize & Store');
    }
  });
}

async function openReplyModal(alert) {
  activeReplyAlert = alert;
  if (replyModalSubject) replyModalSubject.textContent = alert.subject;
  if (replyModalSender) replyModalSender.textContent = alert.reply_from;
  if (replyModalThreadHistory) replyModalThreadHistory.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Loading thread conversation...</div>';
  
  if (replyDetailModal) replyDetailModal.classList.remove('hidden');
  
  // Instantly dismiss alert in backend once viewed by user
  try {
    const tempToken = await currentUser.getIdToken();
    await dismissReply(tempToken, alert.thread_id);
    const floatingCard = notificationCenter?.querySelector(`.notification-alert[data-thread-id="${alert.thread_id}"]`);
    if (floatingCard) {
      floatingCard.style.transform = 'translateX(120%)';
      floatingCard.style.opacity = '0';
      setTimeout(() => floatingCard.remove(), 300);
    }
    checkReplies();
  } catch (dismissErr) {
    console.error('Failed to auto-dismiss alert:', dismissErr);
  }
  
  try {
    idToken = await currentUser.getIdToken();
    await getOrRefreshOauthToken();
    const threadData = await getThread(oauthToken, idToken, alert.thread_id);
    const messages = threadData.messages || [];
    
    if (replyModalThreadHistory) {
      if (messages.length === 0) {
        replyModalThreadHistory.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">No messages found in thread history.</div>';
      } else {
        replyModalThreadHistory.innerHTML = '';
        messages.forEach(msg => {
          const item = document.createElement('div');
          item.className = 'thread-msg-item';
          
          let attachmentsHtml = '';
          const attachments = msg.attachments || [];
          if (attachments.length > 0) {
            attachmentsHtml = `<div class="msg-attachments-container" style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;">`;
            attachments.forEach(att => {
              attachmentsHtml += `
                <div style="display:inline-flex; align-items:center; background:rgba(255,255,255,0.05); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); overflow:hidden;">
                  <button type="button" class="btn btn-ghost btn-xs thread-att-preview-btn" 
                          style="padding:4px 8px; font-size:11.5px; display:flex; align-items:center; gap:4px; color:var(--text-primary); cursor:pointer; border:none; background:transparent;"
                          data-msg-id="${msg.id}" 
                          data-attachment-id="${att.attachmentId}" 
                          data-filename="${escHtml(att.filename)}">
                    📎 ${escHtml(att.filename)}
                  </button>
                  <button type="button" class="btn btn-ghost btn-xs thread-att-download-btn" 
                          title="Download file"
                          style="padding:4px 6px; font-size:11.5px; border-left:1px solid var(--border-subtle); color:var(--text-muted); cursor:pointer; border-top:none; border-bottom:none; border-right:none; background:transparent;"
                          data-msg-id="${msg.id}" 
                          data-attachment-id="${att.attachmentId}" 
                          data-filename="${escHtml(att.filename)}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </button>
                </div>
              `;
            });
            attachmentsHtml += `</div>`;
          }

          item.innerHTML = `
            <div class="thread-msg-meta">
              <span><strong>From:</strong> ${escHtml(msg.from)}</span>
              <span>${escHtml(msg.date)}</span>
            </div>
            <div class="thread-msg-body">${escHtml(msg.body || msg.snippet || '(No content)')}</div>
            ${attachmentsHtml}
          `;
          
          // Wire up preview & download click listeners
          item.querySelectorAll('.thread-att-preview-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              previewAttachment(
                btn.dataset.msgId,
                btn.dataset.attachmentId,
                btn.dataset.filename,
                msg.from || '',
                ''
              );
            });
          });
          item.querySelectorAll('.thread-att-download-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              downloadAttachment(
                btn.dataset.msgId,
                btn.dataset.attachmentId,
                btn.dataset.filename
              );
            });
          });
          
          replyModalThreadHistory.appendChild(item);
        });
        
        // Scroll to bottom of conversation
        replyModalThreadHistory.scrollTop = replyModalThreadHistory.scrollHeight;
      }
    }
  } catch (err) {
    if (replyModalThreadHistory) {
      replyModalThreadHistory.innerHTML = `<div style="color:#f87171; font-size:13px;">Failed to load history: ${escHtml(err.message)}</div>`;
    }
  }
}

async function checkReplies() {
  if (!currentUser) return;
  // Run client calendar alarm checking step
  checkCalendarAlarms();

  if (!oauthToken) return;
  try {
    idToken = await currentUser.getIdToken();
    const data = await getReplies(oauthToken, idToken);
    const alerts = data.alerts || [];
    renderReplyNotifications(alerts);
  } catch (err) {
    console.error('Failed to check for thread replies:', err);
  }
}

function renderReplyNotifications(emailAlerts) {
  const totalCount = emailAlerts.length + activeCalendarAlerts.length;

  if (notificationBadge) {
    if (totalCount > 0) {
      notificationBadge.textContent = totalCount;
      notificationBadge.classList.remove('hidden');
    } else {
      notificationBadge.classList.add('hidden');
    }
  }

  if (notificationDropdownList) {
    if (totalCount === 0) {
      notificationDropdownList.innerHTML = `<div class="no-alerts-msg">No active alerts</div>`;
    } else {
      notificationDropdownList.innerHTML = '';
      
      // 1. Render email alerts
      emailAlerts.forEach(alert => {
        const item = document.createElement('div');
        item.className = 'dropdown-alert-item';
        item.style.cursor = 'pointer';
        item.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="color:#34d399; font-size:12px;">🔔 Reply Received</strong>
            <button class="dismiss-dropdown-btn btn btn-ghost" style="padding:0 4px; font-size:14px; line-height:1;" data-thread-id="${alert.thread_id}">&times;</button>
          </div>
          <div style="font-weight:600; font-size:12px; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
            ${escHtml(alert.subject)}
          </div>
          <div style="font-size:11.5px; color:var(--text-muted); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
            <strong>From:</strong> ${escHtml(alert.reply_from)}
          </div>
        `;
        
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('dismiss-dropdown-btn')) return;
          notificationDropdown.classList.add('hidden');
          openReplyModal(alert);
        });

        item.querySelector('.dismiss-dropdown-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            idToken = await currentUser.getIdToken();
            await dismissReply(idToken, alert.thread_id);
            const floatingCard = notificationCenter?.querySelector(`.notification-alert[data-thread-id="${alert.thread_id}"]`);
            if (floatingCard) {
              floatingCard.style.transform = 'translateX(120%)';
              floatingCard.style.opacity = '0';
              setTimeout(() => floatingCard.remove(), 300);
            }
            checkReplies();
          } catch (err) {
            showToast(err.message || 'Dismiss failed', 'error');
          }
        });
        
        notificationDropdownList.appendChild(item);
      });

      // 2. Render calendar alarms
      activeCalendarAlerts.forEach(calAlert => {
        const item = document.createElement('div');
        item.className = 'dropdown-alert-item';
        item.style.cursor = 'pointer';
        item.style.borderLeft = '3px solid #818cf8';
        item.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="color:#818cf8; font-size:12px;">📅 Calendar Alert</strong>
            <button class="dismiss-cal-dropdown-btn btn btn-ghost" style="padding:0 4px; font-size:14px; line-height:1;" data-event-id="${calAlert.id}">&times;</button>
          </div>
          <div style="font-weight:600; font-size:12px; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
            ${escHtml(calAlert.title)}
          </div>
          <div style="font-size:11.5px; color:var(--text-muted);">
            Starts in ${calAlert.notifyBefore} mins (at ${calAlert.time})
          </div>
        `;

        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('dismiss-cal-dropdown-btn')) return;
          const calTabBtn = document.querySelector('.tab-btn[data-tab="calendar"]');
          if (calTabBtn) calTabBtn.click();
          notificationDropdown.classList.add('hidden');
          const matchedEvt = calendarEvents.find(e => e.id === calAlert.id);
          if (matchedEvt) openCalendarModal(matchedEvt);
        });

        item.querySelector('.dismiss-cal-dropdown-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          activeCalendarAlerts = activeCalendarAlerts.filter(a => a.id !== calAlert.id);
          const floatingCard = notificationCenter?.querySelector(`.notification-alert[data-calendar-event-id="${calAlert.id}"]`);
          if (floatingCard) {
            floatingCard.style.transform = 'translateX(120%)';
            floatingCard.style.opacity = '0';
            setTimeout(() => floatingCard.remove(), 300);
          }
          checkReplies();
        });

        notificationDropdownList.appendChild(item);
      });
    }
  }

  if (!notificationCenter) return;
  const existingThreadIds = Array.from(notificationCenter.querySelectorAll('.notification-alert'))
    .map(el => el.dataset.threadId);
    
  alerts.forEach(alert => {
    if (existingThreadIds.includes(alert.thread_id)) return;
    
    const msgId = alert.last_notified_msg_id || alert.thread_id;
    if (shownAlertMsgIds.has(msgId)) return;
    
    shownAlertMsgIds.add(msgId);
    
    const card = document.createElement('div');
    card.className = 'notification-alert';
    card.dataset.threadId = alert.thread_id;
    card.innerHTML = `
      <div class="notification-alert-header">
        <span class="notification-alert-title">🔔 Reply Received</span>
        <button class="dismiss-alert-btn" title="Dismiss Alert">&times;</button>
      </div>
      <div style="font-weight: 500; font-size: 13px; color: var(--text-primary); max-width: 290px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-bottom: 2px;">
        ${escHtml(alert.subject)}
      </div>
      <div class="notification-alert-body">
        <strong>From:</strong> ${escHtml(alert.reply_from)}<br>
        <em>"${escHtml(alert.reply_snippet)}"</em>
      </div>
    `;
    
    card.querySelector('.dismiss-alert-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      card.style.transform = 'translateX(120%)';
      card.style.opacity = '0';
      setTimeout(() => card.remove(), 300);
    });
    
    notificationCenter.appendChild(card);
  });
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// No client-side polling needed anymore. Inbox updates are handled in real-time via Gmail Pub/Sub Webhooks and Server-Sent Events (SSE).

// Poll local calendar alarms offline every 30 seconds (zero network/server logs footprint)
setInterval(checkCalendarAlarms, 30000);


// ── Scratchpad Notes Logic ──────────────────────────────────────────────────
const scratchpadText = document.getElementById('scratchpad-text');
const saveScratchpadBtn = document.getElementById('save-scratchpad-btn');
const scratchpadStatus = document.getElementById('scratchpad-status');
const scratchpadImportImageBtn = document.getElementById('scratchpad-import-image-btn');
const scratchpadImageLoader = document.getElementById('scratchpad-image-loader');

// PDF Actions Modal DOM refs
const exportPdfBtn = document.getElementById('export-pdf-btn');
const pdfActionsModal = document.getElementById('pdf-actions-modal');
const closePdfModalBtn = document.getElementById('close-pdf-modal-btn');
const pdfFilenameInput = document.getElementById('pdf-filename-input');
const pdfDownloadBtn = document.getElementById('pdf-download-btn');
const pdfShareBtn = document.getElementById('pdf-share-btn');
const pdfCancelBtn = document.getElementById('pdf-cancel-btn');

let autosaveTimeout = null;

if (saveScratchpadBtn && scratchpadText) {
  saveScratchpadBtn.addEventListener('click', () => saveScratchpadContent(false));
  
  // Autosave listener on HTML changes
  scratchpadText.addEventListener('input', () => {
    if (scratchpadStatus) scratchpadStatus.textContent = 'Typing...';
    clearTimeout(autosaveTimeout);
    autosaveTimeout = setTimeout(() => {
      saveScratchpadContent(true);
    }, 1000);
  });

  // Paste handler to catch copy-pasted images
  scratchpadText.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') === 0) {
        e.preventDefault();
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          const container = createImgContainer(event.target.result);
          
          // Insert at current cursor position
          const selection = window.getSelection();
          if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            range.insertNode(container);
            range.collapse(false);
          } else {
            scratchpadText.appendChild(container);
          }
          saveScratchpadContent(true);
        };
        reader.readAsDataURL(blob);
      }
    }
  });

  // Handle click on delete button to remove image container
  scratchpadText.addEventListener('click', (e) => {
    if (e.target.classList.contains('img-remove-btn')) {
      const container = e.target.closest('.scratchpad-img-container');
      if (container) {
        container.remove();
        saveScratchpadContent(true);
      }
    }
  });

  // Prevent browser-native image dragging which duplicates elements inside contenteditable
  scratchpadText.addEventListener('dragstart', (e) => {
    if (e.target.nodeName === 'IMG' || e.target.closest('.scratchpad-img-container')) {
      e.preventDefault();
    }
  });

  // Handle dropped files to prevent double-rendering bugs
  scratchpadText.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      e.preventDefault();
      const file = files[0];
      if (file.type.indexOf('image') === 0) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const container = createImgContainer(event.target.result);
          scratchpadText.appendChild(container);
          saveScratchpadContent(true);
        };
        reader.readAsDataURL(file);
      }
    }
  });
}

// Helper to construct interactive image container HTML
function createImgContainer(src) {
  const container = document.createElement('div');
  container.className = 'scratchpad-img-container';
  container.contentEditable = 'false';
  container.draggable = false;
  // ChatGPT style preview block wrapper
  container.style.position = 'relative';
  container.style.display = 'block';
  container.style.margin = '12px 0';
  
  const img = document.createElement('img');
  img.src = src;
  img.style.width = '180px';
  img.style.height = '180px';
  img.style.objectFit = 'cover';
  img.style.display = 'block';
  img.style.borderRadius = 'var(--radius-md)';
  img.style.border = '1px solid var(--border-subtle)';
  img.style.boxShadow = 'var(--shadow-md)';
  img.draggable = false;
  
  const removeBtn = document.createElement('button');
  removeBtn.className = 'img-remove-btn';
  removeBtn.innerHTML = '&times;';
  // Hover/delete badge positioned over corner
  removeBtn.style.position = 'absolute';
  removeBtn.style.top = '-8px';
  removeBtn.style.right = '-8px';
  removeBtn.style.background = '#ef4444';
  removeBtn.style.color = 'white';
  removeBtn.style.border = 'none';
  removeBtn.style.borderRadius = '50%';
  removeBtn.style.width = '20px';
  removeBtn.style.height = '20px';
  removeBtn.style.fontSize = '14px';
  removeBtn.style.fontWeight = 'bold';
  removeBtn.style.lineHeight = '18px';
  removeBtn.style.textAlign = 'center';
  removeBtn.style.cursor = 'pointer';
  removeBtn.style.opacity = '0';
  removeBtn.style.transition = 'opacity 0.2s, transform 0.2s';
  removeBtn.style.display = 'flex';
  removeBtn.style.alignItems = 'center';
  removeBtn.style.justifyContent = 'center';
  removeBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';

  container.appendChild(img);
  container.appendChild(removeBtn);
  return container;
}

// Import Image handler
if (scratchpadImportImageBtn && scratchpadImageLoader) {
  scratchpadImportImageBtn.addEventListener('click', () => {
    scratchpadImageLoader.click();
  });

  scratchpadImageLoader.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const container = createImgContainer(event.target.result);
        scratchpadText.appendChild(container);
        saveScratchpadContent(true);
        scratchpadImageLoader.value = '';
      };
      reader.readAsDataURL(file);
    }
  });
}

// PDF Modal toggle
if (exportPdfBtn && pdfActionsModal) {
  exportPdfBtn.addEventListener('click', () => {
    pdfActionsModal.classList.remove('hidden');
  });
}

function closePdfModal() {
  if (pdfActionsModal) pdfActionsModal.classList.add('hidden');
}

if (closePdfModalBtn) closePdfModalBtn.addEventListener('click', closePdfModal);
if (pdfCancelBtn) pdfCancelBtn.addEventListener('click', closePdfModal);

// Helper to generate jsPDF document (Parsing rich nodes & extracting embedded images)
function generatePdfDoc() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  doc.setFont('Helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(30, 30, 30);
  
  let y = 15;
  const children = Array.from(scratchpadText.childNodes);
  
  children.forEach(node => {
    if (y > 275) {
      doc.addPage();
      y = 15;
    }
    
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      if (text) {
        const lines = doc.splitTextToSize(text, 180);
        lines.forEach(line => {
          if (y > 275) { doc.addPage(); y = 15; }
          doc.text(line, 15, y);
          y += 7;
        });
      }
    } else if (node.nodeName === 'IMG') {
      const src = node.src;
      if (src.startsWith('data:image/')) {
        try {
          const format = src.substring(src.indexOf('/') + 1, src.indexOf(';')).toUpperCase();
          const cleanFormat = format.includes('PNG') ? 'PNG' : 'JPEG';
          doc.addImage(src, cleanFormat, 15, y, 90, 55);
          y += 60;
        } catch (e) {
          console.error("Failed to add image to PDF", e);
        }
      }
    } else {
      // Normal elements: Paragraphs, Div containers, list items
      const text = node.innerText || node.textContent || '';
      if (text.trim()) {
        const lines = doc.splitTextToSize(text, 180);
        lines.forEach(line => {
          if (y > 275) { doc.addPage(); y = 15; }
          doc.text(line, 15, y);
          y += 7;
        });
      }
      // Inspect if node has child img tags (e.g. pasted directly in block)
      const imgs = node.querySelectorAll ? node.querySelectorAll('img') : [];
      imgs.forEach(img => {
        if (y > 275) { doc.addPage(); y = 15; }
        const src = img.src;
        if (src.startsWith('data:image/')) {
          try {
            const format = src.substring(src.indexOf('/') + 1, src.indexOf(';')).toUpperCase();
            const cleanFormat = format.includes('PNG') ? 'PNG' : 'JPEG';
            doc.addImage(src, cleanFormat, 15, y, 90, 55);
            y += 60;
          } catch (e) {
            console.error("Failed to add nested image", e);
          }
        }
      });
    }
  });
  
  return doc;
}

// Helper to sanitize filename ending
function getSanitizedFilename() {
  let filename = pdfFilenameInput?.value.trim() || 'scratchpad.pdf';
  if (!filename.toLowerCase().endsWith('.pdf')) {
    filename += '.pdf';
  }
  return filename;
}

if (pdfDownloadBtn) {
  pdfDownloadBtn.addEventListener('click', () => {
    try {
      const doc = generatePdfDoc();
      const filename = getSanitizedFilename();
      doc.save(filename);
      showToast('PDF downloaded successfully.', 'success');
      closePdfModal();
    } catch (err) {
      showToast('Failed to generate/download PDF.', 'error');
    }
  });
}

if (pdfShareBtn) {
  pdfShareBtn.addEventListener('click', () => {
    try {
      const doc = generatePdfDoc();
      const filename = getSanitizedFilename();
      const blob = doc.output('blob');
      const file = new File([blob], filename, { type: 'application/pdf' });
      
      // Inject file into attachments array
      composeFiles.push(file);
      renderAttachmentPreviews();
      
      // Open Compose modal
      openCompose('', 'Sharing Scratchpad Notes', 'Hi,\n\nPlease find the attached Scratchpad notes document.\n\nSent via AI Workspace.', false);
      showToast('PDF attached to compose form!', 'success');
      closePdfModal();
    } catch (err) {
      showToast('Failed to attach PDF to email.', 'error');
    }
  });
}

async function loadScratchpadContent() {
  if (!currentUser || !scratchpadText) return;
  try {
    idToken = await currentUser.getIdToken();
    const data = await getScratchpad(idToken);
    scratchpadText.innerHTML = data.content || '';
    if (scratchpadStatus) scratchpadStatus.textContent = 'Note loaded successfully.';
  } catch (err) {
    console.error('Failed to load scratchpad notes:', err);
  }
}

async function saveScratchpadContent(isSilent = false) {
  if (!currentUser || !scratchpadText) return;
  if (!isSilent && saveScratchpadBtn) setLoading(saveScratchpadBtn, true, 'Saving…');
  if (scratchpadStatus) scratchpadStatus.textContent = 'Saving note...';
  try {
    idToken = await currentUser.getIdToken();
    await saveScratchpad(idToken, scratchpadText.innerHTML);
    if (!isSilent) showToast('Scratchpad saved successfully.', 'success');
    if (scratchpadStatus) scratchpadStatus.textContent = `Auto-saved at ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    if (!isSilent) showToast(err.message || 'Failed to save scratchpad', 'error');
    if (scratchpadStatus) scratchpadStatus.textContent = 'Failed to save note.';
  } finally {
    if (!isSilent && saveScratchpadBtn) setLoading(saveScratchpadBtn, false, '💾 Save Notes');
  }
}

let activePreviewBlobUrl = null;

function formatAttachmentSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function closeFilePreview() {
  const modal = document.getElementById('file-preview-modal');
  if (modal) modal.classList.add('hidden');
  const body = document.getElementById('file-preview-body');
  if (body) body.innerHTML = '';
  if (activePreviewBlobUrl) {
    try {
      URL.revokeObjectURL(activePreviewBlobUrl);
    } catch (_) {}
    activePreviewBlobUrl = null;
  }
}

// Wire preview modal backdrop and close buttons
const closeFilePreviewBtn = document.getElementById('close-file-preview-btn');
if (closeFilePreviewBtn) {
  closeFilePreviewBtn.addEventListener('click', closeFilePreview);
}
const filePreviewModalEl = document.getElementById('file-preview-modal');
if (filePreviewModalEl) {
  filePreviewModalEl.addEventListener('click', (e) => {
    if (e.target === filePreviewModalEl) closeFilePreview();
  });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && filePreviewModalEl && !filePreviewModalEl.classList.contains('hidden')) {
    closeFilePreview();
  }
});

async function openFilePreview({ name = 'File Preview', url, downloadUrl, contentType = '', size = null, meta = '', blob = null }) {
  const modal = document.getElementById('file-preview-modal');
  const iconEl = document.getElementById('preview-file-icon');
  const filenameEl = document.getElementById('preview-filename');
  const metaEl = document.getElementById('preview-file-meta');
  const openTabBtn = document.getElementById('preview-open-tab-btn');
  const downloadBtn = document.getElementById('preview-download-btn');
  const bodyEl = document.getElementById('file-preview-body');

  if (!modal || !bodyEl) return;

  const ext = (name.split('.').pop() || '').toLowerCase();
  const cType = (contentType || '').toLowerCase();

  let badgeText = 'DOC';
  let badgeColor = 'var(--text-muted)';
  if (ext === 'pdf' || cType.includes('pdf')) {
    badgeText = 'PDF';
    badgeColor = '#ef4444';
  } else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext) || cType.startsWith('image/')) {
    badgeText = 'IMG';
    badgeColor = '#a855f7';
  } else if (['txt', 'csv', 'json', 'js', 'py', 'html', 'css', 'xml', 'log', 'md', 'yml', 'yaml', 'sh', 'env', 'tsv'].includes(ext) || cType.startsWith('text/') || cType.includes('json')) {
    badgeText = 'TXT';
    badgeColor = '#3b82f6';
  } else if (['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a'].includes(ext) || cType.startsWith('video/') || cType.startsWith('audio/')) {
    badgeText = 'MEDIA';
    badgeColor = '#f59e0b';
  }

  if (iconEl) {
    iconEl.textContent = badgeText;
    iconEl.style.color = badgeColor;
  }
  if (filenameEl) filenameEl.textContent = name;
  if (metaEl) {
    const sizePart = size ? formatAttachmentSize(size) : '';
    metaEl.textContent = meta || [badgeText, sizePart].filter(Boolean).join(' · ') || 'Preview';
  }

  if (openTabBtn) {
    openTabBtn.href = url || '#';
    openTabBtn.style.display = url ? 'inline-flex' : 'none';
  }
  if (downloadBtn) {
    downloadBtn.href = downloadUrl || url || '#';
    downloadBtn.setAttribute('download', name);
    downloadBtn.style.display = (downloadUrl || url) ? 'inline-flex' : 'none';
  }

  modal.classList.remove('hidden');
  bodyEl.innerHTML = '';

  // 1. PDF viewer
  if (ext === 'pdf' || cType.includes('pdf')) {
    bodyEl.innerHTML = `
      <iframe src="${url}#toolbar=1&navpanes=0" title="${escHtml(name)}" style="width:100%; height:100%; border:none; background:#262626;"></iframe>
    `;
    return;
  }

  // 2. Images viewer
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext) || cType.startsWith('image/')) {
    bodyEl.innerHTML = `
      <div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; overflow:auto; padding:24px; box-sizing:border-box;">
        <img src="${url}" alt="${escHtml(name)}" style="max-width:100%; max-height:100%; object-fit:contain; border-radius:6px; box-shadow:0 12px 36px rgba(0,0,0,0.6); background:rgba(0,0,0,0.2);">
      </div>
    `;
    return;
  }

  // 3. Audio & Video viewer
  if (['mp4', 'webm', 'mov'].includes(ext) || cType.startsWith('video/')) {
    bodyEl.innerHTML = `
      <div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box;">
        <video controls autoplay muted src="${url}" style="max-width:92%; max-height:88%; border-radius:8px; box-shadow:0 12px 36px rgba(0,0,0,0.7); outline:none;"></video>
      </div>
    `;
    return;
  }
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext) || cType.startsWith('audio/')) {
    bodyEl.innerHTML = `
      <div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; padding:24px; box-sizing:border-box;">
        <div style="font-size:48px;">🎵</div>
        <div style="font-size:15px; font-weight:600; color:var(--text-primary);">${escHtml(name)}</div>
        <audio controls autoplay src="${url}" style="width:85%; max-width:480px;"></audio>
      </div>
    `;
    return;
  }

  // 4. Text / Code / JSON / CSV viewer
  if (['txt', 'csv', 'json', 'js', 'py', 'html', 'css', 'xml', 'log', 'md', 'yml', 'yaml', 'sh', 'env', 'tsv'].includes(ext) || cType.startsWith('text/') || cType.includes('json')) {
    bodyEl.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; gap:12px; padding:40px;">
        <div class="spinner"></div>
        <span style="font-size:13px; color:var(--text-muted);">Reading file content...</span>
      </div>
    `;
    try {
      let textContent = '';
      if (blob) {
        textContent = await blob.text();
      } else {
        const textResp = await fetch(url);
        textContent = await textResp.text();
      }
      bodyEl.innerHTML = `
        <div style="width:100%; height:100%; overflow:auto; padding:24px; box-sizing:border-box; background:rgba(0,0,0,0.25); text-align:left;">
          <pre style="font-family:var(--font-mono, 'JetBrains Mono', Consolas, monospace); font-size:12.5px; line-height:1.6; color:var(--text-primary); margin:0; white-space:pre-wrap; word-break:break-word;">${escHtml(textContent)}</pre>
        </div>
      `;
    } catch (txtErr) {
      bodyEl.innerHTML = `
        <div style="text-align:center; padding:40px 20px;">
          <p style="color:var(--text-muted); font-size:13px;">Unable to render text directly. You can open in a new tab or download the file.</p>
        </div>
      `;
    }
    return;
  }

  // 5. Unsupported binary fallback
  bodyEl.innerHTML = `
    <div style="text-align:center; padding:40px 20px; max-width:480px; margin:auto;">
      <div style="font-size:48px; margin-bottom:16px;">📄</div>
      <h4 style="font-size:16px; font-weight:600; margin:0 0 8px 0; color:var(--text-primary);">${escHtml(name)}</h4>
      <p style="font-size:13px; color:var(--text-muted); line-height:1.6; margin-bottom:24px;">
        This file format (${(ext || 'binary').toUpperCase()}) cannot be rendered directly inside the browser. You can download it or open in an external application.
      </p>
      <a href="${downloadUrl || url}" download="${escHtml(name)}" class="btn btn-primary" style="display:inline-flex; align-items:center; gap:6px; text-decoration:none; padding:8px 18px; font-size:13px; border-radius:6px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download File
      </a>
    </div>
  `;
}

async function previewAttachment(messageId, attachmentId, filename, sender = '', subject = '') {
  openFilePreview({
    name: filename || 'Attachment',
    url: '',
    downloadUrl: '',
    meta: 'Loading attachment…'
  });

  const bodyEl = document.getElementById('file-preview-body');
  if (bodyEl) {
    bodyEl.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; gap:12px; padding:40px;">
        <div class="spinner"></div>
        <span style="font-size:13px; color:var(--text-muted);">Fetching attachment from Gmail & R2…</span>
      </div>
    `;
  }

  try {
    idToken = await currentUser.getIdToken();
    await getOrRefreshOauthToken();
    const url = `/api/emails/attachment/${messageId}/${attachmentId}?filename=${encodeURIComponent(filename)}&oauth_token=${oauthToken}&inline=true&sender=${encodeURIComponent(sender || '')}&subject=${encodeURIComponent(subject || '')}`;
    
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || 'Failed to fetch attachment');
    }

    const contentType = resp.headers.get('content-type') || '';
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    if (activePreviewBlobUrl) {
      try { URL.revokeObjectURL(activePreviewBlobUrl); } catch (_) {}
    }
    activePreviewBlobUrl = blobUrl;

    await openFilePreview({
      name: filename,
      url: blobUrl,
      downloadUrl: blobUrl,
      contentType,
      size: blob.size,
      meta: `${formatAttachmentSize(blob.size)} · Gmail Attachment`,
      blob
    });
  } catch (err) {
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div style="text-align:center; padding:40px 20px;">
          <p style="color:var(--text-error, #ef4444); font-size:13.5px; margin-bottom:12px;">Failed to load attachment: ${escHtml(err.message)}</p>
          <button class="btn btn-secondary btn-sm" onclick="closeFilePreview()">Close</button>
        </div>
      `;
    }
    showToast(err.message || 'Failed to load attachment', 'error');
  }
}

function handlePreviewR2Document(doc) {
  if (!doc) return;
  const targetUrl = doc.preview_url || doc.download_url;
  openFilePreview({
    name: doc.filename || 'document',
    url: targetUrl,
    downloadUrl: doc.download_url || targetUrl,
    contentType: doc.content_type || '',
    size: doc.size_bytes || null,
    meta: `${doc.direction === 'outgoing' ? 'Sent file' : 'Received file'} · Cloudflare R2`
  });
}

async function downloadAttachment(messageId, attachmentId, filename) {
  try {
    idToken = await currentUser.getIdToken();
    await getOrRefreshOauthToken();
    const url = `/api/emails/attachment/${messageId}/${attachmentId}?filename=${encodeURIComponent(filename)}&oauth_token=${oauthToken}&inline=false`;
    
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (!resp.ok) throw new Error('Failed to download attachment');
    
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
    showToast('File downloaded successfully.', 'success');
  } catch (err) {
    showToast(err.message || 'Download failed.', 'error');
  }
}


// ── Spreadsheet Importer & Viewer Logic ────────────────────────────────────
const excelImportBtn = document.getElementById('excel-import-btn');
const excelFileLoader = document.getElementById('excel-file-loader');
const excelDropZone = document.getElementById('excel-drop-zone');
const excelSheetTabs = document.getElementById('excel-sheet-tabs');
const excelTableViewContainer = document.getElementById('excel-table-view-container');
const excelDataTable = document.getElementById('excel-data-table');

let parsedWorkbook = null;

if (excelImportBtn && excelFileLoader) {
  excelImportBtn.addEventListener('click', () => excelFileLoader.click());
  excelFileLoader.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleExcelFile(file);
  });
}

if (excelDropZone) {
  excelDropZone.addEventListener('click', () => excelFileLoader.click());
  
  excelDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    excelDropZone.classList.add('hover');
  });

  excelDropZone.addEventListener('dragleave', () => {
    excelDropZone.classList.remove('hover');
  });

  excelDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    excelDropZone.classList.remove('hover');
    const file = e.dataTransfer.files[0];
    if (file) handleExcelFile(file);
  });
}

// Spreadsheet History persistence helpers
function loadImportedSheetsHistory() {
  const historyListEl = document.getElementById('spreadsheet-history-list');
  if (!historyListEl) return;

  const history = JSON.parse(localStorage.getItem('crm_imported_sheets_history') || '[]');
  
  if (history.length === 0) {
    historyListEl.innerHTML = '<div style="font-size:12px; color:var(--text-muted); padding:8px 0;">No spreadsheets imported yet.</div>';
    return;
  }

  historyListEl.innerHTML = history.map((item, idx) => `
    <div class="sheet-history-item" data-id="${item.id}" style="background:rgba(255,255,255,0.03); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:10px; display:flex; flex-direction:column; gap:4px; font-size:12.5px; position:relative; transition: all 0.2s;">
      <div style="font-weight:600; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; padding-right:24px; cursor:pointer;" onclick="viewHistorySheet('${item.id}')">${escHtml(item.filename)}</div>
      <div style="font-size:11px; color:var(--text-muted);">Imported: ${escHtml(item.importedAt)}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
        <span style="font-size:11px; color:var(--accent-primary); font-weight:600;">👥 ${item.clientCount} clients</span>
        <button class="btn btn-ghost btn-xs delete-history-sheet-btn" style="color:#ef4444; border-color:transparent; padding:2px; font-size:11px; font-weight:700;" onclick="deleteHistorySheet(event, '${item.id}')">🗑️ Delete</button>
      </div>
    </div>
  `).join('');
}

window.viewHistorySheet = (id) => {
  const history = JSON.parse(localStorage.getItem('crm_imported_sheets_history') || '[]');
  const matched = history.find(item => item.id === id);
  if (!matched) return;

  try {
    // Restore state
    excelSheetTabs.innerHTML = '';
    excelSheetTabs.classList.remove('hidden');
    excelDropZone.style.display = 'none';
    excelTableViewContainer.style.display = 'block';

    // Build workbook dummy configuration from saved JSON sheet data
    const sheets = matched.sheets || {};
    const sheetNames = Object.keys(sheets);
    parsedWorkbook = {
      SheetNames: sheetNames,
      Sheets: {}
    };
    
    sheetNames.forEach((name) => {
      parsedWorkbook.Sheets[name] = XLSX.utils.json_to_sheet(sheets[name]);
    });

    sheetNames.forEach((sheetName, index) => {
      const btn = document.createElement('button');
      btn.className = `excel-sheet-btn ${index === 0 ? 'active' : ''}`;
      btn.textContent = sheetName;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.excel-sheet-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderSheetData(sheetName);
      });
      excelSheetTabs.appendChild(btn);
    });

    renderSheetData(sheetNames[0]);
    showToast(`Loaded ${matched.filename} from history`, 'success');
  } catch (err) {
    showToast('Failed to view cached sheet', 'error');
  }
};

window.deleteHistorySheet = (event, id) => {
  if (event) event.stopPropagation();
  if (!confirm('Are you sure you want to delete this spreadsheet from history?')) return;

  let history = JSON.parse(localStorage.getItem('crm_imported_sheets_history') || '[]');
  history = history.filter(item => item.id !== id);
  localStorage.setItem('crm_imported_sheets_history', JSON.stringify(history));
  loadImportedSheetsHistory();

  // Reset workspace if active sheet is deleted
  excelDropZone.style.display = 'block';
  excelSheetTabs.classList.add('hidden');
  excelTableViewContainer.style.display = 'none';
  parsedWorkbook = null;

  showToast('Spreadsheet deleted from history.', 'success');
};

function handleExcelFile(file) {
  const fileExt = file.name.split('.').pop().toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(fileExt)) {
    showToast('Invalid format. Please upload an Excel (.xlsx, .xls) or CSV file.', 'error');
    return;
  }

  showToast(`Parsing ${file.name}...`, 'info');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      parsedWorkbook = XLSX.read(data, { type: 'array' });
      
      // Setup Sheet Switcher Tabs
      excelSheetTabs.innerHTML = '';
      excelSheetTabs.classList.remove('hidden');
      excelDropZone.style.display = 'none';
      excelTableViewContainer.style.display = 'block';

      // Save sheets representation to history
      const savedSheetsData = {};
      let totalClientRowsCount = 0;

      parsedWorkbook.SheetNames.forEach((sheetName, index) => {
        const sheet = parsedWorkbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        savedSheetsData[sheetName] = rows;
        if (index === 0) {
          totalClientRowsCount = rows.length; // Approximate client count by rows count on primary sheet
        }

        const btn = document.createElement('button');
        btn.className = `excel-sheet-btn ${index === 0 ? 'active' : ''}`;
        btn.textContent = sheetName;
        btn.addEventListener('click', () => {
          document.querySelectorAll('.excel-sheet-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderSheetData(sheetName);
        });
        excelSheetTabs.appendChild(btn);
      });

      // Save entry to import history log
      const newHistoryItem = {
        id: `sheet_${Date.now()}`,
        filename: file.name,
        importedAt: new Date().toLocaleString(),
        clientCount: totalClientRowsCount,
        sheets: savedSheetsData
      };
      
      const history = JSON.parse(localStorage.getItem('crm_imported_sheets_history') || '[]');
      history.unshift(newHistoryItem);
      localStorage.setItem('crm_imported_sheets_history', JSON.stringify(history));
      loadImportedSheetsHistory();

      // Render first sheet by default
      renderSheetData(parsedWorkbook.SheetNames[0]);
      showToast('Spreadsheet loaded and saved to history.', 'success');
    } catch (err) {
      console.error(err);
      showToast('Failed to parse spreadsheet file.', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function renderSheetData(sheetName) {
  if (!parsedWorkbook) return;
  const sheet = parsedWorkbook.Sheets[sheetName];
  // Parse rows as raw 2D array
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  excelDataTable.innerHTML = '';
  if (rows.length === 0) {
    excelDataTable.innerHTML = '<tr><td style="padding:16px; color:var(--text-muted);">This sheet is empty.</td></tr>';
    return;
  }

  // Generate Table Header
  const headers = rows[0];
  const trHead = document.createElement('tr');
  const thIdx = document.createElement('th');
  thIdx.textContent = '#';
  thIdx.style.width = '50px';
  trHead.appendChild(thIdx);

  headers.forEach((h, colIdx) => {
    const th = document.createElement('th');
    th.textContent = h !== undefined && String(h).trim() !== "" ? String(h).trim() : `Column ${colIdx + 1}`;
    trHead.appendChild(th);
  });
  excelDataTable.appendChild(trHead);

  // Generate Table Rows
  for (let rIdx = 1; rIdx < rows.length; rIdx++) {
    const rowCells = rows[rIdx];
    if (rowCells.length === 0 || rowCells.every(c => c === "")) continue;

    const tr = document.createElement('tr');
    
    // Row Index cell
    const tdIdx = document.createElement('td');
    tdIdx.textContent = rIdx;
    tdIdx.style.fontWeight = 'bold';
    tdIdx.style.color = 'var(--text-muted)';
    tr.appendChild(tdIdx);

    for (let cIdx = 0; cIdx < headers.length; cIdx++) {
      const cellVal = rowCells[cIdx];
      const td = document.createElement('td');
      td.textContent = cellVal !== undefined ? String(cellVal) : '';
      tr.appendChild(td);
    }
    excelDataTable.appendChild(tr);
  }
}

// Call on startup initialization
document.addEventListener('DOMContentLoaded', () => {
  loadImportedSheetsHistory();
});

// Run immediate history logs initialization if element is rendered
loadImportedSheetsHistory();


// ── Calendar Workspace Logic ───────────────────────────────────────────────
const calendarPrevMonthBtn = document.getElementById('calendar-prev-month-btn');
const calendarNextMonthBtn = document.getElementById('calendar-next-month-btn');
const calendarMonthYearLabel = document.getElementById('calendar-month-year-label');
const calendarDaysGrid = document.getElementById('calendar-days-grid');
const calendarSidebarEventsList = document.getElementById('calendar-sidebar-events-list');
const calendarAddEventBtn = document.getElementById('calendar-add-event-btn');

// Calendar Event Modal DOM refs
const calendarEventModal = document.getElementById('calendar-event-modal');
const closeCalendarModalBtn = document.getElementById('close-calendar-modal-btn');
const calendarCancelEventBtn = document.getElementById('calendar-cancel-event-btn');
const calendarSaveEventBtn = document.getElementById('calendar-save-event-btn');
const calendarDeleteEventBtn = document.getElementById('calendar-delete-event-btn');

const calendarEventId = document.getElementById('calendar-event-id');
const calendarEventTitle = document.getElementById('calendar-event-title');
const calendarEventDate = document.getElementById('calendar-event-date');
const calendarEventTime = document.getElementById('calendar-event-time');
const calendarEventDesc = document.getElementById('calendar-event-desc');
const calendarEventNotify = document.getElementById('calendar-event-notify');

let calendarCurrentDate = new Date();
let calendarEvents = [];

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Switch tab listener to trigger calendar loads
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'calendar') {
      loadCalendarEvents();
    }
  });
});

if (calendarPrevMonthBtn && calendarNextMonthBtn) {
  calendarPrevMonthBtn.addEventListener('click', () => {
    calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() - 1);
    renderCalendar();
  });
  
  calendarNextMonthBtn.addEventListener('click', () => {
    calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + 1);
    renderCalendar();
  });
}

if (calendarAddEventBtn) {
  calendarAddEventBtn.addEventListener('click', () => {
    openCalendarModal(null, new Date().toISOString().split('T')[0]);
  });
}

function closeCalendarModal() {
  if (calendarEventModal) calendarEventModal.classList.add('hidden');
}

if (closeCalendarModalBtn) closeCalendarModalBtn.addEventListener('click', closeCalendarModal);
if (calendarCancelEventBtn) calendarCancelEventBtn.addEventListener('click', closeCalendarModal);

function inferEventCategory(text) {
  if (!text) return 'general';
  const t = text.toLowerCase();
  if (/(strategy|planning|roadmap|brainstorm)/.test(t)) return 'strategy';
  if (/(due|deadline|submit|urgent|timeline)/.test(t)) return 'deadline';
  if (/(meet|zoom|call|discuss|sync|catch up)/.test(t)) return 'meeting';
  if (/(follow up|check in|touch base)/.test(t)) return 'followup';
  return 'general';
}

// Parse raw email text for meetings, dates, and action items
function parseTargetDateFromText(text, emailDateStr) {
  const currentYear = new Date().getFullYear();
  const lowerText = text.toLowerCase();
  
  // 1. Explicit ISO date: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = lowerText.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = String(parseInt(isoMatch[2], 10)).padStart(2, '0');
    const d = String(parseInt(isoMatch[3], 10)).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 2. Short/Abbreviated dates with 2-digit or 4-digit years like: "21 aug 26", "21-aug-2026", "aug 21 26", "21st august 26"
  const shortDateMatch = lowerText.match(/\b(?:(\d{1,2})(?:st|nd|rd|th)?[\s/-]+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s/-]+(\d{2,4})|(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s/-]+(\d{1,2})(?:st|nd|rd|th)?[\s/-]+(\d{2,4}))\b/i);

  if (shortDateMatch) {
    const dayStr = shortDateMatch[1] || shortDateMatch[4];
    const monthStr = shortDateMatch[2] || shortDateMatch[3];
    let yearVal = parseInt(shortDateMatch[5] || shortDateMatch[6], 10);
    if (yearVal < 100) yearVal += 2000; // Turn 26 -> 2026
    
    const parsedDate = new Date(`${monthStr} ${dayStr}, ${yearVal}`);
    if (!isNaN(parsedDate.getTime())) {
      const y = parsedDate.getFullYear();
      const m = String(parsedDate.getMonth() + 1).padStart(2, '0');
      const d = String(parsedDate.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  // 3. Slash/Dash numerical dates with 2-digit years like: "21/08/26", "21-08-26"
  const numericMatch = lowerText.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
  if (numericMatch) {
    const d = String(parseInt(numericMatch[1], 10)).padStart(2, '0');
    const m = String(parseInt(numericMatch[2], 10)).padStart(2, '0');
    let y = parseInt(numericMatch[3], 10);
    if (y < 100) y += 2000;
    return `${y}-${m}-${d}`;
  }

  // 4. Formats without explicitly stated years: "21 Aug", "August 21", "21st Aug"
  const noYearMatch = lowerText.match(/\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?)\b/i);

  if (noYearMatch) {
    const dayStr = noYearMatch[1] || noYearMatch[4];
    const monthStr = noYearMatch[2] || noYearMatch[3];
    
    const parsedDate = new Date(`${monthStr} ${dayStr}, ${currentYear}`);
    if (!isNaN(parsedDate.getTime())) {
      const y = parsedDate.getFullYear();
      const m = String(parsedDate.getMonth() + 1).padStart(2, '0');
      const d = String(parsedDate.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  // 5. Relative Days: "tomorrow", "day after tomorrow"
  if (lowerText.includes('day after tomorrow')) {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toISOString().split('T')[0];
  }
  if (lowerText.includes('tomorrow')) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }

  // 6. Days of week: "this monday", "next tuesday", "on friday"
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < weekdays.length; i++) {
    if (lowerText.includes(weekdays[i])) {
      const today = new Date();
      const currentDay = today.getDay();
      let diff = i - currentDay;
      if (diff <= 0) diff += 7; // Next occurrence
      today.setDate(today.getDate() + diff);
      return today.toISOString().split('T')[0];
    }
  }

  // 7. Fallback to Email received date or Today
  if (emailDateStr) {
    try {
      const emailDateObj = new Date(emailDateStr);
      if (!isNaN(emailDateObj.getTime())) {
        return emailDateObj.toISOString().split('T')[0];
      }
    } catch (e) {}
  }
  return new Date().toISOString().split('T')[0];
}

function extractAndSyncEventsFromEmailContent(emailsList) {
  if (!emailsList || emailsList.length === 0) return 0;
  let addedCount = 0;

  emailsList.forEach((emailItem) => {
    const textToScan = ((emailItem.subject || '') + ' ' + (emailItem.summary || '') + ' ' + (emailItem.snippet || '') + ' ' + (emailItem.body || ''));
    const lowerText = textToScan.toLowerCase();
    const subjectText = emailItem.subject || '(No Subject)';
    const sender = emailItem.from || emailItem.sender || 'Unknown';
    const emailId = emailItem.id || emailItem.message_id || `msg_${Date.now()}`;

    const category = inferEventCategory(textToScan);

    if (category !== 'general') {
      const title = `${category.charAt(0).toUpperCase() + category.slice(1)}: ${subjectText.substring(0, 32)}`;
      
      // Determine target scheduled date specifically from email content/body text
      const targetDateStr = parseTargetDateFromText(textToScan, emailItem.date);

      // Avoid duplicates
      const exists = calendarEvents.some(e => e.title === title || (e.description && e.description.includes(emailId)));
      if (!exists) {
        calendarEvents.push({
          id: `ai_evt_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
          title: title,
          date: targetDateStr,
          time: '10:00',
          category: category,
          description: `Auto-Fetched from Gmail: "${subjectText}" from ${sender}.\nID: ${emailId}`,
          notifyBefore: 15
        });
        addedCount++;
      }
    }
  });

  return addedCount;
}

const calendarAutoExtractBtn = document.getElementById('calendar-auto-extract-btn');
if (calendarAutoExtractBtn) {
  calendarAutoExtractBtn.addEventListener('click', async () => {
    setLoading(calendarAutoExtractBtn, true, 'Syncing…');
    try {
      idToken = await currentUser.getIdToken();
      
      // 1. Fetch stored summaries
      const res = await getSummaries(idToken);
      const summaries = res.summaries || [];

      // 2. Scan both emailCache (raw inbox) and stored summaries
      const allSources = [...emailCache, ...summaries];

      if (allSources.length === 0) {
        showToast('No emails or stored summaries found to sync reminders from.', 'warning');
        return;
      }

      const addedCount = extractAndSyncEventsFromEmailContent(allSources);

      if (addedCount > 0) {
        await saveCalendarEventsToServer();
        showToast(`Auto-Synced ${addedCount} new meeting/task reminders to Calendar!`, 'success');
      } else {
        showToast('Calendar is already up to date with your inbox & summaries.', 'info');
      }
    } catch (err) {
      showToast(err.message || 'Auto-sync failed', 'error');
    } finally {
      setLoading(calendarAutoExtractBtn, false, '⚡ Auto-Sync AI Reminders');
    }
  });
}

const calendarEventCategory = document.getElementById('calendar-event-category');
const calendarCategoryFilter = document.getElementById('calendar-category-filter');

if (calendarCategoryFilter) {
  calendarCategoryFilter.addEventListener('change', () => {
    renderCalendar();
  });
}

const categoryMeta = {
  followup: { icon: "", label: "Client Follow-up", bg: "rgba(249,115,22,0.15)", color: "#f97316" },
  meeting: { icon: "", label: "Meeting / Call", bg: "rgba(59,130,246,0.15)", color: "#3b82f6" },
  grievance: { icon: "", label: "Grievance Resolution", bg: "rgba(244,63,94,0.15)", color: "#f43f5e" },
  deadline: { icon: "", label: "Project Deadline", bg: "rgba(239,68,68,0.15)", color: "#ef4444" },
  strategy: { icon: "", label: "Strategy Session", bg: "rgba(139,92,246,0.15)", color: "#8b5cf6" },
  general: { icon: "", label: "General Task", bg: "rgba(20,184,166,0.15)", color: "#14b8a6" }
};

function normalizeCategory(catStr) {
  if (!catStr) return 'general';
  const s = catStr.toLowerCase().trim();
  if (s.includes('follow') || s === 'client follow-up') return 'followup';
  if (s.includes('meet') || s.includes('call')) return 'meeting';
  if (s.includes('grievance')) return 'grievance';
  if (s.includes('deadline') || s.includes('project deadline')) return 'deadline';
  if (s.includes('strategy')) return 'strategy';
  return 'general';
}

if (calendarSaveEventBtn) {
  calendarSaveEventBtn.addEventListener('click', async () => {
    const title = calendarEventTitle.value.trim();
    const date = calendarEventDate.value;
    const time = calendarEventTime.value;
    const desc = calendarEventDesc.value.trim();
    const id = calendarEventId.value;
    const notifyBefore = parseInt(calendarEventNotify.value) || 0;
    const category = calendarEventCategory ? calendarEventCategory.value : 'general';

    if (!title || !date) {
      showToast('Event Title and Date are required.', 'error');
      return;
    }

    const eventObj = {
      id: id || Date.now().toString(),
      title,
      date,
      time: time || "12:00",
      category: category,
      description: desc,
      notifyBefore
    };

    if (id) {
      // Update existing
      calendarEvents = calendarEvents.map(e => e.id === id ? eventObj : e);
    } else {
      // Create new
      calendarEvents.push(eventObj);
    }

    await saveCalendarEventsToServer();
    closeCalendarModal();
  });
}

if (calendarDeleteEventBtn) {
  calendarDeleteEventBtn.addEventListener('click', async () => {
    const id = calendarEventId.value;
    if (id) {
      calendarEvents = calendarEvents.filter(e => e.id !== id);
      await saveCalendarEventsToServer();
      closeCalendarModal();
    }
  });
}

function openCalendarModal(eventObj = null, defaultDateStr = '') {
  if (!calendarEventModal) return;
  
  if (eventObj) {
    document.getElementById('calendar-modal-title').textContent = '📝 Modify Workspace Event';
    calendarEventId.value = eventObj.id;
    calendarEventTitle.value = eventObj.title;
    calendarEventDate.value = eventObj.date;
    calendarEventTime.value = eventObj.time;
    if (calendarEventCategory) calendarEventCategory.value = normalizeCategory(eventObj.category);
    calendarEventDesc.value = eventObj.description || '';
    if (calendarEventNotify) calendarEventNotify.value = String(eventObj.notifyBefore !== undefined ? eventObj.notifyBefore : 15);
    if (calendarDeleteEventBtn) calendarDeleteEventBtn.style.display = 'block';
  } else {
    document.getElementById('calendar-modal-title').textContent = '📅 Schedule Workspace Event';
    calendarEventId.value = '';
    calendarEventTitle.value = '';
    calendarEventDate.value = defaultDateStr;
    calendarEventTime.value = '12:00';
    if (calendarEventCategory) calendarEventCategory.value = 'general';
    calendarEventDesc.value = '';
    if (calendarEventNotify) calendarEventNotify.value = '15';
    if (calendarDeleteEventBtn) calendarDeleteEventBtn.style.display = 'none';
  }
  
  calendarEventModal.classList.remove('hidden');
}

async function loadCalendarEvents() {
  if (!currentUser) return;
  try {
    idToken = await currentUser.getIdToken();
    const resp = await fetch('/api/emails/calendar', {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (!resp.ok) throw new Error('Failed to load calendar events');
    calendarEvents = await resp.json();
    renderCalendar();
  } catch (err) {
    console.error(err);
  }
}

async function saveCalendarEventsToServer() {
  if (!currentUser) return;
  try {
    idToken = await currentUser.getIdToken();
    const resp = await fetch('/api/emails/calendar', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(calendarEvents)
    });
    if (!resp.ok) throw new Error('Failed to save calendar events');
    showToast('Calendar updated.', 'success');
    renderCalendar();
  } catch (err) {
    showToast(err.message || 'Save failed.', 'error');
  }
}

const calendarSearchInput = document.getElementById('calendar-search-input');
if (calendarSearchInput) {
  calendarSearchInput.addEventListener('input', () => {
    renderCalendar();
  });
}

function renderCalendar() {
  if (!calendarDaysGrid || !calendarMonthYearLabel) return;

  const year = calendarCurrentDate.getFullYear();
  const month = calendarCurrentDate.getMonth();
  const selectedCategoryFilter = calendarCategoryFilter ? calendarCategoryFilter.value : 'all';
  const searchQuery = calendarSearchInput ? calendarSearchInput.value.trim().toLowerCase() : '';

  calendarMonthYearLabel.textContent = `${monthNames[month]} ${year}`;
  calendarDaysGrid.innerHTML = '';

  // Get index of first day of the month (0 = Sun, 1 = Mon, etc)
  const firstDayIndex = new Date(year, month, 1).getDay();
  // Get total days in month
  const totalDays = new Date(year, month + 1, 0).getDate();
  // Get total days in previous month
  const prevMonthTotalDays = new Date(year, month, 0).getDate();

  const today = new Date();

  // 1. Padding cells from previous month
  for (let i = firstDayIndex; i > 0; i--) {
    const dayNum = prevMonthTotalDays - i + 1;
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell other-month';
    cell.innerHTML = `<span class="day-number">${dayNum}</span>`;
    calendarDaysGrid.appendChild(cell);
  }

  // 2. Main days of the active month
  for (let day = 1; day <= totalDays; day++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell';
    
    const isToday = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year;
    if (isToday) cell.classList.add('today');

    cell.innerHTML = `<span class="day-number">${day}</span>`;

    // Filter events for this specific date string (YYYY-MM-DD)
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    let dayEvents = calendarEvents.filter(e => e.date === dateStr);

    // Apply category filter if selected
    if (selectedCategoryFilter !== 'all') {
      dayEvents = dayEvents.filter(e => normalizeCategory(e.category) === selectedCategoryFilter);
    }

    // Apply live search query filter if typed
    if (searchQuery) {
      dayEvents = dayEvents.filter(e => 
        (e.title || '').toLowerCase().includes(searchQuery) ||
        (e.description || '').toLowerCase().includes(searchQuery)
      );
    }

    dayEvents.forEach(evt => {
      const cat = categoryMeta[normalizeCategory(evt.category)] || categoryMeta.general;
      const pill = document.createElement('div');
      pill.className = 'calendar-event-pill';
      pill.style.background = cat.bg;
      pill.style.color = cat.color;
      pill.style.borderLeft = `3px solid ${cat.color}`;
      pill.textContent = `${evt.time} ${evt.title}`;
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        openCalendarModal(evt);
      });
      cell.appendChild(pill);
    });

    cell.addEventListener('click', () => {
      openCalendarModal(null, dateStr);
    });

    calendarDaysGrid.appendChild(cell);
  }

  // 3. Padding cells for next month to complete 6-row grid (42 cells total)
  const cellsRendered = firstDayIndex + totalDays;
  const nextMonthPadding = 42 - cellsRendered;
  for (let i = 1; i <= nextMonthPadding; i++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day-cell other-month';
    cell.innerHTML = `<span class="day-number">${i}</span>`;
    calendarDaysGrid.appendChild(cell);
  }

  // Update Sidebar Upcoming List (Events sorted chronologically)
  renderSidebarEvents();
}

function renderSidebarEvents() {
  if (!calendarSidebarEventsList) return;
  calendarSidebarEventsList.innerHTML = '';
  const selectedCategoryFilter = calendarCategoryFilter ? calendarCategoryFilter.value : 'all';
  const searchQuery = calendarSearchInput ? calendarSearchInput.value.trim().toLowerCase() : '';

  let upcoming = [...calendarEvents]
    .filter(e => new Date(e.date) >= new Date(new Date().setHours(0,0,0,0)))
    .sort((a,b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  if (selectedCategoryFilter !== 'all') {
    upcoming = upcoming.filter(e => normalizeCategory(e.category) === selectedCategoryFilter);
  }

  if (searchQuery) {
    upcoming = upcoming.filter(e => 
      (e.title || '').toLowerCase().includes(searchQuery) ||
      (e.description || '').toLowerCase().includes(searchQuery)
    );
  }

  if (upcoming.length === 0) {
    calendarSidebarEventsList.innerHTML = '<span style="font-size:12.5px; color:var(--text-muted);">No upcoming events matching filter. Click a day box on the calendar grid to schedule reminders.</span>';
    return;
  }

  upcoming.forEach(evt => {
    const card = document.createElement('div');
    card.className = 'calendar-sidebar-card';
    const cat = categoryMeta[normalizeCategory(evt.category)] || categoryMeta.general;
    
    // Format Date header
    const dateObj = new Date(evt.date);
    const dateFormatted = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div style="font-size:13.5px; font-weight:600; color:var(--text-primary);">${evt.title}</div>
        <span style="font-size:10px; font-weight:700; background:${cat.bg}; color:${cat.color}; padding:2px 6px; border-radius:4px;">${cat.icon} ${cat.label}</span>
      </div>
      <div style="font-size:12px; color:var(--primary-light); font-weight:500; margin-top:2px;">📅 ${dateFormatted} at ${evt.time}</div>
      ${evt.description ? `<div style="font-size:12px; color:var(--text-muted); margin-top:4px;">${evt.description}</div>` : ''}
    `;

    card.addEventListener('click', () => {
      openCalendarModal(evt);
    });

    calendarSidebarEventsList.appendChild(card);
  });
}

let activeCalendarAlerts = [];
let triggeredCalendarAlerts = new Set();

function checkCalendarAlarms() {
  if (!calendarEvents || calendarEvents.length === 0) return;
  const now = new Date();
  
  calendarEvents.forEach(evt => {
    const notifyBefore = parseInt(evt.notifyBefore);
    if (isNaN(notifyBefore) || notifyBefore <= 0) return;
    
    const [year, month, day] = evt.date.split('-').map(Number);
    const [hours, minutes] = evt.time.split(':').map(Number);
    const eventTime = new Date(year, month - 1, day, hours, minutes);
    
    const triggerTime = new Date(eventTime.getTime() - (notifyBefore * 60 * 1000));
    
    // Check if current time has entered the trigger window
    if (now >= triggerTime && now <= new Date(eventTime.getTime() + (5 * 60 * 1000))) {
      const alarmId = `cal_${evt.id}`;
      if (!triggeredCalendarAlerts.has(alarmId)) {
        triggeredCalendarAlerts.add(alarmId);
        
        activeCalendarAlerts.push({
          id: evt.id,
          title: evt.title,
          time: evt.time,
          date: evt.date,
          notifyBefore
        });
        
        showCalendarFloatingToast(evt);
        checkReplies();
      }
    }
  });
}

function showCalendarFloatingToast(evt) {
  if (!notificationCenter) return;
  const card = document.createElement('div');
  card.className = 'notification-alert';
  card.dataset.calendarEventId = evt.id;
  card.style.borderLeft = '4px solid #818cf8';
  card.innerHTML = `
    <div class="notification-alert-header">
      <span class="notification-alert-title" style="color:#818cf8;">📅 Calendar Reminder</span>
      <button class="dismiss-alert-btn" title="Dismiss Alert">&times;</button>
    </div>
    <div style="font-weight: 500; font-size: 13px; color: var(--text-primary); max-width: 290px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-bottom: 2px;">
      ${escHtml(evt.title)}
    </div>
    <div class="notification-alert-body">
      Starts in ${evt.notifyBefore} minutes (at ${evt.time})
    </div>
  `;
  
  card.querySelector('.dismiss-alert-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    card.style.transform = 'translateX(120%)';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 300);
    activeCalendarAlerts = activeCalendarAlerts.filter(a => a.id !== evt.id);
    checkReplies();
  });
  
  notificationCenter.appendChild(card);
}

// ── Operations Kanban Board Logic ──
let localTasks = [];

async function loadTasks() {
  idToken = await currentUser.getIdToken();
  const res = await fetch('/api/tasks', {
    headers: { 'Authorization': `Bearer ${idToken}` }
  });
  const data = await res.json();
  return data.tasks || [];
}

async function apiSaveTask(task) {
  idToken = await currentUser.getIdToken();
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    },
    body: JSON.stringify(task)
  });
  return res.json();
}

async function apiDeleteTask(taskId) {
  idToken = await currentUser.getIdToken();
  const res = await fetch(`/api/tasks/${taskId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${idToken}` }
  });
  return res.json();
}

async function loadKanbanBoard() {
  if (!currentUser) return;
  try {
    localTasks = await loadTasks();
    renderKanbanTasks();
    
    // Fetch crm analytics
    idToken = await currentUser.getIdToken();
    const crmRes = await fetch('/api/crm/analytics', {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (crmRes.ok) {
      const crmData = await crmRes.json();
      updateKanbanAnalytics(crmData.active_grievances || 0);
    }
  } catch (err) {
    showToast(err.message || 'Failed to load tasks', 'error');
  }
}

// Grievances & Task Tickets Ledger state management variables
let activeLedgerTab = 'active';

function updateKanbanAnalytics(activeGrievances) {
  const grievancesEl = document.getElementById('stat-active-grievances');
  const grievancesCard = document.getElementById('stat-grievances-card');
  if (grievancesEl) grievancesEl.textContent = activeGrievances;
  if (grievancesCard) {
    if (activeGrievances > 0) {
      grievancesCard.style.background = 'rgba(244, 63, 94, 0.08)';
      grievancesCard.style.borderColor = 'rgba(244, 63, 94, 0.3)';
      grievancesEl.style.color = '#f43f5e';
    } else {
      grievancesCard.style.background = '';
      grievancesCard.style.borderColor = '';
      grievancesEl.style.color = '';
    }
  }
}

// Bind Grievance Card click to toggle dynamic inspection panel list
const grievancesCard = document.getElementById('stat-grievances-card');
const kanbanLedgerPane = document.getElementById('kanban-ledger-pane');
const closeLedgerPaneBtn = document.getElementById('close-ledger-pane-btn');
const ledgerTabActive = document.getElementById('ledger-tab-active');
const ledgerTabInactive = document.getElementById('ledger-tab-inactive');

if (grievancesCard) {
  grievancesCard.style.cursor = 'pointer';
  grievancesCard.addEventListener('click', () => {
    if (kanbanLedgerPane) {
      kanbanLedgerPane.classList.toggle('hidden');
      if (!kanbanLedgerPane.classList.contains('hidden')) {
        renderLedgerEntries();
        // Smooth scroll details
        kanbanLedgerPane.scrollIntoView({ behavior: 'smooth' });
      }
    }
  });
}

if (closeLedgerPaneBtn) {
  closeLedgerPaneBtn.addEventListener('click', () => {
    kanbanLedgerPane?.classList.add('hidden');
  });
}

if (ledgerTabActive && ledgerTabInactive) {
  ledgerTabActive.addEventListener('click', () => {
    activeLedgerTab = 'active';
    ledgerTabActive.style.background = 'rgba(244,63,94,0.1)';
    ledgerTabActive.style.color = '#f43f5e';
    ledgerTabActive.style.borderColor = 'rgba(244,63,94,0.3)';
    
    ledgerTabInactive.style.background = 'transparent';
    ledgerTabInactive.style.color = 'var(--text-muted)';
    ledgerTabInactive.style.borderColor = 'var(--border-subtle)';
    renderLedgerEntries();
  });

  ledgerTabInactive.addEventListener('click', () => {
    activeLedgerTab = 'inactive';
    ledgerTabInactive.style.background = 'rgba(16,185,129,0.1)';
    ledgerTabInactive.style.color = '#10b981';
    ledgerTabInactive.style.borderColor = 'rgba(16,185,129,0.3)';
    
    ledgerTabActive.style.background = 'transparent';
    ledgerTabActive.style.color = 'var(--text-muted)';
    ledgerTabActive.style.borderColor = 'var(--border-subtle)';
    renderLedgerEntries();
  });
}

// Sub-tabs switching details
const ledgerMainTabGrievances = document.getElementById('ledger-main-tab-grievances');
const ledgerMainTabTasks = document.getElementById('ledger-main-tab-tasks');
const ledgerGrievancePanel = document.getElementById('ledger-grievance-panel');
const ledgerTasksPanel = document.getElementById('ledger-tasks-panel');

if (ledgerMainTabGrievances && ledgerMainTabTasks) {
  ledgerMainTabGrievances.addEventListener('click', () => {
    ledgerMainTabGrievances.classList.add('active');
    ledgerMainTabTasks.classList.remove('active');
    
    ledgerMainTabGrievances.style.background = '';
    ledgerMainTabGrievances.style.color = '';
    ledgerMainTabGrievances.style.borderColor = '';
    
    ledgerMainTabTasks.style.background = 'transparent';
    ledgerMainTabTasks.style.color = 'var(--text-muted)';
    ledgerMainTabTasks.style.borderColor = 'var(--border-subtle)';
    
    ledgerGrievancePanel.classList.remove('hidden');
    ledgerTasksPanel.classList.add('hidden');
    renderLedgerEntries();
  });

  ledgerMainTabTasks.addEventListener('click', () => {
    ledgerMainTabTasks.classList.add('active');
    ledgerMainTabGrievances.classList.remove('active');
    
    ledgerMainTabTasks.style.background = '';
    ledgerMainTabTasks.style.color = '';
    ledgerMainTabTasks.style.borderColor = '';
    
    ledgerMainTabGrievances.style.background = 'transparent';
    ledgerMainTabGrievances.style.color = 'var(--text-muted)';
    ledgerMainTabGrievances.style.borderColor = 'var(--border-subtle)';
    
    ledgerTasksPanel.classList.remove('hidden');
    ledgerGrievancePanel.classList.add('hidden');
    renderLedgerTasks();
  });
}

function renderLedgerTasks() {
  const container = document.getElementById('ledger-tasks-list-container');
  if (!container) return;

  // Filter tasks that have client emails mapped
  const mappedTasks = localTasks.filter(t => t.client_email);

  if (mappedTasks.length === 0) {
    container.innerHTML = '<div style="font-size:12.5px; color:var(--text-muted); padding:16px 0; text-align:center;">No operations tasks associated with client email addresses.</div>';
    return;
  }

  container.innerHTML = mappedTasks.map(t => {
    return `
      <div style="background:var(--bg-elevated); padding:12px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight:700; font-size:13px; color:var(--text-primary);">${escHtml(t.title)}</div>
          <div style="font-size:11.5px; color:var(--accent-primary); margin-top:2px;">Client: ${escHtml(t.client_email)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Status: <span style="font-weight:600; color:var(--text-secondary);">${t.status === 'todo' ? 'To Do' : t.status === 'inprogress' ? 'In Progress' : 'Done'}</span></div>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-ghost btn-xs" onclick="openTaskModalById('${t.id}')">✏️ Edit / View</button>
        </div>
      </div>
    `;
  }).join('');
}

async function renderLedgerEntries() {
  const container = document.getElementById('ledger-list-container');
  if (!container || !currentUser) return;

  container.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">Fetching tickets Ledger...</div>';
  try {
    idToken = await currentUser.getIdToken();
    const res = await fetch('/api/crm/interactions', {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (!res.ok) throw new Error('Failed to load interactions from server');
    
    const data = await res.json();
    renderLedgerHtml(data.interactions || [], container);
  } catch (err) {
    container.innerHTML = `<div style="font-size:12px; color:#ef4444;">Failed to load entries: ${escHtml(err.message)}</div>`;
  }
}

function renderLedgerHtml(allInteractions, container) {
  // Sort descending by date
  allInteractions.sort((a, b) => b.created_at - a.created_at);

  // Group latest interaction status to check if active/inactive grievance
  const clientLatest = {};
  allInteractions.forEach(log => {
    const email = log.client_email.toLowerCase().trim();
    if (!clientLatest[email] || log.created_at > clientLatest[email].created_at) {
      clientLatest[email] = log;
    }
  });

  // Filter based on activeLedgerTab selection
  const filtered = allInteractions.filter(log => {
    if (activeLedgerTab === 'active') {
      // Show ALL active complaints (has_grievance is true)
      return log.has_grievance === true;
    } else {
      // Show resolved/inactive logs (has_grievance is false)
      return log.has_grievance === false;
    }
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="font-size:12.5px; color:var(--text-muted); padding:16px 0; text-align:center;">No ${activeLedgerTab === 'active' ? 'active' : 'resolved/inactive'} tickets in this ledger list.</div>`;
    return;
  }

  container.innerHTML = filtered.map(log => {
    const actionBtn = log.has_grievance
      ? `<button class="btn btn-secondary btn-xs" style="background:rgba(16,185,129,0.1); color:#10b981; border-color:rgba(16,185,129,0.3);" onclick="toggleGrievanceResolveStatus('${log.id}', false)">Resolve</button>`
      : `<button class="btn btn-secondary btn-xs" style="background:rgba(244,63,94,0.1); color:#f43f5e; border-color:rgba(244,63,94,0.3);" onclick="toggleGrievanceResolveStatus('${log.id}', true)">Make Active</button>`;
      
    const convertTaskBtn = `<button class="btn btn-secondary btn-xs" style="background:rgba(99,102,241,0.1); color:#818cf8; border-color:rgba(129,140,248,0.3);" onclick="convertGrievanceToTask('${escHtml(log.client_email)}', '${escHtml(log.topic)}', '${escHtml(log.outcome)}')">Create Operations Task</button>`;

    return `
      <div style="background:var(--bg-elevated); padding:12px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-weight:700; color:var(--text-primary); font-size:12.5px;">👤 ${escHtml(log.client_email)}</span>
          <span style="font-size:11px; color:var(--text-muted);">${escHtml(log.date)}</span>
        </div>
        <div style="font-size:12px; font-weight:600; color:var(--text-secondary);">Topic: ${escHtml(log.topic)}</div>
        <div style="font-size:12px; color:var(--text-muted); line-height:1.4;">Outcome: ${escHtml(log.outcome)}</div>
        <div style="display:flex; justify-content:flex-end; gap:8px; border-top:1px solid var(--border-subtle); padding-top:8px; margin-top:4px;">
          ${convertTaskBtn}
          ${actionBtn}
        </div>
      </div>
    `;
  }).join('');
}

window.convertGrievanceToTask = (clientEmail, topic, outcome) => {
  openTaskModal(null, 'todo');
  if (taskTitleInput) taskTitleInput.value = `Grievance: ${topic}`;
  if (taskClientEmailInput) taskClientEmailInput.value = clientEmail;
  if (taskDescInput) taskDescInput.value = `Client Grievance Details:\nTopic: ${topic}\nOutcome: ${outcome}`;
};

window.toggleGrievanceResolveStatus = async (logId, makeActive) => {
  try {
    idToken = await currentUser.getIdToken();
    // Load full interaction object to preserve topic/outcome details
    const res = await fetch(`/api/crm/interactions`, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (!res.ok) throw new Error('Fetch details failed');
    const data = await res.json();
    const matched = (data.interactions || []).find(l => l.id === logId);
    if (!matched) throw new Error('Touchpoint ticket not found');

    const updateRes = await fetch(`/api/crm/interactions/${logId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        client_email: matched.client_email,
        date: matched.date,
        topic: matched.topic,
        outcome: matched.outcome,
        has_grievance: makeActive
      })
    });

    if (!updateRes.ok) throw new Error('Update failed');
    
    showToast(makeActive ? 'Ticket reopened (marked active).' : 'Ticket marked as resolved (inactive).', 'success');
    
    // Refresh ledger container and analytics
    renderLedgerEntries();
    
    // Refresh operations board analytics & client directory markers
    const crmRes = await fetch('/api/crm/analytics', {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (crmRes.ok) {
      const crmData = await crmRes.json();
      window.clientGrievanceEmails = crmData.grievance_emails || [];
      updateKanbanAnalytics(crmData.active_grievances || 0);
      renderProfilesList();
      if (window.activeInspectedProfile) {
        renderProfileDetail(window.activeInspectedProfile);
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

function renderKanbanTasks() {
  if (!kanbanTodo || !kanbanInprogress || !kanbanDone) return;
  
  // Calculate Task stats
  const totalTasksEl = document.getElementById('stat-total-tasks');
  const completionRateEl = document.getElementById('stat-completion-rate');
  if (totalTasksEl) totalTasksEl.textContent = localTasks.length;
  if (completionRateEl) {
    const total = localTasks.length;
    const completed = localTasks.filter(t => t.status === 'done').length;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
    completionRateEl.textContent = `${rate}%`;
  }
  
  kanbanTodo.innerHTML = '';
  kanbanInprogress.innerHTML = '';
  kanbanDone.innerHTML = '';
  
  let counts = { todo: 0, inprogress: 0, done: 0 };
  
  localTasks.forEach(task => {
    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.setAttribute('draggable', 'true');
    card.dataset.taskId = task.id;
    
    const formattedDate = new Date(task.created_at * 1000).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    const clientHtml = task.client_email ? `<div style="font-size:11px; margin: 4px 0; color:var(--accent-primary); display:flex; align-items:center; gap:4px;">👤 ${escHtml(task.client_email)}</div>` : '';
    const companyHtml = task.company ? `<div style="display:inline-block; font-size:9.5px; font-weight:700; background:rgba(99,102,241,0.1); color:var(--accent-primary); padding:1px 6px; border-radius:3px; margin: 2px 0 6px 0;">🏢 ${escHtml(task.company)}</div>` : '';

    card.innerHTML = `
      <button class="kanban-card-edit-btn" title="Edit Task">✏️</button>
      <div class="kanban-card-title">${escHtml(task.title)}</div>
      ${clientHtml}
      ${companyHtml}
      ${task.description ? `<div class="kanban-card-desc">${escHtml(task.description)}</div>` : ''}
      <div class="kanban-card-meta">
        <span>⏰ ${formattedDate}</span>
      </div>
    `;
    
    // Drag Start
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', task.id);
      card.style.opacity = '0.5';
    });
    
    // Drag End
    card.addEventListener('dragend', () => {
      card.style.opacity = '1';
    });
    
    // Edit Button Click
    card.querySelector('.kanban-card-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openTaskModal(task);
    });
    
    if (task.status === 'todo') {
      kanbanTodo.appendChild(card);
      counts.todo++;
    } else if (task.status === 'inprogress') {
      kanbanInprogress.appendChild(card);
      counts.inprogress++;
    } else if (task.status === 'done') {
      kanbanDone.appendChild(card);
      counts.done++;
    }
  });
  
  if (todoCount) todoCount.textContent = counts.todo;
  if (inprogressCount) inprogressCount.textContent = counts.inprogress;
  if (doneCount) doneCount.textContent = counts.done;
}

// Drag & Drop event bindings for Columns
document.querySelectorAll('.kanban-column').forEach(column => {
  column.addEventListener('dragover', (e) => {
    e.preventDefault();
    column.classList.add('dragover');
  });
  
  column.addEventListener('dragleave', () => {
    column.classList.remove('dragover');
  });
  
  column.addEventListener('drop', async (e) => {
    e.preventDefault();
    column.classList.remove('dragover');
    
    const taskId = e.dataTransfer.getData('text/plain');
    const newStatus = column.dataset.status;
    
    const task = localTasks.find(t => t.id === taskId);
    if (task && task.status !== newStatus) {
      // Optimistic update
      const prevStatus = task.status;
      task.status = newStatus;
      renderKanbanTasks();
      
      try {
        await apiSaveTask(task);
        showToast(`Task moved to ${newStatus === 'inprogress' ? 'In Progress' : newStatus === 'todo' ? 'To Do' : 'Done'}`, 'success');
      } catch (err) {
        task.status = prevStatus;
        renderKanbanTasks();
        showToast('Failed to update task status on server', 'error');
      }
    }
  });
});

// Task Modal Operations
function openTaskModal(task = null) {
  if (!taskModal) return;
  taskModal.classList.remove('hidden');
  
  const clientEmailEl = document.getElementById('task-client-email-input');
  const companyEl = document.getElementById('task-company-input');

  if (task) {
    if (taskIdInput) taskIdInput.value = task.id;
    if (taskTitleInput) taskTitleInput.value = task.title;
    if (taskDescInput) taskDescInput.value = task.description || '';
    if (taskStatusSelect) taskStatusSelect.value = task.status;
    if (clientEmailEl) clientEmailEl.value = task.client_email || '';
    if (companyEl) companyEl.value = task.company || '';
    if (taskDeleteBtn) taskDeleteBtn.style.display = 'block';
    const titleEl = document.getElementById('task-modal-title');
    if (titleEl) titleEl.textContent = '✏️ Edit Operations Task';
  } else {
    if (taskIdInput) taskIdInput.value = '';
    if (taskTitleInput) taskTitleInput.value = '';
    if (taskDescInput) taskDescInput.value = '';
    if (taskStatusSelect) taskStatusSelect.value = 'todo';
    if (clientEmailEl) clientEmailEl.value = '';
    if (companyEl) companyEl.value = '';
    if (taskDeleteBtn) taskDeleteBtn.style.display = 'none';
    const titleEl = document.getElementById('task-modal-title');
    if (titleEl) titleEl.textContent = '📋 Create Operations Task';
  }
}

function closeTaskModal() {
  if (taskModal) taskModal.classList.add('hidden');
}

// Wire crm auto-fetching input listener
const clientEmailInput = document.getElementById('task-client-email-input');
const taskCompanyInput = document.getElementById('task-company-input');
if (clientEmailInput && taskCompanyInput) {
  clientEmailInput.addEventListener('input', () => {
    const emailVal = clientEmailInput.value.trim().toLowerCase();
    if (!emailVal) {
      taskCompanyInput.value = '';
      return;
    }
    
    // Scan profiles cache
    const matched = crmProfilesCache.find(p => p.email && p.email.toLowerCase().trim() === emailVal);
    if (matched) {
      taskCompanyInput.value = matched.company || '';
    }
  });
}

if (addKanbanTaskBtn) addKanbanTaskBtn.addEventListener('click', () => openTaskModal());
if (closeTaskModalBtn) closeTaskModalBtn.addEventListener('click', closeTaskModal);
if (taskCancelBtn) taskCancelBtn.addEventListener('click', closeTaskModal);

if (taskSaveBtn) {
  taskSaveBtn.addEventListener('click', async () => {
    if (!taskTitleInput || !taskTitleInput.value.trim()) {
      showToast('Task title is required', 'error');
      return;
    }
    
    const clientEmailVal = document.getElementById('task-client-email-input')?.value.trim() || '';
    const companyVal = document.getElementById('task-company-input')?.value.trim() || '';

    setLoading(taskSaveBtn, true, 'Saving…');
    const taskData = {
      title: taskTitleInput.value.trim(),
      description: taskDescInput ? taskDescInput.value.trim() : '',
      status: taskStatusSelect ? taskStatusSelect.value : 'todo',
      client_email: clientEmailVal,
      company: companyVal
    };
    if (taskIdInput && taskIdInput.value) {
      taskData.id = taskIdInput.value;
    }
    
    try {
      await apiSaveTask(taskData);
      showToast('Task saved successfully', 'success');
      closeTaskModal();
      await loadKanbanBoard();
      if (window.activeInspectedProfile) {
        renderProfileDetail(window.activeInspectedProfile);
      }
    } catch (err) {
      showToast(err.message || 'Save task failed', 'error');
    } finally {
      setLoading(taskSaveBtn, false, '💾 Save Task');
    }
  });
}

if (taskDeleteBtn) {
  taskDeleteBtn.addEventListener('click', async () => {
    const taskId = taskIdInput ? taskIdInput.value : '';
    if (!taskId) return;
    
    if (confirm('Are you sure you want to delete this task?')) {
      setLoading(taskDeleteBtn, true, 'Deleting…');
      try {
        await apiDeleteTask(taskId);
        showToast('Task deleted successfully', 'success');
        closeTaskModal();
        await loadKanbanBoard();
        if (window.activeInspectedProfile) {
          renderProfileDetail(window.activeInspectedProfile);
        }
      } catch (err) {
        showToast(err.message || 'Delete task failed', 'error');
      } finally {
        setLoading(taskDeleteBtn, false, '🗑️ Delete');
      }
    }
  });
}

// Convert Email to Kanban Ticket inside Modal
if (replyModalConvertTaskBtn) {
  replyModalConvertTaskBtn.addEventListener('click', () => {
    if (!activeReplyAlert) return;
    
    // Prepare values
    const taskTitle = `Follow up: ${activeReplyAlert.subject}`;
    const taskDesc = `Client: ${activeReplyAlert.reply_from}\nEmail snippet: "${activeReplyAlert.reply_snippet}"\nSent time: ${activeReplyAlert.sent_time}`;
    
    closeReplyModal();
    
    // Switch to Kanban tab visually
    const kanbanTabBtn = document.querySelector('[data-tab="kanban"]');
    if (kanbanTabBtn) {
      kanbanTabBtn.click();
    }
    
    openTaskModal({
      id: '',
      title: taskTitle,
      description: taskDesc,
      status: 'todo'
    });
  });
}


// ── CRM Client Profiles Logic ──
let crmProfilesCache = [];

async function loadProfiles() {
  if (!profilesList) return;
  window.clientGrievanceEmails = [];
  
  // Set up listeners once
  setupCrmListeners();
  
  // Fetch dynamic grievance analytics
  if (currentUser) {
    try {
      idToken = await currentUser.getIdToken();
      const crmRes = await fetch('/api/crm/analytics', {
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (crmRes.ok) {
        const crmData = await crmRes.json();
        window.clientGrievanceEmails = crmData.grievance_emails || [];
        updateKanbanAnalytics(crmData.active_grievances || 0);
        
        // Re-run renders to display active grievance indicators
        renderProfilesList();
        if (window.activeInspectedProfile) {
          renderProfileDetail(window.activeInspectedProfile);
        }
      }
    } catch (err) {
      console.error('Failed to load crm analytics:', err);
    }
  }
  
  // Load from localStorage or fallback to Graph
  const saved = localStorage.getItem('crm_imported_profiles');
  loadCrmSheetsHistory();
  if (saved) {
    try {
      crmProfilesCache = JSON.parse(saved);
      const clearBtn = document.getElementById('crm-clear-import-btn');
      if (clearBtn) clearBtn.style.display = 'block';
      const dropzone = document.getElementById('crm-import-dropzone');
      if (dropzone) dropzone.style.display = 'none';
      renderProfilesList();
      return;
    } catch (e) {
      console.error('Failed to parse saved profiles:', e);
    }
  }

  profilesList.innerHTML = '<div class="empty-state">No client profiles loaded. Drag & drop or import a spreadsheet above to start!</div>';
  const dropzone = document.getElementById('crm-import-dropzone');
  if (dropzone) dropzone.style.display = 'block';
}

let crmListenersWired = false;
function setupCrmListeners() {
  if (crmListenersWired) return;
  crmListenersWired = true;
  
  const fileInput = document.getElementById('crm-file-input');
  const dropzone = document.getElementById('crm-import-dropzone');
  const clearBtn = document.getElementById('crm-clear-import-btn');
  const colFilter = document.getElementById('crm-column-filter');
  
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleCrmFileImport(file);
    });
  }
  
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent-primary)';
      dropzone.style.background = 'rgba(129, 140, 248, 0.05)';
    });
    
    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = 'var(--border-subtle)';
      dropzone.style.background = 'rgba(0,0,0,0.1)';
    });
    
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--border-subtle)';
      dropzone.style.background = 'rgba(0,0,0,0.1)';
      const file = e.dataTransfer.files[0];
      if (file) handleCrmFileImport(file);
    });
    
    dropzone.addEventListener('click', () => {
      fileInput?.click();
    });
  }
  
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear the imported client database?')) {
        localStorage.removeItem('crm_imported_profiles');
        crmProfilesCache = [];
        clearBtn.style.display = 'none';
        if (dropzone) dropzone.style.display = 'block';
        if (profileDetailCard) {
          profileDetailCard.innerHTML = `
            <div class="empty-state">
              <div class="empty-icon">👥</div>
              <p>Select a client from the directory sidebar to view full profiles.</p>
            </div>
          `;
        }
        loadProfiles();
      }
    });
  }
  
  if (crmProfileSearch) {
    crmProfileSearch.addEventListener('input', renderProfilesList);
  }
  if (colFilter) {
    colFilter.addEventListener('change', renderProfilesList);
  }
}

function handleCrmFileImport(file) {
  showToast('Reading spreadsheet...', 'info');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      
      if (rows.length < 2) {
        showToast('Spreadsheet does not contain enough rows/data.', 'error');
        return;
      }
      
      const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
      
      // Target Columns detection
      const mapIndex = (variants) => headers.findIndex(h => variants.some(v => h.includes(v)));
      
      const idxName = mapIndex(['client name', 'name', 'full name', 'contact name']);
      const idxEmail = mapIndex(['client email', 'email', 'mail', 'e-mail']);
      const idxPhone = mapIndex(['client contact number', 'phone', 'contact', 'number', 'mobile']);
      const idxCompany = mapIndex(['company name', 'company', 'org', 'organization']);
      const idxRevenue = mapIndex(['company revenue', 'revenue', 'turnover']);
      const idxEmployees = mapIndex(['employee count', 'employee', 'size', 'employees']);
      const idxIndustry = mapIndex(['industry', 'sector']);
      const idxStatus = mapIndex(['status', 'stage']);
      
      const parsedProfiles = [];
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        
        const val = (idx) => idx !== -1 && row[idx] !== undefined ? String(row[idx]).trim() : '';
        
        const name = val(idxName);
        const email = val(idxEmail);
        
        if (!name && !email) continue; // skip blank rows
        
        parsedProfiles.push({
          id: `client_${i}_${Math.random().toString(36).substr(2, 4)}`,
          name: name || email.split('@')[0],
          email: email || '',
          phone: val(idxPhone),
          company: val(idxCompany),
          revenue: val(idxRevenue),
          employees: val(idxEmployees),
          industry: val(idxIndustry),
          status: val(idxStatus) || 'Lead',
          emails: [], // Timeline placeholders
          topics: [],
          organizations: val(idxCompany) ? [val(idxCompany)] : []
        });
      }
      
      // Add incremental merge behavior (don't overwrite present profiles data, merge them)
      const currentSaved = localStorage.getItem('crm_imported_profiles');
      let mergedProfiles = [];
      if (currentSaved) {
        try {
          mergedProfiles = JSON.parse(currentSaved);
        } catch (e) {
          mergedProfiles = [];
        }
      }

      // Check duplicates before inserting new records
      const existingEmails = new Set(mergedProfiles.map(p => String(p.email || '').trim().toLowerCase()));
      parsedProfiles.forEach(p => {
        const mailKey = String(p.email || '').trim().toLowerCase();
        if (!mailKey || !existingEmails.has(mailKey)) {
          mergedProfiles.push(p);
          if (mailKey) existingEmails.add(mailKey);
        }
      });
      
      crmProfilesCache = mergedProfiles;
      localStorage.setItem('crm_imported_profiles', JSON.stringify(mergedProfiles));
      
      // Save entry to CRM import history log
      const newHistoryItem = {
        id: `crm_sheet_${Date.now()}`,
        filename: file.name,
        importedAt: new Date().toLocaleString(),
        clientCount: parsedProfiles.length,
        profileIds: parsedProfiles.map(p => p.id)
      };

      const crmHistory = JSON.parse(localStorage.getItem('crm_sheets_history') || '[]');
      crmHistory.unshift(newHistoryItem);
      localStorage.setItem('crm_sheets_history', JSON.stringify(crmHistory));
      loadCrmSheetsHistory();

      showToast(`Imported ${parsedProfiles.length} clients! Database contains ${mergedProfiles.length} profiles.`, 'success');
      
      const clearBtn = document.getElementById('crm-clear-import-btn');
      if (clearBtn) clearBtn.style.display = 'block';
      const dropzone = document.getElementById('crm-import-dropzone');
      if (dropzone) dropzone.style.display = 'none';
      
      renderProfilesList();
    } catch (err) {
      console.error(err);
      showToast('Failed to parse spreadsheet: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

// CRM Import History persistence helpers
function loadCrmSheetsHistory() {
  const historyListEl = document.getElementById('crm-history-list');
  if (!historyListEl) return;

  const history = JSON.parse(localStorage.getItem('crm_sheets_history') || '[]');
  
  if (history.length === 0) {
    historyListEl.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:4px 0;">No logs yet.</div>';
    return;
  }

  historyListEl.innerHTML = history.map((item) => `
    <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:6px 10px; display:flex; flex-direction:column; gap:2px; font-size:11.5px; position:relative;">
      <div style="font-weight:600; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; padding-right:20px;">${escHtml(item.filename)}</div>
      <div style="font-size:10px; color:var(--text-muted);">${escHtml(item.importedAt)}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
        <span style="font-size:10.5px; color:var(--accent-primary); font-weight:600;">👥 ${item.clientCount} clients</span>
        <button class="btn btn-ghost btn-xs" style="color:#ef4444; border-color:transparent; padding:0; font-size:10.5px; font-weight:700; cursor:pointer;" onclick="deleteCrmHistorySheet(event, '${item.id}')">🗑️ Delete</button>
      </div>
    </div>
  `).join('');
}

window.deleteCrmHistorySheet = (event, id) => {
  if (event) event.stopPropagation();
  if (!confirm('Delete this import record? This deletes imported profiles associated with this spreadsheet while keeping the rest.')) return;

  let history = JSON.parse(localStorage.getItem('crm_sheets_history') || '[]');
  const matched = history.find(item => item.id === id);
  if (!matched) return;

  // Filter out profiles matching this import sheet ID
  const idsToRemove = matched.profileIds || [];
  let savedProfiles = [];
  try {
    savedProfiles = JSON.parse(localStorage.getItem('crm_imported_profiles') || '[]');
  } catch (e) {
    savedProfiles = [];
  }
  
  savedProfiles = savedProfiles.filter(p => !idsToRemove.includes(p.id));
  crmProfilesCache = savedProfiles;
  localStorage.setItem('crm_imported_profiles', JSON.stringify(savedProfiles));

  // Remove sheet from history list
  history = history.filter(item => item.id !== id);
  localStorage.setItem('crm_sheets_history', JSON.stringify(history));

  loadCrmSheetsHistory();
  renderProfilesList();
  
  if (profileDetailCard) {
    profileDetailCard.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <p>Select a client from the directory sidebar to view full profiles.</p>
      </div>
    `;
  }

  showToast('Spreadsheet records deleted from client directory.', 'success');
};

function renderProfilesList() {
  if (!profilesList) return;
  profilesList.innerHTML = '';
  
  const query = crmProfileSearch ? crmProfileSearch.value.toLowerCase().trim() : '';
  const filterCol = document.getElementById('crm-column-filter') ? document.getElementById('crm-column-filter').value : 'all';
  
  const filtered = crmProfilesCache.filter(p => {
    if (!query) return true;
    
    const matches = (field) => String(field || '').toLowerCase().includes(query);
    
    if (filterCol === 'name') return matches(p.name);
    if (filterCol === 'email') return matches(p.email);
    if (filterCol === 'company') return matches(p.company);
    if (filterCol === 'industry') return matches(p.industry);
    if (filterCol === 'status') return matches(p.status);
    
    // 'all' search
    return matches(p.name) || matches(p.email) || matches(p.company) || matches(p.industry) || matches(p.status);
  });
  
  if (filtered.length === 0) {
    profilesList.innerHTML = '<div class="empty-state">No matching clients found</div>';
    return;
  }
  
  filtered.forEach(profile => {
    const card = document.createElement('div');
    
    // Check if client email has active grievance
    const hasGrievance = window.clientGrievanceEmails && window.clientGrievanceEmails.includes(profile.email.toLowerCase().trim());
    card.className = `profile-card ${hasGrievance ? 'grievance-profile-card' : ''}`;
    if (hasGrievance) {
      card.style.borderLeft = '3px solid #f43f5e';
    }
    
    const tagHtml = hasGrievance 
      ? '<span class="tag-pill" style="background:rgba(244, 63, 94, 0.1); color:#f43f5e; border:1px solid rgba(244, 63, 94, 0.2); font-size:10px; padding:1px 6px; font-weight:700;">Grievance</span>'
      : `<span class="tag-pill" style="background:rgba(129, 140, 248, 0.1); color:var(--accent-primary); border:1px solid rgba(129, 140, 248, 0.2); font-size:10px; padding:1px 6px;">${escHtml(profile.status)}</span>`;

    // Compute metric badges for client card
    const clientEmailClean = (profile.email || '').toLowerCase().trim();
    const taskCount = localTasks.filter(t => (t.client_email && t.client_email.toLowerCase().trim() === clientEmailClean)).length;
    const taskBadgeHtml = taskCount > 0 ? `<span style="font-size:10px; background:rgba(99,102,241,0.15); color:#818cf8; padding:1px 6px; border-radius:10px; font-weight:600;">${taskCount} tasks</span>` : '';

    card.innerHTML = `
      <div class="profile-card-title">${escHtml(profile.name)}</div>
      <div class="profile-card-subtitle">${escHtml(profile.email)}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:11px;">
        <span style="color:var(--text-muted);">${escHtml(profile.company || 'N/A')}</span>
        <div style="display:flex; gap:4px; align-items:center;">
          ${taskBadgeHtml}
          ${tagHtml}
        </div>
      </div>
    `;
    
    card.addEventListener('click', () => {
      document.querySelectorAll('.profile-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      renderProfileDetail(profile);
    });
    
    profilesList.appendChild(card);
  });
}

function renderProfileDetail(profile) {
  if (!profileDetailCard) return;
  window.activeInspectedProfile = profile;
  
  // Find associated local Kanban tasks
  const clientEmailClean = profile.email.toLowerCase().trim();
  const associatedTasks = localTasks.filter(task => 
    (task.client_email && task.client_email.toLowerCase().trim() === clientEmailClean) ||
    (task.description && task.description.toLowerCase().includes(clientEmailClean))
  );
  
  let tasksHtml = '';
  if (associatedTasks.length === 0) {
    tasksHtml = '<div style="font-size:12.5px; color:var(--text-muted);">No active tasks tickets for this client.</div>';
  } else {
    tasksHtml = `<div style="display:flex; flex-direction:column; gap:8px;">
      ${associatedTasks.map(t => `
        <div style="background:var(--bg-elevated); padding:10px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600; font-size:13px; color:var(--text-primary);">${escHtml(t.title)}</div>
            <div style="font-size:11.5px; color:var(--text-muted);">Status: ${t.status === 'todo' ? 'To Do' : t.status === 'inprogress' ? 'In Progress' : 'Done'}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="openTaskModalById('${t.id}')">View</button>
        </div>
      `).join('')}
    </div>`;
  }
  
  profileDetailCard.innerHTML = `
    <div style="border-bottom:1px solid var(--border-subtle); padding-bottom:16px; display:flex; justify-content:space-between; align-items:flex-start;">
      <div>
        <h2 style="margin:0 0 4px 0; font-size:20px; font-weight:700; color:var(--text-primary);">${escHtml(profile.name)}</h2>
        <div style="font-size:13.5px; color:var(--text-secondary);">📧 ${escHtml(profile.email || 'No email')} | 📞 ${escHtml(profile.phone || 'No phone')}</div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-secondary btn-sm" id="crm-compose-btn">✉️ Quick Compose</button>
      </div>
    </div>
    
    <!-- Profile Grid details -->
    <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-top:8px;">
      <div style="background:var(--bg-elevated); padding:10px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Company</div>
        <div style="font-weight:600; font-size:13px; color:var(--text-primary); margin-top:2px;">${escHtml(profile.company || 'N/A')}</div>
      </div>
      <div style="background:var(--bg-elevated); padding:10px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Industry</div>
        <div style="font-weight:600; font-size:13px; color:var(--text-primary); margin-top:2px;">${escHtml(profile.industry || 'N/A')}</div>
      </div>
      <div style="background:var(--bg-elevated); padding:10px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Employees</div>
        <div style="font-weight:600; font-size:13px; color:var(--text-primary); margin-top:2px;">${escHtml(profile.employees || 'N/A')}</div>
      </div>
      <div style="background:var(--bg-elevated); padding:10px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Revenue</div>
        <div style="font-weight:600; font-size:13px; color:var(--text-primary); margin-top:2px;">${escHtml(profile.revenue || 'N/A')}</div>
      </div>
    </div>

    <div>
      <h3 style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--text-muted); margin:0 0 8px 0; border-bottom: 1px solid var(--border-subtle); padding-bottom:6px;">Current Status</h3>
      ${window.clientGrievanceEmails && window.clientGrievanceEmails.includes(profile.email.toLowerCase().trim())
        ? `<span class="tag-pill" style="background:rgba(244,63,94,0.1); color:#f43f5e; border:1px solid rgba(244,63,94,0.2); padding:4px 12px; border-radius:12px; font-size:12px; font-weight:600;">⚠️ Grievance / Complaint Reported</span>`
        : `<span class="tag-pill" style="background:rgba(16,185,129,0.1); color:#10b981; border:1px solid rgba(16,185,129,0.2); padding:4px 12px; border-radius:12px; font-size:12px; font-weight:600;">${escHtml(profile.status)}</span>`
      }
    </div>
    
    <div>
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--border-subtle); padding-bottom:6px; margin: 0 0 8px 0;">
        <h3 style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--text-muted); margin:0;">Active Tasks Tickets</h3>
        <button class="btn btn-primary btn-sm" id="crm-add-task-btn" style="padding: 4px 10px; font-size:11px;">+ Add Task</button>
      </div>
      ${tasksHtml}
    </div>

    <!-- Communication Touchpoints Ledger Section -->
    <div>
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--border-subtle); padding-bottom:6px; margin: 20px 0 8px 0;">
        <h3 style="font-size:13px; font-weight:700; text-transform:uppercase; color:var(--text-muted); margin:0;">📞 Touchpoint Logs & Grievances</h3>
        <button class="btn btn-primary btn-sm" id="crm-log-touchpoint-btn" style="padding: 4px 10px; font-size:11px;">+ Log Touchpoint</button>
      </div>
      <div id="crm-touchpoints-list" style="display:flex; flex-direction:column; gap:8px;">
        <div style="font-size:12.5px; color:var(--text-muted);">Loading touchpoint records...</div>
      </div>
    </div>
  `;
  
  // Wire Quick Compose Button
  const crmComposeBtn = document.getElementById('crm-compose-btn');
  if (crmComposeBtn) {
    crmComposeBtn.addEventListener('click', () => {
      openCompose(profile.email, '', '');
    });
  }

  // Wire Log Touchpoint Button
  const logTouchBtn = document.getElementById('crm-log-touchpoint-btn');
  if (logTouchBtn) {
    logTouchBtn.addEventListener('click', () => {
      const modal = document.getElementById('crm-interaction-modal');
      const title = document.getElementById('crm-int-modal-title');
      const emailField = document.getElementById('crm-int-client-email');
      const dateField = document.getElementById('crm-int-date');
      
      if (modal && emailField && dateField) {
        window.editingTouchpointId = null;
        if (title) title.innerHTML = '📞 Log Communication Outcome';
        
        emailField.value = profile.email;
        dateField.value = new Date().toISOString().split('T')[0];
        document.getElementById('crm-int-topic').value = '';
        document.getElementById('crm-int-outcome').value = '';
        // Reset grievance state in both DOM and JS variable
        const grievanceCheckbox = document.getElementById('crm-int-grievance');
        if (grievanceCheckbox) grievanceCheckbox.checked = false;
        window._crmGrievanceFlag = false;
        
        // Reset toggle button appearance
        const grievanceToggle = document.getElementById('crm-grievance-toggle');
        if (grievanceToggle) {
          grievanceToggle.style.background = 'transparent';
          grievanceToggle.style.color = 'var(--text-muted)';
          grievanceToggle.style.borderColor = 'var(--border-subtle)';
          grievanceToggle.textContent = '⚠️ Mark as Grievance / Complaint';
        }
        modal.classList.remove('hidden');
      }
    });
  }

  // Wire Add Task Button
  const crmAddTaskBtn = document.getElementById('crm-add-task-btn');
  if (crmAddTaskBtn) {
    crmAddTaskBtn.addEventListener('click', () => {
      openTaskModal();
      // Pre-fill fields with this profile's info
      const clientEmailEl = document.getElementById('task-client-email-input');
      const companyEl = document.getElementById('task-company-input');
      if (clientEmailEl) clientEmailEl.value = profile.email || '';
      if (companyEl) companyEl.value = profile.company || '';
    });
  }

  // Load actual touchpoint records for this client
  loadTouchpointLogs(profile.email);
}



// Global helper to open task modal by ID (for CRM click triggers)
window.openTaskModalById = (taskId) => {
  const task = localTasks.find(t => t.id === taskId);
  if (task) {
    openTaskModal(task);
  }
};

// ── Hamburger Drawer Navigation ──
const hamburgerBtn = document.getElementById('hamburger-btn');
const sidebarDrawer = document.getElementById('sidebar-drawer');
const closeDrawerBtn = document.getElementById('close-drawer-btn');
const drawerBackdrop = document.getElementById('drawer-backdrop');

function toggleDrawer(show) {
  if (!sidebarDrawer || !drawerBackdrop) return;
  if (show) {
    sidebarDrawer.classList.remove('hidden');
    drawerBackdrop.classList.remove('hidden');
  } else {
    sidebarDrawer.classList.add('hidden');
    drawerBackdrop.classList.add('hidden');
  }
}

if (hamburgerBtn) hamburgerBtn.addEventListener('click', () => toggleDrawer(true));
if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', () => toggleDrawer(false));
if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => toggleDrawer(false));

// Drawer item click bindings
document.querySelectorAll('.drawer-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tab = item.dataset.tab;
    toggleDrawer(false);
    
    // De-activate all drawer items
    document.querySelectorAll('.drawer-nav-item').forEach(d => d.classList.remove('active'));
    item.classList.add('active');
    
    // Simulate main header tab click
    const targetHeaderBtn = document.querySelector(`.tabs .tab-btn[data-tab="${tab}"]`);
    if (targetHeaderBtn) {
      targetHeaderBtn.click();
    } else {
      // If the tab is folded inside Priority Plus "More" dropdown:
      const dropdownItem = document.querySelector(`.tab-overflow-dropdown .tab-btn[data-tab="${tab}"]`);
      if (dropdownItem) {
        dropdownItem.click();
      }
    }
  });
});

// ── Settings Gear & Diagnostics Modal & Profile Setup ──
const settingsGearBtn = document.getElementById('settings-gear-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsModalBtn = document.getElementById('close-settings-modal-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');

// Profile & Settings Tabs refs
const settingsTabProfile = document.getElementById('settings-tab-profile');
const settingsTabSystem = document.getElementById('settings-tab-system');
const settingsProfilePanel = document.getElementById('settings-profile-panel');
const settingsSystemPanel = document.getElementById('settings-system-panel');
const profileSaveBtn = document.getElementById('profile-save-btn');

async function openSettingsModal() {
  if (!settingsModal) return;
  settingsModal.classList.remove('hidden');
  
  // Default active tab to Profile
  switchSettingsTab('profile');

  // Load profile values from backend
  try {
    idToken = await currentUser.getIdToken();
    const res = await fetch('/api/profile', {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (res.ok) {
      const profile = await res.json();
      document.getElementById('profile-name').value = profile.name || '';
      document.getElementById('profile-designation').value = profile.designation || '';
      document.getElementById('profile-company').value = profile.company_name || '';
      document.getElementById('profile-phone').value = profile.phone_number || '';
    }
  } catch (err) {
    console.error('Failed to load profile data:', err);
  }

  // Calculate local storage size
  let totalLength = 0;
  for (let x in localStorage) {
    if (localStorage.hasOwnProperty(x)) {
      totalLength += (localStorage[x].length + x.length) * 2; // UTF-16 characters = 2 bytes
    }
  }
  const sizeKb = (totalLength / 1024).toFixed(2);
  const storageEl = document.getElementById('diag-storage-size');
  if (storageEl) storageEl.textContent = `${sizeKb} KB`;
  
  // Stored Profiles Count
  const countEl = document.getElementById('diag-profiles-count');
  if (countEl) countEl.textContent = crmProfilesCache.length;
}

function switchSettingsTab(tab) {
  if (tab === 'profile') {
    settingsTabProfile.style.borderBottomColor = 'var(--accent-primary)';
    settingsTabProfile.style.color = 'var(--text-primary)';
    settingsTabProfile.style.fontWeight = '600';
    
    settingsTabSystem.style.borderBottomColor = 'transparent';
    settingsTabSystem.style.color = 'var(--text-muted)';
    settingsTabSystem.style.fontWeight = '400';
    
    settingsProfilePanel.classList.remove('hidden');
    settingsSystemPanel.classList.add('hidden');
  } else {
    settingsTabSystem.style.borderBottomColor = 'var(--accent-primary)';
    settingsTabSystem.style.color = 'var(--text-primary)';
    settingsTabSystem.style.fontWeight = '600';
    
    settingsTabProfile.style.borderBottomColor = 'transparent';
    settingsTabProfile.style.color = 'var(--text-muted)';
    settingsTabProfile.style.fontWeight = '400';
    
    settingsSystemPanel.classList.remove('hidden');
    settingsProfilePanel.classList.add('hidden');
  }
}

if (settingsTabProfile) {
  settingsTabProfile.addEventListener('click', () => switchSettingsTab('profile'));
}
if (settingsTabSystem) {
  settingsTabSystem.addEventListener('click', () => switchSettingsTab('system'));
}

if (profileSaveBtn) {
  profileSaveBtn.addEventListener('click', async () => {
    const name = document.getElementById('profile-name').value.trim();
    const designation = document.getElementById('profile-designation').value.trim();
    const company = document.getElementById('profile-company').value.trim();
    const phone = document.getElementById('profile-phone').value.trim();
    
    setLoading(profileSaveBtn, true, 'Saving…');
    try {
      idToken = await currentUser.getIdToken();
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          name: name,
          designation: designation,
          company_name: company,
          phone_number: phone
        })
      });
      if (res.ok) {
        showToast('User Profile saved successfully!', 'success');
      } else {
        throw new Error('Save response failed');
      }
    } catch (err) {
      showToast(err.message || 'Failed to save profile', 'error');
    } finally {
      setLoading(profileSaveBtn, false, '💾 Save Profile Settings');
    }
  });
}

if (settingsGearBtn) settingsGearBtn.addEventListener('click', openSettingsModal);
if (closeSettingsModalBtn) closeSettingsModalBtn.addEventListener('click', () => settingsModal?.classList.add('hidden'));
if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', () => settingsModal?.classList.add('hidden'));

// ── Priority Plus Tab Overflow Resizing ──
const tabOverflowBtn = document.getElementById('tab-overflow-btn');
const tabOverflowDropdown = document.getElementById('tab-overflow-dropdown');

if (tabOverflowBtn && tabOverflowDropdown) {
  tabOverflowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    tabOverflowDropdown.classList.toggle('hidden');
  });
  
  document.addEventListener('click', (e) => {
    if (!tabOverflowDropdown.classList.contains('hidden') && !tabOverflowDropdown.contains(e.target) && e.target !== tabOverflowBtn) {
      tabOverflowDropdown.classList.add('hidden');
    }
  });
}

// Bind clicks on overflow dropdown items to trigger navigation
document.querySelectorAll('.tab-overflow-dropdown .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    
    // Remove active state from all header tabs and panels
    document.querySelectorAll('.tabs .tab-btn').forEach(b => b.classList.remove('active'));
    tabPanels.forEach(p => p.classList.remove('active'));
    
    // Highlight "More" button as active
    tabOverflowBtn.classList.add('active');
    document.getElementById(`tab-${target}`).classList.add('active');
    
    // Close dropdown
    tabOverflowDropdown.classList.add('hidden');
    
    // Trigger respective loaders
    if (target === 'logs') {
      loadActivityLogs();
    } else if (target === 'scratchpad') {
      loadScratchpadContent();
    } else if (target === 'spreadsheet') {
      // spreadsheet viewer init
    } else if (target === 'calendar') {
      loadCalendarEvents();
    } else if (target === 'documents') {
      loadR2Documents();
    }
  });
});

// Remove active "More" styling when regular tabs are clicked
document.querySelectorAll('.visible-tabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    tabOverflowBtn?.classList.remove('active');
  });
});

// ── System Cleanliness actions triggers ──
const cleanProfilesBtn = document.getElementById('clean-profiles-btn');
const cleanTasksBtn = document.getElementById('clean-tasks-btn');
const cleanLogsBtn = document.getElementById('clean-logs-btn');

if (cleanProfilesBtn) {
  cleanProfilesBtn.addEventListener('click', () => {
    if (confirm('Clean imported Client database from Local Storage?')) {
      localStorage.removeItem('crm_imported_profiles');
      crmProfilesCache = [];
      showToast('Client profiles cleared.', 'success');
      loadProfiles();
      openSettingsModal(); // Refresh diagnostics numbers
    }
  });
}

if (cleanTasksBtn) {
  cleanTasksBtn.addEventListener('click', async () => {
    if (confirm('Wipe all operations task tickets from the server database (tasks.json)?')) {
      try {
        idToken = await currentUser.getIdToken();
        const res = await fetch('/api/tasks/clear', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${idToken}` }
        });
        if (res.ok) {
          showToast('Operational task tickets wiped successfully!', 'success');
          loadKanbanBoard();
          openSettingsModal();
        } else {
          showToast('Failed to wipe server tasks database.', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Wipe failed', 'error');
      }
    }
  });
}

if (cleanLogsBtn) {
  cleanLogsBtn.addEventListener('click', async () => {
    if (confirm('Wipe all System Audit Trail records from the server database (activity_logs.json)?')) {
      try {
        idToken = await currentUser.getIdToken();
        const res = await fetch('/api/logs/clear', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${idToken}` }
        });
        if (res.ok) {
          showToast('Audit trail purged successfully!', 'success');
          loadActivityLogs();
          openSettingsModal();
        } else {
          showToast('Failed to purge audit trail logs.', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Purge failed', 'error');
      }
    }
  });
}

// ── CRM Client Touchpoint Loader & Logger Functions ──
async function loadTouchpointLogs(clientEmail) {
  const listContainer = document.getElementById('crm-touchpoints-list');
  if (!listContainer) return;
  
  try {
    idToken = await currentUser.getIdToken();
    const res = await fetch(`/api/crm/interactions?client_email=${encodeURIComponent(clientEmail)}`, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    
    if (!res.ok) throw new Error('Failed to load touchpoint records');
    
    const data = await res.json();
    const list = data.interactions || [];
    window.activeTouchpointLogs = list;
    
    if (list.length === 0) {
      listContainer.innerHTML = '<div style="font-size:12.5px; color:var(--text-muted);">No touchpoint logs recorded for this client.</div>';
      return;
    }
    
    listContainer.innerHTML = list.map(log => `
      <div style="background:var(--bg-elevated); padding:10px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); border-left: 3px solid ${log.has_grievance ? '#f43f5e' : 'var(--accent-primary)'}; display:flex; flex-direction:column; gap:4px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-weight:700; font-size:12.5px; color:var(--text-primary);">📅 ${escHtml(log.date)}</span>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="btn btn-ghost btn-xs" style="padding: 2px 6px; font-size:11px; color:var(--accent-primary); border:1px solid rgba(129, 140, 248, 0.2);" onclick="editTouchpointById('${log.id}')">✏️ Edit</button>
            ${log.has_grievance ? '<span style="font-size:10px; font-weight:700; background:rgba(244,63,94,0.1); color:#f43f5e; border:1px solid rgba(244,63,94,0.2); padding:1px 6px; border-radius:12px;">⚠️ GRIEVANCE</span>' : '<span style="font-size:10px; font-weight:700; background:rgba(99,102,241,0.1); color:var(--accent-primary); padding:1px 6px; border-radius:12px;">Touchpoint</span>'}
          </div>
        </div>
        <div style="font-weight:600; font-size:13px; color:var(--text-primary); margin-top:2px;">Topic: ${escHtml(log.topic)}</div>
        <div style="font-size:12px; color:var(--text-secondary); line-height:1.4; white-space:pre-wrap;">Outcome: ${escHtml(log.outcome)}</div>
      </div>
    `).join('');
  } catch (err) {
    listContainer.innerHTML = `<div style="font-size:12.5px; color:var(--accent-error);">Error loading touchpoints: ${escHtml(err.message)}</div>`;
  }
}

// Wire save and cancel touchpoint actions
const closeCrmIntModalBtn = document.getElementById('close-crm-interaction-modal-btn');
const crmIntCancelBtn = document.getElementById('crm-int-cancel-btn');
const crmIntSaveBtn = document.getElementById('crm-int-save-btn');
const crmIntModal = document.getElementById('crm-interaction-modal');

if (closeCrmIntModalBtn) closeCrmIntModalBtn.addEventListener('click', () => crmIntModal?.classList.add('hidden'));
if (crmIntCancelBtn) crmIntCancelBtn.addEventListener('click', () => crmIntModal?.classList.add('hidden'));

// Track grievance toggle state via a reliable JS variable
window._crmGrievanceFlag = false;

// Wire grievance toggle button
const grievanceToggleBtn = document.getElementById('crm-grievance-toggle');
if (grievanceToggleBtn) {
  grievanceToggleBtn.addEventListener('click', () => {
    window._crmGrievanceFlag = !window._crmGrievanceFlag;
    if (window._crmGrievanceFlag) {
      grievanceToggleBtn.style.background = 'rgba(244, 63, 94, 0.12)';
      grievanceToggleBtn.style.color = '#f43f5e';
      grievanceToggleBtn.style.borderColor = 'rgba(244, 63, 94, 0.5)';
      grievanceToggleBtn.textContent = '⚠️ Grievance FLAGGED ✓ (Click to remove)';
    } else {
      grievanceToggleBtn.style.background = 'transparent';
      grievanceToggleBtn.style.color = 'var(--text-muted)';
      grievanceToggleBtn.style.borderColor = 'var(--border-subtle)';
      grievanceToggleBtn.textContent = '⚠️ Mark as Grievance / Complaint';
    }
  });
}

if (crmIntSaveBtn) {
  crmIntSaveBtn.addEventListener('click', async () => {
    const clientEmail = document.getElementById('crm-int-client-email').value;
    const date = document.getElementById('crm-int-date').value;
    const topic = document.getElementById('crm-int-topic').value.trim();
    const outcome = document.getElementById('crm-int-outcome').value.trim();
    // Read from reliable JS variable, not DOM .checked (which can be stale)
    const hasGrievance = window._crmGrievanceFlag === true;
    
    if (!topic || !outcome) {
      showToast('Please provide both a topic and an outcome summary.', 'error');
      return;
    }
    
    setLoading(crmIntSaveBtn, true, window.editingTouchpointId ? 'Updating…' : 'Logging…');
    try {
      idToken = await currentUser.getIdToken();
      
      const isEdit = !!window.editingTouchpointId;
      const url = isEdit ? `/api/crm/interactions/${window.editingTouchpointId}` : '/api/crm/interactions';
      const method = isEdit ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          client_email: clientEmail,
          date: date,
          topic: topic,
          outcome: outcome,
          has_grievance: hasGrievance
        })
      });
      
      if (!res.ok) throw new Error(isEdit ? 'Failed to update touchpoint' : 'Failed to save touchpoint');
      
      showToast(isEdit ? 'Touchpoint updated successfully!' : 'Touchpoint logged successfully!', 'success');
      crmIntModal.classList.add('hidden');
      
      // Refresh current client detail list view
      loadTouchpointLogs(clientEmail);

      // Reload Operations Board analytics bar
      const crmRes = await fetch('/api/crm/analytics', {
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (crmRes.ok) {
        const crmData = await crmRes.json();
        window.clientGrievanceEmails = crmData.grievance_emails || [];
        updateKanbanAnalytics(crmData.active_grievances || 0);
        
        // Refresh sidebar and detail layouts to display new status tags/badges
        renderProfilesList();
        if (window.activeInspectedProfile) {
          renderProfileDetail(window.activeInspectedProfile);
        }
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(crmIntSaveBtn, false);
    }
  });
}

window.editTouchpointById = (logId) => {
  const log = (window.activeTouchpointLogs || []).find(l => l.id === logId);
  if (!log) return;
  
  const modal = document.getElementById('crm-interaction-modal');
  const title = document.getElementById('crm-int-modal-title');
  const emailField = document.getElementById('crm-int-client-email');
  const dateField = document.getElementById('crm-int-date');
  const topicField = document.getElementById('crm-int-topic');
  const outcomeField = document.getElementById('crm-int-outcome');
  const grievanceToggleBtn = document.getElementById('crm-grievance-toggle');
  
  if (modal && emailField && dateField && topicField && outcomeField) {
    window.editingTouchpointId = log.id;
    if (title) title.innerHTML = '✏️ Edit Communication Outcome';
    
    emailField.value = log.client_email;
    dateField.value = log.date;
    topicField.value = log.topic;
    outcomeField.value = log.outcome;
    
    window._crmGrievanceFlag = log.has_grievance === true;
    if (grievanceToggleBtn) {
      if (window._crmGrievanceFlag) {
        grievanceToggleBtn.style.background = 'rgba(244, 63, 94, 0.12)';
        grievanceToggleBtn.style.color = '#f43f5e';
        grievanceToggleBtn.style.borderColor = 'rgba(244, 63, 94, 0.5)';
        grievanceToggleBtn.textContent = '⚠️ Grievance FLAGGED ✓ (Click to remove)';
      } else {
        grievanceToggleBtn.style.background = 'transparent';
        grievanceToggleBtn.style.color = 'var(--text-muted)';
        grievanceToggleBtn.style.borderColor = 'var(--border-subtle)';
        grievanceToggleBtn.textContent = '⚠️ Mark as Grievance / Complaint';
      }
    }
    
    modal.classList.remove('hidden');
  }
};

// ── Cloudflare R2 Document Vault ──────────────────────────────────────────────
let r2DocumentsCache = [];
let activeR2Direction = 'all';
let activeR2EmailFilter = '';
let activeR2Search = '';

async function loadR2Documents() {
  const grid = document.getElementById('r2-documents-grid');
  const refreshBtn = document.getElementById('refresh-r2-docs-btn');
  if (grid) {
    grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1; padding: 40px 20px;">
      <div class="empty-icon">📁</div>
      <p style="font-size:15px; font-weight:600; color:var(--text-primary); margin-bottom:6px;">Connecting to Cloudflare R2 Vault...</p>
      <p style="font-size:13px; color:var(--text-muted);">Fetching your multi-tenant encrypted files...</p>
    </div>`;
  }
  if (refreshBtn) setLoading(refreshBtn, true, 'Loading…');

  try {
    idToken = await currentUser.getIdToken();
    const data = await getR2Documents(idToken, 'all', '');
    r2DocumentsCache = data.documents || [];

    // Populate datalist of known counterparty emails
    const datalist = document.getElementById('r2-known-emails-datalist');
    if (datalist) {
      datalist.innerHTML = '';
      const uniqueEmails = [...new Set(r2DocumentsCache.map(d => d.associated_email).filter(Boolean))].sort();
      uniqueEmails.forEach(email => {
        const opt = document.createElement('option');
        opt.value = email;
        datalist.appendChild(opt);
      });
    }

    // Update stat numbers
    const totalCount = r2DocumentsCache.length;
    const incomingCount = r2DocumentsCache.filter(d => d.direction === 'incoming').length;
    const outgoingCount = r2DocumentsCache.filter(d => d.direction === 'outgoing').length;

    const statTotalEl = document.getElementById('stat-r2-total');
    const statIncEl = document.getElementById('stat-r2-incoming');
    const statOutEl = document.getElementById('stat-r2-outgoing');

    if (statTotalEl) statTotalEl.textContent = totalCount;
    if (statIncEl) statIncEl.textContent = incomingCount;
    if (statOutEl) statOutEl.textContent = outgoingCount;

    filterAndRenderR2Documents();
  } catch (err) {
    console.error('[R2VaultError]', err);
    showToast(`Failed to load R2 documents: ${err.message}`, 'error');
    if (grid) {
      grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1; padding: 40px 20px;">
        <div class="empty-icon">⚠️</div>
        <p style="font-size:15px; font-weight:600; color:#f87171; margin-bottom:6px;">Failed to load documents</p>
        <p style="font-size:13px; color:var(--text-muted);">${err.message || 'Error connecting to R2'}</p>
      </div>`;
    }
  } finally {
    if (refreshBtn) setLoading(refreshBtn, false);
  }
}

function filterAndRenderR2Documents() {
  let docs = [...r2DocumentsCache];

  // 1. Direction Filter
  if (activeR2Direction && activeR2Direction !== 'all') {
    docs = docs.filter(d => (d.direction || '').toLowerCase() === activeR2Direction.toLowerCase());
  }

  // 2. Email Address Filter
  if (activeR2EmailFilter) {
    const ef = activeR2EmailFilter.trim().toLowerCase();
    docs = docs.filter(d => (d.associated_email || '').toLowerCase().includes(ef));
  }

  // 3. Search input (filename or subject)
  if (activeR2Search) {
    const q = activeR2Search.trim().toLowerCase();
    docs = docs.filter(d => 
      (d.filename || '').toLowerCase().includes(q) ||
      (d.subject || '').toLowerCase().includes(q) ||
      (d.associated_email || '').toLowerCase().includes(q)
    );
  }

  renderR2Documents(docs, handleDeleteR2Document, handlePreviewR2Document);
}

async function handleDeleteR2Document(key, cardEl) {
  if (!confirm('Are you sure you want to permanently delete this file from Cloudflare R2?')) {
    return;
  }
  try {
    idToken = await currentUser.getIdToken();
    await deleteR2Document(idToken, key);
    showToast('File deleted from Cloudflare R2.', 'success');
    r2DocumentsCache = r2DocumentsCache.filter(d => d.key !== key);
    filterAndRenderR2Documents();

    // Update counts
    const statTotalEl = document.getElementById('stat-r2-total');
    const statIncEl = document.getElementById('stat-r2-incoming');
    const statOutEl = document.getElementById('stat-r2-outgoing');
    if (statTotalEl) statTotalEl.textContent = r2DocumentsCache.length;
    if (statIncEl) statIncEl.textContent = r2DocumentsCache.filter(d => d.direction === 'incoming').length;
    if (statOutEl) statOutEl.textContent = r2DocumentsCache.filter(d => d.direction === 'outgoing').length;
  } catch (err) {
    showToast(`Failed to delete document: ${err.message}`, 'error');
  }
}

async function handleSyncR2Inbox() {
  if (!oauthToken) {
    showToast('Please sign in with Google to sync inbox attachments.', 'warning');
    return;
  }
  const syncBtn = document.getElementById('sync-r2-inbox-btn');
  if (syncBtn) setLoading(syncBtn, true, 'Syncing…');
  try {
    idToken = await currentUser.getIdToken();
    const res = await syncR2InboxAttachments(oauthToken, idToken, 30);
    showToast(`Successfully archived ${res.synced || 0} inbox attachments to Cloudflare R2!`, 'success');
    await loadR2Documents();
  } catch (err) {
    showToast(`Failed to sync attachments: ${err.message}`, 'error');
  } finally {
    if (syncBtn) setLoading(syncBtn, false);
  }
}

// R2 Documents Event Listeners
const refreshR2DocsBtn = document.getElementById('refresh-r2-docs-btn');
const syncR2InboxBtn = document.getElementById('sync-r2-inbox-btn');
const r2EmailFilterInput = document.getElementById('r2-email-filter-input');
const r2SearchInput = document.getElementById('r2-search-input');
const btnGotoDocuments = document.getElementById('btn-goto-documents');

if (refreshR2DocsBtn) refreshR2DocsBtn.addEventListener('click', loadR2Documents);
if (syncR2InboxBtn) syncR2InboxBtn.addEventListener('click', handleSyncR2Inbox);

if (r2EmailFilterInput) {
  r2EmailFilterInput.addEventListener('input', (e) => {
    activeR2EmailFilter = e.target.value;
    filterAndRenderR2Documents();
  });
}

if (r2SearchInput) {
  r2SearchInput.addEventListener('input', (e) => {
    activeR2Search = e.target.value;
    filterAndRenderR2Documents();
  });
}

document.querySelectorAll('.r2-dir-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.r2-dir-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeR2Direction = btn.dataset.dir || 'all';
    filterAndRenderR2Documents();
  });
});

if (btnGotoDocuments) {
  btnGotoDocuments.addEventListener('click', () => {
    const docTabBtn = document.querySelector('.tab-btn[data-tab="documents"]');
    if (docTabBtn) {
      docTabBtn.click();
    } else {
      document.querySelectorAll('.tabs .tab-btn').forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      document.getElementById('tab-documents')?.classList.add('active');
      loadR2Documents();
    }
  });
}




