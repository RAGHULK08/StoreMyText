import os
import re
import logging
from io import BytesIO
from datetime import datetime

import click
import psycopg2
from psycopg2.extras import DictCursor
from psycopg2 import sql

from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

# Google API imports (unchanged)
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseUpload
from google.auth.transport.requests import Request as GoogleRequest
from google.auth.exceptions import RefreshError

# --- Logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Required env vars (fail fast) ---
required_env_vars = ["DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "REDIRECT_URI"]
for var in required_env_vars:
    if not os.environ.get(var):
        logging.error(f"FATAL ERROR: Environment variable '{var}' is not set.")
        raise RuntimeError(f"FATAL ERROR: Environment variable '{var}' is not set.")

app = Flask(__name__)
CORS(app)  # keep flexible for now; tighten origins in production

# ------------------ Database Configuration ------------------
DATABASE_URL = os.environ.get("DATABASE_URL")
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)


def get_db_connection():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except Exception as e:
        logging.error(f"Database connection error: {e}")
        return None


# Globals to store detected column names
USERS_EMAIL_COL = "emailid"  # fallback
NOTES_EMAIL_COL = "emailid"  # fallback


def detect_email_like_column(conn, table_name):
    """
    Returns the actual column name in `table_name` that most likely stores an email.
    Strategy:
      - Query information_schema.columns for column_name
      - prefer exact matches ('emailid', 'email', 'email_id')
      - else pick the first column containing substring 'email' case-insensitive
      - if none found, return None
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = %s
                ORDER BY ordinal_position
                """,
                (table_name.lower(),),
            )
            cols = [r[0] for r in cur.fetchall()]
    except Exception as e:
        logging.error(f"Schema detection query failed for table {table_name}: {e}")
        return None

    if not cols:
        return None

    # Prioritized names
    preferred = ["emailid", "email", "email_id", "Email", "EmailId", "EmailID"]
    for p in preferred:
        for c in cols:
            if c.lower() == p.lower():
                return c

    # Fallback: first column that contains 'email'
    for c in cols:
        if "email" in c.lower():
            return c

    return None


def set_column_mappings():
    """Detect and set USERS_EMAIL_COL and NOTES_EMAIL_COL based on existing schema."""
    global USERS_EMAIL_COL, NOTES_EMAIL_COL
    conn = get_db_connection()
    if not conn:
        logging.warning("Could not connect to DB to detect column mappings; using defaults.")
        return
    try:
        users_col = detect_email_like_column(conn, "users")
        notes_col = detect_email_like_column(conn, "notes")

        if users_col:
            USERS_EMAIL_COL = users_col
            logging.info(f"Detected users email column: {USERS_EMAIL_COL}")
        else:
            logging.warning("Could not detect users email-like column; using fallback 'emailid'.")

        if notes_col:
            NOTES_EMAIL_COL = notes_col
            logging.info(f"Detected notes email column: {NOTES_EMAIL_COL}")
        else:
            logging.warning("Could not detect notes email-like column; using fallback 'emailid'.")

    finally:
        try:
            conn.close()
        except Exception:
            pass


def init_db():
    """Create tables if they don't exist (safe to run on existing DB)."""
    conn = get_db_connection()
    if not conn:
        logging.error("init_db: no database connection available.")
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    emailid VARCHAR(255) PRIMARY KEY,
                    password_hash VARCHAR(255) NOT NULL,
                    google_refresh_token TEXT
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS notes (
                    filename VARCHAR(255) PRIMARY KEY,
                    emailid VARCHAR(255) REFERENCES users(emailid) ON DELETE CASCADE,
                    title TEXT,
                    filecontent TEXT,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    pinned BOOLEAN DEFAULT FALSE
                );
            """)
            conn.commit()
            logging.info("Database tables initialized (if not present).")
    except Exception as e:
        logging.error(f"DB Init Error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


# Initialize mappings early (attempt)
try:
    set_column_mappings()
except Exception as e:
    logging.warning(f"set_column_mappings initial call failed: {e}")


# ------------------ Utilities ------------------
EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def validate_email(email):
    return bool(email and EMAIL_REGEX.match(email))


def sanitize_filename_part(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", s)


def generate_filename(email):
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    localpart = email.split('@')[0] if '@' in email else email
    sanitized_email = sanitize_filename_part(localpart)
    return f"{sanitized_email}_{timestamp}.txt"


# ------------------ Routes ------------------
@app.route("/")
def index():
    return jsonify({"message": "Backend is running", "status": "ok"}), 200


@app.route("/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")
    password = data.get("password")
    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    hashed_password = generate_password_hash(password)
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    # Ensure mappings up-to-date (in case DB changed)
    try:
        set_column_mappings()
    except Exception:
        pass

    try:
        with conn.cursor() as cur:
            # Use psycopg2.sql to safely inject identifier (column name)
            insert_q = sql.SQL("INSERT INTO {table} ({email_col}, password_hash) VALUES (%s, %s)").format(
                table=sql.Identifier("users"),
                email_col=sql.Identifier(USERS_EMAIL_COL)
            )
            cur.execute(insert_q, (email, hashed_password))
            conn.commit()
        return jsonify({"message": "User registered successfully."}), 201
    except psycopg2.IntegrityError:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": "User with this email already exists."}), 409
    except Exception as e:
        logging.error(f"Register Error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": "An internal error occurred."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


@app.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")
    password = data.get("password")

    if not email or not password:
        return jsonify({"error": "Email and password are required."}), 400
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        # Refresh mapping in case DB schema changed
        set_column_mappings()
        with conn.cursor(cursor_factory=DictCursor) as cur:
            sel_q = sql.SQL("SELECT * FROM {table} WHERE {email_col} = %s").format(
                table=sql.Identifier("users"),
                email_col=sql.Identifier(USERS_EMAIL_COL)
            )
            cur.execute(sel_q, (email,))
            user = cur.fetchone()

        if user and check_password_hash(user.get("password_hash"), password):
            return jsonify({"message": "Login successful."}), 200
        else:
            return jsonify({"error": "Invalid email or password."}), 401
    except Exception as e:
        logging.error(f"Login Error: {e}")
        return jsonify({"error": "An internal error occurred."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


@app.route("/save", methods=["POST"])
def save_text():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")
    content = data.get("filecontent")
    title = data.get("title", "Untitled Note")

    if not email or content is None:
        return jsonify({"error": "Email and content are required."}), 400
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    filename = generate_filename(email)
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        set_column_mappings()
        with conn.cursor() as cur:
            ins_q = sql.SQL("INSERT INTO {table} (filename, {email_col}, title, filecontent) VALUES (%s, %s, %s, %s)").format(
                table=sql.Identifier("notes"),
                email_col=sql.Identifier(NOTES_EMAIL_COL)
            )
            cur.execute(ins_q, (filename, email, title, content))
            conn.commit()
        return jsonify({"message": "Note saved successfully.", "filename": filename}), 201
    except Exception as e:
        logging.error(f"Save Error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": "Failed to save note."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


@app.route("/history", methods=["POST"])
def get_history():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")

    if not email:
        return jsonify({"error": "Email is required."}), 400
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        set_column_mappings()
        with conn.cursor(cursor_factory=DictCursor) as cur:
            sel_q = sql.SQL("SELECT filename, title, filecontent, created_at, pinned FROM {table} WHERE {email_col} = %s").format(
                table=sql.Identifier("notes"),
                email_col=sql.Identifier(NOTES_EMAIL_COL)
            )
            cur.execute(sel_q, (email,))
            rows = cur.fetchall()
            notes = [dict(row) for row in rows]
        # Sort pinned first then newest within groups
        notes.sort(key=lambda n: (not bool(n.get('pinned')), -float(n.get('created_at').timestamp() if n.get('created_at') else 0)))
        return jsonify(notes), 200
    except Exception as e:
        logging.error(f"History Error: {e}")
        return jsonify({"error": "Failed to retrieve history."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


@app.route("/update", methods=["PUT"])
def update_note():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")
    filename = data.get("filename")
    content = data.get("filecontent")
    title = data.get("title")

    if not email or not filename or content is None or title is None:
        return jsonify({"error": "Missing required fields for update."}), 400
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        set_column_mappings()
        with conn.cursor() as cur:
            upd_q = sql.SQL("UPDATE {table} SET title = %s, filecontent = %s WHERE filename = %s AND {email_col} = %s").format(
                table=sql.Identifier("notes"),
                email_col=sql.Identifier(NOTES_EMAIL_COL)
            )
            cur.execute(upd_q, (title, content, filename, email))
            conn.commit()
            if cur.rowcount == 0:
                return jsonify({"error": "Note not found or user mismatch."}), 404
        return jsonify({"message": "Note updated successfully."}), 200
    except Exception as e:
        logging.error(f"Update Error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": "Failed to update note."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


@app.route("/delete", methods=["DELETE"])
def delete_note():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")
    filename = data.get("filename")

    if not email or not filename:
        return jsonify({"error": "Email and filename are required."}), 400
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        set_column_mappings()
        with conn.cursor() as cur:
            del_q = sql.SQL("DELETE FROM {table} WHERE filename = %s AND {email_col} = %s").format(
                table=sql.Identifier("notes"),
                email_col=sql.Identifier(NOTES_EMAIL_COL)
            )
            cur.execute(del_q, (filename, email))
            conn.commit()
            if cur.rowcount == 0:
                return jsonify({"error": "Note not found or permission denied."}), 404
        return jsonify({"message": "Note deleted successfully."}), 200
    except Exception as e:
        logging.error(f"Delete Error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": "Failed to delete note."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


@app.route("/pin", methods=["PUT"])
def pin_note():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")
    filename = data.get("filename")
    pinned = data.get("pinned")

    if not email or not filename or pinned is None:
        return jsonify({"error": "Missing required fields for pin action."}), 400
    if not isinstance(pinned, bool):
        pinned = bool(pinned)
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        set_column_mappings()
        with conn.cursor() as cur:
            pin_q = sql.SQL("UPDATE {table} SET pinned = %s WHERE filename = %s AND {email_col} = %s").format(
                table=sql.Identifier("notes"),
                email_col=sql.Identifier(NOTES_EMAIL_COL)
            )
            cur.execute(pin_q, (pinned, filename, email))
            conn.commit()
            if cur.rowcount == 0:
                return jsonify({"error": "Note not found or user mismatch."}), 404
        return jsonify({"message": f"Note {'pinned' if pinned else 'unpinned'} successfully."}), 200
    except Exception as e:
        logging.error(f"Pin Error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": "Failed to update pin status."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ------------------ Google Drive Integration ------------------
SCOPES = ['https://www.googleapis.com/auth/drive.file']
CLIENT_SECRETS_FILE = {
    "web": {
        "client_id": os.environ.get("GOOGLE_CLIENT_ID"),
        "project_id": "storemytext",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET"),
        "redirect_uris": [os.environ.get("REDIRECT_URI")]
    }
}


@app.route('/drive/login')
def drive_login():
    email = request.args.get('email')
    if not email:
        return jsonify({"error": "Email is required to initiate Google Drive login."}), 400

    flow = Flow.from_client_config(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=os.environ.get("REDIRECT_URI")
    )
    authorization_url, state = flow.authorization_url(
        access_type='offline',
        prompt='consent',
        state=email
    )
    return redirect(authorization_url)


@app.route('/drive/callback')
def drive_callback():
    state = request.args.get('state')
    flow = Flow.from_client_config(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=os.environ.get("REDIRECT_URI")
    )
    try:
        flow.fetch_token(authorization_response=request.url)
    except Exception as e:
        logging.error(f"Drive callback token fetch error: {e}")
        return jsonify({"error": "Failed to fetch token from Google."}), 500

    refresh_token = getattr(flow.credentials, "refresh_token", None)
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        set_column_mappings()
        with conn.cursor() as cur:
            upd_q = sql.SQL("UPDATE {table} SET google_refresh_token = %s WHERE {email_col} = %s").format(
                table=sql.Identifier("users"),
                email_col=sql.Identifier(USERS_EMAIL_COL)
            )
            cur.execute(upd_q, (refresh_token, state))
            conn.commit()
        return """
            <html>
                <head><title>Success</title></head>
                <body>
                    <h1>Google Drive connected successfully!</h1>
                    <p>You can now close this tab and return to the application.</p>
                </body>
            </html>
        """
    except Exception as e:
        logging.error(f"Drive Callback Error: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": "Failed to save Google Drive token."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _get_and_refresh_drive_service(refresh_token):
    creds = Credentials(
        None,
        refresh_token=refresh_token,
        token_uri=CLIENT_SECRETS_FILE['web']['token_uri'],
        client_id=CLIENT_SECRETS_FILE['web']['client_id'],
        client_secret=CLIENT_SECRETS_FILE['web']['client_secret'],
        scopes=SCOPES
    )
    try:
        creds.refresh(GoogleRequest())
    except RefreshError as e:
        logging.error(f"Drive token refresh failed: {e}")
        raise
    return build('drive', 'v3', credentials=creds)


def _ensure_folder(service, folder_name):
    query = f"mimeType='application/vnd.google-apps.folder' and name='{folder_name}' and trashed=false"
    response = service.files().list(q=query, spaces='drive', fields='files(id, name)').execute()
    files = response.get('files', [])
    if files:
        return files[0].get('id')
    else:
        file_metadata = {'name': folder_name, 'mimeType': 'application/vnd.google-apps.folder'}
        folder = service.files().create(body=file_metadata, fields='id').execute()
        return folder.get('id')


@app.route("/drive/upload", methods=["POST"])
def upload_to_drive():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")
    filename = data.get("filename")

    if not email or not filename:
        return jsonify({"error": "Email and filename are required."}), 400
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        set_column_mappings()
        with conn.cursor(cursor_factory=DictCursor) as cur:
            sel_q = sql.SQL("SELECT google_refresh_token FROM {table} WHERE {email_col} = %s").format(
                table=sql.Identifier("users"),
                email_col=sql.Identifier(USERS_EMAIL_COL)
            )
            cur.execute(sel_q, (email,))
            user = cur.fetchone()
            if not user or not user.get('google_refresh_token'):
                return jsonify({"error": "Google Drive not connected for this user."}), 403

            note_q = sql.SQL("SELECT title, filecontent FROM {table} WHERE filename = %s AND {email_col} = %s").format(
                table=sql.Identifier("notes"),
                email_col=sql.Identifier(NOTES_EMAIL_COL)
            )
            cur.execute(note_q, (filename, email))
            note = cur.fetchone()
            if not note:
                return jsonify({"error": "Note not found."}), 404

        try:
            drive_service = _get_and_refresh_drive_service(user["google_refresh_token"])
        except Exception as e:
            logging.error(f"Drive service error: {e}")
            return jsonify({"error": "Failed to refresh Google Drive credentials. Reconnect required."}), 500

        parent_folder_id = _ensure_folder(drive_service, "StoreMyText")
        file_metadata = {
            'name': (note['title'] or filename),
            'mimeType': 'text/plain',
            'parents': [parent_folder_id],
        }
        media_body = MediaIoBaseUpload(BytesIO((note['filecontent'] or "").encode('utf-8')), mimetype='text/plain', resumable=False)
        created_file = drive_service.files().create(body=file_metadata, media_body=media_body, fields='id').execute()
        return jsonify({"message": "Note uploaded to Google Drive.", "file_id": created_file.get("id")}), 200
    except HttpError as e:
        logging.error(f"Google Drive upload error: {e}")
        return jsonify({"error": "Failed to upload to Google Drive. Connection may need to be re-established."}), 500
    except Exception as e:
        logging.error(f"Error in /drive/upload: {e}")
        return jsonify({"error": "Server error during Drive upload."}), 500
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ------------------ App Initialization ------------------
if __name__ == "__main__":
    try:
        init_db()
    except Exception:
        pass

    # Re-detect mappings after init
    try:
        set_column_mappings()
    except Exception as e:
        logging.warning(f"Column mapping detection failed on startup: {e}")

    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(debug=debug_mode, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
