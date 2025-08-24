document.addEventListener("DOMContentLoaded", () => {
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

    const BACKEND_BASE_URL = "https://savetext-0pk6.onrender.com/api";
    let loggedInUser = null;
    let allNotes = [];
    let isEditing = null;

    // Check for an existing login session when the popup opens
    if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["loggedInUserEmail"], (result) => {
            if (result.loggedInUserEmail) {
                loggedInUser = result.loggedInUserEmail;
                showView(mainSection);
            } else {
                showView(loginSection);
            }
        });
    } else {
        showView(loginSection);
    }

    function showView(view) {
        [loginSection, registerSection, mainSection, historySection].forEach(
            v => v.classList.remove("active")
        );
        view.classList.add("active");
        logoutBtn.style.display = (view === mainSection || view === historySection) ? "inline-block" : "none";

        if (view === historySection) {
            fetchHistory();
        }
    }

    function showStatusMessage(element, msg, color, duration = 3000) {
        element.textContent = msg;
        element.style.color = color || "#333";
        if (msg) {
            setTimeout(() => { element.textContent = ""; }, duration);
        }
    }

    const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const isValidPassword = (password) => /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/.test(password);

    goToRegister.addEventListener("click", (e) => { e.preventDefault(); showView(registerSection); });
    goToLogin.addEventListener("click", (e) => { e.preventDefault(); showView(loginSection); });
    historyBtn.addEventListener("click", () => showView(historySection));
    backToMain.addEventListener("click", () => showView(mainSection));
    textInput.addEventListener("input", () => { charCounter.textContent = `${textInput.value.length} characters`; });

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
                if (chrome && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ loggedInUserEmail: email });
                }

                if (data.is_google_connected) {
                    showView(mainSection);
                } else {
                    showStatusMessage(loginMsg, "Login successful! Please connect your Google Drive.", "blue");
                    connectToGoogleDrive();
                }
                loginForm.reset();
            } else {
                loggedInUser = null;
                showStatusMessage(loginMsg, data.error || "Login failed.", "red");
            }
        } catch (error) {
            loggedInUser = null;
            showStatusMessage(loginMsg, "Cannot connect to the server.", "red");
        }
    });

    logoutBtn.addEventListener("click", () => {
        if (confirm("Are you sure you want to logout?")) {
            if (chrome && chrome.storage && chrome.storage.local) {
                chrome.storage.local.remove('loggedInUserEmail');
            }
            loggedInUser = null;
            allNotes = [];
            resetMainForm();
            historyList.innerHTML = "";
            showView(loginSection);
        }
    });

    async function connectToGoogleDrive() {
        if (!loggedInUser) return;
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/auth/google/start?emailid=${loggedInUser}`);
            const data = await res.json();
            if (res.ok) {
                window.open(data.authorization_url, '_blank', 'width=500,height=600');
            } else {
                showStatusMessage(loginMsg, data.error || "Could not start Google auth.", "red");
            }
        } catch (error) {
            showStatusMessage(loginMsg, "Cannot connect to server for Google auth.", "red");
        }
    }

    window.addEventListener("message", (event) => {
        if (event.data === "google-auth-success") {
            showStatusMessage(status, "✅ Google Drive connected successfully!", "green");
            showView(mainSection);
        }
    });

    saveBtn.addEventListener("click", async () => {
        const title = noteTitleInput.value.trim();
        const text = textInput.value.trim();

        if (!text || !title) return showStatusMessage(status, "Please enter a title and some text.", "red");
        if (!loggedInUser) return showStatusMessage(status, "You must be logged in to save.", "red");

        const endpoint = isEditing ? '/edit' : '/userdata';
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
                method: "POST",
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
                fetchHistory();
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

    async function fetchHistory() {
        if (!loggedInUser) return showStatusMessage(historyStatus, "Please login first.", "red");

        showStatusMessage(historyStatus, "Loading...", "#444");
        historyList.innerHTML = "";
        try {
            const url = new URL(`${BACKEND_BASE_URL}/userdata`);
            url.searchParams.set("emailid", loggedInUser);
            const res = await fetch(url, { cache: 'no-cache' });
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
        if (!notes || notes.length === 0) {
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
                        <button class="drive-btn" data-filename="${note.filename}">Save to Google Drive</button>
                    </div>
                </div>
            `;
            historyList.appendChild(noteDiv);
        });

        // --- ROBUSTNESS FIX: Check if buttons exist before adding listeners ---
        const editButtons = historyList.querySelectorAll('.edit-btn');
        if (editButtons) {
            editButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const noteToEdit = allNotes.find(n => n.filename === btn.dataset.filename);
                    if (noteToEdit) handleEditNote(noteToEdit);
                });
            });
        }

        const deleteButtons = historyList.querySelectorAll('.delete-btn');
        if (deleteButtons) {
            deleteButtons.forEach(btn => {
                btn.addEventListener('click', () => handleDeleteNote(btn.dataset.filename));
            });
        }

        const driveButtons = historyList.querySelectorAll('.drive-btn');
        if (driveButtons) {
            driveButtons.forEach(btn => {
                btn.addEventListener('click', async () => {
                    const noteToUpload = allNotes.find(n => n.filename === btn.dataset.filename);
                    if (!noteToUpload) return;
                    showStatusMessage(historyStatus, "Uploading to Google Drive...", "#444");
                    try {
                        const res = await fetch(`${BACKEND_BASE_URL}/drive/upload`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                emailid: loggedInUser,
                                filename: noteToUpload.filename,
                                title: noteToUpload.title,
                                filecontent: noteToUpload.filecontent
                            })
                        });
                        const data = await res.json();
                        if (res.ok) {
                            showStatusMessage(historyStatus, "Uploaded to Google Drive ✅", "green");
                        } else {
                            showStatusMessage(historyStatus, data.error || "Drive upload failed.", "red");
                        }
                    } catch (err) {
                        showStatusMessage(historyStatus, "Network error during Drive upload.", "red");
                    }
                });
            });
        }
    }

    // --- ROBUSTNESS FIX: Check if searchBox exists before adding listener ---
    if (searchBox) {
        searchBox.addEventListener("input", function () {
            const searchTerm = this.value.trim().toLowerCase();
            const filteredNotes = allNotes.filter(note =>
                note.title.toLowerCase().includes(searchTerm) ||
                note.filecontent.toLowerCase().includes(searchTerm)
            );
            renderHistory(filteredNotes);
        });
    }
})();
