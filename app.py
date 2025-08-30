import os
import re
import psycopg2
import logging
from io import BytesIO
from psycopg2.extras import DictCursor
from flask import Flask, request, jsonify, redirect, session
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import click
from datetime import datetime, timezone

# --- Google OAuth Imports ---
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseUpload
from google.auth.transport.requests import Request as GoogleRequest
from google.auth.exceptions import RefreshError

# --- Basic Logging Configuration ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://savetext_db_user:1YaL7yXH4rvZqCoC8K53Qy3PAaKod0Jh@dpg-d2f27didbo4c73918te0-a/savetext_db")

app = Flask(__name__)
CORS(app, supports_credentials=True)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-for-session")

# ------------------ Database Helper ------------------
def get_db_connection():
    """Establishes and returns a database connection."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except psycopg2.Error as e:
        logging.error(f"Database connection error: {e}")
        return None

# ------------------ Database Initialization ------------------
def init_db():
    """Initializes the database schema."""
    conn = get_db_connection()
    if not conn:
        logging.error("Could not initialize database: No connection.")
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                google_creds_json TEXT
            );
            """)
            cur.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                filecontent TEXT,
                title TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            """)
            # Add updated_at trigger
            cur.execute("""
            CREATE OR REPLACE FUNCTION trigger_set_timestamp()
            RETURNS TRIGGER AS $$
            BEGIN
              NEW.updated_at = NOW();
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            """)
            cur.execute("""
            DROP TRIGGER IF EXISTS set_timestamp ON notes;
            CREATE TRIGGER set_timestamp
            BEFORE UPDATE ON notes
            FOR EACH ROW
            EXECUTE PROCEDURE trigger_set_timestamp();
            """)
        conn.commit()
        logging.info("Database initialized successfully.")
    except psycopg2.Error as e:
        logging.error(f"Error initializing database: {e}")
    finally:
        if conn:
            conn.close()

@app.cli.command("init-db")
def init_db_command():
    """CLI command to initialize the database."""
    init_db()
    click.echo("Initialized the database.")

# ------------------ User Authentication Routes ------------------
@app.route("/register", methods=["POST"])
def register():
    data = request.get_json()
    email = data.get("email", "").strip()
    password = data.get("password")
    if password is not None:
        password = password.strip()

    if not email or not password or not re.match(r"[^@]+@[^@]+\.[^@]+", email):
        return jsonify({"error": "Invalid email or password"}), 400

    hashed_password = generate_password_hash(password)
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500

    try:
        with conn.cursor() as cur:
            # FIX: Use password_hash column
            cur.execute("INSERT INTO users (email, password_hash) VALUES (%s, %s)", (email, hashed_password))
        conn.commit()
        return jsonify({"message": "User registered successfully"}), 201
    except psycopg2.IntegrityError:
        return jsonify({"error": "Email already registered"}), 409
    except Exception as e:
        logging.error(f"Registration error: {e}")
        return jsonify({"error": "An internal error occurred"}), 500
    finally:
        if conn:
            conn.close()

@app.route("/login", methods=["POST"])
def login():
    data = request.get_json()
    email = data.get("email", "").strip()
    password = data.get("password")
    if password is not None:
        password = password.strip()

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500

    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            # FIX: Use password_hash column
            cur.execute("SELECT id, password_hash FROM users WHERE email = %s", (email,))
            user = cur.fetchone()

        if user and user["password_hash"]:
            valid = check_password_hash(user["password_hash"], password)
            logging.info(f"Password check for {email}: {valid}")
            if valid:
                return jsonify({"token": user["id"], "message": "Login successful"}), 200
        return jsonify({"error": "Invalid email or password"}), 401
    except Exception as e:
        logging.error(f"Login error: {e}")
        return jsonify({"error": "An internal error occurred"}), 500
    finally:
        if conn:
            conn.close()

# ------------------ Note Management Routes ------------------
def get_user_id_from_request(request):
    auth_header = request.headers.get("Authorization")
    if isinstance(auth_header, str) and auth_header.startswith("Bearer "):
        return auth_header.split(" ")[1]
    return None

@app.route("/save", methods=["POST"])
def save_text():
    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required"}), 401

    data = request.get_json()
    filename = data.get("filename")
    content = data.get("content")
    title = data.get("title")

    if not title:
        return jsonify({"error": "Title is required"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500

    try:
        with conn.cursor() as cur:
            if filename: # Update existing note
                cur.execute(
                    "UPDATE notes SET filecontent = %s, title = %s WHERE filename = %s AND user_id = %s",
                    (content, title, filename, user_id)
                )
                message = "Note updated successfully"
            else: # Create new note
                new_filename = f"note_{int(datetime.now(timezone.utc).timestamp())}_{user_id}.txt"
                cur.execute(
                    "INSERT INTO notes (user_id, filename, filecontent, title) VALUES (%s, %s, %s, %s)",
                    (user_id, new_filename, content, title)
                )
                filename = new_filename
                message = "Note saved successfully"
        conn.commit()
        return jsonify({"message": message, "filename": filename}), 200
    except Exception as e:
        logging.error(f"Save note error: {e}")
        return jsonify({"error": "Failed to save note"}), 500
    finally:
        if conn:
            conn.close()

@app.route("/history", methods=["GET"])
def get_history():
    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required"}), 401
    
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute(
                "SELECT filename, filecontent, title, updated_at FROM notes WHERE user_id = %s ORDER BY updated_at DESC",
                (user_id,)
            )
            notes = [dict(row) for row in cur.fetchall()]
        return jsonify(notes), 200
    except Exception as e:
        logging.error(f"Get history error: {e}")
        return jsonify({"error": "Failed to retrieve history"}), 500
    finally:
        if conn:
            conn.close()

@app.route("/delete", methods=["POST"])
def delete_text():
    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required"}), 401
    
    data = request.get_json()
    filenames = data.get("filenames")
    if not filenames or not isinstance(filenames, list):
        return jsonify({"error": "Invalid request, filenames must be a list"}), 400
    
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    
    try:
        with conn.cursor() as cur:
            # Using tuple for IN clause
            cur.execute("DELETE FROM notes WHERE user_id = %s AND filename IN %s", (user_id, tuple(filenames)))
        conn.commit()
        return jsonify({"message": f"{len(filenames)} note(s) deleted successfully"}), 200
    except Exception as e:
        logging.error(f"Delete note error: {e}")
        return jsonify({"error": "Failed to delete note(s)"}), 500
    finally:
        if conn:
            conn.close()

# ------------------ App Initialization ------------------
if __name__ == "__main__":
    with app.app_context():
        init_db()
    port = int(os.environ.get("PORT", 5001))
    app.run(debug=False, host='0.0.0.0', port=port)
    port = int(os.environ.get("PORT", 5001))
    app.run(debug=False, host='0.0.0.0', port=port)
