# Owlshelf relay image (§15.18/O3).
#
# Runtime dependencies only: `requirements.txt` must never contain the test
# stack, and tests/test_dependencies.py fails if it does (G7).
FROM python:3.12-slim

# No build tools: every dependency here ships a manylinux wheel, and installing
# gcc "just in case" is 300 MB of attack surface for nothing.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py ./
COPY app ./app

# Non-root, and the log directory is the only writable path it needs. The relay
# keeps no state beyond memory, so there is nothing else to persist.
RUN useradd --system --uid 10001 --create-home relay \
    && mkdir -p /var/log/owlshelf \
    && chown -R relay:relay /var/log/owlshelf /srv
USER relay

# `--workers 1` is a correctness requirement, not a tuning choice: the room
# registry is process-local, so two workers split rooms permanently (§9, §9.1).
CMD ["python", "main.py"]

EXPOSE 8000
