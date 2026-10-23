# Mint authentication

Use `coco.auth` for mints requiring NUT-21/22 authentication. Authentication grants access to
the mint; the app still needs the separate mint trust decision from [Wallet basics](wallet-basics.md).
An auth session is mint-scoped and distinct from the Wallet Seed and the Coco Session.

## Sign in

For device authorization, start the flow in response to the user's sign-in action:

```ts
const device = await coco.auth.startDeviceAuth(mintUrl);
// Display device.verification_uri and device.user_code, or verification_uri_complete when present.
// Keep device.cancel available to the screen's owner while authorization is pending.
await device.poll();
```

Successful polling persists the auth session and attaches Coco's auth provider automatically.
Cancel an abandoned poll with `device.cancel()` and handle its rejected promise. Keep poll
completion tied to the owning screen/session so a late result cannot restart abandoned work.
If the app already obtains OIDC tokens through its own authorization flow, pass them to
`coco.auth.login(mintUrl, { access_token, refresh_token, expires_in, scope })` instead.
Treat tokens, stored auth sessions, and blind-auth pools as secrets; display only authorization
instructions and login status, not returned token objects.

## Restore access after restart

After initializing Coco, explicitly call `await coco.auth.restore(mintUrl)` for the relevant
known mints before initiating protected actions. `initializeCoco()` does not restore their auth
providers. A `true` result attaches the persisted provider; `false` means no usable session could
be restored and the UI should offer sign-in. Handle rejected restore calls as errors too.

An expired access token with a refresh token can be restored so Coco can refresh it on a later
request. `auth.hasSession()` checks stored validity; it does not attach a provider and is not a
substitute for `restore()`. `auth.getSession()` throws for a missing or expired stored session.

Observe `auth-session:updated`, `auth-session:deleted`, and `auth-session:expired`, filtering by
`mintUrl` and unsubscribing on cleanup. Expiry notifications are emitted when validity is checked,
not by a deadline timer. Surface authentication failures from actions as well. If startup work
or a payment failed for lack of authentication, restore access and reconcile its existing
operation through that flow's refresh/recovery API before offering a replacement payment.

## Sign out

Call `await coco.auth.logout(mintUrl)` to remove the local auth session and disconnect its provider.
This does not revoke mint trust, delete Wallet funds, or cancel pending operations. Cancel any
app-owned authorization poll and await its settlement before logging out so a late successful
poll cannot log the user back in.

**Done when:** authorization, cancellation, restart restoration, expiry, and logout have explicit
UI outcomes, and reauthentication reconciles existing work without creating duplicate payments.
