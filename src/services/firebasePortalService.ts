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
  getDocsFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
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
  LeaveRestriction,
  LeaveType,
  RestrictionTargetType,
  StaffAuthLink,
  StaffProfile,
  UserRole,
} from '../types/portal';
import { expandDateRange, getMonthMetadata } from '../utils/maldivesDate';
import { findRestrictedDatesForStaff } from '../utils/leaveRestrictions';
import { isValidPinFormat, isValidStaffIdFormat } from '../utils/staffAuthId';

export class RestrictedLeaveError extends Error {
  blockedDates: string[];
  matchedRestrictions: LeaveRestriction[];

  constructor(
    message: string,
    blockedDates: string[],
    matchedRestrictions: LeaveRestriction[]
  ) {
    super(message);
    this.name = 'RestrictedLeaveError';
    this.blockedDates = blockedDates;
    this.matchedRestrictions = matchedRestrictions;
  }
}

const REMEMBERED_STAFF_ID_KEY = 'ssu_remembered_staff_id';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  maxDailyCombinedCap: 10,
  maxAnnualLeavePeriods: 3,
  pendingReservesCapacity: true,
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

async function getWorkerJson<T>(path: string, bearerToken: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    });
  } catch {
    throw new Error(
      'Unable to reach the server. Check your internet connection and try again.'
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Worker endpoint (/api/*) is unavailable.');
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

function normalizeRestrictionRecord(
  raw: Record<string, unknown>,
  docId: string
): LeaveRestriction {
  const rawPrimary = Array.isArray(raw.targetStaffIds) ? raw.targetStaffIds : [];
  const rawAltA = Array.isArray(raw.staffIds) ? raw.staffIds : [];
  const rawAltB = Array.isArray(raw.selectedStaffIds) ? raw.selectedStaffIds : [];
  const rawStaffList =
    rawPrimary.length > 0 ? rawPrimary : rawAltA.length > 0 ? rawAltA : rawAltB;
  const rawTargetNames = Array.isArray(raw.targetStaffNames) ? raw.targetStaffNames : [];

  const isActiveRaw = raw.isActive;
  const isActive =
    typeof isActiveRaw === 'string'
      ? isActiveRaw.trim().toLowerCase() !== 'false'
      : isActiveRaw !== false;

  return {
    restrictionId: String(raw.restrictionId || docId),
    startDate: String(raw.startDate || '').trim(),
    endDate: String(raw.endDate || '').trim(),
    targetType: (String(raw.targetType || 'all').trim().toLowerCase() as RestrictionTargetType) || 'all',
    targetStaffIds: rawStaffList.map((v) => String(v || '').trim()).filter(Boolean),
    targetStaffNames: rawTargetNames.map((v) => String(v || '').trim()).filter(Boolean),
    reason: String(raw.reason || '').trim(),
    isActive,
    createdByStaffId: String(raw.createdByStaffId || '').trim(),
    createdByName: String(raw.createdByName || '').trim(),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export async function fetchLeaveRestrictionsFromWorker(): Promise<LeaveRestriction[]> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required to verify leave restrictions.');
  }
  const idToken = await user.getIdToken();
  const res = await getWorkerJson<{ ok: boolean; restrictions: LeaveRestriction[] }>(
    '/api/leave/restrictions',
    idToken
  );
  if (!res || !Array.isArray(res.restrictions)) {
    throw new Error('Invalid leave restrictions response from server.');
  }
  return res.restrictions
    .map((r) => normalizeRestrictionRecord(r as unknown as Record<string, unknown>, r.restrictionId))
    .filter((r) => Boolean(r.startDate && r.endDate))
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export async function loadActiveRestrictionsStrict(): Promise<LeaveRestriction[]> {
  // Prefer Worker endpoint first because it bypasses stale client cache & permission-rule delays
  // and reads directly from Firestore using authenticated caller identity.
  try {
    return await fetchLeaveRestrictionsFromWorker();
  } catch (workerErr) {
    try {
      const snap = await getDocsFromServer(collection(db, 'leaveRestrictions'));
      return snap.docs
        .map((d) => normalizeRestrictionRecord(d.data() as Record<string, unknown>, d.id))
        .filter((r) => Boolean(r.startDate && r.endDate))
        .sort((a, b) => b.startDate.localeCompare(a.startDate));
    } catch {
      throw new Error(
        workerErr instanceof Error && workerErr.message
          ? `Unable to verify leave date restrictions: ${workerErr.message}`
          : 'Unable to load leave date restrictions. Please check your connection and try again.'
      );
    }
  }
}

export function subscribeLeaveRestrictions(
  onData: (restrictions: LeaveRestriction[]) => void,
  onError: (err: Error) => void,
  onFallbackLoad?: () => void
): Unsubscribe {
  let active = true;
  return onSnapshot(
    collection(db, 'leaveRestrictions'),
    (snap) => {
      if (!active) return;
      const items = snap.docs
        .map((d) => normalizeRestrictionRecord(d.data() as Record<string, unknown>, d.id))
        .filter((r) => Boolean(r.startDate && r.endDate))
        .sort((a, b) => b.startDate.localeCompare(a.startDate));
      onData(items);
    },
    (snapshotErr) => {
      // Fallback via Cloudflare Worker when Firestore security rules are pending update
      void fetchLeaveRestrictionsFromWorker()
        .then((items) => {
          if (active) {
            onFallbackLoad?.();
            onData(items);
          }
        })
        .catch((workerErr) => {
          if (active) {
            onError(
              workerErr instanceof Error
                ? workerErr
                : snapshotErr instanceof Error
                  ? snapshotErr
                  : new Error('Unable to load leave date restrictions.')
            );
          }
        });
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Leave & Administrative Transactions (Cloudflare Worker Atomic Sync)        */
/* -------------------------------------------------------------------------- */

export async function syncPendingCapacity(force = false): Promise<{
  syncedDates: number;
  activeRequests: number;
}> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken();
  const res = await postWorkerJson<{
    ok: boolean;
    syncedDates: number;
    activeRequests: number;
  }>('/api/leave/sync-pending-capacity', { force }, idToken);
  return {
    syncedDates: Number(res.syncedDates || 0),
    activeRequests: Number(res.activeRequests || 0),
  };
}

export async function fetchCapacityForDates(dates: string[]): Promise<{
  capacityMap: Record<string, DailyCapacity>;
  capacityDetailsMap: Record<string, DailyCapacityDetail>;
}> {
  const uniqueDates = Array.from(new Set(dates.filter(Boolean)));
  if (uniqueDates.length === 0) {
    return { capacityMap: {}, capacityDetailsMap: {} };
  }

  const [capSnaps, detailSnaps] = await Promise.all([
    Promise.all(uniqueDates.map((d) => getDoc(doc(db, 'dailyCapacity', d)))),
    Promise.all(uniqueDates.map((d) => getDoc(doc(db, 'dailyCapacityDetails', d)))),
  ]);

  const capacityMap: Record<string, DailyCapacity> = {};
  const capacityDetailsMap: Record<string, DailyCapacityDetail> = {};

  capSnaps.forEach((snap, idx) => {
    if (snap.exists()) {
      const data = snap.data() as DailyCapacity;
      capacityMap[data.date || uniqueDates[idx]] = data;
    }
  });

  detailSnaps.forEach((snap, idx) => {
    if (snap.exists()) {
      const data = snap.data() as DailyCapacityDetail;
      capacityDetailsMap[data.date || uniqueDates[idx]] = data;
    }
  });

  return { capacityMap, capacityDetailsMap };
}

export async function submitLeaveRequest(
  staff: StaffProfile,
  payload: {
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    reason: string;
  }
): Promise<{ requestId: string }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  if (!staff.isActive) {
    throw new Error('Your staff account is inactive. Contact a Manager.');
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

  // Always recheck active restrictions live from server before creating a leave request or reserving slots
  const activeRestrictions = await loadActiveRestrictionsStrict();
  const blockedCheck = findRestrictedDatesForStaff(
    expanded.dates,
    activeRestrictions,
    staff
  );
  if (blockedCheck.matchedRestrictions.length > 0) {
    const primary = blockedCheck.matchedRestrictions[0];
    throw new RestrictedLeaveError(
      `You are not permitted to apply for leave during the selected dates. Reason: ${primary.reason}. Please select alternative dates.`,
      blockedCheck.blockedDates,
      blockedCheck.matchedRestrictions
    );
  }

  const idToken = await user.getIdToken(true);
  const res = await postWorkerJson<{ ok: boolean; requestId: string }>(
    '/api/leave/submit',
    {
      leaveType: payload.leaveType,
      startDate: payload.startDate,
      endDate: payload.endDate,
      reason: trimmedReason,
    },
    idToken
  );

  return { requestId: res.requestId };
}

export async function cancelPendingLeaveRequest(
  _staff: StaffProfile,
  req: LeaveRequest
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken(true);
  await postWorkerJson<{ ok: boolean; requestId: string }>(
    '/api/leave/cancel-pending',
    { requestId: req.requestId },
    idToken
  );
}

export async function editPendingLeaveDates(
  staff: StaffProfile,
  req: LeaveRequest,
  payload: {
    startDate: string;
    endDate: string;
  }
): Promise<{ startDate: string; endDate: string; daysCount: number }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  if (!staff.isActive) {
    throw new Error('Your staff account is inactive. Contact a Manager.');
  }
  if (req.staffId !== staff.staffId) {
    throw new Error('You can only edit your own pending leave applications.');
  }
  if (req.status !== 'pending') {
    throw new Error('This leave application has already been reviewed and can no longer be edited.');
  }

  const expanded = expandDateRange(payload.startDate, payload.endDate, 30);
  if (expanded.error) {
    throw new Error(expanded.error);
  }

  const activeRestrictions = await loadActiveRestrictionsStrict();
  const blockedCheck = findRestrictedDatesForStaff(
    expanded.dates,
    activeRestrictions,
    staff
  );
  if (blockedCheck.matchedRestrictions.length > 0) {
    const primary = blockedCheck.matchedRestrictions[0];
    throw new RestrictedLeaveError(
      `You are not permitted to apply for leave during the selected dates. Reason: ${primary.reason}. Please select alternative dates.`,
      blockedCheck.blockedDates,
      blockedCheck.matchedRestrictions
    );
  }

  const idToken = await user.getIdToken(true);
  const res = await postWorkerJson<{
    ok: boolean;
    requestId: string;
    startDate: string;
    endDate: string;
    daysCount: number;
  }>(
    '/api/leave/edit-pending',
    {
      requestId: req.requestId,
      startDate: payload.startDate,
      endDate: payload.endDate,
    },
    idToken
  );

  return {
    startDate: res.startDate,
    endDate: res.endDate,
    daysCount: Number(res.daysCount || expanded.dates.length),
  };
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

    // Prevent overlapping another pending or approved leave period
    const userReqsSnap = await getDocs(
      query(collection(db, 'leaveRequests'), where('staffId', '==', staff.staffId))
    );
    const otherBooked = new Set<string>();
    for (const d of userReqsSnap.docs) {
      const item = d.data() as LeaveRequest;
      if (
        item.requestId !== req.requestId &&
        (item.status === 'pending' || item.status === 'approved')
      ) {
        for (const dt of item.dates || []) otherBooked.add(dt);
      }
    }
    const overlaps = exp.dates.filter((d) => otherBooked.has(d));
    if (overlaps.length > 0) {
      throw new Error(
        `Requested dates overlap another pending or approved leave on: ${overlaps.join(', ')}.`
      );
    }

    const activeRestrictions = await loadActiveRestrictionsStrict();
    const blockedCheck = findRestrictedDatesForStaff(
      exp.dates,
      activeRestrictions,
      staff
    );
    if (blockedCheck.matchedRestrictions.length > 0) {
      const primary = blockedCheck.matchedRestrictions[0];
      throw new RestrictedLeaveError(
        `You are not permitted to apply for leave during the selected dates. Reason: ${primary.reason}. Please select alternative dates.`,
        blockedCheck.blockedDates,
        blockedCheck.matchedRestrictions
      );
    }

    // Verify daily capacity on newly added dates for cap-counting designations
    if (staff.countsTowardDailyCap) {
      const oldDates = new Set(req.dates || []);
      const addedDates = exp.dates.filter((d) => !oldDates.has(d));
      if (addedDates.length > 0) {
        const [settingsSnap, fetched] = await Promise.all([
          getDoc(doc(db, 'appSettings', 'portalConfig')),
          fetchCapacityForDates(addedDates),
        ]);
        const maxCap = settingsSnap.exists()
          ? Number(settingsSnap.data()?.maxDailyCombinedCap || 10)
          : 10;
        const fullDates: string[] = [];
        for (const dateKey of addedDates) {
          const cap = fetched.capacityMap[dateKey];
          const used = cap ? Number(cap.approvedCount || 0) : 0;
          const capLimit = cap ? Number(cap.maxCapacity || maxCap) : maxCap;
          if (used >= capLimit) {
            fullDates.push(`${dateKey} (${used}/${capLimit})`);
          }
        }
        if (fullDates.length > 0) {
          throw new Error(
            `Daily capacity (${maxCap} slots including Pending & Approved) is full on: ${fullDates.join(', ')}.`
          );
        }
      }
    }
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
  _reviewer: StaffProfile,
  requestId: string,
  comment: string,
  _settings: AppSettings
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken(true);
  await postWorkerJson<{ ok: boolean; requestId: string }>(
    '/api/leave/approve',
    {
      requestId,
      comment: comment.trim(),
    },
    idToken
  );
}

export async function rejectLeaveRequest(
  _reviewer: StaffProfile,
  requestId: string,
  comment: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken(true);
  await postWorkerJson<{ ok: boolean; requestId: string }>(
    '/api/leave/reject',
    {
      requestId,
      comment: comment.trim(),
    },
    idToken
  );
}

export async function processLeaveModification(
  _reviewer: StaffProfile,
  requestId: string,
  decision: 'approve_cancel' | 'approve_edit' | 'decline_modification',
  comment: string,
  _settings: AppSettings
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken(true);
  await postWorkerJson<{ ok: boolean; requestId: string }>(
    '/api/leave/process-modification',
    {
      requestId,
      decision,
      comment: comment.trim(),
    },
    idToken
  );
}

export async function removeApprovedLeaveRequest(requestId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken(true);
  await postWorkerJson<{ ok: boolean; requestId: string }>(
    '/api/leave/remove-approved',
    { requestId },
    idToken
  );
}

export async function managerAddApprovedLeave(payload: {
  staffId: string;
  startDate: string;
  endDate: string;
  reason: string;
  confirmOverlap: boolean;
}): Promise<{ requestId: string; peakOccupied: number }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const trimmedReason = payload.reason.trim();
  if (trimmedReason.length > 0 && trimmedReason.length < 3) {
    throw new Error('Reason / Remarks must be at least 3 characters if provided.');
  }
  if (trimmedReason.length > 500) {
    throw new Error('Reason / Remarks cannot exceed 500 characters.');
  }
  const expanded = expandDateRange(payload.startDate, payload.endDate, 30);
  if (expanded.error) {
    throw new Error(expanded.error);
  }
  const idToken = await user.getIdToken(true);
  const res = await postWorkerJson<{
    ok: boolean;
    requestId: string;
    peakOccupied?: number;
  }>(
    '/api/leave/manager-add',
    {
      staffId: payload.staffId.trim(),
      startDate: payload.startDate,
      endDate: payload.endDate,
      reason: trimmedReason || 'Added directly by Manager.',
      confirmOverlap: payload.confirmOverlap,
    },
    idToken
  );
  return {
    requestId: res.requestId,
    peakOccupied: Number(res.peakOccupied || 0),
  };
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
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken(true);
  const res = await postWorkerJson<{ ok: boolean; removedRequests: number }>(
    '/api/admin/remove-staff',
    { targetStaffId: target.staffId },
    idToken
  );
  return { removedRequests: Number(res.removedRequests || 0) };
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

export async function saveLeaveRestriction(payload: {
  restrictionId?: string;
  startDate: string;
  endDate: string;
  targetType: RestrictionTargetType;
  targetStaffIds: string[];
  reason: string;
  isActive: boolean;
}): Promise<LeaveRestriction> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken(true);
  const res = await postWorkerJson<{ ok: boolean; restriction: LeaveRestriction }>(
    '/api/admin/restrictions/save',
    payload,
    idToken
  );
  return res.restriction;
}

export async function deleteLeaveRestriction(restrictionId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  const idToken = await user.getIdToken(true);
  await postWorkerJson<{ ok: boolean; restrictionId: string }>(
    '/api/admin/restrictions/delete',
    { restrictionId },
    idToken
  );
}

export async function clearAllLeaveRecords(confirmation: string): Promise<{
  deletedRequests: number;
  deletedCapacityDocs: number;
  deletedDetailDocs: number;
}> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required. Please log in again.');
  }
  if (confirmation.trim() !== 'DELETE ALL') {
    throw new Error('Please type "DELETE ALL" to confirm.');
  }
  const idToken = await user.getIdToken(true);
  const res = await postWorkerJson<{
    ok: boolean;
    deletedRequests: number;
    deletedCapacityDocs: number;
    deletedDetailDocs: number;
  }>(
    '/api/admin/clear-all-leave',
    { confirmation: confirmation.trim() },
    idToken
  );
  return {
    deletedRequests: Number(res.deletedRequests || 0),
    deletedCapacityDocs: Number(res.deletedCapacityDocs || 0),
    deletedDetailDocs: Number(res.deletedDetailDocs || 0),
  };
}
