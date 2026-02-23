# NUT-21/22 Auth System Architecture

## Core Concepts

```
CAT (Client Auth Token) = OIDC access_token. User identity proof.
BAT (Blind Auth Token)   = ecash proof (unit:'auth', amount:1). Consumed per request.
                           Blind signature prevents mint from tracking "who made the request".
```

## Layer Structure

```
Manager (entry point)
  ├── mgr.auth.*          AuthApi
  ├── mgr.quotes.*        QuotesApi
  ├── mgr.wallet.*        WalletApi
  └── mgr.mint.*          MintApi

Services (business logic)
  ├── AuthSessionService   Session CRUD + expiry validation
  ├── WalletService        Wallet creation / caching
  └── MintService          Mint info management

Infra (external communication)
  ├── MintAdapter          HTTP -> Mint object management
  └── MintRequestProvider  Request rate limiting

Repositories (storage)
  └── AuthSessionRepository  memory / sqlite / indexeddb

cashu-ts (external library)
  ├── AuthManager          CAT/BAT lifecycle management
  ├── OIDCAuth             OIDC Device Code Flow
  ├── Mint                 Mint HTTP client
  └── Wallet               ecash operations (swap, melt, etc.)
```

## Storage Separation

```
Regular ecash:  /v1/keysets -> KeysetRepository
                Wallet      -> ProofRepository (unit:'sat')

Auth (BAT):    /v1/auth/blind/keysets -> cashu-ts internal
               AuthManager.exportPool() -> AuthSession.batPool (Proof[])
               <-> AuthSessionRepository (JSON serialized)
```

BAT is `unit:'auth'` and must not mix with balance.
When a session is deleted, BATs are deleted together.

---

## Flow 1: Initial Authentication (`startDeviceAuth`)

```mermaid
sequenceDiagram
    participant User
    participant AuthApi
    participant cashu_ts as cashu-ts<br/>(AuthManager + OIDCAuth)
    participant Mint as Mint Server
    participant DB as AuthSessionRepository

    User->>AuthApi: mgr.auth.startDeviceAuth(mintUrl)
    AuthApi->>cashu_ts: new AuthManager(mintUrl)
    AuthApi->>cashu_ts: mint.oidcAuth({ onTokens })
    cashu_ts->>Mint: GET /v1/auth/info
    Mint-->>cashu_ts: OIDC metadata
    AuthApi->>cashu_ts: oidc.startDeviceAuth()
    cashu_ts->>Mint: POST /device/auth
    Mint-->>cashu_ts: device_code + user_code
    AuthApi-->>User: verification_uri + user_code

    Note over User: User authorizes in browser

    User->>AuthApi: device.poll()
    AuthApi->>cashu_ts: poll()
    cashu_ts->>Mint: POST /token (polling)
    Mint-->>cashu_ts: access_token + refresh_token

    AuthApi->>DB: saveSession(tokens + batPool)
    AuthApi->>AuthApi: managers.set(mintUrl, auth)
    AuthApi->>AuthApi: mintAdapter.setAuthProvider<br/>(PersistingProvider wrapper)
    AuthApi-->>User: tokens
```

## Flow 2: Authenticated Request (`createMintQuote`)

```mermaid
sequenceDiagram
    participant App
    participant WalletService
    participant Wallet as Wallet / Mint<br/>(cashu-ts)
    participant PP as PersistingProvider<br/>(wrapper)
    participant AM as AuthManager<br/>(cashu-ts)
    participant Mint as Mint Server
    participant DB as AuthSessionRepository

    App->>WalletService: getWallet(mintUrl)
    WalletService->>WalletService: buildWallet()<br/>new Mint(url, { authProvider: PP })

    App->>Wallet: createMintQuote()
    Wallet->>PP: getBlindAuthToken({ method, path })
    PP->>AM: auth.getBlindAuthToken()

    alt pool is empty
        AM->>Mint: POST /v1/auth/blind/mint<br/>(topUp - mint new BATs using CAT)
        Mint-->>AM: blind-signed BAT proofs
    end

    AM->>AM: pool.pop() (consume 1 BAT)
    AM-->>PP: BAT token string

    PP-)DB: persistPool() (fire & forget)<br/>updateBatPool(mintUrl, exportPool())

    PP-->>Wallet: BAT token string
    Wallet->>Mint: POST /v1/mint/quote/bolt11<br/>Authorization: BAT xxxxxx
    Mint-->>Wallet: quote response
    Wallet-->>App: quote
```

## Flow 3: App Restart (`restore`)

```mermaid
sequenceDiagram
    participant App
    participant AuthApi
    participant DB as AuthSessionRepository
    participant AM as AuthManager<br/>(cashu-ts)
    participant MintAdapter

    App->>AuthApi: mgr.auth.restore(mintUrl)
    AuthApi->>DB: getSession(mintUrl)
    DB-->>AuthApi: session<br/>(accessToken, refreshToken, batPool)

    AuthApi->>AM: new AuthManager(mintUrl)
    AuthApi->>AM: setCAT(accessToken)

    alt batPool exists
        AuthApi->>AM: importPool(proofs, 'replace')
    end

    alt refreshToken exists
        AuthApi->>AM: attachOIDC(oidc)<br/>(enables automatic CAT refresh)
    end

    AuthApi->>AuthApi: managers.set(mintUrl, auth)
    AuthApi->>MintAdapter: setAuthProvider<br/>(PersistingProvider wrapper)
    AuthApi-->>App: true
```

## Flow 4: Cache Invalidation

```mermaid
sequenceDiagram
    participant AuthApi
    participant EventBus
    participant Manager
    participant WalletService
    participant MintAdapter

    Note over AuthApi: login / logout / token refresh

    AuthApi->>MintAdapter: setAuthProvider() or clearAuthProvider()
    MintAdapter->>MintAdapter: delete cached Mint instance

    AuthApi->>EventBus: emit('auth-session:updated') or<br/>emit('auth-session:deleted')
    EventBus->>Manager: event handler
    Manager->>WalletService: clearCache(mintUrl)

    Note over WalletService: Next getWallet() call rebuilds<br/>Wallet with new authProvider
```

## PersistingProvider Wrapper

cashu-ts `AuthManager` has no pool-change callback.
The wrapper intercepts `getBlindAuthToken()` and `ensure()` to auto-save pool to DB.

```mermaid
flowchart LR
    subgraph PersistingProvider
        A[getBlindAuthToken] --> B[auth.getBlindAuthToken]
        B --> C[persistPool - fire & forget]
        D[ensure] --> E[auth.ensure]
        E --> C
        F[getCAT / setCAT / ensureCAT] --> G[delegate as-is]
    end

    C --> H[(AuthSessionRepository<br/>updateBatPool)]
```

## Flow 5: Logout

```mermaid
sequenceDiagram
    participant App
    participant AuthApi
    participant DB as AuthSessionRepository
    participant EventBus
    participant MintAdapter
    participant Manager
    participant WalletService

    App->>AuthApi: mgr.auth.logout(mintUrl)
    AuthApi->>DB: deleteSession(mintUrl)
    AuthApi->>AuthApi: managers.delete(mintUrl)
    AuthApi->>AuthApi: oidcClients.delete(mintUrl)
    AuthApi->>MintAdapter: clearAuthProvider(mintUrl)
    MintAdapter->>MintAdapter: delete cached Mint

    AuthApi->>EventBus: emit('auth-session:deleted')
    EventBus->>Manager: handler
    Manager->>WalletService: clearCache(mintUrl)

    Note over WalletService: Next Wallet will be<br/>created without authProvider
```

## Flow 6: BAT State Query & Spend (non-standard cdk extension)

cashu-ts `Mint` class has no corresponding methods for these endpoints.
`MintAdapter` calls `requestProvider.getRequestFn()` directly.

```mermaid
sequenceDiagram
    participant App
    participant AuthApi
    participant MintAdapter
    participant Mint as Mint Server

    Note over App: checkBlindAuthState — read-only state query

    App->>AuthApi: mgr.auth.checkBlindAuthState(mintUrl, proofs)
    AuthApi->>AuthApi: proofs.map(toAuthProof)<br/>strip amount/witness → {id, secret, C, dleq?}
    AuthApi->>MintAdapter: checkBlindAuthState(mintUrl, { auth_proofs })
    MintAdapter->>Mint: POST /v1/auth/blind/checkstate<br/>(via requestFn — rate-limited)
    Mint-->>MintAdapter: { states: [{ Y, state, witness? }] }
    MintAdapter-->>App: CheckBlindAuthStateResponse

    Note over App: spendBlindAuth — mark BAT as spent

    App->>AuthApi: mgr.auth.spendBlindAuth(mintUrl, proof)
    AuthApi->>AuthApi: toAuthProof(proof)
    AuthApi->>MintAdapter: spendBlindAuth(mintUrl, { auth_proof })
    MintAdapter->>Mint: POST /v1/auth/blind/spend<br/>(via requestFn — rate-limited)
    Mint-->>MintAdapter: { state: { Y, state: "SPENT" } }
    MintAdapter-->>App: SpendBlindAuthResponse

    Note over App: Local BAT pool is NOT modified.<br/>Caller is responsible for pool management.
```

### Wire Types (`packages/core/types.ts`)

```
Proof (cashu-ts)          AuthProof (wire)
┌──────────────────┐      ┌──────────────────┐
│ id               │ ──── │ id               │
│ amount           │  ✗   │ secret           │
│ secret           │ ──── │ C                │
│ C                │ ──── │ dleq? {e, s, r}  │
│ witness          │  ✗   └──────────────────┘
│ dleq? {e, s, r}  │ ────   toAuthProof() strips amount + witness
└──────────────────┘
```

## Recommended Mint Auth Configuration

```
# Entry points — authenticated users only
mint:              Blind   # Token minting requires BAT
get_mint_quote:    Clear   # Quote creation requires CAT (lightweight)
check_mint_quote:  Blind   # Quote status requires BAT

# Exit points — open (external recipients must redeem)
melt:              None    # Anyone with tokens can withdraw
get_melt_quote:    None    # Anyone can create withdrawal quotes
check_melt_quote:  None    # Anyone can check withdrawal status

# Token operations — open (receivers need swap to claim)
swap:              None    # Receiving tokens requires swap
check_proof_state: None    # Anyone can verify token validity

# Recovery — protected (computationally expensive, DoS vector)
restore:           Blind   # Token recovery requires BAT
```

Rationale: Mint serves two user types.
**Internal** (authenticated) users deposit funds via mint endpoints.
**External** users receive ecash and must be able to redeem (melt/swap) without authentication.

## Integration Test Suite

File: `packages/core/test/integration/auth-bat.test.ts`

```bash
MINT_URL=http://localhost:8085 bun test packages/core/test/integration/auth-bat.test.ts --timeout 300000
```

Requires OIDC Device Code authorization in browser during `beforeAll`.

```
beforeAll
  OIDC Device Code Flow → browser authorization → CAT acquired

T1  CAT-protected endpoint succeeds without consuming BATs
    createMintQuote (get_mint_quote = Clear)
    → quote returned, pool stays 0
    Verifies: CAT header auth works, BAT pool untouched

T2  ensure() mints BATs via CAT and populates pool
    provider.ensure(3)
    → pool ≥ 3
    Verifies: CAT → POST /v1/auth/blind/mint → BAT minting works

T3  session restore → CAT works, BAT re-mintable
    new Manager + restore() from same repository
    → createMintQuote succeeds (CAT restored)
    → ensure(2) succeeds (BAT re-mintable with restored CAT)
    Verifies: session persistence, CAT + BAT capability after restart

T4  flush → re-issue → checkBlindAuthState → spendBlindAuth
    importPool([], 'replace') → ensure(3) → fresh pool
    → checkBlindAuthState: all UNSPENT, pool size unchanged (read-only)
    → spendBlindAuth(pool[0]): returns SPENT
    → checkBlindAuthState: pool[0] SPENT, rest UNSPENT
    Verifies: checkstate/spend endpoints, state transitions, read-only semantics
```
