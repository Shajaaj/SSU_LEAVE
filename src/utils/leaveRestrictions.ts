import {
  LeaveRestriction,
  RestrictionTargetType,
  StaffProfile,
} from '../types/portal';
import { formatDisplayDate } from './maldivesDate';
import { normalizeStaffIdToken } from './staffAuthId';

const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const RESTRICTION_TARGET_OPTIONS: Array<{
  value: RestrictionTargetType;
  label: string;
}> = [
  { value: 'all', label: 'All Staff' },
  { value: 'assistant_officer', label: 'Assistant Officers' },
  { value: 'attendant', label: 'Attendants' },
  { value: 'executive', label: 'Executives' },
  { value: 'officer', label: 'Officers' },
  { value: 'selected_staff', label: 'Selected Staff Members' },
];

export function formatLongDate(dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return dateKey;
  const [y, m, d] = dateKey.split('-').map(Number);
  const monthName = LONG_MONTHS[m - 1] || '';
  return `${String(d).padStart(2, '0')} ${monthName} ${y}`;
}

export type RestrictionStaffIdentity = Pick<StaffProfile, 'staffId' | 'designation'> & {
  authUid?: string;
  fullName?: string;
};

export function doesRestrictionApplyToStaff(
  restriction: LeaveRestriction,
  staff: RestrictionStaffIdentity
): boolean {
  if (!restriction.isActive) return false;
  const targetType = String(restriction.targetType || '').trim().toLowerCase();
  const designation = String(staff.designation || '').trim().toUpperCase();
  const staffIdToken = normalizeStaffIdToken(String(staff.staffId || ''));
  const staffDeterministicUid = staffIdToken ? `ss_${staffIdToken}` : '';
  const staffAuthUid = String(staff.authUid || '').trim().toLowerCase();
  const staffFullName = String(staff.fullName || '').trim().toLowerCase();

  switch (targetType) {
    case 'all':
      return true;
    case 'assistant_officer':
      return designation === 'ASSISTANT OFFICER';
    case 'attendant':
      return designation === 'ATTENDANT';
    case 'executive':
      return designation === 'EXECUTIVE';
    case 'officer':
      return designation === 'OFFICER';
    case 'selected_staff':
    case 'selectedstaff':
    case 'specific_staff': {
      const targetIds = Array.isArray(restriction.targetStaffIds)
        ? restriction.targetStaffIds
        : [];
      const matchedById = targetIds.some((rawEntry) => {
        const trimmed = String(rawEntry || '').trim();
        if (!trimmed) return false;
        if (staffIdToken && normalizeStaffIdToken(trimmed) === staffIdToken) {
          return true;
        }
        const lower = trimmed.toLowerCase();
        if (staffDeterministicUid && lower === staffDeterministicUid) return true;
        if (staffAuthUid && lower === staffAuthUid) return true;
        if (staffFullName.length >= 3 && lower === staffFullName) return true;
        return false;
      });
      if (matchedById) return true;

      // Backwards compatibility only if a legacy restriction saved names with no targetStaffIds
      if (targetIds.length === 0 && staffFullName.length >= 3) {
        return (restriction.targetStaffNames || []).some(
          (n) => String(n || '').trim().toLowerCase() === staffFullName
        );
      }
      return false;
    }
    default:
      return false;
  }
}

export function getActiveRestrictionsForDate(
  dateKey: string,
  restrictions: LeaveRestriction[],
  staff?: RestrictionStaffIdentity
): LeaveRestriction[] {
  const targetDate = String(dateKey || '').trim();
  return restrictions.filter((r) => {
    if (!r.isActive) return false;
    const start = String(r.startDate || '').trim();
    const end = String(r.endDate || '').trim();
    if (!start || !end || targetDate < start || targetDate > end) return false;
    if (!staff) return true;
    return doesRestrictionApplyToStaff(r, staff);
  });
}

export function findRestrictedDatesForStaff(
  dates: string[],
  restrictions: LeaveRestriction[],
  staff: RestrictionStaffIdentity
): {
  blockedDates: string[];
  matchedRestrictions: LeaveRestriction[];
} {
  if (!dates.length || !restrictions.length) {
    return { blockedDates: [], matchedRestrictions: [] };
  }

  const applicable = restrictions.filter((r) => doesRestrictionApplyToStaff(r, staff));
  if (applicable.length === 0) {
    return { blockedDates: [], matchedRestrictions: [] };
  }

  const blockedSet = new Set<string>();
  const matchedMap = new Map<string, LeaveRestriction>();

  for (const dateKey of dates) {
    const cleanDate = String(dateKey || '').trim();
    for (const r of applicable) {
      const start = String(r.startDate || '').trim();
      const end = String(r.endDate || '').trim();
      if (start && end && cleanDate >= start && cleanDate <= end) {
        blockedSet.add(cleanDate);
        matchedMap.set(r.restrictionId, r);
      }
    }
  }

  const blockedDates = Array.from(blockedSet).sort();
  const matchedRestrictions = Array.from(matchedMap.values()).sort((a, b) =>
    a.startDate.localeCompare(b.startDate)
  );

  return { blockedDates, matchedRestrictions };
}

export function formatRestrictionTargetLabel(
  restriction: LeaveRestriction,
  profiles: StaffProfile[] = []
): string {
  switch (String(restriction.targetType || '').trim().toLowerCase()) {
    case 'all':
      return 'All Staff';
    case 'assistant_officer':
      return 'Assistant Officers';
    case 'attendant':
      return 'Attendants';
    case 'executive':
      return 'Executives';
    case 'officer':
      return 'Officers';
    case 'selected_staff':
    case 'selectedstaff':
    case 'specific_staff': {
      const ids = restriction.targetStaffIds || [];
      if (ids.length === 0) return 'Selected Staff (0)';
      const profileByToken = new Map(
        profiles.map((p) => [normalizeStaffIdToken(p.staffId), p])
      );
      const labels = ids.map((id, idx) => {
        const profile = profileByToken.get(normalizeStaffIdToken(id));
        const displayId = profile?.staffId || id;
        const name = profile?.fullName || restriction.targetStaffNames?.[idx];
        return name ? `${displayId} (${name})` : displayId;
      });
      if (labels.length <= 2) return labels.join(', ');
      return `${labels.slice(0, 2).join(', ')} +${labels.length - 2} more`;
    }
    default:
      return 'All Staff';
  }
}

export function formatRestrictionRangeShort(restriction: LeaveRestriction): string {
  if (restriction.startDate === restriction.endDate) {
    return formatDisplayDate(restriction.startDate);
  }
  return `${formatDisplayDate(restriction.startDate)} – ${formatDisplayDate(restriction.endDate)}`;
}
