FROM node:20-alpine
WORKDIR /app
# El server no usa dependencias externas (solo modulos nativos de Node)
COPY server/ ./server/
COPY index.html ./index.html
COPY manifest.json ./manifest.json
EXPOSE 5055
ENV PORT=5055
CMD ["node", "server/server.js"]
