# Standard Python image for EC2 / ECS-on-EC2 — not the AWS Lambda base image.
# Target Python version: 3.12 (confirm with your team before changing the tag).
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    COMPARISON_HOST=0.0.0.0 \
    COMPARISON_PORT=8080 \
    COMPARISON_DOWNLOAD_DIR=/tmp/comparison-engine

RUN useradd --create-home --system --uid 10001 appuser \
    && mkdir -p /tmp/comparison-engine \
    && chown -R appuser:appuser /app /tmp/comparison-engine

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY comparison_engine ./comparison_engine
COPY app ./app

RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
