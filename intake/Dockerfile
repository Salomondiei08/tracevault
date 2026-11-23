FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev
COPY dist ./dist

ENV PORT=8080
EXPOSE 8080

CMD ["node", "--no-warnings", "dist/intake/cli.js"]
