# The mock as a container, for a client's CI or a compose file. It listens on 0.0.0.0 inside the
# container; publish the port only where the controls (which have no sign-in) are safe to reach.
FROM node:24-alpine
WORKDIR /mock
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY bin ./bin
COPY src ./src
ENV HOST=0.0.0.0 PORT=5180 LOG_FORMAT=json LOG_LEVEL=info
EXPOSE 5180
USER node
CMD ["node", "bin/steward-mock-server.mjs"]
