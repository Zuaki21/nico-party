# サーバー（Node）の Docker イメージ。リポジトリのルートを context にしてビルドする（shared/ も使うため）
#   docker build -f server/Dockerfile .
# arm64（OCI の VM.Standard.A1）でも動くよう、公式の node イメージだけを使う
FROM node:22-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci
COPY shared shared
COPY server server
RUN cd server && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    ROOMS_FILE=/data/rooms.json \
    CLIENT_LOG_FILE=/data/client-logs.jsonl
COPY --from=build /app/server/dist/main.js ./main.js
# 停止するときに部屋を書き出す場所（ボリュームを割り当てる）
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "main.js"]
