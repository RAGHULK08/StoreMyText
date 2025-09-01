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
from werkzeug.middleware.proxy_fix import ProxyFix
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

# requests for manual token exchange fallback
import requests

# ---- logging ----
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# ---- env / config ----
DATABASE_URL = os.environ.get("DATABASE_URL", "")
BACKEND_URL = os.environ.get("BACKEND_URL", "")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
REDIRECT_URI = os.environ.get("REDIRECT_URI", "")
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-secret")
JWT_SECRET = os.environ.get("JWT_SECRET", FLASK_SECRET_KEY)
JWT_ALGO = "HS256"
JWT_EXP_DAYS = int(os.environ.get("JWT_EXP_DAYS", "7"))

app = Flask(__name__)
app.secret_key = FLASK_SECRET_KEY
# tell Flask about the external preferred scheme
app.config['PREFERRED_URL_SCHEME'] = 'https'

# Trust the proxy headers supplied by Render (X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# CORS: restrict to front-end origin if provided
if FRONTEND_URL:
    CORS(app, resources={r"/*": {"origins": FRONTEND_URL}}, supports_credentials=True)
else:
    CORS(app, supports_credentials=True)

# ---------------- DB helpers ----------------
def get_db_connection():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except Exception as e:
        logging.error(f"DB connection failed (postgres): {e}")
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
            cur.execute("DROP TRIGGER IF EXISTS set_timestamp ON notes;")
            cur.execute("""
            CREATE TRIGGER set_timestamp
            BEFORE UPDATE ON notes
            FOR EACH ROW
            EXECUTE PROCEDURE trigger_set_timestamp();
            """)
        conn.commit()
        logging.info("DB initialized / migrations applied")
    except Exception:
        logging.exception("Error init DB")
    finally:
        conn.close()

@app.cli.command("init-db")
def init_db_command():
    init_db()
    click.echo("Initialized DB.")

# ---------------- JWT helpers ----------------
def create_token(user_id):
    payload = {"sub": str(user_id), "iat": datetime.utcnow(), "exp": datetime.utcnow() + timedelta(days=JWT_EXP_DAYS)}
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)
    if isinstance(token, bytes):
        token = token.decode()
    return token

def decode_token(token):
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        return payload.get("sub")
    except jwt.ExpiredSignatureError:
        return None
    except Exception:
        logging.exception("JWT decode error")
        return None

def get_user_id_from_request(req):
    auth = req.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth.split(" ", 1)[1]
        return decode_token(token)
    return None

# ---------------- secure state helpers ----------------
STATE_TTL_SECONDS = 600
def make_oauth_state(user_id):
    ts = str(int(time.time()))
    msg = f"{user_id}:{ts}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).hexdigest()
    raw = f"{user_id}:{ts}:{sig}"
    return base64.urlsafe_b64encode(raw.encode()).decode()

def verify_oauth_state(state_b64, max_age_seconds=STATE_TTL_SECONDS):
    try:
        raw = base64.urlsafe_b64decode(state_b64.encode()).decode()
        parts = raw.split(":")
        if len(parts) != 3:
            return None
        user_id, ts, sig = parts
        msg = f"{user_id}:{ts}".encode()
        expected = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            logging.warning("OAuth state signature mismatch")
            return None
        if abs(int(time.time()) - int(ts)) > max_age_seconds:
            logging.warning("OAuth state expired")
            return None
        return user_id
    except Exception:
        logging.exception("OAuth state verify error")
        return None

# ---------------- Google Drive helpers ----------------
def build_client_config():
    redirect_list = [REDIRECT_URI] if REDIRECT_URI else []
    return {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": redirect_list,
        }
    }

def effective_redirect_uri():
    if REDIRECT_URI:
        return REDIRECT_URI
    if BACKEND_URL:
        return BACKEND_URL.rstrip("/") + "/auth/google/callback"
    try:
        return request.url_root.rstrip("/") + "/auth/google/callback"
    except Exception:
        return "/auth/google/callback"

def get_drive_service_from_creds_json(creds_json):
    if not creds_json:
        return None, None
    try:
        creds_info = json.loads(creds_json)
        scopes = creds_info.get("scopes") or []
        if isinstance(scopes, str):
            scopes = scopes.split()
        creds = Credentials(
            token=creds_info.get("token"),
            refresh_token=creds_info.get("refresh_token"),
            token_uri=creds_info.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=creds_info.get("client_id"),
            client_secret=creds_info.get("client_secret"),
            scopes=scopes or None,
        )
        if creds and creds.expired and getattr(creds, "refresh_token", None):
            try:
                creds.refresh(GoogleRequest())
            except RefreshError:
                logging.exception("Failed to refresh Google credentials")
                return None, None
        service = build("drive", "v3", credentials=creds)
        return service, creds
    except Exception:
        logging.exception("Error building drive service from creds")
        return None, None

def creds_to_json(creds):
    try:
        scopes = creds.scopes if getattr(creds, "scopes", None) is not None else []
        if isinstance(scopes, (set, tuple)):
            scopes = list(scopes)
        return json.dumps({
            "token": creds.token,
            "refresh_token": getattr(creds, "refresh_token", None),
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": scopes
        })
    except Exception:
        logging.exception("Error serializing credentials to JSON")
        return None

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
    except Exception:
        logging.exception("Drive upload/update failed")
        return None

def delete_drive_file(service, file_id):
    try:
        service.files().delete(fileId=file_id).execute()
        return True
    except Exception:
        logging.exception("Drive delete failed")
        return False

# ---------------- Auth routes (register/login/me) ----------------
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
    except Exception:
        logging.exception("Register error")
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
    except Exception:
        logging.exception("Login error")
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
            cur.execute("SELECT id, email, google_creds_json IS NOT NULL AS drive_linked FROM users WHERE id = %s", (int(user_id),))
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "User not found"}), 404
            return jsonify({"id": row["id"], "email": row["email"], "drive_linked": row["drive_linked"]}), 200
    except Exception:
        logging.exception("/me error")
        return jsonify({"error": "Internal error"}), 500
    finally:
        conn.close()

# ---------------- Google OAuth endpoints ----------------
@app.route("/auth/google/start", methods=["GET"])
def google_auth_start():
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return jsonify({"error": "Google OAuth not configured"}), 500

    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required (login first)"}), 401

    state = make_oauth_state(user_id)
    redirect_uri = effective_redirect_uri()
    logging.info(f"google_auth_start redirect_uri={redirect_uri} user={user_id}")

    flow = Flow.from_client_config(
        build_client_config(),
        scopes=["https://www.googleapis.com/auth/drive.file", "openid", "email", "profile"],
        redirect_uri=redirect_uri
    )

    auth_url, _ = flow.authorization_url(access_type="offline", include_granted_scopes="true", prompt="consent", state=state)
    return jsonify({"auth_url": auth_url, "redirect_uri": redirect_uri})

@app.route("/auth/google/callback", methods=["GET"])
def google_auth_callback():
    logging.info(f"Callback received: request.scheme={request.scheme} request.url={request.url} headers_proto={request.headers.get('X-Forwarded-Proto')}")

    if "error" in request.args:
        logging.error(f"Google OAuth returned error param: error={request.args.get('error')} description={request.args.get('error_description')}")
        return redirect((FRONTEND_URL or "/") + "?google_link_error=1")

    state = request.args.get("state")
    if not state:
        logging.warning("OAuth callback missing state")
        return redirect((FRONTEND_URL or "/") + "?google_link_error=1")

    user_id = verify_oauth_state(state)
    if not user_id:
        logging.warning("OAuth callback state invalid or expired")
        return redirect((FRONTEND_URL or "/") + "?google_link_error=1")

    redirect_uri = effective_redirect_uri()
    logging.info(f"google_auth_callback redirect_uri={redirect_uri} for user={user_id}")

    flow = Flow.from_client_config(
        build_client_config(),
        scopes=["https://www.googleapis.com/auth/drive.file", "openid", "email", "profile"],
        redirect_uri=redirect_uri
    )
    try:
        flow.fetch_token(authorization_response=request.url)
        creds = flow.credentials
    except Exception:
        logging.exception("Error fetching token from Google (fetch_token failed). Attempting manual token exchange fallback.")
        code = request.args.get("code")
        if not code:
            logging.error("No code param present in callback; cannot perform manual exchange.")
            return redirect((FRONTEND_URL or "/") + "?google_link_error=1")

        token_uri = flow.client_config["web"].get("token_uri", "https://oauth2.googleapis.com/token")
        payload = {
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code"
        }
        try:
            resp = requests.post(token_uri, data=payload, headers={"Accept": "application/json"}, timeout=10)
        except Exception as e:
            logging.exception(f"Manual token exchange request failed: {e}")
            return redirect((FRONTEND_URL or "/") + "?google_link_error=1")

        if resp.status_code != 200:
            logging.error(f"Manual token exchange failed: status={resp.status_code} body={resp.text}")
            return redirect((FRONTEND_URL or "/") + "?google_link_error=1")

        token_resp = resp.json()
        access_token = token_resp.get("access_token")
        refresh_token = token_resp.get("refresh_token")
        token_uri_resp = token_resp.get("token_uri", token_uri)
        scope_str = token_resp.get("scope") or request.args.get("scope", "")
        scopes = scope_str.split() if isinstance(scope_str, str) and scope_str else None

        if not access_token:
            logging.error(f"Manual token exchange returned no access_token: {token_resp}")
            return redirect((FRONTEND_URL or "/") + "?google_link_error=1")

        creds = Credentials(
            token=access_token,
            refresh_token=refresh_token,
            token_uri=token_uri_resp,
            client_id=GOOGLE_CLIENT_ID,
            client_secret=GOOGLE_CLIENT_SECRET,
            scopes=scopes
        )

    has_refresh = getattr(creds, "refresh_token", None) is not None
    logging.info(f"Token exchange OK for user {user_id}. refresh_token_present={has_refresh}")

    conn = get_db_connection()
    if not conn:
        logging.error("DB connection failed while saving google creds")
        return redirect((FRONTEND_URL or "/") + "?google_link_error=1")
    try:
        user_id_int = int(user_id)
        creds_json = creds_to_json(creds)
        if not creds_json:
            logging.error("Failed to serialize credentials")
            return redirect((FRONTEND_URL or "/") + "?google_link_error=1")

        with conn.cursor() as cur:
            cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (creds_json, user_id_int))
        conn.commit()
        logging.info(f"Saved Google creds for user {user_id_int} (refresh_token_present={has_refresh})")
        return redirect((FRONTEND_URL or "/") + "?google_link_success=1")
    except Exception:
        logging.exception("Saving google creds error")
        return redirect((FRONTEND_URL or "/") + "?google_link_error=1")
    finally:
        conn.close()

# ---------------- Notes endpoints ----------------
@app.route("/save", methods=["POST"])
def save_text():
    user_id = get_user_id_from_request(request)
    if not user_id:
        return jsonify({"error": "Authorization required"}), 401
    data = request.get_json() or {}
    filename = data.get("filename")
    content = data.get("content", "")
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title required"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"error": "Database connection failed"}), 500

    try:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT google_creds_json FROM users WHERE id = %s", (int(user_id),))
            row = cur.fetchone()
            creds_json = row["google_creds_json"] if row else None
            drive_file_id = None

            if filename:
                cur.execute("SELECT drive_file_id FROM notes WHERE filename = %s AND user_id = %s", (filename, int(user_id)))
                r = cur.fetchone()
                existing_drive_id = r["drive_file_id"] if r else None

                if creds_json:
                    service, refreshed_creds = get_drive_service_from_creds_json(creds_json)
                    if service:
                        drive_file_id = upload_or_update_file(service, filename, content, existing_file_id=existing_drive_id)
                        if refreshed_creds and getattr(refreshed_creds, "refresh_token", None):
                            upd = creds_to_json(refreshed_creds)
                            if upd:
                                cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (upd, int(user_id)))

                cur.execute("""
                    UPDATE notes
                    SET filecontent = %s, title = %s, drive_file_id = COALESCE(%s, drive_file_id)
                    WHERE filename = %s AND user_id = %s
                """, (content, title, drive_file_id, filename, int(user_id)))
                message = "Note updated"
            else:
                filename = f"note_{int(datetime.now(timezone.utc).timestamp())}_{user_id}.txt"
                if creds_json:
                    service, refreshed_creds = get_drive_service_from_creds_json(creds_json)
                    if service:
                        drive_file_id = upload_or_update_file(service, filename, content)
                        if refreshed_creds and getattr(refreshed_creds, "refresh_token", None):
                            upd = creds_to_json(refreshed_creds)
                            if upd:
                                cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (upd, int(user_id)))
                cur.execute("""
                    INSERT INTO notes (user_id, filename, filecontent, title, drive_file_id)
                    VALUES (%s, %s, %s, %s, %s)
                """, (int(user_id), filename, content, title, drive_file_id))
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
            """, (int(user_id),))
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
            cur.execute("SELECT filename, drive_file_id FROM notes WHERE user_id = %s AND filename = ANY(%s)", (int(user_id), filenames))
            items = cur.fetchall()
            cur.execute("SELECT google_creds_json FROM users WHERE id = %s", (int(user_id),))
            row = cur.fetchone()
            creds_json = row["google_creds_json"] if row else None
            service = None
            if creds_json:
                service, refreshed_creds = get_drive_service_from_creds_json(creds_json)
                if refreshed_creds and getattr(refreshed_creds, "refresh_token", None):
                    upd = creds_to_json(refreshed_creds)
                    if upd:
                        cur.execute("UPDATE users SET google_creds_json = %s WHERE id = %s", (upd, int(user_id)))
            deleted_count = 0
            for it in items:
                if it["drive_file_id"] and service:
                    if delete_drive_file(service, it["drive_file_id"]):
                        deleted_count += 1
            cur.execute("DELETE FROM notes WHERE user_id = %s AND filename = ANY(%s)", (int(user_id), filenames))
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
    return jsonify({"status": "ok", "backend_url": BACKEND_URL or request.url_root}), 200

# ---------------- Run server ----------------
if __name__ == "__main__":
    with app.app_context():
        init_db()
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)
