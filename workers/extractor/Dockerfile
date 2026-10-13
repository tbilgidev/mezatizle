FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY workers/extractor/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY workers/extractor /app
ENV STORAGE_ROOT=/data/storage
CMD ["python3", "worker.py"]
