(function () {
    "use strict";

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
            connectDrive: document.getElementById("connectDriveBtn"),
            deleteSelected: document.getElementById("deleteSelectedBtn"),
        },
        containers: {
            historyList: document.getElementById("historyList"),
            bulkActions: document.getElementById("bulkActions"),
        },
        messages: {
            login: document.getElementById("loginMsg"),
            register: document.getElementById("registerMsg"),
            mainStatus: document.getElementById("status"),
            historyStatus: document.getElementById("historyStatus"),
        },
        other: {
            mainTitle: document.getElementById("mainSectionTitle"),
            charCounter: document.getElementById("charCounter"),
            customConfirm: document.getElementById("customConfirm"),
            confirmMsg: document.getElementById("confirmMsg"),
            confirmYes: document.getElementById("confirmYes"),
            confirmNo: document.getElementById("confirmNo"),
        }
    };

    // --- Application State ---
    const state = {
        loggedInUser: null,
        editingNote: null, // filename being edited
        allNotes: [], // cache
        selectedNotes: new Set(),
    };

    const MAX_CHAR_LIMIT = 10000;

    // IMPORTANT: set backend base URL to your Render service (no trailing slash)
    const BACKEND_BASE_URL = "https://savetext-0pk6.onrender.com";

    // --- Helpers ---
    function showStatusMessage(element, message, color) {
        if (!element) return;
        element.textContent = message;
        element.style.color = color || "#000";
    }

    // Add simple show/hide password toggle appended after the input
    function addPasswordToggle(input) {
        if (!input || input.dataset.hasToggle) return;
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "btn-small";
        toggle.style.marginLeft = "8px";
        toggle.textContent = "Show";
        toggle.addEventListener("click", () => {
            if (input.type === "password") {
                input.type = "text";
                toggle.textContent = "Hide";
            } else {
                input.type = "password";
                toggle.textContent = "Show";
            }
        });
        input.dataset.hasToggle = "1";
        // Insert after input
        input.parentNode.insertBefore(toggle, input.nextSibling);
    }

    // Custom confirmation dialog (promise-based)
    function customConfirm(message) {
        return new Promise((resolve) => {
            UI.other.confirmMsg.textContent = message;
            UI.other.customConfirm.style.display = "flex";

            const yesListener = () => {
                cleanup();
                resolve(true);
            };
            const noListener = () => {
                cleanup();
                resolve(false);
            };

            UI.other.confirmYes.addEventListener("click", yesListener);
            UI.other.confirmNo.addEventListener("click", noListener);

            function cleanup() {
                UI.other.customConfirm.style.display = "none";
                UI.other.confirmYes.removeEventListener("click", yesListener);
                UI.other.confirmNo.removeEventListener("click", noListener);
            }
        });
    }

    function switchView(viewName) {
        Object.values(UI.views).forEach(view => view.classList.remove('active'));
        if (UI.views[viewName]) {
            UI.views[viewName].classList.add('active');
            // focus first input for accessibility
            const inputs = UI.views[viewName].querySelectorAll('input, textarea, button');
            if (inputs.length) inputs[0].focus();
        }
    }

    // --- Core Logic ---

    function initialize() {
        const user = localStorage.getItem("loggedInUser");
        if (user) {
            state.loggedInUser = user;
            UI.buttons.logout.style.display = "block";
            switchView("main");
        } else {
            switchView("login");
        }
        addPasswordToggle(UI.inputs.loginPassword);
        addPasswordToggle(UI.inputs.registerPassword);
        UI.other.charCounter.textContent = `0/${MAX_CHAR_LIMIT}`;
        setupEventListeners();
    }

    async function fetchHistory() {
        if (!state.loggedInUser) return;
        showStatusMessage(UI.messages.historyStatus, "Loading notes...", "#444");
        try {
            const response = await fetch(`${BACKEND_BASE_URL}/history`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: state.loggedInUser }),
            });
            if (!response.ok) throw new Error("Failed to fetch history.");
            const notes = await response.json();

            // Ensure pinned first, newest within pinned/unpinned
            notes.sort((a, b) => {
                const aPinned = !!a.pinned;
                const bPinned = !!b.pinned;
                if (aPinned !== bPinned) return aPinned ? -1 : 1;
                const aTime = new Date(a.created_at).getTime() || 0;
                const bTime = new Date(b.created_at).getTime() || 0;
                return bTime - aTime;
            });

            state.allNotes = notes;
            renderHistory(state.allNotes);
            showStatusMessage(UI.messages.historyStatus, "", "black");
        } catch (error) {
            console.error("Fetch History Error:", error);
            showStatusMessage(UI.messages.historyStatus, "Could not load notes.", "red");
        }
    }

    function renderHistory(notes) {
        UI.containers.historyList.innerHTML = "";
        if (!notes || notes.length === 0) {
            UI.containers.historyList.innerHTML = "<p>No notes found.</p>";
            UI.containers.bulkActions.style.display = "none";
            UI.buttons.deleteSelected.style.display = "none";
            return;
        }

        UI.containers.bulkActions.style.display = "flex";
        notes.forEach(note => {
            const noteDiv = document.createElement("div");
            noteDiv.className = "history-item";
            noteDiv.dataset.filename = note.filename;

            // Checkbox
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "note-select-checkbox";
            checkbox.checked = state.selectedNotes.has(note.filename);
            checkbox.addEventListener("change", () => {
                toggleNoteSelection(note.filename, checkbox.checked);
            });

            const mainContent = document.createElement("div");
            mainContent.className = "history-item-main";

            const header = document.createElement("div");
            header.className = "history-item-header";

            const title = document.createElement("span");
            title.className = "history-item-title";
            title.textContent = note.title || 'Untitled Note';

            const actions = document.createElement("div");
            actions.className = "history-item-actions";

            const editBtn = document.createElement("button");
            editBtn.textContent = "Edit";
            editBtn.className = "btn-small edit-btn";
            editBtn.onclick = () => startEdit(note);

            const pinBtn = document.createElement("button");
            pinBtn.textContent = note.pinned ? "Unpin" : "Pin";
            pinBtn.className = `btn-small pin-btn ${note.pinned ? 'pinned' : ''}`;
            pinBtn.onclick = () => togglePin(note.filename, !note.pinned);

            actions.append(editBtn, pinBtn);
            header.append(title, actions);

            const content = document.createElement("div");
            content.className = "history-item-content";
            content.textContent = note.filecontent || "";

            const footer = document.createElement("div");
            footer.className = "history-item-footer";
            const dateSpan = document.createElement("span");
            dateSpan.textContent = `Saved: ${new Date(note.created_at).toLocaleString()}`;

            const copyBtn = document.createElement("button");
            copyBtn.textContent = "Copy Text";
            copyBtn.className = "btn-small copy-btn";
            copyBtn.onclick = () => copyToClipboard(note.filecontent || "", copyBtn);

            footer.append(dateSpan, copyBtn);
            mainContent.append(header, content, footer);
            noteDiv.append(checkbox, mainContent);
            UI.containers.historyList.appendChild(noteDiv);
        });

        updateBulkActionUI();
    }

    // --- Event Setup ---
    function setupEventListeners() {
        UI.buttons.goToRegister.addEventListener("click", (e) => { e.preventDefault(); switchView("register"); });
        UI.buttons.goToLogin.addEventListener("click", (e) => { e.preventDefault(); switchView("login"); });
        UI.buttons.history.addEventListener("click", () => { switchView("history"); fetchHistory(); });
        UI.buttons.backToMain.addEventListener("click", () => switchView("main"));

        UI.forms.login.addEventListener("submit", handleLogin);
        UI.forms.register.addEventListener("submit", handleRegister);
        UI.buttons.logout.addEventListener("click", handleLogout);

        UI.forms.note.addEventListener("submit", handleSaveNote);
        UI.buttons.cancelEdit.addEventListener("click", cancelEdit);

        UI.inputs.textInput.addEventListener("input", () => {
            const count = UI.inputs.textInput.value.length;
            UI.other.charCounter.textContent = `${count}/${MAX_CHAR_LIMIT}`;
        });

        UI.inputs.searchNotes.addEventListener("input", handleSearch);
        UI.inputs.selectAllNotes.addEventListener("change", toggleSelectAll);
        UI.buttons.deleteSelected.addEventListener("click", handleDeleteSelected);

        UI.buttons.connectDrive.addEventListener("click", () => {
            window.location.href = `${BACKEND_BASE_URL}/drive/login?email=${encodeURIComponent(state.loggedInUser)}`;
        });
    }

    // --- Auth Handlers ---
    async function handleLogin(e) {
        e.preventDefault();
        const email = UI.inputs.loginEmail.value.trim();
        const password = UI.inputs.loginPassword.value.trim();
        if (!email || !password) {
            showStatusMessage(UI.messages.login, "Please enter both email and password.", "red");
            return;
        }
        const submitBtn = UI.forms.login.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        showStatusMessage(UI.messages.login, "Logging in...", "#444");
        try {
            const response = await fetch(`${BACKEND_BASE_URL}/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: email, password: password }),
            });
            let result = {};
            try {
                result = await response.json();
            } catch {
                throw new Error("Server error: Could not parse response.");
            }
            if (!response.ok) {
                throw new Error(result.error || "Login failed.");
            }
            state.loggedInUser = email;
            localStorage.setItem("loggedInUser", email);
            UI.buttons.logout.style.display = "block";
            showStatusMessage(UI.messages.login, "Login successful!", "green");
            switchView("main");
        } catch (error) {
            if (error.name === "TypeError") {
                showStatusMessage(UI.messages.login, "Network error: Could not connect to server. Please check your connection or try again later.", "red");
            } else {
                showStatusMessage(UI.messages.login, error.message, "red");
            }
        } finally {
            submitBtn.disabled = false;
        }
    }

    async function handleRegister(e) {
        e.preventDefault();
        const email = UI.inputs.registerEmail.value.trim();
        const password = UI.inputs.registerPassword.value.trim();
        if (!email || !password) {
            showStatusMessage(UI.messages.register, "Please fill in all fields.", "red");
            return;
        }
        const submitBtn = UI.forms.register.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        showStatusMessage(UI.messages.register, "Registering...", "#444");
        try {
            const response = await fetch(`${BACKEND_BASE_URL}/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: email, password: password }),
            });
            let result = {};
            try {
                result = await response.json();
            } catch {
                throw new Error("Server error: Could not parse response.");
            }
            if (response.ok) {
                showStatusMessage(UI.messages.register, "Registration successful! Redirecting to login...", "green");
                // Clear register form
                UI.forms.register.reset();
                setTimeout(() => {
                    showStatusMessage(UI.messages.login, "Registration completed. Please log in.", "green");
                    switchView("login");
                }, 600);
            } else {
                throw new Error(result.error || "Registration failed.");
            }
        } catch (error) {
            if (error.name === "TypeError") {
                showStatusMessage(UI.messages.register, "Network error: Could not connect to server. Please check your connection or try again later.", "red");
            } else {
                showStatusMessage(UI.messages.register, error.message, "red");
            }
        } finally {
            submitBtn.disabled = false;
        }
    }

    function handleLogout() {
        state.loggedInUser = null;
        localStorage.removeItem("loggedInUser");
        UI.buttons.logout.style.display = "none";
        switchView("login");
    }

    // --- Note Handlers ---
    async function handleSaveNote(e) {
        e.preventDefault();
        if (!state.loggedInUser) {
            showStatusMessage(UI.messages.mainStatus, "You must be logged in to save notes.", "red");
            return;
        }
        const title = UI.inputs.noteTitle.value.trim();
        const content = UI.inputs.textInput.value;
        if (!content) {
            showStatusMessage(UI.messages.mainStatus, "Cannot save an empty note.", "orange");
            return;
        }

        const endpoint = state.editingNote ? "/update" : "/save";
        const method = state.editingNote ? "PUT" : "POST";
        const body = {
            emailid: state.loggedInUser,
            title: title,
            filecontent: content,
            filename: state.editingNote || undefined,
        };

        UI.buttons.save.disabled = true;
        showStatusMessage(UI.messages.mainStatus, "Saving...", "#444");
        try {
            const response = await fetch(`${BACKEND_BASE_URL}${endpoint}`, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const result = await response.json().catch(() => ({}));
            if (response.ok) {
                showStatusMessage(UI.messages.mainStatus, result.message || "Saved successfully", "green");
                UI.forms.note.reset();
                UI.other.charCounter.textContent = `0/${MAX_CHAR_LIMIT}`;
                if (state.editingNote) {
                    cancelEdit();
                }
                // Refresh history so users see the new/updated note immediately
                await fetchHistory();
            } else {
                throw new Error(result.error || "Failed to save note.");
            }
        } catch (error) {
            showStatusMessage(UI.messages.mainStatus, error.message || "Server error", "red");
        } finally {
            UI.buttons.save.disabled = false;
        }
    }

    function handleSearch() {
        const searchTerm = UI.inputs.searchNotes.value.trim().toLowerCase();
        const filteredNotes = state.allNotes.filter(note =>
            (note.title || '').toLowerCase().includes(searchTerm) ||
            (note.filecontent || '').toLowerCase().includes(searchTerm)
        );
        renderHistory(filteredNotes);
    }

    async function handleDeleteSelected() {
        if (state.selectedNotes.size === 0) return;
        const confirmed = await customConfirm(`Are you sure you want to delete ${state.selectedNotes.size} selected note(s)?`);
        if (!confirmed) return;

        showStatusMessage(UI.messages.historyStatus, "Deleting selected notes...", "#444");
        const promises = Array.from(state.selectedNotes).map(filename =>
            fetch(`${BACKEND_BASE_URL}/delete`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: state.loggedInUser, filename }),
            }).then(res => ({ ok: res.ok })).catch(() => ({ ok: false }))
        );

        try {
            const results = await Promise.all(promises);
            const deletedCount = results.filter(res => res.ok).length;
            showStatusMessage(UI.messages.historyStatus, `${deletedCount} note(s) deleted successfully.`, "green");
        } catch (error) {
            console.error("Bulk Delete Error:", error);
            showStatusMessage(UI.messages.historyStatus, "An error occurred during deletion.", "red");
        } finally {
            state.selectedNotes.clear();
            await fetchHistory();
        }
    }

    // --- note action helpers ---
    function startEdit(note) {
        state.editingNote = note.filename;
        UI.inputs.noteTitle.value = note.title || '';
        UI.inputs.textInput.value = note.filecontent || '';
        UI.other.mainTitle.textContent = "Edit Your Note";
        UI.buttons.save.textContent = "Update Note";
        UI.buttons.cancelEdit.style.display = "block";
        UI.other.charCounter.textContent = `${(note.filecontent || '').length}/${MAX_CHAR_LIMIT}`;
        switchView("main");
    }

    function cancelEdit() {
        state.editingNote = null;
        UI.forms.note.reset();
        UI.other.mainTitle.textContent = "Save Your Text";
        UI.buttons.save.textContent = "Save Note";
        UI.buttons.cancelEdit.style.display = "none";
        UI.other.charCounter.textContent = `0/${MAX_CHAR_LIMIT}`;
        showStatusMessage(UI.messages.mainStatus, "", "black");
    }

    async function togglePin(filename, shouldPin) {
        try {
            const response = await fetch(`${BACKEND_BASE_URL}/pin`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: state.loggedInUser, filename, pinned: shouldPin }),
            });
            if (response.ok) {
                await fetchHistory();
            } else {
                console.error("Pin operation failed");
            }
        } catch (error) {
            console.error("Pin Error:", error);
        }
    }

    function copyToClipboard(text, button) {
        navigator.clipboard.writeText(text).then(() => {
            const originalText = button.textContent;
            button.textContent = "Copied!";
            setTimeout(() => { button.textContent = originalText; }, 2000);
        }).catch(err => {
            console.error('Failed to copy text: ', err);
            showStatusMessage(UI.messages.historyStatus, "Copy failed.", "red");
        });
    }

    // --- Bulk selection ---
    function toggleNoteSelection(filename, checked) {
        if (checked) state.selectedNotes.add(filename);
        else state.selectedNotes.delete(filename);
        updateBulkActionUI();
    }

    function toggleSelectAll() {
        const isChecked = UI.inputs.selectAllNotes.checked;
        const checkboxes = document.querySelectorAll(".note-select-checkbox");
        const visibleNotes = Array.from(checkboxes).map(cb => cb.closest('.history-item').dataset.filename);

        state.selectedNotes.clear();
        if (isChecked) visibleNotes.forEach(fn => state.selectedNotes.add(fn));

        checkboxes.forEach(cb => cb.checked = isChecked);
        updateBulkActionUI();
    }

    function updateBulkActionUI() {
        const allCheckboxes = document.querySelectorAll(".note-select-checkbox");
        const allVisibleSelected = allCheckboxes.length > 0 && Array.from(allCheckboxes).every(cb => cb.checked);
        UI.inputs.selectAllNotes.checked = allVisibleSelected;

        const hasSelection = state.selectedNotes.size > 0;
        UI.buttons.deleteSelected.style.display = hasSelection ? "block" : "none";
    }

    // --- init ---
    document.addEventListener("DOMContentLoaded", initialize);
})();
