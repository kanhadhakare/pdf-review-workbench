FROM pdf2htmlex/pdf2htmlex:0.18.8.rc2-master-20200820-alpine-3.12.0-x86_64

RUN apk add --no-cache nodejs

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV PORT=4010
EXPOSE 4010
ENTRYPOINT ["node", "src/server.js"]
