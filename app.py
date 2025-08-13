import os
import re
import psycopg2
from psycopg2.extras import DictCursor # Import DictCursor
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import click

# ------------------ Basic Setup ------------------
app = Flask(__name__)
CORS(app)

# ------------------ Database URL Configuration ------------------
DATABASE_URL = os.environ.get('DATABASE_URL')

# A crucial check to ensure the app doesn't start without a database URL
if not DATABASE_URL:
    raise RuntimeError("FATAL: DATABASE_URL environment variable is not set.")

# Render/Postgres fix: psycopg2 needs postgresql:// not postgres://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# ------------------ Database Connection ------------------
def get_db_connection():
    """Returns a new database connection."""
    return psycopg2.connect(DATABASE_URL, sslmode='require')

# ------------------ Password Validation ------------------
def is_valid_password(password):
    """Checks if password has min 8 chars, 1 uppercase, 1 lowercase, & 1 symbol."""
    return bool(re.match(r'^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$', password))

# ------------------ Initialize DB Tables ------------------
def init_db():
    """Initializes the database tables if they don't exist."""
    try:
        # Using 'with' statement ensures the connection is always closed
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT to_regclass('public.users');")
                if cursor.fetchone()[0]:
                    print("Database already initialized.")
                    return

                print("Creating database tables...")
                cursor.execute("""
                    CREATE TABLE users (
                        id SERIAL PRIMARY KEY,
                        email TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL
                    )
                """)
                cursor.execute("""
                    CREATE TABLE notes (
                        id SERIAL PRIMARY KEY,
                        user_id INTEGER NOT NULL,
                        filename TEXT NOT NULL,
                        filecontent TEXT NOT NULL,
                        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                    )
                """)
                conn.commit()
                print("Database created successfully.")
    except (Exception, psycopg2.Error) as error:
        print("Error while initializing PostgreSQL table:", error)

# CLI command to manually initialize DB: `flask --app app.py init-db`
@app.cli.command("init-db")
def init_db_command():
    """Creates the database tables."""
    init_db()
    click.echo("Initialized the database.")

# ------------------ API Endpoints ------------------

@app.route('/')
def health_check():
    return "Backend is running!"

# ---------- Register ----------
@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()
    email = (data.get('email') or "").strip().lower()
    password = data.get('password') or ""

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400
    if not is_valid_password(password):
        return jsonify({"error": "Password: 8+ chars, with uppercase, lowercase, & symbol."}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                if cursor.fetchone():
                    return jsonify({"error": "Email already registered"}), 409

                hashed_password = generate_password_hash(password)
                cursor.execute("INSERT INTO users (email, password_hash) VALUES (%s, %s)", (email, hashed_password))
                conn.commit()
        return jsonify({"message": "Registration successful"}), 201
    except psycopg2.Error as e:
        print("Database error:", e)
        return jsonify({"error": "A database error occurred."}), 500

# ---------- Login ----------
@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    email = (data.get('email') or "").strip().lower()
    password = data.get('password') or ""

    if not email or not password:
        return jsonify({"error": "Invalid email or password"}), 401

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT password_hash FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
        
        if user and check_password_hash(user[0], password):
            return jsonify({"message": "Login successful"}), 200
        
        return jsonify({"error": "Invalid email or password"}), 401
    except psycopg2.Error as e:
        print("Database error:", e)
        return jsonify({"error": "A database error occurred."}), 500

# ---------- User Data (Save / Get Notes) ----------
@app.route('/api/userdata', methods=['POST', 'GET'])
def userdata():
    try:
        with get_db_connection() as conn:
            # Using DictCursor to get dictionary-like results
            with conn.cursor(cursor_factory=DictCursor) as cursor:
                if request.method == 'POST':
                    data = request.get_json()
                    email = (data.get('emailid') or "").strip().lower()
                    filename = data.get('filename')
                    filecontent = data.get('filecontent')

                    cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                    user = cursor.fetchone()
                    if not user:
                        return jsonify({"error": "User not found"}), 404

                    cursor.execute(
                        "INSERT INTO notes (user_id, filename, filecontent) VALUES (%s, %s, %s)",
                        (user['id'], filename, filecontent)
                    )
                    conn.commit()
                    return jsonify({"message": "Note saved successfully"}), 201

                elif request.method == 'GET':
                    email = (request.args.get('emailid') or "").strip().lower()
                    cursor.execute("""
                        SELECT n.filename, n.filecontent 
                        FROM notes n JOIN users u ON n.user_id = u.id 
                        WHERE u.email = %s
                    """, (email,))
                    notes = cursor.fetchall() # Fetches a list of dictionary-like rows
                    return jsonify(notes), 200
    except psycopg2.Error as e:
        print("Database error:", e)
        return jsonify({"error": "A database error occurred."}), 500

# ---------- Delete Note ----------
@app.route('/api/delete', methods=['DELETE']) # CORRECTED: Changed method to DELETE
def delete_note():
    data = request.get_json()
    email = (data.get('emailid') or "").strip().lower()
    filename = data.get('filename')

    if not email or not filename:
        return jsonify({"error": "Email and filename are required"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
                user = cursor.fetchone()
                if not user:
                    return jsonify({"error": "User not found"}), 404

                cursor.execute("DELETE FROM notes WHERE user_id = %s AND filename = %s", (user[0], filename))
                conn.commit()
        return jsonify({"message": "Note deleted"}), 200
    except psycopg2.Error as e:
        print("Database error:", e)
        return jsonify({"error": "A database error occurred."}), 500
