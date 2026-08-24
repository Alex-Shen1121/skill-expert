# Skill Expert Updater trust root

Skill Expert owns its Tauri Updater trust root. The repository contains only the
base64-encoded public key in `src-tauri/tauri.conf.json`. The encrypted private key and its
password are two separate `release` Environment Secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Do not create repository-level copies of these Secrets. Do not paste either value into an
Issue, pull request, workflow input, shell history, or log. Until the controlled formal-release
orchestration replaces the legacy tag/manual workflow, no workflow may read these production
Secrets. The future formal release build will be the only job bound to the `release`
Environment. Candidate builds generate an ephemeral updater key inside each runner and have no
access to the production Environment.

## Initial provisioning

Provisioning is a maintainer operation and must happen on a trusted machine:

1. Create a permission-restricted working directory (`umask 077`; directory mode `700`).
2. Generate a new password-protected Tauri signer keypair for Skill Expert. Never reuse the
   upstream keypair. Keep the private key and password in separate mode-`600` files.
3. Put only the generated `.pub` value into `plugins.updater.pubkey` and keep the single feed
   `https://github.com/Alex-Shen1121/skill-expert/releases/latest/download/latest.json`.
4. Create the GitHub `release` Environment without a second reviewer. The reviewed
   `main -> release` merge is the human publication approval.
5. Upload the private-key file as `TAURI_SIGNING_PRIVATE_KEY` and the password file as
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` using `gh secret set --env release`. Confirm the
   Environment exposes exactly those Secret names; GitHub never returns their values.
6. Run `npm run updater:check`. It validates `src-tauri/tauri.conf.json` and must reject the
   archived upstream public key, any upstream feed URL, or a malformed key.
7. Validate a generated feed separately:

   ```bash
   node scripts/verify-updater-metadata.mjs \
     --file latest.json \
     --version x.y.z \
     --asset-directory /path/to/release-assets
   ```

   The verifier reads the configured public key and cryptographically verifies each listed
   asset, in addition to rejecting missing platforms, malformed or missing Tauri signatures,
   version drift, and non-Skill-Expert artifact URLs.

The keypair is not considered provisioned until the encrypted offline recovery test below
has completed successfully.

## Encrypted offline backup

Keep the encrypted recovery bundle on an offline removable volume. Keep the recovery
passphrase in a separate physical location or separate medium (for example, a password
manager with its own recovery plan). Never store the bundle and its passphrase together,
and never commit either one.

Prepare the passphrase file with restricted permissions:

```bash
umask 077
chmod 600 /secure/separate-medium/skill-expert-recovery-passphrase
```

Create the authenticated AES-256-GCM recovery bundle directly on the offline volume:

```bash
node scripts/updater-key-recovery.mjs create \
  --private-key /secure/work/skill-expert-updater.key \
  --public-key /secure/work/skill-expert-updater.key.pub \
  --signing-password-file /secure/work/skill-expert-updater.password \
  --recovery-passphrase-file /secure/separate-medium/skill-expert-recovery-passphrase \
  --output "/Volumes/OFFLINE/Skill Expert/skill-expert-updater-recovery.json"
chmod 600 "/Volumes/OFFLINE/Skill Expert/skill-expert-updater-recovery.json"
```

The bundle contains the private key, public key, and signing password only inside an
authenticated encrypted payload. The tool refuses a recovery passphrase shorter than 32
characters and refuses to overwrite an existing backup. On Unix, it also refuses source
credentials readable by group/others and writes owner-only modes. It writes and synchronizes a
temporary file beside the destination before atomically publishing the completed bundle, so a
failed write never leaves a truncated file at the final path. Windows permission bits do not
represent the effective ACL, so the tool cannot validate that boundary automatically there; use
a trusted private directory and inspect its Windows ACL before provisioning or recovery.

## Recovery verification

Test recovery before deleting the working copy and after every rotation. Restore into a new
temporary directory, never over a live key directory:

```bash
verify_parent=$(mktemp -d)
node scripts/updater-key-recovery.mjs restore \
  --backup "/Volumes/OFFLINE/Skill Expert/skill-expert-updater-recovery.json" \
  --recovery-passphrase-file /secure/separate-medium/skill-expert-recovery-passphrase \
  --output-directory "$verify_parent/restored"
```

Verify all of the following without printing a credential:

1. The restored directory is mode `700`; the restored private key, public key, and password
   are each mode `600`.
2. The restored public key exactly matches `plugins.updater.pubkey` in
   `src-tauri/tauri.conf.json`.
3. Use `TAURI_SIGNING_PRIVATE_KEY_PATH` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from the
   restored files to sign a disposable canary with `npx tauri signer sign`, then verify that
   signature cryptographically with the restored public key. A non-empty `.sig` file alone is
   not proof that the private and public keys match:

   ```bash
   canary="$verify_parent/skill-expert-updater-canary.txt"
   printf 'Skill Expert updater recovery canary\n' > "$canary"
   export TAURI_SIGNING_PRIVATE_KEY_PATH="$verify_parent/restored/skill-expert-updater.key"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(< "$verify_parent/restored/skill-expert-updater.password")"
   npx tauri signer sign "$canary"
   unset TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   node scripts/verify-updater-signature.mjs \
     --file "$canary" \
     --signature "$canary.sig" \
     --public-key "$verify_parent/restored/skill-expert-updater.key.pub"
   ```

   The verification must fail if the signature, canary, or public key came from a different
   keypair.
4. Delete the canary and restored plaintext material immediately after the test, eject the
   offline volume, and retain only the encrypted bundle.

A wrong recovery passphrase must fail authentication before the output directory is created.
Record only the test date, public key identifier, backup checksum, and success/failure. Never
record the private key, signing password, or recovery passphrase.

## Two-stage key rotation

Tauri clients trust the public key embedded in the version they are currently running, so a
safe rotation requires two releases.

### Phase 1: transition release

While the old private key is still available, change the client configuration to the new
public key, but sign the transition release with the old private key. Existing clients accept
that release using the old trust root; after installation, the transition client trusts the
new public key. Keep both encrypted recovery bundles throughout the adoption window.

### Phase 2: new signing key

After the transition release has been available for the agreed adoption window, replace the
`release` Environment Secrets with the new private key and password. Sign every subsequent
release with the new private key. Verify its `latest.json` signatures and retain the old
encrypted backup according to the release-retention policy.

If the old private key is lost before Phase 1, old clients cannot authenticate the transition
release. If the active private key and its encrypted backup (or the required passphrases) are
both lost, automatic updates for installed clients cannot be recovered. Publish a newly
signed build and instruct affected users to manual reinstall it; do not move an old tag or
replace already-published assets.
