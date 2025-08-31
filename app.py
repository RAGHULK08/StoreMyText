import os
import re
import json
import logging
import psycopg2
from io import BytesIO
from psycopg2.extras import DictCursor
from flask import Flask, request, jsonify, redirect, session, url_for
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import click
from datetime import datetime, timezone, timedelta
import jwt

# Google OAuth
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.auth.transport.requests import Request as GoogleRequest
from google.auth.exceptions import RefreshError

# --- Logging ---
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# --- Config (use env vars in production) ---
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://<user>:<pass>@<host>:5432/<db>?sslmode=require")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "https://your-frontend.example.com")  # where Google should redirect after flow
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key")
JWT_SECRET = os.environ.get("JWT_SECRET", FLASK_SECRET_KEY)
JWT_ALGO = "HS256"
JWT_EXP_DAYS = int(os.environ.get("JWT_EXP_DAYS", "7"))

app = Flask(__name__)
app.secret_key = FLASK_SECRET_KEY
CORS(app, supports_credentials=True)

# ------------------ DB helpers ------------------
def get_db_connection():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except Exception as e:
        logging.error(f"DB connection failed: {e}")
        return None

def init_db():
    conn = get_db_connection()
    if not conn:
        logging.error("Cannot initialize DB: no connection")
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
                drive_file_id TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            """)
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
        logging.info("DB initialized / migrations applied")
    except Exception as e:
        logging.error(f"Error init DB: {e}")
    finally:
        conn.close()

# CLI
@app.cli.command("init-db")
def init_db_command():
    init_db()
    click.echo("Initialized DB.")

# ------------------ JWT helpers ------------------
def create_token(user_id):
    payload = {
        "sub": str(user_id),
        "iat": datetime.utcnow(),
        "exp": datetime.utcnow() + timedelta(days=JWT_EXP_DAYS)
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)
    # jwt.encode returns str in PyJWT >=2.x
    if isinstance(token, bytes):
        token = token.decode()
    return token

def decode_token(token):
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        return payload.get("sub")
    except jwt.ExpiredSignatureError:
        return None
    except Exception as e:
        logging.warning(f"JWT decode error: {e}")
        return None

def get_user_id_from_request(req):
    auth = req.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth.split(" ", 1)[1]
        return decode_token(token)
    return None

# ------------------ Google Drive helpers ------------------
def build_client_config():
    return {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }

def get_drive_service_from_creds_json(creds_json):
    if not creds_json:
        return None, None
    try:
        creds_info = json.loads(creds_json)
        creds = Credentials(
            token=creds_info.get("token"),
            refresh_token=creds_info.get("refresh_token"),
            token_uri=creds_info.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=creds_info.get("client_id"),
            client_secret=creds_info.get("client_secret"),
            scopes=creds_info.get("scopes"),
        )
        # refresh if needed
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(GoogleRequest())
            except RefreshError as e:
                logging.warning(f"Could not refresh Google credentials: {e}")
                return None, None
        service = build("drive", "v3", credentials=creds)
        return service, creds
    except Exception as e:
        logging.error(f"Error building drive service from creds: {e}")
        return None, None

def creds_to_json(creds):
    return json.dumps({
        "token": creds.token,
        "refresh_token": getattr(creds, "refresh_token", None),
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": creds.scopes
    })

def upload_or_update_file(service, file_name, content, existing_file_id=None):
    try:
        fh = BytesIO(content.encode("utf-8"))
        media = MediaIoBaseUpload(fh, mimetype="text/plain", resumable=False)
        if existing_file_id:
            updated = service.files().update(fileId=existing_file_id, media_body=media).execute()
            return updated.get("id")
        else:
            meta = {"name": file_name, "mimeType": "text/plain"}
            created = service.files().create(body=meta, media_body=media, fields="id").execute()
            return created.get("id")
    except Exception as e:
        logging.error(f"Drive upload/update failed: {e}")
        return None

def delete_drive_file(service, file_id):
    try:
        service.files().delete(fileId=file_id).execute()
        return True
    except Exception as e:
        logging.warning(f"Drive delete failed (file may already be gone): {e}")
        return False

# ------------------ Auth routes ------------------
@app.route("/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "").strip()
    if not email or not password or not re.match(r"[^@]+@[^@]+\.[^@]+", email):
        return jsonify({"error": "Invalid email or password"}), 400

    hashed = generate_password_hash(password)
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    try:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id", (email, hashed))
            new_id = cur.fetchone()[0]
        conn.commit()
        token = create_token(new_id)
        return jsonify({"message": "User created", "token": token}), 201
    except psycopg2.IntegrityError:
        return jsonify({"error": "Email already registered"}), 409
    except Exception as e:
        logging.error(f"Register error: {e}")
        return jsonify({"error": "Internal error"}), 500
    finally:
        conn.close()

@app.route("/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "").strip()
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT id, password_hash FROM users WHERE email = %s", (email,))
            user = cur.fetchone()
        if user and user["password_hash"] and check_password_hash(user["password_hash"], password):
            token = create_token(user["id"])
            return jsonify({"token": token, "message": "Login successful"}), 200
        return jsonify({"error": "Invalid credentials"}), 401
    except Exception as e:
        logging.error(f"Login error: {e}")
        return jsonify({"error": "Internal error"}), 500
    finally:
        conn.close()

@app.route("/me", methods=["GET"])
def me():
    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required"}), 401
    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500
    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT id, email, google_creds_json IS NOT NULL AS drive_linked FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "User not found"}), 404
            return jsonify({"id": row["id"], "email": row["email"], "drive_linked": row["drive_linked"]}), 200
    except Exception as e:
        logging.error(f"/me error: {e}")
        return jsonify({"error": "Internal error"}), 500
    finally:
        conn.close()

# ------------------ Google OAuth endpoints ------------------
@app.route("/auth/google/start", methods=["GET"])
def google_auth_start():
    """
    Start Google OAuth flow. Returns an authorization URL to which the frontend should redirect.
    Frontend MUST provide the user's JWT in the Authorization header for the /callback to link to the correct user.
    """
    # Build Flow
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return jsonify({"error": "Google OAuth not configured on server"}), 500

    flow = Flow.from_client_config(
        build_client_config(),
        scopes=["https://www.googleapis.com/auth/drive.file", "openid", "email", "profile"],
        redirect_uri=url_for("google_auth_callback", _external=True)
    )
    auth_url, state = flow.authorization_url(access_type="offline", include_granted_scopes="true", prompt="consent")
    # store flow state in server session (short lived)
    session["google_oauth_state"] = state
    return jsonify({"auth_url": auth_url})

@app.route("/auth/google/callback", methods=["GET"])
def google_auth_callback():
    """
    Google redirects back here. The Authorization header must contain the user's JWT so server can save creds to that user.
    After saving, server redirects back to FRONTEND_URL with success or error query param.
    """
    state = session.get("google_oauth_state")
    if not state:
        logging.warning("OAuth callback without state in session.")
    flow = Flow.from_client_config(
        build_client_config(),
        scopes=["https://www.googleapis.com/auth/drive.file", "openid", "email", "profile"],
        state=state,
        redirect_uri=url_for("google_auth_callback", _external=True)
    )

    authorization_response = request.url
    try:
        flow.fetch_token(authorization_response=authorization_response)
    except Exception as e:
        logging.error(f"Error fetching token from Google: {e}")
        return redirect(f"{FRONTEND_URL}?google_link_error=1")

    creds = flow.credentials
    # Identify user from header JWT
    bearer = request.headers.get("Authorization", "")
    user_id = None
    if bearer.startswith("Bearer "):
        token = bearer.split(" ", 1)[1]
        user_id = decode_token(token)
    # If not in header (some OAuth clients / browsers strip headers on redirect), try session-stored user id
    # (We don't store user id in session for security reasons; recommend frontend include token during final fetch if possible)
    if not user_id:
        # fallback: try 'state' to carry user id (not implemented here). If missing, we still try to ask frontend to re-fetch /me
        logging.warning("No JWT in callback request — ensure your frontend includes Authorization header when calling the callback (or provide a separate endpoint). Will attempt best-effort redirect.")
    # Save creds to DB if we have user_id
    if user_id:
        try:
            conn = get_db_connection()
            if conn:
                with conn.cursor() as cur:
                    cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s",
                                (creds_to_json(creds), user_id))
                conn.commit()
                conn.close()
                logging.info(f"Saved Google creds for user {user_id}")
                return redirect(f"{FRONTEND_URL}?google_link_success=1")
            else:
                logging.error("DB connection failed while saving google creds")
                return redirect(f"{FRONTEND_URL}?google_link_error=1")
        except Exception as e:
            logging.error(f"Saving google creds error: {e}")
            return redirect(f"{FRONTEND_URL}?google_link_error=1")
    else:
        # If we couldn't attach to a user, return success but the frontend should call /me to confirm
        return redirect(f"{FRONTEND_URL}?google_link_success=1")

# ------------------ Notes endpoints ------------------
@app.route("/save", methods=["POST"])
def save_text():
    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required"}), 401

    data = request.get_json() or {}
    filename = data.get("filename")  # if provided, update
    content = data.get("content", "")
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title required"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500

    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            # fetch user's creds to decide whether to upload to Drive
            cur.execute("SELECT google_creds_json FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            creds_json = row["google_creds_json"] if row else None

            drive_file_id = None
            # If file exists (update)
            if filename:
                # lookup existing drive_file_id
                cur.execute("SELECT drive_file_id FROM notes WHERE filename = %s AND user_id = %s", (filename, user_id))
                r = cur.fetchone()
                existing_drive_id = r["drive_file_id"] if r else None

                if creds_json:
                    service, refreshed_creds = get_drive_service_from_creds_json(creds_json)
                    if service:
                        drive_file_id = upload_or_update_file(service, filename, content, existing_file_id=existing_drive_id)
                        # save refreshed tokens if any
                        if refreshed_creds and refreshed_creds.refresh_token:
                            cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (creds_to_json(refreshed_creds), user_id))

                # Update note metadata in DB (keep filecontent as backup copy)
                cur.execute("""
                    UPDATE notes
                    SET filecontent = %s, title = %s, drive_file_id = COALESCE(%s, drive_file_id)
                    WHERE filename = %s AND user_id = %s
                """, (content, title, drive_file_id, filename, user_id))
                message = "Note updated"
            else:
                # new note
                filename = f"note_{int(datetime.now(timezone.utc).timestamp())}_{user_id}.txt"
                if creds_json:
                    service, refreshed_creds = get_drive_service_from_creds_json(creds_json)
                    if service:
                        drive_file_id = upload_or_update_file(service, filename, content)
                        if refreshed_creds and refreshed_creds.refresh_token:
                            cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (creds_to_json(refreshed_creds), user_id))
                cur.execute("""
                    INSERT INTO notes (user_id, filename, filecontent, title, drive_file_id)
                    VALUES (%s, %s, %s, %s, %s)
                """, (user_id, filename, content, title, drive_file_id))
                message = "Note saved"

        conn.commit()
        return jsonify({"message": message, "filename": filename, "drive_file_id": drive_file_id}), 200
    except Exception as e:
        logging.error(f"Save note error: {e}")
        return jsonify({"error": "Failed to save note"}), 500
    finally:
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
            cur.execute("""
                SELECT filename, filecontent, title, drive_file_id, updated_at
                FROM notes WHERE user_id = %s ORDER BY updated_at DESC
            """, (user_id,))
            notes = [dict(r) for r in cur.fetchall()]
        return jsonify(notes), 200
    except Exception as e:
        logging.error(f"Get history error: {e}")
        return jsonify({"error": "Failed to retrieve history"}), 500
    finally:
        conn.close()

@app.route("/delete", methods=["POST"])
def delete_notes():
    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required"}), 401
    data = request.get_json() or {}
    filenames = data.get("filenames")
    if not isinstance(filenames, list) or not filenames:
        return jsonify({"error": "filenames must be a non-empty list"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500

    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            # Fetch drive_file_ids for deletion
            cur.execute("SELECT filename, drive_file_id FROM notes WHERE user_id = %s AND filename = ANY(%s)", (user_id, filenames))
            items = cur.fetchall()
            # fetch user's creds
            cur.execute("SELECT google_creds_json FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            creds_json = row["google_creds_json"] if row else None
            service = None
            if creds_json:
                service, refreshed_creds = get_drive_service_from_creds_json(creds_json)
                if refreshed_creds and refreshed_creds.refresh_token:
                    cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (creds_to_json(refreshed_creds), user_id))
            # delete Drive files (best-effort)
            deleted_count = 0
            for it in items:
                if it["drive_file_id"] and service:
                    if delete_drive_file(service, it["drive_file_id"]):
                        deleted_count += 1
            # delete metadata rows
            cur.execute("DELETE FROM notes WHERE user_id = %s AND filename = ANY(%s)", (user_id, filenames))
        conn.commit()
        return jsonify({"message": f"{len(filenames)} note(s) deleted; {deleted_count} Drive file(s) removed."}), 200
    except Exception as e:
        logging.error(f"Delete notes error: {e}")
        return jsonify({"error": "Failed to delete notes"}), 500
    finally:
        conn.close()

# ------------------ Run ------------------
if __name__ == "__main__":
    with app.app_context():
        init_db()
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)
