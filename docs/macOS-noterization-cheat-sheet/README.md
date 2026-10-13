# Apple signing and notarization cheat sheet

Direct-download Mac apps: one setup per build Mac/team, reused for all your apps.

| Thing | What it is | What it does |
| --- | --- | --- |
| Developer ID Application identity | Apple-issued certificate plus your private key | Signs the app as your team's software |
| App-specific password | A generated, separately revocable Apple Account password | Lets a tool authenticate without your main account password |
| `aiui-notary` | An arbitrary local Keychain profile name | Lets `notarytool` look up your Apple Account, team and saved credential |

`aiui-notary` is our chosen name for saved credentials. Scripts look up that name;
it works for every app built under the same team.

**Set up notarization once on each Mac**

1. Install Apple's tools if missing: `xcode-select --install`.
2. At [account.apple.com](https://account.apple.com), open **Sign-In and Security →
   App-Specific Passwords** and generate one. Label it `Notarization — this Mac`.
3. Run this, using the Apple Account email for your developer team:

```sh
xcrun notarytool store-credentials aiui-notary \
  --apple-id 'YOUR_APPLE_ACCOUNT_EMAIL' \
  --team-id QR7G4C9JWN
```

Paste the generated password at the secure prompt. The team ID above is yours.
Verify:

```sh
xcrun notarytool history --keychain-profile aiui-notary
```

Use one labeled password per build Mac, shared across its apps.

**Move your signing identity to another Mac**

On the source Mac, open **Keychain Access → My Certificates**, select the
**Developer ID Application** identity including its private key, then **File →
Export Items → .p12**. Save as `~/developer-id.p12` with an export password.
The downloaded `.cer` alone does not contain the private key.
[Apple's export/import instructions](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac)

From the destination Mac, copy over SSH and import:

```sh
scp old-mac:~/developer-id.p12 ~/Downloads/developer-id.p12
open ~/Downloads/developer-id.p12
security find-identity -v -p codesigning
```

Enter the export password; verify a valid **Developer ID Application** appears.
Keep the `.p12`/password out of source control. Keychain Access exports the
selected identity; `security export` cannot select one by name.

If you already maintain a dedicated keychain containing only that identity,
the export itself can be launched over SSH:

```sh
ssh -t old-mac 'umask 077; security export \
  -k "$HOME/Library/Keychains/developer-id.keychain-db" \
  -t identities -f pkcs12 -o "$HOME/developer-id.p12"'
```

This exports **all identities** in that keychain; don't use your general login
keychain. Password/key authorization may require the source Mac's GUI. Omit `-P`
to keep the password out of process arguments. Then copy/import as above.

**For each distribution build**

Build → sign app/native code → create DMG → submit → Accepted → staple → verify.
Changed builds need new submissions; keep the submitted image unchanged.

```sh
xcrun notarytool submit 'MyApp.dmg' --keychain-profile aiui-notary
xcrun notarytool info SUBMISSION_ID --keychain-profile aiui-notary
xcrun notarytool log SUBMISSION_ID --keychain-profile aiui-notary
# Only after Accepted:
xcrun stapler staple 'MyApp.dmg'
xcrun stapler validate 'MyApp.dmg'
spctl --assess --type open --context context:primary-signature 'MyApp.dmg'
```

Our [runner](../../experiments/macos-notarization/notary.mjs) saves IDs/checks
hashes; the [workflow](../../experiments/macos-notarization/README.md) has Electron
build commands.

**Internal transfers and quarantine**

Quarantine is filesystem metadata (`com.apple.quarantine`), separate from the
DMG's contents. A browser can add it without changing the DMG's content hash.
Quarantine on a mounted DMG propagates to its contents and Finder copies.
Without it, an internal transfer may avoid the normal downloaded-app assessment;
your successful Dropbox Sync transfer is consistent with that explanation.

Apple documents that `curl` and `scp` do not set quarantine; an AWS/S3 client or
sync client depends on its implementation. Byte-for-byte copying alone does not
tell you whether filesystem metadata was added or preserved. macOS can also
invoke Gatekeeper at other times; absence of quarantine is not a guarantee that
all unsigned code runs. [Apple's trusted-execution explanation](https://developer.apple.com/forums/thread/706442)

To check quarantine on the archive file itself:

```sh
xattr -p com.apple.quarantine "/path/to/app.dmg"
```

A value means the attribute exists; "No such xattr" means it is absent. To list
all extended attributes on that file:

```sh
xattr -l "/path/to/app.dmg"
```

In the reported transfer tests:

- **SCP:** the source had a quarantine tag; the newly received file did not.
- **AWS S3 CLI:** the newly downloaded file had no quarantine tag. Even an S3
  object metadata field named `com.apple.quarantine` was not converted into a
  macOS extended attribute.

Neither test inspected metadata inside an archive. Transfers copy the archive's
bytes, so any metadata stored within those bytes remains intact. These results
describe the tested transfer paths, not every client's metadata behavior.

To check inside a DMG, mount it and inspect the app:

```sh
xattr -lr "/Volumes/Your Volume/Your App.app"
```

This recursively lists attributes on the app and its contents. Look for
`com.apple.quarantine`.

For ZIP or TAR archives, extract into a temporary folder and run the same
recursive check there. Archive formats and extraction tools differ in whether
they restore embedded attributes. Extracting a quarantined archive can also
propagate quarantine to its contents, even if the original files were not tagged
before packaging. [Apple's explanation of quarantine propagation](https://developer.apple.com/forums/thread/706442)

Controlled internal sync can be a convenient test lane. Keep signing/notarization
for browser downloads and routine distribution; a Dropbox website download is a
different path from Dropbox Sync. [Apple on download paths](https://developer.apple.com/forums/thread/777189)

**GitHub Releases and GitHub Actions**

The app-specific password authenticates **to Apple for notarization**. Uploading
the final DMG to GitHub Releases uses **GitHub authentication**—`gh auth login`
locally, or Actions' `GITHUB_TOKEN` with `contents: write` in CI. A GitHub release
can host a DMG regardless of notarization; a browser download still gets the
normal macOS checks. [GitHub token documentation](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)

For an existing release, after notarization/stapling:

```sh
gh release upload EXISTING_RELEASE_TAG 'MyApp.dmg' --repo OWNER/REPO
```

In Actions, set `GH_TOKEN` to the workflow's `GITHUB_TOKEN`. A macOS release job
also needs the signing certificate/private key and Apple credentials, supplied
through protected CI secrets and installed for that job; the local `aiui-notary`
profile is not automatically available on a hosted runner. Reuse the team's
credentials across approved app repositories, not new passwords per app. Publish
the final stapled bytes and generate checksums/update metadata afterward.
[GitHub secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets),
[release upload command](https://cli.github.com/manual/gh_release_upload)

**App-specific passwords as a general pattern**

An app-specific password is a generated login secret for a client or automation.
The client uses it without an interactive two-factor prompt each time. You can
revoke it independently of your main password and other clients. Apple requires
two-factor authentication to create one; uses include mail/calendar clients and
developer tools.

Its label does not bind it to one executable or define permission scopes. It is
a secret, distinct from a scoped API token or OAuth consent. Changing/resetting
your main Apple Account password revokes **all** app-specific passwords; recreate
and update affected profiles. [Apple's instructions](https://support.apple.com/en-us/102654)
