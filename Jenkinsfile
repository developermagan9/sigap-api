// ─────────────────────────────────────────────────────────────────────────────
//  Pipeline CI/CD SIGAP-Bansos API  —  untuk belajar Jenkins + Docker
// ─────────────────────────────────────────────────────────────────────────────
//
//  Alur:
//    Metadata      → hitung tag image dari commit + nomor build
//    Dependencies  → npm ci + prisma generate  (di dalam container node:20)
//    Quality       → typecheck + unit test, jalan paralel  (gagal = stop)
//    Docker image  → build image produksi dari Dockerfile multi-stage
//    Deploy        → hanya di branch `main`: `docker compose up -d`
//    Smoke test    → tunggu endpoint /health hijau, kalau tidak → rollback log
//
//  PRASYARAT di agent Jenkins:
//    - Docker Engine + plugin "Docker Pipeline" (untuk blok `docker.*`)
//    - `docker compose` v2 (bukan `docker-compose` lama)
//    - Plugin "Credentials Binding"
//
//  KREDENSIAL yang harus dibuat di Jenkins (Manage Jenkins → Credentials),
//  semuanya bertipe "Secret text":
//    sigap-jwt-secret           → JWT_SECRET        (>= 32 karakter acak)
//    sigap-system-pepper        → SYSTEM_PEPPER     (tepat 64 hex, `openssl rand -hex 32`)
//    sigap-db-encryption-key    → DB_ENCRYPTION_KEY (tepat 64 hex, `openssl rand -hex 32`)
//    sigap-postgres-password    → password Postgres di dalam compose deploy
//
//  Kenapa serumit ini soal secret: lihat src/common/env.validation.ts —
//  di NODE_ENV=production aplikasi SENGAJA menolak start kalau salah satu
//  variabel itu kosong / masih nilai contoh.
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
    // Stage lint/test/build jalan di dalam container ini, jadi agent Jenkins
    // cukup punya Docker — tidak perlu pasang Node/npm sendiri.
    NODE_IMAGE   = 'node:20-alpine'
  }

  stages {

    stage('Metadata') {
      steps {
        script {
          env.GIT_SHA   = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
          env.IMAGE_TAG = "${env.GIT_SHA}-b${env.BUILD_NUMBER}"
        }
        echo "Branch  : ${env.BRANCH_NAME ?: 'n/a'}"
        echo "Commit  : ${env.GIT_SHA}"
        echo "Image   : ${IMAGE_NAME}:${env.IMAGE_TAG}"
      }
    }

    stage('Dependencies') {
      agent { docker { image "${NODE_IMAGE}"; reuseNode true } }
      steps {
        sh 'node --version && npm --version'
        // `npm ci` = install deterministik dari package-lock.json.
        sh 'npm ci'
        // Prisma Client digenerate dari schema.prisma — tipe hasilnya dipakai
        // oleh `typecheck`, jadi harus jalan lebih dulu. Tidak butuh database.
        sh 'npx prisma generate'
      }
    }

    stage('Quality') {
      agent { docker { image "${NODE_IMAGE}"; reuseNode true } }
      parallel {
        stage('Typecheck') {
          steps { sh 'npm run typecheck' }
        }
        stage('Unit test') {
          steps { sh 'npm test' }
          // Jest di project ini murni in-memory (algoritma mining + Merkle),
          // tidak menyentuh Postgres — lihat jest.config.js.
        }
      }
    }

    stage('Docker image') {
      steps {
        // Dockerfile multi-stage: deps → builder (nest build) → runner.
        // .dockerignore membuang node_modules & dist milik host, jadi image
        // ini bersih dan tidak tergantung workspace di atas.
        sh "docker build -t ${IMAGE_NAME}:${env.IMAGE_TAG} -t ${IMAGE_NAME}:latest ."
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
          // IMAGE_TAG di-export supaya di-substitusi di docker-compose.deploy.yml.
          // Container `sigap-api` menjalankan `prisma db push` + seed wilayah
          // lalu start (lihat CMD di Dockerfile) — idempoten, aman diulang.
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
              echo "OK — API merespons setelah $((i*3)) detik."
              exit 0
            fi
            sleep 3
          done
          echo "GAGAL — API tidak sehat setelah 120 detik. Log terakhir:"
          docker compose -f "$COMPOSE_FILE" logs --tail=120 sigap-api
          exit 1
        '''
      }
    }
  }

  post {
    success {
      echo "✅ ${IMAGE_NAME}:${env.IMAGE_TAG} berhasil dibangun" +
           (shouldDeploy() ? ' & dideploy.' : ' (stage deploy dilewati untuk branch ini).')
    }
    failure {
      echo "❌ Pipeline gagal — periksa stage yang merah di atas."
    }
    always {
      // Bersihkan image dangling supaya disk agent tidak penuh.
      sh 'docker image prune -f || true'
    }
    cleanup {
      cleanWs()
    }
  }
}

// Deploy dijalankan bila:
//   - job "Pipeline" biasa (tanpa info branch) → selalu deploy, ATAU
//   - branch-nya `main` (multibranch pipeline / GIT_BRANCH = origin/main).
// Ubah daftar `deployable` di bawah kalau mau menambah branch (mis. 'develop').
boolean shouldDeploy() {
  def deployable = ['main', 'origin/main', 'develop', 'origin/develop']
  def b = env.BRANCH_NAME ?: env.GIT_BRANCH
  return (b == null) || deployable.contains(b)
}
