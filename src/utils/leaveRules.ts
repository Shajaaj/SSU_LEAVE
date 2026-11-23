import {
  AppSettings,
  DailyCapacity,
  DailyCapacityDetail,
  LeaveRequest,
  LeaveRestriction,
  StaffProfile,
} from '../types/portal';
import { expandDateRange, formatDisplayDate } from './maldivesDate';
import { findRestrictedDatesForStaff, formatLongDate } from './leaveRestrictions';

export interface AnnualPeriodSummary {
  year: number;
  approvedPeriods: number;
  pendingPeriods: number;
  totalAllocatedPeriods: number;
  limit: number;
  remainingPeriods: number;
}

export interface DailyCapacityBreakdown {
  occupiedCount: number;
  approvedOnlyCount: number;
  pendingCount: number;
  maxCapacity: number;
  availableSlots: number;
  isFull: boolean;
}

export const EXECUTIVE_LIMIT_REACHED_MESSAGE =
  'Executive Leave Limit Reached\n\n' +
  'An Executive already has Pending or Approved leave during the selected dates.\n\n' +
  'Only one Executive may be on leave per day.\n\n' +
  'Please select alternative dates.';

export interface ExecutiveCapacityBreakdown {
  occupiedCount: number;
  approvedOnlyCount: number;
  pendingCount: number;
  maxCapacity: number;
  availableSlots: number;
  isFull: boolean;
}

export interface OverCapacityDateReport {
  date: string;
  kind: 'executive' | 'staff';
  occupiedCount: number;
  approvedOnlyCount: number;
  pendingCount: number;
  capLimit: number;
  staffEntries: Array<{
    staffId: string;
    staffName: string;
    status: string;
  }>;
}

export interface LeaveValidationResult {
  valid: boolean;
  dates: string[];
  errors: string[];
  unavailableDates: Array<{
    date: string;
    occupiedCount: number;
    approvedCount: number;
    maxCapacity: number;
    pendingCount: number;
  }>;
  executiveUnavailableDates: Array<{
    date: string;
    occupiedCount: number;
    approvedCount: number;
    maxCapacity: number;
    pendingCount: number;
  }>;
  pendingOverlapDates: Array<{
    date: string;
    pendingCount: number;
  }>;
  blockedDates: string[];
  matchedRestrictions: LeaveRestriction[];
}

export function doesRequestDesignationCountTowardCap(designation: string): boolean {
  const norm = String(designation || '').trim().toUpperCase();
  return norm === 'ASSISTANT OFFICER' || norm === 'ATTENDANT';
}

export function isExecutiveDesignation(designation: string): boolean {
  return String(designation || '').trim().toUpperCase() === 'EXECUTIVE';
}

export function calculateAnnualPeriodUsage(
  allRequests: LeaveRequest[],
  staffId: string,
  calendarYear: number,
  maxAnnualLimit = 3
): AnnualPeriodSummary {
  const userYearRequests = allRequests.filter(
    (r) => r.staffId === staffId && r.calendarYear === calendarYear
  );
  const approvedPeriods = userYearRequests.filter((r) => r.status === 'approved').length;
  const pendingPeriods = userYearRequests.filter((r) => r.status === 'pending').length;
  const totalAllocatedPeriods = approvedPeriods + pendingPeriods;
  const remainingPeriods = Math.max(0, maxAnnualLimit - totalAllocatedPeriods);

  return {
    year: calendarYear,
    approvedPeriods,
    pendingPeriods,
    totalAllocatedPeriods,
    limit: maxAnnualLimit,
    remainingPeriods,
  };
}

export function buildPendingDemandMap(requests: LeaveRequest[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const req of requests) {
    if (req.status !== 'pending' || !req.countsTowardDailyCap) continue;
    for (const dateKey of req.dates) {
      map[dateKey] = (map[dateKey] || 0) + 1;
    }
  }
  return map;
}

/**
 * Single source of truth for daily slot occupancy across Calendar, Dashboard,
 * Available Slots, and Leave Submission Form:
 * - Both Pending and Approved applications for Assistant Officers & Attendants
 *   occupy slots immediately toward the 10-slot combined daily limit.
 * - When `pendingReservesCapacity` is active (synced), `dailyCapacity.approvedCount`
 *   already holds the combined occupied count (Pending + Approved) without double-counting.
 */
export function getDailyCapacityBreakdown(params: {
  dateKey: string;
  capacityMap: Record<string, DailyCapacity>;
  pendingDemandMap?: Record<string, number>;
  capacityDetailsMap?: Record<string, DailyCapacityDetail>;
  defaultMaxCap?: number;
  pendingReservesCapacity?: boolean;
}): DailyCapacityBreakdown {
  const {
    dateKey,
    capacityMap,
    pendingDemandMap = {},
    capacityDetailsMap,
    defaultMaxCap = 10,
    pendingReservesCapacity = true,
  } = params;

  const cap = capacityMap[dateKey];
  const detailAllocs = capacityDetailsMap?.[dateKey]?.allocations;
  const maxCapacity = cap ? cap.maxCapacity || defaultMaxCap : defaultMaxCap;

  if (pendingReservesCapacity) {
    let occupiedCount = cap ? Number(cap.approvedCount || 0) : 0;
    let pendingCount =
      cap && typeof cap.pendingCount === 'number' ? Number(cap.pendingCount) : 0;
    let approvedOnlyCount =
      cap && typeof cap.approvedOnlyCount === 'number'
        ? Number(cap.approvedOnlyCount)
        : 0;

    if (detailAllocs && detailAllocs.length > 0) {
      let detailPending = 0;
      let detailApproved = 0;
      for (const a of detailAllocs) {
        if (!doesRequestDesignationCountTowardCap(a.designation)) continue;
        if (a.status === 'pending') detailPending += 1;
        else detailApproved += 1;
      }
      if (!cap) {
        occupiedCount = detailPending + detailApproved;
        pendingCount = detailPending;
        approvedOnlyCount = detailApproved;
      } else {
        if (typeof cap.pendingCount !== 'number') {
          pendingCount = detailPending;
        }
        if (typeof cap.approvedOnlyCount !== 'number') {
          approvedOnlyCount = Math.max(0, occupiedCount - pendingCount);
        }
      }
    } else if (cap) {
      if (typeof cap.pendingCount !== 'number') {
        pendingCount = Math.min(occupiedCount, pendingDemandMap[dateKey] || 0);
      }
      if (typeof cap.approvedOnlyCount !== 'number') {
        approvedOnlyCount = Math.max(0, occupiedCount - pendingCount);
      }
    }

    const availableSlots = Math.max(0, maxCapacity - occupiedCount);
    return {
      occupiedCount,
      approvedOnlyCount,
      pendingCount,
      maxCapacity,
      availableSlots,
      isFull: occupiedCount >= maxCapacity,
    };
  }

  // Fallback before initial reconciliation completes
  const approvedOnlyCount = cap ? Number(cap.approvedCount || 0) : 0;
  const pendingCount = pendingDemandMap[dateKey] || 0;
  const occupiedCount = approvedOnlyCount + pendingCount;
  const availableSlots = Math.max(0, maxCapacity - occupiedCount);

  return {
    occupiedCount,
    approvedOnlyCount,
    pendingCount,
    maxCapacity,
    availableSlots,
    isFull: occupiedCount >= maxCapacity,
  };
}

/**
 * Independent daily capacity breakdown for Executives (`EXECUTIVE`).
 * - Both Pending and Approved Executive leave occupy Executive daily slots.
 * - Completely isolated from Assistant Officer / Attendant daily limits.
 */
export function getExecutiveCapacityBreakdown(params: {
  dateKey: string;
  capacityMap: Record<string, DailyCapacity>;
  capacityDetailsMap?: Record<string, DailyCapacityDetail>;
  defaultMaxExecCap?: number;
  allRequests?: LeaveRequest[];
}): ExecutiveCapacityBreakdown {
  const {
    dateKey,
    capacityMap,
    capacityDetailsMap,
    defaultMaxExecCap = 1,
    allRequests,
  } = params;

  const cap = capacityMap[dateKey];
  const detailEntry = capacityDetailsMap?.[dateKey];
  const maxCapacity = Math.max(1, Number(defaultMaxExecCap || cap?.maxExecutiveCapacity || 1));

  let occupiedCount = 0;
  let approvedOnlyCount = 0;
  let pendingCount = 0;

  if (detailEntry !== undefined) {
    for (const a of detailEntry.allocations || []) {
      if (!isExecutiveDesignation(a.designation)) continue;
      if (a.status === 'pending') pendingCount += 1;
      else approvedOnlyCount += 1;
    }
    occupiedCount = approvedOnlyCount + pendingCount;
  } else if (cap && typeof cap.executiveCount === 'number') {
    occupiedCount = Math.max(0, Number(cap.executiveCount || 0));
    pendingCount = Math.max(0, Number(cap.executivePendingCount || 0));
    approvedOnlyCount =
      typeof cap.executiveApprovedCount === 'number'
        ? Math.max(0, Number(cap.executiveApprovedCount || 0))
        : Math.max(0, occupiedCount - pendingCount);
  } else if (allRequests && allRequests.length > 0) {
    for (const r of allRequests) {
      if (!isExecutiveDesignation(r.designation)) continue;
      if (r.status !== 'pending' && r.status !== 'approved') continue;
      if (!r.dates.includes(dateKey)) continue;
      if (r.status === 'pending') pendingCount += 1;
      else approvedOnlyCount += 1;
    }
    occupiedCount = approvedOnlyCount + pendingCount;
  }

  const availableSlots = Math.max(0, maxCapacity - occupiedCount);
  return {
    occupiedCount,
    approvedOnlyCount,
    pendingCount,
    maxCapacity,
    availableSlots,
    isFull: occupiedCount >= maxCapacity,
  };
}

export function calculateOverCapacityDates(
  allRequests: LeaveRequest[],
  settings: AppSettings
): OverCapacityDateReport[] {
  const staffCapLimit = settings.maxDailyCombinedCap || 10;
  const execCapLimit = Math.max(1, settings.maxExecutiveDailyCap || 1);

  const staffByDate = new Map<
    string,
    Array<{ staffId: string; staffName: string; status: string }>
  >();
  const execByDate = new Map<
    string,
    Array<{ staffId: string; staffName: string; status: string }>
  >();

  for (const r of allRequests) {
    if (r.status !== 'pending' && r.status !== 'approved') continue;
    const isExec = isExecutiveDesignation(r.designation);
    const isStaffCap = doesRequestDesignationCountTowardCap(r.designation);
    if (!isExec && !isStaffCap) continue;

    const targetMap = isExec ? execByDate : staffByDate;
    for (const d of r.dates || []) {
      const list = targetMap.get(d) || [];
      list.push({
        staffId: r.staffId,
        staffName: r.staffName,
        status: r.status,
      });
      targetMap.set(d, list);
    }
  }

  const reports: OverCapacityDateReport[] = [];

  for (const [date, entries] of execByDate.entries()) {
    if (entries.length > execCapLimit) {
      const pendingCount = entries.filter((e) => e.status === 'pending').length;
      const approvedOnlyCount = entries.length - pendingCount;
      reports.push({
        date,
        kind: 'executive',
        occupiedCount: entries.length,
        approvedOnlyCount,
        pendingCount,
        capLimit: execCapLimit,
        staffEntries: entries,
      });
    }
  }

  for (const [date, entries] of staffByDate.entries()) {
    if (entries.length > staffCapLimit) {
      const pendingCount = entries.filter((e) => e.status === 'pending').length;
      const approvedOnlyCount = entries.length - pendingCount;
      reports.push({
        date,
        kind: 'staff',
        occupiedCount: entries.length,
        approvedOnlyCount,
        pendingCount,
        capLimit: staffCapLimit,
        staffEntries: entries,
      });
    }
  }

  return reports.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

export function validateLeaveSubmission(params: {
  staff: StaffProfile;
  startDate: string;
  endDate: string;
  reason: string;
  userRequests: LeaveRequest[];
  allRequests?: LeaveRequest[];
  capacityMap: Record<string, DailyCapacity>;
  pendingDemandMap: Record<string, number>;
  capacityDetailsMap?: Record<string, DailyCapacityDetail>;
  settings: AppSettings;
  restrictions?: LeaveRestriction[];
  excludeRequestId?: string;
}): LeaveValidationResult {
  const {
    staff,
    startDate,
    endDate,
    reason,
    userRequests,
    allRequests,
    capacityMap,
    pendingDemandMap,
    capacityDetailsMap,
    settings,
    restrictions = [],
    excludeRequestId,
  } = params;

  const errors: string[] = [];
  const unavailableDates: LeaveValidationResult['unavailableDates'] = [];
  const executiveUnavailableDates: LeaveValidationResult['executiveUnavailableDates'] = [];
  const pendingOverlapDates: LeaveValidationResult['pendingOverlapDates'] = [];

  if (!staff.isActive) {
    errors.push('Your staff account is inactive. Contact a Manager to reactivate access.');
  }

  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3 || trimmedReason.length > 500) {
    errors.push('Please provide a reason between 3 and 500 characters.');
  }

  const expanded = expandDateRange(startDate, endDate, 30);
  if (expanded.error) {
    errors.push(expanded.error);
    return {
      valid: false,
      dates: [],
      errors,
      unavailableDates,
      executiveUnavailableDates,
      pendingOverlapDates,
      blockedDates: [],
      matchedRestrictions: [],
    };
  }

  const dates = expanded.dates;
  const calendarYear = Number(startDate.slice(0, 4));
  const limit = staff.annualPeriodLimit || settings.maxAnnualLeavePeriods || 3;

  const excludedRequest = excludeRequestId
    ? userRequests.find((r) => r.requestId === excludeRequestId)
    : undefined;
  const alreadyReservedDates = new Set(excludedRequest?.dates || []);

  const filteredRequests = excludeRequestId
    ? userRequests.filter((r) => r.requestId !== excludeRequestId)
    : userRequests;

  const periodUsage = calculateAnnualPeriodUsage(
    filteredRequests,
    staff.staffId,
    calendarYear,
    limit
  );

  if (periodUsage.totalAllocatedPeriods >= limit) {
    errors.push(
      `Annual limit reached for ${calendarYear}: ${periodUsage.approvedPeriods} approved and ${periodUsage.pendingPeriods} pending out of ${limit} permitted leave periods.`
    );
  }

  const ownBookedDates = new Set<string>();
  for (const r of filteredRequests) {
    if (r.staffId === staff.staffId && (r.status === 'pending' || r.status === 'approved')) {
      for (const d of r.dates) ownBookedDates.add(d);
    }
  }

  const selfOverlaps = dates.filter((d) => ownBookedDates.has(d));
  if (selfOverlaps.length > 0) {
    errors.push(
      `You already have pending or approved leave covering: ${selfOverlaps
        .map(formatDisplayDate)
        .join(', ')}.`
    );
  }

  const maxDailyCap = settings.maxDailyCombinedCap || 10;
  const maxExecDailyCap = Math.max(1, settings.maxExecutiveDailyCap || 1);
  const isExecutiveApplicant = isExecutiveDesignation(staff.designation);

  for (const dateKey of dates) {
    const breakdown = getDailyCapacityBreakdown({
      dateKey,
      capacityMap,
      pendingDemandMap,
      capacityDetailsMap,
      defaultMaxCap: maxDailyCap,
      pendingReservesCapacity: Boolean(settings.pendingReservesCapacity),
    });

    if (breakdown.pendingCount > 0) {
      pendingOverlapDates.push({ date: dateKey, pendingCount: breakdown.pendingCount });
    }

    if (
      staff.countsTowardDailyCap &&
      breakdown.isFull &&
      !alreadyReservedDates.has(dateKey)
    ) {
      unavailableDates.push({
        date: dateKey,
        occupiedCount: breakdown.occupiedCount,
        approvedCount: breakdown.approvedOnlyCount,
        maxCapacity: breakdown.maxCapacity,
        pendingCount: breakdown.pendingCount,
      });
    }

    if (isExecutiveApplicant && !alreadyReservedDates.has(dateKey)) {
      const execBreakdown = getExecutiveCapacityBreakdown({
        dateKey,
        capacityMap,
        capacityDetailsMap,
        defaultMaxExecCap: maxExecDailyCap,
        allRequests,
      });
      if (execBreakdown.isFull) {
        executiveUnavailableDates.push({
          date: dateKey,
          occupiedCount: execBreakdown.occupiedCount,
          approvedCount: execBreakdown.approvedOnlyCount,
          maxCapacity: execBreakdown.maxCapacity,
          pendingCount: execBreakdown.pendingCount,
        });
      }
    }
  }

  if (unavailableDates.length > 0) {
    const formattedList = unavailableDates
      .map(
        (u) =>
          `${formatDisplayDate(u.date)} (${u.occupiedCount}/${u.maxCapacity} slots occupied)`
      )
      .join('; ');
    errors.push(
      `Daily unit capacity limit (${maxDailyCap} combined Assistant Officers & Attendants) is full on: ${formattedList}.`
    );
  }

  if (executiveUnavailableDates.length > 0) {
    errors.push(EXECUTIVE_LIMIT_REACHED_MESSAGE);
  }

  const restrictionCheck = findRestrictedDatesForStaff(dates, restrictions, staff);
  if (restrictionCheck.matchedRestrictions.length > 0) {
    const primary = restrictionCheck.matchedRestrictions[0];
    errors.push(
      `You are not permitted to apply for leave during the selected dates (${formatLongDate(primary.startDate)} to ${formatLongDate(primary.endDate)}). Reason: ${primary.reason}. Please select alternative dates.`
    );
  }

  return {
    valid: errors.length === 0,
    dates,
    errors,
    unavailableDates,
    executiveUnavailableDates,
    pendingOverlapDates,
    blockedDates: restrictionCheck.blockedDates,
    matchedRestrictions: restrictionCheck.matchedRestrictions,
  };
}

/**
 * Checks whether approving a pending request can proceed within daily cap.
 * Since pending requests reserve their slot on submission, approving an
 * already-reserved request keeps occupancy unchanged (no double-counting).
 * Handles both Assistant Officer/Attendant cap and independent Executive cap.
 */
export function checkApprovalCapacityFeasibility(
  request: LeaveRequest,
  capacityMap: Record<string, DailyCapacity>,
  defaultCap = 10,
  capacityDetailsMap?: Record<string, DailyCapacityDetail>,
  pendingReservesCapacity = true,
  defaultExecCap = 1
): {
  feasible: boolean;
  fullDates: Array<{ date: string; approvedCount: number; maxCapacity: number }>;
} {
  const isExec = isExecutiveDesignation(request.designation);
  if (!request.countsTowardDailyCap && !isExec) {
    return { feasible: true, fullDates: [] };
  }
  const fullDates: Array<{ date: string; approvedCount: number; maxCapacity: number }> = [];
  for (const dateKey of request.dates) {
    const cap = capacityMap[dateKey];
    const details = capacityDetailsMap?.[dateKey]?.allocations;

    if (isExec) {
      const execBreakdown = getExecutiveCapacityBreakdown({
        dateKey,
        capacityMap,
        capacityDetailsMap,
        defaultMaxExecCap: defaultExecCap,
      });
      const alreadyReserved = details
        ? details.some((a) => a.requestId === request.requestId)
        : pendingReservesCapacity && execBreakdown.occupiedCount > 0;

      const projected = alreadyReserved
        ? execBreakdown.occupiedCount
        : execBreakdown.occupiedCount + 1;
      if (!alreadyReserved && projected > execBreakdown.maxCapacity) {
        fullDates.push({
          date: dateKey,
          approvedCount: execBreakdown.occupiedCount,
          maxCapacity: execBreakdown.maxCapacity,
        });
      }
      continue;
    }

    const occupied = cap ? Number(cap.approvedCount || 0) : 0;
    const maxCapacity = cap ? Number(cap.maxCapacity || defaultCap) : defaultCap;
    const alreadyReserved = details
      ? details.some((a) => a.requestId === request.requestId)
      : pendingReservesCapacity && occupied > 0;

    const projected = alreadyReserved ? occupied : occupied + 1;
    if (!alreadyReserved && projected > maxCapacity) {
      fullDates.push({ date: dateKey, approvedCount: occupied, maxCapacity });
    }
  }
  return {
    feasible: fullDates.length === 0,
    fullDates,
  };
}
