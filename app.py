import os
import psycopg2 # Changed from sqlite3
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from urllib.parse import urlparse

# --- Basic Setup ---
app = Flask(__name__)
CORS(app)

# --- Database Connection and Initialization ---
# Render will provide the DATABASE_URL environment variable
DATABASE_URL = os.environ.get('DATABASE_URL')

def get_db_connection():
    conn = psycopg2.connect(DATABASE_URL)
    return conn

def init_db():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if users table exists
        cursor.execute("SELECT to_regclass('public.users');")
        if cursor.fetchone()[0]:
            print("Database already initialized.")
            conn.close()
            return
            
        print("Creating database tables...")
        # Create users table with SERIAL for auto-increment
        cursor.execute('''
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL
            )
        ''')
        # Create notes table
        cursor.execute('''
            CREATE TABLE notes (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                filecontent TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        
        conn.commit()
        cursor.close()
        conn.close()
        print("Database created successfully.")
    except (Exception, psycopg2.Error) as error:
        print("Error while initializing PostgreSQL table", error)

# Initialize the DB when the app starts if tables don't exist
init_db()

# --- API Endpoints (with updated DB connection logic) ---

@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()
    email = data.get('email')
    password = data.get('password')

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

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    email = data.get('email')
    password = data.get('password')

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE email = %s", (email,))
    user = cursor.fetchone() # Fetch as a tuple
    cursor.close()
    conn.close()

    if user and check_password_hash(user[2], password): # password_hash is at index 2
        return jsonify({"message": "Login successful"}), 200
    
    return jsonify({"error": "Invalid email or password"}), 401

@app.route('/api/userdata', methods=['POST', 'GET'])
def userdata():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    if request.method == 'POST':
        data = request.get_json()
        email = data.get('emailid')
        cursor.execute("SELECT id FROM users WHERE email = %s", (email,))
        user = cursor.fetchone()
        
        if not user:
            cursor.close()
            conn.close()
            return jsonify({"error": "User not found"}), 404

        user_id = user[0]
        cursor.execute("INSERT INTO notes (user_id, filename, filecontent) VALUES (%s, %s, %s)", 
                       (user_id, data.get('filename'), data.get('filecontent')))
        conn.commit()
        message = {"message": "Note saved successfully"}
        status_code = 201
    
    elif request.method == 'GET':
        email = request.args.get('emailid')
        cursor.execute("""
            SELECT n.filename, n.filecontent 
            FROM notes n JOIN users u ON n.user_id = u.id 
            WHERE u.email = %s
        """, (email,))
        
        # Fetch results and convert to list of dicts
        notes_raw = cursor.fetchall()
        column_names = [desc[0] for desc in cursor.description]
        notes = [dict(zip(column_names, row)) for row in notes_raw]
        
        message = jsonify(notes)
        status_code = 200
    
    cursor.close()
    conn.close()
    return message, status_code


# The main execution part is no longer needed for Render
# if __name__ == '__main__':
#     app.run(port=8081, debug=True)