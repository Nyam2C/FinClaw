// packages/infra/src/dotenv.ts

/**
 * .env 파일 로딩 — Node.js 22+ process.loadEnvFile() 사용
 * dotenv 패키지 불필요
 */
export function loadDotenv(envPath?: string): void {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // .env 파일이 없으면 무시 (선택적 로딩)
  }
}
