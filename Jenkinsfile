// ─────────────────────────────────────────────────────────────────────────────
//  Pipeline CI/CD SIGAP-Bansos API  —  untuk belajar Jenkins + Docker
// ─────────────────────────────────────────────────────────────────────────────
//
//  Versi ini SENGAJA tidak memakai plugin apa pun selain Docker CLI + compose v2
//  yang sudah ada di server. Semua tahap Node dijalankan lewat `docker run`
//  langsung, jadi tidak perlu plugin "Docker Pipeline".
//
//  Alur:
//    Metadata     → hitung tag image dari commit + nomor build
//    Quality      → npm ci + prisma generate + typecheck + unit test
//                   (semua di dalam container node:20-alpine, sekali jalan)
//    Docker image → build image produksi dari Dockerfile multi-stage
//    Deploy       → `docker compose up -d`  (branch main / develop)
//    Smoke test   → tunggu endpoint /health hijau
//
//  PRASYARAT di server Jenkins:
//    - Docker Engine + `docker compose` v2  (sudah ✓)
//    - user `jenkins` anggota grup `docker`  (sudah ✓)
//    - plugin "Credentials Binding" (bawaan Jenkins)
//
//  KREDENSIAL yang harus dibuat di Jenkins (Manage Jenkins → Credentials),
//  tipe "Secret text", ID harus persis:
//    sigap-jwt-secret          → JWT_SECRET        (`openssl rand -hex 32`)
//    sigap-system-pepper       → SYSTEM_PEPPER     (`openssl rand -hex 32`)
//    sigap-db-encryption-key   → DB_ENCRYPTION_KEY (`openssl rand -hex 32`)
//    sigap-postgres-password   → password Postgres (`openssl rand -hex 16`)
//
//  Kenapa serumit ini soal secret: src/common/env.validation.ts — di
//  NODE_ENV=production aplikasi menolak start kalau salah satu kosong.
// ─────────────────────────────────────────────────────────────────────────────

pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '15'))
    timeout(time: 30, unit: 'MINUTES')
  }

  environment {
    IMAGE_NAME   = 'sigap-api'
    COMPOSE_FILE = 'docker-compose.deploy.yml'
    NODE_IMAGE   = 'node:20-alpine'
  }

  stages {

    stage('Metadata') {
      steps {
        script {
          env.GIT_SHA   = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
          env.IMAGE_TAG = "${env.GIT_SHA}-b${env.BUILD_NUMBER}"
        }
        echo "Branch : ${env.BRANCH_NAME ?: env.GIT_BRANCH ?: 'n/a'}"
        echo "Commit : ${env.GIT_SHA}"
        echo "Image  : ${IMAGE_NAME}:${env.IMAGE_TAG}"
      }
    }

    stage('Quality') {
      steps {
        // Semua langkah Node jalan di dalam container sekali `docker run`:
        //   -v $WORKSPACE:/app  → source code ikut masuk
        //   -u <uid>:<gid>      → file hasil (node_modules) dimiliki user jenkins,
        //                          jadi `cleanWs()` di akhir tidak kena "permission denied"
        //   -e HOME=/tmp        → npm butuh HOME yang bisa ditulis
        //
        // `prisma generate` wajib sebelum `typecheck` (tipe Prisma Client dipakai
        // tsc). `npm test` di project ini murni in-memory, tanpa database.
        sh '''
          docker run --rm \
            -v "$WORKSPACE":/app -w /app \
            -u "$(id -u):$(id -g)" \
            -e HOME=/tmp \
            "$NODE_IMAGE" \
            sh -c "npm ci && npx prisma generate && npm run typecheck && npm test"
        '''
      }
    }

    stage('Docker image') {
      steps {
        // Dockerfile multi-stage: deps → builder (nest build) → runner.
        // .dockerignore membuang node_modules & dist host, jadi image ini bersih.
        sh 'docker build -t "$IMAGE_NAME:$IMAGE_TAG" -t "$IMAGE_NAME:latest" .'
      }
    }

    stage('Deploy') {
      when { expression { return shouldDeploy() } }
      steps {
        withCredentials([
          string(credentialsId: 'sigap-jwt-secret',        variable: 'JWT_SECRET'),
          string(credentialsId: 'sigap-system-pepper',      variable: 'SYSTEM_PEPPER'),
          string(credentialsId: 'sigap-db-encryption-key',  variable: 'DB_ENCRYPTION_KEY'),
          string(credentialsId: 'sigap-postgres-password',  variable: 'POSTGRES_PASSWORD'),
        ]) {
          // Container `sigap-api` menjalankan `prisma db push` + seed wilayah lalu
          // start (lihat CMD di Dockerfile) — idempoten, aman diulang tiap deploy.
          sh '''
            export IMAGE_TAG
            docker compose -f "$COMPOSE_FILE" up -d --remove-orphans
          '''
        }
      }
    }

    stage('Smoke test') {
      when { expression { return shouldDeploy() } }
      steps {
        sh '''
          echo "Menunggu API sehat di http://localhost:3001/health ..."
          for i in $(seq 1 40); do
            if curl -fsS http://localhost:3001/health >/dev/null 2>&1; then
              echo "OK - API merespons setelah $((i*3)) detik."
              exit 0
            fi
            sleep 3
          done
          echo "GAGAL - API tidak sehat setelah 120 detik. Log terakhir:"
          docker compose -f "$COMPOSE_FILE" logs --tail=120 sigap-api
          exit 1
        '''
      }
    }
  }

  post {
    success {
      echo "OK  ${IMAGE_NAME}:${env.IMAGE_TAG} berhasil dibangun" +
           (shouldDeploy() ? ' & dideploy.' : ' (stage deploy dilewati untuk branch ini).')
    }
    failure {
      echo "GAGAL  Pipeline merah - periksa stage di atas."
    }
    always {
      sh 'docker image prune -f || true'
    }
    cleanup {
      cleanWs()
    }
  }
}

// Deploy dijalankan bila:
//   - job "Pipeline" biasa tanpa info branch  → selalu deploy, ATAU
//   - branch-nya ada di daftar `deployable`.
boolean shouldDeploy() {
  def deployable = ['main', 'origin/main', 'develop', 'origin/develop']
  def b = env.BRANCH_NAME ?: env.GIT_BRANCH
  return (b == null) || deployable.contains(b)
}
