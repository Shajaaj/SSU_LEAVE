# Security Specification: Special Services Leave Management Portal

## 1. Architecture & Data Invariants (Firebase Spark Free Tier)

1. **Default-Deny Perimeter**: Any collection or subcollection not explicitly matched under `/databases/{database}/documents` is denied for all reads and writes.
2. **Staff ID Login Mapping (Zero Public Directory Exposure)**:
   - Employees sign in using **Staff ID + Password** only.
   - The frontend deterministically maps each Staff ID to an internal Firebase Authentication identifier (`a5530@staff.example.com` for `A-5530`, `a10002@staff.example.com` for `A10002`) via `src/utils/staffAuthId.ts`.
   - Internal auth accounts are created with `emailVerified: true` by trusted local Admin CLI scripts (`scripts/migrateToFirebaseAuth.ts`, `scripts/adminStaffAuth.ts`), so staff never need real email addresses or verification links while `firestore.rules` still strictly requires `request.auth != null && request.auth.token.email_verified == true`.
   - Unauthenticated clients cannot query `staff`, `staffAuthLinks`, `leaveRequests`, `dailyCapacity`, or `auditLogs`.
3. **UID-to-Staff-ID & RBAC Integrity (`staffAuthLinks/{uid}`)**:
   - `staffAuthLinks/{uid}` maps `request.auth.uid` to `{ uid, staffId, role, designation, isActive }` so `firestore.rules` resolves the caller's exact `staffId` and `role` directly on the server without trusting client-submitted parameters.
   - Regular staff (`role == 'staff'`) cannot create or delete `staff` or `staffAuthLinks` documents, and cannot alter their `role`, `designation`, `isActive`, or `annualPeriodLimit`. Their only permitted write on `staff/{staffId}` is one-way clearing of `mustChangePassword` from `true` to `false` on their own document after updating their password in Firebase Authentication.
   - `staff` list queries are restricted to `executive` and `manager` roles; regular staff can only `get` their own `staff/{staffId}` record and view non-PII colleague leave spans via `dailyCapacityDetails/{dateKey}`.
4. **Leave Lifecycle & Immutability (`leaveRequests/{requestId}`)**:
   - Staff can only create `leaveRequests` where `incoming().staffId == callerStaffId()`, `incoming().uid == request.auth.uid`, `leaveType == 'Annual Leave'`, `status == 'pending'`, `modificationRequestType == 'none'`, `startDate <= endDate`, `1 <= daysCount <= 30`, and `createdAt == request.time`.
   - Staff cannot approve, reject, or mutate `status` to `'approved'` or `'rejected'`.
   - Once `'approved'`, staff cannot alter `startDate`, `endDate`, `dates`, or `status`; they may only submit a modification/cancellation request (`modificationRequestType` in `['edit', 'cancel']`) while `status` remains `'approved'`.
5. **Daily Capacity Bound (Max 10 Combined Assistant Officers & Attendants)**:
   - `dailyCapacity/{dateKey}` enforces `approvedCount >= 0 && approvedCount <= maxCapacity && maxCapacity <= 10` at the security-rule layer.
   - Only active, verified `executive` or `manager` accounts can write `dailyCapacity` and `dailyCapacityDetails`.
   - Approvals and modifications run inside Firestore `runTransaction()` across `leaveRequests/{requestId}`, `dailyCapacity/{dateKey}`, `dailyCapacityDetails/{dateKey}`, and `auditLogs/{logId}`.
6. **Immutable Append-Only Audit Trail (`auditLogs/{logId}`)**:
   - `auditLogs/{logId}` denies all updates and deletes (`allow update, delete: if false;`).
   - Only `manager` accounts can read `auditLogs`.
   - Every `leaveRequests` create/update requires a matching `auditLogs` document created in the same atomic batch/transaction (`existsAfter(/databases/$(database)/documents/auditLogs/$(incoming().lastAuditLogId))`).

---

## 2. Explicit Spark Free-Tier Limitations

Because the portal runs as a static SPA on **Firebase Hosting (Spark Free Tier)** without Cloud Functions or a continuously running Node.js backend:

1. **Multi-Document Rule Boundary**: Firestore Security Rules cannot iterate over a dynamic `dates[]` array (`1..30` dates) or count annual leave periods across collections in a single rule expression. Therefore, multi-day range validation, annual 3-period limit checks, and multi-day concurrent approval checks rely on client-executed `runTransaction()` combined with per-document rule caps (`approvedCount <= maxCapacity && maxCapacity <= 10`). Full server-side enforcement against a compromised Executive/Manager browser client would require upgrading to the Firebase **Blaze** plan and moving approvals to Cloud Functions.
2. **Firebase Authentication User Management**: Static browser clients cannot create/delete other Firebase Authentication users or reset another employee's password without exposing Admin SDK credentials. Those operations are intentionally executed only by trusted administrators running `scripts/migrateToFirebaseAuth.ts` or `scripts/adminStaffAuth.ts` locally.

---

## 3. Adversarial Verification Cases

1. Unauthenticated `get` or `list` on `/staff/A-5530` or `/staffAuthLinks/{uid}` -> `PERMISSION_DENIED`.
2. Regular staff reading another employee's `/staff/{otherStaffId}` or `/leaveRequests/{otherReqId}` -> `PERMISSION_DENIED`.
3. Regular staff updating `/staff/{ownStaffId}` to change `role: 'manager'` or `annualPeriodLimit: 10` -> `PERMISSION_DENIED`.
4. Regular staff self-approving `/leaveRequests/{reqId}` (`status: 'approved'`) -> `PERMISSION_DENIED`.
5. Ghost/extra field injection on `/leaveRequests/{reqId}` create -> `PERMISSION_DENIED`.
6. Regular staff directly editing `dates` or `startDate` on an `'approved'` leave request -> `PERMISSION_DENIED`.
7. Executive setting `approvedCount: 11` on `/dailyCapacity/2026-12-01` -> `PERMISSION_DENIED`.
8. Regular staff attempting write on `/dailyCapacity/2026-12-01` -> `PERMISSION_DENIED`.
9. Manager attempting `update` or `delete` on `/auditLogs/{logId}` -> `PERMISSION_DENIED`.
10. Signed-in token with `email_verified == false` attempting any read/write -> `PERMISSION_DENIED`.
11. Resource poisoning with invalid document ID characters or oversized `reason` (`> 500` chars) -> `PERMISSION_DENIED`.
12. Creating `staff/{staffId}` containing a legacy `passwordHash` field -> `PERMISSION_DENIED`.
