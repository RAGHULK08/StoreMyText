(function () {
    // Self-executing anonymous function to encapsulate the script and avoid global scope pollution.
    "use strict";

    // --- DOM Element Selection ---
    // A centralized object to hold all DOM element references for cleaner access.
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
    // Manages the dynamic state of the application.
    const state = {
        loggedInUser: null,
        editingNote: null, // Stores the filename of the note being edited
        allNotes: [], // Cache for all fetched notes to enable client-side search
        selectedNotes: new Set(), // Holds filenames of selected notes for bulk actions
    };

    // --- Constants ---
    // Use relative path for backend API (works for local and deployed)
    const BACKEND_BASE_URL = "/"; // Use "/" for same-origin API calls
    const MAX_CHAR_LIMIT = 10000;

    // --- Utility Functions ---

    /**
     * Displays a status message to the user.
     * @param {HTMLElement} element - The message container element.
     * @param {string} message - The text to display.
     * @param {string} color - The color of the message text.
     */
    function showStatusMessage(element, message, color) {
        element.textContent = message;
        element.style.color = color;
        // The message will auto-clear on the next successful action.
    }

    // --- Password Show/Hide Toggle ---
    function addPasswordToggle(input, container) {
        const toggle = document.createElement("span");
        toggle.textContent = "👁";
        toggle.style.cursor = "pointer";
        toggle.style.marginLeft = "8px";
        toggle.style.userSelect = "none";
        toggle.title = "Show/Hide Password";
        toggle.onclick = () => {
            input.type = input.type === "password" ? "text" : "password";
            toggle.textContent = input.type === "password" ? "👁" : "🙈";
        };
        container.appendChild(toggle);
    }
    // Add to login password field
    addPasswordToggle(UI.inputs.loginPassword, UI.inputs.loginPassword.parentElement);

    /**
     * A promise-based custom confirmation dialog to replace the blocking `window.confirm`.
     * @param {string} message - The confirmation message to display.
     * @returns {Promise<boolean>} - Resolves with true if "Yes" is clicked, false otherwise.
     */
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

    /**
     * Switches the active view, hiding all others.
     * @param {string} viewName - The key of the view to show (e.g., 'login', 'main').
     */
    function switchView(viewName) {
        Object.values(UI.views).forEach(view => view.classList.remove('active'));
        if (UI.views[viewName]) {
            UI.views[viewName].classList.add('active');
        }
    }

    // --- Core Application Logic ---

    /**
     * Initializes the application, checks login status, and sets up initial view.
     */
    function initialize() {
        const user = localStorage.getItem("loggedInUser");
        if (user) {
            state.loggedInUser = user;
            UI.buttons.logout.style.display = "block";
            switchView("main");
        } else {
            switchView("login");
        }
        setupEventListeners();
    }

    /**
     * Fetches the user's note history from the backend.
     */
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
            state.allNotes = notes.sort((a, b) => (b.pinned === a.pinned) ? 0 : b.pinned ? 1 : -1);
            renderHistory(state.allNotes);
            showStatusMessage(UI.messages.historyStatus, "", "black");
        } catch (error) {
            console.error("Fetch History Error:", error);
            showStatusMessage(UI.messages.historyStatus, "Could not load notes.", "red");
        }
    }

    /**
     * Renders the list of notes in the history view.
     * @param {Array} notes - An array of note objects to render.
     */
    function renderHistory(notes) {
        UI.containers.historyList.innerHTML = ""; // Clear previous list
        if (notes.length === 0) {
            UI.containers.historyList.innerHTML = "<p>No notes found.</p>";
            UI.containers.bulkActions.style.display = "none";
            return;
        }

        UI.containers.bulkActions.style.display = "flex";

        notes.forEach(note => {
            const noteDiv = document.createElement("div");
            noteDiv.className = "history-item";
            noteDiv.dataset.filename = note.filename;

            // Checkbox for selection
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "note-select-checkbox";
            checkbox.checked = state.selectedNotes.has(note.filename);
            checkbox.addEventListener("change", () => toggleNoteSelection(note.filename));

            const mainContent = document.createElement("div");
            mainContent.className = "history-item-main";

            const header = document.createElement("div");
            header.className = "history-item-header";

            const title = document.createElement("span");
            title.className = "history-item-title";
            title.textContent = note.title || 'Untitled Note';

            const actions = document.createElement("div");
            actions.className = "history-item-actions";

            // Edit Button
            const editBtn = document.createElement("button");
            editBtn.textContent = "Edit";
            editBtn.className = "btn-small edit-btn";
            editBtn.onclick = () => startEdit(note);

            // Pin Button
            const pinBtn = document.createElement("button");
            pinBtn.textContent = note.pinned ? "Unpin" : "Pin";
            pinBtn.className = `btn-small pin-btn ${note.pinned ? 'pinned' : ''}`;
            pinBtn.onclick = () => togglePin(note.filename, !note.pinned);

            actions.append(editBtn, pinBtn);
            header.append(title, actions);

            const content = document.createElement("div");
            content.className = "history-item-content";
            content.textContent = note.filecontent;

            const footer = document.createElement("div");
            footer.className = "history-item-footer";
            const dateSpan = document.createElement("span");
            dateSpan.textContent = `Saved: ${new Date(note.created_at).toLocaleString()}`;

            // Copy Button
            const copyBtn = document.createElement("button");
            copyBtn.textContent = "Copy Text";
            copyBtn.className = "btn-small copy-btn";
            copyBtn.onclick = () => copyToClipboard(note.filecontent, copyBtn);

            footer.append(dateSpan, copyBtn);
            mainContent.append(header, content, footer);
            noteDiv.append(checkbox, mainContent);
            UI.containers.historyList.appendChild(noteDiv);
        });
        updateBulkActionUI();
    }

    // --- Event Handlers & Associated Logic ---

    /**
     * Sets up all the event listeners for the application.
     */
    function setupEventListeners() {
        // View Switching
        UI.buttons.goToRegister.addEventListener("click", (e) => { e.preventDefault(); switchView("register"); });
        UI.buttons.goToLogin.addEventListener("click", (e) => { e.preventDefault(); switchView("login"); });
        UI.buttons.history.addEventListener("click", () => { switchView("history"); fetchHistory(); });
        UI.buttons.backToMain.addEventListener("click", () => switchView("main"));

        // Authentication
        UI.forms.login.addEventListener("submit", handleLogin);
        UI.forms.register.addEventListener("submit", handleRegister);
        UI.buttons.logout.addEventListener("click", handleLogout);

        // Note Management
        UI.forms.note.addEventListener("submit", handleSaveNote);
        UI.buttons.cancelEdit.addEventListener("click", cancelEdit);
        UI.inputs.textInput.addEventListener("input", () => {
            const count = UI.inputs.textInput.value.length;
            UI.other.charCounter.textContent = `${count}/${MAX_CHAR_LIMIT}`;
        });

        // History View Actions
        UI.inputs.searchNotes.addEventListener("input", handleSearch);
        UI.inputs.selectAllNotes.addEventListener("change", toggleSelectAll);
        UI.buttons.deleteSelected.addEventListener("click", handleDeleteSelected);

        // Google Drive
        UI.buttons.connectDrive.addEventListener("click", () => {
            window.location.href = `${BACKEND_BASE_URL}/drive/login?email=${state.loggedInUser}`;
        });
    }

    async function handleLogin(e) {
        e.preventDefault();
        const email = UI.inputs.loginEmail.value.trim();
        const password = UI.inputs.loginPassword.value.trim();
        if (!email || !password) {
            showStatusMessage(UI.messages.login, "Please enter both email and password.", "red");
            return;
        }
        UI.buttons.save.disabled = true;
        showStatusMessage(UI.messages.login, "Logging in...", "#444");
        try {
            const response = await fetch(`${BACKEND_BASE_URL}/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: email, password: password }),
            });
            if (!response.ok) {
                let result = {};
                try { result = await response.json(); } catch { }
                throw new Error(result.error || "Login failed.");
            }
            const result = await response.json();
            state.loggedInUser = email;
            localStorage.setItem("loggedInUser", email);
            UI.buttons.logout.style.display = "block";
            showStatusMessage(UI.messages.login, "Login successful!", "green");
            switchView("main");
        } catch (error) {
            if (error.name === "TypeError") {
                showStatusMessage(UI.messages.login, "Network error: Could not connect to server.", "red");
            } else {
                showStatusMessage(UI.messages.login, error.message, "red");
            }
        } finally {
            UI.buttons.save.disabled = false;
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
        try {
            // FIX: Add missing slash to endpoint
            const response = await fetch(`${BACKEND_BASE_URL}/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: email, password: password }),
            });
            const result = await response.json();
            if (response.ok) {
                showStatusMessage(UI.messages.login, "Registration successful! Please log in.", "green");
                switchView("login");
            } else {
                throw new Error(result.error || "Registration failed.");
            }
        } catch (error) {
            showStatusMessage(UI.messages.register, error.message, "red");
        }
    }

    function handleLogout() {
        state.loggedInUser = null;
        localStorage.removeItem("loggedInUser");
        UI.buttons.logout.style.display = "none";
        switchView("login");
    }

    async function handleSaveNote(e) {
        e.preventDefault();
        const title = UI.inputs.noteTitle.value.trim();
        const content = UI.inputs.textInput.value;
        if (!content) {
            showStatusMessage(UI.messages.mainStatus, "Cannot save an empty note.", "orange");
            return;
        }

        const endpoint = state.editingNote ? "/update" : "/save";
        const body = {
            emailid: state.loggedInUser,
            title: title,
            filecontent: content,
            filename: state.editingNote, // will be null for new notes
        };

        showStatusMessage(UI.messages.mainStatus, "Saving...", "#444");
        try {
            const response = await fetch(`${BACKEND_BASE_URL}${endpoint}`, {
                method: state.editingNote ? "PUT" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const result = await response.json();
            if (response.ok) {
                showStatusMessage(UI.messages.mainStatus, result.message, "green");
                if (state.editingNote) {
                    cancelEdit(); // Reset form after successful edit
                } else {
                    UI.forms.note.reset(); // Reset for new note
                    UI.other.charCounter.textContent = `0/${MAX_CHAR_LIMIT}`;
                }
            } else {
                throw new Error(result.error || "Failed to save note.");
            }
        } catch (error) {
            showStatusMessage(UI.messages.mainStatus, error.message, "red");
        }
    }

    function handleSearch() {
        const searchTerm = UI.inputs.searchNotes.value.trim().toLowerCase();
        const filteredNotes = state.allNotes.filter(note =>
            (note.title || '').toLowerCase().includes(searchTerm) ||
            note.filecontent.toLowerCase().includes(searchTerm)
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
            })
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
            fetchHistory(); // Refresh the list
        }
    }

    // --- Helper functions for note actions ---

    function startEdit(note) {
        state.editingNote = note.filename;
        UI.inputs.noteTitle.value = note.title || '';
        UI.inputs.textInput.value = note.filecontent;
        UI.other.mainTitle.textContent = "Edit Your Note";
        UI.buttons.save.textContent = "Update Note";
        UI.buttons.cancelEdit.style.display = "block";
        UI.other.charCounter.textContent = `${note.filecontent.length}/${MAX_CHAR_LIMIT}`;
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
                fetchHistory(); // Refresh to show updated pin status
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
        }).catch(err => console.error('Failed to copy text: ', err));
    }

    // --- Bulk Selection Logic ---

    function toggleNoteSelection(filename) {
        if (state.selectedNotes.has(filename)) {
            state.selectedNotes.delete(filename);
        } else {
            state.selectedNotes.add(filename);
        }
        updateBulkActionUI();
    }

    function toggleSelectAll() {
        const isChecked = UI.inputs.selectAllNotes.checked;
        const checkboxes = document.querySelectorAll(".note-select-checkbox");
        const visibleNotes = Array.from(checkboxes).map(cb => cb.closest('.history-item').dataset.filename);

        state.selectedNotes.clear();
        if (isChecked) {
            visibleNotes.forEach(filename => state.selectedNotes.add(filename));
        }

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


    // --- App Initialization ---
    // The DOMContentLoaded event ensures the script runs only after the entire HTML is loaded.
    document.addEventListener("DOMContentLoaded", initialize);

})();
