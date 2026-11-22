import {
  LeaveRestriction,
  RestrictionTargetType,
  StaffProfile,
} from '../types/portal';
import { formatDisplayDate } from './maldivesDate';

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

export function doesRestrictionApplyToStaff(
  restriction: LeaveRestriction,
  staff: Pick<StaffProfile, 'staffId' | 'designation'>
): boolean {
  if (!restriction.isActive) return false;
  const designation = String(staff.designation || '').trim().toUpperCase();
  const staffIdNorm = String(staff.staffId || '').trim().toUpperCase();

  switch (restriction.targetType) {
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
      return (restriction.targetStaffIds || []).some(
        (id) => String(id || '').trim().toUpperCase() === staffIdNorm
      );
    default:
      return false;
  }
}

export function getActiveRestrictionsForDate(
  dateKey: string,
  restrictions: LeaveRestriction[],
  staff?: Pick<StaffProfile, 'staffId' | 'designation'>
): LeaveRestriction[] {
  return restrictions.filter((r) => {
    if (!r.isActive) return false;
    if (dateKey < r.startDate || dateKey > r.endDate) return false;
    if (!staff) return true;
    return doesRestrictionApplyToStaff(r, staff);
  });
}

export function findRestrictedDatesForStaff(
  dates: string[],
  restrictions: LeaveRestriction[],
  staff: Pick<StaffProfile, 'staffId' | 'designation'>
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
    for (const r of applicable) {
      if (dateKey >= r.startDate && dateKey <= r.endDate) {
        blockedSet.add(dateKey);
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
  switch (restriction.targetType) {
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
    case 'selected_staff': {
      const ids = restriction.targetStaffIds || [];
      if (ids.length === 0) return 'Selected Staff (0)';
      const nameById = new Map(profiles.map((p) => [p.staffId, p.fullName]));
      const labels = ids.map((id, idx) => {
        const name = nameById.get(id) || restriction.targetStaffNames?.[idx];
        return name ? `${id} (${name})` : id;
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
