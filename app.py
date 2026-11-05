"""A public chat page for one Microsoft Foundry agent.

The browser talks to this server; the server calls the agent with its own
Azure identity (DefaultAzureCredential: the App Service managed identity once
hosted, `az login` or a one-time browser sign-in on your machine). Visitors
never sign in to Azure, and no key or token lives in this code.

The agent is called through the project endpoint, as Foundry's "Continue in
code" does, so it is NOT published and its tools keep running as the project
identity that the AuthSec access policies target.
"""

import hmac
import json
import logging
import os
import re
import threading
import time
import uuid
from collections import deque

import openai
from azure.ai.projects import AIProjectClient
from azure.core.exceptions import ClientAuthenticationError
from azure.identity import (
    AuthenticationRecord,
    DefaultAzureCredential,
    InteractiveBrowserCredential,
    TokenCachePersistenceOptions,
)
from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        raise SystemExit(f"{name} must be a whole number")


def env_rate(name, default):
    """"<count>/<seconds>", e.g. 20/600 is 20 messages per 10 minutes."""
    raw = os.environ.get(name, default)
    m = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", raw)
    if not m or int(m[2]) == 0:
        raise SystemExit(f"{name} must look like 20/600 (messages/seconds)")
    return int(m[1]), int(m[2])


ENDPOINT = os.environ.get(
    "FOUNDRY_PROJECT_ENDPOINT",
    "https://authsec-agent-iga-proje-resource.services.ai.azure.com/api/projects/authsec-agent-iga-project-test-01",
)
AGENT = os.environ.get("FOUNDRY_AGENT_NAME", "authsec-iga-agent-test")
PASSCODE = os.environ.get("CHAT_PASSCODE", "")  # empty: the page is open to anyone
# Editing the shared prompt catalog; empty: nobody can edit it.
ADMIN_PASSCODE = os.environ.get("CHAT_ADMIN_PASSCODE", "")
RATE_COUNT, RATE_WINDOW = env_rate("CHAT_RATE_PER_IP", "40/600")
DAILY_LIMIT = env_int("CHAT_DAILY_LIMIT", 1000)  # every visitor together; 0 = no limit
MASK_VALUES = os.environ.get("CHAT_MASK_VALUES", "true").lower() != "false"
AGENT_TIMEOUT = env_int("CHAT_AGENT_TIMEOUT", 150)  # seconds; under gunicorn's timeout
ON_APP_SERVICE = bool(os.environ.get("WEBSITE_SITE_NAME"))

HERE = os.path.dirname(os.path.abspath(__file__))
# Kept outside the deployed code so a deploy does not wipe the catalog;
# /home survives restarts on App Service.
DATA_DIR = os.environ.get("CHAT_DATA_DIR") or (
    "/home/data/agent-chat" if ON_APP_SERVICE else os.path.join(HERE, "data")
)

try:  # the commit the deploy workflow packaged
    with open(os.path.join(HERE, "build.txt"), encoding="utf-8") as f:
        BUILD = f.read().strip()
except OSError:
    BUILD = "local"

MAX_MESSAGE = 4000
MAX_OUTPUT = 3000
SCOPE = "https://ai.azure.com/.default"
RECORD = os.path.join(HERE, ".auth-record.json")
CONVERSATION_ID = re.compile(r"^[A-Za-z0-9_\-]{1,200}$")
SECRET_VALUE = re.compile(r'("value"\s*:\s*")((?:[^"\\]|\\.)*)(")')
# What Azure data planes answer when a role is missing: Key Vault
# "Forbidden", Storage "AuthorizationPermissionMismatch", ARM
# "AuthorizationFailed", or a bare 401/403 status.
DENIED = re.compile(
    r"forbidden|unauthori[sz]ed|authorizationfailed|authenticationfailed|authorizationpermissionmismatch"
    r"|permission ?denied|access ?denied|does not have (?:authorization|permission)"
    r"|\b(?:http|status|code|error)\W{0,4}40[13]\b|\b40[13] (?:forbidden|unauthorized)",
    re.I,
)
MAX_PROMPTS = 100
PROMPT_ID = re.compile(r"^[a-z0-9]{1,16}$")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("agent-chat")

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024
if ON_APP_SERVICE:
    # App Service's front end adds one X-Forwarded-For / -Proto hop; trust
    # that one only, so a visitor cannot pick their own address.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)


class Limiter:
    """Messages per visitor address in a sliding window, and per UTC day for
    everyone together. In memory, so run one gunicorn worker."""

    def __init__(self, count, window, daily):
        self.count, self.window, self.daily = count, window, daily
        self.lock = threading.Lock()
        self.hits = {}
        self.day, self.today = None, 0

    def take(self, who, now=None):
        """None when the message may go, else the seconds to wait."""
        now = time.time() if now is None else now
        with self.lock:
            day = int(now // 86400)
            if day != self.day:
                self.day, self.today = day, 0
            if self.daily and self.today >= self.daily:
                return int((day + 1) * 86400 - now) + 1
            q = self.hits.setdefault(who, deque())
            while q and q[0] <= now - self.window:
                q.popleft()
            if len(q) >= self.count:
                return int(q[0] + self.window - now) + 1
            q.append(now)
            self.today += 1
            if len(self.hits) > 10000:
                self.hits = {k: v for k, v in self.hits.items() if v and v[-1] > now - self.window}
            return None


limiter = Limiter(RATE_COUNT, RATE_WINDOW, DAILY_LIMIT)


class Catalog:
    """The shared list of test prompts: a JSON file, written whole and
    atomically. Until someone edits it, the list is the defaults file."""

    def __init__(self, path, defaults):
        self.path, self.defaults = path, defaults
        self.lock = threading.Lock()

    def _read(self):
        for p in (self.path, self.defaults):
            try:
                with open(p, encoding="utf-8") as f:
                    return json.load(f)
            except FileNotFoundError:
                continue
        return []

    def _write(self, prompts):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(prompts, f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.path)

    def all(self):
        with self.lock:
            return self._read()

    def add(self, fields):
        with self.lock:
            prompts = self._read()
            if len(prompts) >= MAX_PROMPTS:
                raise ValueError(f"The catalog holds at most {MAX_PROMPTS} prompts.")
            prompt = {"id": uuid.uuid4().hex[:8], **fields}
            prompts.append(prompt)
            self._write(prompts)
            return prompt

    def update(self, pid, fields):
        with self.lock:
            prompts = self._read()
            for p in prompts:
                if p["id"] == pid:
                    p.update(fields)
                    self._write(prompts)
                    return p
            return None

    def delete(self, pid):
        with self.lock:
            prompts = self._read()
            kept = [p for p in prompts if p["id"] != pid]
            if len(kept) == len(prompts):
                return False
            self._write(kept)
            return True

    def reset(self):
        with self.lock:
            try:
                os.remove(self.path)
            except FileNotFoundError:
                pass
            return self._read()


catalog = Catalog(os.path.join(DATA_DIR, "prompts.json"), os.path.join(HERE, "prompts_default.json"))


def prompt_fields(body):
    """title, resource and text from a request, checked; raises ValueError."""
    if not isinstance(body, dict):
        raise ValueError("Send JSON with title, resource and text.")
    fields = {k: str(body.get(k) or "").strip() for k in ("title", "resource", "text")}
    if not fields["title"] or not fields["text"]:
        raise ValueError("A prompt needs a title and its text.")
    if len(fields["title"]) > 120 or len(fields["resource"]) > 160:
        raise ValueError("Keep the title under 120 characters and the resource under 160.")
    if len(fields["text"]) > MAX_MESSAGE:
        raise ValueError(f"Keep the prompt under {MAX_MESSAGE} characters.")
    return fields

_client = None
_client_lock = threading.Lock()
# The SDK names the agent in the request body; versions differ on the key.
# The first one that works is kept.
_agent_key = None


def browser_credential():
    """Browser sign-in, once (local use only). The tokens go to the
    Windows-encrypted token cache and the account to RECORD (no secret in
    it), so neither later messages nor a restart ask again."""
    record = None
    if os.path.exists(RECORD):
        with open(RECORD, encoding="utf-8") as f:
            record = AuthenticationRecord.deserialize(f.read())
    cred = InteractiveBrowserCredential(
        tenant_id=os.environ.get("AZURE_TENANT_ID") or None,
        cache_persistence_options=TokenCachePersistenceOptions(name="agent-chat"),
        authentication_record=record,
    )
    if record is None:
        log.info("signing in: a browser tab opens")
        record = cred.authenticate(scopes=[SCOPE])
        with open(RECORD, "w", encoding="utf-8") as f:
            f.write(record.serialize())
    return cred


def credential():
    if os.environ.get("CHAT_BROWSER_LOGIN") == "1" and not ON_APP_SERVICE:
        return browser_credential()
    return DefaultAzureCredential(exclude_interactive_browser_credential=True)


def openai_client():
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                project = AIProjectClient(endpoint=ENDPOINT, credential=credential(), allow_preview=True)
                _client = project.get_openai_client().with_options(timeout=AGENT_TIMEOUT, max_retries=1)
    return _client


def ask(client, conversation_id, text):
    global _agent_key
    keys = [_agent_key] if _agent_key else ["agent_reference", "agent"]
    first = None
    for key in keys:
        try:
            response = client.responses.create(
                conversation=conversation_id,
                input=text,
                extra_body={key: {"name": AGENT, "type": "agent_reference"}},
            )
        except openai.BadRequestError as e:
            first = first or e
            continue
        _agent_key = key
        return response
    # The first key's error: a tool's 400 must not turn into "unknown key".
    raise first


def masked(s):
    return s[:4] + f"… ({len(s) - 4} more characters hidden)" if len(s) > 4 else "****"


def shown(output):
    """A tool's result for the page: string "value" fields (a Key Vault
    secret's value) are masked unless CHAT_MASK_VALUES=false, and the text is
    cut to MAX_OUTPUT."""
    if output is None:
        return ""
    text = output if isinstance(output, str) else json.dumps(output, indent=2)
    if MASK_VALUES:
        text = SECRET_VALUE.sub(lambda m: m[1] + masked(m[2]) + m[3], text)
    return text if len(text) <= MAX_OUTPUT else text[:MAX_OUTPUT] + "\n… (cut)"


def verdict(status, output, error=None):
    """allowed / denied from what the tool got back, failed when the call did
    not finish, unknown when Foundry shows no result (built-in tools)."""
    raw = "" if output is None else output if isinstance(output, str) else json.dumps(output)
    if error:
        raw += " " + (error if isinstance(error, str) else json.dumps(error))
    if raw.strip():
        return "denied" if DENIED.search(raw) else "allowed"
    if status in ("failed", "incomplete"):
        return "failed"
    return "unknown"


def tool_calls(response):
    """What the agent called, what each call returned, and whether Azure let
    it through."""
    calls, by_id = [], {}
    for item in response.output or []:
        d = item.model_dump() if hasattr(item, "model_dump") else dict(item)
        kind = d.get("type", "")
        if kind in ("message", "reasoning"):
            continue
        name = next(
            (d[k] for k in ("name", "operation_id", "tool_name", "server_label") if isinstance(d.get(k), str)),
            "",
        )
        if kind.endswith("_output"):
            # The result of a call listed before it: attach it there.
            call = by_id.get(d.get("call_id"))
            if call is None:
                call = {"type": kind[: -len("_output")], "name": name, "status": d.get("status") or ""}
                calls.append(call)
            call["output"] = shown(d.get("output"))
            call["verdict"] = verdict(call["status"], d.get("output"), d.get("error"))
            continue
        call = {"type": kind, "name": name, "status": d.get("status") or ""}
        if d.get("output") is not None:
            call["output"] = shown(d.get("output"))
        call["verdict"] = verdict(call["status"], d.get("output"), d.get("error"))
        calls.append(call)
        for key in ("call_id", "id"):
            if d.get(key):
                by_id[d[key]] = call
    return calls


UPSTREAM_STATUS = re.compile(r"HTTP error (\d{3})")


def upstream(message):
    """The status a tool's own HTTP call got, when Foundry reports it inside
    its 400: 401/403 is Azure refusing the identity (denied); any other
    status (409 Conflict, 404) means the call got past authorization."""
    m = UPSTREAM_STATUS.search(message or "")
    if not m:
        return None, None
    status = int(m[1])
    return status, "denied" if status in (401, 403) else "allowed"


def is_admin():
    given = request.headers.get("X-Admin-Passcode", "").encode()
    return bool(ADMIN_PASSCODE) and hmac.compare_digest(given, ADMIN_PASSCODE.encode())


def failure(status, message, **extra):
    """An error for the page. The details stay in the log under the request id."""
    return jsonify(error=message, reference=g.get("rid", ""), **extra), status


@app.before_request
def start():
    g.rid = uuid.uuid4().hex[:12]
    g.t0 = time.monotonic()


@app.after_request
def headers(resp):
    resp.headers["X-Request-Id"] = g.get("rid", "")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
    resp.headers["Cache-Control"] = "no-store" if request.path.startswith("/api/") else "no-cache"
    if request.is_secure:
        resp.headers["Strict-Transport-Security"] = "max-age=31536000"
    return resp


@app.errorhandler(413)
def too_large(_):
    return failure(413, "That message is too large.")


@app.errorhandler(404)
def not_found(_):
    return failure(404, "Not found.")


@app.errorhandler(Exception)
def unexpected(e):
    if hasattr(e, "code") and isinstance(getattr(e, "code"), int):
        return failure(e.code, getattr(e, "description", "Request failed."))
    log.exception("rid=%s unexpected error", g.get("rid"))
    return failure(500, "Something went wrong on the server.")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/healthz")
def healthz():
    """Liveness for App Service's health check; does not call Azure. The
    version lets the deploy workflow see that its own commit is running."""
    return jsonify(status="ok", version=BUILD)


@app.get("/api/config")
def config():
    return jsonify(agent=AGENT, passcode=bool(PASSCODE), editable=bool(ADMIN_PASSCODE))


@app.get("/api/prompts")
def list_prompts():
    return jsonify(prompts=catalog.all(), editable=bool(ADMIN_PASSCODE))


@app.post("/api/admin/check")
def admin_check():
    """Lets the page tell a wrong admin passcode before any edit."""
    if not is_admin():
        return failure(403, "Wrong admin passcode." if ADMIN_PASSCODE else "Editing is turned off on this server.")
    return jsonify(ok=True)


@app.post("/api/prompts")
def add_prompt():
    if not is_admin():
        return failure(403, "Editing needs the admin passcode.")
    try:
        prompt = catalog.add(prompt_fields(request.get_json(silent=True)))
    except ValueError as e:
        return failure(400, str(e))
    log.info("rid=%s prompt added %s", g.rid, prompt["id"])
    return jsonify(prompt=prompt), 201


@app.put("/api/prompts/<pid>")
def update_prompt(pid):
    if not is_admin():
        return failure(403, "Editing needs the admin passcode.")
    if not PROMPT_ID.match(pid):
        return failure(404, "No such prompt.")
    try:
        prompt = catalog.update(pid, prompt_fields(request.get_json(silent=True)))
    except ValueError as e:
        return failure(400, str(e))
    if prompt is None:
        return failure(404, "No such prompt.")
    log.info("rid=%s prompt updated %s", g.rid, pid)
    return jsonify(prompt=prompt)


@app.delete("/api/prompts/<pid>")
def delete_prompt(pid):
    if not is_admin():
        return failure(403, "Editing needs the admin passcode.")
    if not PROMPT_ID.match(pid) or not catalog.delete(pid):
        return failure(404, "No such prompt.")
    log.info("rid=%s prompt deleted %s", g.rid, pid)
    return "", 204


@app.post("/api/prompts/reset")
def reset_prompts():
    if not is_admin():
        return failure(403, "Editing needs the admin passcode.")
    log.info("rid=%s prompts reset to defaults", g.rid)
    return jsonify(prompts=catalog.reset())


@app.post("/api/chat")
def chat():
    if PASSCODE:
        given = request.headers.get("X-Passcode", "").encode()
        if not hmac.compare_digest(given, PASSCODE.encode()):
            return failure(401, "Wrong passcode.")

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return failure(400, "Send JSON with a message.")
    message = str(body.get("message") or "").strip()
    conversation_id = str(body.get("conversation_id") or "")
    if not message:
        return failure(400, "Type a message.")
    if len(message) > MAX_MESSAGE:
        return failure(400, f"Keep the message under {MAX_MESSAGE} characters.")
    if conversation_id and not CONVERSATION_ID.match(conversation_id):
        return failure(400, "Unknown conversation; start a new chat.")

    who = request.remote_addr or "unknown"
    wait = limiter.take(who)
    if wait is not None:
        resp, status = failure(429, f"Too many messages. Try again in {wait} seconds.", retry_after=wait)
        resp.headers["Retry-After"] = str(wait)
        return resp, status

    try:
        client = openai_client()
        if not conversation_id:
            conversation_id = client.conversations.create().id
        response = ask(client, conversation_id, message)
    except ClientAuthenticationError:
        log.exception("rid=%s no Azure credential", g.rid)
        return failure(500, "The server cannot sign in to Azure. Check its managed identity (or `az login` when local).")
    except openai.PermissionDeniedError as e:
        log.warning("rid=%s agent call refused: %s", g.rid, e.message)
        return failure(403, "Azure refused the call: the server's identity needs the Foundry User (Azure AI User) role on the project.")
    except openai.NotFoundError as e:
        log.warning("rid=%s not found: %s", g.rid, e.message)
        return failure(404, "The agent or this conversation was not found. Start a new chat.")
    except openai.BadRequestError as e:
        # Foundry answers 400 when a tool cannot be called as its OpenAPI
        # spec says, and also when the tool's own HTTP call failed: then the
        # message carries "HTTP error <status>" and the upstream body.
        log.warning("rid=%s agent call rejected: %s", g.rid, e.message)
        status, tool_verdict = upstream(e.message)
        return failure(400, f"Foundry rejected the request: {e.message[:2000]}",
                       upstream_status=status, verdict=tool_verdict)
    except openai.RateLimitError as e:
        log.warning("rid=%s Foundry rate limit: %s", g.rid, e.message)
        return failure(503, "The model is busy. Try again in a minute.")
    except openai.APITimeoutError:
        log.warning("rid=%s agent call timed out after %ss", g.rid, AGENT_TIMEOUT)
        return failure(504, "The agent took too long to answer. Try again.")
    except openai.APIConnectionError:
        log.exception("rid=%s cannot reach Foundry", g.rid)
        return failure(502, "Cannot reach the agent right now.")
    except openai.APIStatusError as e:
        log.warning("rid=%s agent call failed %s: %s", g.rid, e.status_code, e.message)
        return failure(502, f"The agent call failed ({e.status_code}).")

    tools = tool_calls(response)
    log.info(
        "rid=%s ip=%s conversation=%s chars=%d tools=%s ms=%d",
        g.rid, who, conversation_id, len(message),
        ",".join(f"{c['name'] or c['type']}:{c['verdict']}" for c in tools) or "-",
        (time.monotonic() - g.t0) * 1000,
    )
    return jsonify(reply=response.output_text or "", conversation_id=conversation_id, tools=tools)


if __name__ == "__main__":
    port = env_int("PORT", 8080)
    log.info("agent %s at %s", AGENT, ENDPOINT)
    openai_client()  # sign in now, not on the first message
    log.info("open http://localhost:%d", port)
    app.run(host="127.0.0.1", port=port, threaded=True)
