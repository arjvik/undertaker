FROM node:alpine as build
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY src src
COPY tsconfig.json .
RUN npx tsc

FROM node:alpine
WORKDIR /app
COPY --from=build /app/build/ ./
COPY --from=build /app/node_modules/ ./node_modules/