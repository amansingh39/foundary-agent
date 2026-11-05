# Agent chat

A public chat page for the Foundry agent `authsec-iga-agent-test`.

```
visitor's browser ──(no Azure sign-in)──▶ this app ──(the app's own Azure identity)──▶ Foundry agent
                                                                                        └─ tools run as the project identity
```

The agent is called through the project endpoint (as Foundry's "Continue in
code" does) and is **not published**, so its tools keep running as the project
identity that the AuthSec access policies block.

## What the server does for production

- Azure sign-in with its managed identity on App Service; nothing secret in code or settings.
- Rate limits: per visitor address (`CHAT_RATE_PER_IP`) and for everyone per UTC day (`CHAT_DAILY_LIMIT`), so a public link cannot run up the model bill.
- Errors give the visitor a short message and a reference; the details are in the log under that reference.
- Security headers (CSP with no inline script, no framing, HSTS on HTTPS), 64 KB request limit, message length limit.
- One log line per message: reference, address, conversation, tools used and their status, time taken (not the message text).
- `/healthz` for App Service's health check.

## Settings (App Service → Environment variables; all optional)

| Variable | Default | |
|---|---|---|
| `FOUNDRY_PROJECT_ENDPOINT` | the authsec-agent-iga-project-test-01 project | |
| `FOUNDRY_AGENT_NAME` | `authsec-iga-agent-test` | |
| `CHAT_PASSCODE` | none | set it to make visitors type a code |
| `CHAT_RATE_PER_IP` | `20/600` | messages / seconds, per visitor |
| `CHAT_DAILY_LIMIT` | `1000` | messages per UTC day, all visitors; `0` = no limit |
| `CHAT_MASK_VALUES` | `true` | `false` shows Key Vault values in "Tool result" |
| `CHAT_AGENT_TIMEOUT` | `150` | seconds to wait for the agent |

## Deploy to App Service (Free F1)

1. App Services → Create → Web App: Python 3.12, Linux, plan **Free F1**.
2. Web app → **Identity** → System assigned → **On** → Save.
3. Foundry resource `authsec-agent-iga-proje-resource` → **Access control (IAM)** → Add role assignment →
   **Foundry User** (Azure AI User) → Managed identity → App Service → your app.
4. Web app → **Environment variables** → add `SCM_DO_BUILD_DURING_DEPLOYMENT` = `true`.
5. Web app → **Configuration** → Startup Command: `gunicorn --config gunicorn.conf.py app:app` → Save.
6. Web app → **Configuration** → General settings → **HTTPS Only: On**.
7. Web app → **Health check** → path `/healthz`.
8. Deploy from GitHub with `.github/workflows/deploy.yml` (OpenID Connect, no stored password):
   - A user-assigned managed identity in the resource group, with a federated credential
     (GitHub Actions; `amansingh39` / `foundary-agent`, entity Branch `main`) and the
     **Website Contributor** role on the web app.
   - Repository variables (Settings → Secrets and variables → Actions → Variables):
     `AZURE_CLIENT_ID` (the identity's client ID), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
   - Every push to `main` runs the tests, deploys, and waits for `/healthz` to answer.
9. Open the app's **Default domain** from its Overview page.

`.github/workflows/test.yml` runs the tests on other branches and pull requests.
(The Kudu drag-and-drop zip page does not exist on Linux; a one-off deploy is
`az webapp deploy -g <group> -n <app> --src-path <zip> --type zip`.)

Logs: web app → **Log stream**.

## Run on your machine (PowerShell)

```powershell
cd C:\Users\amank\Desktop\agent-chat
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:CHAT_BROWSER_LOGIN="1"     # or skip it after `az login`
python app.py
```

Open http://localhost:8080. Tests: `python -m unittest discover -s tests`.

## Testing enforcement

Ask a prompt, block that resource for the project identity in AuthSec, wait for
the policy to be Active plus Azure's propagation (usually a few minutes, up to
about 10), then start a **New chat** and ask again. Open "Tool result": a value
means the call got through, `Forbidden` / not authorized means the block holds.
In the same chat the agent may repeat what it fetched earlier without calling
the tool, so always start a new chat after a change.
