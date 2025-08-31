(function () {
    "use strict";

    // --- Configuration & State ---
    const API_BASE_URL = "https://savetext-0pk6.onrender.com";
"; 
    const state = {
        token: localStorage.getItem("token"),
        currentView: "",
        editingFilename: null,
        notesCache: [],
        selectedNotes: new Set(),
        messageTimeout: null,
        userEmail: null,
        driveLinked: false
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
            connectDrive: document.getElementById("connectDriveBtn")
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
        if (state.token) headers.append("Authorization", `Bearer ${state.token}`);
        const config = { method, headers, body: body ? JSON.stringify(body) : null };
        try {
            UI.displays.loader.style.display = "flex";
            const resp = await fetch(`${API_BASE_URL}${endpoint}`, config);
            const data = await resp.json();
            if (!resp.ok) {
                throw new Error(data.error || `HTTP ${resp.status}`);
            }
            return data;
        } catch (err) {
            console.error("API error", err);
            throw err;
        } finally {
            UI.displays.loader.style.display = "none";
        }
    }

    // --- UI helpers ---
    function showView(viewName) {
        Object.values(UI.views).forEach(v => v.style.display = "none");
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
                element.className = "message";
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

    // --- Auth handlers ---
    async function handleLogin(e) {
        e.preventDefault();
        const email = UI.inputs.loginEmail.value.trim();
        const password = UI.inputs.loginPassword.value;
        try {
            const data = await apiRequest("/login", "POST", { email, password });
            state.token = data.token;
            localStorage.setItem("token", state.token);
            await loadUserProfile();
            initializeApp();
            showStatusMessage(UI.messages.loginStatus, "Logged in", "success");
        } catch (err) {
            showStatusMessage(UI.messages.loginStatus, err.message || "Login failed", "error");
        }
    }

    async function handleRegister(e) {
        e.preventDefault();
        const email = UI.inputs.registerEmail.value.trim();
        const password = UI.inputs.registerPassword.value;
        try {
            const data = await apiRequest("/register", "POST", { email, password });
            // auto-login token returned
            if (data.token) {
                state.token = data.token;
                localStorage.setItem("token", state.token);
                await loadUserProfile();
                initializeApp();
            } else {
                showStatusMessage(UI.messages.registerStatus, "Registered. Please log in.", "success");
                showView("login");
            }
        } catch (err) {
            showStatusMessage(UI.messages.registerStatus, err.message || "Register failed", "error");
        }
    }

    function logout() {
        state.token = null;
        localStorage.removeItem("token");
        state.userEmail = null;
        state.driveLinked = false;
        UI.buttons.connectDrive.style.display = "none";
        UI.buttons.logout.style.display = "none";
        UI.displays.userEmail.textContent = "";
        showView("login");
    }

    async function loadUserProfile() {
        if (!state.token) return;
        try {
            const me = await apiRequest("/me");
            state.userEmail = me.email;
            state.driveLinked = !!me.drive_linked;
            UI.displays.userEmail.textContent = me.email;
            UI.buttons.logout.style.display = "inline-block";
            UI.buttons.connectDrive.style.display = state.driveLinked ? "none" : "inline-block";
        } catch (err) {
            console.warn("Could not load /me", err);
        }
    }

    // --- Drive connect flow ---
    async function startDriveConnect() {
        try {
            const r = await apiRequest("/auth/google/start");
            if (r && r.auth_url) {
                // Navigate browser to the auth url. Google will redirect back to server callback which will
                // redirect to FRONTEND_URL with google_link_success=1 or google_link_error=1.
                // The server requires the Authorization header on the callback to associate creds with the user.
                // Browsers don't send Authorization header on 3rd-party redirect, so we do the redirect via fetch:
                // First open a small POST to callback URL with Authorization so that server has the token in request headers.
                // But since the callback is done by Google we cannot attach header there. Therefore the recommended approach:
                // 1. Open the auth_url in the browser (user consents)
                // 2. After redirect completes, the server will still not have the Authorization header.
                // To ensure linking, after redirect success the frontend should call a small endpoint to fetch fresh /me (server saved creds if it had the user info).
                // Simpler approach: open auth_url in a new tab/window.
                window.location.href = r.auth_url;
            } else {
                showStatusMessage(UI.messages.mainStatus, "Could not start Google auth", "error");
            }
        } catch (err) {
            showStatusMessage(UI.messages.mainStatus, err.message || "Could not start Drive connect", "error");
        }
    }

    // Check URL for google_link_success/google_link_error params (after redirect flow)
    function checkOAuthRedirectFlags() {
        const params = new URLSearchParams(window.location.search);
        if (params.get("google_link_success")) {
            // user probably linked; re-fetch profile
            const current = window.location.href.split("?")[0];
            history.replaceState({}, "", current); // remove query params
            loadUserProfile().then(() => {
                showStatusMessage(UI.messages.mainStatus, "Google Drive linked successfully!", "success");
                UI.buttons.connectDrive.style.display = "none";
            });
        } else if (params.get("google_link_error")) {
            const current = window.location.href.split("?")[0];
            history.replaceState({}, "", current);
            showStatusMessage(UI.messages.mainStatus, "Google Drive linking failed.", "error");
        }
    }

    // --- Notes ---
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
                showStatusMessage(UI.messages.mainStatus, data.message || "Saved", "success");
                resetEditor();
            })
            .catch(err => showStatusMessage(UI.messages.mainStatus, err.message || "Save failed", "error"));
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
            showStatusMessage(UI.messages.historyStatus, err.message || "Failed", "error", null);
        }
    }

    function renderHistory(filter = "") {
        const filtered = state.notesCache.filter(note =>
            note.title.toLowerCase().includes(filter) ||
            (note.filecontent || "").toLowerCase().includes(filter)
        );
        if (!filtered.length) {
            UI.displays.historyList.innerHTML = "<p>No notes found.</p>";
            return;
        }
        UI.displays.historyList.innerHTML = filtered.map(note => `
            <div class="history-item" data-filename="${note.filename}">
                <input type="checkbox" class="note-select-checkbox" data-filename="${note.filename}" />
                <div class="history-item-content">
                    <p>${escapeHTML(note.title)}</p>
                    <small>Last updated: ${new Date(note.updated_at).toLocaleString()}</small>
                    ${note.drive_file_id ? `<div><a target="_blank" rel="noopener noreferrer" href="https://drive.google.com/file/d/${note.drive_file_id}/view">Open in Drive</a></div>` : ""}
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
        return (str || "").replace(/[&<>"']/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
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
        } else if (target.closest(".history-item-content")) {
            handleEditNote(filename);
        }
    }

    async function handleDeleteNote(filenames) {
        const confirmed = await customConfirm(`Delete ${filenames.length} note(s)?`);
        if (!confirmed) return;
        apiRequest("/delete", "POST", { filenames })
            .then(data => {
                showStatusMessage(UI.messages.historyStatus, data.message || "Deleted", "success");
                state.selectedNotes.clear();
                fetchHistory();
            })
            .catch(err => showStatusMessage(UI.messages.historyStatus, err.message || "Delete failed", "error"));
    }

    function handleEditNote(filename) {
        const note = state.notesCache.find(n => n.filename === filename);
        if (!note) return;
        state.editingFilename = filename;
        UI.inputs.noteTitle.value = note.title;
        UI.inputs.textInput.value = note.filecontent || "";
        UI.buttons.cancelEdit.style.display = "inline-block";
        showView("main");
    }

    // bulk select helpers
    function toggleNoteSelection(filename, checked) {
        if (checked) state.selectedNotes.add(filename);
        else state.selectedNotes.delete(filename);
        updateBulkActionUI();
    }
    function toggleSelectAll() {
        const checked = UI.inputs.selectAllNotes.checked;
        const checkboxes = document.querySelectorAll(".note-select-checkbox");
        checkboxes.forEach(cb => { cb.checked = checked; const fn = cb.dataset.filename; if (checked) state.selectedNotes.add(fn); else state.selectedNotes.delete(fn); });
        updateBulkActionUI();
    }
    function updateBulkActionUI() {
        const has = state.selectedNotes.size > 0;
        UI.buttons.deleteSelected.style.display = has ? "block" : "none";
        const allBoxes = [...document.querySelectorAll(".note-select-checkbox")];
        const allSelected = allBoxes.length > 0 && allBoxes.every(cb => cb.checked);
        UI.inputs.selectAllNotes.checked = allSelected;
    }

    // --- Event wiring & init ---
    function setupEventListeners() {
        UI.forms.login.addEventListener("submit", handleLogin);
        UI.forms.register.addEventListener("submit", handleRegister);
        UI.forms.note.addEventListener("submit", handleSaveNote);

        UI.buttons.goToRegister.addEventListener("click", (e) => { e.preventDefault(); showView("register"); });
        UI.buttons.goToLogin.addEventListener("click", (e) => { e.preventDefault(); showView("login"); });
        UI.buttons.history.addEventListener("click", () => { fetchHistory(); showView("history"); });
        UI.buttons.backToMain.addEventListener("click", () => showView("main"));
        UI.buttons.logout.addEventListener("click", logout);
        UI.buttons.cancelEdit.addEventListener("click", resetEditor);

        UI.displays.historyList.addEventListener("click", handleHistoryListClick);
        UI.inputs.searchNotes.addEventListener("input", (e) => renderHistory(e.target.value.toLowerCase()));
        UI.inputs.selectAllNotes.addEventListener("change", toggleSelectAll);
        UI.buttons.deleteSelected.addEventListener("click", () => handleDeleteNote([...state.selectedNotes]));

        UI.buttons.connectDrive.addEventListener("click", (e) => { e.preventDefault(); startDriveConnect(); });
    }

    async function initializeApp() {
        checkOAuthRedirectFlags();
        if (state.token) {
            UI.buttons.logout.style.display = "inline-block";
            await loadUserProfile();
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

