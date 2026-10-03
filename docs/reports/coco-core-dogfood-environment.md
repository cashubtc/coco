# Coco core dogfood environment and remaining coverage

The 2026-09-20 browser, Node HTTP and Bun terminal consumers exercised locally built public core
2.0.0 exports at baseline `b7aac78c780f2e50607fe332186619e856dbd38d`. Their deterministic mint
simulators support local flow regression checks. They do not establish real mint interoperability.

Session evidence and runnable mitigation artifacts are retained under
`/tmp/coco-dog-food-20260920/`. These temporary files must be archived with the report before the
execution environment is discarded. `mitigations/UPSTREAM-READY.md` contains ready-to-file harness
and environment issue notes; none was published. No product runtime changes are required for the
environment findings below.

| Rows          | Observation and evidence                                                                                                                                                             | Mitigation and remaining prerequisite                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W05, N08, B08 | Restricted Node listen failed EPERM; Bun listen failed EADDRINUSE. See `node/logs/mint-sandbox-failure.log`, `web/evidence/server.log`, `bun/startup-sandbox-failure/session-1.log`. | Identical apps subsequently ran with approved loopback execution; see `node/logs/mint.log`, `web/evidence/server-escalated.log`, `bun/driver.log`. Minimal port-0 probes are `mitigations/loopback-node.mjs` and `mitigations/loopback-bun.ts`. Keep permission context with failures. |
| N07           | Simulator passed a noble point to cashu-ts `pointToHex`, which expects a tagged `CurvePoint`; initial transcript contains an undefined `.toHex` error.                               | Harness mistake, not a cashu-ts bug. Use the noble point's `.toHex()`, or the documented tagged point wrapper. `mitigations/point-conversion.mjs` retains the original failure and valid alternatives.                                                                                 |
| N09, B09, P01 | Concurrent prerequisite rebuilding temporarily removed dist; initial root typecheck failed TS6053. Local symlinks did not establish tarball completeness.                            | `evidence/typecheck-before-serial.log` passed after builds stopped. Serialize builds/checks; run the extracted-package smoke below. `mitigations/dist-clean-repro.mjs` reproduces a missing-dist window only in that isolated consumer.                                                |
| N10, B09, P02 | Docker absent; mint/auth services unconfigured. Full core integration recorded 1 pass, 7 fail, 3 errors in `evidence/core-integration-before.log`.                                   | Follow the service setup below. `mitigations/environment-prerequisites.py` records tool availability, auth-variable presence and bounded local health checks. Mint, auth, fee, WebSocket and external invoice interoperability remain unverified until observed.                       |
| B07           | tui-debug was absent from the session catalog and inspected installed skill roots.                                                                                                   | Existing Python PTY driver executed the actual terminal app, including process restart. This is standard PTY coverage; tui-debug itself remains unavailable and untested.                                                                                                              |
| B10           | `python` alias missing, exit 127; see `bun/driver-python-missing.log`.                                                                                                               | `/usr/bin/python3` is installed and ran the full driver. Use `python3` explicitly; no host alias change required.                                                                                                                                                                      |

## Sequential distribution check

After all editing and build-triggering validation suites finish, run from the repository root:

```sh
bun run build
bun run typecheck
bun test packages/core/test/unit
```

Await each command before starting the next. The package's `test` and `test:unit` scripts rebuild
core prerequisites, so do not run them concurrently with consumers or typecheck. Pack the final
built artifact without invoking another build:

```sh
mkdir -p /tmp/coco-dog-food-20260920/mitigations/pack-final
cd packages/core
bun pm pack --ignore-scripts --destination /tmp/coco-dog-food-20260920/mitigations/pack-final
```

Pass the resulting tarball to the prepared smoke script (substitute the filename if the package
version changed):

```sh
node /tmp/coco-dog-food-20260920/mitigations/packed-core-smoke.mjs /tmp/coco-dog-food-20260920/mitigations/pack-final/cashu-coco-core-2.0.0.tgz /root/projects/coco
```

The script extracts core into a new `/tmp/coco-packed-consumer-*` directory, asserts resolution
inside that copy, checks every declared import/types target, imports all JavaScript entry points
using Node and Bun, initializes the public memory manager and generates a key, then checks a
strict NodeNext TypeScript consumer. It reuses existing installed external dependencies and does
not install, publish, build, access the registry or modify workspace package resolution.
Provenance and generated consumers remain in the printed directory. Declaration-library checking
is skipped, matching the original external consumers. This establishes only the tested tarball
and installed dependency combination; clean installation, registry resolution, browser execution
of the tarball, and adapter tarballs require separate coverage. The parent report records whether
this prepared command actually passed.

## Real mint and authentication followup

The original failing command was:

```sh
bun run --filter='@cashu/coco-core' test:integration
```

Run prerequisites on a disposable host with Docker/Compose, image access and allowed loopback
networking. Do not infer these capabilities from the simulator's successful approved loopback
run. From the repository root, build first, then use the checked-in runners sequentially:

```sh
bun run build
bash scripts/test-integration.sh core
bash scripts/auth_mint/test-auth-integration.sh
```

The current core runner provisions `cashubtc/mintd:0.17.0-rc.0` with a fake wallet, test mnemonic,
input fees and port 3338; `--custom-unit usd` adds a custom-unit pass. The older
`docker-compose.test.yml` names 0.15.1 and is not the current runner's image source of truth.
The auth runner uses `scripts/auth_mint/docker-compose.yml`, currently Keycloak 25.0.0 and
`cashubtc/mintd:0.15.2-test-static-4`, serving auth mint 3339 and Keycloak 8080. Although its status
message says “Nutshell,” its executable compose configuration runs CDK mintd. The runner supplies
`MINT_URL`, `AUTH_TEST_KEYCLOAK_URL`, `AUTH_TEST_CLIENT_ID`, `AUTH_TEST_USERNAME` and
`AUTH_TEST_PASSWORD` using the fixture credentials and runs the login/BAT files. Capture image
versions, service health, exact test commands and results; omit credential values from reports.
Both runners own their fixture containers and cleanup, so use a dedicated host without other
workloads using their container names.

These runners do not establish every test in the full directory passed. The generic core runner
targets `integration.test.ts`; the auth runner targets the two auth files.
`ReceiveOperationIntegration.test.ts` hardcodes `http://localhost:3338` and must run while an
appropriate fixture is live. `PauseResumeIntegration.test.ts` hardcodes
`https://testnut.cashu.space`, so setting `MINT_URL` does not redirect it: it needs approved access
to that test mint or a separately reviewed change to make its mint configurable. The full
integration command also needs all auth variables and both local mint services available at the
same time. Preserve the original failed result until these paths are actually exercised.

For another workbench pass, configure its host to target the real test mint instead of starting
the embedded simulator, remove simulator-only `/admin/pay` or `/pay` calls, and settle quotes
through that fixture's controlled payment mechanism. Enable watchers and supply the Node
WebSocket factory when testing event delivery. Use separate test seeds and databases for separate
wallets. Verify issuance, transfer, spent-proof rejection, fee accounting, restart/recovery and
subscription behavior against the real service. Test auth against the configured auth mint.
Fake-wallet service integration still does not establish real Lightning invoice payment or
production mint compatibility; add an explicitly funded regtest/payment setup for that claim.

## Scope of this remediation

Only this report and temporary harness artifacts were changed by the environment work. There are
no new public exports, runtime compatibility changes, persistence transactions or storage adapter
changes. A changeset is not required for this report alone. Validation was deferred to the parent
until the concurrent edit wave finished; consult its final results rather than treating prepared
scripts or baseline simulator success as completed external verification.

## Additional final-validation prerequisite: WebKit libraries

The combined `CI=1 bun run test:browser -- src/test/contract.test.ts` command stopped
before running tests because cached WebKit requires `libicudata.so.74`,
`libicui18n.so.74`, `libicuuc.so.74`, `libxml2.so.2`, and `libvpx.so.9`, which the host
could not load. The exact launch failure is retained in
`/tmp/coco-dog-food-20260920/evidence/browser-contract-final.log`.

A ready-to-file environment issue is: **Provision the system libraries matching
the cached Playwright WebKit build before the three-browser contract gate.** The
reproduction is the command above from `packages/indexeddb`. Expected: Chromium,
Firefox and WebKit launch. Actual: the missing-library diagnostic aborts the
combined gate. Use the repository's Playwright dependency setup on a disposable
CI host, then rerun that exact command. No product defect or compatible replacement
library has been established by this failure.

The local mitigation is to select the available projects explicitly:
`CI=1 bun run test:browser -- src/test/contract.test.ts --project chromium --project firefox`.
That command passed 154 tests. WebKit remains unverified; neither the browser
workbench nor the two-browser gate substitutes for it.

The extracted-package smoke also needed approved subprocess execution: sandboxed
Node `spawnSync('tar', ...)` returned `EPERM`. The same script passed with that
access. This is another execution-environment prerequisite covered by the loopback
and driver permission notes, not evidence of a broken archive.

The final approved full integration run reached the public test mint: two
networked pause/resume cases and the disabled-watcher case passed. The multiple
pause/resume case exceeded its default setup/teardown hook timeout. Its cause is
not established by the missing local mint/auth prerequisites. Preserve this
separate timeout when evaluating the gate; increasing a command timeout can
probe it but does not turn the original full-suite invocation into a pass.

The isolated diagnostic command
`bun test test/integration/PauseResumeIntegration.test.ts -t 'should handle multiple pause/resume cycles' --timeout 30000`
passed in about 12.27 seconds, with one test and five assertions. This shows the
case can finish with a larger hook budget against the public mint; it does not
establish why the original hook exceeded its default limit. The original full
integration command still failed and its log is retained separately.
