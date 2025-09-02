(function () {
    "use strict";

    // --- Configuration & State ---
    const API_BASE_URL = "https://savetext-0pk6.onrender.com";
    const state = {
        token: localStorage.getItem("token"),
        currentView: "",
        editingFilename: null,
        notesCache: [],
        selectedNotes: new Set(),
        messageTimeout: null,
        userEmail: null,
        driveLinked: false,
        pinnedNotes: new Set(JSON.parse(localStorage.getItem("pinnedNotes") || "[]"))
    };

    // --- DOM Element Selection ---
    const UI = {
        views: {
            login: document.getElementById("loginSection"),
            register: document.getElementById("registerSection"),
            main: document.getElementById("mainSection"),
            history: document.getElementById("historySection"),
            viewNoteModal: document.getElementById("viewNoteModal"),
        },
        forms: {
            login: document.getElementById("loginForm"),
            register: document.getElementById("registerForm"),
            note: document.getElementById("noteForm"),
        },
        inputs: {
            loginEmail: document.getElementById("loginEmail"),
            loginPassword: document.getElementById("loginPassword"),
            registerEmail: document.getElementById("registerEmail"),
            registerPassword: document.getElementById("registerPassword"),
            noteTitle: document.getElementById("noteTitle"),
            textInput: document.getElementById("textInput"),
            searchNotes: document.getElementById("searchNotes"),
            selectAllNotes: document.getElementById("selectAllNotes"),
        },
        displays: {
            mainStatus: document.getElementById("status"),
            loginStatus: document.getElementById("loginMsg"),
            registerStatus: document.getElementById("registerMsg"),
            historyStatus: document.getElementById("historyStatus"),
            historyList: document.getElementById("historyList"),
            userEmail: document.getElementById("userEmail"),
            bulkActions: document.getElementById("bulkActions"),
            viewNoteTitle: document.getElementById("viewNoteTitle"),
            viewNoteContent: document.getElementById("viewNoteContent")
        },
        buttons: {
            save: document.getElementById("saveBtn"),
            history: document.getElementById("historyBtn"),
            logout: document.getElementById("logoutBtn"),
            goToRegister: document.getElementById("goToRegister"),
            goToLogin: document.getElementById("goToLogin"),
            backToMain: document.getElementById("backToMain"),
            cancelEdit: document.getElementById("cancelEditBtn"),
            selectAllNotes: document.getElementById("selectAllNotes"),
            deleteSelected: document.getElementById("deleteSelectedBtn"),
            connectDrive: document.getElementById("connectDriveBtn"),
            closeViewModal: document.getElementById("closeViewModal"),
            copyFromView: document.getElementById("copyFromView"),
            downloadFromView: document.getElementById("downloadFromView")
        }
    };

    // --- API Communication ---
    async function apiRequest(endpoint, method = "GET", body = null) {
        const headers = { "Content-Type": "application/json" };
        if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
        const res = await fetch(API_BASE_URL + endpoint, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        if (!res.ok) throw new Error(await res.text());
        return await res.json();
    }

    // --- Authentication ---
    async function handleAuth(e, endpoint, statusEl, emailInput, passwordInput) {
        e.preventDefault();
        statusEl.textContent = "";
        try {
            const payload = { email: emailInput.value.trim(), password: passwordInput.value.trim() };
            const data = await apiRequest(endpoint, "POST", payload);
            if (endpoint === "/login") {
                localStorage.setItem("token", data.token);
                state.token = data.token;
                showView("main");
                loadUserProfile();
            } else {
                statusEl.textContent = "Registered successfully. Please login.";
                showView("login");
            }
        } catch (error) {
            statusEl.textContent = error.message;
        }
    }

    function logout() {
        localStorage.removeItem("token");
        state.token = null;
        state.userEmail = null;
        showView("login");
        UI.buttons.logout.style.display = "none";
        UI.displays.userEmail.textContent = "";
    }

    // --- UI & View Management ---
    function showView(viewName) {
        Object.values(UI.views).forEach(v => v.style.display = "none");
        UI.views[viewName].style.display = viewName === "viewNoteModal" ? "flex" : "block";
        state.currentView = viewName;

        // Show/hide header actions based on auth
        if (viewName === "main" || viewName === "history" || viewName === "viewNoteModal") {
            UI.buttons.logout.style.display = "inline-block";
            if (state.userEmail) UI.displays.userEmail.textContent = state.userEmail;
        } else {
            UI.buttons.logout.style.display = "none";
            UI.displays.userEmail.textContent = "";
        }
    }

    function showLoader(show) {
        document.body.classList.toggle("loading", !!show);
    }

    function showMessage(element, message, type = "info", duration = 4000) {
        element.textContent = message;
        element.className = `message ${type}`;
        if (duration > 0) {
            clearTimeout(state.messageTimeout);
            state.messageTimeout = setTimeout(() => {
                element.textContent = "";
                element.className = "message";
            }, duration);
        }
    }

    function escapeHTML(str) {
        return str.replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[m]);
    }

    function checkOAuthRedirectFlags() {}

    // --- Note Management ---
    async function handleSaveNote(e) {
        e.preventDefault();
        const content = UI.inputs.textInput.value.trim();
        const title = UI.inputs.noteTitle.value.trim();
        if (!title) {
            showMessage(UI.displays.mainStatus, "Title is required to save the note.", "error");
            return;
        }

        showLoader(true);
        try {
            const payload = { title, content, filename: state.editingFilename };
            const data = await apiRequest("/save", "POST", payload);
            showMessage(UI.displays.mainStatus, data.message, "success");
            resetEditor();
        } catch (error) {
            showMessage(UI.displays.mainStatus, error.message, "error");
        } finally {
            showLoader(false);
        }
    }

    async function fetchHistory() {
        showLoader(true);
        UI.displays.historyStatus.style.display = "none";
        try {
            const data = await apiRequest("/history");
            state.notesCache = data || [];
            renderHistory(UI.inputs.searchNotes.value);
        } catch (error) {
            showMessage(UI.displays.historyStatus, error.message, "error");
        } finally {
            showLoader(false);
        }
    }

    async function handleDeleteNote(filenames) {
        const confirmed = await customConfirm(`Are you sure you want to delete ${filenames.length} note(s)? This action cannot be undone.`);
        if (!confirmed) return;

        showLoader(true);
        try {
            await apiRequest("/delete", "POST", { filenames });
            await fetchHistory();
            state.selectedNotes.clear();
            updateBulkActionUI();
            showMessage(UI.displays.historyStatus, `Successfully deleted ${filenames.length} note(s).`, "success");
        } catch (error) {
            showMessage(UI.displays.historyStatus, error.message, "error");
        } finally {
            showLoader(false);
        }
    }

    function renderHistory(searchTerm = "") {
        const list = UI.displays.historyList;
        const lowerCaseSearchTerm = searchTerm.toLowerCase();
        const notesToRender = state.notesCache.filter(note =>
            (note.title && note.title.toLowerCase().includes(lowerCaseSearchTerm)) ||
            (note.filecontent && note.filecontent.toLowerCase().includes(lowerCaseSearchTerm))
        );

        notesToRender.sort((a, b) => {
            const aIsPinned = state.pinnedNotes.has(a.filename);
            const bIsPinned = state.pinnedNotes.has(b.filename);
            if (aIsPinned && !bIsPinned) return -1;
            if (!aIsPinned && bIsPinned) return 1;
            return new Date(b.updated_at) - new Date(a.updated_at);
        });

        if (notesToRender.length === 0) {
            list.innerHTML = `<p class="message">No notes found.</p>`;
            return;
        }

        list.innerHTML = notesToRender.map(note => {
            const isSelected = state.selectedNotes.has(note.filename);
            const isPinned = state.pinnedNotes.has(note.filename);
            const driveIcon = note.drive_file_id ? `<span class="drive-icon" title="Synced with Google Drive">☁️</span>` : '';
            const pinIcon = isPinned ? '📌' : '📍';
            const pinClass = isPinned ? 'pinned' : '';

            return `
            <div class="history-item ${isSelected ? 'selected' : ''} ${pinClass}" data-filename="${escapeHTML(note.filename)}" tabindex="0" aria-label="${escapeHTML(note.title)}">
                <div class="note-info">
                    <input type="checkbox" class="note-select" data-filename="${escapeHTML(note.filename)}" ${isSelected ? 'checked' : ''} aria-label="Select note">
                    <div class="note-text-content">
                        <h3 class="note-title">${escapeHTML(note.title)}</h3>
                        <div class="note-meta">
                            ${driveIcon}
                            <span class="note-date">${new Date(note.updated_at).toLocaleString()}</span>
                        </div>
                    </div>
                </div>
                <div class="note-actions">
                    <button class="btn-icon view-btn" data-filename="${escapeHTML(note.filename)}" title="View Note" aria-label="View Note">👁️</button>
                    <button class="btn-icon delete-btn" data-filename="${escapeHTML(note.filename)}" title="Delete Note" aria-label="Delete Note">🗑️</button>
                    <button class="btn-icon pin-btn ${pinClass}" data-filename="${escapeHTML(note.filename)}" title="${isPinned ? 'Unpin Note' : 'Pin Note'}" aria-label="${isPinned ? 'Unpin Note' : 'Pin Note'}">${pinIcon}</button>
                </div>
            </div>`;
        }).join('');
        updateBulkActionUI();
    }

    function handleHistoryListClick(e) {
        const target = e.target;
        const item = target.closest('.history-item');
        if (!item) return;

        const filename = item.dataset.filename;

        if (target.classList.contains('note-select')) {
            toggleNoteSelection(filename);
        } else if (target.classList.contains('view-btn')) {
            handleViewNote(filename);
        } else if (target.classList.contains('delete-btn')) {
            handleDeleteNote([filename]);
        } else if (target.classList.contains('pin-btn')) {
            handlePinNote(filename);
        } else {
            const note = state.notesCache.find(n => n.filename === filename);
            if (note) editNote(note);
        }
    }

    function handleViewNote(filename) {
        const note = state.notesCache.find(n => n.filename === filename);
        if (!note) return;
        UI.displays.viewNoteTitle.textContent = note.title;
        UI.displays.viewNoteContent.textContent = note.filecontent;
        UI.views.viewNoteModal.style.display = 'flex';
        UI.buttons.copyFromView.dataset.content = note.filecontent;
        UI.buttons.downloadFromView.dataset.content = note.filecontent;
        UI.buttons.downloadFromView.dataset.title = note.title || "note";
        UI.views.viewNoteModal.setAttribute("aria-modal", "true");
        UI.views.viewNoteModal.setAttribute("tabindex", "-1");
        UI.buttons.closeViewModal.focus();
    }

    function handleCopyNote(button, filename) {
        const note = state.notesCache.find(n => n.filename === filename);
        if (!note || !note.filecontent) return;

        navigator.clipboard.writeText(note.filecontent).then(() => {
            const originalText = button.innerHTML;
            button.innerHTML = '✅';
            setTimeout(() => { button.innerHTML = "📋"; }, 1500);
        }).catch(err => {
            console.error("Failed to copy text: ", err);
            showMessage(UI.displays.historyStatus, 'Failed to copy text.', 'error');
        });
    }

    function handlePinNote(filename) {
        if (state.pinnedNotes.has(filename)) {
            state.pinnedNotes.delete(filename);
        } else {
            state.pinnedNotes.add(filename);
        }
        localStorage.setItem("pinnedNotes", JSON.stringify([...state.pinnedNotes]));
        renderHistory(UI.inputs.searchNotes.value);
    }

    function editNote(note) {
        state.editingFilename = note.filename;
        UI.inputs.noteTitle.value = note.title;
        UI.inputs.textInput.value = note.filecontent;
        UI.buttons.save.textContent = "Update Note";
        UI.buttons.cancelEdit.style.display = "inline-block";
        showView("main");
    }

    function resetEditor() {
        state.editingFilename = null;
        UI.forms.note.reset();
        UI.buttons.save.textContent = "Save Note";
        UI.buttons.cancelEdit.style.display = "none";
        showMessage(UI.displays.mainStatus, "", "info", 0);
    }

    // --- Bulk Actions & Selection ---
    function toggleNoteSelection(filename) {
        const checkbox = document.querySelector(`.note-select[data-filename="${escapeHTML(filename)}"]`);
        if (!checkbox) return;
        const item = checkbox.closest('.history-item');
        if (state.selectedNotes.has(filename)) {
            state.selectedNotes.delete(filename);
            item.classList.remove('selected');
        } else {
            state.selectedNotes.add(filename);
            item.classList.add('selected');
        }
        updateBulkActionUI();
    }

    function toggleSelectAll(e) {
        const checked = e.target.checked;
        const checkboxes = document.querySelectorAll('.note-select');
        checkboxes.forEach(cb => {
            const filename = cb.dataset.filename;
            if (checked) {
                state.selectedNotes.add(filename);
                cb.closest('.history-item').classList.add('selected');
                cb.checked = true;
            } else {
                state.selectedNotes.delete(filename);
                cb.closest('.history-item').classList.remove('selected');
                cb.checked = false;
            }
        });
        updateBulkActionUI();
    }

    function updateBulkActionUI() {
        const count = state.selectedNotes.size;
        UI.buttons.deleteSelected.style.display = count > 0 ? "inline-block" : "none";
    }

    // --- Google Drive Integration ---
    async function startDriveConnect() {}

    async function loadUserProfile() {
        // Fill in user info if available, or you can call an API to get user profile
        // Example: UI.displays.userEmail.textContent = "user@example.com";
        // For demo, show token existence
        if (state.token) {
            UI.displays.userEmail.textContent = "Logged in";
        }
    }

    // --- Confirmation Modal ---
    function customConfirm(msg) {
        return new Promise((resolve) => {
            const modal = document.getElementById('customConfirm');
            document.getElementById('confirmMsg').textContent = msg;
            modal.style.display = 'flex';
            modal.setAttribute("aria-modal", "true");
            modal.setAttribute("tabindex", "-1");
            document.getElementById('confirmYes').focus();

            const yesBtn = document.getElementById('confirmYes');
            const noBtn = document.getElementById('confirmNo');

            const cleanup = (result) => {
                modal.style.display = 'none';
                yesBtn.removeEventListener('click', yesHandler);
                noBtn.removeEventListener('click', noHandler);
                resolve(result);
            };

            const yesHandler = () => cleanup(true);
            const noHandler = () => cleanup(false);

            yesBtn.addEventListener('click', yesHandler, { once: true });
            noBtn.addEventListener('click', noHandler, { once: true });
        });
    }

    // --- Initialization ---
    function setupEventListeners() {
        UI.forms.login.addEventListener("submit", (e) => handleAuth(e, "/login", UI.displays.loginStatus, UI.inputs.loginEmail, UI.inputs.loginPassword));
        UI.forms.register.addEventListener("submit", (e) => handleAuth(e, "/register", UI.displays.registerStatus, UI.inputs.registerEmail, UI.inputs.registerPassword));
        UI.forms.note.addEventListener("submit", handleSaveNote);
        UI.buttons.goToRegister.addEventListener("click", (e) => { e.preventDefault(); showView("register"); });
        UI.buttons.goToLogin.addEventListener("click", (e) => { e.preventDefault(); showView("login"); });
        UI.buttons.history.addEventListener("click", () => { fetchHistory(); showView("history"); });
        UI.buttons.backToMain.addEventListener("click", () => showView("main"));
        UI.buttons.logout.addEventListener("click", logout);
        UI.buttons.cancelEdit.addEventListener("click", resetEditor);
        UI.displays.historyList.addEventListener("click", handleHistoryListClick);

        UI.inputs.searchNotes.addEventListener("input", (e) => renderHistory(e.target.value));
        UI.inputs.selectAllNotes.addEventListener("change", toggleSelectAll);
        UI.buttons.deleteSelected.addEventListener("click", () => handleDeleteNote([...state.selectedNotes]));
        UI.buttons.connectDrive.addEventListener("click", (e) => { e.preventDefault(); startDriveConnect(); });

        // Modal listeners
        UI.buttons.closeViewModal.addEventListener('click', () => {
            UI.views.viewNoteModal.style.display = 'none';
        });

        UI.views.viewNoteModal.addEventListener('click', (e) => {
            if (e.target === UI.views.viewNoteModal) {
                UI.views.viewNoteModal.style.display = 'none';
            }
        });

        UI.buttons.copyFromView.addEventListener('click', (e) => {
            const content = e.target.dataset.content;
            if (content === undefined || content === null) return;
            navigator.clipboard.writeText(content).then(() => {
                const originalText = e.target.textContent;
                e.target.textContent = 'Copied!';
                setTimeout(() => { e.target.textContent = originalText; }, 1500);
            }).catch(err => console.error("Failed to copy from modal: ", err));
        });

        // Download button for modal
        UI.buttons.downloadFromView.addEventListener('click', (e) => {
            const content = e.target.dataset.content;
            const title = e.target.dataset.title || "note";
            if (content === undefined || content === null) return;
            const element = document.createElement('a');
            const file = new Blob([content], { type: 'text/plain' });
            element.href = URL.createObjectURL(file);
            element.download = title + ".txt";
            document.body.appendChild(element);
            element.click();
            document.body.removeChild(element);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === "Escape") {
                if (UI.views.viewNoteModal.style.display === 'flex') {
                    UI.views.viewNoteModal.style.display = 'none';
                }
                if (document.getElementById('customConfirm').style.display === 'flex') {
                    document.getElementById('customConfirm').style.display = 'none';
                }
            }
        });
    }

    async function initializeApp() {
        if (state.token) {
            loadUserProfile();
            showView("main");
        } else {
            showView("login");
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        setupEventListeners();
        initializeApp();
    });
})();
