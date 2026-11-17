# Special Services Leave Management Portal — Firebase Hosting (Spark Free Tier) Guide

## 1. Architecture Summary

This portal runs as a static React + Vite single-page application deployed directly on **Firebase Hosting** (Spark Free Tier), connected to Firebase project **`gen-lang-client-0180778148`** and Cloud Firestore named database **`ai-studio-ee2eb30d-6479-40ee-8c90-a5e78ecc9769`**.

There is **no continuously running Node.js server**, **no Express runtime**, and **no `firebase-admin` code in the browser**.

### Key Components
- **Public Firebase Web Config**: `src/firebase/client.ts` loads the public Firebase web config from `firebase-applet-config.json` (with optional `VITE_FIREBASE_*` overrides). Never put service account private keys in `VITE_*` variables.
- **Deterministic Staff ID Normalization**: `src/utils/staffAuthId.ts` maps every employee's Staff ID into an internal Firebase Authentication email identifier without changing the login UI:
  - Example: `A-5530` → `a5530@staff.example.com`
  - Example: `A10002` → `a10002@staff.example.com`
- **Real-Time Synchronization**: `src/services/firebasePortalService.ts` uses Firestore `onSnapshot` listeners for live updates across all devices and `runTransaction()` for concurrent leave approvals and modifications.
- **Maldives Timezone (`Asia/Male`)**: All leave dates are stored as `YYYY-MM-DD` strings and validated in Maldives time.

---

## 2. Firebase Console Prerequisites (One-Time)

1. Open Firebase Console for project **`gen-lang-client-0180778148`**.
2. Go to **Authentication → Sign-in method** and ensure **Email/Password** is **Enabled**.
3. Keep **Public sign-up / self-registration disabled** in the app (no registration screen exists in the frontend; all accounts are created by an administrator via CLI).

---

## 3. Step-by-Step Migration of Existing 81 Staff Accounts

Run the one-time migration script from a trusted administrator workstation (never from the browser).

1. Export a Service Account key from **Firebase Console → Project Settings → Service Accounts → Generate new private key**, and point either `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json` or `FIREBASE_SERVICE_ACCOUNT_KEY` in a local `.env` (never committed to git).
2. Run a dry run first to verify all existing staff IDs and collision checks:

```bash
npx tsx scripts/migrateToFirebaseAuth.ts --dry-run
```

3. Run the live migration (creates Firebase Auth accounts with `emailVerified: true` and unique random 12-character temporary passwords, writes `authUid`/`authEmail` on `staff/{staffId}` and `staffAuthLinks/{uid}`, and saves a `chmod 600` backup JSON + one-time credentials CSV locally):

```bash
npx tsx scripts/migrateToFirebaseAuth.ts
```

4. *(Optional, after verifying logins work)* Strip legacy `passwordHash` fields from `staff/{staffId}`:

```bash
npx tsx scripts/migrateToFirebaseAuth.ts --strip-legacy-hashes
```

5. Securely distribute each employee's one-time temporary password from `.local-initial-credentials-*.csv`, then delete the local CSV file. Every employee is flagged `mustChangePassword: true` and prompted to set their personal password (`>= 8` chars) on first login.

---

## 4. Ongoing Administrator CLI Commands (Spark Tier)

Because browser clients cannot create/delete Firebase Auth users or reset other employees' passwords without exposing Admin credentials, use `scripts/adminStaffAuth.ts` locally:

```bash
# Provision a single new staff member
npx tsx scripts/adminStaffAuth.ts provision A-10018 "Full Name" "ASSISTANT OFFICER" staff "VIP Lounge"

# Bulk import from CSV / Markdown file (checks collisions before creating accounts)
npx tsx scripts/adminStaffAuth.ts import ./roster.csv

# Reset an employee's password (generates random 12-char temporary password unless --password given)
npx tsx scripts/adminStaffAuth.ts reset-password A-7111

# Sync deactivated staff (staff.isActive == false) to Firebase Auth disabled flag
npx tsx scripts/adminStaffAuth.ts sync-disabled

# Delete a removed employee's Firebase Auth user
npx tsx scripts/adminStaffAuth.ts delete-auth A-7111
```

---

## 5. Build & Deploy to Firebase Hosting

```bash
# 1. Install dependencies & verify TypeScript / production bundle
npm install
npm run lint
npm run build

# 2. Authenticate Firebase CLI (if not already logged in)
firebase login

# 3. Deploy Firestore Security Rules & Indexes (AFTER running migrateToFirebaseAuth.ts!)
firebase deploy --only firestore:rules,firestore:indexes --project gen-lang-client-0180778148

# 4. Deploy static SPA to Firebase Hosting
firebase deploy --only hosting --project gen-lang-client-0180778148
```

`firebase.json` is configured with `hosting.public: "dist"` and SPA rewrite `** -> /index.html`, and targets database `ai-studio-ee2eb30d-6479-40ee-8c90-a5e78ecc9769`.

---

## 6. Explicit Spark Free-Tier Limitations & Risk Assessment

1. **Multi-Document Rule Limitation**: Firestore Security Rules cannot loop over dynamic `dates[]` arrays (`1..30`) or count annual leave periods across collections inside a single rule expression. Therefore, multi-day capacity validation, annual 3-period checks, and concurrent approval safety rely on Firestore `runTransaction()` executed by signed-in Executive/Manager clients, backed by rule-level caps (`approvedCount >= 0 && approvedCount <= maxCapacity && maxCapacity <= 10`) on every `dailyCapacity/{dateKey}` document. Full server-side enforcement against a compromised Executive browser client requires upgrading to Firebase **Blaze** and moving approvals to Cloud Functions.
2. **Auth Provisioning & Password Resets**: Performed via local Admin CLI scripts rather than in-browser buttons because Spark Free Tier excludes Cloud Functions.

---

## 7. Rollback Plan

1. **Before `migrateToFirebaseAuth.ts`**: No records are modified; `--dry-run` verifies collision safety first, and live runs automatically save `.local-staff-backup-<timestamp>.json`.
2. **If an issue is discovered after deployment**:
   - All 81 original `staff/{staffId}` documents, `leaveRequests`, `dailyCapacity`, `dailyCapacityDetails`, and `auditLogs` remain untouched under their original document IDs (unless `--strip-legacy-hashes` was explicitly run).
   - You can immediately revert Hosting to the previous release in **Firebase Console → Hosting → Release history → Rollback**, and/or re-deploy previous `firestore.rules` if needed.
