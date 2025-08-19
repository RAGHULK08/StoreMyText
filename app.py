import os
import re
import psycopg2
import logging
import json
from psycopg2.extras import DictCursor
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import click
from datetime import datetime

# --- Google OAuth Imports ---
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# --- Basic Logging Configuration ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Environment Variable Check ---
# This will check for required variables on startup and provide clear errors.
required_env_vars = ["DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "REDIRECT_URI"]
for var in required_env_vars:
    if not os.environ.get(var):
        logging.error(f"FATAL ERROR: Environment variable '{var}' is not set.")
        raise RuntimeError(f"FATAL ERROR: Environment variable '{var}' is not set.")

app = Flask(__name__)
CORS(app)

# ------------------ Database Configuration ------------------
DATABASE_URL = os.environ.get("DATABASE_URL")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

def get_db_connection():
    try:
        conn = psycopg2.connect(DATABASE_URL, sslmode='require')
        return conn
    except psycopg2.OperationalError as e:
        logging.error(f"CRITICAL: Could not connect to the database: {e}")
        raise

# Password validation
def is_valid_password(password):
    return bool(re.match(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$", password))

# ------------------ Initialize Database ------------------
def init_db():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                logging.info("Ensuring database tables exist...")
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        id SERIAL PRIMARY KEY,
                        email TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        google_access_token TEXT,
                        google_refresh_token TEXT
                    )
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS notes (
                        id SERIAL PRIMARY KEY,
                        user_id INTEGER NOT NULL,
                        filename TEXT NOT NULL,
                        title TEXT NOT NULL DEFAULT 'Untitled',
                        filecontent TEXT NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW(),
                        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                    )
                """)
                conn.commit()
                logging.info("Database tables are ready.")
    except Exception as e:
        logging.error(f"Error during database initialization: {e}")

@app.cli.command("init-db")
def init_db_command():
    init_db()
    click.echo("Initialized the database.")

# ------------------ Google OAuth 2.0 Setup ------------------
SCOPES = ['https://www.googleapis.com/auth/drive.file']
REDIRECT_URI = os.environ.get("REDIRECT_URI")

def get_google_flow():
    client_secrets_config = {
        "web": {
            "client_id": os.environ.get("GOOGLE_CLIENT_ID"),
            "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET"),
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://accounts.google.com/o/oauth2/token",
            "redirect_uris": [REDIRECT_URI]
        }
    }
    return Flow.from_client_config(client_secrets_config, scopes=SCOPES, redirect_uri=REDIRECT_URI)

# ------------------ API Endpoints ------------------
@app.route("/")
def health_check():
    return "Backend is running."

@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400
    if not is_valid_password(password):
        return jsonify({"error": "Password: 8+ chars, uppercase, lowercase, & symbol."}), 400
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                if cursor.fetchone():
                    return jsonify({"error": "Email already registered."}), 409
                hashed_password = generate_password_hash(password)
                cursor.execute("INSERT INTO users (email, password_hash) VALUES (%s, %s)", (email, hashed_password))
                conn.commit()
                return jsonify({"message": "Registration successful."}), 201
    except Exception as e:
        logging.error(f"DATABASE ERROR during registration: {e}")
        return jsonify({"error": "Server error during registration."}), 500

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not email or not password:
        return jsonify({"error": "Invalid email or password."}), 401
    try:
        with get_db_connection() as conn:
            with conn.cursor(cursor_factory=DictCursor) as cursor:
                cursor.execute("SELECT password_hash, google_refresh_token FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                if not user or not check_password_hash(user["password_hash"], password):
                    return jsonify({"error": "Invalid email or password."}), 401
                
                is_google_connected = bool(user["google_refresh_token"])
                return jsonify({
                    "message": "Login successful.",
                    "is_google_connected": is_google_connected
                }), 200
    except Exception as e:
        logging.error(f"DATABASE ERROR during login: {e}")
        return jsonify({"error": "Server error during login."}), 500

# Other routes (userdata, delete, edit) are unchanged
@app.route("/api/userdata", methods=["POST", "GET"])
def userdata():
    # This function is correct and does not need changes
    try:
        with get_db_connection() as conn:
            with conn.cursor(cursor_factory=DictCursor) as cursor:
                if request.method == "POST":
                    data = request.get_json()
                    email = (data.get("emailid") or "").strip().lower()
                    cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                    user = cursor.fetchone()
                    if not user: return jsonify({"error": "User not found."}), 404
                    cursor.execute(
                        "INSERT INTO notes (user_id, filename, title, filecontent) VALUES (%s, %s, %s, %s)",
                        (user["id"], data.get("filename"), data.get("title", "Untitled").strip(), data.get("filecontent")),
                    )
                    conn.commit()
                    return jsonify({"message": "Note saved successfully."}), 201
                elif request.method == "GET":
                    email = (request.args.get("emailid") or "").strip().lower()
                    cursor.execute(
                        "SELECT filename, title, filecontent, updated_at FROM notes WHERE user_id = (SELECT id FROM users WHERE email = %s) ORDER BY updated_at DESC",
                        (email,),
                    )
                    notes = [dict(row) for row in cursor.fetchall()]
                    return jsonify(notes), 200
    except Exception as e:
        logging.error(f"DATABASE ERROR on /userdata: {e}")
        return jsonify({"error": "A database error occurred."}), 500

@app.route("/api/delete", methods=["DELETE"])
def delete_note():
    # This function is correct and does not need changes
    data = request.get_json()
    email = (data.get("emailid") or "").strip().lower()
    filename = data.get("filename")
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                if not user: return jsonify({"error": "User not found."}), 404
                cursor.execute(
                    "DELETE FROM notes WHERE user_id = %s AND filename = %s",
                    (user[0], filename),
                )
                conn.commit()
                return jsonify({"message": "Note deleted successfully."}), 200
    except Exception as e:
        logging.error(f"DATABASE ERROR during delete: {e}")
        return jsonify({"error": "A database error occurred."}), 500

@app.route("/api/edit", methods=["POST"])
def edit_note():
    # This function is correct and does not need changes
    data = request.get_json()
    email = (data.get("emailid") or "").strip().lower()
    filename = data.get("filename")
    title = data.get("title", "Untitled").strip()
    new_content = data.get("filecontent")
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                if not user: return jsonify({"error": "User not found."}), 404
                cursor.execute(
                    "UPDATE notes SET title = %s, filecontent = %s, updated_at = NOW() WHERE user_id = %s AND filename = %s",
                    (title, new_content, user[0], filename),
                )
                conn.commit()
                return jsonify({"message": "Note updated successfully."}), 200
    except Exception as e:
        logging.error(f"DATABASE ERROR during edit: {e}")
        return jsonify({"error": "A database error occurred."}), 500

@app.route('/api/auth/google/start')
def google_auth_start():
    email = request.args.get('emailid')
    if not email:
        return jsonify({"error": "Email ID is required."}), 400
    flow = get_google_flow()
    authorization_url, state = flow.authorization_url(access_type='offline', prompt='consent', state=email)
    return jsonify({"authorization_url": authorization_url})

@app.route('/api/auth/google/callback')
def google_auth_callback():
    email = request.args.get('state')
    code = request.args.get('code')
    try:
        flow = get_google_flow()
        flow.fetch_token(code=code)
        credentials = flow.credentials
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET google_access_token = %s, google_refresh_token = %s WHERE email = %s",
                    (credentials.token, credentials.refresh_token, email)
                )
                conn.commit()
        return '<script>window.opener.postMessage("google-auth-success", "*"); window.close();</script>'
    except Exception as e:
        logging.error(f"Error in Google auth callback: {e}")
        return "An error occurred during authentication.", 500

if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))

