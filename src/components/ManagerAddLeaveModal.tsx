import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarPlus,
  Check,
  ChevronDown,
  Search,
  ShieldAlert,
  UserCheck,
  X,
} from 'lucide-react';
import {
  AppSettings,
  DailyCapacity,
  DailyCapacityDetail,
  LeaveRequest,
  StaffProfile,
} from '../types/portal';
import { fetchCapacityForDates } from '../services/firebasePortalService';
import {
  buildPendingDemandMap,
  calculateAnnualPeriodUsage,
  getDailyCapacityBreakdown,
} from '../utils/leaveRules';
import {
  expandDateRange,
  formatDisplayDate,
  getTodayInMaldives,
} from '../utils/maldivesDate';

interface ManagerAddLeaveModalProps {
  open: boolean;
  onClose: () => void;
  profiles: StaffProfile[];
  allRequests: LeaveRequest[];
  capacityMap: Record<string, DailyCapacity>;
  capacityDetailsMap?: Record<string, DailyCapacityDetail>;
  settings: AppSettings;
  onSubmit: (payload: {
    staffId: string;
    startDate: string;
    endDate: string;
    reason: string;
    confirmOverlap: boolean;
  }) => Promise<void>;
}

export const ManagerAddLeaveModal: React.FC<ManagerAddLeaveModalProps> = ({
  open,
  onClose,
  profiles,
  allRequests,
  capacityMap,
  capacityDetailsMap,
  settings,
  onSubmit,
}) => {
  const today = getTodayInMaldives();
  const maxDailyCap = settings.maxDailyCombinedCap || 10;

  const [staffSearch, setStaffSearch] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState('');
  const [confirmOverlap, setConfirmOverlap] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [extraCapMap, setExtraCapMap] = useState<Record<string, DailyCapacity>>({});
  const [extraDetailsMap, setExtraDetailsMap] = useState<
    Record<string, DailyCapacityDetail>
  >({});

  const dropdownContainerRef = useRef<HTMLDivElement | null>(null);

  const activeStaff = useMemo(
    () =>
      profiles
        .filter((p) => p.isActive)
        .slice()
        .sort((a, b) => a.staffId.localeCompare(b.staffId)),
    [profiles]
  );

  const selectedStaff = useMemo(
    () => activeStaff.find((p) => p.staffId === selectedStaffId) || null,
    [activeStaff, selectedStaffId]
  );

  const filteredStaff = useMemo(() => {
    const q = staffSearch.trim().toLowerCase();
    if (!q) return activeStaff;
    return activeStaff.filter(
      (p) =>
        p.staffId.toLowerCase().includes(q) ||
        p.fullName.toLowerCase().includes(q) ||
        p.designation.toLowerCase().includes(q)
    );
  }, [activeStaff, staffSearch]);

  useEffect(() => {
    if (open) {
      setStaffSearch('');
      setDropdownOpen(false);
      setSelectedStaffId('');
      setStartDate(today);
      setEndDate(today);
      setReason('');
      setConfirmOverlap(false);
      setSubmitError(null);
      setExtraCapMap({});
      setExtraDetailsMap({});
    }
  }, [open, today]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const onOutsideClick = (e: MouseEvent) => {
      if (
        dropdownContainerRef.current &&
        !dropdownContainerRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, [dropdownOpen]);

  const expandedRange = useMemo(() => {
    if (!open || !startDate || !endDate) {
      return { dates: [] as string[], error: 'Please choose start and end dates.' };
    }
    return expandDateRange(startDate, endDate, 30);
  }, [open, startDate, endDate]);

  useEffect(() => {
    setConfirmOverlap(false);
    setSubmitError(null);
  }, [selectedStaffId, startDate, endDate]);

  useEffect(() => {
    if (!open || expandedRange.dates.length === 0) return;
    const missing = expandedRange.dates.filter(
      (d) => !(d in capacityMap) && !(d in extraCapMap)
    );
    if (missing.length === 0) return;

    let cancelled = false;
    void fetchCapacityForDates(missing)
      .then((res) => {
        if (cancelled) return;
        setExtraCapMap((prev) => ({ ...prev, ...res.capacityMap }));
        setExtraDetailsMap((prev) => ({ ...prev, ...res.capacityDetailsMap }));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [open, expandedRange.dates, capacityMap, extraCapMap]);

  const mergedCapacityMap = useMemo(
    () => ({ ...extraCapMap, ...capacityMap }),
    [extraCapMap, capacityMap]
  );

  const mergedDetailsMap = useMemo(
    () => ({ ...extraDetailsMap, ...(capacityDetailsMap || {}) }),
    [extraDetailsMap, capacityDetailsMap]
  );

  const pendingDemandMap = useMemo(
    () => buildPendingDemandMap(allRequests),
    [allRequests]
  );

  const overlappingInfo = useMemo(() => {
    if (!selectedStaff || expandedRange.dates.length === 0) {
      return { overlappingDates: [] as string[], requests: [] as LeaveRequest[] };
    }
    const selectedSet = new Set(expandedRange.dates);
    const matchingRequests: LeaveRequest[] = [];
    const dateSet = new Set<string>();

    for (const r of allRequests) {
      if (r.staffId !== selectedStaff.staffId) continue;
      if (r.status !== 'pending' && r.status !== 'approved') continue;
      const hits = (r.dates || []).filter((d) => selectedSet.has(d));
      if (hits.length > 0) {
        matchingRequests.push(r);
        for (const h of hits) dateSet.add(h);
      }
    }

    return {
      overlappingDates: Array.from(dateSet).sort(),
      requests: matchingRequests,
    };
  }, [selectedStaff, expandedRange.dates, allRequests]);

  const capacityPreview = useMemo(() => {
    const countsTowardCap = Boolean(selectedStaff?.countsTowardDailyCap);
    return expandedRange.dates.map((dateKey) => {
      const breakdown = getDailyCapacityBreakdown({
        dateKey,
        capacityMap: mergedCapacityMap,
        pendingDemandMap,
        capacityDetailsMap: mergedDetailsMap,
        defaultMaxCap: maxDailyCap,
        pendingReservesCapacity: Boolean(settings.pendingReservesCapacity),
      });
      const projectedOccupied = countsTowardCap
        ? breakdown.occupiedCount + 1
        : breakdown.occupiedCount;
      const willExceedCap = countsTowardCap && projectedOccupied > breakdown.maxCapacity;
      return {
        dateKey,
        ...breakdown,
        projectedOccupied,
        willExceedCap,
      };
    });
  }, [
    expandedRange.dates,
    selectedStaff,
    mergedCapacityMap,
    pendingDemandMap,
    mergedDetailsMap,
    maxDailyCap,
    settings.pendingReservesCapacity,
  ]);

  const calendarYear = Number((startDate || today).slice(0, 4));
  const annualUsage = useMemo(() => {
    if (!selectedStaff) return null;
    return calculateAnnualPeriodUsage(
      allRequests,
      selectedStaff.staffId,
      calendarYear,
      selectedStaff.annualPeriodLimit || settings.maxAnnualLeavePeriods || 3
    );
  }, [selectedStaff, allRequests, calendarYear, settings.maxAnnualLeavePeriods]);

  const hasOverCapacityDate = capacityPreview.some((d) => d.willExceedCap);
  const hasOverlap = overlappingInfo.overlappingDates.length > 0;

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (!selectedStaff) {
      setSubmitError('Please select a staff member.');
      return;
    }
    if (expandedRange.error || expandedRange.dates.length === 0) {
      setSubmitError(expandedRange.error || 'Please choose a valid leave date range.');
      return;
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length > 0 && trimmedReason.length < 3) {
      setSubmitError('Reason / Remarks must be at least 3 characters if provided.');
      return;
    }
    if (hasOverlap && !confirmOverlap) {
      setSubmitError(
        'Please confirm the overlapping leave warning before adding this approved leave.'
      );
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        staffId: selectedStaff.staffId,
        startDate,
        endDate,
        reason: trimmedReason || 'Added directly by Manager.',
        confirmOverlap: hasOverlap ? confirmOverlap : false,
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('OVERLAP_CONFIRM_REQUIRED:')) {
        setSubmitError(msg.replace('OVERLAP_CONFIRM_REQUIRED:', '').trim());
      } else {
        setSubmitError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manager-add-leave-title"
    >
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-2xl w-full shadow-2xl overflow-hidden max-h-[94vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-50 dark:bg-teal-950/60 border border-teal-200 dark:border-teal-800/70 text-teal-700 dark:text-teal-300 flex items-center justify-center shrink-0">
              <CalendarPlus className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="manager-add-leave-title"
                className="text-base font-display font-bold text-[#0B1F3A] dark:text-white"
              >
                Manager Add Leave
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Assign immediately approved Annual Leave directly, bypassing standard limits and restrictions.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close Manager Add Leave modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto text-xs">
          {/* Searchable Staff Member Dropdown */}
          <div ref={dropdownContainerRef} className="relative space-y-1.5">
            <label
              htmlFor="manager-add-staff-search"
              className="block font-semibold text-slate-700 dark:text-slate-200"
            >
              Staff Member <span className="text-red-600">*</span>
            </label>

            <div className="relative">
              <Search
                className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="manager-add-staff-search"
                type="text"
                value={
                  dropdownOpen
                    ? staffSearch
                    : selectedStaff
                      ? `${selectedStaff.staffId} — ${selectedStaff.fullName}`
                      : staffSearch
                }
                onFocus={() => {
                  setDropdownOpen(true);
                  if (selectedStaff && !staffSearch) {
                    setStaffSearch('');
                  }
                }}
                onChange={(e) => {
                  setStaffSearch(e.target.value);
                  setDropdownOpen(true);
                }}
                placeholder="Search by Staff ID or Full Name..."
                autoComplete="off"
                className="w-full min-h-[42px] sm:min-h-0 pl-9 pr-16 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {(selectedStaff || staffSearch) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedStaffId('');
                      setStaffSearch('');
                      setDropdownOpen(true);
                    }}
                    className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    aria-label="Clear selected staff"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDropdownOpen((v) => !v)}
                  className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  aria-label="Toggle staff list"
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
              </div>
            </div>

            {dropdownOpen && (
              <div className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B1928] shadow-xl divide-y divide-slate-100 dark:divide-slate-800">
                {filteredStaff.length === 0 ? (
                  <p className="p-3 text-xs text-slate-500 dark:text-slate-400 text-center">
                    No active staff match &ldquo;{staffSearch}&rdquo;.
                  </p>
                ) : (
                  filteredStaff.map((p) => {
                    const isSelected = p.staffId === selectedStaffId;
                    return (
                      <button
                        key={p.staffId}
                        type="button"
                        onClick={() => {
                          setSelectedStaffId(p.staffId);
                          setStaffSearch('');
                          setDropdownOpen(false);
                        }}
                        className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 transition-colors ${
                          isSelected
                            ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-900 dark:text-teal-200'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/70'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                            <span className="font-mono text-teal-700 dark:text-teal-400 mr-1.5">
                              {p.staffId}
                            </span>
                            <span>{p.fullName}</span>
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            {p.designation} · {p.countsTowardDailyCap ? 'Counts toward 10-slot cap' : 'Exempt from 10-slot cap'}
                          </p>
                        </div>
                        {isSelected && (
                          <Check className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Designation (Auto-Populated) & Total Leave Days */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-200 mb-1">
                Designation
              </label>
              <div className="min-h-[38px] px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#07111E] flex items-center justify-between gap-2">
                {selectedStaff ? (
                  <>
                    <span className="font-mono font-semibold text-slate-900 dark:text-white">
                      {selectedStaff.designation}
                    </span>
                    <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                      {selectedStaff.countsTowardDailyCap
                        ? 'Cap-counted'
                        : 'Cap-exempt'}
                    </span>
                  </>
                ) : (
                  <span className="text-slate-400">Select a staff member above</span>
                )}
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-200 mb-1">
                Total Leave Days
              </label>
              <div className="min-h-[38px] px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#07111E] flex items-center justify-between">
                <span className="font-mono font-bold text-sm text-[#0B1F3A] dark:text-white tabular-nums">
                  {expandedRange.error ? '—' : `${expandedRange.dates.length} day${expandedRange.dates.length === 1 ? '' : 's'}`}
                </span>
                <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                  Approved Immediately
                </span>
              </div>
            </div>
          </div>

          {/* Start & End Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="manager-add-start"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                Start Date (MVT)
              </label>
              <input
                id="manager-add-start"
                type="date"
                value={startDate}
                onChange={(e) => {
                  const nextStart = e.target.value;
                  setStartDate(nextStart);
                  if (endDate < nextStart) {
                    setEndDate(nextStart);
                  }
                }}
                required
                className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
              />
            </div>

            <div>
              <label
                htmlFor="manager-add-end"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                End Date (MVT)
              </label>
              <input
                id="manager-add-end"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
              />
            </div>
          </div>

          {expandedRange.error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300">
              {expandedRange.error}
            </div>
          )}

          {/* Reason / Remarks */}
          <div>
            <label
              htmlFor="manager-add-reason"
              className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
            >
              Reason / Remarks
            </label>
            <textarea
              id="manager-add-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional remarks (e.g. Operational override, emergency leave, roster adjustment)..."
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
            />
          </div>

          {/* Bypass Information Banner (Annual Limit / Over Capacity) */}
          {selectedStaff &&
            ((annualUsage && annualUsage.totalAllocatedPeriods >= annualUsage.limit) ||
              hasOverCapacityDate) && (
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-1 text-[11px] text-slate-600 dark:text-slate-300">
                <p className="font-semibold text-[#0B1F3A] dark:text-teal-300 flex items-center gap-1.5">
                  <UserCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Manager Override Active</span>
                </p>
                {annualUsage && annualUsage.totalAllocatedPeriods >= annualUsage.limit && (
                  <p>
                    • {selectedStaff.fullName} already has{' '}
                    <span className="font-mono font-semibold">
                      {annualUsage.totalAllocatedPeriods}/{annualUsage.limit}
                    </span>{' '}
                    leave period(s) in {calendarYear} — bypassed automatically.
                  </p>
                )}
                {hasOverCapacityDate && (
                  <p>
                    • One or more selected dates will exceed the standard {maxDailyCap}-slot daily cap — allowed for Manager-added leave (normal staff remain blocked).
                  </p>
                )}
              </div>
            )}

          {/* Overlapping Leave Warning + Confirmation */}
          {hasOverlap && (
            <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800/80 space-y-2.5 text-amber-950 dark:text-amber-100">
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <p className="font-semibold">
                    Overlapping Leave Detected for {selectedStaff?.fullName} ({selectedStaff?.staffId})
                  </p>
                  <p className="text-[11px] leading-relaxed">
                    Existing Pending or Approved leave already covers:{' '}
                    <span className="font-mono font-semibold">
                      {overlappingInfo.overlappingDates.map(formatDisplayDate).join(', ')}
                    </span>
                    .
                  </p>
                  <ul className="text-[11px] space-y-0.5 font-mono text-amber-900 dark:text-amber-200">
                    {overlappingInfo.requests.map((r) => (
                      <li key={r.requestId}>
                        • {r.status.toUpperCase()}: {formatDisplayDate(r.startDate)} –{' '}
                        {formatDisplayDate(r.endDate)} ({r.daysCount}d)
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <label className="flex items-start gap-2 pt-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmOverlap}
                  onChange={(e) => setConfirmOverlap(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-amber-400 text-teal-600 focus:ring-teal-500"
                />
                <span className="text-xs font-semibold">
                  Confirm adding this overlapping approved leave anyway
                </span>
              </label>
            </div>
          )}

          {/* Daily Capacity Preview */}
          {capacityPreview.length > 0 && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="px-3.5 py-2 bg-slate-50 dark:bg-[#07111E] border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  Daily Capacity Preview ({capacityPreview.length} day
                  {capacityPreview.length === 1 ? '' : 's'})
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {selectedStaff
                    ? selectedStaff.countsTowardDailyCap
                      ? 'Assistant Officer / Attendant (+1 slot/day)'
                      : `${selectedStaff.designation} (Exempt from 10-slot cap)`
                    : `Standard combined cap: ${maxDailyCap}/day`}
                </span>
              </div>

              <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                {capacityPreview.map((d) => (
                  <div
                    key={d.dateKey}
                    className="px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px]"
                  >
                    <div>
                      <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                        {formatDisplayDate(d.dateKey)}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400 ml-2 font-mono">
                        ({d.approvedOnlyCount} approved · {d.pendingCount} pending)
                      </span>
                    </div>

                    <div className="flex items-center gap-2 font-mono tabular-nums">
                      <span
                        className={`font-semibold ${
                          d.occupiedCount >= d.maxCapacity
                            ? 'text-red-700 dark:text-red-400'
                            : 'text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {d.occupiedCount}/{d.maxCapacity}
                      </span>
                      {selectedStaff && (
                        <>
                          <span className="text-slate-400">→</span>
                          {selectedStaff.countsTowardDailyCap ? (
                            <span
                              className={`px-1.5 py-0.5 rounded font-bold ${
                                d.willExceedCap
                                  ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/70 dark:text-amber-200'
                                  : d.projectedOccupied >= d.maxCapacity
                                    ? 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300'
                                    : 'bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300'
                              }`}
                            >
                              {d.projectedOccupied}/{d.maxCapacity}
                              {d.willExceedCap ? ' Over Cap' : ''}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-200 font-semibold">
                              Exempt
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {submitError && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{submitError}</span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                submitting ||
                !selectedStaff ||
                Boolean(expandedRange.error) ||
                (hasOverlap && !confirmOverlap)
              }
              className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold disabled:opacity-45 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <CalendarPlus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{submitting ? 'Adding Leave...' : 'Add Approved Leave'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
