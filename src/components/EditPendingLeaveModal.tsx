import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Calendar, CheckCircle2, X } from 'lucide-react';
import {
  AppSettings,
  DailyCapacity,
  DailyCapacityDetail,
  LeaveRequest,
  LeaveRestriction,
  StaffProfile,
} from '../types/portal';
import {
  RestrictedLeaveError,
  fetchCapacityForDates,
  loadActiveRestrictionsStrict,
} from '../services/firebasePortalService';
import { findRestrictedDatesForStaff } from '../utils/leaveRestrictions';
import {
  getDailyCapacityBreakdown,
  validateLeaveSubmission,
} from '../utils/leaveRules';
import { expandDateRange, formatDisplayDate } from '../utils/maldivesDate';
import { LeaveRestrictedPopup } from './LeaveRestrictedPopup';
import { LeaveStatusLabel } from './StatusLabel';

interface EditPendingLeaveModalProps {
  open: boolean;
  onClose: () => void;
  staff: StaffProfile;
  targetRequest: LeaveRequest | null;
  liveRequest: LeaveRequest | null;
  userRequests: LeaveRequest[];
  capacityMap: Record<string, DailyCapacity>;
  capacityDetailsMap?: Record<string, DailyCapacityDetail>;
  pendingDemandMap: Record<string, number>;
  settings: AppSettings;
  restrictions?: LeaveRestriction[];
  onRefreshRestrictions?: () => Promise<LeaveRestriction[]>;
  onSave: (
    req: LeaveRequest,
    payload: { startDate: string; endDate: string }
  ) => Promise<void>;
}

const ALREADY_REVIEWED_MESSAGE =
  'This leave application has already been reviewed and can no longer be edited.';

export const EditPendingLeaveModal: React.FC<EditPendingLeaveModalProps> = ({
  open,
  onClose,
  staff,
  targetRequest,
  liveRequest,
  userRequests,
  capacityMap,
  capacityDetailsMap,
  pendingDemandMap,
  settings,
  restrictions = [],
  onRefreshRestrictions,
  onSave,
}) => {
  const activeRecord = liveRequest || targetRequest;

  const [newStartDate, setNewStartDate] = useState('');
  const [newEndDate, setNewEndDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dismissedPopupSig, setDismissedPopupSig] = useState<string | null>(null);
  const [runtimeBlocked, setRuntimeBlocked] = useState<{
    blockedDates: string[];
    matchedRestrictions: LeaveRestriction[];
  } | null>(null);
  const [extraCapMap, setExtraCapMap] = useState<Record<string, DailyCapacity>>({});
  const [extraDetailsMap, setExtraDetailsMap] = useState<
    Record<string, DailyCapacityDetail>
  >({});

  useEffect(() => {
    if (open && targetRequest) {
      setNewStartDate(targetRequest.startDate);
      setNewEndDate(targetRequest.endDate);
      setSaving(false);
      setSaveError(null);
      setDismissedPopupSig(null);
      setRuntimeBlocked(null);
      setExtraCapMap({});
      setExtraDetailsMap({});
    }
  }, [open, targetRequest]);

  const alreadyReviewed = Boolean(activeRecord && activeRecord.status !== 'pending');

  const expandedPreviewDates = useMemo(() => {
    if (!open || !newStartDate || !newEndDate) return [];
    const exp = expandDateRange(newStartDate, newEndDate, 30);
    return exp.error ? [] : exp.dates;
  }, [open, newStartDate, newEndDate]);

  useEffect(() => {
    if (!open || expandedPreviewDates.length === 0) return;
    const missing = expandedPreviewDates.filter(
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
  }, [open, expandedPreviewDates, capacityMap, extraCapMap]);

  const mergedCapacityMap = useMemo(
    () => ({ ...extraCapMap, ...capacityMap }),
    [extraCapMap, capacityMap]
  );

  const mergedDetailsMap = useMemo(
    () => ({ ...extraDetailsMap, ...(capacityDetailsMap || {}) }),
    [extraDetailsMap, capacityDetailsMap]
  );

  const validation = useMemo(() => {
    if (!targetRequest) {
      return {
        valid: false,
        dates: [] as string[],
        errors: [] as string[],
        unavailableDates: [],
        pendingOverlapDates: [],
        blockedDates: [] as string[],
        matchedRestrictions: [] as LeaveRestriction[],
      };
    }
    const effectiveReason =
      targetRequest.reason && targetRequest.reason.trim().length >= 3
        ? targetRequest.reason
        : 'Annual Leave';

    return validateLeaveSubmission({
      staff,
      startDate: newStartDate,
      endDate: newEndDate,
      reason: effectiveReason,
      userRequests,
      capacityMap: mergedCapacityMap,
      pendingDemandMap,
      capacityDetailsMap: mergedDetailsMap,
      settings,
      restrictions,
      excludeRequestId: targetRequest.requestId,
    });
  }, [
    targetRequest,
    staff,
    newStartDate,
    newEndDate,
    userRequests,
    mergedCapacityMap,
    pendingDemandMap,
    mergedDetailsMap,
    settings,
    restrictions,
  ]);

  const activeBlockedDates =
    runtimeBlocked && runtimeBlocked.blockedDates.length > 0
      ? runtimeBlocked.blockedDates
      : validation.blockedDates;

  const activeMatchedRestrictions =
    runtimeBlocked && runtimeBlocked.matchedRestrictions.length > 0
      ? runtimeBlocked.matchedRestrictions
      : validation.matchedRestrictions;

  const blockedSig =
    activeMatchedRestrictions.length > 0
      ? `${newStartDate}_${newEndDate}_${activeMatchedRestrictions
          .map((r) => r.restrictionId)
          .join(',')}`
      : null;

  const showRestrictedPopup = Boolean(
    open && !alreadyReviewed && blockedSig && blockedSig !== dismissedPopupSig
  );

  const blockedDatesSet = useMemo(
    () => new Set(activeBlockedDates),
    [activeBlockedDates]
  );

  const oldDatesSet = useMemo(
    () => new Set(targetRequest?.dates || []),
    [targetRequest]
  );

  const slotChangeSummary = useMemo(() => {
    const newSet = new Set(validation.dates);
    const released = (targetRequest?.dates || []).filter((d) => !newSet.has(d));
    const kept = validation.dates.filter((d) => oldDatesSet.has(d));
    const added = validation.dates.filter((d) => !oldDatesSet.has(d));
    return { released, kept, added };
  }, [targetRequest, validation.dates, oldDatesSet]);

  if (!open || !targetRequest) return null;

  const isOwner = activeRecord?.staffId === staff.staffId;
  const datesUnchanged =
    newStartDate === targetRequest.startDate && newEndDate === targetRequest.endDate;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setRuntimeBlocked(null);

    if (alreadyReviewed) {
      setSaveError(ALREADY_REVIEWED_MESSAGE);
      return;
    }

    if (!isOwner) {
      setSaveError('You can only edit your own pending leave applications.');
      return;
    }

    if (datesUnchanged) {
      setSaveError('Please select different start or end dates before saving changes.');
      return;
    }

    if (validation.matchedRestrictions.length > 0) {
      setDismissedPopupSig(null);
      setSaveError(
        validation.errors[validation.errors.length - 1] ||
          'You are not permitted to apply for leave during the selected dates.'
      );
      return;
    }

    if (!validation.valid) {
      setSaveError(validation.errors[0] || 'Please resolve the highlighted policy checks.');
      return;
    }

    setSaving(true);
    try {
      const freshRestrictions = onRefreshRestrictions
        ? await onRefreshRestrictions()
        : await loadActiveRestrictionsStrict();
      const freshCheck = findRestrictedDatesForStaff(
        validation.dates,
        freshRestrictions,
        staff
      );
      if (freshCheck.matchedRestrictions.length > 0) {
        setRuntimeBlocked(freshCheck);
        setDismissedPopupSig(null);
        const primary = freshCheck.matchedRestrictions[0];
        setSaveError(
          `You are not permitted to apply for leave during the selected dates. Reason: ${primary.reason}. Please select alternative dates.`
        );
        return;
      }

      await onSave(targetRequest, {
        startDate: newStartDate,
        endDate: newEndDate,
      });
      onClose();
    } catch (err) {
      if (err instanceof RestrictedLeaveError) {
        setRuntimeBlocked({
          blockedDates: err.blockedDates,
          matchedRestrictions: err.matchedRestrictions,
        });
        setDismissedPopupSig(null);
      }
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-pending-title"
    >
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-lg w-full p-5 sm:p-6 space-y-4 shadow-xl sm:my-8 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-3.5">
          <div>
            <h3
              id="edit-pending-title"
              className="text-base sm:text-lg font-display font-bold text-[#0B1F3A] dark:text-white"
            >
              Edit Leave Dates
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
              {staff.staffId} · {targetRequest.leaveType}
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

        {/* Current Submitted Dates */}
        <div className="grid grid-cols-2 gap-3 p-3.5 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 text-xs">
          <div>
            <p className="text-slate-500 dark:text-slate-400">Current Start Date</p>
            <p className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
              {formatDisplayDate(targetRequest.startDate)}
            </p>
          </div>
          <div>
            <p className="text-slate-500 dark:text-slate-400">Current End Date</p>
            <p className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
              {formatDisplayDate(targetRequest.endDate)}
            </p>
          </div>
        </div>

        {/* Live Review Protection Banner */}
        {alreadyReviewed && activeRecord && (
          <div
            role="alert"
            className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-800 dark:text-red-200 space-y-2"
          >
            <div className="flex items-start gap-2 font-semibold">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{ALREADY_REVIEWED_MESSAGE}</span>
            </div>
            <div className="flex items-center gap-2 pl-6">
              <span className="text-slate-600 dark:text-slate-300">Latest status:</span>
              <LeaveStatusLabel status={activeRecord.status} />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label
                htmlFor="edit-pending-start"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
              >
                New Start Date
              </label>
              <input
                id="edit-pending-start"
                type="date"
                value={newStartDate}
                disabled={alreadyReviewed || saving}
                onChange={(e) => {
                  setNewStartDate(e.target.value);
                  setRuntimeBlocked(null);
                  setSaveError(null);
                  if (e.target.value > newEndDate) {
                    setNewEndDate(e.target.value);
                  }
                }}
                className="w-full min-h-[44px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-60"
                required
              />
            </div>

            <div>
              <label
                htmlFor="edit-pending-end"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
              >
                New End Date
              </label>
              <input
                id="edit-pending-end"
                type="date"
                value={newEndDate}
                min={newStartDate}
                disabled={alreadyReviewed || saving}
                onChange={(e) => {
                  setNewEndDate(e.target.value);
                  setRuntimeBlocked(null);
                  setSaveError(null);
                }}
                className="w-full min-h-[44px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-60"
                required
              />
            </div>
          </div>

          {/* Automatic Total Leave Days & Slot Change Preview */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Total Leave Days
            </span>
            <span className="font-mono font-bold text-[#0B1F3A] dark:text-teal-300 tabular-nums">
              {validation.dates.length} day{validation.dates.length === 1 ? '' : 's'}
            </span>
          </div>

          {/* Date-by-date capacity breakdown */}
          {validation.dates.length > 0 && !alreadyReviewed && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
                  <span>Daily Slot Check</span>
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                  {slotChangeSummary.kept.length} kept · {slotChangeSummary.added.length} new ·{' '}
                  {slotChangeSummary.released.length} released
                </span>
              </div>
              <div className="max-h-36 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
                {validation.dates.map((d) => {
                  const breakdown = getDailyCapacityBreakdown({
                    dateKey: d,
                    capacityMap: mergedCapacityMap,
                    pendingDemandMap,
                    capacityDetailsMap: mergedDetailsMap,
                    defaultMaxCap: settings.maxDailyCombinedCap || 10,
                    pendingReservesCapacity: Boolean(settings.pendingReservesCapacity),
                  });
                  const alreadyReserved = oldDatesSet.has(d);
                  const isCapFull =
                    staff.countsTowardDailyCap && breakdown.isFull && !alreadyReserved;
                  const isRestricted = blockedDatesSet.has(d);
                  const blocked = isCapFull || isRestricted;
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
                      <div className="flex items-center gap-2.5 font-mono tabular-nums">
                        {alreadyReserved && (
                          <span className="text-[11px] font-semibold text-teal-700 dark:text-teal-400">
                            Reserved
                          </span>
                        )}
                        {isRestricted && (
                          <span className="text-[11px] font-semibold text-red-700 dark:text-red-400">
                            Restricted
                          </span>
                        )}
                        <span
                          className={`font-semibold ${
                            isCapFull
                              ? 'text-red-700 dark:text-red-400'
                              : 'text-emerald-700 dark:text-emerald-400'
                          }`}
                        >
                          {breakdown.occupiedCount}/{breakdown.maxCapacity} occupied{' '}
                          {isCapFull ? '(FULL)' : ''}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Validation & Error Messages */}
          {!alreadyReviewed &&
          (validation.errors.length > 0 || activeBlockedDates.length > 0 || saveError) ? (
            <div
              role="alert"
              className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-800 dark:text-red-200 space-y-1"
            >
              {saveError && (
                <p className="flex items-start gap-2 font-semibold">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{saveError}</span>
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
            !alreadyReviewed &&
            validation.valid &&
            !datesUnchanged && (
              <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>
                  Updated dates verified. Saving updates this pending application and adjusts daily slots automatically.
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
              disabled={
                alreadyReviewed ||
                saving ||
                !isOwner ||
                datesUnchanged ||
                !validation.valid ||
                activeMatchedRestrictions.length > 0
              }
              className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {saving ? 'Saving Changes...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>

      <LeaveRestrictedPopup
        open={showRestrictedPopup}
        blockedDates={activeBlockedDates}
        matchedRestrictions={activeMatchedRestrictions}
        onClose={() => setDismissedPopupSig(blockedSig)}
      />
    </div>
  );
};
