# Auth Wallet Feature

Adding NUT-21/22 authentication support (CAT + BAT) to coco-cashu.

## Background

BAT (Blind Auth Token) is a standard ecash proof with `unit:'auth', amount:1`.
cashu-ts provides `AuthManager` which handles the full CAT/BAT lifecycle internally:
- Auth keysets are fetched from `/v1/auth/blind/keysets` (not `/v1/keysets`)
- BAT pool is managed internally by `AuthManager` (mint/consume/top-up)
- `exportPool()` / `importPool()` API for external persistence

BAT uses independent storage — not shared with regular keyset/proof repositories.
This avoids contaminating balance calculations and proof state tracking, and matches
the lifecycle: auth session + BAT pool are always created/deleted together.

## Completed

### 1. AuthSession Model
- [x] `models/AuthSession.ts` — session data structure
- [x] `models/index.ts` export

### 2. Repository
- [x] `repositories/index.ts` — `AuthSessionRepository` interface
- [x] `RepositoriesBase` — `authSessionRepository` field
- [x] `repositories/memory/MemoryAuthSessionRepository.ts` — in-memory implementation for tests
- [x] `repositories/memory/index.ts` export
- [x] `MemoryRepositories.ts` wiring

### 3. Errors
- [x] `models/Error.ts` — `AuthSessionError`, `AuthSessionExpiredError`

### 4. Events
- [x] `events/types.ts` CoreEvents:
  - `auth-session:updated`
  - `auth-session:deleted`
  - `auth-session:expired`

### 5. Service
- [x] `services/AuthSessionService.ts` — session CRUD + expiration validation
- [x] `services/index.ts` export

### 6. Tests
- [x] `test/unit/AuthSessionService.test.ts` — unit tests

### 7. API Integration (AuthApi + Manager + MintAdapter)
- [x] `api/AuthApi.ts` — orchestrates cashu-ts AuthManager per mint
  - `startDeviceAuth(mintUrl)` — OIDC Device Code Flow
  - `login(mintUrl, tokens)` — manual login with externally obtained tokens
  - `restore(mintUrl)` — restore session on app restart
  - `logout(mintUrl)` — delete session + disconnect AuthProvider
  - `getSession(mintUrl)` / `hasSession(mintUrl)` — session queries
  - `getAuthProvider(mintUrl)` — access cashu-ts AuthProvider
- [x] `Manager.ts` — `readonly auth: AuthApi` property
- [x] `MintAdapter.ts` — `setAuthProvider`/`clearAuthProvider`
  - Passes `authProvider` to cashu-ts `Mint` constructor
- [x] `api/index.ts` export
- [x] `services/AuthSessionService.ts` — fixed Logger import (`@nestjs/common` → `@core/logging`)
- [x] `test/unit/AuthApi.test.ts` — 9 unit tests
- [x] `test/integration/auth-session.test.ts` — end-to-end via `mgr.auth.startDeviceAuth()`

### 8. Phase 1: BAT Pool Persistence
- [x] `models/AuthSession.ts` — `batPool?: Proof[]` 필드 추가
- [x] `services/AuthSessionService.ts` — `saveSession()` 3번째 파라미터 `batPool` 추가
- [x] `api/AuthApi.ts` — `saveSessionWithPool()` private helper 추가
  - `startDeviceAuth` — `onTokens` + `poll()` 에서 `exportPool()` 포함 저장
  - `login` — `saveSessionWithPool()` 사용
  - `restore` — `session.batPool` 있으면 `importPool(proofs, 'replace')`
  - `attachOIDC` — `onTokens` 콜백에서 `exportPool()` 포함 저장
  - `logout` — 변경 없음 (session 삭제 시 batPool도 함께 삭제)
- [x] `test/unit/AuthSessionService.test.ts` — batPool round-trip + backward compat 테스트 2개
- [x] `test/unit/AuthApi.test.ts` — restore+importPool, restore without pool, login batPool 테스트 3개

### 9. Phase 2: Storage Adapters (All Platforms)
- [x] `packages/sqlite3/`
  - `src/repositories/AuthSessionRepository.ts` — SQLite 구현 (UPSERT, batPoolJson TEXT)
  - `src/schema.ts` — migration `012_auth_sessions` 추가
  - `src/index.ts` — `SqliteRepositories` + `withTransaction` 연결
- [x] `packages/expo-sqlite/`
  - `src/repositories/AuthSessionRepository.ts` — Expo SQLite 구현
  - `src/schema.ts` — migration `012_auth_sessions` 추가
  - `src/index.ts` — `ExpoSqliteRepositories` + `withTransaction` 연결
- [x] `packages/indexeddb/`
  - `src/repositories/AuthSessionRepository.ts` — Dexie 구현
  - `src/lib/db.ts` — `AuthSessionRow` 타입 추가
  - `src/lib/schema.ts` — Dexie version 10 (`coco_cashu_auth_sessions: '&mintUrl'`)
  - `src/index.ts` — `IndexedDbRepositories` + `withTransaction` 연결

### 10. BAT TopUp Integration Tests
- [x] `test/unit/AuthManager.topUp.test.ts` — 실제 secp256k1 암호화 mock mint 기반 5개 테스트
  - 빈 pool → 자동 topUp 트리거 (init + `/v1/auth/blind/mint` 호출 검증)
  - pool에 토큰 있을 때 → topUp 미발생 확인
  - pool 소진 후 → 재 topUp 트리거
  - `bat_max_mint` 제한 준수
  - `exportPool()` → `importPool()` round-trip으로 topUp 회피

### 11. WalletService Auth Integration
- [x] `MintAdapter.getAuthProvider()` — auth provider 읽기 접근자
- [x] `WalletService` — optional `authProviderGetter`, `buildWallet()`에서 `authProvider` 전달
- [x] `Manager.ts` — getter 클로저 연결 + 이벤트 기반 캐시 무효화
- [x] Wallet 기반 작업 (createMintQuote, melt, swap, send)에 BAT/CAT 헤더 포함

### 12. BAT checkstate / spend (non-standard cdk extension)
- [x] `types.ts` — `AuthProof`, `CheckBlindAuthStateRequest/Response`, `SpendBlindAuthRequest/Response`, `BlindAuthProofState` 타입 추가
- [x] `types.ts` — `toAuthProof(proof)` 유틸 (Proof → AuthProof, amount/witness 제거, dleq {e,s,r} 보존)
- [x] `infra/MintAdapter.ts` — `checkBlindAuthState()`, `spendBlindAuth()` 메서드 추가
  - cashu-ts Mint에 없는 비표준 엔드포인트 → `requestProvider.getRequestFn()` 직접 사용
  - 기존 rate-limiting 자동 적용
- [x] `api/AuthApi.ts` — `checkBlindAuthState(mintUrl, proofs)`, `spendBlindAuth(mintUrl, proof)` public 메서드
  - `Proof[] → AuthProof[]` 변환은 AuthApi에서 수행 (MintAdapter는 wire type만 다룸)
  - mintUrl 정규화, local pool 미수정 원칙
- [x] `test/unit/AuthApi.test.ts` — 4개 테스트 추가 (Proof→AuthProof 변환, URL 정규화, 에러 전파)
- [x] `test/integration/auth-bat.test.ts` — CAT + BAT 통합 테스트 4개
  - T1: CAT-protected endpoint (createMintQuote) 성공, pool 0 유지
  - T2: ensure() → BAT 발급, pool ≥ 3
  - T3: session restore → CAT 동작 + BAT 재발급 가능
  - T4: flush → re-issue → checkBlindAuthState(UNSPENT) → spendBlindAuth → checkBlindAuthState(SPENT)
- [x] `docs/auth-architecture.md` — Flow 6 (checkstate/spend), 권장 민트 설정, 테스트 스위트 문서화

## Remaining Work

### Phase 3: React Wrapper (optional)

- [ ] `packages/react/` auth hooks
  - `useAuthSession()`
  - `useBatPool()`

## Architecture (Current)

```
mgr.auth.startDeviceAuth(mintUrl)
  → Creates AuthManager + OIDCAuth (cashu-ts)
  → oidc.startDeviceAuth() → user authorizes → poll()
  → AuthSessionService.saveSession() (persistence)
  → MintAdapter.setAuthProvider() (injects authProvider into Mint)
  → All subsequent Mint requests auto-include CAT/BAT headers

AuthManager (built into cashu-ts):
  - CAT storage / retrieval / auto-refresh via OIDCAuth
  - BAT auto-minting / pool management / DLEQ validation
  - Auth keysets fetched from /v1/auth/blind/keysets (managed internally)
  - Auto-detects NUT-21 (CAT) vs NUT-22 (BAT) per endpoint
  - exportPool() → Proof[]  (snapshot for persistence)
  - importPool(proofs, 'replace'|'merge')  (restore from persistence)
```

### Storage Strategy: Independent (Not Shared)

```
Regular ecash:  MintService → /v1/keysets → KeysetRepository
                WalletService → ProofRepository (unit:'sat')

Auth (BAT):     AuthManager → /v1/auth/blind/keysets (internal)
                AuthManager.exportPool() → AuthSession.batPool (Proof[])
                ↕ saved/restored via AuthSessionRepository
```

- Auth keysets: cashu-ts internal, coco가 별도 저장할 필요 없음
- BAT proofs: `AuthSession.batPool`에 JSON으로 직렬화, session과 동일 lifecycle
- 기존 KeysetRepository/ProofRepository와 완전 분리 → 잔고 오염 없음

## Reference Patterns

| New | Existing Pattern |
|-----|-----------------|
| AuthSessionRepository | MintQuoteRepository |
| AuthSessionService | MintQuoteService |

## Conventions

- **Normalize mint URLs**: always pass through `normalizeMintUrl()` before storage/comparison
- **Emit events**: emit EventBus events on every state change
- **Domain errors**: use `models/Error.ts` classes instead of plain `new Error()`
- **Include cause**: preserve original error when wrapping

## Running Tests

```sh
# All core tests (452 pass expected)
bun run --filter='coco-cashu-core' test

# AuthSessionService only
cd packages/core
bun test test/unit/AuthSessionService.test.ts

# AuthApi only
bun test test/unit/AuthApi.test.ts

# BAT topUp tests (mock mint with real DLEQ)
bun test test/unit/AuthManager.topUp.test.ts

# sqlite3 contract tests
cd packages/sqlite3
bun test

# Integration test — auth session (requires running mint + manual OIDC authorization)
MINT_URL=http://localhost:8085 bun test test/integration/auth-session.test.ts --timeout 300000

# Integration test — CAT + BAT + checkstate/spend
MINT_URL=http://localhost:8085 bun test test/integration/auth-bat.test.ts --timeout 300000
```
