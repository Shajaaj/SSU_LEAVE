/**
 * Firestore Security Rules Verification Suite — Special Services Leave Management Portal
 *
 * Covers the active Spark-tier schema (`staff`, `staffAuthLinks`, `leaveRequests`,
 * `dailyCapacity`, `dailyCapacityDetails`, `auditLogs`, `appSettings`).
 * Run against the Firebase Emulator Suite (`@firebase/rules-unit-testing`)
 * to verify all adversarial payloads return PERMISSION_DENIED.
 */

export interface AdversarialRuleTestCase {
  id: number;
  name: string;
  collection: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  actor: {
    uid: string | null;
    role: 'unauthenticated' | 'staff' | 'executive' | 'manager' | 'unverified';
    emailVerified: boolean;
  };
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED' | 'ALLOWED';
}

export const ADVERSARIAL_RULE_PAYLOADS: AdversarialRuleTestCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read of staff record',
    collection: 'staff/A-5530',
    operation: 'get',
    actor: { uid: null, role: 'unauthenticated', emailVerified: false },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Regular staff reading another employee leaveRequest',
    collection: 'leaveRequests/req_other_staff',
    operation: 'get',
    actor: { uid: 'staff_a_uid', role: 'staff', emailVerified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Regular staff self-escalating role to manager on staff/{staffId}',
    collection: 'staff/A-7111',
    operation: 'update',
    actor: { uid: 'staff_a_uid', role: 'staff', emailVerified: true },
    payload: {
      role: 'manager',
      annualPeriodLimit: 10,
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Regular staff self-approving own pending leave request',
    collection: 'leaveRequests/req_001',
    operation: 'update',
    actor: { uid: 'staff_a_uid', role: 'staff', emailVerified: true },
    payload: { status: 'approved' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow ghost field injection on leaveRequest create',
    collection: 'leaveRequests/req_002',
    operation: 'create',
    actor: { uid: 'staff_a_uid', role: 'staff', emailVerified: true },
    payload: {
      requestId: 'req_002',
      uid: 'staff_a_uid',
      staffId: 'A-7111',
      staffName: 'Mohamed Adil',
      designation: 'ASSISTANT OFFICER',
      countsTowardDailyCap: true,
      leaveType: 'Annual Leave',
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      dates: ['2026-12-01', '2026-12-02'],
      daysCount: 2,
      calendarYear: 2026,
      reason: 'Annual family travel',
      status: 'pending',
      modificationRequestType: 'none',
      isAutoApproved: true,
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Regular staff directly modifying dates on an approved leave request',
    collection: 'leaveRequests/req_approved_001',
    operation: 'update',
    actor: { uid: 'staff_a_uid', role: 'staff', emailVerified: true },
    payload: {
      startDate: '2026-12-10',
      endDate: '2026-12-12',
      dates: ['2026-12-10', '2026-12-11', '2026-12-12'],
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Executive exceeding daily capacity cap (approvedCount = 11)',
    collection: 'dailyCapacity/2026-12-01',
    operation: 'update',
    actor: { uid: 'exec_uid', role: 'executive', emailVerified: true },
    payload: {
      date: '2026-12-01',
      approvedCount: 11,
      maxCapacity: 10,
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Regular staff attempting to write dailyCapacity counter directly',
    collection: 'dailyCapacity/2026-12-01',
    operation: 'create',
    actor: { uid: 'staff_a_uid', role: 'staff', emailVerified: true },
    payload: {
      date: '2026-12-01',
      approvedCount: 0,
      maxCapacity: 10,
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Manager attempting to delete an immutable auditLog entry',
    collection: 'auditLogs/log_001',
    operation: 'delete',
    actor: { uid: 'manager_uid', role: 'manager', emailVerified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Signed-in token without active staffAuthLinks entry attempting settings write',
    collection: 'appSettings/portalConfig',
    operation: 'update',
    actor: { uid: 'spoof_unlinked_uid', role: 'unverified', emailVerified: false },
    payload: { maxDailyCombinedCap: 10 },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Resource poisoning with invalid path ID or oversized reason',
    collection: 'leaveRequests/invalid.id$with*chars',
    operation: 'create',
    actor: { uid: 'staff_a_uid', role: 'staff', emailVerified: true },
    payload: {
      reason: 'x'.repeat(2000),
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Creating staff document containing passwordHash field',
    collection: 'staff/A-9999',
    operation: 'create',
    actor: { uid: 'manager_uid', role: 'manager', emailVerified: true },
    payload: {
      staffId: 'A-9999',
      fullName: 'Test Staff',
      designation: 'ASSISTANT OFFICER',
      role: 'staff',
      isActive: true,
      passwordHash: 'should_never_be_stored',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 13,
    name: 'Manager attempting to read or tamper with server-only staffPinSecrets via client SDK',
    collection: 'staffPinSecrets/A-5530',
    operation: 'get',
    actor: { uid: 'manager_uid', role: 'manager', emailVerified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
];
