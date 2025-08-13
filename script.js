document.addEventListener("DOMContentLoaded", () => {
    // --- DOM Element Selection (no changes here) ---
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
    const historyForm = document.getElementById("historyForm");
    const historyPassword = document.getElementById("historyPassword");
    const historyList = document.getElementById("historyList");
    const historyStatus = document.getElementById("historyStatus");
    const backToMain = document.getElementById("backToMain");

    // --- State Management & Configuration ---
    const BACKEND_BASE_URL = "https://savetext-0pk6.onrender.com/api"; // Updated URL for our Flask server
    let loggedInUser = null;
    let loggedInPassword = null; // Storing password for history check

    // --- Initial View ---
    showView(registerSection);

    // --- Core Functions (no changes here) ---
    function showView(view) {
        [loginSection, registerSection, mainSection, historySection].forEach(v => v.classList.remove("active"));
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
            setTimeout(() => { element.textContent = ""; }, 3000);
        }
    }
    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
    function isValidPassword(password) {
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/.test(password);
    }

    // --- Event Listeners (UPDATED LOGIC) ---
    goToRegister.addEventListener("click", e => { e.preventDefault(); showView(registerSection); });
    goToLogin.addEventListener("click", e => { e.preventDefault(); showView(loginSection); });

    // UPDATED REGISTER
    registerForm.addEventListener("submit", async (e) => {
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
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
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

    // UPDATED LOGIN
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("loginEmail").value.trim().toLowerCase();
        const password = document.getElementById("loginPassword").value.trim();

        try {
            const res = await fetch(`${BACKEND_BASE_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            if (res.ok) {
                loggedInUser = email;
                loggedInPassword = password; // For history verification
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

    // Enhanced Logout with Confirmation
    logoutBtn.addEventListener("click", () => {
        if (confirm("Are you sure you want to logout?")) {
            loggedInUser = null;
            loggedInPassword = null;
            textInput.value = "";
            historyList.innerHTML = "";
            showView(loginSection);
        }
    });

    // Save Text (No change needed here)
    saveBtn.addEventListener("click", async () => {
        const text = textInput.value.trim();
        if (!text) return showStatusMessage(status, "Please enter some text to save.", "red");
        if (!loggedInUser) return showStatusMessage(status, "You must be logged in to save.", "red");

        showStatusMessage(status, "Saving...", "#444");
        try {
            const payload = { emailid: loggedInUser, filename: `note_${Date.now()}.txt`, filecontent: text };
            const res = await fetch(`${BACKEND_BASE_URL}/userdata`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
            });
            if (res.ok) {
                showStatusMessage(status, "Saved to cloud ✅", "green");
                textInput.value = "";
            } else {
                showStatusMessage(status, `Error: ${res.statusText}`, "red");
            }
        } catch {
            showStatusMessage(status, "Network error! Could not connect to the server.", "red");
        }
    });

    // History View
    historyBtn.addEventListener("click", () => {
        historyList.innerHTML = "";
        historyPassword.value = "";
        showStatusMessage(historyStatus, "");
        showView(historySection);
    });

    backToMain.addEventListener("click", () => showView(mainSection));

    // UPDATED History Form Submission
    historyForm.addEventListener("submit", async e => {
        e.preventDefault();
        const pw = historyPassword.value;

        if (!loggedInUser) return showStatusMessage(historyStatus, "Please login first.", "red");
        if (!pw) return showStatusMessage(historyStatus, "Enter your password to view history.", "red");

        // Verify password against the one stored during login
        if (pw !== loggedInPassword) {
            return showStatusMessage(historyStatus, "Incorrect password.", "red");
        }

        showStatusMessage(historyStatus, "Loading...", "#444");
        try {
            const url = new URL(`${BACKEND_BASE_URL}/userdata`);
            url.searchParams.set("emailid", loggedInUser);

            const res = await fetch(url);
            if (!res.ok) throw new Error('Server responded with an error');

            const data = await res.json();
            historyList.innerHTML = data.length
                ? data.map(n => `<div><strong>${n.filename}</strong><br>${n.filecontent.replace(/\n/g, '<br>')}</div>`).join("")
                : "No saved notes found.";
            showStatusMessage(historyStatus, "History loaded successfully.", "green");
        } catch (error) {
            showStatusMessage(historyStatus, "Failed to fetch history.", "red");
        }
    });

});

