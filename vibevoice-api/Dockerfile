FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --default-timeout=1000 --retries=20 --no-cache-dir -r requirements.txt

RUN git clone -q --depth 1 https://github.com/microsoft/VibeVoice.git /app/VibeVoice
RUN cd /app/VibeVoice && pip3 install -e .

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
