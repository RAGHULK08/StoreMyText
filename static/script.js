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
    };

    // --- DOM Element Selection ---
    const UI = {
        views: {
            login: document.getElementById("loginSection"),
            register: document.getElementById("registerSection"),
            main: document.getElementById("mainSection"),
            history: document.getElementById("historySection"),
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
        buttons: {
            goToRegister: document.getElementById("goToRegister"),
            goToLogin: document.getElementById("goToLogin"),
            save: document.getElementById("saveBtn"),
            cancelEdit: document.getElementById("cancelEditBtn"),
            history: document.getElementById("historyBtn"),
            logout: document.getElementById("logoutBtn"),
            backToMain: document.getElementById("backToMain"),
            deleteSelected: document.getElementById("deleteSelectedBtn"),
        },
        displays: {
            userEmail: document.getElementById("userEmail"),
            historyList: document.getElementById("historyList"),
            loader: document.getElementById("loader"),
        },
        messages: {
            loginStatus: document.getElementById("loginMsg"),
            registerStatus: document.getElementById("registerMsg"),
            mainStatus: document.getElementById("status"),
            historyStatus: document.getElementById("historyStatus"),
        },
        modals: {
            confirm: document.getElementById("customConfirm"),
            confirmMsg: document.getElementById("confirmMsg"),
            confirmYes: document.getElementById("confirmYes"),
            confirmNo: document.getElementById("confirmNo"),
        },
    };

    // --- API Helper ---
    async function apiRequest(endpoint, method = "GET", body = null) {
        const headers = new Headers({ "Content-Type": "application/json" });
        if (state.token) {
            headers.append("Authorization", `Bearer ${state.token}`);
        }

        const config = {
            method,
            headers,
            body: body ? JSON.stringify(body) : null,
        };

        try {
            UI.displays.loader.style.display = "flex";
            const response = await fetch(`${API_BASE_URL}${endpoint}`, config);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `HTTP error! status: ${response.status}`);
            }
            return data;
        } catch (error) {
            console.error(`API request to ${endpoint} failed:`, error);
            throw error; // Re-throw to be caught by the calling function
        } finally {
            UI.displays.loader.style.display = "none";
        }
    }

    // --- UI & View Management ---
    function showView(viewName) {
        Object.values(UI.views).forEach(view => view.style.display = "none");
        if (UI.views[viewName]) {
            UI.views[viewName].style.display = "block";
            state.currentView = viewName;
        }
    }

    function showStatusMessage(element, message, type = "info", duration = 4000) {
        if (!element) return;
        clearTimeout(state.messageTimeout);
        element.textContent = message;
        element.className = `message show ${type}`;
        if (duration) {
            state.messageTimeout = setTimeout(() => {
                element.className = 'message';
            }, duration);
        }
    }

    function customConfirm(message) {
        return new Promise(resolve => {
            UI.modals.confirmMsg.textContent = message;
            UI.modals.confirm.style.display = "flex";
            
            const cleanup = () => {
                UI.modals.confirm.style.display = "none";
                UI.modals.confirmYes.onclick = null;
                UI.modals.confirmNo.onclick = null;
            };

            UI.modals.confirmYes.onclick = () => { cleanup(); resolve(true); };
            UI.modals.confirmNo.onclick = () => { cleanup(); resolve(false); };
        });
    }

    // --- Authentication ---
    function handleLogin(e) {
        e.preventDefault();
        const email = UI.inputs.loginEmail.value;
        const password = UI.inputs.loginPassword.value;
        apiRequest("/login", "POST", { email, password })
            .then(data => {
                state.token = data.token;
                localStorage.setItem("token", state.token);
                UI.displays.userEmail.textContent = email;
                initializeApp();
            })
            .catch(err => showStatusMessage(UI.messages.loginStatus, err.message, "error"));
    }

    function handleRegister(e) {
        e.preventDefault();
        const email = UI.inputs.registerEmail.value;
        const password = UI.inputs.registerPassword.value;
        apiRequest("/register", "POST", { email, password })
            .then(() => {
                showStatusMessage(UI.messages.registerStatus, "Registration successful! Please log in.", "success");
                showView("login");
            })
            .catch(err => showStatusMessage(UI.messages.registerStatus, err.message, "error"));
    }

    function logout() {
        state.token = null;
        localStorage.removeItem("token");
        UI.buttons.logout.style.display = "none";
        UI.displays.userEmail.textContent = "";
        showView("login");
    }
    
    // --- Note Management ---
    function handleSaveNote(e) {
        e.preventDefault();
        const title = UI.inputs.noteTitle.value.trim();
        if (!title) {
            showStatusMessage(UI.messages.mainStatus, "Title is required.", "error");
            return;
        }
        const content = UI.inputs.textInput.value;

        apiRequest("/save", "POST", { filename: state.editingFilename, title, content })
            .then(data => {
                showStatusMessage(UI.messages.mainStatus, data.message, "success");
                resetEditor();
            })
            .catch(err => showStatusMessage(UI.messages.mainStatus, err.message, "error"));
    }
    
    function resetEditor() {
        state.editingFilename = null;
        UI.forms.note.reset();
        UI.buttons.cancelEdit.style.display = "none";
        UI.inputs.noteTitle.focus();
    }

    async function fetchHistory() {
        try {
            const notes = await apiRequest("/history");
            state.notesCache = notes;
            renderHistory();
        } catch (err) {
            showStatusMessage(UI.messages.historyStatus, err.message, "error", null);
        }
    }

    function renderHistory(filter = "") {
        const filteredNotes = state.notesCache.filter(note =>
            note.title.toLowerCase().includes(filter) ||
            (note.filecontent || "").toLowerCase().includes(filter)
        );

        if (filteredNotes.length === 0) {
            UI.displays.historyList.innerHTML = `<p>No notes found.</p>`;
            return;
        }

        UI.displays.historyList.innerHTML = filteredNotes.map(note => `
            <div class="history-item" data-filename="${note.filename}">
                <input type="checkbox" class="note-select-checkbox" data-filename="${note.filename}" />
                <div class="history-item-content">
                    <p>${escapeHTML(note.title)}</p>
                    <small>Last updated: ${new Date(note.updated_at).toLocaleString()}</small>
                </div>
                <div class="history-item-actions">
                    <button class="edit-btn" title="Edit Note" data-filename="${note.filename}">✏️</button>
                    <button class="delete-btn" title="Delete Note" data-filename="${note.filename}">🗑️</button>
                </div>
            </div>
        `).join("");
        updateBulkActionUI();
    }

    function escapeHTML(str) {
        return str.replace(/[&<>"']/g, function(match) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[match];
        });
    }

    function handleHistoryListClick(e) {
        const target = e.target;
        const filename = target.closest(".history-item")?.dataset.filename;
        if (!filename) return;

        if (target.classList.contains("delete-btn")) {
            handleDeleteNote([filename]);
        } else if (target.classList.contains("edit-btn")) {
            handleEditNote(filename);
        } else if (target.classList.contains("note-select-checkbox")) {
            toggleNoteSelection(filename, target.checked);
        } else if (target.closest('.history-item-content')) {
            // Optional: view note content on click. For now, we use edit.
            handleEditNote(filename);
        }
    }

    async function handleDeleteNote(filenames) {
        const confirmed = await customConfirm(`Are you sure you want to delete ${filenames.length} note(s)?`);
        if (!confirmed) return;
        
        apiRequest("/delete", "POST", { filenames })
            .then(data => {
                showStatusMessage(UI.messages.historyStatus, data.message, "success");
                state.selectedNotes.clear();
                fetchHistory();
            })
            .catch(err => showStatusMessage(UI.messages.historyStatus, err.message, "error"));
    }

    function handleEditNote(filename) {
        const note = state.notesCache.find(n => n.filename === filename);
        if (note) {
            state.editingFilename = filename;
            UI.inputs.noteTitle.value = note.title;
            UI.inputs.textInput.value = note.filecontent;
            UI.buttons.cancelEdit.style.display = "inline-block";
            showView("main");
        }
    }

    // --- Bulk selection ---
    function toggleNoteSelection(filename, checked) {
        if (checked) {
            state.selectedNotes.add(filename);
        } else {
            state.selectedNotes.delete(filename);
        }
        updateBulkActionUI();
    }

    function toggleSelectAll() {
        const isChecked = UI.inputs.selectAllNotes.checked;
        const visibleCheckboxes = document.querySelectorAll(".note-select-checkbox");
        
        visibleCheckboxes.forEach(cb => {
            cb.checked = isChecked;
            const filename = cb.dataset.filename;
            if (isChecked) {
                state.selectedNotes.add(filename);
            } else {
                state.selectedNotes.delete(filename);
            }
        });
        updateBulkActionUI();
    }

    function updateBulkActionUI() {
        const hasSelection = state.selectedNotes.size > 0;
        UI.buttons.deleteSelected.style.display = hasSelection ? "block" : "none";
        
        const allVisibleCheckboxes = [...document.querySelectorAll(".note-select-checkbox")];
        const allVisibleSelected = allVisibleCheckboxes.length > 0 && allVisibleCheckboxes.every(cb => cb.checked);
        UI.inputs.selectAllNotes.checked = allVisibleSelected;
    }

    // --- Event Listeners & Initialization ---
    function setupEventListeners() {
        // Forms
        UI.forms.login.addEventListener("submit", handleLogin);
        UI.forms.register.addEventListener("submit", handleRegister);
        UI.forms.note.addEventListener("submit", handleSaveNote);

        // View switching buttons
        UI.buttons.goToRegister.addEventListener("click", (e) => { e.preventDefault(); showView("register"); });
        UI.buttons.goToLogin.addEventListener("click", (e) => { e.preventDefault(); showView("login"); });
        UI.buttons.history.addEventListener("click", () => { fetchHistory(); showView("history"); });
        UI.buttons.backToMain.addEventListener("click", () => showView("main"));
        UI.buttons.logout.addEventListener("click", logout);
        UI.buttons.cancelEdit.addEventListener("click", resetEditor);
        
        // History view interactions
        UI.displays.historyList.addEventListener("click", handleHistoryListClick);
        UI.inputs.searchNotes.addEventListener("input", (e) => renderHistory(e.target.value.toLowerCase()));
        
        // Bulk actions
        UI.inputs.selectAllNotes.addEventListener("change", toggleSelectAll);
        UI.buttons.deleteSelected.addEventListener("click", () => handleDeleteNote([...state.selectedNotes]));
    }

    function initializeApp() {
        if (state.token) {
            UI.buttons.logout.style.display = "block";
            // A better approach would be a /me endpoint to get user details
            // For now, we just proceed to the main view.
            showView("main");
        } else {
            showView("login");
        }
    }

    // --- App Start ---
    document.addEventListener("DOMContentLoaded", () => {
        setupEventListeners();
        initializeApp();
    });
})();
