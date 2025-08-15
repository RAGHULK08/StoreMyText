document.addEventListener("DOMContentLoaded", () => {
    // Element selectors
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
    const textInput = document.getElementById("textInput");
    const saveBtn = document.getElementById("saveBtn");
    const historyBtn = document.getElementById("historyBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const status = document.getElementById("status");
    const historyList = document.getElementById("historyList");
    const historyStatus = document.getElementById("historyStatus");
    const backToMain = document.getElementById("backToMain");
    const searchBox = document.getElementById("searchNotes");

    const BACKEND_BASE_URL = "https://savetext-0pk6.onrender.com/api";

    let loggedInUser = null;

    // Initial view: login page
    showView(loginSection);

    function showView(view) {
        [loginSection, registerSection, mainSection, historySection].forEach(
            v => v.classList.remove("active")
        );
        view.classList.add("active");
        showLogout(view === mainSection || view === historySection);
    }

    function showLogout(show) {
        logoutBtn.style.display = show ? "inline-block" : "none";
    }

    function showStatusMessage(element, msg, color) {
        element.textContent = msg;
        element.style.color = color || "#333";
        if (msg) {
            setTimeout(() => {
                element.textContent = "";
            }, 3000);
        }
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function isValidPassword(password) {
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/.test(password);
    }

    // Switch forms
    goToRegister.addEventListener("click", e => {
        e.preventDefault();
        showView(registerSection);
    });
    goToLogin.addEventListener("click", e => {
        e.preventDefault();
        showView(loginSection);
    });

    // Register
    registerForm.addEventListener("submit", async e => {
        e.preventDefault();
        const email = document.getElementById("registerEmail").value.trim().toLowerCase();
        const password = document.getElementById("registerPassword").value.trim();
        const confirmPassword = document.getElementById("registerConfirmPassword").value.trim();

        if (!isValidEmail(email)) return showStatusMessage(registerMsg, "Invalid email format.", "red");
        if (password !== confirmPassword) return showStatusMessage(registerMsg, "Passwords do not match.", "red");
        if (!isValidPassword(password)) {
            return showStatusMessage(registerMsg, "Password: 8+ chars, with uppercase, lowercase, & symbol.", "red");
        }
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            if (res.ok) {
                showStatusMessage(registerMsg, "Registration successful! Please login.", "green");
                setTimeout(() => {
                    showView(loginSection);
                    registerForm.reset();
                    showStatusMessage(registerMsg, "");
                }, 1500);
            } else {
                const data = await res.json();
                showStatusMessage(registerMsg, data.error || "Registration failed.", "red");
            }
        } catch (error) {
            showStatusMessage(registerMsg, "Cannot connect to the server.", "red");
        }
    });

    // Login
    loginForm.addEventListener("submit", async e => {
        e.preventDefault();
        const email = document.getElementById("loginEmail").value.trim().toLowerCase();
        const password = document.getElementById("loginPassword").value.trim();

        try {
            const res = await fetch(`${BACKEND_BASE_URL}/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            if (res.ok) {
                loggedInUser = email;
                showView(mainSection);
                loginForm.reset();
                showStatusMessage(loginMsg, "");
            } else {
                const data = await res.json();
                showStatusMessage(loginMsg, data.error || "Login failed.", "red");
            }
        } catch (error) {
            showStatusMessage(loginMsg, "Cannot connect to the server.", "red");
        }
    });

    // Logout
    logoutBtn.addEventListener("click", () => {
        if (confirm("Are you sure you want to logout?")) {
            loggedInUser = null;
            textInput.value = "";
            historyList.innerHTML = "";
            showView(loginSection);
        }
    });

    // Save note
    saveBtn.addEventListener("click", async () => {
        const text = textInput.value.trim();
        if (!text) return showStatusMessage(status, "Please enter some text to save.", "red");
        if (!loggedInUser) return showStatusMessage(status, "You must be logged in to save.", "red");
        showStatusMessage(status, "Saving...", "#444");
        try {
            const payload = { emailid: loggedInUser, filename: `note_${Date.now()}.txt`, filecontent: text };
            const res = await fetch(`${BACKEND_BASE_URL}/userdata`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                showStatusMessage(status, "Saved to cloud ✅", "green");
                textInput.value = "";
            } else {
                showStatusMessage(status, "Error saving!", "red");
            }
        } catch (e) {
            showStatusMessage(status, "Network error! Could not connect to the server.", "red");
        }
    });

    // Show history -- no password prompt
    historyBtn.addEventListener("click", () => {
        historyList.innerHTML = "";
        showStatusMessage(historyStatus, "");
        fetchHistory();
        showView(historySection);
    });

    backToMain.addEventListener("click", () => showView(mainSection));

    // Fetch notes & render history list, integrated with search
    let allNotes = [];
    async function fetchHistory() {
        if (!loggedInUser) {
            showStatusMessage(historyStatus, "Please login first.", "red");
            return;
        }
        showStatusMessage(historyStatus, "Loading...", "#444");
        historyList.innerHTML = "";
        try {
            const url = new URL(`${BACKEND_BASE_URL}/userdata`);
            url.searchParams.set("emailid", loggedInUser);
            const res = await fetch(url);
            if (!res.ok) throw new Error("Server responded with an error");
            allNotes = await res.json();
            renderHistory(allNotes);
            showStatusMessage(historyStatus, "", "green");
        } catch (err) {
            showStatusMessage(historyStatus, "Failed to fetch history.", "red");
        }
    }

    function renderHistory(notes) {
        historyList.innerHTML = "";
        if (!notes.length) {
            historyList.innerHTML = "No saved notes found.";
            return;
        }
        notes.forEach(note => {
            const noteDiv = document.createElement("div");
            noteDiv.className = "history-item";

            const filenameDiv = document.createElement("strong");
            filenameDiv.textContent = note.filename + ": ";

            const noteContent = document.createElement("span");
            noteContent.textContent = note.filecontent;

            // Edit button
            const editBtn = document.createElement("button");
            editBtn.className = "edit-btn";
            editBtn.textContent = "Edit";
            editBtn.onclick = () => handleEditNote(note.filename, note.filecontent);

            // Delete button
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "delete-btn";
            deleteBtn.textContent = "Delete";
            deleteBtn.onclick = () => handleDeleteNote(note.filename);

            noteDiv.appendChild(filenameDiv);
            noteDiv.appendChild(noteContent);
            noteDiv.appendChild(editBtn);
            noteDiv.appendChild(deleteBtn);

            historyList.appendChild(noteDiv);
        });
    }

    async function handleEditNote(filename, oldContent) {
        const newContent = prompt(
            "Edit your note:", oldContent
        );
        if (newContent === null || newContent === oldContent) return;
        showStatusMessage(historyStatus, "Updating...", "#444");
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/edit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    emailid: loggedInUser,
                    filename: filename,
                    filecontent: newContent
                })
            });
            const data = await res.json();
            if (res.ok) {
                showStatusMessage(historyStatus, "Note updated!", "green");
                fetchHistory();
            } else {
                showStatusMessage(historyStatus, data.error || "Update failed.", "red");
            }
        } catch (e) {
            showStatusMessage(historyStatus, "Cannot connect to the server.", "red");
        }
    }

    async function handleDeleteNote(filename) {
        if (!loggedInUser) {
            showStatusMessage(historyStatus, "You are not logged in.", "red");
            return;
        }
        if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;
        showStatusMessage(historyStatus, "Deleting note...", "#444");
        try {
            const res = await fetch(`${BACKEND_BASE_URL}/delete`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ emailid: loggedInUser, filename })
            });
            const data = await res.json();
            if (res.ok) {
                showStatusMessage(historyStatus, "Note deleted successfully!", "green");
                fetchHistory();
            } else {
                showStatusMessage(historyStatus, data.error || "Failed to delete note.", "red");
            }
        } catch (err) {
            showStatusMessage(historyStatus, "Cannot connect to the server.", "red");
        }
    }

    // Search notes (live filter)
    searchBox?.addEventListener("input", function() {
        const search = this.value.trim().toLowerCase();
        renderHistory(
            allNotes.filter(note =>
                note.filename.toLowerCase().includes(search) ||
                note.filecontent.toLowerCase().includes(search)
            )
        );
    });
});
