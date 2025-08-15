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

app = Flask(__name__)
CORS(app)

# ------------------ Database Configuration ------------------
DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("FATAL: DATABASE_URL environment variable is not set.")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

def get_db_connection():
    try:
        conn = psycopg2.connect(DATABASE_URL, sslmode='require')
        return conn
    except psycopg2.OperationalError as e:
        logging.error(f"Could not connect to the database: {e}")
        raise

# Password validation
def is_valid_password(password):
    return bool(re.match(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$", password))

# ------------------ Initialize Database ------------------
def init_db():
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                logging.info("Creating users table if it doesn't exist...")
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
                logging.info("Creating notes table if it doesn't exist...")
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
                logging.info("Database tables ensured.")
    except Exception as e:
        logging.error(f"Error while initializing database: {e}")

@app.cli.command("init-db")
def init_db_command():
    init_db()
    click.echo("Initialized the database.")

# ------------------ Google OAuth 2.0 Setup ------------------
SCOPES = ['https://www.googleapis.com/auth/drive.file']
REDIRECT_URI = os.environ.get("REDIRECT_URI") # e.g., https://yourapp.onrender.com/api/auth/google/callback

def get_google_flow():
    """Initializes the Google OAuth 2.0 flow."""
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
    # ... (code is the same as before, no changes needed)
    pass # Placeholder for existing code

@app.route("/api/login", methods=["POST"])
def login():
    # ... (code is the same as before, no changes needed)
    pass # Placeholder for existing code

@app.route("/api/userdata", methods=["POST", "GET"])
def userdata():
    # ... (code is the same as before, no changes needed)
    pass # Placeholder for existing code

@app.route("/api/delete", methods=["DELETE"])
def delete_note():
    # ... (code is the same as before, no changes needed)
    pass # Placeholder for existing code

@app.route("/api/edit", methods=["POST"])
def edit_note():
    # ... (code is the same as before, no changes needed)
    pass # Placeholder for existing code

# --- NEW: Google Authentication Routes ---
@app.route('/api/auth/google/start')
def google_auth_start():
    email = request.args.get('emailid')
    if not email:
        return jsonify({"error": "Email ID is required to start auth flow."}), 400
    
    flow = get_google_flow()
    authorization_url, state = flow.authorization_url(access_type='offline', prompt='consent', state=email)
    
    logging.info(f"Redirecting user {email} to Google for auth.")
    return jsonify({"authorization_url": authorization_url})

@app.route('/api/auth/google/callback')
def google_auth_callback():
    email = request.args.get('state')
    code = request.args.get('code')

    if not email or not code:
        return "Error: Missing state or code from Google.", 400

    try:
        flow = get_google_flow()
        flow.fetch_token(code=code)
        
        credentials = flow.credentials
        access_token = credentials.token
        refresh_token = credentials.refresh_token

        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET google_access_token = %s, google_refresh_token = %s WHERE email = %s",
                    (access_token, refresh_token, email)
                )
                conn.commit()
                logging.info(f"Successfully stored Google tokens for user {email}")
        
        # This script closes the popup and notifies the main window of success
        return '<script>window.opener.postMessage("google-auth-success", "*"); window.close();</script>'

    except Exception as e:
        logging.error(f"Error in Google auth callback: {e}")
        return "An error occurred during authentication.", 500

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
