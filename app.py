import os
import re
import psycopg2
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import click

# ------------------ Basic Setup ------------------
app = Flask(__name__)
CORS(app)

# ------------------ Database URL Parsing ------------------
DATABASE_URL = os.environ.get('DATABASE_URL')
# Render/Postgres fix: psycopg2 needs postgresql:// not postgres://
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# ------------------ Database Connection ------------------
def get_db_connection():
    """
    Returns a new database connection.
    sslmode='require' ensures Render's cloud Postgres works.
    """
    return psycopg2.connect(DATABASE_URL, sslmode='require')

# ------------------ Password Validation ------------------
def is_valid_password(password):
    """
    Checks if password has:
    - Min 8 chars
    - At least 1 uppercase
    - At least 1 lowercase
    - At least 1 symbol (underscore allowed)
    """
    return bool(re.match(r'^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$', password))

# ------------------ Initialize DB Tables ------------------
def init_db():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        # Check if 'users' table exists
        cursor.execute("SELECT to_regclass('public.users');")
        if cursor.fetchone()[0]:
            print("Database already initialized.")
            cursor.close()
            conn.close()
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
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        """)
        conn.commit()
        print("Database created successfully.")

        cursor.close()
        conn.close()
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
        return jsonify({"error": "Password must be at least 8 chars, include 1 uppercase, 1 lowercase, and 1 symbol (underscore allowed)."}), 400

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE email = %s", (email,))
    if cursor.fetchone():
        cursor.close()
        conn.close()
        return jsonify({"error": "Email already registered"}), 409

    hashed_password = generate_password_hash(password)
    cursor.execute("INSERT INTO users (email, password_hash) VALUES (%s, %s)", (email, hashed_password))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Registration successful"}), 201

# ---------- Login ----------
@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    email = (data.get('email') or "").strip().lower()
    password = data.get('password') or ""

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE email = %s", (email,))
    user = cursor.fetchone()
    cursor.close()
    conn.close()

    if user and check_password_hash(user[2], password):  # password_hash is at index 2
        return jsonify({"message": "Login successful"}), 200
    return jsonify({"error": "Invalid email or password"}), 401

# ---------- User Data (Save / Get Notes) ----------
@app.route('/api/userdata', methods=['POST', 'GET'])
def userdata():
    conn = get_db_connection()
    cursor = conn.cursor()

    if request.method == 'POST':
        data = request.get_json()
        email = (data.get('emailid') or "").strip().lower()
        filename = data.get('filename')
        filecontent = data.get('filecontent')

        cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
        user = cursor.fetchone()

        if not user:
            cursor.close()
            conn.close()
            return jsonify({"error": "User not found"}), 404

        user_id = user[0]
        cursor.execute(
            "INSERT INTO notes (user_id, filename, filecontent) VALUES (%s, %s, %s)",
            (user_id, filename, filecontent)
        )
        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({"message": "Note saved successfully"}), 201

    elif request.method == 'GET':
        email = (request.args.get('emailid') or "").strip().lower()
        cursor.execute("""
            SELECT n.filename, n.filecontent 
            FROM notes n JOIN users u ON n.user_id = u.id 
            WHERE u.email = %s
        """, (email,))
        notes_raw = cursor.fetchall()
        notes = [{"filename": row[0], "filecontent": row[1]} for row in notes_raw]
        cursor.close()
        conn.close()
        return jsonify(notes), 200

# ---------- Delete Note ----------
@app.route('/api/delete', methods=['GET'])
def delete_note():
    email = (request.args.get('emailid') or "").strip().lower()
    filename = request.args.get('filename')

    if not email or not filename:
        return jsonify({"error": "Email and filename are required"}), 400

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
    user = cursor.fetchone()
    if not user:
        cursor.close()
        conn.close()
        return jsonify({"error": "User not found"}), 404

    cursor.execute("DELETE FROM notes WHERE user_id = %s AND filename = %s", (user[0], filename))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"message": "Note deleted"}), 200
