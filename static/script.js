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
        const responseText = await res.text();
        if (!res.ok) {
            throw new Error(responseText || `HTTP error! status: ${res.status}`);
        }
        try {
            return JSON.parse(responseText);
        } catch (e) {
            return responseText;
        }
    }

    // --- Authentication ---
    async function handleAuth(e, endpoint, statusEl, emailInput, passwordInput) {
        e.preventDefault();
        showMessage(statusEl, "", "info", 0); // Clear previous message
        try {
            const payload = { email: emailInput.value.trim(), password: passwordInput.value.trim() };
             if (!payload.email || !payload.password) {
                 showMessage(statusEl, "Email and password cannot be empty.", "error");
                 return;
            }
            const data = await apiRequest(endpoint, "POST", payload);
            if (endpoint === "/login") {
                localStorage.setItem("token", data.token);
                state.token = data.token;
                showView("main");
                loadUserProfile();
            } else {
                showMessage(UI.displays.loginStatus, "Registered successfully. Please login.", "success");
                showView("login");
                UI.forms.register.reset();
            }
        } catch (error) {
            showMessage(statusEl, error.message, "error");
        }
    }

    function logout() {
        localStorage.removeItem("token");
        localStorage.removeItem("pinnedNotes");
        state.token = null;
        state.userEmail = null;
        state.pinnedNotes.clear();
        showView("login");
        UI.buttons.logout.style.display = "none";
        UI.displays.userEmail.textContent = "";
    }

    // --- UI & View Management ---
    function showView(viewName) {
        Object.values(UI.views).forEach(v => {
            if (v) v.style.display = "none";
        });
        if (UI.views[viewName]) {
            UI.views[viewName].style.display = viewName === "viewNoteModal" ? "flex" : "block";
        }
        state.currentView = viewName;

        if (state.token) {
            UI.buttons.logout.style.display = "inline-block";
            if (state.userEmail) UI.displays.userEmail.textContent = state.userEmail;
        } else {
            UI.buttons.logout.style.display = "none";
            UI.displays.userEmail.textContent = "";
        }
    }

    function showLoader(show) {
        const loader = document.getElementById('loader');
        if (loader) {
            loader.style.display = show ? 'flex' : 'none';
        }
    }

    function showMessage(element, message, type = "info", duration = 4000) {
        if (!element) return;
        element.textContent = message;
        element.className = `message ${type} show`;

        clearTimeout(state.messageTimeout);

        if (duration > 0) {
            state.messageTimeout = setTimeout(() => {
                element.classList.remove("show");
                // Clear text after the fade-out transition completes
                setTimeout(() => {
                    if (!element.classList.contains('show')) {
                        element.textContent = "";
                        element.className = "message";
                    }
                }, 500);
            }, duration);
        }
    }

    function escapeHTML(str) {
         if (typeof str !== 'string') return '';
        return str.replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[m]);
    }

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
            showMessage(UI.displays.mainStatus, data.message || "Note saved successfully!", "success");
            resetEditor();
        } catch (error) {
            showMessage(UI.displays.mainStatus, error.message, "error");
        } finally {
            showLoader(false);
        }
    }

    async function fetchHistory() {
        showLoader(true);
        showMessage(UI.displays.historyStatus, "", "info", 0);
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
            // Remove from cache locally before refetching for faster UI update
            state.notesCache = state.notesCache.filter(note => !filenames.includes(note.filename));
            filenames.forEach(name => state.selectedNotes.delete(name));
            renderHistory(UI.inputs.searchNotes.value);
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
        
        UI.displays.bulkActions.style.display = notesToRender.length > 0 ? "flex" : "none";

        if (notesToRender.length === 0) {
            list.innerHTML = `<p class="message info show">No notes found.</p>`;
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
        <div class="note-info" data-action="edit">
            <input type="checkbox" class="note-select" data-filename="${escapeHTML(note.filename)}" ${isSelected ? 'checked' : ''} aria-label="Select note ${escapeHTML(note.title)}">
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
            toggleNoteSelection(filename, target.checked);
        } else if (target.classList.contains('view-btn')) {
            handleViewNote(filename);
        } else if (target.classList.contains('delete-btn')) {
            handleDeleteNote([filename]);
        } else if (target.classList.contains('pin-btn')) {
            handlePinNote(filename);
        } else if (target.closest('[data-action="edit"]')) {
            const note = state.notesCache.find(n => n.filename === filename);
            if (note) editNote(note);
        }
    }

    function handleViewNote(filename) {
        const note = state.notesCache.find(n => n.filename === filename);
        if (!note) return;
        UI.displays.viewNoteTitle.textContent = note.title;
        UI.displays.viewNoteContent.textContent = note.filecontent;
        UI.buttons.copyFromView.dataset.content = note.filecontent;
        UI.buttons.downloadFromView.dataset.content = note.filecontent;
        UI.buttons.downloadFromView.dataset.title = note.title || "note";
        showView('viewNoteModal');
        UI.buttons.closeViewModal.focus();
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
    function toggleNoteSelection(filename, isSelected) {
        const item = document.querySelector(`.history-item[data-filename="${escapeHTML(filename)}"]`);
        if (isSelected) {
            state.selectedNotes.add(filename);
            if (item) item.classList.add('selected');
        } else {
            state.selectedNotes.delete(filename);
            if (item) item.classList.remove('selected');
        }
        updateBulkActionUI();
    }

    function toggleSelectAll(e) {
        const isChecked = e.target.checked;
        const visibleCheckboxes = document.querySelectorAll('#historyList .note-select');
        visibleCheckboxes.forEach(cb => {
            cb.checked = isChecked;
            toggleNoteSelection(cb.dataset.filename, isChecked);
        });
    }

    function updateBulkActionUI() {
        const count = state.selectedNotes.size;
        UI.buttons.deleteSelected.style.display = count > 0 ? "inline-block" : "none";

        const allVisibleNotes = document.querySelectorAll('#historyList .note-select');
        const allVisibleSelected = Array.from(allVisibleNotes).every(cb => state.selectedNotes.has(cb.dataset.filename));
        UI.inputs.selectAllNotes.checked = allVisibleNotes.length > 0 && allVisibleSelected;
    }

    async function loadUserProfile() {
        // In a real app, you might fetch the user profile here.
        // For now, we'll just indicate they are logged in.
        if (state.token) {
            try {
                // A dummy call to check if token is valid.
                // Replace with an actual /profile or /me endpoint.
                await apiRequest('/history'); 
                UI.displays.userEmail.textContent = "Logged In";
            } catch (error) {
                // Token might be expired or invalid
                logout();
            }
        }
    }

    // --- Confirmation Modal ---
    function customConfirm(msg) {
        return new Promise((resolve) => {
            const modal = document.getElementById('customConfirm');
            const msgEl = document.getElementById('confirmMsg');
            const yesBtn = document.getElementById('confirmYes');
            const noBtn = document.getElementById('confirmNo');

            if (!modal || !msgEl || !yesBtn || !noBtn) {
                resolve(window.confirm(msg)); // Fallback
                return;
            }

            msgEl.textContent = msg;
            modal.style.display = 'flex';
            yesBtn.focus();

            const cleanup = (result) => {
                modal.style.display = 'none';
                resolve(result);
            };

            yesBtn.onclick = () => cleanup(true);
            noBtn.onclick = () => cleanup(false);
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
        
        // Modal listeners
        UI.buttons.closeViewModal.addEventListener('click', () => showView('history'));
        UI.views.viewNoteModal.addEventListener('click', (e) => {
            if (e.target === UI.views.viewNoteModal) showView('history');
        });

        UI.buttons.copyFromView.addEventListener('click', (e) => {
            const content = e.currentTarget.dataset.content;
            if (!content) return;
            navigator.clipboard.writeText(content).then(() => {
                const originalText = e.currentTarget.textContent;
                e.currentTarget.textContent = 'Copied!';
                setTimeout(() => { e.currentTarget.textContent = originalText; }, 1500);
            }).catch(err => console.error("Failed to copy from modal: ", err));
        });
        
        UI.buttons.downloadFromView.addEventListener('click', (e) => {
            const { content, title = "note" } = e.currentTarget.dataset;
            if (content === undefined) return;
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${title}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === "Escape") {
                if (state.currentView === 'viewNoteModal') showView('history');
                const confirmModal = document.getElementById('customConfirm');
                if (confirmModal && confirmModal.style.display === 'flex') {
                   confirmModal.style.display = 'none';
                }
            }
        });
    }

    function initializeApp() {
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
