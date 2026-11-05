"""gunicorn settings for App Service (Linux). Start with:
    gunicorn --config gunicorn.conf.py app:app
"""

import os

bind = "0.0.0.0:" + os.environ.get("PORT", "8000")
# One process: the rate limits and the Azure client live in its memory.
# Threads carry the concurrency; agent calls are mostly waiting on Azure.
workers = 1
threads = int(os.environ.get("GUNICORN_THREADS", "8"))
timeout = 180  # above CHAT_AGENT_TIMEOUT (150)
graceful_timeout = 30
keepalive = 5
accesslog = "-"
errorlog = "-"
loglevel = "info"
