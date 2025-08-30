import os
import re
import psycopg2
import logging
from io import BytesIO
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
from googleapiclient.http import MediaIoBaseUpload
from google.auth.transport.requests import Request as GoogleRequest
from google.auth.exceptions import RefreshError

# --- Basic Logging Configuration ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Environment Variable Check ---
required_env_vars = ["DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "REDIRECT_URI"]
for var in required_env_vars:
    if not os.environ.get(var):
        logging.error(f"FATAL ERROR: Environment variable '{var}' is not set.")
        raise RuntimeError(f"FATAL ERROR: Environment variable '{var}' is not set.")

app = Flask(__name__)
CORS(app)  # allow cross-origin access (adjust in production)

# ------------------ Database Configuration ------------------
DATABASE_URL = os.environ.get("DATABASE_URL")
# Adjust for Heroku's PostgreSQL scheme if needed
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)


def get_db_connection():
    """Establishes and returns a database connection or None on failure."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except psycopg2.OperationalError as e:
        logging.error(f"Database connection error: {e}")
        return None


def init_db():
    """Initializes the database tables if they don't exist."""
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
            logging.info("Database tables initialized successfully.")
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


@app.cli.command("init-db")
def init_db_command():
    """Creates the database tables."""
    init_db()
    click.echo("Initialized the database.")


# ------------------ Root and Health Check ------------------
@app.route("/")
def index():
    """Simple health check."""
    return jsonify({"message": "Backend is running", "status": "ok"}), 200


# ------------------ Utilities ------------------
EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def validate_email(email):
    return bool(email and EMAIL_REGEX.match(email))


def sanitize_filename_part(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", s)


def generate_filename(email):
    """Generates a unique filename based on email and timestamp."""
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    localpart = email.split('@')[0] if '@' in email else email
    sanitized_email = sanitize_filename_part(localpart)
    return f"{sanitized_email}_{timestamp}.txt"


# ------------------ User Authentication Routes ------------------
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

    try:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO users (emailid, password_hash) VALUES (%s, %s)", (email, hashed_password))
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

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT * FROM users WHERE emailid = %s", (email,))
            user = cur.fetchone()

        if user and check_password_hash(user["password_hash"], password):
            # Currently we return a simple success message; consider returning a token (JWT) in future.
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


# ------------------ Note Management Routes ------------------
@app.route("/save", methods=["POST"])
def save_text():
    data = request.get_json(silent=True) or {}
    email = data.get("emailid")
    content = data.get("filecontent")
    title = data.get("title", "Untitled Note")  # Default title

    if not email or not content:
        return jsonify({"error": "Email and content are required."}), 400
    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    filename = generate_filename(email)
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO notes (filename, emailid, title, filecontent) VALUES (%s, %s, %s, %s)",
                (filename, email, title, content)
            )
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
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute(
                "SELECT filename, title, filecontent, created_at, pinned FROM notes WHERE emailid = %s",
                (email,)
            )
            rows = cur.fetchall()
            notes = [dict(row) for row in rows]
        # Sort pinned first, then by created_at descending within each group
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
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE notes SET title = %s, filecontent = %s WHERE filename = %s AND emailid = %s",
                (title, content, filename, email)
            )
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
        with conn.cursor() as cur:
            cur.execute("DELETE FROM notes WHERE filename = %s AND emailid = %s", (filename, email))
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
        # Allow 0/1 or "true"/"false" as fallback
        pinned = bool(pinned)

    if not validate_email(email):
        return jsonify({"error": "Invalid email format."}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503

    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE notes SET pinned = %s WHERE filename = %s AND emailid = %s",
                (pinned, filename, email)
            )
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

    # Build OAuth flow and redirect user to Google consent screen.
    flow = Flow.from_client_config(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=os.environ.get("REDIRECT_URI")
    )
    authorization_url, state = flow.authorization_url(
        access_type='offline',
        prompt='consent',
        state=email  # passing email in state to identify user during callback
    )
    return redirect(authorization_url)


@app.route('/drive/callback')
def drive_callback():
    state = request.args.get('state')  # we encoded email in state
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
    if not refresh_token:
        logging.warning("No refresh token received from Google. User may need to re-consent with prompt=consent.")
        # Still try to extract access token if present, but ideally we need refresh token.
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database service unavailable."}), 503
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET google_refresh_token = %s WHERE emailid = %s",
                (refresh_token, state)
            )
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
    """Builds a Drive service object from a refresh token. Raises informative exceptions on failure."""
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
    """Finds a folder by name or creates it if it doesn't exist. Returns folder ID."""
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
        with conn.cursor(cursor_factory=DictCursor) as cur:
            # First, get the user's refresh token
            cur.execute("SELECT google_refresh_token FROM users WHERE emailid = %s", (email,))
            user = cur.fetchone()
            if not user or not user.get('google_refresh_token'):
                return jsonify({"error": "Google Drive not connected for this user."}), 403

            # Then, get the note content
            cur.execute("SELECT title, filecontent FROM notes WHERE filename = %s AND emailid = %s", (filename, email))
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

        created_file = drive_service.files().create(
            body=file_metadata,
            media_body=media_body,
            fields='id'
        ).execute()
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
    # Initialize DB when running directly (development convenience)
    try:
        init_db()
    except Exception:
        pass

    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(debug=debug_mode, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
