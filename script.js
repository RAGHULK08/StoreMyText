document.addEventListener("DOMContentLoaded", () => {
    // --- Element Selectors ---
    const loginSection = document.getElementById("loginSection");
    const registerSection = document.getElementById("registerSection");
    const mainSection = document.getElementById("mainSection");
    const historySection = document.getElementById("historySection");
    const loginForm = document.getElementById("loginForm");
    const registerForm = document.getElementById("registerForm");
    const loginMsg = document.getElementById("loginMsg");
    const registerMsg = document.getElementById("registerMsg");
    const goToRegister = document.getElementById("goToRegister");
    const goToLogin = document.getElementById("goToLogin");
    const mainSectionTitle = document.getElementById("mainSectionTitle");
    const noteTitleInput = document.getElementById("noteTitle");
    const textInput = document.getElementById("textInput");
    const charCounter = document.getElementById("charCounter");
    const saveBtn = document.getElementById("saveBtn");
    const cancelEditBtn = document.getElementById("cancelEditBtn");
    const historyBtn = document.getElementById("historyBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const status = document.getElementById("status");
    const historyList = document.getElementById("historyList");
    const historyStatus = document.getElementById("historyStatus");
    const backToMain = document.getElementById("backToMain");
    const searchBox = document.getElementById("searchNotes");
    const connectDriveBtn = document.getElementById("connectDriveBtn");

    // --- API and State Management ---
    const BACKEND_BASE_URL = "https://savetext-0pk6.onrender.com/api";
    let loggedInUser = null;
    let allNotes = [];
    let isEditing = null;

    // --- Initial View ---
    showView(loginSection);

    // --- View Management ---
    function showView(view) {
        [loginSection, registerSection, mainSection, historySection].forEach(
            v => v.classList.remove("active")
        );
        view.classList.add("active");
        logoutBtn.style.display = (view === mainSection || view === historySection) ? "inline-block" : "none";
    }

    // --- Utility Functions ---
    function showStatusMessage(element, msg, color, duration = 3000) {
        element.textContent = msg;
        element.style.color = color || "#333";
        if (msg) {
            setTimeout(() => { element.textContent = ""; }, duration);
        }
    }

    const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const isValidPassword = (password) => /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/.test(password);

    // --- Event Listeners ---
    goToRegister.addEventListener("click", (e) => { e.preventDefault(); showView(registerSection); });
    goToLogin.addEventListener("click", (e) => { e.preventDefault(); showView(loginSection); });
    historyBtn.addEventListener("click", () => { fetchHistory(); showView(historySection); });
    backToMain.addEventListener("click", () => showView(mainSection));
    textInput.addEventListener("input", () => { charCounter.textContent = `${textInput.value.length} characters`; });

    // --- User Authentication ---
    registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("registerEmail").value.trim().toLowerCase();
        const password = document.getElementById("registerPassword").value.trim();
        const confirmPassword = document.getElementById("registerConfirmPassword").value.trim();

        if (!isValidEmail(email)) return showStatusMessage(registerMsg, "Invalid email format.", "red");
        if (password !== confirmPassword) return showStatusMessage(registerMsg, "Passwords do not match.", "red");
        if (!isValidPassword(password)) return showStatusMessage(registerMsg, "Password: 8+ chars, with uppercase, lowercase, & symbol.", "red");
        
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (res.ok) {
                showStatusMessage(registerMsg, "Registration successful! Please login.", "green");
                setTimeout(() => { showView(loginSection); registerForm.reset(); }, 1500);
            } else {
                showStatusMessage(registerMsg, data.error || "Registration failed.", "red");
            }
        } catch (error) {
            showStatusMessage(registerMsg, "Cannot connect to the server.", "red");
        }
    });

    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("loginEmail").value.trim().toLowerCase();
        const password = document.getElementById("loginPassword").value.trim();

        try {
            const res = await fetch(`${BACKEND_BASE_URL}/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (res.ok) {
                loggedInUser = email;
                showView(mainSection);
                loginForm.reset();
            } else {
                showStatusMessage(loginMsg, data.error || "Login failed.", "red");
            }
        } catch (error) {
            console.error("Login Error:", error);
            showStatusMessage(loginMsg, "Cannot connect to the server.", "red");
        }
    });

    logoutBtn.addEventListener("click", () => {
        if (confirm("Are you sure you want to logout?")) {
            loggedInUser = null;
            allNotes = [];
            resetMainForm();
            historyList.innerHTML = "";
            showView(loginSection);
        }
    });
    
    // --- Note Management ---
    saveBtn.addEventListener("click", async () => {
        const title = noteTitleInput.value.trim();
        const text = textInput.value.trim();
        
        if (!text || !title) return showStatusMessage(status, "Please enter a title and some text.", "red");
        if (!loggedInUser) return showStatusMessage(status, "You must be logged in to save.", "red");

        const endpoint = isEditing ? '/edit' : '/userdata';
        const method = 'POST';
        const payload = {
            emailid: loggedInUser,
            filename: isEditing || `note_${Date.now()}.txt`,
            title: title,
            filecontent: text
        };

        const actionText = isEditing ? "Updating" : "Saving";
        showStatusMessage(status, `${actionText}...`, "#444");

        try {
            const res = await fetch(`${BACKEND_BASE_URL}${endpoint}`, {
                method: method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok) {
                showStatusMessage(status, `Note ${actionText.slice(0, -3)}ed successfully ✅`, "green");
                resetMainForm();
            } else {
                showStatusMessage(status, data.error || `Error ${actionText.toLowerCase()} note!`, "red");
            }
        } catch (e) {
            showStatusMessage(status, "Network error! Could not connect.", "red");
        }
    });

    cancelEditBtn.addEventListener("click", resetMainForm);

    async function handleDeleteNote(filename) {
        if (!confirm(`Are you sure you want to delete this note?`)) return;
        showStatusMessage(historyStatus, "Deleting note...", "#444");
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/delete`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: loggedInUser, filename })
            });
            if (res.ok) {
                showStatusMessage(historyStatus, "Note deleted successfully!", "green");
                fetchHistory(); // Refresh list
            } else {
                const data = await res.json();
                showStatusMessage(historyStatus, data.error || "Failed to delete note.", "red");
            }
        } catch (err) {
            showStatusMessage(historyStatus, "Cannot connect to the server.", "red");
        }
    }
    
    function handleEditNote(note) {
        isEditing = note.filename;
        mainSectionTitle.textContent = "Edit Your Note";
        noteTitleInput.value = note.title;
        textInput.value = note.filecontent;
        saveBtn.textContent = "Update Note";
        cancelEditBtn.style.display = "block";
        historyBtn.style.display = "none";
        charCounter.textContent = `${textInput.value.length} characters`;
        showView(mainSection);
        window.scrollTo(0, 0);
    }
    
    function resetMainForm() {
        isEditing = null;
        mainSectionTitle.textContent = "Save Your Text";
        noteTitleInput.value = "";
        textInput.value = "";
        saveBtn.textContent = "Save to Cloud";
        cancelEditBtn.style.display = "none";
        historyBtn.style.display = "block";
        charCounter.textContent = "0 characters";
    }

    // --- History & Search ---
    async function fetchHistory() {
        if (!loggedInUser) return showStatusMessage(historyStatus, "Please login first.", "red");
        
        showStatusMessage(historyStatus, "Loading...", "#444");
        historyList.innerHTML = "";
        try {
            const url = new URL(`${BACKEND_BASE_URL}/userdata`);
            url.searchParams.set("emailid", loggedInUser);
            const res = await fetch(url);
            if (!res.ok) throw new Error("Server responded with an error");
            allNotes = await res.json();
            renderHistory(allNotes);
            showStatusMessage(historyStatus, "");
        } catch (err) {
            showStatusMessage(historyStatus, "Failed to fetch history.", "red");
        }
    }

    function renderHistory(notes) {
        historyList.innerHTML = "";
        if (!notes.length) {
            historyList.innerHTML = "<p>No saved notes found.</p>";
            return;
        }
        notes.forEach(note => {
            const noteDiv = document.createElement("div");
            noteDiv.className = "history-item";

            const formattedDate = new Date(note.updated_at).toLocaleString('en-US', {
                dateStyle: 'medium',
                timeStyle: 'short'
            });

            noteDiv.innerHTML = `
                <div class="history-item-header">
                    <span class="history-item-title">${note.title}</span>
                </div>
                <p class="history-item-content">${note.filecontent}</p>
                <div class="history-item-footer">
                    <span>Last updated: ${formattedDate}</span>
                    <div class="history-item-actions">
                        <button class="edit-btn" data-filename="${note.filename}">Edit</button>
                        <button class="delete-btn" data-filename="${note.filename}">Delete</button>
                    </div>
                </div>
            `;
            
            historyList.appendChild(noteDiv);
        });

        historyList.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const noteToEdit = allNotes.find(n => n.filename === btn.dataset.filename);
                if(noteToEdit) handleEditNote(noteToEdit);
            });
        });
        historyList.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => handleDeleteNote(btn.dataset.filename));
        });
    }

    searchBox.addEventListener("input", function () {
        const searchTerm = this.value.trim().toLowerCase();
        const filteredNotes = allNotes.filter(note =>
            note.title.toLowerCase().includes(searchTerm) ||
            note.filecontent.toLowerCase().includes(searchTerm)
        );
        renderHistory(filteredNotes);
    });

    // --- Google Drive Connection Logic ---
    connectDriveBtn.addEventListener("click", async () => {
        if (!loggedInUser) {
            showStatusMessage(status, "Please login first.", "red");
            return;
        }
        
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/auth/google/start?emailid=${loggedInUser}`);
            const data = await res.json();
            
            if (res.ok) {
                window.open(data.authorization_url, '_blank', 'width=500,height=600');
            } else {
                showStatusMessage(status, data.error || "Could not start Google auth.", "red");
            }
        } catch (error) {
            showStatusMessage(status, "Cannot connect to server for Google auth.", "red");
        }
    });

    window.addEventListener("message", (event) => {
        if (event.data === "google-auth-success") {
            showStatusMessage(status, "✅ Google Drive connected successfully!", "green");
            connectDriveBtn.textContent = "✅ Google Drive Connected";
            connectDriveBtn.disabled = true;
        }
    });
})();
