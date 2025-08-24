(function () {
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
        const connectDriveBtn = document.getElementById("connectDriveBtn");

        const BACKEND_BASE_URL = "https://savetext-0pk6.onrender.com/api";

        // environment-agnostic storage (works on website and extension)
        const isExt = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
        const storage = {
            get: (key) => {
                if (isExt) {
                    return new Promise(resolve => chrome.storage.local.get([key], r => resolve(r[key] || null)));
                }
                return Promise.resolve(localStorage.getItem(key));
            },
            set: (key, value) => {
                if (isExt) {
                    return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
                }
                localStorage.setItem(key, value);
                return Promise.resolve();
            },
            remove: (key) => {
                if (isExt) {
                    return new Promise(resolve => chrome.storage.local.remove(key, resolve));
                }
                localStorage.removeItem(key);
                return Promise.resolve();
            }
        };

        let loggedInUser = null;
        let allNotes = [];
        let isEditing = null;

        // restore session
        storage.get('loggedInUserEmail').then(email => {
            if (email) {
                loggedInUser = email;
                showView(mainSection);
            } else {
                showView(loginSection);
            }
        });

        function showView(view) {
            [loginSection, registerSection, mainSection, historySection].forEach(v => v.classList.remove("active"));
            view.classList.add("active");
            logoutBtn.style.display = (view === mainSection || view === historySection) ? "inline-block" : "none";
            if (view === historySection) fetchHistory();
        }

        function showStatusMessage(element, msg, color, duration = 3000) {
            element.textContent = msg;
            element.style.color = color || "#333";
            if (msg) setTimeout(() => { element.textContent = ""; }, duration);
        }

        const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        const isValidPassword = (password) => /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/.test(password);

        goToRegister.addEventListener("click", (e) => { e.preventDefault(); showView(registerSection); });
        goToLogin.addEventListener("click", (e) => { e.preventDefault(); showView(loginSection); });
        historyBtn.addEventListener("click", () => showView(historySection));
        backToMain.addEventListener("click", () => showView(mainSection));
        textInput.addEventListener("input", () => { charCounter.textContent = `${textInput.value.length} characters`; });

        if (connectDriveBtn) {
            connectDriveBtn.addEventListener('click', () => connectToGoogleDrive());
        }

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
                    setTimeout(() => { showView(loginSection); registerForm.reset(); }, 1200);
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
                    await storage.set('loggedInUserEmail', email);

                    if (data.is_google_connected) {
                        showView(mainSection);
                    } else {
                        showStatusMessage(loginMsg, "Login successful! Please connect your Google Drive.", "#0b5ed7");
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

        logoutBtn.addEventListener("click", async () => {
            if (confirm("Are you sure you want to logout?")) {
                await storage.remove('loggedInUserEmail');
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
                const res = await fetch(`${BACKEND_BASE_URL}/auth/google/start?emailid=${encodeURIComponent(loggedInUser)}`);
                const data = await res.json();
                if (res.ok && data.authorization_url) {
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
                filecontent: text,
            };

            const actionText = isEditing ? "Updating" : "Saving";
            showStatusMessage(status, `${actionText}...`, "#444");

            try {
                const res = await fetch(`${BACKEND_BASE_URL}${endpoint}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                const data = await res.json();
                if (res.ok) {
                    showStatusMessage(status, `Note ${isEditing ? 'updat' : 'sav'}ed successfully ✅`, "green");
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
                    body: JSON.stringify({ emailid: loggedInUser, filename }),
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
            saveBtn.textContent = "Save";
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

        // Safely render history without innerHTML injection for the dynamic parts
        function renderHistory(notes) {
            historyList.innerHTML = "";
            if (!notes || notes.length === 0) {
                const p = document.createElement('p');
                p.textContent = "No saved notes found.";
                historyList.appendChild(p);
                return;
            }

            notes.forEach(note => {
                const noteDiv = document.createElement("div");
                noteDiv.className = "history-item";

                const header = document.createElement('div');
                header.className = 'history-item-header';
                const titleSpan = document.createElement('span');
                titleSpan.className = 'history-item-title';
                titleSpan.textContent = note.title;
                header.appendChild(titleSpan);

                const contentP = document.createElement('p');
                contentP.className = 'history-item-content';
                contentP.textContent = note.filecontent;

                const footer = document.createElement('div');
                footer.className = 'history-item-footer';
                const timeSpan = document.createElement('span');
                const formattedDate = new Date(note.updated_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
                timeSpan.textContent = `Last updated: ${formattedDate}`;

                const actions = document.createElement('div');
                actions.className = 'history-item-actions';

                const editBtn = document.createElement('button');
                editBtn.className = 'edit-btn';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', () => handleEditNote(note));

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'delete-btn';
                deleteBtn.textContent = 'Delete';
                deleteBtn.addEventListener('click', () => handleDeleteNote(note.filename));

                const driveBtn = document.createElement('button');
                driveBtn.className = 'drive-btn';
                driveBtn.textContent = 'Save to Google Drive';
                driveBtn.addEventListener('click', async () => {
                    showStatusMessage(historyStatus, "Uploading to Google Drive...", "#444");
                    try {
                        const res = await fetch(`${BACKEND_BASE_URL}/drive/upload`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                emailid: loggedInUser,
                                filename: note.filename,
                                title: note.title,
                                filecontent: note.filecontent,
                            }),
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

                actions.appendChild(editBtn);
                actions.appendChild(deleteBtn);
                actions.appendChild(driveBtn);

                footer.appendChild(timeSpan);
                footer.appendChild(actions);

                noteDiv.appendChild(header);
                noteDiv.appendChild(contentP);
                noteDiv.appendChild(footer);
                historyList.appendChild(noteDiv);
            });
        }

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
    });
})();
