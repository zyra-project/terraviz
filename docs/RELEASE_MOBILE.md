# Mobile Release Setup — TestFlight & Play Console

This guide walks through the one-time setup required before the
`release-mobile.yml` GitHub Actions workflow can build and distribute
signed iOS and Android apps.

**Time estimate**: ~1 hour total (30 min Apple, 30 min Google).

---

## Part 1: iOS — Apple Developer → TestFlight

### Prerequisites

- Apple Developer Program membership ($99/year) — you already have this
- Access to [App Store Connect](https://appstoreconnect.apple.com)
- Access to [Apple Developer Portal](https://developer.apple.com/account)

### Step 1: Create an App ID

1. Go to **Certificates, Identifiers & Profiles** → **Identifiers**
2. Click **+** → **App IDs** → **App**
3. Set:
   - Description: `Interactive Sphere`
   - Bundle ID: `org.zyra-project.interactive-sphere` (Explicit)
4. Enable capabilities as needed (none required for v1)
5. Click **Register**

### Step 2: Create a Distribution Certificate

1. Go to **Certificates** → click **+**
2. Select **Apple Distribution**
3. Follow the CSR (Certificate Signing Request) flow:
   - Open Keychain Access on any Mac (or use the CI runner)
   - Keychain Access → Certificate Assistant → Request a Certificate
   - Save the CSR file, upload it to Apple
4. Download the `.cer` file
5. Double-click to install in Keychain Access
6. In Keychain Access, right-click the certificate → **Export** as `.p12`
   - Set a strong password — you'll need it for the GitHub secret

### Step 3: Create a Provisioning Profile

1. Go to **Profiles** → click **+**
2. Select **App Store Connect** (under Distribution)
3. Select the App ID from Step 1
4. Select the Distribution Certificate from Step 2
5. Name it: `Interactive Sphere App Store`
6. Download the `.mobileprovision` file

### Step 4: Create an App Store Connect API Key

1. Go to [App Store Connect](https://appstoreconnect.apple.com) →
   **Users and Access** → **Integrations** → **App Store Connect API**
2. Click **+** → **Generate API Key**
   - Name: `GitHub Actions`
   - Access: **App Manager** (minimum for TestFlight uploads)
3. Note the **Key ID** and **Issuer ID** shown on the page
4. Download the **AuthKey_XXXXXX.p8** file (you can only download once!)

### Step 5: Create the App in App Store Connect

1. Go to **My Apps** → click **+** → **New App**
2. Fill in:
   - Platform: **iOS**
   - Name: `Interactive Sphere`
   - Primary Language: English
   - Bundle ID: select `org.zyra-project.interactive-sphere`
   - SKU: `interactive-sphere`
3. Click **Create**

This app record is required before TestFlight uploads will work.

### Step 6: Store Secrets in GitHub

Go to your repo → **Settings** → **Secrets and variables** → **Actions**
→ **New repository secret** for each:

| Secret name | Value | How to get it |
|---|---|---|
| `APPLE_CERTIFICATE_BASE64` | Base64-encoded `.p12` file | `base64 -i certificate.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the .p12 | You chose this in Step 2 |
| `APPLE_PROVISIONING_PROFILE_BASE64` | Base64-encoded `.mobileprovision` file | `base64 -i profile.mobileprovision \| pbcopy` |
| `APPLE_DEVELOPMENT_TEAM` | Your 10-character Team ID | Visible in the Developer Portal top-right, or in the certificate details |
| `APP_STORE_CONNECT_API_KEY_ID` | The Key ID from Step 4 | Shown on the API Keys page |
| `APP_STORE_CONNECT_API_ISSUER_ID` | The Issuer ID from Step 4 | Shown at the top of the API Keys page |
| `APP_STORE_CONNECT_API_KEY_BASE64` | Base64-encoded `.p8` file | `base64 -i AuthKey_XXXXX.p8 \| pbcopy` |

### Step 7: Test

Run the workflow manually:
**Actions** → **Release Mobile App** → **Run workflow** → enter version
→ pick branch → **Run**

The iOS job should build a signed `.ipa`, upload it to TestFlight, and
within ~15 minutes you'll receive a TestFlight email to install on your
iPhone.

---

## Part 2: Android — Google Play Console

### Prerequisites

- Google Play Console account ($25 one-time) — create at
  [play.google.com/console](https://play.google.com/console)
- A Google Cloud service account with Play Console API access

### Step 1: Create the App in Play Console

1. Go to **All apps** → **Create app**
2. Fill in:
   - App name: `Interactive Sphere`
   - Default language: English
   - App or game: **App**
   - Free or paid: **Free**
3. Complete the **Dashboard setup** checklist (privacy policy URL,
   content rating questionnaire, target audience, etc.)

### Step 2: Create an Upload Keystore

On any machine with Java installed:

```bash
keytool -genkeypair \
  -alias upload \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -keystore upload-keystore.jks \
  -storepass YOUR_STORE_PASSWORD \
  -keypass YOUR_KEY_PASSWORD \
  -dname "CN=Zyra Project, O=Zyra Project"
```

Keep `upload-keystore.jks` safe — if you lose it, you'll need to
contact Google Play support to reset your upload key.

### Step 3: Enroll in Google Play App Signing

1. In Play Console → your app → **Setup** → **App signing**
2. Choose **Use Google-generated key** (recommended)
3. Upload your `upload-keystore.jks` certificate (the public part)
   following the instructions on-screen

Google will use their own key to sign the final APK/AAB delivered to
users. Your upload keystore just authenticates that the build came
from you.

### Step 4: Create a Service Account for CI

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select or create a project linked to your Play Console
3. **IAM & Admin** → **Service Accounts** → **Create Service Account**
   - Name: `github-actions-play-upload`
   - Role: none (we'll grant access in Play Console)
4. Click the service account → **Keys** → **Add Key** → **JSON**
5. Download the JSON key file

### Step 5: Grant Service Account Access in Play Console

1. Play Console → **Users and permissions** → **Invite new users**
2. Enter the service account email (from Step 4)
3. Set permissions:
   - **App access**: your app only
   - **Permissions**: **Release to production, exclude devices, and
     use Play App Signing** (or at minimum, release to testing tracks)
4. Click **Invite user**

### Step 6: Create an Internal Testing Track

1. Play Console → your app → **Testing** → **Internal testing**
2. Click **Create new release** (you don't need to upload anything yet)
3. Add testers: create an email list with your email and any beta
   testers
4. Save and activate the track

### Step 7: Store Secrets in GitHub

| Secret name | Value | How to get it |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded `upload-keystore.jks` | `base64 -i upload-keystore.jks \| pbcopy` (or `base64 upload-keystore.jks` on Linux) |
| `ANDROID_KEY_ALIAS` | `upload` (or whatever you used in `keytool -alias`) | You chose this in Step 2 |
| `ANDROID_KEY_PASSWORD` | The key password from Step 2 | You chose this |
| `ANDROID_STORE_PASSWORD` | The store password from Step 2 | You chose this |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | The entire contents of the JSON key file | Copy-paste the JSON from Step 4 |

### Step 8: Test

Run the workflow manually:
**Actions** → **Release Mobile App** → **Run workflow** → enter version
→ pick branch → **Run**

The Android job should build a signed `.aab`, upload it to the Internal
Testing track, and within ~30 minutes you'll see it available in the
Play Console for testers to install.

---

## First Full Release Checklist

Once both platforms are working on Internal/TestFlight:

- [ ] iOS secrets stored and TestFlight upload works
- [ ] Android secrets stored and Internal Testing upload works
- [ ] Smoke test on a real iPhone via TestFlight
- [ ] Smoke test on a real Android device via Internal Testing
- [ ] Promote Android from Internal → Closed Testing → Open Testing → Production
- [ ] Submit iOS for App Store Review
- [ ] Update `docs/MOBILE_APP_PLAN.md` Phase 6 items to ✅

## Troubleshooting

**iOS: "No matching provisioning profile"**
→ Ensure the Bundle ID in the profile matches `org.zyra-project.interactive-sphere`
exactly, and that the profile includes the distribution certificate you exported.

**iOS: "Unable to authenticate with App Store Connect"**
→ Check that `APP_STORE_CONNECT_API_KEY_ID`, `API_ISSUER_ID`, and the `.p8` key
are all from the same API key. The `.p8` can only be downloaded once — if you lost
it, revoke and recreate the key.

**Android: "Upload failed — package name mismatch"**
→ The `applicationId` in `src-tauri/gen/android/app/build.gradle.kts` must match
the package name you registered in Play Console (`org.zyra_project.interactive_sphere`).

**Android: "Keystore was tampered with"**
→ Re-export the keystore and re-encode as base64. Ensure no trailing newline
was added during copy-paste.

**Either platform: "Version code already used"**
→ Bump the version in `package.json` / `tauri.conf.json` before re-running.
Each upload must have a unique version code.
