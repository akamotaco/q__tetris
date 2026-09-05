# 런타임 의존성 0 — Node 24 슬림 하나면 충분
FROM node:24-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=8787 NT_DATA=/app/data
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.js"]
