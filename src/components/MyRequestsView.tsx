import React, { useMemo, useState } from 'react';
import { AlertCircle, CalendarClock, Edit3, Plus, XCircle } from 'lucide-react';
import {
  AppSettings,
  DailyCapacity,
  DailyCapacityDetail,
  LeaveRequest,
  LeaveRestriction,
  LeaveStatus,
  StaffProfile,
} from '../types/portal';
import {
  expandDateRange,
  formatDisplayDate,
  formatTimestampForDisplay,
} from '../utils/maldivesDate';
import { findRestrictedDatesForStaff, formatLongDate } from '../utils/leaveRestrictions';
import { EditPendingLeaveModal } from './EditPendingLeaveModal';
import { LeaveRestrictedPopup } from './LeaveRestrictedPopup';
import { LeaveStatusLabel, ManagerAddedLabel } from './StatusLabel';

interface MyRequestsViewProps {
  profile: StaffProfile;
  requests: LeaveRequest[];
  allRequests?: LeaveRequest[];
  restrictions?: LeaveRestriction[];
  capacityMap?: Record<string, DailyCapacity>;
  capacityDetailsMap?: Record<string, DailyCapacityDetail>;
  pendingDemandMap?: Record<string, number>;
  settings?: AppSettings;
  loading: boolean;
  onOpenNewRequest: () => void;
  onRefreshRestrictions?: () => Promise<LeaveRestriction[]>;
  onEditPending: (
    req: LeaveRequest,
    payload: { startDate: string; endDate: string }
  ) => Promise<void>;
  onCancelPending: (req: LeaveRequest) => Promise<void>;
  onRequestModification: (params: {
    req: LeaveRequest;
    type: 'edit' | 'cancel';
    note: string;
    requestedStartDate?: string;
    requestedEndDate?: string;
  }) => Promise<void>;
}

export const MyRequestsView: React.FC<MyRequestsViewProps> = ({
  profile,
  requests,
  allRequests,
  restrictions = [],
  capacityMap = {},
  capacityDetailsMap = {},
  pendingDemandMap = {},
  settings = {
    maxDailyCombinedCap: 10,
    maxExecutiveDailyCap: 1,
    maxAnnualLeavePeriods: 3,
    pendingReservesCapacity: true,
    timezone: 'Asia/Male',
    unitName: 'Special Services Unit',
    airportName: 'Velana International Airport',
    updatedByStaffId: 'SYSTEM',
  },
  loading,
  onOpenNewRequest,
  onRefreshRestrictions,
  onEditPending,
  onCancelPending,
  onRequestModification,
}) => {
  const [filterStatus, setFilterStatus] = useState<'all' | LeaveStatus>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Edit Pending Leave Modal State
  const [editTarget, setEditTarget] = useState<LeaveRequest | null>(null);

  // Modification Modal State for Approved Leave
  const [modTarget, setModTarget] = useState<LeaveRequest | null>(null);
  const [modType, setModType] = useState<'edit' | 'cancel'>('edit');
  const [modNote, setModNote] = useState('');
  const [modStart, setModStart] = useState('');
  const [modEnd, setModEnd] = useState('');
  const [modError, setModError] = useState<string | null>(null);
  const [dismissedModPopupSig, setDismissedModPopupSig] = useState<string | null>(null);

  const liveEditTarget = useMemo(() => {
    if (!editTarget) return null;
    return requests.find((r) => r.requestId === editTarget.requestId) || null;
  }, [editTarget, requests]);

  const filtered = useMemo(() => {
    if (filterStatus === 'all') return requests;
    return requests.filter((r) => r.status === filterStatus);
  }, [requests, filterStatus]);

  const modRestrictionCheck = useMemo(() => {
    if (!modTarget || modType !== 'edit' || !modStart || !modEnd || modStart > modEnd) {
      return { blockedDates: [], matchedRestrictions: [] };
    }
    const exp = expandDateRange(modStart, modEnd, 30);
    if (exp.error) return { blockedDates: [], matchedRestrictions: [] };
    return findRestrictedDatesForStaff(exp.dates, restrictions, profile);
  }, [modTarget, modType, modStart, modEnd, restrictions, profile]);

  const modBlockedSig =
    modRestrictionCheck.matchedRestrictions.length > 0
      ? `${modStart}_${modEnd}_${modRestrictionCheck.matchedRestrictions
          .map((r) => r.restrictionId)
          .join(',')}`
      : null;

  const showModRestrictedPopup = Boolean(
    modTarget && modType === 'edit' && modBlockedSig && modBlockedSig !== dismissedModPopupSig
  );

  const openModModal = (req: LeaveRequest, type: 'edit' | 'cancel') => {
    setModTarget(req);
    setModType(type);
    setModStart(req.startDate);
    setModEnd(req.endDate);
    setModNote('');
    setModError(null);
    setDismissedModPopupSig(null);
  };

  const handleSubmitMod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modTarget) return;
    setModError(null);
    if (modNote.trim().length < 3) {
      setModError('Please provide an explanation for your modification/cancellation request.');
      return;
    }
    if (modType === 'edit' && (!modStart || !modEnd || modStart > modEnd)) {
      setModError('Provide a valid date range where end date is on or after start date.');
      return;
    }
    if (modType === 'edit' && modRestrictionCheck.matchedRestrictions.length > 0) {
      setDismissedModPopupSig(null);
      const primary = modRestrictionCheck.matchedRestrictions[0];
      setModError(
        `Leave applications are not permitted from ${formatLongDate(primary.startDate)} to ${formatLongDate(primary.endDate)}. Reason: ${primary.reason}. Please select alternative dates.`
      );
      return;
    }

    setBusyId(modTarget.requestId);
    try {
      await onRequestModification({
        req: modTarget,
        type: modType,
        note: modNote.trim(),
        requestedStartDate: modType === 'edit' ? modStart : undefined,
        requestedEndDate: modType === 'edit' ? modEnd : undefined,
      });
      setModTarget(null);
    } catch (err) {
      setModError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base sm:text-lg font-display font-bold text-[#0B1F3A] dark:text-white">
              Personal Leave History
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Approved leave records are locked against unauthorized edits; submit a modification request for Executive or Manager review.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenNewRequest}
            className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>New Request</span>
          </button>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg w-full sm:w-fit overflow-x-auto">
          {(['all', 'pending', 'approved', 'rejected', 'cancelled'] as const).map(
            (tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilterStatus(tab)}
                className={`min-h-[40px] sm:min-h-0 px-3 py-1.5 text-xs font-semibold rounded-md capitalize transition-colors whitespace-nowrap ${
                  filterStatus === tab
                    ? 'bg-white dark:bg-[#162B45] text-[#0B1F3A] dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {tab}
              </button>
            )
          )}
        </div>

        {loading ? (
          <div className="space-y-2 py-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center space-y-2 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
            <CalendarClock className="w-7 h-7 mx-auto text-slate-400" aria-hidden="true" />
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              No {filterStatus === 'all' ? '' : filterStatus} leave applications
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Submit a new leave application to view it tracked here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((req) => (
              <div
                key={req.requestId}
                className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <LeaveStatusLabel status={req.status} />
                    {Boolean(req.editedAt) && (
                      <span
                        title={`Dates edited: ${formatTimestampForDisplay(req.editedAt)}`}
                        className="inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800/70 whitespace-nowrap"
                      >
                        Edited
                      </span>
                    )}
                    {req.addedByManager && (
                      <ManagerAddedLabel
                        addedByName={req.addedByName}
                        addedByStaffId={req.addedByStaffId}
                      />
                    )}
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">
                      {req.leaveType}
                    </span>
                    <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                      {formatDisplayDate(req.startDate)} – {formatDisplayDate(req.endDate)} ({req.daysCount}d)
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {req.reason}
                  </p>
                  {req.addedByManager && (req.addedByName || req.addedByStaffId) && (
                    <p className="text-[11px] text-teal-700 dark:text-teal-400">
                      Added by Manager: {req.addedByName || req.addedByStaffId}
                      {req.addedByStaffId && req.addedByName ? ` (${req.addedByStaffId})` : ''}
                    </p>
                  )}
                  {req.reviewComment && (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Reviewer ({req.reviewedByName || 'Management'}): {req.reviewComment}
                    </p>
                  )}
                  {req.modificationRequestType !== 'none' && (
                    <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      Modification pending ({req.modificationRequestType}
                      {req.requestedStartDate
                        ? `: ${req.requestedStartDate} – ${req.requestedEndDate}`
                        : ''}
                      ): {req.modificationNote}
                    </p>
                  )}
                  <p className="text-[11px] font-mono text-slate-400">
                    Submitted: {formatTimestampForDisplay(req.createdAt)}
                    {req.editedAt ? ` · Edited: ${formatTimestampForDisplay(req.editedAt)}` : ''}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0 w-full sm:w-auto">
                  {req.status === 'pending' && req.staffId === profile.staffId && (
                    <>
                      <button
                        type="button"
                        disabled={busyId === req.requestId}
                        onClick={() => {
                          setEditTarget(req);
                          if (onRefreshRestrictions) {
                            void onRefreshRestrictions().catch(() => undefined);
                          }
                        }}
                        className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Edit Dates</span>
                      </button>
                      <button
                        type="button"
                        disabled={busyId === req.requestId}
                        onClick={async () => {
                          setBusyId(req.requestId);
                          try {
                            await onCancelPending(req);
                          } finally {
                            setBusyId(null);
                          }
                        }}
                        className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/60 text-xs font-semibold text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Cancel Request</span>
                      </button>
                    </>
                  )}

                  {req.status === 'approved' && req.modificationRequestType === 'none' && (
                    <>
                      <button
                        type="button"
                        onClick={() => openModModal(req, 'edit')}
                        className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Request Date Change</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openModModal(req, 'cancel')}
                        className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-900/60 text-xs font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 flex items-center justify-center whitespace-nowrap"
                      >
                        Request Cancellation
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Approved Leave Modification Request Modal */}
      {modTarget && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mod-dialog-title"
        >
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
            <h3 id="mod-dialog-title" className="text-base font-display font-bold">
              {modType === 'cancel'
                ? 'Request Cancellation of Approved Leave'
                : 'Request Date Change on Approved Leave'}
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Original approved period:{' '}
              <span className="font-mono font-semibold text-slate-900 dark:text-white">
                {formatDisplayDate(modTarget.startDate)} – {formatDisplayDate(modTarget.endDate)}
              </span>
              . Approved leave remains active until an Executive or Manager processes your request.
            </p>

            {modError && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300 flex items-start gap-2 whitespace-pre-line">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{modError}</span>
              </div>
            )}

            <form onSubmit={handleSubmitMod} className="space-y-3">
              {modType === 'edit' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="mod-start"
                      className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                    >
                      New Start Date
                    </label>
                    <input
                      id="mod-start"
                      type="date"
                      value={modStart}
                      onChange={(e) => {
                        setModStart(e.target.value);
                        if (e.target.value > modEnd) setModEnd(e.target.value);
                      }}
                      className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
                      required
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="mod-end"
                      className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                    >
                      New End Date
                    </label>
                    <input
                      id="mod-end"
                      type="date"
                      value={modEnd}
                      min={modStart}
                      onChange={(e) => setModEnd(e.target.value)}
                      className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
                      required
                    />
                  </div>
                </div>
              )}

              <div>
                <label
                  htmlFor="mod-note"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                >
                  Explanation for Management
                </label>
                <textarea
                  id="mod-note"
                  rows={3}
                  maxLength={500}
                  value={modNote}
                  onChange={(e) => setModNote(e.target.value)}
                  placeholder="Reason for requested edit or cancellation..."
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModTarget(null)}
                  className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyId === modTarget.requestId}
                  className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg bg-[#0B1F3A] dark:bg-teal-600 text-white disabled:opacity-60 whitespace-nowrap"
                >
                  {busyId === modTarget.requestId ? 'Submitting...' : 'Submit Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <EditPendingLeaveModal
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        staff={profile}
        targetRequest={editTarget}
        liveRequest={liveEditTarget}
        userRequests={requests}
        allRequests={allRequests}
        capacityMap={capacityMap}
        capacityDetailsMap={capacityDetailsMap}
        pendingDemandMap={pendingDemandMap}
        settings={settings}
        restrictions={restrictions}
        onRefreshRestrictions={onRefreshRestrictions}
        onSave={onEditPending}
      />

      <LeaveRestrictedPopup
        open={showModRestrictedPopup}
        blockedDates={modRestrictionCheck.blockedDates}
        matchedRestrictions={modRestrictionCheck.matchedRestrictions}
        onClose={() => setDismissedModPopupSig(modBlockedSig)}
      />
    </div>
  );
};
