FROM node@sha256:0f65470961851f2354dc8e560853e2f428ea928436135fc7e35780ab100c7e00

WORKDIR /opt/extract
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node index.js ./
COPY --chown=node:node request-log.js ./
COPY --chown=node:node public ./public
RUN mkdir -p logs && chown node:node logs

USER node
EXPOSE 3721
CMD ["node", "index.js"]
