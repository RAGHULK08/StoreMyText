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
            customConfirm: document.getElementById('customConfirm'),
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
            textContent: document.getElementById("textContent"),
            historySearch: document.getElementById("historySearch"),
        },
        buttons: {
            showRegister: document.getElementById("showRegister"),
            showLogin: document.getElementById("showLogin"),
            logout: document.getElementById("logoutBtn"),
            viewHistory: document.getElementById("viewHistory"),
            backToMain: document.getElementById("backToMain"),
            clear: document.getElementById("clearBtn"),
            refreshHistory: document.getElementById("refreshHistory"),
            deleteSelected: document.getElementById("deleteSelectedBtn"),
            connectDrive: document.getElementById("connectDriveBtn"),
            closeViewModal: document.getElementById('closeViewModal'),
            copyFromView: document.getElementById('copyFromView'),
            openInDriveFromView: document.getElementById('openInDriveFromView'),
            deleteFromView: document.getElementById('deleteFromView'),
            confirmYes: document.getElementById('confirmYes'),
            confirmNo: document.getElementById('confirmNo'),
        },
        container: {
            historyList: document.getElementById("historyList"),
            loader: document.getElementById("loader"),
        },
        text: {
            loginStatus: document.getElementById("loginStatus"),
            registerStatus: document.getElementById("registerStatus"),
            mainStatus: document.getElementById("mainStatus"),
            historyStatus: document.getElementById("historyStatus"),
            userEmail: document.getElementById("userEmail"),
            confirmMsg: document.getElementById('confirmMsg'),
            viewNoteTitle: document.getElementById('viewNoteTitle'),
            viewNoteContent: document.getElementById('viewNoteContent'),
        }
    };

    // --- API Communication ---
    async function apiRequest(endpoint, method = "GET", body = null) {
        const headers = { "Content-Type": "application/json" };
        if (state.token) {
            headers["Authorization"] = `Bearer ${state.token}`;
        }
        const options = { method, headers };
        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: "An unknown error occurred" }));
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }
            if (response.status === 204) return null;
            return await response.json();
        } catch (error) {
            console.error("API Request Error:", error);
            throw error;
        }
    }

    // --- UI & View Management ---
    function showView(viewName) {
        Object.values(UI.views).forEach(view => view.style.display = 'none');
        if (UI.views[viewName]) {
            UI.views[viewName].style.display = 'block';
            state.currentView = viewName;
            if (viewName === 'history') {
                loadHistory();
            }
        }
    }

    function showLoader(show) {
        UI.container.loader.style.display = show ? 'flex' : 'none';
    }

    function showMessage(element, message, isError = false, duration = 3000) {
        element.textContent = message;
        element.className = `message ${isError ? 'error' : 'success'}`;
        if (state.messageTimeout) clearTimeout(state.messageTimeout);
        if (duration > 0) {
           state.messageTimeout = setTimeout(() => element.textContent = '', duration);
        }
    }

    function showCustomConfirm(message, onConfirm) {
        UI.text.confirmMsg.textContent = message;
        UI.views.customConfirm.style.display = 'flex';

        const confirmHandler = () => {
            UI.views.customConfirm.style.display = 'none';
            onConfirm();
            UI.buttons.confirmYes.removeEventListener('click', confirmHandler);
            UI.buttons.confirmNo.removeEventListener('click', cancelHandler);
        };
        const cancelHandler = () => {
            UI.views.customConfirm.style.display = 'none';
            UI.buttons.confirmYes.removeEventListener('click', confirmHandler);
            UI.buttons.confirmNo.removeEventListener('click', cancelHandler);
        };

        UI.buttons.confirmYes.addEventListener('click', confirmHandler, { once: true });
        UI.buttons.confirmNo.addEventListener('click', cancelHandler, { once: true });
    }

    // --- Authentication ---
    async function handleLogin(e) {
        e.preventDefault();
        showLoader(true);
        try {
            const email = UI.inputs.loginEmail.value;
            const password = UI.inputs.loginPassword.value;
            const data = await apiRequest("/login", "POST", { email, password });
            state.token = data.token;
            localStorage.setItem("token", state.token);
            await initializeApp();
        } catch (error) {
            showMessage(UI.text.loginStatus, error.message, true);
        } finally {
            showLoader(false);
        }
    }

    async function handleRegister(e) {
        e.preventDefault();
        showLoader(true);
        try {
            const email = UI.inputs.registerEmail.value;
            const password = UI.inputs.registerPassword.value;
            const data = await apiRequest("/register", "POST", { email, password });
            showMessage(UI.text.registerStatus, data.message, false);
            UI.forms.register.reset();
            setTimeout(() => showView('login'), 1500);
        } catch (error) {
            showMessage(UI.text.registerStatus, error.message, true);
        } finally {
            showLoader(false);
        }
    }

    function handleLogout() {
        localStorage.removeItem("token");
        localStorage.removeItem("pinnedNotes");
        state.token = null;
        state.userEmail = null;
        state.pinnedNotes.clear();
        UI.text.userEmail.textContent = "";
        UI.buttons.logout.style.display = "none";
        UI.buttons.connectDrive.style.display = "none";
        showView("login");
    }
    
    // --- Note Management ---
    async function handleSaveNote(e) {
        e.preventDefault();
        const content = UI.inputs.textContent.value.trim();
        if (!content) {
            showMessage(UI.text.mainStatus, "Content cannot be empty.", true);
            return;
        }
        showLoader(true);
        const title = UI.inputs.noteTitle.value.trim();
        const endpoint = state.editingFilename ? `/save/${state.editingFilename}` : "/save";
        try {
            const data = await apiRequest(endpoint, "POST", { content, title });
            showMessage(UI.text.mainStatus, data.message, false);
            UI.forms.note.reset();
            state.editingFilename = null;
        } catch (error) {
            showMessage(UI.text.mainStatus, error.message, true);
        } finally {
            showLoader(false);
        }
    }

    async function loadHistory() {
        showLoader(true);
        try {
            const data = await apiRequest("/history");
            state.notesCache = data.notes;
            renderHistory();
        } catch (error) {
            showMessage(UI.text.historyStatus, "Failed to load history.", true);
        } finally {
            showLoader(false);
        }
    }

    async function deleteNotes(filenames) {
        showLoader(true);
        try {
            const data = await apiRequest("/delete", "POST", { filenames });
            showMessage(UI.text.historyStatus, data.message, false);
            state.selectedNotes.clear();
            loadHistory();
        } catch (error) {
            showMessage(UI.text.historyStatus, error.message, true);
        } finally {
            showLoader(false);
        }
    }
    
    // --- History View Rendering & Events ---
    function renderHistory() {
        const searchTerm = UI.inputs.historySearch.value.toLowerCase();
        const filteredNotes = state.notesCache.filter(note =>
            (note.title && note.title.toLowerCase().includes(searchTerm)) ||
            note.content.toLowerCase().includes(searchTerm) ||
            note.filename.toLowerCase().includes(searchTerm)
        );

        // Sort notes: pinned first, then by date descending
        filteredNotes.sort((a, b) => {
            const aIsPinned = state.pinnedNotes.has(a.filename);
            const bIsPinned = state.pinnedNotes.has(b.filename);
            if (aIsPinned && !bIsPinned) return -1;
            if (!aIsPinned && bIsPinned) return 1;
            return new Date(b.timestamp) - new Date(a.timestamp);
        });

        UI.container.historyList.innerHTML = '';
        if (filteredNotes.length === 0) {
            UI.container.historyList.innerHTML = '<p>No notes found.</p>';
            return;
        }

        filteredNotes.forEach(note => {
            const item = createHistoryItem(note);
            UI.container.historyList.appendChild(item);
        });
        updateDeleteSelectedButton();
    }
    
    function createHistoryItem(note) {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.dataset.filename = note.filename;
        if (state.selectedNotes.has(note.filename)) {
            item.classList.add('selected');
        }

        const isPinned = state.pinnedNotes.has(note.filename);

        item.innerHTML = `
            <input type="checkbox" class="history-item-checkbox" ${state.selectedNotes.has(note.filename) ? 'checked' : ''}>
            <div class="history-item-content">
                <div class="history-item-title">${note.title || note.filename}</div>
                <div class="history-item-meta">${new Date(note.timestamp).toLocaleString()}</div>
            </div>
            <div class="history-item-actions">
                <button class="btn-icon btn-pin-note ${isPinned ? 'pinned' : ''}" title="${isPinned ? 'Unpin' : 'Pin'} note">&#x1f4cc;</button>
                <button class="btn-small btn-view-note">View</button>
                ${note.drive_file_id ? `<a href="https://docs.google.com/document/d/${note.drive_file_id}" target="_blank" class="btn-small btn-secondary">Open in Drive</a>` : ''}
                <button class="btn-small btn-danger btn-delete-note">Delete</button>
            </div>
        `;
        return item;
    }

    function handleHistoryListClick(e) {
        const target = e.target;
        const item = target.closest('.history-item');
        if (!item) return;

        const filename = item.dataset.filename;
        const note = state.notesCache.find(n => n.filename === filename);
        if (!note) return;
        
        if (target.type === 'checkbox') {
            toggleNoteSelection(filename);
        } else if (target.classList.contains('btn-pin-note')) {
            togglePinNote(filename, target);
        } else if (target.classList.contains('btn-view-note')) {
            handleViewClick(note);
        } else if (target.classList.contains('btn-delete-note')) {
            showCustomConfirm(`Are you sure you want to delete "${note.title || filename}"? This may also remove it from Google Drive.`, () => {
                deleteNotes([filename]);
            });
        }
    }
    
    function handleViewClick(note) {
        UI.text.viewNoteTitle.textContent = note.title || 'View Note';
        UI.text.viewNoteContent.textContent = note.content;
        UI.buttons.copyFromView.dataset.content = note.content;
        UI.buttons.deleteFromView.dataset.filename = note.filename;

        if (note.drive_file_id) {
            UI.buttons.openInDriveFromView.style.display = 'inline-block';
            UI.buttons.openInDriveFromView.dataset.driveId = note.drive_file_id;
        } else {
            UI.buttons.openInDriveFromView.style.display = 'none';
        }
        UI.views.viewNoteModal.style.display = 'flex';
    }


    function toggleNoteSelection(filename) {
        const item = UI.container.historyList.querySelector(`[data-filename="${filename}"]`);
        if (state.selectedNotes.has(filename)) {
            state.selectedNotes.delete(filename);
            item.classList.remove('selected');
        } else {
            state.selectedNotes.add(filename);
            item.classList.add('selected');
        }
        updateDeleteSelectedButton();
    }

    function updateDeleteSelectedButton() {
        UI.buttons.deleteSelected.style.display = state.selectedNotes.size > 0 ? 'inline-block' : 'none';
    }

    function togglePinNote(filename, button) {
        if (state.pinnedNotes.has(filename)) {
            state.pinnedNotes.delete(filename);
            button.classList.remove('pinned');
            button.title = 'Pin note';
        } else {
            state.pinnedNotes.add(filename);
            button.classList.add('pinned');
            button.title = 'Unpin note';
        }
        localStorage.setItem("pinnedNotes", JSON.stringify(Array.from(state.pinnedNotes)));
        renderHistory();
    }
    
    // --- Google Drive Integration ---
    async function loadUserProfile() {
        try {
            const profile = await apiRequest("/profile");
            state.userEmail = profile.email;
            state.driveLinked = profile.drive_linked;
            UI.text.userEmail.textContent = state.userEmail;
            UI.buttons.connectDrive.textContent = state.driveLinked ? "Drive Connected" : "Connect Drive";
            UI.buttons.connectDrive.disabled = state.driveLinked;
            UI.buttons.connectDrive.style.display = "inline-block";
        } catch (error) {
            console.error("Failed to load profile:", error);
            handleLogout();
        }
    }

    async function startDriveConnect() {
        try {
            const data = await apiRequest("/connect_drive");
            if (data.auth_url) {
                window.location.href = data.auth_url;
            }
        } catch (error) {
            showMessage(UI.text.mainStatus, "Failed to start Drive connection.", true);
        }
    }

    function checkOAuthRedirectFlags() {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('oauth_success')) {
            showMessage(UI.text.mainStatus, "Google Drive connected successfully!", false);
            history.replaceState(null, '', window.location.pathname);
        } else if (urlParams.has('oauth_error')) {
            const errorMsg = urlParams.get('oauth_error') || "Unknown error during Google Drive connection.";
            showMessage(UI.text.mainStatus, `Drive connection failed: ${errorMsg}`, true);
            history.replaceState(null, '', window.location.pathname);
        }
    }

    // --- Event Listeners Setup ---
    function setupEventListeners() {
        // Form submissions
        UI.forms.login.addEventListener("submit", handleLogin);
        UI.forms.register.addEventListener("submit", handleRegister);
        UI.forms.note.addEventListener("submit", handleSaveNote);

        // View switching
        UI.buttons.showRegister.addEventListener("click", (e) => { e.preventDefault(); showView('register'); });
        UI.buttons.showLogin.addEventListener("click", (e) => { e.preventDefault(); showView('login'); });
        UI.buttons.viewHistory.addEventListener("click", () => showView('history'));
        UI.buttons.backToMain.addEventListener("click", () => showView('main'));
        
        // Actions
        UI.buttons.logout.addEventListener("click", handleLogout);
        UI.buttons.clear.addEventListener("click", () => {
            UI.forms.note.reset();
            state.editingFilename = null;
        });
        UI.buttons.refreshHistory.addEventListener("click", loadHistory);
        UI.buttons.deleteSelected.addEventListener("click", () => {
            if (state.selectedNotes.size === 0) return;
            showCustomConfirm(`Are you sure you want to delete ${state.selectedNotes.size} selected notes?`, () => {
                deleteNotes(Array.from(state.selectedNotes));
            });
        });

        // History list interactions (delegated)
        UI.container.historyList.addEventListener('click', handleHistoryListClick);
        UI.inputs.historySearch.addEventListener('input', renderHistory);
        
        // Drive connection
        UI.buttons.connectDrive.addEventListener("click", (e) => { e.preventDefault(); startDriveConnect(); });

        // Modal listeners
        UI.buttons.closeViewModal.addEventListener('click', () => UI.views.viewNoteModal.style.display = 'none');
        UI.views.viewNoteModal.addEventListener('click', (e) => {
            if (e.target === UI.views.viewNoteModal) UI.views.viewNoteModal.style.display = 'none';
        });

        UI.buttons.copyFromView.addEventListener('click', (e) => {
            navigator.clipboard.writeText(e.target.dataset.content).then(() => {
                const originalText = e.target.textContent;
                e.target.textContent = 'Copied!';
                setTimeout(() => { e.target.textContent = originalText; }, 1500);
            }).catch(err => console.error("Failed to copy from modal: ", err));
        });
        
        UI.buttons.deleteFromView.addEventListener('click', (e) => {
            const filename = e.target.dataset.filename;
            if (!filename) return;
            UI.views.viewNoteModal.style.display = 'none';
            const note = state.notesCache.find(n => n.filename === filename);
            showCustomConfirm(`Are you sure you want to delete "${note.title || filename}"?`, () => {
                deleteNotes([filename]);
            });
        });

        UI.buttons.openInDriveFromView.addEventListener('click', (e) => {
            const driveId = e.target.dataset.driveId;
            if (driveId) {
                window.open(`https://docs.google.com/document/d/${driveId}`, '_blank');
            }
        });

        // Custom confirm no button
        UI.buttons.confirmNo.addEventListener('click', () => {
             UI.views.customConfirm.style.display = 'none';
        });
    }

    // --- App Initialization ---
    async function initializeApp() {
        showLoader(true);
        checkOAuthRedirectFlags();
        if (state.token) {
            UI.buttons.logout.style.display = "inline-block";
            await loadUserProfile();
            showView("main");
        } else {
            showView("login");
        }
        showLoader(false);
    }

    document.addEventListener('DOMContentLoaded', () => {
        setupEventListeners();
        initializeApp();
    });

})();
