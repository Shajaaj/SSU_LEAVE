import {
  AppSettings,
  DailyCapacity,
  LeaveRequest,
  StaffProfile,
} from '../types/portal';
import { expandDateRange, formatDisplayDate } from './maldivesDate';

export interface AnnualPeriodSummary {
  year: number;
  approvedPeriods: number;
  pendingPeriods: number;
  totalAllocatedPeriods: number;
  limit: number;
  remainingPeriods: number;
}

export interface LeaveValidationResult {
  valid: boolean;
  dates: string[];
  errors: string[];
  unavailableDates: Array<{
    date: string;
    approvedCount: number;
    maxCapacity: number;
    pendingCount: number;
  }>;
  pendingOverlapDates: Array<{
    date: string;
    pendingCount: number;
  }>;
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

export function validateLeaveSubmission(params: {
  staff: StaffProfile;
  startDate: string;
  endDate: string;
  reason: string;
  userRequests: LeaveRequest[];
  capacityMap: Record<string, DailyCapacity>;
  pendingDemandMap: Record<string, number>;
  settings: AppSettings;
  excludeRequestId?: string;
}): LeaveValidationResult {
  const {
    staff,
    startDate,
    endDate,
    reason,
    userRequests,
    capacityMap,
    pendingDemandMap,
    settings,
    excludeRequestId,
  } = params;

  const errors: string[] = [];
  const unavailableDates: LeaveValidationResult['unavailableDates'] = [];
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
      pendingOverlapDates,
    };
  }

  const dates = expanded.dates;
  const calendarYear = Number(startDate.slice(0, 4));
  const limit = staff.annualPeriodLimit || settings.maxAnnualLeavePeriods || 3;

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
  for (const dateKey of dates) {
    const cap = capacityMap[dateKey];
    const approvedCount = cap ? cap.approvedCount : 0;
    const maxCapacity = cap ? cap.maxCapacity : maxDailyCap;
    const pendingCount = pendingDemandMap[dateKey] || 0;

    if (pendingCount > 0) {
      pendingOverlapDates.push({ date: dateKey, pendingCount });
    }

    if (staff.countsTowardDailyCap) {
      const effectiveUsed = settings.pendingReservesCapacity
        ? approvedCount + pendingCount
        : approvedCount;

      if (effectiveUsed >= maxCapacity) {
        unavailableDates.push({
          date: dateKey,
          approvedCount,
          maxCapacity,
          pendingCount,
        });
      }
    }
  }

  if (unavailableDates.length > 0) {
    const formattedList = unavailableDates
      .map(
        (u) =>
          `${formatDisplayDate(u.date)} (${u.approvedCount}/${u.maxCapacity} approved slots taken)`
      )
      .join('; ');
    errors.push(
      `Daily unit capacity limit (${maxDailyCap} combined Assistant Officers & Attendants) is full on: ${formattedList}.`
    );
  }

  return {
    valid: errors.length === 0,
    dates,
    errors,
    unavailableDates,
    pendingOverlapDates,
  };
}

export function checkApprovalCapacityFeasibility(
  request: LeaveRequest,
  capacityMap: Record<string, DailyCapacity>,
  defaultCap = 10
): {
  feasible: boolean;
  fullDates: Array<{ date: string; approvedCount: number; maxCapacity: number }>;
} {
  if (!request.countsTowardDailyCap) {
    return { feasible: true, fullDates: [] };
  }
  const fullDates: Array<{ date: string; approvedCount: number; maxCapacity: number }> = [];
  for (const dateKey of request.dates) {
    const cap = capacityMap[dateKey];
    const approvedCount = cap ? cap.approvedCount : 0;
    const maxCapacity = cap ? cap.maxCapacity : defaultCap;
    if (approvedCount >= maxCapacity) {
      fullDates.push({ date: dateKey, approvedCount, maxCapacity });
    }
  }
  return {
    feasible: fullDates.length === 0,
    fullDates,
  };
}
