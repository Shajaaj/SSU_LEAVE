# Security Specification: Special Services Leave Management Portal

## 1. Architecture & Data Invariants (Cloudflare Workers + Firebase Custom Tokens)

1. **Default-Deny Perimeter**: Any collection or subcollection not explicitly matched under `/databases/{database}/documents` is denied for all reads and writes.
2. **Server-Verified Staff ID + Numeric PIN & Custom Token Auth**:
   - Employees sign in using **Staff ID + numeric PIN** (`4–12` digits) only.
   - Plaintext PINs are never stored in Firestore, `localStorage`, sessionStorage, or source code.
   - `POST /api/auth/login` runs inside a Cloudflare Worker (`worker/index.ts`) using `FIREBASE_SERVICE_ACCOUNT_KEY` stored exclusively in Cloudflare encrypted Worker secrets.
   - The Worker validates that the Staff ID already exists and is active in `staff/{staffId}` (never auto-registering unknown Staff IDs), verifies the numeric PIN against a 16-byte random salt + `PBKDF2-SHA256` (`100,000` iterations) hash in `staffPinSecrets/{staffId}`, enforces per-IP sliding-window rate limiting (`20 req/min`) plus persistent per-Staff-ID `5`-attempt lockout (`15` minutes), and mints a short-lived RS256 Firebase Custom Token (`signInWithCustomToken`).
   - `POST /api/auth/change-pin` and `POST /api/admin/reset-pin` verify the caller's Firebase ID Token against Google's JWK set before updating `staffPinSecrets/{staffId}` and clearing/setting `mustChangePassword` on `staff/{staffId}` server-side.
   - `firestore.rules` explicitly denies all browser SDK access to `staffPinSecrets/{staffId}` (`allow read, write: if false;`).
   - Unauthenticated clients cannot query `staff`, `staffAuthLinks`, `staffPinSecrets`, `leaveRequests`, `dailyCapacity`, `dailyCapacityDetails`, or `auditLogs`.
3. **UID-to-Staff-ID & RBAC Integrity (`staffAuthLinks/{uid}`)**:
   - `staffAuthLinks/{uid}` maps `request.auth.uid` to `{ uid, staffId, role, designation, isActive }` so `firestore.rules` resolves the caller's exact `staffId` and `role` directly from Firestore without trusting client-submitted parameters.
   - Regular staff (`role == 'staff'`) cannot create, update, or delete `staff`, `staffAuthLinks`, or `staffPinSecrets` documents, and cannot alter their `role`, `designation`, `isActive`, `mustChangePassword`, or `annualPeriodLimit`.
   - `staff` list queries are restricted to `executive` and `manager` roles; regular staff can only `get` their own `staff/{staffId}` record and view non-PII colleague leave spans via `dailyCapacityDetails/{dateKey}`.
4. **Leave Lifecycle & Immutability (`leaveRequests/{requestId}`)**:
   - Staff can only create `leaveRequests` where `incoming().staffId == callerStaffId()`, `incoming().uid == request.auth.uid`, `leaveType == 'Annual Leave'`, `status == 'pending'`, `modificationRequestType == 'none'`, `startDate <= endDate`, `1 <= daysCount <= 30`, and `createdAt == request.time`.
   - Staff cannot approve, reject, or mutate `status` to `'approved'` or `'rejected'`.
   - Once `'approved'`, staff cannot alter `startDate`, `endDate`, `dates`, or `status`; they may only submit a modification/cancellation request (`modificationRequestType` in `['edit', 'cancel']`) while `status` remains `'approved'`.
5. **Daily Capacity Bound (Max 10 Combined Assistant Officers & Attendants)**:
   - `dailyCapacity/{dateKey}` enforces `approvedCount >= 0 && approvedCount <= maxCapacity && maxCapacity <= 10` at the security-rule layer.
   - Only active `executive` or `manager` accounts can write `dailyCapacity` and `dailyCapacityDetails`.
   - Approvals and modifications run inside Firestore `runTransaction()` across `leaveRequests/{requestId}`, `dailyCapacity/{dateKey}`, `dailyCapacityDetails/{dateKey}`, and `auditLogs/{logId}`.
6. **Immutable Append-Only Audit Trail (`auditLogs/{logId}`)**:
   - `auditLogs/{logId}` denies all updates and deletes (`allow update, delete: if false;`).
   - Only `manager` accounts can read `auditLogs`.
   - Every `leaveRequests` create/update requires a matching `auditLogs` document created in the same atomic batch/transaction (`existsAfter(/databases/$(database)/documents/auditLogs/$(incoming().lastAuditLogId))`).

---

## 2. Explicit Operational Boundaries

1. **Multi-Document Rule Boundary**: Firestore Security Rules cannot iterate over a dynamic `dates[]` array (`1..30` dates) or count annual leave periods across collections in a single rule expression. Therefore, multi-day range validation, annual 3-period limit checks, and concurrent approval checks rely on Firestore `runTransaction()` combined with per-document rule caps (`approvedCount <= maxCapacity && maxCapacity <= 10`).
2. **Per-Isolate IP Rate Limit + Persistent Per-Account Lockout**: IP rate limiting operates per Cloudflare Worker isolate (`RATE_LIMIT_MAX_ATTEMPTS`, default 20/min), while the 5-attempt failed PIN lockout (`15` minutes) is persisted in Cloud Firestore (`staffPinSecrets/{staffId}`) so brute-force lockouts hold globally across all edge POPs.

---

## 3. Adversarial Verification Cases

1. Unauthenticated `get` or `list` on `/staff/A-5530`, `/staffAuthLinks/{uid}`, or `/staffPinSecrets/A-5530` -> `PERMISSION_DENIED`.
2. Regular staff reading another employee's `/staff/{otherStaffId}` or `/leaveRequests/{otherReqId}` -> `PERMISSION_DENIED`.
3. Regular staff updating `/staff/{ownStaffId}` to change `role: 'manager'`, `mustChangePassword: false`, or `annualPeriodLimit: 10` -> `PERMISSION_DENIED`.
4. Regular staff self-approving `/leaveRequests/{reqId}` (`status: 'approved'`) -> `PERMISSION_DENIED`.
5. Ghost/extra field injection on `/leaveRequests/{reqId}` create -> `PERMISSION_DENIED`.
6. Regular staff directly editing `dates` or `startDate` on an `'approved'` leave request -> `PERMISSION_DENIED`.
7. Executive setting `approvedCount: 11` on `/dailyCapacity/2026-12-01` -> `PERMISSION_DENIED`.
8. Regular staff attempting write on `/dailyCapacity/2026-12-01` -> `PERMISSION_DENIED`.
9. Manager attempting `update` or `delete` on `/auditLogs/{logId}` -> `PERMISSION_DENIED`.
10. Signed-in token lacking an active `staffAuthLinks/{uid}` document attempting settings write -> `PERMISSION_DENIED`.
11. Resource poisoning with invalid document ID characters or oversized `reason` (`> 500` chars) -> `PERMISSION_DENIED`.
12. Creating `staff/{staffId}` containing a legacy `passwordHash` field -> `PERMISSION_DENIED`.
13. Even an authenticated `manager` attempting to read or modify `/staffPinSecrets/{staffId}` directly via Firebase Web SDK -> `PERMISSION_DENIED`.
