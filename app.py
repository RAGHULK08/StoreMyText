import os
import re
import psycopg2
import logging
from psycopg2.extras import DictCursor
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import click
from datetime import datetime

# --- Basic Logging Configuration ---
# This will print informative messages to your Render logs
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
                logging.info("Dropping existing tables for a clean setup...")
                cursor.execute("DROP TABLE IF EXISTS notes;")
                cursor.execute("DROP TABLE IF EXISTS users;")
                
                logging.info("Creating database tables...")
                cursor.execute("""
                    CREATE TABLE users (
                        id SERIAL PRIMARY KEY,
                        email TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW()
                    )
                """)
                cursor.execute("""
                    CREATE TABLE notes (
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
                logging.info("Database tables created successfully.")
    except Exception as e:
        logging.error(f"Error while initializing database: {e}")

@app.cli.command("init-db")
def init_db_command():
    """Initializes the database by creating tables."""
    init_db()
    click.echo("Initialized the database.")

# ------------------ API Endpoints ------------------
@app.route("/")
def health_check():
    logging.info("Health check endpoint was hit.")
    return "Backend is running."

@app.route("/api/register", methods=["POST"])
def register():
    logging.info("Received request to /api/register")
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
                logging.info(f"Successfully registered user: {email}")
                return jsonify({"message": "Registration successful."}), 201
    except Exception as e:
        logging.error(f"DATABASE ERROR during registration for {email}: {e}")
        return jsonify({"error": "A database error occurred during registration."}), 500

@app.route("/api/login", methods=["POST"])
def login():
    logging.info("Received request to /api/login")
    data = request.get_json()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not email or not password:
        return jsonify({"error": "Invalid email or password."}), 401
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT password_hash FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                if user and check_password_hash(user[0], password):
                    logging.info(f"Successful login for user: {email}")
                    return jsonify({"message": "Login successful."}), 200
                logging.warning(f"Failed login attempt for user: {email}")
                return jsonify({"error": "Invalid email or password."}), 401
    except Exception as e:
        logging.error(f"DATABASE ERROR during login for {email}: {e}")
        return jsonify({"error": "A database error occurred during login."}), 500

@app.route("/api/userdata", methods=["POST", "GET"])
def userdata():
    logging.info(f"Received request to /api/userdata with method: {request.method}")
    try:
        with get_db_connection() as conn:
            with conn.cursor(cursor_factory=DictCursor) as cursor:
                if request.method == "POST":
                    data = request.get_json()
                    email = (data.get("emailid") or "").strip().lower()
                    filename = data.get("filename")
                    title = data.get("title", "Untitled").strip()
                    filecontent = data.get("filecontent")
                    logging.info(f"Saving note for user: {email}")
                    cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                    user = cursor.fetchone()
                    if not user: return jsonify({"error": "User not found."}), 404
                    
                    cursor.execute(
                        "INSERT INTO notes (user_id, filename, title, filecontent) VALUES (%s, %s, %s, %s)",
                        (user["id"], filename, title, filecontent),
                    )
                    conn.commit()
                    return jsonify({"message": "Note saved successfully."}), 201

                elif request.method == "GET":
                    email = (request.args.get("emailid") or "").strip().lower()
                    logging.info(f"Fetching notes for user: {email}")
                    cursor.execute(
                        """
                        SELECT filename, title, filecontent, updated_at 
                        FROM notes 
                        WHERE user_id = (SELECT id FROM users WHERE email = %s)
                        ORDER BY updated_at DESC
                        """,
                        (email,),
                    )
                    notes = [dict(row) for row in cursor.fetchall()]
                    return jsonify(notes), 200
    except psycopg2.Error as db_err:
        logging.error(f"DATABASE SPECIFIC ERROR on /userdata: {db_err}")
        return jsonify({"error": "A database query failed."}), 500
    except Exception as e:
        logging.error(f"GENERAL ERROR on /userdata: {e}")
        return jsonify({"error": "An unexpected server error occurred."}), 500

@app.route("/api/delete", methods=["DELETE"])
def delete_note():
    logging.info("Received request to /api/delete")
    data = request.get_json()
    email = (data.get("emailid") or "").strip().lower()
    filename = data.get("filename")
    if not email or not filename:
        return jsonify({"error": "Email and filename are required."}), 400
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
                if cursor.rowcount == 0:
                    return jsonify({"error": "Note not found or already deleted."}), 404
                logging.info(f"Note '{filename}' deleted for user {email}")
                return jsonify({"message": "Note deleted successfully."}), 200
    except Exception as e:
        logging.error(f"DATABASE ERROR during delete: {e}")
        return jsonify({"error": "A database error occurred."}), 500

@app.route("/api/edit", methods=["POST"])
def edit_note():
    logging.info("Received request to /api/edit")
    data = request.get_json()
    email = (data.get("emailid") or "").strip().lower()
    filename = data.get("filename")
    title = data.get("title", "Untitled").strip()
    new_content = data.get("filecontent")
    
    if not email or not filename or new_content is None:
        return jsonify({"error": "All fields are required."}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                if not user: return jsonify({"error": "User not found."}), 404
                
                cursor.execute(
                    """
                    UPDATE notes 
                    SET title = %s, filecontent = %s, updated_at = NOW() 
                    WHERE user_id = %s AND filename = %s
                    """,
                    (title, new_content, user[0], filename),
                )
                conn.commit()
                if cursor.rowcount == 0:
                    return jsonify({"error": "Note not found."}), 404
                logging.info(f"Note '{filename}' updated for user {email}")
                return jsonify({"message": "Note updated successfully."}), 200
    except Exception as e:
        logging.error(f"DATABASE ERROR during edit: {e}")
        return jsonify({"error": "A database error occurred."}), 500

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
