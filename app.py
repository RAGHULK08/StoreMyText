import os
import re
import json
import hmac
import time
import base64
import hashlib
import logging
import psycopg2
from io import BytesIO
from psycopg2.extras import DictCursor
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import click
from datetime import datetime, timezone, timedelta
import jwt

# Google OAuth libs
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.auth.transport.requests import Request as GoogleRequest
from google.auth.exceptions import RefreshError

# ---- logging ----
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# ---- env / config ----
DATABASE_URL = os.environ.get("DATABASE_URL", "") 
BACKEND_URL = os.environ.get("BACKEND_URL", "")    
FRONTEND_URL = os.environ.get("FRONTEND_URL", "")  
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "default_flask_secret")
JWT_SECRET = os.environ.get("JWT_SECRET", "default_jwt_secret")

# ---- App Initialization ----
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": [FRONTEND_URL] if FRONTEND_URL else "*"}})

# ---- DB connection ----
def get_db_connection():
    conn = psycopg2.connect(DATABASE_URL)
    return conn

# ---- Google Drive / OAuth Helpers ----

def get_absolute_redirect_uri(path="/auth/google/callback"):
    if BACKEND_URL:
        base_url = BACKEND_URL
    else:
        base_url = request.url_root.replace("http://", "https://")

    # Cleanly join the base_url and the path
    if base_url.endswith('/') and path.startswith('/'):
        return base_url[:-1] + path
    if not base_url.endswith('/') and not path.startswith('/'):
        return base_url + '/' + path
    return base_url + path


def creds_to_json(creds):
    """Serialize credentials to a JSON string."""
    return json.dumps({
        'token': creds.token,
        'refresh_token': creds.refresh_token,
        'token_uri': creds.token_uri,
        'client_id': creds.client_id,
        'client_secret': creds.client_secret,
        'scopes': creds.scopes
    })

def get_drive_service_from_creds_json(creds_json):
    """Builds a Google Drive service object from stored JSON credentials."""
    creds = Credentials.from_authorized_user_info(json.loads(creds_json))
    refreshed_creds = None
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(GoogleRequest())
            refreshed_creds = creds
        except RefreshError as e:
            logging.error(f"Google credentials refresh error: {e}")
            return None, None # cant refresh, so old creds are invalid
    return build('drive', 'v3', credentials=creds), refreshed_creds

def get_folder_id(service, folder_name="TextGrab"):
    """Finds or creates a folder in Google Drive."""
    q = f"name='{folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    response = service.files().list(q=q, spaces='drive', fields='files(id, name)').execute()
    if not response.get('files'):
        file_metadata = {'name': folder_name, 'mimeType': 'application/vnd.google-apps.folder'}
        folder = service.files().create(body=file_metadata, fields='id').execute()
        return folder.get('id')
    return response.get('files')[0].get('id')

def upsert_drive_file(service, folder_id, title, content, file_id=None):
    """Creates or updates a file in Google Drive."""
    file_metadata = {'name': f"{title}.txt", 'parents': [folder_id]}
    media = MediaIoBaseUpload(BytesIO(content.encode()), mimetype='text/plain', resumable=True)
    if file_id:
        file = service.files().update(fileId=file_id, body=file_metadata, media_body=media, fields='id').execute()
    else:
        file_metadata['mimeType'] = 'text/plain'
        file = service.files().create(body=file_metadata, media_body=media, fields='id').execute()
    return file.get('id')

def delete_drive_file(service, file_id):
    """Permanently deletes a file from Google Drive."""
    try:
        service.files().delete(fileId=file_id).execute()
        return True
    except Exception as e:
        logging.error(f"Failed to delete Drive file {file_id}: {e}")
        return False


# ---- JWT Auth Helpers ----
def create_jwt_token(user_id):
    payload = {
        'iat': datetime.now(timezone.utc),
        'exp': datetime.now(timezone.utc) + timedelta(days=7),
        'sub': user_id
    }
    return jwt.encode(payload, JWT_SECRET, algorithm='HS256')

def get_user_from_token(request):
    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '): return None
    token = auth_header.split(' ')[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
        return payload['sub']
    except jwt.ExpiredSignatureError:
        return 'expired'
    except jwt.InvalidTokenError:
        return None
    return None

# ---- Password Helpers (for local auth)----
def hash_password(password):
    return generate_password_hash(password)

def check_password(hashed_password, password):
    return check_password_hash(hashed_password, password)

def is_valid_email(email):
    return re.match(r"[^@]+@[^@]+\.[^@]+", email)

# ---- Routes ----

# ---------------- Auth endpoints ----------------
@app.route('/register', methods=['POST'])
def register():
    data = request.get_json()
    email = data.get('email')
    password = data.get('password')

    if not email or not password or not is_valid_email(email) or len(password) < 6:
        return jsonify({'error': 'Invalid email or password (must be at least 6 characters)'}), 400

    hashed_pw = hash_password(password)
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE email = %s", (email,))
            if cur.fetchone():
                return jsonify({'error': 'User already exists'}), 409
            cur.execute(
                "INSERT INTO users (email, password_hash, created_at) VALUES (%s, %s, NOW()) RETURNING id",
                (email, hashed_pw)
            )
            user_id = cur.fetchone()[0]
            conn.commit()
            token = create_jwt_token(user_id)
            return jsonify({'token': token}), 201
    except Exception as e:
        logging.error(f"Registration error: {e}")
        conn.rollback()
        return jsonify({'error': 'Registration failed'}), 500
    finally:
        conn.close()


@app.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    email = data.get('email')
    password = data.get('password')

    if not email or not password:
        return jsonify({'error': 'Email and password are required'}), 400

    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT id, password_hash FROM users WHERE email = %s", (email,))
            user = cur.fetchone()
            if user and check_password(user['password_hash'], password):
                token = create_jwt_token(user['id'])
                return jsonify({'token': token}), 200
            else:
                return jsonify({'error': 'Invalid credentials'}), 401
    except Exception as e:
        logging.error(f"Login error: {e}")
        return jsonify({'error': 'Login failed'}), 500
    finally:
        conn.close()

# ---------------- Google OAuth endpoints ----------------
@app.route("/auth/google")
def auth_google():
    """Starts the Google OAuth flow."""
    client_config = {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    flow = Flow.from_client_config(
        client_config,
        scopes=[
            "https://www.googleapis.com/auth/userinfo.profile",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/drive.file",
            "openid"
        ],
    )
    flow.redirect_uri = get_absolute_redirect_uri()
    authorization_url, state = flow.authorization_url(access_type='offline', prompt='consent')
    return jsonify({"auth_url": authorization_url})


@app.route("/auth/google/callback")
def oauth2callback():
    """Handles the callback from Google after user authorization."""
    try:
        client_config = {
            "web": {
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        }
        flow = Flow.from_client_config(
            client_config,
            scopes=None, # Scopes are not needed for token exchange
        )
        flow.redirect_uri = get_absolute_redirect_uri()
        flow.fetch_token(authorization_response=request.url)
        creds = flow.credentials
        
        # Get user profile
        user_info_service = build('oauth2', 'v2', credentials=creds)
        user_info = user_info_service.userinfo().get().execute()
        
        email = user_info.get('email')
        if not email:
            return redirect(f"{FRONTEND_URL}?error=email_not_found")

        # Upsert user in DB
        conn = get_db_connection()
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT id FROM users WHERE email = %s", (email,))
            user = cur.fetchone()
            if user:
                user_id = user['id']
                # Update credentials for existing user
                cur.execute("UPDATE users SET google_creds_json = %s, updated_at = NOW() WHERE id = %s", (creds_to_json(creds), user_id))
            else:
                # Create a new user
                cur.execute(
                    "INSERT INTO users (email, google_creds_json, created_at) VALUES (%s, %s, NOW()) RETURNING id",
                    (email, creds_to_json(creds))
                )
                user_id = cur.fetchone()['id']
            conn.commit()

        # Generate JWT and redirect
        app_token = create_jwt_token(user_id)
        return redirect(f"{FRONTEND_URL}?token={app_token}&drive_linked=true")

    except Exception as e:
        logging.error(f"OAuth callback error: {e}")
        return redirect(f"{FRONTEND_URL}?error=oauth_failed")
    finally:
        if 'conn' in locals() and conn:
            conn.close()

# ---------------- User Profile endpoint ----------------
@app.route('/profile', methods=['GET'])
def get_profile():
    user_id = get_user_from_token(request)
    if not user_id or user_id == 'expired':
        return jsonify({"error": "Unauthorized"}), 401

    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT email, google_creds_json IS NOT NULL as drive_linked FROM users WHERE id = %s", (user_id,))
            user_profile = cur.fetchone()
            if not user_profile:
                return jsonify({"error": "User not found"}), 404
            return jsonify(dict(user_profile)), 200
    except Exception as e:
        logging.error(f"Get profile error: {e}")
        return jsonify({"error": "Failed to fetch profile"}), 500
    finally:
        conn.close()

# ---------------- Notes endpoints ----------------
@app.route('/save', methods=['POST'])
def save_text():
    user_id = get_user_from_token(request)
    if not user_id or user_id == 'expired':
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    filename = data.get('filename') or f"note_{int(time.time())}.txt"
    content = data.get('content', '')

    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            # Check for Drive integration
            cur.execute("SELECT google_creds_json FROM users WHERE id = %s", (user_id,))
            creds_json = cur.fetchone()['google_creds_json']
            drive_file_id = None
            
            if creds_json:
                service, refreshed_creds = get_drive_service_from_creds_json(creds_json)
                if service:
                    folder_id = get_folder_id(service)
                    # Check if this note is already linked to a drive file
                    cur.execute("SELECT drive_file_id FROM notes WHERE user_id = %s AND filename = %s", (user_id, filename))
                    note_row = cur.fetchone()
                    existing_drive_file_id = note_row['drive_file_id'] if note_row else None
                    drive_file_id = upsert_drive_file(service, folder_id, filename.replace('.txt', ''), content, existing_drive_file_id)
                    # If creds were refreshed, save them back
                    if refreshed_creds and getattr(refreshed_creds, "refresh_token", None):
                         cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (creds_to_json(refreshed_creds), user_id))

            # Upsert note in DB
            cur.execute("""
                INSERT INTO notes (user_id, filename, content, drive_file_id, updated_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (user_id, filename) DO UPDATE SET
                content = EXCLUDED.content,
                drive_file_id = EXCLUDED.drive_file_id,
                updated_at = NOW();
            """, (user_id, filename, content, drive_file_id))
            conn.commit()

        return jsonify({"message": "Saved successfully", "filename": filename}), 200
    except Exception as e:
        logging.error(f"Save text error: {e}")
        conn.rollback()
        return jsonify({"error": "Failed to save"}), 500
    finally:
        conn.close()


@app.route('/history', methods=['GET'])
def get_history():
    user_id = get_user_from_token(request)
    if not user_id or user_id == 'expired':
        return jsonify({"error": "Unauthorized"}), 401

    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute(
                "SELECT filename, content, updated_at, drive_file_id IS NOT NULL as is_on_drive FROM notes WHERE user_id = %s ORDER BY updated_at DESC",
                (user_id,)
            )
            notes = [dict(row) for row in cur.fetchall()]
            return jsonify(notes), 200
    except Exception as e:
        logging.error(f"Get history error: {e}")
        return jsonify({"error": "Failed to retrieve history"}), 500
    finally:
        conn.close()


@app.route('/delete', methods=['POST'])
def delete_notes():
    user_id = get_user_from_token(request)
    if not user_id or user_id == 'expired':
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    filenames = data.get('filenames')
    if not isinstance(filenames, list) or not filenames:
        return jsonify({"error": "Invalid request"}), 400

    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            # Get drive file IDs for the notes to be deleted
            cur.execute(
                "SELECT filename, drive_file_id FROM notes WHERE user_id = %s AND filename = ANY(%s)",
                (user_id, filenames)
            )
            items = cur.fetchall()
            
            # Get user's google creds
            cur.execute("SELECT google_creds_json FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            creds_json = row["google_creds_json"] if row else None
            
            service = None
            if creds_json:
                service, refreshed_creds = get_drive_service_from_creds_json(creds_json)
                if refreshed_creds and getattr(refreshed_creds, "refresh_token", None):
                    cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (creds_to_json(refreshed_creds), user_id))

            deleted_count = 0
            for it in items:
                if it["drive_file_id"] and service:
                    if delete_drive_file(service, it["drive_file_id"]):
                        deleted_count += 1

            cur.execute("DELETE FROM notes WHERE user_id = %s AND filename = ANY(%s)", (user_id, filenames))
        conn.commit()
        return jsonify({"message": f"{len(filenames)} note(s) deleted; {deleted_count} Drive file(s) removed."}), 200
    except Exception as e:
        logging.error(f"Delete notes error: {e}")
        return jsonify({"error": "Failed to delete notes"}), 500
    finally:
        conn.close()

# ---------------- Health endpoint ----------------
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "backend_url": BACKEND_URL or request.url_root.replace('http://', 'https://')}), 200

# ---------------- DB Init Command ----------------
@click.command('init-db')
def init_db_command():
    """Initializes the database by creating the users and notes tables."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS notes;")
            cur.execute("DROP TABLE IF EXISTS users;")
            cur.execute("""
                CREATE TABLE users (
                    id SERIAL PRIMARY KEY,
                    email VARCHAR(255) UNIQUE NOT NULL,
                    password_hash VARCHAR(255),
                    google_creds_json TEXT,
                    created_at TIMESTAMP WITH TIME ZONE,
                    updated_at TIMESTAMP WITH TIME ZONE
                );
            """)
            cur.execute("""
                CREATE TABLE notes (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    filename VARCHAR(255) NOT NULL,
                    content TEXT,
                    drive_file_id VARCHAR(255),
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    updated_at TIMESTAMP WITH TIME ZONE,
                    UNIQUE(user_id, filename)
                );
            """)
            conn.commit()
            print("Database initialized.")
    except Exception as e:
        print(f"Error initializing database: {e}")
    finally:
        conn.close()

app.cli.add_command(init_db_command)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port)
