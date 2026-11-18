# Special Services Leave Management Portal — Cloudflare Workers & Firebase (`ss-leave-management`) Guide

## 1. Architecture Summary

This portal runs on **Cloudflare Workers** (serving the Vite React SPA from `./dist` and authentication API endpoints `/api/*` from `worker/index.ts`), connected to Firebase project **`ss-leave-management`** and its standard **`(default)`** Cloud Firestore database.

There is **no Express server**, **no `firebase-admin` code in browser bundles**, and **no plaintext PIN storage anywhere**.

### Key Components
- **Public Firebase Web Config**: `src/firebase/client.ts` loads the public Firebase web config from `firebase-applet-config.json` (with optional `VITE_FIREBASE_*` overrides). Never put service account private keys in `VITE_*` variables or GitHub.
- **Server-Side Numeric PIN Verification & Firebase Custom Tokens (`worker/index.ts`)**:
  - Employees enter only their **Staff ID** and **numeric PIN** (`4–12` digits).
  - `POST /api/auth/login` verifies that the Staff ID already exists and is active in `staff/{staffId}` (unknown Staff IDs are never auto-registered), checks a salted **PBKDF2-SHA256** (`100,000` iterations, 16-byte random salt) hash stored in server-only `staffPinSecrets/{staffId}`, enforces per-IP sliding-window rate limiting and persistent `5`-attempt account lockout (`15` minutes), and mints a short-lived RS256 Firebase Authentication **Custom Token**.
  - The browser establishes its authenticated Firebase session via `signInWithCustomToken(auth, customToken)`.
  - `POST /api/auth/change-pin` verifies the caller's Firebase ID Token, checks their current PIN, saves a new salted PBKDF2-SHA256 hash centrally in `staffPinSecrets/{staffId}`, clears `mustChangePassword` on `staff/{staffId}`, and records an audit log so the new PIN works immediately across every device.
  - `POST /api/admin/reset-pin` lets an authenticated **Manager** assign a temporary PIN (with `mustChangePassword: true`) from the Administration view.
- **Real-Time Synchronization**: `src/services/firebasePortalService.ts` uses Firestore `onSnapshot` listeners for live updates across all devices and `runTransaction()` for concurrent leave approvals and modifications.
- **Maldives Timezone (`Asia/Male`)**: All leave dates are stored as `YYYY-MM-DD` strings and validated in Maldives time.

---

## 2. Manual Setup Required Before Login Works Live

Complete these steps in order before staff sign in:

### Step A — Enable Firebase Services (`ss-leave-management`)
1. Open the **Firebase Console** for project **`ss-leave-management`**.
2. Go to **Build → Authentication** and click **Get started** (if Authentication is not initialized yet; no public sign-up provider is required because Custom Tokens work natively once Firebase Authentication is enabled).
3. Go to **Build → Firestore Database** and ensure the `(default)` Firestore database exists.
4. *(Recommended)* Under **Authentication → Settings → Authorized domains**, add your Cloudflare Workers domain (for example `ss-leave-management.<your-subdomain>.workers.dev` and any custom domain).

### Step B — Generate a Firebase Service Account Key
1. In Firebase Console → **Project Settings → Service Accounts**, click **Generate new private key** and download the JSON file securely to your workstation.
2. **Never commit this JSON file to GitHub** and never place it in `VITE_*` variables or `wrangler.jsonc`.
3. Store it only in:
   - Your local untracked `.env` file (`FIREBASE_SERVICE_ACCOUNT_KEY='{...}'` or `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`) for running one-time Admin CLI scripts, and
   - Your Cloudflare Worker secret (Step D below).

### Step C — Deploy Updated Firestore Security Rules & Indexes
The updated `firestore.rules` permits Custom Token sessions (`sign_in_provider == 'custom'`), enforces active `staffAuthLinks/{uid}` membership, and blocks all browser access to `staffPinSecrets/{staffId}`:

```bash
npm install
npm run lint
npm run build

firebase login
firebase deploy --only firestore:rules,firestore:indexes --project ss-leave-management
```

### Step D — Upload the Service Account Secret to Cloudflare Workers
Upload your service account JSON into an encrypted Cloudflare secret (never checked into Git):

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY < /path/to/service-account.json
```

*(If deploying via Cloudflare Workers Builds connected to GitHub, add `FIREBASE_SERVICE_ACCOUNT_KEY` as a **Secret** environment variable in Cloudflare Dashboard → Workers & Pages → `ss-leave-management` → Settings → Variables and Secrets.)*

### Step E — Initialize Default `1234` PINs for Existing Authorized Staff (Non-Destructive)
Run the migration script from your trusted workstation. It reads all existing `staff` records without overwriting names, designations, roles, limits, or `leaveRequests`, creates `staffAuthLinks/{uid}`, and creates hashed `staffPinSecrets/{staffId}` entries (only where missing, unless `--reset-all-pins` is passed) with `mustChangePassword: true`:

```bash
# 1. Dry run first (verifies existing records and checks Staff ID UID collisions)
npx tsx scripts/migrateToFirebaseAuth.ts --dry-run

# 2. Initialize PBKDF2-hashed PIN 1234 for all existing staff (requires change on first login)
INITIAL_STAFF_PIN=1234 npx tsx scripts/migrateToFirebaseAuth.ts
```

> If your `ss-leave-management` Firestore `staff` collection is initially empty, either restore your exported `staff` documents first or append `--seed-initial-roster` to seed missing records without overwriting existing ones.

*(Optional, after verifying logins work)* Strip any legacy `passwordHash` fields from `staff/{staffId}`:

```bash
INITIAL_STAFF_PIN=1234 npx tsx scripts/migrateToFirebaseAuth.ts --strip-legacy-hashes
```

### Step F — Browser-Based GitHub Actions CSV Import (`data/ssleave_staff_roster.csv`)
You can validate and idempotently import `data/ssleave_staff_roster.csv` directly from GitHub's **Actions** tab using `.github/workflows/import-staff-roster.yml`:

1. Add `FIREBASE_SERVICE_ACCOUNT_KEY` under **GitHub Repository → Settings → Secrets and variables → Actions → New repository secret**.
2. Open **Actions → Import Staff Roster (PIN Auth) → Run workflow**.
3. Run **`mode: validate`** first (read-only offline check; requires no Firebase credentials).
4. Once validation passes, run **`mode: import`** with **`confirm_import: IMPORT`** to create missing `staff/{staffId}`, `staffAuthLinks/{uid}`, and `staffPinSecrets/{staffId}` records (`PBKDF2-SHA256` hashed initial PIN requiring change on first login) while preserving existing records, PINs, leave requests, and rules.

---

## 3. Build & Deploy on Cloudflare Workers

Cloudflare Workers configuration lives in `wrangler.jsonc` (`main: "worker/index.ts"`, `assets.directory: "./dist"`, `assets.run_worker_first: ["/api/*"]`).

### Cloudflare Workers / GitHub Build Settings
- **Install command**: `bun install --frozen-lockfile`
- **Build command**: `bun run build`
- **Deploy command**: `npx wrangler deploy` (or automatic Workers Git integration)

### Local End-to-End Test (Optional)
```bash
bun run build
npx wrangler dev
```
*(In local `wrangler dev`, create an untracked `.dev.vars` file with `FIREBASE_SERVICE_ACCOUNT_KEY=...` — `.dev.vars` must remain untracked in Git.)*

---

## 4. Ongoing Administrator CLI Commands

All CLI commands preserve existing data and store only PBKDF2-SHA256 salted hashes in `staffPinSecrets/{staffId}`:

```bash
# Validate CSV roster offline without Firebase credentials
npx tsx scripts/adminStaffAuth.ts import data/ssleave_staff_roster.csv --validate-only

# Provision a single new staff member
npx tsx scripts/adminStaffAuth.ts provision A-10018 "Full Name" "ASSISTANT OFFICER" staff "VIP Lounge" --pin 1234

# Bulk import from CSV / Markdown file (idempotent; preserves existing staff & PINs)
npx tsx scripts/adminStaffAuth.ts import data/ssleave_staff_roster.csv --pin 1234

# Reset an employee's PIN via CLI (or use the Reset PIN button in Administration)
npx tsx scripts/adminStaffAuth.ts reset-pin A-7111 --pin 1234

# Sync deactivated staff (staff.isActive == false) to staffAuthLinks & Firebase Auth
npx tsx scripts/adminStaffAuth.ts sync-disabled

# Clean up PIN secret, auth link, and Firebase Auth user for a removed employee
npx tsx scripts/adminStaffAuth.ts delete-auth A-7111
```

---

## 5. Rollback Plan

1. **Before `migrateToFirebaseAuth.ts`**: No records are modified; `--dry-run` verifies collision safety first, and live runs automatically save `.local-staff-backup-<timestamp>.json`.
2. **If an issue is discovered after deployment**:
   - All original `staff/{staffId}` documents, `leaveRequests`, `dailyCapacity`, `dailyCapacityDetails`, and `auditLogs` remain untouched under their original document IDs.
   - Roll back the Cloudflare Worker deployment in Cloudflare Dashboard and/or re-deploy previous `firestore.rules`.
