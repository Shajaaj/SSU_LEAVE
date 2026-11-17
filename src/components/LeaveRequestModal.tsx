import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Calendar, CheckCircle2, X } from 'lucide-react';
import {
  AppSettings,
  DailyCapacity,
  LeaveRequest,
  LeaveType,
  StaffProfile,
} from '../types/portal';
import {
  calculateAnnualPeriodUsage,
  validateLeaveSubmission,
} from '../utils/leaveRules';
import { formatDisplayDate, getTodayInMaldives } from '../utils/maldivesDate';

interface LeaveRequestModalProps {
  open: boolean;
  onClose: () => void;
  staff: StaffProfile;
  userRequests: LeaveRequest[];
  capacityMap: Record<string, DailyCapacity>;
  pendingDemandMap: Record<string, number>;
  settings: AppSettings;
  initialStartDate?: string;
  initialEndDate?: string;
  onSubmit: (payload: {
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    dates: string[];
    reason: string;
  }) => Promise<void>;
}

export const LeaveRequestModal: React.FC<LeaveRequestModalProps> = ({
  open,
  onClose,
  staff,
  userRequests,
  capacityMap,
  pendingDemandMap,
  settings,
  initialStartDate,
  initialEndDate,
  onSubmit,
}) => {
  const today = getTodayInMaldives();
  const leaveType: LeaveType = 'Annual Leave';
  const [startDate, setStartDate] = useState(initialStartDate || today);
  const [endDate, setEndDate] = useState(initialEndDate || initialStartDate || today);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const s = initialStartDate || today;
      const e = initialEndDate || s;
      setStartDate(s);
      setEndDate(e);
      setReason('');
      setSubmitError(null);
    }
  }, [open, initialStartDate, initialEndDate, today]);

  const calendarYear = Number((startDate || today).slice(0, 4));
  const annualUsage = useMemo(
    () =>
      calculateAnnualPeriodUsage(
        userRequests,
        staff.staffId,
        calendarYear,
        staff.annualPeriodLimit || settings.maxAnnualLeavePeriods || 3
      ),
    [userRequests, staff.staffId, calendarYear, staff.annualPeriodLimit, settings.maxAnnualLeavePeriods]
  );

  const validation = useMemo(
    () =>
      validateLeaveSubmission({
        staff,
        startDate,
        endDate,
        reason,
        userRequests,
        capacityMap,
        pendingDemandMap,
        settings,
      }),
    [staff, startDate, endDate, reason, userRequests, capacityMap, pendingDemandMap, settings]
  );

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    if (!validation.valid) {
      setSubmitError(validation.errors[0] || 'Please resolve the highlighted policy checks.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        leaveType,
        startDate,
        endDate,
        dates: validation.dates,
        reason: reason.trim(),
      });
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-leave-title"
    >
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-xl w-full p-5 sm:p-6 space-y-5 shadow-xl sm:my-8 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div>
            <h2 id="new-leave-title" className="text-lg font-display font-bold text-[#0B1F3A] dark:text-white">
              New Annual Leave Application
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
              {staff.staffId} · {staff.fullName} · {staff.designation}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Annual Period Quota Summary */}
        <div className="grid grid-cols-3 gap-3 p-3.5 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 text-xs">
          <div>
            <p className="text-slate-500 dark:text-slate-400">Year ({calendarYear})</p>
            <p className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
              {annualUsage.approvedPeriods} approved
            </p>
          </div>
          <div>
            <p className="text-slate-500 dark:text-slate-400">Pending</p>
            <p className="font-mono font-bold text-amber-700 dark:text-amber-400 mt-0.5 tabular-nums">
              {annualUsage.pendingPeriods} pending
            </p>
          </div>
          <div>
            <p className="text-slate-500 dark:text-slate-400">Remaining</p>
            <p
              className={`font-mono font-bold mt-0.5 tabular-nums ${
                annualUsage.remainingPeriods === 0
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-teal-700 dark:text-teal-400'
              }`}
            >
              {annualUsage.remainingPeriods} of {annualUsage.limit}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="leave-start-date"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Start Date (Asia/Male)
              </label>
              <input
                id="leave-start-date"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (e.target.value > endDate) {
                    setEndDate(e.target.value);
                  }
                }}
                className="w-full min-h-[44px] sm:min-h-0 px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                required
              />
            </div>

            <div>
              <label
                htmlFor="leave-end-date"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
              >
                End Date (Asia/Male)
              </label>
              <input
                id="leave-end-date"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full min-h-[44px] sm:min-h-0 px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                required
              />
            </div>
          </div>

          {/* Per-Date Capacity Inspection */}
          {validation.dates.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
                  <span>Date-by-Date Capacity Check ({validation.dates.length} day{validation.dates.length > 1 ? 's' : ''})</span>
                </span>
                {!staff.countsTowardDailyCap && (
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Exempt from 10-slot Assistant/Attendant cap
                  </span>
                )}
              </div>
              <div className="max-h-36 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
                {validation.dates.map((d) => {
                  const used = capacityMap[d]?.approvedCount || 0;
                  const cap = capacityMap[d]?.maxCapacity || settings.maxDailyCombinedCap || 10;
                  const pending = pendingDemandMap[d] || 0;
                  const blocked = staff.countsTowardDailyCap && used >= cap;
                  return (
                    <div
                      key={d}
                      className={`px-3 py-2 flex items-center justify-between text-xs ${
                        blocked ? 'bg-red-50/70 dark:bg-red-950/30' : ''
                      }`}
                    >
                      <span className="font-mono text-slate-800 dark:text-slate-200">
                        {formatDisplayDate(d)}
                      </span>
                      <div className="flex items-center gap-3 font-mono tabular-nums">
                        {pending > 0 && (
                          <span className="text-[11px] text-amber-700 dark:text-amber-400">
                            {pending} pending
                          </span>
                        )}
                        <span
                          className={`font-semibold ${
                            blocked
                              ? 'text-red-700 dark:text-red-400'
                              : 'text-emerald-700 dark:text-emerald-400'
                          }`}
                        >
                          {used}/{cap} approved {blocked ? '(FULL)' : ''}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label
              htmlFor="leave-reason"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Reason / Operational Notes
            </label>
            <textarea
              id="leave-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Provide brief leave details (3–500 characters)..."
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              required
            />
          </div>

          {/* Blocking Validation Errors */}
          {(validation.errors.length > 0 && reason.length > 0) ||
          validation.unavailableDates.length > 0 ||
          annualUsage.remainingPeriods === 0 ||
          submitError ? (
            <div
              role="alert"
              className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-800 dark:text-red-200 space-y-1"
            >
              {submitError && (
                <p className="flex items-start gap-2 font-semibold">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{submitError}</span>
                </p>
              )}
              {validation.errors.map((errMsg, idx) => (
                <p key={idx} className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{errMsg}</span>
                </p>
              ))}
            </div>
          ) : (
            validation.valid && (
              <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>
                  All {validation.dates.length} day{validation.dates.length > 1 ? 's' : ''} verified within capacity. Pending requests do not reserve slots until approved.
                </span>
              </div>
            )
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !validation.valid}
              className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {submitting ? 'Submitting...' : 'Submit Leave Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
