import React, { useMemo, useState } from 'react';
import {
  CalendarCheck2,
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
  StaffProfile,
} from '../types/portal';
import {
  WEEKDAY_HEADERS,
  buildMonthDays,
  formatDisplayDate,
  getMonthMetadata,
  getTodayInMaldives,
} from '../utils/maldivesDate';
import { AvailabilityLabel, LeaveStatusLabel } from './StatusLabel';

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

  const selectedDayCap = capacityMap[selectedDay]?.approvedCount || 0;
  const selectedDayMax = capacityMap[selectedDay]?.maxCapacity || maxCap;
  const selectedDayPending = pendingDemandMap[selectedDay] || 0;
  const selectedDayDetails = capacityDetailsMap[selectedDay]?.allocations || [];

  const selectedDayVisibleRequests = useMemo(() => {
    return allRequests.filter((r) => {
      if (!r.dates.includes(selectedDay)) return false;
      if (r.status !== 'approved' && r.status !== 'pending') return false;
      if (isManagement) return true;
      return r.staffId === currentProfile.staffId;
    });
  }, [allRequests, selectedDay, isManagement, currentProfile.staffId]);

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
              Combined Assistant Officer & Attendant cap: <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">{maxCap} slots/day</span> · Pending requests do not reserve capacity.
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
              const approvedCount = capacityMap[dateKey]?.approvedCount || 0;
              const maxDayCap = capacityMap[dateKey]?.maxCapacity || maxCap;
              const pendingCount = pendingDemandMap[dateKey] || 0;
              const isFull = approvedCount >= maxDayCap;
              const isSelected = selectedDay === dateKey;
              const inRange = isInSelectedRange(dateKey);
              const isToday = dateKey === todayMaldives;
              const myStatus = myStatusByDate[dateKey];

              return (
                <button
                  key={dateKey}
                  type="button"
                  onClick={() => handleDayClick(dateKey)}
                  className={`${compact ? 'min-h-[58px] sm:min-h-[76px]' : 'min-h-[62px] sm:min-h-[94px]'} p-1.5 sm:p-2 rounded-lg border text-left flex flex-col justify-between transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 overflow-hidden ${
                    inRange
                      ? 'border-teal-600 bg-teal-50/70 dark:bg-teal-950/35 dark:border-teal-500'
                      : isSelected
                        ? 'border-[#0B1F3A] dark:border-teal-400 bg-slate-50 dark:bg-slate-900/80'
                        : isFull
                          ? 'border-red-200 dark:border-red-900/60 bg-red-50/40 dark:bg-red-950/15 hover:bg-red-50/70 dark:hover:bg-red-950/25'
                          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0D1B2A] hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 w-full">
                    <span
                      className={`text-[11px] sm:text-xs font-mono tabular-nums font-bold ${
                        isToday
                          ? 'text-teal-700 dark:text-teal-300 underline underline-offset-4'
                          : 'text-slate-900 dark:text-slate-100'
                      }`}
                    >
                      {dayNum}
                    </span>
                    {myStatus && (
                      <>
                        <span
                          className={`sm:hidden w-1.5 h-1.5 rounded-full shrink-0 ${
                            myStatus === 'approved' ? 'bg-emerald-600' : 'bg-amber-500'
                          }`}
                          aria-label={myStatus === 'approved' ? 'My Leave' : 'My Pending'}
                        />
                        <span
                          className={`hidden sm:inline text-[10px] font-semibold ${
                            myStatus === 'approved'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {myStatus === 'approved' ? 'My Leave' : 'My Pending'}
                        </span>
                      </>
                    )}
                  </div>

                  <div className="space-y-0.5 w-full">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0 sm:gap-1">
                      <span className="text-[10px] sm:text-[11px] font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200 leading-tight">
                        {approvedCount}/{maxDayCap}
                      </span>
                      <AvailabilityLabel
                        approvedCount={approvedCount}
                        maxCapacity={maxDayCap}
                        compactMobile
                      />
                    </div>
                    {pendingCount > 0 && (
                      <p className="hidden sm:block text-[10px] font-mono tabular-nums text-amber-700 dark:text-amber-400 truncate">
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
              Approved: {selectedDayCap}/{selectedDayMax} · Available: {Math.max(0, selectedDayMax - selectedDayCap)} · Pending (non-reserving): {selectedDayPending}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onRequestRange(selectedDay, selectedDay)}
            disabled={currentProfile.countsTowardDailyCap && selectedDayCap >= selectedDayMax}
            className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg bg-[#0B1F3A] dark:bg-teal-600 text-white text-xs font-semibold hover:bg-[#14325B] dark:hover:bg-teal-700 disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {currentProfile.countsTowardDailyCap && selectedDayCap >= selectedDayMax
              ? 'Day Capacity Full (10/10)'
              : `Apply for ${formatDisplayDate(selectedDay)}`}
          </button>
        </div>

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
                No approved or pending leave records on this date. All {selectedDayMax} operational slots are open.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {selectedDayVisibleRequests.map((req) => (
                  <div
                    key={req.requestId}
                    className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
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
                    <LeaveStatusLabel status={req.status} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {selectedDayVisibleRequests.length > 0 ? (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {selectedDayVisibleRequests.map((req) => (
                  <div
                    key={req.requestId}
                    className="py-2 flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-slate-100">
                        Your {req.leaveType}
                      </p>
                      <p className="text-slate-500 dark:text-slate-400 font-mono">
                        {req.startDate} to {req.endDate} ({req.daysCount} day{req.daysCount > 1 ? 's' : ''})
                      </p>
                    </div>
                    <LeaveStatusLabel status={req.status} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-2">
                <Info className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" aria-hidden="true" />
                <span>
                  You have no leave scheduled on {formatDisplayDate(selectedDay)}.{' '}
                  {Math.max(0, selectedDayMax - selectedDayCap)} of {selectedDayMax} unit slots are available.
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
