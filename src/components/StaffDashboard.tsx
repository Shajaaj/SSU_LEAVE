import React, { useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  X,
} from 'lucide-react';
import {
  AppSettings,
  DailyCapacity,
  DailyCapacityDetail,
  Designation,
  LeaveRequest,
  LeaveStatus,
  LeaveType,
  StaffProfile,
} from '../types/portal';
import {
  WEEKDAY_HEADERS,
  buildMonthDays,
  formatDisplayDate,
  getCurrentYearInMaldives,
  getMonthMetadata,
  getTodayInMaldives,
} from '../utils/maldivesDate';

interface StaffDashboardProps {
  profile: StaffProfile;
  allRequests: LeaveRequest[];
  profiles?: StaffProfile[];
  capacityMap: Record<string, DailyCapacity>;
  capacityDetailsMap: Record<string, DailyCapacityDetail>;
  settings: AppSettings;
  calendarYear: number;
  calendarMonth0: number;
  onChangeMonth: (y: number, m0: number) => void;
  onOpenNewRequest: (start?: string, end?: string) => void;
  loading?: boolean;
}

const MONTH_OPTIONS = [
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

type StatusFilter = 'all' | 'approved' | 'pending';

interface TimelineSpan {
  key: string;
  requestId: string;
  staffId: string;
  staffName: string;
  designation: Designation;
  leaveType: LeaveType;
  status: LeaveStatus;
  hasModPending: boolean;
  startDate: string;
  endDate: string;
  reason: string;
  startCol: number; // 1-based column inside the month grid
  endCol: number; // 1-based inclusive end column
  spanDays: number;
  lane: number; // 1-based CSS grid row within staff row
  isMine: boolean;
}

interface StaffTimelineRow {
  staffId: string;
  staffName: string;
  designation: Designation;
  isMine: boolean;
  laneCount: number;
  spans: TimelineSpan[];
}

export const StaffDashboard: React.FC<StaffDashboardProps> = ({
  profile,
  allRequests,
  profiles = [],
  capacityMap,
  capacityDetailsMap,
  settings,
  calendarYear,
  calendarMonth0,
  onChangeMonth,
  onOpenNewRequest,
  loading = false,
}) => {
  const todayMaldives = getTodayInMaldives();
  const currentMaldivesYear = getCurrentYearInMaldives();
  const maxCap = settings.maxDailyCombinedCap || 10;

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showAllUnitStaff, setShowAllUnitStaff] = useState(false);
  const [mobileShowEmptyDays, setMobileShowEmptyDays] = useState(false);
  const [selectedSpan, setSelectedSpan] = useState<TimelineSpan | null>(null);

  const meta = useMemo(
    () => getMonthMetadata(calendarYear, calendarMonth0),
    [calendarYear, calendarMonth0]
  );

  const monthDays = useMemo(
    () => buildMonthDays(calendarYear, calendarMonth0),
    [calendarYear, calendarMonth0]
  );

  const dayColumns = useMemo(
    () =>
      monthDays.map((dateKey, idx) => {
        const [y, m, d] = dateKey.split('-').map(Number);
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        const isWeekend = dow === 5 || dow === 6; // Maldives weekend: Fri & Sat
        return {
          dateKey,
          dayStr: String(d).padStart(2, '0'),
          weekday: WEEKDAY_HEADERS[dow],
          colIndex: idx + 1,
          isToday: dateKey === todayMaldives,
          isWeekend,
        };
      }),
    [monthDays, todayMaldives]
  );

  const yearOptions = useMemo(() => {
    const years = new Set<number>([
      currentMaldivesYear - 1,
      currentMaldivesYear,
      currentMaldivesYear + 1,
      currentMaldivesYear + 2,
      calendarYear,
    ]);
    return Array.from(years).sort((a, b) => a - b);
  }, [currentMaldivesYear, calendarYear]);

  const rows = useMemo(() => {
    const rowMap = new Map<string, StaffTimelineRow>();
    const seenRequestIds = new Map<string, Set<string>>();

    const ensureRow = (
      staffId: string,
      staffName: string,
      designation: Designation
    ) => {
      let existing = rowMap.get(staffId);
      if (!existing) {
        existing = {
          staffId,
          staffName,
          designation,
          isMine: staffId === profile.staffId,
          laneCount: 1,
          spans: [],
        };
        rowMap.set(staffId, existing);
        seenRequestIds.set(staffId, new Set());
      }
      return existing;
    };

    if (showAllUnitStaff && profiles.length > 0) {
      for (const p of profiles) {
        if (!p.isActive) continue;
        ensureRow(p.staffId, p.fullName, p.designation);
      }
    }

    // 1. Map leave requests overlapping this month into contiguous horizontal bars
    for (const req of allRequests) {
      if (req.status !== 'approved' && req.status !== 'pending') continue;
      if (statusFilter === 'approved' && req.status !== 'approved') continue;
      if (statusFilter === 'pending' && req.status !== 'pending') continue;

      if (req.endDate < meta.startDate || req.startDate > meta.endDate) {
        continue;
      }

      const clippedStart =
        req.startDate < meta.startDate ? meta.startDate : req.startDate;
      const clippedEnd =
        req.endDate > meta.endDate ? meta.endDate : req.endDate;

      const startDayNum = Number(clippedStart.slice(8, 10));
      const endDayNum = Number(clippedEnd.slice(8, 10));
      if (startDayNum > endDayNum) continue;

      const row = ensureRow(req.staffId, req.staffName, req.designation);
      const seen = seenRequestIds.get(req.staffId)!;
      if (seen.has(req.requestId)) continue;
      seen.add(req.requestId);

      row.spans.push({
        key: `${req.requestId}_${clippedStart}`,
        requestId: req.requestId,
        staffId: req.staffId,
        staffName: req.staffName,
        designation: req.designation,
        leaveType: req.leaveType,
        status: req.status,
        hasModPending: req.modificationRequestType !== 'none',
        startDate: req.startDate,
        endDate: req.endDate,
        reason: req.reason || '',
        startCol: startDayNum,
        endCol: endDayNum,
        spanDays: endDayNum - startDayNum + 1,
        lane: 1,
        isMine: req.staffId === profile.staffId,
      });
    }

    // 2. Fallback: merge any dailyCapacityDetails allocations not already represented
    if (statusFilter !== 'pending') {
      const allocByReqStaff = new Map<
        string,
        {
          requestId: string;
          staffId: string;
          staffName: string;
          designation: Designation;
          leaveType: LeaveType;
          days: number[];
        }
      >();

      for (const dateKey of monthDays) {
        const dayNum = Number(dateKey.slice(8, 10));
        const allocs = capacityDetailsMap[dateKey]?.allocations || [];
        for (const a of allocs) {
          const seen = seenRequestIds.get(a.staffId);
          if (seen && seen.has(a.requestId)) continue;
          const groupKey = `${a.staffId}::${a.requestId}`;
          let g = allocByReqStaff.get(groupKey);
          if (!g) {
            g = {
              requestId: a.requestId,
              staffId: a.staffId,
              staffName: a.staffName,
              designation: a.designation,
              leaveType: a.leaveType,
              days: [],
            };
            allocByReqStaff.set(groupKey, g);
          }
          g.days.push(dayNum);
        }
      }

      for (const g of allocByReqStaff.values()) {
        g.days.sort((a, b) => a - b);
        const startDay = g.days[0];
        const endDay = g.days[g.days.length - 1];
        const monthPrefix = meta.startDate.slice(0, 8);
        const row = ensureRow(g.staffId, g.staffName, g.designation);
        row.spans.push({
          key: `${g.requestId}_${startDay}`,
          requestId: g.requestId,
          staffId: g.staffId,
          staffName: g.staffName,
          designation: g.designation,
          leaveType: g.leaveType,
          status: 'approved',
          hasModPending: false,
          startDate: `${monthPrefix}${String(startDay).padStart(2, '0')}`,
          endDate: `${monthPrefix}${String(endDay).padStart(2, '0')}`,
          reason: '',
          startCol: startDay,
          endCol: endDay,
          spanDays: endDay - startDay + 1,
          lane: 1,
          isMine: g.staffId === profile.staffId,
        });
      }
    }

    const query = searchTerm.trim().toLowerCase();
    const list = Array.from(rowMap.values()).filter((r) => {
      if (!showAllUnitStaff && r.spans.length === 0) return false;
      if (!query) return true;
      return (
        r.staffName.toLowerCase().includes(query) ||
        r.staffId.toLowerCase().includes(query) ||
        r.designation.toLowerCase().includes(query)
      );
    });

    // Sort spans inside each row chronologically, assign non-overlapping lanes, and sort rows
    for (const r of list) {
      r.spans.sort((a, b) => a.startCol - b.startCol);
      const laneEndCols: number[] = [];
      for (const span of r.spans) {
        let assigned = -1;
        for (let i = 0; i < laneEndCols.length; i++) {
          if (span.startCol > laneEndCols[i]) {
            assigned = i;
            laneEndCols[i] = span.endCol;
            break;
          }
        }
        if (assigned === -1) {
          assigned = laneEndCols.length;
          laneEndCols.push(span.endCol);
        }
        span.lane = assigned + 1;
      }
      r.laneCount = Math.max(1, laneEndCols.length);
    }

    list.sort((a, b) => {
      const aFirst = a.spans[0]?.startCol ?? 99;
      const bFirst = b.spans[0]?.startCol ?? 99;
      if (aFirst !== bFirst) return aFirst - bFirst;
      return a.staffName.localeCompare(b.staffName);
    });

    return list;
  }, [
    allRequests,
    capacityDetailsMap,
    monthDays,
    meta.startDate,
    meta.endDate,
    profile.staffId,
    profiles,
    showAllUnitStaff,
    statusFilter,
    searchTerm,
  ]);

  const handlePrevMonth = () => {
    if (calendarMonth0 === 0) {
      onChangeMonth(calendarYear - 1, 11);
    } else {
      onChangeMonth(calendarYear, calendarMonth0 - 1);
    }
  };

  const handleNextMonth = () => {
    if (calendarMonth0 === 11) {
      onChangeMonth(calendarYear + 1, 0);
    } else {
      onChangeMonth(calendarYear, calendarMonth0 + 1);
    }
  };

  const handleToday = () => {
    const y = Number(todayMaldives.slice(0, 4));
    const m = Number(todayMaldives.slice(5, 7)) - 1;
    onChangeMonth(y, m);
  };

  // Group active spans per date for clean mobile day-by-day roster cards
  const mobileDayRoster = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return dayColumns
      .map((col) => {
        const activeSpans: TimelineSpan[] = [];
        for (const r of rows) {
          for (const sp of r.spans) {
            if (col.colIndex >= sp.startCol && col.colIndex <= sp.endCol) {
              if (
                !query ||
                sp.staffName.toLowerCase().includes(query) ||
                sp.staffId.toLowerCase().includes(query)
              ) {
                activeSpans.push(sp);
              }
            }
          }
        }
        return {
          ...col,
          spans: activeSpans,
          usedCap: capacityMap[col.dateKey]?.approvedCount || 0,
          limitCap: capacityMap[col.dateKey]?.maxCapacity || maxCap,
        };
      })
      .filter((d) => mobileShowEmptyDays || d.spans.length > 0 || d.isToday);
  }, [dayColumns, rows, searchTerm, capacityMap, maxCap, mobileShowEmptyDays]);

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5">
      {/* Top Toolbar: Year & Month Selectors (matching reference layout) + Search & Legend */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {/* Year Dropdown */}
          <div className="relative flex items-center bg-white dark:bg-[#0D1B2A] border border-[#1E4B8F] dark:border-slate-700 rounded-md overflow-hidden shadow-2xs">
            <select
              aria-label="Select year"
              value={calendarYear}
              onChange={(e) => onChangeMonth(Number(e.target.value), calendarMonth0)}
              className="appearance-none bg-transparent min-h-[40px] sm:min-h-0 pl-3 pr-9 py-1.5 text-base sm:text-sm font-semibold text-[#0B1F3A] dark:text-white focus:outline-none cursor-pointer tabular-nums"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y} className="dark:bg-[#0D1B2A]">
                  {y}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-0 inset-y-0 w-7 bg-[#2E5FA8] dark:bg-teal-700 text-white flex items-center justify-center">
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            </span>
          </div>

          {/* Month Dropdown */}
          <div className="relative flex-1 sm:flex-none flex items-center bg-white dark:bg-[#0D1B2A] border border-[#1E4B8F] dark:border-slate-700 rounded-md overflow-hidden shadow-2xs min-w-[140px] sm:min-w-[165px]">
            <select
              aria-label="Select month"
              value={calendarMonth0}
              onChange={(e) => onChangeMonth(calendarYear, Number(e.target.value))}
              className="w-full appearance-none bg-transparent min-h-[40px] sm:min-h-0 pl-3 pr-9 py-1.5 text-base sm:text-sm font-semibold text-[#0B1F3A] dark:text-white focus:outline-none cursor-pointer"
            >
              {MONTH_OPTIONS.map((label, idx) => (
                <option key={label} value={idx} className="dark:bg-[#0D1B2A]">
                  {label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-0 inset-y-0 w-7 bg-[#2E5FA8] dark:bg-teal-700 text-white flex items-center justify-center">
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            </span>
          </div>

          {/* Quick Month Stepper */}
          <div className="flex items-center border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1B2A] rounded-md overflow-hidden">
            <button
              type="button"
              onClick={handlePrevMonth}
              className="min-h-[40px] min-w-[38px] sm:min-h-0 sm:min-w-0 p-1.5 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleToday}
              className="min-h-[40px] sm:min-h-0 px-2.5 py-1 text-xs font-semibold border-x border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              Today
            </button>
            <button
              type="button"
              onClick={handleNextMonth}
              className="min-h-[40px] min-w-[38px] sm:min-h-0 sm:min-w-0 p-1.5 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {loading && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Syncing...
            </span>
          )}
        </div>

        {/* Right Controls: Search + Status Filter + Legend */}
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-none">
            <Search
              className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search staff..."
              aria-label="Filter staff by name or ID"
              className="w-full sm:w-44 min-h-[40px] sm:min-h-0 pl-8 pr-6 py-1.5 text-base sm:text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1B2A] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div
            className="flex items-center p-0.5 bg-slate-200/70 dark:bg-[#0D1B2A] rounded-md border border-slate-300/80 dark:border-slate-700"
            role="group"
            aria-label="Leave status filter"
          >
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'approved', label: 'Approved' },
                { id: 'pending', label: 'Pending' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`min-h-[36px] sm:min-h-0 px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  statusFilter === tab.id
                    ? 'bg-white dark:bg-teal-600 text-[#0B1F3A] dark:text-white shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {profiles.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAllUnitStaff((v) => !v)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                showAllUnitStaff
                  ? 'bg-[#0B1F3A] text-white border-[#0B1F3A] dark:bg-teal-600 dark:border-teal-600'
                  : 'bg-white dark:bg-[#0D1B2A] text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {showAllUnitStaff ? 'All Unit Staff' : 'On Leave Only'}
            </button>
          )}

          <div className="hidden xl:flex items-center gap-3 text-[11px] text-slate-600 dark:text-slate-400 pl-1">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-3 h-2.5 rounded-xs bg-[#9CD3A4] dark:bg-emerald-500/45 border border-emerald-600/50 inline-block" />
              Approved
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-3 h-2.5 rounded-xs bg-[#F5D7A1] dark:bg-amber-500/45 border border-amber-600/50 inline-block" />
              Pending
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-3 h-2.5 rounded-xs bg-[#D8DADF] dark:bg-slate-600 border border-slate-500/50 inline-block" />
              Mod Pending
            </span>
          </div>
        </div>
      </div>

      {/* Mobile-First Day-by-Day Leave Roster Cards (< 768px) */}
      <div className="md:hidden space-y-2.5 pb-4">
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            {rows.length} staff with leave in {meta.label}
          </p>
          <button
            type="button"
            onClick={() => setMobileShowEmptyDays((v) => !v)}
            className="min-h-[36px] px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1B2A] text-xs font-medium text-slate-700 dark:text-slate-200"
          >
            {mobileShowEmptyDays ? 'Days with Leave Only' : 'Show All Days'}
          </button>
        </div>

        {mobileDayRoster.length === 0 ? (
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-6 text-center space-y-2.5">
            <CalendarDays
              className="w-7 h-7 text-slate-400 mx-auto"
              aria-hidden="true"
            />
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              No staff on leave in {meta.label}
            </p>
            <button
              type="button"
              onClick={() => onOpenNewRequest(meta.startDate, meta.startDate)}
              className="min-h-[44px] px-4 py-2 rounded-lg bg-teal-600 text-white text-xs font-semibold inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>New Leave Request</span>
            </button>
          </div>
        ) : (
          mobileDayRoster.map((day) => {
            const isFull = day.usedCap >= day.limitCap;
            return (
              <div
                key={day.dateKey}
                className={`rounded-xl border overflow-hidden ${
                  day.isToday
                    ? 'border-teal-500 bg-teal-50/30 dark:bg-teal-950/20'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0D1B2A]'
                }`}
              >
                <div className="px-3.5 py-2.5 bg-slate-50/90 dark:bg-[#091526] border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-bold text-[#0B1F3A] dark:text-white">
                      {day.weekday}, {formatDisplayDate(day.dateKey)}
                    </span>
                    {day.isToday && (
                      <span className="text-[11px] font-semibold text-teal-700 dark:text-teal-400">
                        · Today
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-mono tabular-nums font-bold ${
                        isFull
                          ? 'text-red-700 dark:text-red-400'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {day.usedCap}/{day.limitCap}
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenNewRequest(day.dateKey, day.dateKey)}
                      className="min-h-[36px] px-2.5 py-1 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-semibold whitespace-nowrap"
                    >
                      + Apply
                    </button>
                  </div>
                </div>

                {day.spans.length === 0 ? (
                  <p className="px-3.5 py-2.5 text-xs text-slate-400 dark:text-slate-500">
                    No staff on leave
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {day.spans.map((sp) => (
                      <button
                        key={`${day.dateKey}_${sp.key}`}
                        type="button"
                        onClick={() => setSelectedSpan(sp)}
                        className="w-full min-h-[48px] px-3.5 py-2 text-left flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                            {sp.staffName}
                            {sp.isMine && (
                              <span className="ml-1.5 text-teal-700 dark:text-teal-400">
                                (You)
                              </span>
                            )}
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate font-mono">
                            {sp.staffId} · {sp.leaveType} ·{' '}
                            {formatDisplayDate(sp.startDate)} –{' '}
                            {formatDisplayDate(sp.endDate)}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold border ${
                            sp.hasModPending
                              ? 'bg-[#D8DADF] dark:bg-slate-700 border-slate-400 text-slate-800 dark:text-slate-200'
                              : sp.status === 'pending'
                                ? 'bg-[#F5D7A1]/60 dark:bg-amber-500/20 border-amber-500/50 text-amber-900 dark:text-amber-200'
                                : 'bg-[#9CD3A4]/50 dark:bg-emerald-500/20 border-emerald-600/40 text-emerald-900 dark:text-emerald-200'
                          }`}
                        >
                          {sp.status === 'approved' ? 'Approved' : 'Pending'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Desktop & Tablet Full-Month Horizontal Staff Timeline Matrix (>= 768px) */}
      <div className="hidden md:flex flex-1 min-h-[520px] lg:min-h-0 flex-col bg-[#EEF2F7] dark:bg-[#0D1B2A] border-2 border-[#233B6E] dark:border-slate-700 rounded-md overflow-hidden shadow-xs">
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto flex flex-col">
          <div className="min-w-[780px] lg:min-w-0 w-full flex-1 flex flex-col">
            {/* Sticky Day Header Row */}
            <div className="sticky top-0 z-20 flex bg-[#E8EEF5] dark:bg-[#0B1F3A] border-b-2 border-[#0B1F3A] dark:border-slate-600 shrink-0">
              <div className="sticky left-0 z-30 w-[152px] xl:w-[185px] shrink-0 bg-[#E8EEF5] dark:bg-[#0B1F3A] border-r border-slate-300 dark:border-slate-700 px-3 py-1.5 flex items-end justify-between">
                <span className="text-[11px] font-semibold text-[#0B1F3A] dark:text-slate-200 truncate">
                  Staff ({rows.length})
                </span>
              </div>

              <div
                className="flex-1 min-w-0 grid"
                style={{
                  gridTemplateColumns: `repeat(${dayColumns.length}, minmax(0, 1fr))`,
                }}
              >
                {dayColumns.map((col) => (
                  <button
                    key={col.dateKey}
                    type="button"
                    onClick={() => onOpenNewRequest(col.dateKey, col.dateKey)}
                    title={`Request leave starting ${formatDisplayDate(col.dateKey)}`}
                    className={`py-1 px-0 text-center border-r last:border-r-0 border-slate-300/70 dark:border-slate-700/70 flex flex-col items-center justify-center transition-colors hover:bg-white/60 dark:hover:bg-white/10 ${
                      col.isToday
                        ? 'bg-teal-600 text-white'
                        : col.isWeekend
                          ? 'bg-slate-200/60 dark:bg-slate-900/50 text-slate-700 dark:text-slate-300'
                          : 'text-[#0B1F3A] dark:text-slate-200'
                    }`}
                  >
                    <span
                      className={`text-[8.5px] xl:text-[9.5px] leading-tight font-medium ${
                        col.isToday ? 'text-teal-100' : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {col.weekday}
                    </span>
                    <span className="text-[10px] xl:text-[11px] leading-tight font-bold font-mono tabular-nums">
                      {col.dayStr}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Staff Rows Body */}
            <div className="flex-1 bg-white dark:bg-[#0D1B2A]">
              {rows.length === 0 ? (
                <div className="h-full min-h-[260px] flex flex-col items-center justify-center p-6 text-center space-y-2.5">
                  <CalendarDays
                    className="w-8 h-8 text-slate-400 dark:text-slate-500"
                    aria-hidden="true"
                  />
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                      No staff on leave in {meta.label}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {searchTerm || statusFilter !== 'all'
                        ? 'Try clearing your search or status filter, or switch months above.'
                        : 'All operational leave slots are open across this month.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenNewRequest(meta.startDate, meta.startDate)}
                    className="px-3.5 py-1.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold transition-colors flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>New Leave Request</span>
                  </button>
                </div>
              ) : (
                rows.map((row, rowIdx) => (
                  <div
                    key={row.staffId}
                    className={`flex min-h-[34px] border-b-[2px] border-[#1A356B]/75 dark:border-slate-700 ${
                      row.isMine
                        ? 'bg-teal-50/40 dark:bg-teal-950/20'
                        : rowIdx % 2 === 1
                          ? 'bg-[#F5F7FA] dark:bg-[#0A1624]'
                          : 'bg-white dark:bg-[#0D1B2A]'
                    }`}
                  >
                    {/* Sticky Staff Name Column */}
                    <div
                      className={`sticky left-0 z-10 w-[152px] xl:w-[185px] shrink-0 border-r border-slate-300 dark:border-slate-700 px-2.5 py-1 flex items-center justify-between gap-1.5 ${
                        row.isMine
                          ? 'bg-[#EAF7F5] dark:bg-[#0D262A]'
                          : rowIdx % 2 === 1
                            ? 'bg-[#F5F7FA] dark:bg-[#0A1624]'
                            : 'bg-white dark:bg-[#0D1B2A]'
                      }`}
                      title={`${row.staffName} (${row.staffId} · ${row.designation})`}
                    >
                      <span className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                        {row.staffName}
                      </span>
                      {row.isMine && (
                        <span className="text-[10px] font-semibold text-teal-700 dark:text-teal-400 shrink-0">
                          You
                        </span>
                      )}
                    </div>

                    {/* Horizontal Day Cells + Overlaid Contiguous Leave Bars */}
                    <div
                      className="flex-1 min-w-0 grid relative"
                      style={{
                        gridTemplateColumns: `repeat(${dayColumns.length}, minmax(0, 1fr))`,
                        gridTemplateRows: `repeat(${row.laneCount}, 32px)`,
                      }}
                    >
                      {/* Background Day Gridlines */}
                      {dayColumns.map((col) => (
                        <button
                          key={col.dateKey}
                          type="button"
                          onClick={() => onOpenNewRequest(col.dateKey, col.dateKey)}
                          aria-label={`Apply for leave on ${formatDisplayDate(col.dateKey)}`}
                          style={{
                            gridColumnStart: col.colIndex,
                            gridColumnEnd: col.colIndex + 1,
                            gridRowStart: 1,
                            gridRowEnd: row.laneCount + 1,
                          }}
                          className={`h-full border-r last:border-r-0 border-slate-300/75 dark:border-slate-800/90 transition-colors hover:bg-teal-500/10 ${
                            col.isToday
                              ? 'bg-teal-500/8'
                              : col.isWeekend
                                ? 'bg-slate-200/35 dark:bg-slate-900/35'
                                : ''
                          }`}
                        />
                      ))}

                      {/* Contiguous Horizontal Leave Bars */}
                      {row.spans.map((span) => {
                        const barColors = span.hasModPending
                          ? 'bg-[#D8DADF] dark:bg-slate-600/80 border-[#8C929C] dark:border-slate-400 text-slate-900 dark:text-slate-100'
                          : span.status === 'pending'
                            ? 'bg-[#F5D7A1] dark:bg-amber-500/35 border-[#C49A45] dark:border-amber-400/70 text-amber-950 dark:text-amber-100'
                            : 'bg-[#9CD3A4] dark:bg-emerald-500/35 border-[#5B9A65] dark:border-emerald-400/70 text-emerald-950 dark:text-emerald-100';

                        return (
                          <button
                            key={span.key}
                            type="button"
                            onClick={() => setSelectedSpan(span)}
                            title={`${span.staffName} (${span.staffId}) · ${span.leaveType} · ${formatDisplayDate(span.startDate)} – ${formatDisplayDate(span.endDate)} (${span.status})`}
                            style={{
                              gridColumnStart: span.startCol,
                              gridColumnEnd: span.endCol + 1,
                              gridRowStart: span.lane,
                            }}
                            className={`relative z-10 my-[4px] mx-[1px] h-[24px] rounded-[2px] border px-1.5 flex items-center justify-between gap-1 text-[10px] font-medium overflow-hidden transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B1F3A] dark:focus-visible:ring-teal-400 ${barColors}`}
                          >
                            {span.spanDays >= 3 && (
                              <span className="truncate leading-none">
                                {span.status === 'pending'
                                  ? 'Pending'
                                  : span.hasModPending
                                    ? 'Mod Pending'
                                    : span.leaveType}
                              </span>
                            )}
                            {span.spanDays >= 5 && (
                              <span className="shrink-0 font-mono text-[9px] opacity-80">
                                {span.spanDays}d
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Sticky Bottom Daily Capacity Summary Row */}
            <div className="sticky bottom-0 z-20 flex bg-[#E8EEF5] dark:bg-[#0B1F3A] border-t-2 border-[#0B1F3A] dark:border-slate-600 shrink-0">
              <div className="sticky left-0 z-30 w-[152px] xl:w-[185px] shrink-0 bg-[#E8EEF5] dark:bg-[#0B1F3A] border-r border-slate-300 dark:border-slate-700 px-3 py-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-[#0B1F3A] dark:text-slate-200 truncate">
                  Daily Cap ({maxCap} max)
                </span>
              </div>

              <div
                className="flex-1 min-w-0 grid"
                style={{
                  gridTemplateColumns: `repeat(${dayColumns.length}, minmax(0, 1fr))`,
                }}
              >
                {dayColumns.map((col) => {
                  const used = capacityMap[col.dateKey]?.approvedCount || 0;
                  const limit = capacityMap[col.dateKey]?.maxCapacity || maxCap;
                  const isFull = used >= limit;
                  return (
                    <div
                      key={col.dateKey}
                      title={`${formatDisplayDate(col.dateKey)}: ${used}/${limit} cap slots used`}
                      className={`py-1 text-center text-[10px] font-mono tabular-nums font-bold border-r last:border-r-0 border-slate-300/70 dark:border-slate-700/70 ${
                        isFull
                          ? 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-300'
                          : used > 0
                            ? 'text-teal-800 dark:text-teal-300'
                            : 'text-slate-400 dark:text-slate-500'
                      }`}
                    >
                      {used}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Selected Leave Span Detail Modal */}
      {selectedSpan && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-span-modal-title"
          onClick={() => setSelectedSpan(null)}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-3">
              <div>
                <h3
                  id="leave-span-modal-title"
                  className="text-base font-display font-bold text-[#0B1F3A] dark:text-white"
                >
                  {selectedSpan.staffName}
                </h3>
                <p className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                  {selectedSpan.staffId} · {selectedSpan.designation}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSpan(null)}
                className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                aria-label="Close leave details"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3 text-xs overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-slate-500 dark:text-slate-400">Leave Type</p>
                  <p className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                    {selectedSpan.leaveType}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500 dark:text-slate-400">Status</p>
                  <p
                    className={`font-semibold mt-0.5 ${
                      selectedSpan.status === 'approved'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {selectedSpan.status === 'approved' ? 'Approved' : 'Pending Approval'}
                    {selectedSpan.hasModPending ? ' (Modification Pending)' : ''}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-slate-500 dark:text-slate-400">Leave Period</p>
                <p className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {formatDisplayDate(selectedSpan.startDate)} –{' '}
                  {formatDisplayDate(selectedSpan.endDate)}
                </p>
              </div>

              {selectedSpan.reason && (
                <div>
                  <p className="text-slate-500 dark:text-slate-400">Reason</p>
                  <p className="text-slate-700 dark:text-slate-300 mt-0.5 leading-relaxed">
                    {selectedSpan.reason}
                  </p>
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#091526] flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setSelectedSpan(null)}
                className="min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = selectedSpan.startDate;
                  setSelectedSpan(null);
                  onOpenNewRequest(target, target);
                }}
                className="min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold transition-colors flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Apply Around This Date</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
