import React, { useMemo, useState } from 'react';
import {
  CalendarCheck2,
  CalendarOff,
  ChevronLeft,
  ChevronRight,
  Info,
  Lock,
  Users,
} from 'lucide-react';
import {
  AppSettings,
  DailyCapacity,
  DailyCapacityDetail,
  LeaveRequest,
  LeaveRestriction,
  StaffProfile,
} from '../types/portal';
import {
  WEEKDAY_HEADERS,
  buildMonthDays,
  formatDisplayDate,
  getMonthMetadata,
  getTodayInMaldives,
} from '../utils/maldivesDate';
import { getLeaveBarStyle } from '../utils/leaveColors';
import {
  formatRestrictionRangeShort,
  formatRestrictionTargetLabel,
  getActiveRestrictionsForDate,
} from '../utils/leaveRestrictions';
import { getDailyCapacityBreakdown } from '../utils/leaveRules';
import {
  AvailabilityLabel,
  LeaveColorLegend,
  LeaveStatusLabel,
  ManagerAddedLabel,
} from './StatusLabel';

interface LeaveCalendarProps {
  year: number;
  monthIndex0: number;
  onChangeMonth: (nextYear: number, nextMonth0: number) => void;
  capacityMap: Record<string, DailyCapacity>;
  capacityDetailsMap: Record<string, DailyCapacityDetail>;
  pendingDemandMap: Record<string, number>;
  allRequests: LeaveRequest[];
  currentProfile: StaffProfile;
  settings: AppSettings;
  restrictions?: LeaveRestriction[];
  onRequestRange: (startDate: string, endDate: string) => void;
  compact?: boolean;
}

export const LeaveCalendar: React.FC<LeaveCalendarProps> = ({
  year,
  monthIndex0,
  onChangeMonth,
  capacityMap,
  capacityDetailsMap,
  pendingDemandMap,
  allRequests,
  currentProfile,
  settings,
  restrictions = [],
  onRequestRange,
  compact = false,
}) => {
  const todayMaldives = getTodayInMaldives();
  const maxCap = settings.maxDailyCombinedCap || 10;
  const isManagement =
    currentProfile.role === 'executive' || currentProfile.role === 'manager';

  const [selectedDay, setSelectedDay] = useState<string>(todayMaldives);
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);

  const meta = useMemo(
    () => getMonthMetadata(year, monthIndex0),
    [year, monthIndex0]
  );
  const monthDays = useMemo(
    () => buildMonthDays(year, monthIndex0),
    [year, monthIndex0]
  );

  const myStatusByDate = useMemo(() => {
    const map: Record<string, 'approved' | 'pending'> = {};
    for (const r of allRequests) {
      if (r.staffId !== currentProfile.staffId) continue;
      if (r.status !== 'approved' && r.status !== 'pending') continue;
      for (const d of r.dates) {
        if (r.status === 'approved' || !map[d]) {
          map[d] = r.status;
        }
      }
    }
    return map;
  }, [allRequests, currentProfile.staffId]);

  const barsByDate = useMemo(() => {
    const map: Record<
      string,
      Array<{
        requestId: string;
        staffId: string;
        staffName: string;
        designation: string;
        status: 'pending' | 'approved';
        hasModPending: boolean;
      }>
    > = {};

    const seenByDate = new Map<string, Set<string>>();
    const pushBar = (
      dateKey: string,
      entry: {
        requestId: string;
        staffId: string;
        staffName: string;
        designation: string;
        status: 'pending' | 'approved';
        hasModPending: boolean;
      }
    ) => {
      let seen = seenByDate.get(dateKey);
      if (!seen) {
        seen = new Set();
        seenByDate.set(dateKey, seen);
      }
      if (seen.has(entry.requestId)) return;
      seen.add(entry.requestId);
      if (!map[dateKey]) map[dateKey] = [];
      map[dateKey].push(entry);
    };

    const monthSet = new Set(monthDays);
    for (const r of allRequests) {
      if (r.status !== 'approved' && r.status !== 'pending') continue;
      if (!isManagement && r.staffId !== currentProfile.staffId) continue;
      for (const d of r.dates) {
        if (!monthSet.has(d)) continue;
        pushBar(d, {
          requestId: r.requestId,
          staffId: r.staffId,
          staffName: r.staffName,
          designation: r.designation,
          status: r.status,
          hasModPending: r.modificationRequestType !== 'none',
        });
      }
    }

    if (isManagement) {
      for (const dateKey of monthDays) {
        const allocs = capacityDetailsMap[dateKey]?.allocations || [];
        for (const a of allocs) {
          pushBar(dateKey, {
            requestId: a.requestId,
            staffId: a.staffId,
            staffName: a.staffName,
            designation: a.designation,
            status: a.status === 'pending' ? 'pending' : 'approved',
            hasModPending: false,
          });
        }
      }
    }

    return map;
  }, [allRequests, capacityDetailsMap, monthDays, isManagement, currentProfile.staffId]);

  const handlePrevMonth = () => {
    if (monthIndex0 === 0) {
      onChangeMonth(year - 1, 11);
    } else {
      onChangeMonth(year, monthIndex0 - 1);
    }
  };

  const handleNextMonth = () => {
    if (monthIndex0 === 11) {
      onChangeMonth(year + 1, 0);
    } else {
      onChangeMonth(year, monthIndex0 + 1);
    }
  };

  const handleToday = () => {
    const y = Number(todayMaldives.slice(0, 4));
    const m = Number(todayMaldives.slice(5, 7)) - 1;
    onChangeMonth(y, m);
    setSelectedDay(todayMaldives);
  };

  const handleDayClick = (dateKey: string) => {
    setSelectedDay(dateKey);
    if (!rangeStart || (rangeStart && rangeEnd)) {
      setRangeStart(dateKey);
      setRangeEnd(null);
    } else if (dateKey < rangeStart) {
      setRangeEnd(rangeStart);
      setRangeStart(dateKey);
    } else {
      setRangeEnd(dateKey);
    }
  };

  const isInSelectedRange = (dateKey: string) => {
    if (!rangeStart) return false;
    if (!rangeEnd) return dateKey === rangeStart;
    return dateKey >= rangeStart && dateKey <= rangeEnd;
  };

  const selectedBreakdown = getDailyCapacityBreakdown({
    dateKey: selectedDay,
    capacityMap,
    pendingDemandMap,
    capacityDetailsMap,
    defaultMaxCap: maxCap,
    pendingReservesCapacity: Boolean(settings.pendingReservesCapacity),
  });
  const selectedDayDetails = capacityDetailsMap[selectedDay]?.allocations || [];

  const selectedDayVisibleRequests = useMemo(() => {
    return allRequests.filter((r) => {
      if (!r.dates.includes(selectedDay)) return false;
      if (r.status !== 'approved' && r.status !== 'pending') return false;
      if (isManagement) return true;
      return r.staffId === currentProfile.staffId;
    });
  }, [allRequests, selectedDay, isManagement, currentProfile.staffId]);

  const selectedDayMyRestrictions = useMemo(
    () => getActiveRestrictionsForDate(selectedDay, restrictions, currentProfile),
    [selectedDay, restrictions, currentProfile]
  );

  const selectedDayAllRestrictions = useMemo(
    () => getActiveRestrictionsForDate(selectedDay, restrictions),
    [selectedDay, restrictions]
  );

  return (
    <div className="space-y-4">
      {/* Header Controls */}
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-3 sm:p-5 space-y-3.5 sm:space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base sm:text-lg font-display font-bold text-[#0B1F3A] dark:text-white">
              {meta.label}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Combined Assistant Officer &amp; Attendant cap: <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">{maxCap} slots/day</span> · Both Pending and Approved leave immediately reserve daily slots.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleToday}
              className="min-h-[40px] sm:min-h-0 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              Today (MVT)
            </button>
            <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 flex items-center justify-center p-2 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                aria-label="Previous month"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleNextMonth}
                className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 flex items-center justify-center p-2 border-l border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                aria-label="Next month"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Range Selection Action Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 py-2.5 px-3 sm:px-3.5 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 text-xs">
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
            <CalendarCheck2 className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" aria-hidden="true" />
            {!rangeStart ? (
              <span>Click any start date and end date on the calendar to check availability and apply.</span>
            ) : !rangeEnd ? (
              <span>
                Start date selected: <strong className="font-mono text-slate-900 dark:text-white">{formatDisplayDate(rangeStart)}</strong> · Click an end date or apply for 1 day.
              </span>
            ) : (
              <span>
                Selected range: <strong className="font-mono text-slate-900 dark:text-white">{formatDisplayDate(rangeStart)} – {formatDisplayDate(rangeEnd)}</strong>
              </span>
            )}
          </div>
          {rangeStart && (
            <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
              <button
                type="button"
                onClick={() => {
                  setRangeStart(null);
                  setRangeEnd(null);
                }}
                className="min-h-[40px] sm:min-h-0 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 text-xs font-medium whitespace-nowrap"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => onRequestRange(rangeStart, rangeEnd || rangeStart)}
                className="flex-1 sm:flex-initial min-h-[40px] sm:min-h-0 px-3 py-1.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold whitespace-nowrap text-center"
              >
                Request Selected Dates
              </button>
            </div>
          )}
        </div>

        {/* Designation & Status Legend (All Screen Sizes) */}
        <LeaveColorLegend />

        {/* Month Grid (All Viewports: Mobile, Tablet & Desktop) */}
        <div>
          <div className="grid grid-cols-7 gap-1 sm:gap-1.5 mb-1 sm:mb-1.5">
            {WEEKDAY_HEADERS.map((day) => (
              <div
                key={day}
                className="text-center text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 py-1 sm:py-1.5"
              >
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
            {Array.from({ length: meta.leadingEmptyCells }).map((_, idx) => (
              <div
                key={`empty-${idx}`}
                className={`${compact ? 'min-h-[58px] sm:min-h-[76px]' : 'min-h-[62px] sm:min-h-[94px]'} rounded-lg bg-slate-50/60 dark:bg-slate-900/30`}
                aria-hidden="true"
              />
            ))}

            {monthDays.map((dateKey) => {
              const dayNum = Number(dateKey.slice(8, 10));
              const breakdown = getDailyCapacityBreakdown({
                dateKey,
                capacityMap,
                pendingDemandMap,
                capacityDetailsMap,
                defaultMaxCap: maxCap,
                pendingReservesCapacity: Boolean(settings.pendingReservesCapacity),
              });
              const occupiedCount = breakdown.occupiedCount;
              const maxDayCap = breakdown.maxCapacity;
              const pendingCount = breakdown.pendingCount;
              const isFull = breakdown.isFull;
              const isSelected = selectedDay === dateKey;
              const inRange = isInSelectedRange(dateKey);
              const isToday = dateKey === todayMaldives;
              const myStatus = myStatusByDate[dateKey];
              const dayBars = barsByDate[dateKey] || [];
              const myBarStyle = myStatus
                ? getLeaveBarStyle(currentProfile.designation, myStatus)
                : null;
              const myDayRestrictions = getActiveRestrictionsForDate(
                dateKey,
                restrictions,
                currentProfile
              );
              const unitDayRestrictions = isManagement
                ? getActiveRestrictionsForDate(dateKey, restrictions)
                : myDayRestrictions;
              const isRestrictedForMe = myDayRestrictions.length > 0;
              const hasAnyRestriction = unitDayRestrictions.length > 0;

              return (
                <button
                  key={dateKey}
                  type="button"
                  onClick={() => handleDayClick(dateKey)}
                  title={
                    unitDayRestrictions.length > 0
                      ? `Restricted: ${unitDayRestrictions.map((r) => r.reason).join(' / ')}`
                      : undefined
                  }
                  className={`${compact ? 'min-h-[62px] sm:min-h-[84px]' : 'min-h-[68px] sm:min-h-[106px]'} p-1.5 sm:p-2 rounded-lg border text-left flex flex-col justify-between gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 overflow-hidden ${
                    inRange
                      ? 'border-teal-600 bg-teal-50/70 dark:bg-teal-950/35 dark:border-teal-500'
                      : isSelected
                        ? 'border-[#0B1F3A] dark:border-teal-400 bg-slate-50 dark:bg-slate-900/80'
                        : isRestrictedForMe
                          ? 'border-rose-300 dark:border-rose-800/80 bg-rose-50/60 dark:bg-rose-950/25 hover:bg-rose-50 dark:hover:bg-rose-950/35'
                          : isFull
                            ? 'border-red-200 dark:border-red-900/60 bg-red-50/40 dark:bg-red-950/15 hover:bg-red-50/70 dark:hover:bg-red-950/25'
                            : hasAnyRestriction
                              ? 'border-amber-300 dark:border-amber-800/70 bg-amber-50/40 dark:bg-amber-950/20 hover:bg-amber-50/70'
                              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0D1B2A] hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 w-full">
                    <span
                      className={`text-[11px] sm:text-xs font-mono tabular-nums font-bold ${
                        isToday
                          ? 'text-teal-700 dark:text-teal-300 underline underline-offset-4'
                          : isRestrictedForMe
                            ? 'text-rose-800 dark:text-rose-300'
                            : 'text-slate-900 dark:text-slate-100'
                      }`}
                    >
                      {dayNum}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {hasAnyRestriction && (
                        <>
                          <span
                            className={`sm:hidden w-1.5 h-1.5 rounded-full shrink-0 ${
                              isRestrictedForMe ? 'bg-rose-600' : 'bg-amber-500'
                            }`}
                            aria-label="Blocked date"
                          />
                          <span
                            className={`hidden sm:inline px-1 py-0.5 rounded-[2px] text-[9px] font-bold uppercase tracking-tight ${
                              isRestrictedForMe
                                ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-200'
                                : 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-200'
                            }`}
                          >
                            Blocked
                          </span>
                        </>
                      )}
                      {myStatus && myBarStyle && (
                        <>
                          <span
                            className={`sm:hidden w-2 h-2 rounded-full shrink-0 ${myBarStyle.dotClass}`}
                            aria-label={myStatus === 'approved' ? 'My Leave' : 'My Pending'}
                          />
                          <span
                            className={`hidden sm:inline text-[10px] font-semibold ${
                              myBarStyle.isExecutive
                                ? 'text-purple-700 dark:text-purple-300'
                                : 'text-blue-700 dark:text-blue-300'
                            }`}
                          >
                            {myStatus === 'approved' ? 'My Leave' : 'My Pending'}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Designation-Coloured Leave Bars inside Calendar Day Cell */}
                  {dayBars.length > 0 && (
                    <div className="w-full space-y-0.5">
                      {dayBars.slice(0, 2).map((bar) => {
                        const style = getLeaveBarStyle(
                          bar.designation,
                          bar.status,
                          bar.hasModPending
                        );
                        return (
                          <div
                            key={bar.requestId}
                            className={`w-full h-1.5 sm:h-4 rounded-[2px] border px-1 flex items-center justify-between gap-1 text-[9px] font-semibold overflow-hidden ${style.barClass}`}
                            title={`${bar.staffName} (${bar.designation}) · ${style.statusText}`}
                          >
                            <span className="hidden sm:inline truncate leading-none">
                              {isManagement ? bar.staffName.split(' ')[0] : style.statusText}
                            </span>
                            {bar.status === 'pending' && isManagement && (
                              <span className="hidden md:inline shrink-0 text-[8px] uppercase tracking-tight opacity-90">
                                Pending
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {dayBars.length > 2 && (
                        <p className="hidden sm:block text-[9px] font-mono text-slate-500 dark:text-slate-400 leading-none">
                          +{dayBars.length - 2} more
                        </p>
                      )}
                    </div>
                  )}

                  <div className="space-y-0.5 w-full">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0 sm:gap-1">
                      <span className="text-[10px] sm:text-[11px] font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200 leading-tight">
                        {occupiedCount}/{maxDayCap}
                      </span>
                      <AvailabilityLabel
                        approvedCount={occupiedCount}
                        maxCapacity={maxDayCap}
                        compactMobile
                      />
                    </div>
                    {pendingCount > 0 && (
                      <p className="hidden sm:block text-[10px] font-mono tabular-nums text-blue-700 dark:text-blue-300 truncate">
                        {pendingCount} pending
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Selected Day Detail Panel */}
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div>
            <h3 className="text-sm font-display font-bold text-[#0B1F3A] dark:text-white">
              Day Breakdown: <span className="font-mono">{formatDisplayDate(selectedDay)}</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono tabular-nums">
              Occupied: {selectedBreakdown.occupiedCount}/{selectedBreakdown.maxCapacity} ({selectedBreakdown.approvedOnlyCount} approved · {selectedBreakdown.pendingCount} pending) · Available: {selectedBreakdown.availableSlots}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onRequestRange(selectedDay, selectedDay)}
            disabled={
              currentProfile.countsTowardDailyCap &&
              selectedBreakdown.isFull &&
              selectedDayMyRestrictions.length === 0
            }
            className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg bg-[#0B1F3A] dark:bg-teal-600 text-white text-xs font-semibold hover:bg-[#14325B] dark:hover:bg-teal-700 disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {selectedDayMyRestrictions.length > 0
              ? `Restricted Date (${formatDisplayDate(selectedDay)})`
              : currentProfile.countsTowardDailyCap && selectedBreakdown.isFull
                ? `Day Capacity Full (${selectedBreakdown.occupiedCount}/${selectedBreakdown.maxCapacity})`
                : `Apply for ${formatDisplayDate(selectedDay)}`}
          </button>
        </div>

        {(isManagement ? selectedDayAllRestrictions : selectedDayMyRestrictions).length > 0 && (
          <div className="p-3.5 rounded-lg bg-rose-50 dark:bg-rose-950/35 border border-rose-200 dark:border-rose-900/60 text-xs space-y-1.5">
            <p className="font-semibold text-rose-800 dark:text-rose-200 flex items-center gap-1.5">
              <CalendarOff className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Blocked Leave Date Restriction(s) Active</span>
            </p>
            {(isManagement ? selectedDayAllRestrictions : selectedDayMyRestrictions).map((r) => (
              <p key={r.restrictionId} className="text-rose-900 dark:text-rose-100 leading-relaxed">
                <span className="font-mono font-semibold">{formatRestrictionRangeShort(r)}</span> ·{' '}
                <span className="font-semibold">{formatRestrictionTargetLabel(r)}</span> —{' '}
                <span>Reason: {r.reason}</span>
              </p>
            ))}
          </div>
        )}

        {isManagement ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
                <span>Staff Leave Roster for {formatDisplayDate(selectedDay)}</span>
              </p>
            </div>
            {selectedDayVisibleRequests.length === 0 && selectedDayDetails.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-2">
                No approved or pending leave records on this date. All {selectedBreakdown.maxCapacity} operational slots are open.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {selectedDayVisibleRequests.map((req) => {
                  const barStyle = getLeaveBarStyle(
                    req.designation,
                    req.status,
                    req.modificationRequestType !== 'none'
                  );
                  return (
                    <div
                      key={req.requestId}
                      className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 flex items-center gap-2.5">
                        <span
                          className={`w-2 h-8 rounded-[2px] border shrink-0 ${barStyle.barClass}`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900 dark:text-slate-100">
                            {req.staffName}{' '}
                            <span className="font-mono text-slate-500 dark:text-slate-400">
                              · {req.staffId}
                            </span>
                          </p>
                          <p className="text-slate-500 dark:text-slate-400">
                            {req.designation} · {req.leaveType} ·{' '}
                            <span className="font-mono">
                              {req.startDate} to {req.endDate}
                            </span>
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {req.addedByManager && (
                          <ManagerAddedLabel
                            addedByName={req.addedByName}
                            addedByStaffId={req.addedByStaffId}
                          />
                        )}
                        <span
                          className={`px-2 py-0.5 rounded-[2px] text-[10px] font-semibold ${barStyle.badgeClass}`}
                        >
                          {barStyle.statusText}
                        </span>
                        <LeaveStatusLabel status={req.status} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {selectedDayVisibleRequests.length > 0 ? (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {selectedDayVisibleRequests.map((req) => {
                  const barStyle = getLeaveBarStyle(
                    req.designation,
                    req.status,
                    req.modificationRequestType !== 'none'
                  );
                  return (
                    <div
                      key={req.requestId}
                      className="py-2 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className={`w-2 h-8 rounded-[2px] border shrink-0 ${barStyle.barClass}`}
                          aria-hidden="true"
                        />
                        <div>
                          <p className="font-semibold text-slate-900 dark:text-slate-100">
                            Your {req.leaveType}
                          </p>
                          <p className="text-slate-500 dark:text-slate-400 font-mono">
                            {req.startDate} to {req.endDate} ({req.daysCount} day{req.daysCount > 1 ? 's' : ''})
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {req.addedByManager && (
                          <ManagerAddedLabel
                            addedByName={req.addedByName}
                            addedByStaffId={req.addedByStaffId}
                          />
                        )}
                        <span
                          className={`px-2 py-0.5 rounded-[2px] text-[10px] font-semibold ${barStyle.badgeClass}`}
                        >
                          {barStyle.statusText}
                        </span>
                        <LeaveStatusLabel status={req.status} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-2">
                <Info className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" aria-hidden="true" />
                <span>
                  You have no leave scheduled on {formatDisplayDate(selectedDay)}.{' '}
                  {selectedBreakdown.availableSlots} of {selectedBreakdown.maxCapacity} unit slots are available.
                </span>
              </p>
            )}
            <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Individual colleague leave details are restricted to Executives and Managers.</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
