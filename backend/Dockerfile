FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
  default-jdk \
  maven \
  python3 \
  python3-pip \
  libglib2.0-0 \
  libgl1 \
  libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY package*.json ./
RUN npm ci

COPY . ./

RUN mkdir -p /app/storage/uploads /app/storage/jobs /app/storage/fixes /app/storage/profiles /app/storage/models
RUN python3 -m pip install --no-cache-dir --break-system-packages paddleocr paddlepaddle
RUN npm run build && npm run build:pdfbox-font-extractor

ENV BACKEND_ROOT=/app/backend \
    WORKBENCH_ROOT=/app \
    STORAGE_ROOT=/app/storage \
    JAVA_BIN=/usr/bin/java \
    PYTHON_BIN=/usr/bin/python3 \
    PORT=3000

VOLUME ["/app/storage"]
EXPOSE 3000

CMD ["npm", "run", "start"]

