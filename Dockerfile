FROM nousresearch/hermes-agent:main@sha256:5c83f2b25058c3b28ddaa72fb67d571341639e9d813d72aff9e2ad10a8ee8c68

RUN uv pip install --python /opt/hermes/.venv/bin/python --no-cache "python-telegram-bot[webhooks]==22.6" && \
    /opt/hermes/.venv/bin/python -c "import openai, pathlib; p = pathlib.Path(openai.__file__).parent / 'lib/_parsing/_responses.py'; text = p.read_text(); old = 'for output in response.output:'; new = 'for output in (response.output or []):'; assert old in text or new in text, 'OpenAI Responses parser target line not found'; p.write_text(text.replace(old, new, 1) if new not in text else text)"

ENV HERMES_DASHBOARD=1 \
    HERMES_DASHBOARD_HOST=127.0.0.1 \
    HERMES_DASHBOARD_PORT=9119 \
    HERMES_DASHBOARD_TUI=1

COPY start-railway.sh /opt/hermes-railway/start-railway.sh
COPY dashboard-proxy.mjs /opt/hermes-railway/dashboard-proxy.mjs

# Railway public traffic is served by the Basic Auth proxy on $PORT.
# The official dashboard stays bound to localhost inside the container.
EXPOSE 8080 8642 9119

CMD ["bash", "/opt/hermes-railway/start-railway.sh"]
