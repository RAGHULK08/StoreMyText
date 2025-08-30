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
from datetime import datetime, timezone, timedelta
import jwt # Using PyJWT for token generation

# --- Basic Logging Configuration ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://savetext_db_user:1YaL7yXH4rvZqCoC8K53Qy3PAaKod0Jh@dpg-d2f27didbo4c73918te0-a/savetext_db")

app = Flask(__name__)
CORS(app, supports_credentials=True, resources={r"/*": {"origins": "*"}})
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-for-session")
JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "super-secret-jwt-key")


# ------------------ Database Helper ------------------
def get_db_connection():
    """Establishes a connection to the PostgreSQL database."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except psycopg2.OperationalError as e:
        logging.error(f"Database connection error: {e}")
        return None

# ------------------ Authentication Helpers ------------------
def get_user_id_from_request(req):
    """Extracts user ID from JWT token in Authorization header."""
    auth_header = req.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    
    token = auth_header.split(" ")[1]
    try:
        decoded_token = jwt.decode(token, JWT_SECRET_KEY, algorithms=["HS256"])
        return decoded_token.get("user_id")
    except jwt.ExpiredSignatureError:
        logging.warning("Token has expired.")
        return None
    except jwt.InvalidTokenError:
        logging.warning("Invalid token provided.")
        return None

# ------------------ CLI Command for DB Init ------------------
@click.command(name='init-db')
def init_db_command():
    """CLI command to initialize the database tables."""
    conn = get_db_connection()
    if not conn:
        click.echo("Failed to connect to the database.")
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS notes (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    filename TEXT NOT NULL,
                    content TEXT,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                    UNIQUE (user_id, filename)
                );
            """)
        conn.commit()
        click.echo("Database tables initialized successfully.")
    except Exception as e:
        click.echo(f"An error occurred: {e}")
    finally:
        conn.close()

app.cli.add_command(init_db_command)

# ------------------ API Routes ------------------
@app.route("/")
def index():
    return "API is running."

@app.route("/register", methods=["POST"])
def register():
    data = request.get_json()
    email = data.get("email")
    password = data.get("password")

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters long"}), 400

    hashed_password = generate_password_hash(password)
    
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500

    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute(
                "INSERT INTO users (email, password) VALUES (%s, %s) RETURNING id",
                (email, hashed_password),
            )
            user_id = cur.fetchone()["id"]
        conn.commit()
        
        # Create a token for the new user
        token = jwt.encode(
            {"user_id": user_id, "exp": datetime.now(timezone.utc) + timedelta(hours=24)},
            JWT_SECRET_KEY,
            algorithm="HS256"
        )
        return jsonify({"message": "User registered successfully", "token": token}), 201
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
    email = data.get("email")
    password = data.get("password")

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            user = cur.fetchone()
            
            # --- THIS IS THE FIX ---
            # Correctly check the hashed password against the provided password.
            if user and check_password_hash(user["password"], password):
                token = jwt.encode(
                    {"user_id": user["id"], "exp": datetime.now(timezone.utc) + timedelta(hours=24)},
                    JWT_SECRET_KEY,
                    algorithm="HS256"
                )
                return jsonify({"message": "Login successful", "token": token}), 200
            else:
                # This error is now returned only if the email doesn't exist or the password is truly incorrect.
                return jsonify({"error": "Invalid email or password"}), 401
    except Exception as e:
        logging.error(f"Login error: {e}")
        return jsonify({"error": "An internal error occurred"}), 500
    finally:
        if conn:
            conn.close()

@app.route("/save", methods=["POST"])
def save_text():
    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required"}), 401

    data = request.get_json()
    filename = data.get("filename")
    content = data.get("content")

    if not filename:
        return jsonify({"error": "Filename is required"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    
    try:
        with conn.cursor() as cur:
            # Upsert logic: Insert or update on conflict
            cur.execute("""
                INSERT INTO notes (user_id, filename, content, updated_at)
                VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, filename)
                DO UPDATE SET content = EXCLUDED.content, updated_at = CURRENT_TIMESTAMP;
            """, (user_id, filename, content))
        conn.commit()
        return jsonify({"message": "Note saved successfully"}), 200
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
            cur.execute("SELECT filename, content, updated_at FROM notes WHERE user_id = %s ORDER BY updated_at DESC", (user_id,))
            history = [dict(row) for row in cur.fetchall()]
        return jsonify(history), 200
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

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port, debug=True)
