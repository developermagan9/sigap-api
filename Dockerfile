FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma/
RUN npx prisma generate

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY package.json ./

EXPOSE 3001
# Entry-point-nya `dist/src/main`, bukan `dist/main`: tsconfig.json meng-include
# `prisma/**/*` selain `src/**/*`, jadi rootDir tsc jadi root project dan output
# masuk ke dist/src. `node dist/main` di sini akan gagal MODULE_NOT_FOUND.
#
# `migrate deploy` di-skip kalau belum ada folder migrations (project ini memakai
# `prisma db push` untuk skema demo) — tanpa ini container berhenti sebelum start.
#
# `seed-wilayah` ikut dijalankan tiap start dan itu disengaja: isinya REFERENSI
# (91.599 wilayah administratif Kepmendagri), bukan data demo. Tanpa tabel itu
# admin tidak bisa mendaftarkan satu wilayah kerja pun dan seluruh pendataan
# buntu. Skripnya idempoten (~5 detik) dan membaca CSV dari `prisma/data/`, yang
# ikut tersalin ke image lewat COPY prisma di atas. `prisma/seed.ts` — data DEMO
# — sengaja TIDAK dijalankan di sini.
CMD ["sh", "-c", "([ -d prisma/migrations ] && npx prisma migrate deploy || npx prisma db push --skip-generate) && node dist/prisma/seed-wilayah.js && node dist/src/main"]
