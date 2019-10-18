FROM node:dubnium-alpine AS build-env

# Configure the environment
ARG NPM_TOKEN

# Install build dependencies (marked as 'build-dependencies' group)
#RUN if [ -f /etc/alpine-release ]; then apk add --no-cache --virtual build-dependencies git bash gcc g++ python make openssl-dev lz4-dev zlib-dev; fi

WORKDIR /app

# Install the application
RUN mkdir -p /app
ADD package.json tsconfig.json /app/
ADD src /app/src

# Configure NPM
RUN npm config set progress=false
RUN npm config set //registry.npmjs.org/:_authToken=${NPM_TOKEN}

# Install dependencies and build
RUN ls -al
RUN npm install
RUN npm run build

#
# Create actual runtime environment
#
FROM node:dubnium-alpine

ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}
ENV LOG4JS_CONFIG=/app/log4js.json

# Install runtime dependencies
#RUN if [ -f /etc/alpine-release ]; then apk add --no-cache openssl lz4-libs zlib-dev; fi

WORKDIR /app
COPY --from=build-env /app/package.json /app/
COPY --from=build-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
ADD log4js.json /app/log4js.json
RUN npm prune

EXPOSE 8080
ENTRYPOINT ["npm", "start", "--"]
