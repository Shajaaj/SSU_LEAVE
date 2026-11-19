import {
  browserLocalPersistence,
  browserSessionPersistence,
  setPersistence,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth';
import {
  Unsubscribe,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { OperationType, auth, db, handleFirestoreError } from '../firebase/client';
import {
  AppSettings,
  AuditLog,
  DailyCapacity,
  DailyCapacityDetail,
  Designation,
  LeaveRequest,
  LeaveType,
  StaffAuthLink,
  StaffProfile,
  UserRole,
} from '../types/portal';
import { expandDateRange, getMonthMetadata } from '../utils/maldivesDate';
import { isValidPinFormat, isValidStaffIdFormat } from '../utils/staffAuthId';

const REMEMBERED_STAFF_ID_KEY = 'ssu_remembered_staff_id';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  maxDailyCombinedCap: 10,
  maxAnnualLeavePeriods: 3,
  pendingReservesCapacity: false,
  timezone: 'Asia/Male',
  unitName: 'Special Services Unit',
  airportName: 'Velana International Airport',
  updatedByStaffId: 'SYSTEM',
};

function makeClientId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

export function doesDesignationCountTowardDailyCap(designation: Designation): boolean {
  return designation === 'ASSISTANT OFFICER' || designation === 'ATTENDANT';
}

export function getRememberedStaffId(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(REMEMBERED_STAFF_ID_KEY) || '';
  } catch {
    return '';
  }
}

export function setRememberedStaffId(staffId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (staffId) {
      window.localStorage.setItem(REMEMBERED_STAFF_ID_KEY, staffId);
    } else {
      window.localStorage.removeItem(REMEMBERED_STAFF_ID_KEY);
    }
  } catch {
    // Ignore storage access restrictions
  }
}

function normalizeStaffProfile(raw: Record<string, unknown>, id: string): StaffProfile {
  const designation = (raw.designation as Designation) || 'ASSISTANT OFFICER';
  return {
    staffId: String(raw.staffId || id),
    authUid: raw.authUid ? String(raw.authUid) : undefined,
    authEmail: raw.authEmail ? String(raw.authEmail) : undefined,
    fullName: String(raw.fullName || ''),
    designation,
    role: (raw.role as UserRole) || 'staff',
    isActive: raw.isActive !== false,
    mustChangePassword: Boolean(raw.mustChangePassword),
    unitSection: String(raw.unitSection || 'Special Services'),
    annualPeriodLimit: Number(raw.annualPeriodLimit || 3),
    countsTowardDailyCap:
      typeof raw.countsTowardDailyCap === 'boolean'
        ? raw.countsTowardDailyCap
        : doesDesignationCountTowardDailyCap(designation),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

async function postWorkerJson<T>(
  path: string,
  payload: Record<string, unknown>,
  bearerToken?: string
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(
      'Unable to reach the authentication server. Check your internet connection and try again.'
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      'PIN authentication Worker endpoint (/api/*) is unavailable. Deploy or run with Cloudflare Workers.'
    );
  }

  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return data;
}

export async function resolveSignedInStaffProfile(
  uid: string
): Promise<StaffProfile> {
  const linkPath = `staffAuthLinks/${uid}`;
  let linkSnap;
  try {
    linkSnap = await getDoc(doc(db, 'staffAuthLinks', uid));
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, linkPath);
  }

  if (!linkSnap.exists()) {
    throw new Error(
      'Your account is not linked to an active staff profile. Please contact an Administrator.'
    );
  }

  const link = linkSnap.data() as StaffAuthLink;
  if (!link.isActive) {
    throw new Error(
      `Account ${link.staffId} has been deactivated. Contact a Manager.`
    );
  }

  const staffPath = `staff/${link.staffId}`;
  let staffSnap;
  try {
    staffSnap = await getDoc(doc(db, 'staff', link.staffId));
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, staffPath);
  }

  if (!staffSnap.exists()) {
    throw new Error(`Staff record ${link.staffId} not found.`);
  }

  const profile = normalizeStaffProfile(
    staffSnap.data() as Record<string, unknown>,
    staffSnap.id
  );
  if (!profile.isActive) {
    throw new Error(
      `Account ${profile.staffId} has been deactivated. Contact a Manager.`
    );
  }
  return profile;
}

export async function loginWithStaffId(
  staffId: string,
  pin: string,
  rememberOnDevice = true
): Promise<{ user: StaffProfile }> {
  const trimmedStaffId = staffId.trim();
  const trimmedPin = pin.trim();
  if (!isValidStaffIdFormat(trimmedStaffId) || !isValidPinFormat(trimmedPin)) {
    throw new Error('Invalid Staff ID or PIN.');
  }

  const authResponse = await postWorkerJson<{
    customToken: string;
    staffId: string;
    mustChangePin?: boolean;
  }>('/api/auth/login', {
    staffId: trimmedStaffId,
    pin: trimmedPin,
  });

  try {
    await setPersistence(
      auth,
      rememberOnDevice ? browserLocalPersistence : browserSessionPersistence
    );
  } catch {
    // Fallback gracefully if third-party iframe blocks IndexedDB persistence
  }

  let credential;
  try {
    credential = await signInWithCustomToken(auth, authResponse.customToken);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || '';
    if (code === 'auth/user-disabled') {
      throw new Error('This account has been deactivated. Contact a Manager.');
    }
    if (code === 'auth/network-request-failed') {
      throw new Error('Network error while connecting to Firebase Authentication.');
    }
    throw new Error(
      err instanceof Error ? err.message : 'Unable to establish authenticated session.'
    );
  }

  try {
    const profile = await resolveSignedInStaffProfile(credential.user.uid);
    if (typeof authResponse.mustChangePin === 'boolean') {
      profile.mustChangePassword = authResponse.mustChangePin;
    }
    setRememberedStaffId(rememberOnDevice ? profile.staffId : null);
    return { user: profile };
  } catch (err) {
    await signOut(auth).catch(() => undefined);
    throw err;
  }
}

export async function logoutSession(): Promise<void> {
  await signOut(auth);
}

export async function changeOwnPassword(
  _staff: StaffProfile,
  currentPin: string,
  newPin: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please sign in again.');
  }

  const trimmedCurrent = currentPin.trim();
  const trimmedNew = newPin.trim();
  if (!isValidPinFormat(trimmedCurrent)) {
    throw new Error('Current PIN must be 4 to 12 numeric digits.');
  }
  if (!isValidPinFormat(trimmedNew)) {
    throw new Error('New PIN must be 4 to 12 numeric digits.');
  }
  if (trimmedNew === trimmedCurrent) {
    throw new Error('New PIN must be different from your current PIN.');
  }

  const idToken = await user.getIdToken(true);
  await postWorkerJson<{ ok: boolean }>(
    '/api/auth/change-pin',
    {
      currentPin: trimmedCurrent,
      newPin: trimmedNew,
    },
    idToken
  );
}

export async function resetStaffPinByManager(
  targetStaffId: string,
  tempPin: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please sign in again.');
  }
  const trimmedPin = tempPin.trim();
  if (!isValidPinFormat(trimmedPin)) {
    throw new Error('Temporary PIN must be 4 to 12 numeric digits.');
  }
  const idToken = await user.getIdToken(true);
  await postWorkerJson<{ ok: boolean; staffId: string }>(
    '/api/admin/reset-pin',
    {
      targetStaffId: targetStaffId.trim(),
      tempPin: trimmedPin,
    },
    idToken
  );
}

export async function addStaffByManager(payload: {
  staffId: string;
  fullName: string;
  designation: Designation;
  role: UserRole;
}): Promise<{ staffId: string }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please sign in again.');
  }

  const trimmedStaffId = payload.staffId.trim();
  const trimmedFullName = payload.fullName.trim();
  if (!isValidStaffIdFormat(trimmedStaffId)) {
    throw new Error('Staff ID must be 2 to 24 letters, numbers, or hyphens.');
  }
  if (trimmedFullName.length < 2 || trimmedFullName.length > 100) {
    throw new Error('Full Name must be between 2 and 100 characters.');
  }

  const idToken = await user.getIdToken(true);
  const res = await postWorkerJson<{ ok: boolean; staffId: string }>(
    '/api/admin/add-staff',
    {
      staffId: trimmedStaffId,
      fullName: trimmedFullName,
      designation: payload.designation,
      role: payload.role,
    },
    idToken
  );

  return { staffId: res.staffId };
}

/* -------------------------------------------------------------------------- */
/* Real-Time onSnapshot Subscriptions                                         */
/* -------------------------------------------------------------------------- */

export function subscribeStaffProfile(
  staffId: string,
  onData: (profile: StaffProfile | null) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = `staff/${staffId}`;
  return onSnapshot(
    doc(db, 'staff', staffId),
    (snap) => {
      if (!snap.exists()) {
        onData(null);
        return;
      }
      onData(normalizeStaffProfile(snap.data() as Record<string, unknown>, snap.id));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

export function subscribeSettings(
  onData: (settings: AppSettings) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'appSettings/portalConfig';
  return onSnapshot(
    doc(db, 'appSettings', 'portalConfig'),
    (snap) => {
      if (!snap.exists()) {
        onData(DEFAULT_APP_SETTINGS);
        return;
      }
      onData({ ...DEFAULT_APP_SETTINGS, ...(snap.data() as Partial<AppSettings>) });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

export function subscribeMyRequests(
  staffId: string,
  onData: (requests: LeaveRequest[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'leaveRequests';
  const q = query(collection(db, 'leaveRequests'), where('staffId', '==', staffId));
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs
        .map((d) => d.data() as LeaveRequest)
        .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

export function subscribeAllRequests(
  onData: (requests: LeaveRequest[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'leaveRequests';
  return onSnapshot(
    collection(db, 'leaveRequests'),
    (snap) => {
      const items = snap.docs
        .map((d) => d.data() as LeaveRequest)
        .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

export function subscribeAllStaff(
  onData: (profiles: StaffProfile[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'staff';
  return onSnapshot(
    collection(db, 'staff'),
    (snap) => {
      const items = snap.docs
        .map((d) => normalizeStaffProfile(d.data() as Record<string, unknown>, d.id))
        .sort((a, b) => a.staffId.localeCompare(b.staffId));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

export function subscribeMonthCapacity(
  year: number,
  month0: number,
  onData: (capMap: Record<string, DailyCapacity>) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const { startDate, endDate } = getMonthMetadata(year, month0);
  const path = 'dailyCapacity';
  const q = query(
    collection(db, 'dailyCapacity'),
    where('date', '>=', startDate),
    where('date', '<=', endDate)
  );
  return onSnapshot(
    q,
    (snap) => {
      const map: Record<string, DailyCapacity> = {};
      for (const d of snap.docs) {
        const data = d.data() as DailyCapacity;
        map[data.date] = data;
      }
      onData(map);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

export function subscribeMonthCapacityDetails(
  year: number,
  month0: number,
  onData: (detailsMap: Record<string, DailyCapacityDetail>) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const { startDate, endDate } = getMonthMetadata(year, month0);
  const path = 'dailyCapacityDetails';
  const q = query(
    collection(db, 'dailyCapacityDetails'),
    where('date', '>=', startDate),
    where('date', '<=', endDate)
  );
  return onSnapshot(
    q,
    (snap) => {
      const map: Record<string, DailyCapacityDetail> = {};
      for (const d of snap.docs) {
        const data = d.data() as DailyCapacityDetail;
        map[data.date] = data;
      }
      onData(map);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

export function subscribeAuditLogs(
  onData: (logs: AuditLog[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const path = 'auditLogs';
  const q = query(
    collection(db, 'auditLogs'),
    orderBy('createdAt', 'desc'),
    limit(200)
  );
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as AuditLog));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Leave & Administrative Transactions                                        */
/* -------------------------------------------------------------------------- */

export async function submitLeaveRequest(
  staff: StaffProfile,
  payload: {
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    reason: string;
  }
): Promise<{ requestId: string }> {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Authentication required. Please log in again.');
  }
  if (payload.leaveType !== 'Annual Leave') {
    throw new Error('Only Annual Leave applications are permitted.');
  }
  const trimmedReason = payload.reason.trim();
  if (trimmedReason.length < 3 || trimmedReason.length > 500) {
    throw new Error('Reason must be between 3 and 500 characters.');
  }

  const expanded = expandDateRange(payload.startDate, payload.endDate, 30);
  if (expanded.error) {
    throw new Error(expanded.error);
  }
  const dates = expanded.dates;
  const calendarYear = Number(payload.startDate.slice(0, 4));

  const settingsSnap = await getDoc(doc(db, 'appSettings', 'portalConfig'));
  const settings = settingsSnap.exists()
    ? ({ ...DEFAULT_APP_SETTINGS, ...settingsSnap.data() } as AppSettings)
    : DEFAULT_APP_SETTINGS;

  const maxCap = settings.maxDailyCombinedCap || 10;
  const annualLimit = staff.annualPeriodLimit || settings.maxAnnualLeavePeriods || 3;

  const userReqsSnap = await getDocs(
    query(collection(db, 'leaveRequests'), where('staffId', '==', staff.staffId))
  );
  const userReqs = userReqsSnap.docs.map((d) => d.data() as LeaveRequest);

  const yearAllocated = userReqs.filter(
    (r) =>
      r.calendarYear === calendarYear &&
      (r.status === 'approved' || r.status === 'pending')
  );
  if (yearAllocated.length >= annualLimit) {
    throw new Error(
      `Annual limit reached for ${calendarYear}: ${yearAllocated.length}/${annualLimit} leave periods used or pending.`
    );
  }

  const bookedDates = new Set<string>();
  for (const r of userReqs) {
    if (r.status === 'approved' || r.status === 'pending') {
      for (const d of r.dates) bookedDates.add(d);
    }
  }
  const overlapping = dates.filter((d) => bookedDates.has(d));
  if (overlapping.length > 0) {
    throw new Error(
      `You already have pending or approved leave on: ${overlapping.join(', ')}.`
    );
  }

  if (staff.countsTowardDailyCap) {
    const capSnaps = await Promise.all(
      dates.map((d) => getDoc(doc(db, 'dailyCapacity', d)))
    );
    const fullDates: string[] = [];
    capSnaps.forEach((snap, idx) => {
      const used = snap.exists() ? Number(snap.data()?.approvedCount || 0) : 0;
      const capLimit = snap.exists() ? Number(snap.data()?.maxCapacity || maxCap) : maxCap;
      if (used >= capLimit) {
        fullDates.push(`${dates[idx]} (${used}/${capLimit})`);
      }
    });
    if (fullDates.length > 0) {
      throw new Error(
        `Daily limit (${maxCap} combined Assistant Officers & Attendants) is full on: ${fullDates.join(', ')}.`
      );
    }
  }

  const requestId = makeClientId('req');
  const logId = makeClientId('log');
  const batch = writeBatch(db);

  batch.set(doc(db, 'leaveRequests', requestId), {
    requestId,
    uid,
    staffId: staff.staffId,
    staffName: staff.fullName,
    designation: staff.designation,
    countsTowardDailyCap: Boolean(staff.countsTowardDailyCap),
    leaveType: 'Annual Leave',
    startDate: payload.startDate,
    endDate: payload.endDate,
    dates,
    daysCount: dates.length,
    calendarYear,
    reason: trimmedReason,
    status: 'pending',
    modificationRequestType: 'none',
    lastAuditLogId: logId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'auditLogs', logId), {
    logId,
    action: 'LEAVE_SUBMITTED',
    targetType: 'leaveRequest',
    targetId: requestId,
    actorStaffId: staff.staffId,
    actorName: staff.fullName,
    actorRole: staff.role,
    summary: `Submitted Annual Leave (${payload.startDate} – ${payload.endDate}, ${dates.length} day${dates.length > 1 ? 's' : ''}).`,
    newStatus: 'pending',
    affectedDates: dates,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `leaveRequests/${requestId}`);
  }

  return { requestId };
}

export async function cancelPendingLeaveRequest(
  staff: StaffProfile,
  req: LeaveRequest
): Promise<void> {
  const logId = makeClientId('log');
  const batch = writeBatch(db);
  batch.update(doc(db, 'leaveRequests', req.requestId), {
    status: 'cancelled',
    lastAuditLogId: logId,
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'auditLogs', logId), {
    logId,
    action: 'LEAVE_CANCELLED',
    targetType: 'leaveRequest',
    targetId: req.requestId,
    actorStaffId: staff.staffId,
    actorName: staff.fullName,
    actorRole: staff.role,
    summary: `Applicant cancelled pending ${req.leaveType} (${req.startDate} – ${req.endDate}).`,
    previousStatus: 'pending',
    newStatus: 'cancelled',
    affectedDates: req.dates.slice(0, 31),
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `leaveRequests/${req.requestId}`);
  }
}

export async function requestLeaveModification(
  staff: StaffProfile,
  req: LeaveRequest,
  payload: {
    type: 'edit' | 'cancel';
    note: string;
    requestedStartDate?: string;
    requestedEndDate?: string;
  }
): Promise<void> {
  if (payload.note.trim().length < 3) {
    throw new Error('Provide an explanation (min 3 characters).');
  }
  if (payload.type === 'edit') {
    const exp = expandDateRange(
      payload.requestedStartDate || '',
      payload.requestedEndDate || '',
      30
    );
    if (exp.error) throw new Error(exp.error);
  }

  const logId = makeClientId('log');
  const batch = writeBatch(db);
  batch.update(doc(db, 'leaveRequests', req.requestId), {
    modificationRequestType: payload.type,
    modificationNote: payload.note.trim(),
    requestedStartDate: payload.type === 'edit' ? payload.requestedStartDate : '',
    requestedEndDate: payload.type === 'edit' ? payload.requestedEndDate : '',
    lastAuditLogId: logId,
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'auditLogs', logId), {
    logId,
    action: 'MOD_REQUESTED',
    targetType: 'leaveRequest',
    targetId: req.requestId,
    actorStaffId: staff.staffId,
    actorName: staff.fullName,
    actorRole: staff.role,
    summary:
      payload.type === 'cancel'
        ? `Requested cancellation of approved leave (${req.startDate} – ${req.endDate}): ${payload.note.trim()}`
        : `Requested date change (${payload.requestedStartDate} – ${payload.requestedEndDate}) on approved leave: ${payload.note.trim()}`,
    previousStatus: 'approved',
    newStatus: 'approved',
    affectedDates: req.dates.slice(0, 31),
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `leaveRequests/${req.requestId}`);
  }
}

export async function approveLeaveRequest(
  reviewer: StaffProfile,
  requestId: string,
  comment: string,
  settings: AppSettings
): Promise<void> {
  const reqRef = doc(db, 'leaveRequests', requestId);
  const logId = makeClientId('log');
  const defaultMaxCap = Math.min(10, Math.max(1, settings.maxDailyCombinedCap || 10));

  try {
    await runTransaction(db, async (tx) => {
      const reqSnap = await tx.get(reqRef);
      if (!reqSnap.exists()) {
        throw new Error('Leave request not found.');
      }
      const reqData = reqSnap.data() as LeaveRequest;
      if (reqData.status !== 'pending') {
        throw new Error(`Cannot approve: request status is already "${reqData.status}".`);
      }

      const capRefs = reqData.dates.map((d) => doc(db, 'dailyCapacity', d));
      const detailRefs = reqData.dates.map((d) => doc(db, 'dailyCapacityDetails', d));
      const capSnaps = await Promise.all(capRefs.map((r) => tx.get(r)));
      const detailSnaps = await Promise.all(detailRefs.map((r) => tx.get(r)));

      const fullDates: string[] = [];
      if (reqData.countsTowardDailyCap) {
        reqData.dates.forEach((dateKey, idx) => {
          const snap = capSnaps[idx];
          const used = snap.exists() ? Number(snap.data()?.approvedCount || 0) : 0;
          const capLimit = snap.exists()
            ? Number(snap.data()?.maxCapacity || defaultMaxCap)
            : defaultMaxCap;
          if (used + 1 > capLimit) {
            fullDates.push(`${dateKey} (${used}/${capLimit})`);
          }
        });
      }

      if (fullDates.length > 0) {
        throw new Error(
          `Approval blocked — daily limit reached on: ${fullDates.join(', ')}.`
        );
      }

      reqData.dates.forEach((dateKey, idx) => {
        const capSnap = capSnaps[idx];
        const detailSnap = detailSnaps[idx];
        const used = capSnap.exists() ? Number(capSnap.data()?.approvedCount || 0) : 0;
        const capLimit = capSnap.exists()
          ? Number(capSnap.data()?.maxCapacity || defaultMaxCap)
          : defaultMaxCap;

        if (reqData.countsTowardDailyCap) {
          tx.set(capRefs[idx], {
            date: dateKey,
            approvedCount: used + 1,
            maxCapacity: Math.min(10, capLimit),
            updatedAt: serverTimestamp(),
          });
        }

        const existingAllocs = (
          detailSnap.exists() ? detailSnap.data()?.allocations || [] : []
        ) as Array<Record<string, unknown>>;
        const filtered = existingAllocs.filter(
          (a) => a.requestId !== reqData.requestId
        );
        filtered.push({
          staffId: reqData.staffId,
          staffName: reqData.staffName,
          designation: reqData.designation,
          requestId: reqData.requestId,
          leaveType: reqData.leaveType,
        });
        tx.set(detailRefs[idx], {
          date: dateKey,
          allocations: filtered.slice(0, 25),
          updatedAt: serverTimestamp(),
        });
      });

      tx.update(reqRef, {
        status: 'approved',
        reviewedByStaffId: reviewer.staffId,
        reviewedByName: reviewer.fullName,
        reviewComment: comment.trim() || 'Approved within operational capacity.',
        lastAuditLogId: logId,
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'auditLogs', logId), {
        logId,
        action: 'LEAVE_APPROVED',
        targetType: 'leaveRequest',
        targetId: reqData.requestId,
        actorStaffId: reviewer.staffId,
        actorName: reviewer.fullName,
        actorRole: reviewer.role,
        summary: `Approved ${reqData.staffName} (${reqData.staffId}) ${reqData.leaveType} for ${reqData.startDate} – ${reqData.endDate}.`,
        previousStatus: 'pending',
        newStatus: 'approved',
        affectedDates: reqData.dates.slice(0, 31),
        createdAt: serverTimestamp(),
      });
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.startsWith('Approval blocked') ||
        err.message.startsWith('Cannot approve') ||
        err.message === 'Leave request not found.')
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `leaveRequests/${requestId}`);
  }
}

export async function rejectLeaveRequest(
  reviewer: StaffProfile,
  requestId: string,
  comment: string
): Promise<void> {
  const reqRef = doc(db, 'leaveRequests', requestId);
  const logId = makeClientId('log');

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(reqRef);
      if (!snap.exists()) throw new Error('Leave request not found.');
      const reqData = snap.data() as LeaveRequest;
      if (reqData.status !== 'pending') {
        throw new Error(`Cannot reject: request status is already "${reqData.status}".`);
      }

      tx.update(reqRef, {
        status: 'rejected',
        reviewedByStaffId: reviewer.staffId,
        reviewedByName: reviewer.fullName,
        reviewComment: comment.trim() || 'Declined due to operational requirements.',
        lastAuditLogId: logId,
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(db, 'auditLogs', logId), {
        logId,
        action: 'LEAVE_REJECTED',
        targetType: 'leaveRequest',
        targetId: reqData.requestId,
        actorStaffId: reviewer.staffId,
        actorName: reviewer.fullName,
        actorRole: reviewer.role,
        summary: `Rejected ${reqData.staffName} (${reqData.staffId}) ${reqData.leaveType}. Reason: ${comment.trim() || 'Operational requirements'}`,
        previousStatus: 'pending',
        newStatus: 'rejected',
        affectedDates: reqData.dates.slice(0, 31),
        createdAt: serverTimestamp(),
      });
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.startsWith('Cannot reject') ||
        err.message === 'Leave request not found.')
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `leaveRequests/${requestId}`);
  }
}

export async function processLeaveModification(
  reviewer: StaffProfile,
  requestId: string,
  decision: 'approve_cancel' | 'approve_edit' | 'decline_modification',
  comment: string,
  settings: AppSettings
): Promise<void> {
  const reqRef = doc(db, 'leaveRequests', requestId);
  const logId = makeClientId('log');
  const defaultMaxCap = Math.min(10, Math.max(1, settings.maxDailyCombinedCap || 10));

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(reqRef);
      if (!snap.exists()) throw new Error('Leave request not found.');
      const reqData = snap.data() as LeaveRequest;
      if (reqData.status !== 'approved') {
        throw new Error('Only approved leave requests can be modified.');
      }

      if (decision === 'decline_modification') {
        tx.update(reqRef, {
          modificationRequestType: 'none',
          modificationNote: '',
          requestedStartDate: '',
          requestedEndDate: '',
          reviewedByStaffId: reviewer.staffId,
          reviewedByName: reviewer.fullName,
          reviewComment: comment.trim() || 'Modification request declined.',
          lastAuditLogId: logId,
          updatedAt: serverTimestamp(),
        });
        tx.set(doc(db, 'auditLogs', logId), {
          logId,
          action: 'LEAVE_MODIFIED',
          targetType: 'leaveRequest',
          targetId: reqData.requestId,
          actorStaffId: reviewer.staffId,
          actorName: reviewer.fullName,
          actorRole: reviewer.role,
          summary: `Declined modification request for ${reqData.staffName} (${reqData.staffId}).`,
          previousStatus: 'approved',
          newStatus: 'approved',
          affectedDates: reqData.dates.slice(0, 31),
          createdAt: serverTimestamp(),
        });
        return;
      }

      let newDates: string[] = [];
      if (decision === 'approve_edit') {
        const expanded = expandDateRange(
          reqData.requestedStartDate || '',
          reqData.requestedEndDate || '',
          30
        );
        if (expanded.error) throw new Error(expanded.error);
        newDates = expanded.dates;
      }

      const allDateKeys = Array.from(new Set([...reqData.dates, ...newDates])).sort();
      const capRefs = allDateKeys.map((d) => doc(db, 'dailyCapacity', d));
      const detailRefs = allDateKeys.map((d) => doc(db, 'dailyCapacityDetails', d));
      const capSnaps = await Promise.all(capRefs.map((r) => tx.get(r)));
      const detailSnaps = await Promise.all(detailRefs.map((r) => tx.get(r)));

      const oldSet = new Set(reqData.dates);
      const newSet = new Set(newDates);
      const fullDates: string[] = [];

      allDateKeys.forEach((dateKey, idx) => {
        const capSnap = capSnaps[idx];
        const used = capSnap.exists() ? Number(capSnap.data()?.approvedCount || 0) : 0;
        const capLimit = capSnap.exists()
          ? Number(capSnap.data()?.maxCapacity || defaultMaxCap)
          : defaultMaxCap;
        const delta = (newSet.has(dateKey) ? 1 : 0) - (oldSet.has(dateKey) ? 1 : 0);
        if (reqData.countsTowardDailyCap && delta > 0 && used + delta > capLimit) {
          fullDates.push(`${dateKey} (${used}/${capLimit})`);
        }
      });

      if (fullDates.length > 0) {
        throw new Error(
          `Cannot apply new dates — capacity full on: ${fullDates.join(', ')}.`
        );
      }

      allDateKeys.forEach((dateKey, idx) => {
        const capSnap = capSnaps[idx];
        const detailSnap = detailSnaps[idx];
        const used = capSnap.exists() ? Number(capSnap.data()?.approvedCount || 0) : 0;
        const capLimit = capSnap.exists()
          ? Number(capSnap.data()?.maxCapacity || defaultMaxCap)
          : defaultMaxCap;
        const delta = (newSet.has(dateKey) ? 1 : 0) - (oldSet.has(dateKey) ? 1 : 0);

        if (reqData.countsTowardDailyCap && delta !== 0) {
          tx.set(capRefs[idx], {
            date: dateKey,
            approvedCount: Math.max(0, used + delta),
            maxCapacity: Math.min(10, capLimit),
            updatedAt: serverTimestamp(),
          });
        }

        const existingAllocs = (
          detailSnap.exists() ? detailSnap.data()?.allocations || [] : []
        ) as Array<Record<string, unknown>>;
        let updatedAllocs = existingAllocs.filter(
          (a) => a.requestId !== reqData.requestId
        );
        if (newSet.has(dateKey)) {
          updatedAllocs = [
            ...updatedAllocs,
            {
              staffId: reqData.staffId,
              staffName: reqData.staffName,
              designation: reqData.designation,
              requestId: reqData.requestId,
              leaveType: reqData.leaveType,
            },
          ];
        }
        if (detailSnap.exists() || updatedAllocs.length > 0) {
          tx.set(detailRefs[idx], {
            date: dateKey,
            allocations: updatedAllocs.slice(0, 25),
            updatedAt: serverTimestamp(),
          });
        }
      });

      if (decision === 'approve_cancel') {
        tx.update(reqRef, {
          status: 'cancelled',
          modificationRequestType: 'none',
          reviewedByStaffId: reviewer.staffId,
          reviewedByName: reviewer.fullName,
          reviewComment:
            comment.trim() || 'Approved leave cancelled and capacity released.',
          lastAuditLogId: logId,
          updatedAt: serverTimestamp(),
        });
        tx.set(doc(db, 'auditLogs', logId), {
          logId,
          action: 'LEAVE_CANCELLED',
          targetType: 'leaveRequest',
          targetId: reqData.requestId,
          actorStaffId: reviewer.staffId,
          actorName: reviewer.fullName,
          actorRole: reviewer.role,
          summary: `Cancelled approved leave for ${reqData.staffName} (${reqData.staffId}) and released daily slots.`,
          previousStatus: 'approved',
          newStatus: 'cancelled',
          affectedDates: reqData.dates.slice(0, 31),
          createdAt: serverTimestamp(),
        });
      } else {
        tx.update(reqRef, {
          startDate: reqData.requestedStartDate!,
          endDate: reqData.requestedEndDate!,
          dates: newDates,
          daysCount: newDates.length,
          calendarYear: Number(reqData.requestedStartDate!.slice(0, 4)),
          modificationRequestType: 'none',
          modificationNote: '',
          requestedStartDate: '',
          requestedEndDate: '',
          reviewedByStaffId: reviewer.staffId,
          reviewedByName: reviewer.fullName,
          reviewComment: comment.trim() || 'Approved date modification applied.',
          lastAuditLogId: logId,
          updatedAt: serverTimestamp(),
        });
        tx.set(doc(db, 'auditLogs', logId), {
          logId,
          action: 'LEAVE_MODIFIED',
          targetType: 'leaveRequest',
          targetId: reqData.requestId,
          actorStaffId: reviewer.staffId,
          actorName: reviewer.fullName,
          actorRole: reviewer.role,
          summary: `Updated approved leave dates for ${reqData.staffName} (${reqData.staffId}) to ${reqData.requestedStartDate} – ${reqData.requestedEndDate}.`,
          previousStatus: 'approved',
          newStatus: 'approved',
          affectedDates: allDateKeys.slice(0, 31),
          createdAt: serverTimestamp(),
        });
      }
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.startsWith('Cannot apply') ||
        err.message.startsWith('Only approved') ||
        err.message === 'Leave request not found.')
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `leaveRequests/${requestId}`);
  }
}

export async function updateStaffProfile(
  actor: StaffProfile,
  target: StaffProfile,
  updates: {
    fullName: string;
    designation: Designation;
    role: UserRole;
    isActive: boolean;
    unitSection: string;
    annualPeriodLimit: number;
  }
): Promise<void> {
  const countsTowardDailyCap = doesDesignationCountTowardDailyCap(updates.designation);
  const logId = makeClientId('log');
  const batch = writeBatch(db);

  batch.update(doc(db, 'staff', target.staffId), {
    fullName: updates.fullName.trim(),
    designation: updates.designation,
    role: updates.role,
    isActive: updates.isActive,
    unitSection: updates.unitSection.trim() || 'Special Services',
    annualPeriodLimit: Math.min(10, Math.max(1, Number(updates.annualPeriodLimit) || 3)),
    countsTowardDailyCap,
    updatedAt: serverTimestamp(),
  });

  if (target.authUid) {
    batch.update(doc(db, 'staffAuthLinks', target.authUid), {
      role: updates.role,
      designation: updates.designation,
      isActive: updates.isActive,
      updatedAt: serverTimestamp(),
    });
  }

  const action =
    target.isActive && !updates.isActive ? 'STAFF_DEACTIVATED' : 'STAFF_UPDATED';

  batch.set(doc(db, 'auditLogs', logId), {
    logId,
    action,
    targetType: 'staff',
    targetId: target.staffId,
    actorStaffId: actor.staffId,
    actorName: actor.fullName,
    actorRole: actor.role,
    summary: `Updated ${target.staffId} (${updates.fullName.trim()}): role=${updates.role}, designation=${updates.designation}, isActive=${updates.isActive}.`,
    previousStatus: target.isActive ? 'active' : 'inactive',
    newStatus: updates.isActive ? 'active' : 'inactive',
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `staff/${target.staffId}`);
  }
}

export async function removeStaffAccount(
  actor: StaffProfile,
  target: StaffProfile
): Promise<{ removedRequests: number }> {
  if (target.staffId === actor.staffId) {
    throw new Error('You cannot remove your own currently signed-in account.');
  }

  const reqSnap = await getDocs(
    query(collection(db, 'leaveRequests'), where('staffId', '==', target.staffId))
  );
  const reqDocs = reqSnap.docs;

  const removedCountsByDate = new Map<string, number>();
  const removedReqIds = new Set<string>();
  const affectedDatesSet = new Set<string>();

  for (const d of reqDocs) {
    const reqData = d.data() as LeaveRequest;
    removedReqIds.add(reqData.requestId || d.id);
    if (reqData.status === 'approved') {
      for (const dateKey of reqData.dates || []) {
        affectedDatesSet.add(dateKey);
        if (reqData.countsTowardDailyCap) {
          removedCountsByDate.set(
            dateKey,
            (removedCountsByDate.get(dateKey) || 0) + 1
          );
        }
      }
    }
  }

  const affectedDates = Array.from(affectedDatesSet).sort();

  try {
    await runTransaction(db, async (tx) => {
      const capRefs = affectedDates.map((d) => doc(db, 'dailyCapacity', d));
      const detailRefs = affectedDates.map((d) => doc(db, 'dailyCapacityDetails', d));

      const capSnaps = await Promise.all(capRefs.map((r) => tx.get(r)));
      const detailSnaps = await Promise.all(detailRefs.map((r) => tx.get(r)));

      affectedDates.forEach((dateKey, idx) => {
        const capSnap = capSnaps[idx];
        const detailSnap = detailSnaps[idx];
        const removeCount = removedCountsByDate.get(dateKey) || 0;

        if (capSnap.exists() && removeCount > 0) {
          const used = Number(capSnap.data()?.approvedCount || 0);
          const capLimit = Number(capSnap.data()?.maxCapacity || 10);
          tx.set(capRefs[idx], {
            date: dateKey,
            approvedCount: Math.max(0, used - removeCount),
            maxCapacity: Math.min(10, capLimit),
            updatedAt: serverTimestamp(),
          });
        }

        if (detailSnap.exists()) {
          const existingAllocs = (
            detailSnap.data()?.allocations || []
          ) as Array<Record<string, unknown>>;
          const nextAllocs = existingAllocs.filter(
            (a) =>
              a.staffId !== target.staffId &&
              !removedReqIds.has(String(a.requestId || ''))
          );
          tx.set(detailRefs[idx], {
            date: dateKey,
            allocations: nextAllocs.slice(0, 25),
            updatedAt: serverTimestamp(),
          });
        }
      });

      for (const d of reqDocs) {
        tx.delete(d.ref);
      }

      tx.delete(doc(db, 'staff', target.staffId));
      if (target.authUid) {
        tx.delete(doc(db, 'staffAuthLinks', target.authUid));
      }

      const logId = makeClientId('log');
      tx.set(doc(db, 'auditLogs', logId), {
        logId,
        action: 'STAFF_REMOVED',
        targetType: 'staff',
        targetId: target.staffId,
        actorStaffId: actor.staffId,
        actorName: actor.fullName,
        actorRole: actor.role,
        summary: `Removed staff record ${target.staffId} (${target.fullName}, ${target.designation}); deleted ${reqDocs.length} leave request(s) and released ${affectedDates.length} approved date slot(s).`,
        previousStatus: target.isActive ? 'active' : 'inactive',
        newStatus: 'removed',
        ...(affectedDates.length > 0
          ? { affectedDates: affectedDates.slice(0, 31) }
          : {}),
        createdAt: serverTimestamp(),
      });
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `staff/${target.staffId}`);
  }

  return { removedRequests: reqDocs.length };
}

export async function updatePortalSettings(
  actor: StaffProfile,
  next: {
    maxDailyCombinedCap: number;
    maxAnnualLeavePeriods: number;
  }
): Promise<void> {
  const cap = Math.min(10, Math.max(1, Number(next.maxDailyCombinedCap) || 10));
  const annual = Math.min(10, Math.max(1, Number(next.maxAnnualLeavePeriods) || 3));
  const logId = makeClientId('log');
  const batch = writeBatch(db);

  batch.set(doc(db, 'appSettings', 'portalConfig'), {
    ...DEFAULT_APP_SETTINGS,
    maxDailyCombinedCap: cap,
    maxAnnualLeavePeriods: annual,
    updatedByStaffId: actor.staffId,
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'auditLogs', logId), {
    logId,
    action: 'SETTINGS_UPDATED',
    targetType: 'appSettings',
    targetId: 'portalConfig',
    actorStaffId: actor.staffId,
    actorName: actor.fullName,
    actorRole: actor.role,
    summary: `Updated portal configuration: dailyCap=${cap}, annualLimit=${annual}.`,
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'appSettings/portalConfig');
  }
}
