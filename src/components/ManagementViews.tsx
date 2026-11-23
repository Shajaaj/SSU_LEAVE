import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Plus,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  AppSettings,
  DailyCapacity,
  DailyCapacityDetail,
  LeaveRequest,
  StaffProfile,
} from '../types/portal';
import { downloadCsv } from '../utils/csvExport';
import { getLeaveBarStyle } from '../utils/leaveColors';
import {
  calculateAnnualPeriodUsage,
  checkApprovalCapacityFeasibility,
  getDailyCapacityBreakdown,
} from '../utils/leaveRules';
import {
  formatDisplayDate,
  formatTimestampForDisplay,
  getCurrentYearInMaldives,
  getTodayInMaldives,
} from '../utils/maldivesDate';
import { ManagerAddLeaveModal } from './ManagerAddLeaveModal';
import {
  LeaveStatusLabel,
  ManagerAddedLabel,
  StaffStatusLabel,
} from './StatusLabel';

/* -------------------------------------------------------------------------- */
/* 1. Management Approvals & Operational Overview                              */
/* -------------------------------------------------------------------------- */

interface ManagementQueueViewProps {
  currentProfile: StaffProfile;
  profiles: StaffProfile[];
  allRequests: LeaveRequest[];
  capacityMap: Record<string, DailyCapacity>;
  capacityDetailsMap?: Record<string, DailyCapacityDetail>;
  settings: AppSettings;
  onApprove: (requestId: string, comment: string) => Promise<void>;
  onReject: (requestId: string, comment: string) => Promise<void>;
  onProcessModification: (
    requestId: string,
    decision: 'approve_cancel' | 'approve_edit' | 'decline_modification',
    comment: string
  ) => Promise<void>;
  onRemoveApproved?: (requestId: string) => Promise<void>;
  onManagerAddLeave?: (payload: {
    staffId: string;
    startDate: string;
    endDate: string;
    reason: string;
    confirmOverlap: boolean;
  }) => Promise<void>;
}

export const ManagementQueueView: React.FC<ManagementQueueViewProps> = ({
  currentProfile,
  profiles,
  allRequests,
  capacityMap,
  capacityDetailsMap,
  settings,
  onApprove,
  onReject,
  onProcessModification,
  onRemoveApproved,
  onManagerAddLeave,
}) => {
  const today = getTodayInMaldives();
  const maxCap = settings.maxDailyCombinedCap || 10;
  const isManager = currentProfile.role === 'manager';
  const canRemoveApproved =
    (currentProfile.role === 'executive' || currentProfile.role === 'manager') &&
    Boolean(onRemoveApproved);

  const [decisionTarget, setDecisionTarget] = useState<{
    req: LeaveRequest;
    action: 'approve' | 'reject';
  } | null>(null);
  const [comment, setComment] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LeaveRequest | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [queueStatusView, setQueueStatusView] = useState<'approved' | 'cancelled'>('approved');
  const [approvedSearch, setApprovedSearch] = useState('');
  const [addLeaveModalOpen, setAddLeaveModalOpen] = useState(false);

  const activeStaffCount = useMemo(
    () => profiles.filter((p) => p.isActive).length,
    [profiles]
  );

  const pendingRequests = useMemo(
    () =>
      allRequests
        .filter((r) => r.status === 'pending')
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [allRequests]
  );

  const modRequests = useMemo(
    () =>
      allRequests.filter(
        (r) => r.status === 'approved' && r.modificationRequestType !== 'none'
      ),
    [allRequests]
  );

  const onLeaveToday = useMemo(
    () =>
      allRequests.filter(
        (r) => r.status === 'approved' && r.dates.includes(today)
      ),
    [allRequests, today]
  );

  const upcomingApproved = useMemo(
    () =>
      allRequests
        .filter((r) => r.status === 'approved' && r.startDate > today)
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [allRequests, today]
  );

  const approvedRequests = useMemo(
    () =>
      allRequests
        .filter((r) => r.status === 'approved')
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [allRequests]
  );

  const cancelledRequests = useMemo(
    () =>
      allRequests
        .filter((r) => r.status === 'cancelled')
        .sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [allRequests]
  );

  const filteredQueueByStatus = useMemo(() => {
    const base = queueStatusView === 'approved' ? approvedRequests : cancelledRequests;
    const q = approvedSearch.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (r) =>
        r.staffName.toLowerCase().includes(q) ||
        r.staffId.toLowerCase().includes(q) ||
        r.designation.toLowerCase().includes(q) ||
        r.startDate.includes(q) ||
        r.endDate.includes(q)
    );
  }, [queueStatusView, approvedRequests, cancelledRequests, approvedSearch]);

  const todayBreakdown = useMemo(
    () =>
      getDailyCapacityBreakdown({
        dateKey: today,
        capacityMap,
        capacityDetailsMap,
        defaultMaxCap: maxCap,
        pendingReservesCapacity: Boolean(settings.pendingReservesCapacity),
      }),
    [today, capacityMap, capacityDetailsMap, maxCap, settings.pendingReservesCapacity]
  );

  const handleConfirmDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decisionTarget) return;
    setActionError(null);
    setBusyId(decisionTarget.req.requestId);
    try {
      if (decisionTarget.action === 'approve') {
        await onApprove(decisionTarget.req.requestId, comment);
      } else {
        await onReject(
          decisionTarget.req.requestId,
          comment || 'Declined due to operational requirements.'
        );
      }
      setDecisionTarget(null);
      setComment('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmRemoveApproved = async () => {
    if (!removeTarget || !onRemoveApproved) return;
    setRemoveError(null);
    setBusyId(removeTarget.requestId);
    try {
      await onRemoveApproved(removeTarget.requestId);
      setRemoveTarget(null);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {isManager && onManagerAddLeave && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base sm:text-lg font-display font-bold text-[#0B1F3A] dark:text-white">
              Approvals Queue
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Review pending leave requests, manage approved leave, or assign approved leave directly as Manager.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAddLeaveModalOpen(true)}
            className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap shadow-xs"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>Add Leave</span>
          </button>
        </div>
      )}

      {/* Management KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-1">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Total Active Staff
          </p>
          <p className="text-2xl font-display font-bold font-mono tabular-nums text-[#0B1F3A] dark:text-white">
            {activeStaffCount}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {profiles.length} total provisioned accounts
          </p>
        </div>

        <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-1">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Pending Queue
          </p>
          <p className="text-2xl font-display font-bold font-mono tabular-nums text-amber-700 dark:text-amber-400">
            {pendingRequests.length}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            +{modRequests.length} approved modification request{modRequests.length === 1 ? '' : 's'}
          </p>
        </div>

        <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-1">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            On Approved Leave Today
          </p>
          <p className="text-2xl font-display font-bold font-mono tabular-nums text-[#0B1F3A] dark:text-white">
            {onLeaveToday.length}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
            {formatDisplayDate(today)} (MVT)
          </p>
        </div>

        <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-1">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Daily Leave Capacity Today
          </p>
          <p className="text-2xl font-display font-bold font-mono tabular-nums text-teal-700 dark:text-teal-400">
            {todayBreakdown.occupiedCount} / {todayBreakdown.maxCapacity}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {todayBreakdown.occupiedCount > todayBreakdown.maxCapacity
              ? `${todayBreakdown.occupiedCount - todayBreakdown.maxCapacity} over cap (${todayBreakdown.approvedOnlyCount} approved · ${todayBreakdown.pendingCount} pending)`
              : `${todayBreakdown.availableSlots} left (${todayBreakdown.approvedOnlyCount} approved · ${todayBreakdown.pendingCount} pending)`}
          </p>
        </div>
      </section>

      {/* Pending Leave Applications Queue */}
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
              Pending Leave Applications
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Pending applications reserve slots upon submission. Approving keeps occupancy unchanged (no double-counting); rejecting releases slots immediately.
            </p>
          </div>
          <span className="text-xs font-mono font-semibold text-slate-600 dark:text-slate-300 tabular-nums">
            {pendingRequests.length} pending
          </span>
        </div>

        {pendingRequests.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
            All pending leave applications have been processed.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {pendingRequests.map((req) => {
              const feasibility = checkApprovalCapacityFeasibility(
                req,
                capacityMap,
                maxCap,
                capacityDetailsMap,
                Boolean(settings.pendingReservesCapacity),
                settings.maxExecutiveDailyCap || 1
              );
              const barStyle = getLeaveBarStyle(req.designation, req.status);
              return (
                <div
                  key={req.requestId}
                  className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="flex items-stretch gap-3 min-w-0">
                    <span
                      className={`w-1.5 rounded-full border shrink-0 ${barStyle.barClass}`}
                      aria-hidden="true"
                    />
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-sm text-slate-900 dark:text-white">
                          {req.staffName}
                        </span>
                        <span className="font-mono text-slate-500 dark:text-slate-400">
                          · {req.staffId} · {req.designation}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded-[2px] text-[10px] font-semibold ${barStyle.badgeClass}`}
                        >
                          Pending
                        </span>
                        {Boolean(req.editedAt) && (
                          <span
                            title={`Dates edited: ${formatTimestampForDisplay(req.editedAt)}`}
                            className="inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800/70 whitespace-nowrap"
                          >
                            Edited
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-700 dark:text-slate-300 font-mono">
                        {req.leaveType} · {formatDisplayDate(req.startDate)} –{' '}
                        {formatDisplayDate(req.endDate)} ({req.daysCount} day
                        {req.daysCount > 1 ? 's' : ''})
                      </p>
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        {req.reason}
                      </p>
                      {Boolean(req.editedAt) && (
                        <p className="text-[11px] font-mono text-sky-700 dark:text-sky-400">
                          Dates edited: {formatTimestampForDisplay(req.editedAt)}
                        </p>
                      )}

                      {!feasibility.feasible && (
                        <p className="text-xs font-semibold text-red-700 dark:text-red-400 flex items-start gap-1.5 pt-0.5">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                          <span>
                            Blocked by daily cap on:{' '}
                            {feasibility.fullDates
                              .map((f) => `${formatDisplayDate(f.date)} (${f.approvedCount}/${f.maxCapacity})`)
                              .join(', ')}
                          </span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                    <button
                      type="button"
                      disabled={busyId === req.requestId || !feasibility.feasible}
                      onClick={() => {
                        setDecisionTarget({ req, action: 'approve' });
                        setComment('');
                        setActionError(null);
                      }}
                      className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Approve</span>
                    </button>
                    <button
                      type="button"
                      disabled={busyId === req.requestId}
                      onClick={() => {
                        setDecisionTarget({ req, action: 'reject' });
                        setComment('');
                        setActionError(null);
                      }}
                      className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-red-300 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Reject</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Modification Requests on Approved Leave */}
      {modRequests.length > 0 && (
        <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
          <div className="border-b border-slate-100 dark:border-slate-800 pb-3">
            <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
              Approved Leave Modification & Cancellation Requests
            </h2>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {modRequests.map((req) => (
              <div
                key={req.requestId}
                className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="space-y-1 text-xs">
                  <p className="font-semibold text-sm text-slate-900 dark:text-white">
                    {req.staffName}{' '}
                    <span className="font-mono text-slate-500 dark:text-slate-400 font-normal">
                      · {req.staffId}
                    </span>
                  </p>
                  <p className="font-mono text-slate-600 dark:text-slate-300">
                    Current approved: {formatDisplayDate(req.startDate)} – {formatDisplayDate(req.endDate)}
                    {req.modificationRequestType === 'edit' && req.requestedStartDate
                      ? ` -> Requested: ${formatDisplayDate(req.requestedStartDate)} – ${formatDisplayDate(req.requestedEndDate || req.requestedStartDate)}`
                      : ' -> Requested full cancellation'}
                  </p>
                  <p className="text-slate-500 dark:text-slate-400">
                    Note: {req.modificationNote}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0 w-full sm:w-auto">
                  <button
                    type="button"
                    disabled={busyId === req.requestId}
                    onClick={async () => {
                      setBusyId(req.requestId);
                      try {
                        await onProcessModification(
                          req.requestId,
                          req.modificationRequestType === 'cancel'
                            ? 'approve_cancel'
                            : 'approve_edit',
                          'Processed by management.'
                        );
                      } finally {
                        setBusyId(null);
                      }
                    }}
                    className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold flex items-center justify-center whitespace-nowrap"
                  >
                    {req.modificationRequestType === 'cancel'
                      ? 'Approve Cancellation'
                      : 'Approve New Dates'}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === req.requestId}
                    onClick={async () => {
                      setBusyId(req.requestId);
                      try {
                        await onProcessModification(
                          req.requestId,
                          'decline_modification',
                          'Original approved leave retained.'
                        );
                      } finally {
                        setBusyId(null);
                      }
                    }}
                    className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center whitespace-nowrap"
                  >
                    Decline Change
                  </button>
                  {canRemoveApproved && req.status === 'approved' && (
                    <button
                      type="button"
                      disabled={busyId === req.requestId}
                      onClick={() => {
                        setRemoveError(null);
                        setRemoveTarget(req);
                      }}
                      className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-xs font-semibold disabled:opacity-40 flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Remove Leave</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Approved & Cancelled Leave Applications Queue */}
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
              {queueStatusView === 'approved'
                ? 'Approved Leave Applications'
                : 'Cancelled Leave Applications'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {queueStatusView === 'approved'
                ? 'Active approved leave periods. Removing an approved leave marks it Cancelled and immediately releases occupied daily slots.'
                : 'Removed or cancelled leave applications retained in history without occupying daily slots or annual leave periods.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#07111E] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setQueueStatusView('approved')}
                className={`px-3 py-1.5 rounded-md font-semibold transition-colors whitespace-nowrap ${
                  queueStatusView === 'approved'
                    ? 'bg-white dark:bg-[#0D1B2A] text-[#0B1F3A] dark:text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Approved ({approvedRequests.length})
              </button>
              <button
                type="button"
                onClick={() => setQueueStatusView('cancelled')}
                className={`px-3 py-1.5 rounded-md font-semibold transition-colors whitespace-nowrap ${
                  queueStatusView === 'cancelled'
                    ? 'bg-white dark:bg-[#0D1B2A] text-[#0B1F3A] dark:text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Cancelled ({cancelledRequests.length})
              </button>
            </div>
          </div>
        </div>

        <div className="relative max-w-sm">
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="text"
            value={approvedSearch}
            onChange={(e) => setApprovedSearch(e.target.value)}
            placeholder="Search by Staff ID, name, or date..."
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-sm text-slate-900 dark:text-slate-100"
          />
        </div>

        {filteredQueueByStatus.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
            {queueStatusView === 'approved'
              ? 'No approved leave applications match the current view.'
              : 'No cancelled leave applications match the current view.'}
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {filteredQueueByStatus.map((req) => {
              const barStyle = getLeaveBarStyle(req.designation, req.status);
              return (
                <div
                  key={req.requestId}
                  className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="flex items-stretch gap-3 min-w-0">
                    <span
                      className={`w-1.5 rounded-full border shrink-0 ${barStyle.barClass}`}
                      aria-hidden="true"
                    />
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-sm text-slate-900 dark:text-white">
                          {req.staffName}
                        </span>
                        <span className="font-mono text-slate-500 dark:text-slate-400">
                          · {req.staffId} · {req.designation}
                        </span>
                        <LeaveStatusLabel status={req.status} />
                        {req.addedByManager && (
                          <ManagerAddedLabel
                            addedByName={req.addedByName}
                            addedByStaffId={req.addedByStaffId}
                          />
                        )}
                      </div>
                      <p className="text-xs text-slate-700 dark:text-slate-300 font-mono">
                        {req.leaveType} · {formatDisplayDate(req.startDate)} –{' '}
                        {formatDisplayDate(req.endDate)} ({req.daysCount} day
                        {req.daysCount > 1 ? 's' : ''})
                      </p>
                      {req.reason && (
                        <p className="text-xs text-slate-600 dark:text-slate-400">
                          {req.reason}
                        </p>
                      )}
                      {req.addedByManager && (req.addedByName || req.addedByStaffId) && (
                        <p className="text-[11px] text-teal-700 dark:text-teal-400">
                          Added by Manager: {req.addedByName || req.addedByStaffId}
                          {req.addedByStaffId && req.addedByName ? ` (${req.addedByStaffId})` : ''}
                          {req.addedAt ? ` · ${formatTimestampForDisplay(req.addedAt)}` : ''}
                        </p>
                      )}
                      {req.reviewComment && (
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          {req.reviewComment}
                          {req.reviewedByName ? ` (${req.reviewedByName})` : ''}
                        </p>
                      )}
                    </div>
                  </div>

                  {canRemoveApproved && req.status === 'approved' && (
                    <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                      <button
                        type="button"
                        disabled={busyId === req.requestId}
                        onClick={() => {
                          setRemoveError(null);
                          setRemoveTarget(req);
                        }}
                        className="flex-1 sm:flex-initial min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-red-300 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-xs font-semibold disabled:opacity-40 flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Remove Leave</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Currently On Leave & Upcoming Approved Leave */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-3">
          <h3 className="text-sm font-display font-bold text-[#0B1F3A] dark:text-white">
            Staff Currently on Approved Leave ({onLeaveToday.length})
          </h3>
          {onLeaveToday.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-3">
              No staff are on approved leave today.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {onLeaveToday.map((r) => {
                const barStyle = getLeaveBarStyle(r.designation, r.status);
                return (
                  <div
                    key={r.requestId}
                    className="py-2.5 flex flex-wrap sm:flex-nowrap items-center justify-between text-xs gap-2"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={`w-1.5 h-7 rounded-full border shrink-0 ${barStyle.barClass}`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                            {r.staffName} <span className="font-mono text-slate-500">· {r.staffId}</span>
                          </p>
                          {r.addedByManager && (
                            <ManagerAddedLabel
                              addedByName={r.addedByName}
                              addedByStaffId={r.addedByStaffId}
                            />
                          )}
                        </div>
                        <p className="text-slate-500 dark:text-slate-400">
                          {r.designation} · {r.leaveType}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-auto">
                      <span className="font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        Until {formatDisplayDate(r.endDate)}
                      </span>
                      {canRemoveApproved && r.status === 'approved' && (
                        <button
                          type="button"
                          disabled={busyId === r.requestId}
                          onClick={() => {
                            setRemoveError(null);
                            setRemoveTarget(r);
                          }}
                          className="min-h-[36px] sm:min-h-0 px-2.5 py-1 rounded-lg border border-red-300 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-[11px] font-semibold disabled:opacity-40 flex items-center gap-1 whitespace-nowrap"
                        >
                          <Trash2 className="w-3 h-3" aria-hidden="true" />
                          <span>Remove Leave</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-3">
          <h3 className="text-sm font-display font-bold text-[#0B1F3A] dark:text-white">
            Upcoming Approved Leave ({upcomingApproved.length})
          </h3>
          {upcomingApproved.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-3">
              No upcoming approved leave periods scheduled.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {upcomingApproved.slice(0, 8).map((r) => {
                const barStyle = getLeaveBarStyle(r.designation, r.status);
                return (
                  <div
                    key={r.requestId}
                    className="py-2.5 flex flex-wrap sm:flex-nowrap items-center justify-between text-xs gap-2"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={`w-1.5 h-7 rounded-full border shrink-0 ${barStyle.barClass}`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                            {r.staffName} <span className="font-mono text-slate-500">· {r.staffId}</span>
                          </p>
                          {r.addedByManager && (
                            <ManagerAddedLabel
                              addedByName={r.addedByName}
                              addedByStaffId={r.addedByStaffId}
                            />
                          )}
                        </div>
                        <p className="text-slate-500 dark:text-slate-400">
                          {r.designation} · {r.leaveType}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-auto">
                      <span className="font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {formatDisplayDate(r.startDate)} – {formatDisplayDate(r.endDate)}
                      </span>
                      {canRemoveApproved && r.status === 'approved' && (
                        <button
                          type="button"
                          disabled={busyId === r.requestId}
                          onClick={() => {
                            setRemoveError(null);
                            setRemoveTarget(r);
                          }}
                          className="min-h-[36px] sm:min-h-0 px-2.5 py-1 rounded-lg border border-red-300 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-[11px] font-semibold disabled:opacity-40 flex items-center gap-1 whitespace-nowrap"
                        >
                          <Trash2 className="w-3 h-3" aria-hidden="true" />
                          <span>Remove Leave</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Decision Confirmation Modal */}
      {decisionTarget && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
            <h3 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
              {decisionTarget.action === 'approve'
                ? 'Confirm Atomic Leave Approval'
                : 'Reject Leave Application'}
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              <strong className="text-slate-900 dark:text-white">
                {decisionTarget.req.staffName} ({decisionTarget.req.staffId})
              </strong>{' '}
              · {decisionTarget.req.leaveType} ·{' '}
              <span className="font-mono">
                {formatDisplayDate(decisionTarget.req.startDate)} –{' '}
                {formatDisplayDate(decisionTarget.req.endDate)}
              </span>
            </p>

            {actionError && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300">
                {actionError}
              </div>
            )}

            <form onSubmit={handleConfirmDecision} className="space-y-3">
              <div>
                <label
                  htmlFor="decision-comment"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                >
                  {decisionTarget.action === 'approve'
                    ? 'Approval Notes (Optional)'
                    : 'Rejection Reason (Required)'}
                </label>
                <textarea
                  id="decision-comment"
                  rows={3}
                  maxLength={500}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  required={decisionTarget.action === 'reject'}
                  placeholder={
                    decisionTarget.action === 'approve'
                      ? 'Optional operational note...'
                      : 'Provide reason for declining this request...'
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDecisionTarget(null)}
                  className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyId === decisionTarget.req.requestId}
                  className={`min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg text-white whitespace-nowrap ${
                    decisionTarget.action === 'approve'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-red-600 hover:bg-red-700'
                  }`}
                >
                  {busyId === decisionTarget.req.requestId
                    ? 'Processing...'
                    : decisionTarget.action === 'approve'
                      ? 'Confirm Approval'
                      : 'Confirm Rejection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Remove Approved Leave Confirmation Popup */}
      {removeTarget && canRemoveApproved && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-approved-leave-title"
        >
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/60 flex items-center justify-center text-red-600 dark:text-red-400 shrink-0">
                <Trash2 className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h3
                  id="remove-approved-leave-title"
                  className="text-base font-display font-bold text-[#0B1F3A] dark:text-white"
                >
                  Remove Approved Leave
                </h3>
                <p className="text-xs font-medium text-red-700 dark:text-red-400">
                  Are you sure you want to remove this approved leave?
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#07111E] p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Staff Name</span>
                <span className="font-semibold text-slate-900 dark:text-white text-right">
                  {removeTarget.staffName}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Staff ID</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-white">
                  {removeTarget.staffId}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Leave Start Date</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-white">
                  {formatDisplayDate(removeTarget.startDate)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Leave End Date</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-white">
                  {formatDisplayDate(removeTarget.endDate)}
                </span>
              </div>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Confirming removal will change this application status from Approved to{' '}
              <strong className="text-slate-800 dark:text-slate-200">Cancelled</strong>,
              immediately release all occupied daily leave slots for those dates, and retain the record in leave history under Cancelled.
            </p>

            {removeError && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300">
                {removeError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={busyId === removeTarget.requestId}
                onClick={() => {
                  setRemoveTarget(null);
                  setRemoveError(null);
                }}
                className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyId === removeTarget.requestId}
                onClick={handleConfirmRemoveApproved}
                className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 whitespace-nowrap"
              >
                {busyId === removeTarget.requestId ? 'Removing...' : 'Confirm Removal'}
              </button>
            </div>
          </div>
        </div>
      )}
      {isManager && onManagerAddLeave && (
        <ManagerAddLeaveModal
          open={addLeaveModalOpen}
          onClose={() => setAddLeaveModalOpen(false)}
          profiles={profiles}
          allRequests={allRequests}
          capacityMap={capacityMap}
          capacityDetailsMap={capacityDetailsMap}
          settings={settings}
          onSubmit={onManagerAddLeave}
        />
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 2. Searchable Staff Directory                                              */
/* -------------------------------------------------------------------------- */

export const StaffDirectoryView: React.FC<{
  profiles: StaffProfile[];
  allRequests: LeaveRequest[];
}> = ({ profiles, allRequests }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'staff' | 'executive' | 'manager'>('all');
  const currentYear = getCurrentYearInMaldives();

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return profiles.filter((p) => {
      if (roleFilter !== 'all' && p.role !== roleFilter) return false;
      if (!q) return true;
      return (
        p.staffId.toLowerCase().includes(q) ||
        p.fullName.toLowerCase().includes(q) ||
        p.designation.toLowerCase().includes(q) ||
        p.unitSection.toLowerCase().includes(q)
      );
    });
  }, [profiles, searchQuery, roleFilter]);

  return (
    <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base sm:text-lg font-display font-bold text-[#0B1F3A] dark:text-white">
            Staff Directory
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Operational directory without exposed PII. Leave period balances shown for {currentYear}.
          </p>
        </div>
        <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
          {filtered.length} of {profiles.length} staff
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by Staff ID, name, designation, or section..."
            className="w-full min-h-[42px] sm:min-h-0 pl-9 pr-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg w-full sm:w-auto overflow-x-auto">
          {(['all', 'staff', 'executive', 'manager'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRoleFilter(r)}
              className={`min-h-[40px] sm:min-h-0 px-3 py-1.5 text-xs font-semibold rounded-md capitalize whitespace-nowrap ${
                roleFilter === r
                  ? 'bg-white dark:bg-[#162B45] text-[#0B1F3A] dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile Staff Directory Cards */}
      <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
        {filtered.map((p) => {
          const usage = calculateAnnualPeriodUsage(
            allRequests,
            p.staffId,
            currentYear,
            p.annualPeriodLimit
          );
          return (
            <div key={p.staffId} className="py-3.5 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {p.fullName}
                  </p>
                  <p className="text-xs font-mono text-[#0B1F3A] dark:text-teal-300 font-semibold">
                    {p.staffId}
                  </p>
                </div>
                <StaffStatusLabel isActive={p.isActive} />
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                {p.designation} · {p.unitSection} ·{' '}
                <span className="capitalize">{p.role}</span>
              </p>
              <p className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                {currentYear} Periods: {usage.approvedPeriods} approved / {usage.limit} ({usage.pendingPeriods} pending)
              </p>
            </div>
          );
        })}
      </div>

      {/* Desktop Staff Directory Table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
              <th className="py-2.5 pr-4 font-semibold">Staff ID</th>
              <th className="py-2.5 pr-4 font-semibold">Full Name</th>
              <th className="py-2.5 pr-4 font-semibold">Designation</th>
              <th className="py-2.5 pr-4 font-semibold">Section</th>
              <th className="py-2.5 pr-4 font-semibold">Role</th>
              <th className="py-2.5 pr-4 font-semibold text-right">Periods Used ({currentYear})</th>
              <th className="py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((p) => {
              const usage = calculateAnnualPeriodUsage(
                allRequests,
                p.staffId,
                currentYear,
                p.annualPeriodLimit
              );
              return (
                <tr key={p.staffId} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                  <td className="py-3 pr-4 font-mono font-semibold text-[#0B1F3A] dark:text-teal-300 whitespace-nowrap">
                    {p.staffId}
                  </td>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {p.fullName}
                  </td>
                  <td className="py-3 pr-4 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {p.designation}
                  </td>
                  <td className="py-3 pr-4 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {p.unitSection}
                  </td>
                  <td className="py-3 pr-4 capitalize text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {p.role}
                  </td>
                  <td className="py-3 pr-4 text-right font-mono tabular-nums whitespace-nowrap">
                    {usage.approvedPeriods} approved / {usage.limit} ({usage.pendingPeriods} pending)
                  </td>
                  <td className="py-3 whitespace-nowrap">
                    <StaffStatusLabel isActive={p.isActive} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 3. Monthly & Annual Reporting + CSV Export                                 */
/* -------------------------------------------------------------------------- */

export const ReportsView: React.FC<{
  allRequests: LeaveRequest[];
  profiles: StaffProfile[];
}> = ({ allRequests }) => {
  const currentYear = getCurrentYearInMaldives();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [selectedMonth, setSelectedMonth] = useState<string>('all'); // 'all' or '01'..'12'

  const filteredRequests = useMemo(() => {
    return allRequests.filter((r) => {
      if (r.calendarYear !== selectedYear) return false;
      if (selectedMonth !== 'all') {
        const prefix = `${selectedYear}-${selectedMonth}`;
        return r.dates.some((d) => d.startsWith(prefix));
      }
      return true;
    });
  }, [allRequests, selectedYear, selectedMonth]);

  const metrics = useMemo(() => {
    const approved = filteredRequests.filter((r) => r.status === 'approved');
    const pending = filteredRequests.filter((r) => r.status === 'pending');
    const rejected = filteredRequests.filter((r) => r.status === 'rejected');
    const cancelled = filteredRequests.filter((r) => r.status === 'cancelled');
    const totalApprovedDays = approved.reduce((acc, r) => acc + r.daysCount, 0);
    return {
      total: filteredRequests.length,
      approved: approved.length,
      pending: pending.length,
      rejected: rejected.length,
      cancelled: cancelled.length,
      totalApprovedDays,
    };
  }, [filteredRequests]);

  const handleExportCsv = () => {
    const scopeLabel =
      selectedMonth === 'all'
        ? `${selectedYear}-annual`
        : `${selectedYear}-${selectedMonth}`;
    downloadCsv(
      `ssu-leave-report-${scopeLabel}.csv`,
      [
        'Request ID',
        'Staff ID',
        'Staff Name',
        'Designation',
        'Counts Toward 10/Day Cap',
        'Leave Type',
        'Start Date (MVT)',
        'End Date (MVT)',
        'Days',
        'Status',
        'Source',
        'Reviewed By',
        'Review Comment',
        'Reason',
      ],
      filteredRequests.map((r) => [
        r.requestId,
        r.staffId,
        r.staffName,
        r.designation,
        r.countsTowardDailyCap ? 'Yes' : 'No',
        r.leaveType,
        r.startDate,
        r.endDate,
        r.daysCount,
        r.status,
        r.addedByManager ? 'Manager Added' : 'Staff Submitted',
        r.reviewedByName || '',
        r.reviewComment || '',
        r.reason,
      ])
    );
  };

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base sm:text-lg font-display font-bold text-[#0B1F3A] dark:text-white">
              Monthly & Annual Leave Reports
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Filter by Maldives calendar year or month and export operational leave records as CSV.
            </p>
          </div>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredRequests.length === 0}
            className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-[#0B1F3A] dark:bg-teal-600 hover:bg-[#14325B] dark:hover:bg-teal-700 text-white text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-45 whitespace-nowrap"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Export CSV</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label htmlFor="report-year" className="sr-only">
              Calendar Year
            </label>
            <select
              id="report-year"
              value={selectedYear}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              className="min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono font-semibold"
            >
              {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 sm:flex-initial">
            <label htmlFor="report-month" className="sr-only">
              Month
            </label>
            <select
              id="report-month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="w-full sm:w-auto min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-semibold"
            >
              <option value="all">Full Year (Annual Report)</option>
              {[
                ['01', 'January'],
                ['02', 'February'],
                ['03', 'March'],
                ['04', 'April'],
                ['05', 'May'],
                ['06', 'June'],
                ['07', 'July'],
                ['08', 'August'],
                ['09', 'September'],
                ['10', 'October'],
                ['11', 'November'],
                ['12', 'December'],
              ].map(([val, label]) => (
                <option key={val} value={val}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2">
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Applications</p>
            <p className="text-lg font-mono font-bold tabular-nums">{metrics.total}</p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Approved</p>
            <p className="text-lg font-mono font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
              {metrics.approved}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Approved Leave Days</p>
            <p className="text-lg font-mono font-bold tabular-nums">{metrics.totalApprovedDays}</p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Pending</p>
            <p className="text-lg font-mono font-bold tabular-nums text-amber-700 dark:text-amber-400">
              {metrics.pending}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Rejected / Cancelled</p>
            <p className="text-lg font-mono font-bold tabular-nums">
              {metrics.rejected + metrics.cancelled}
            </p>
          </div>
        </div>
      </div>

      {/* Approval History Table */}
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-3">
        <h3 className="text-sm font-display font-bold text-[#0B1F3A] dark:text-white">
          Leave Application & Approval History
        </h3>
        {filteredRequests.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
            No leave applications match the selected year and month.
          </p>
        ) : (
          <>
            {/* Mobile Leave History Cards */}
            <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
              {filteredRequests.map((r) => (
                <div key={r.requestId} className="py-3.5 space-y-1.5 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {r.staffName}
                      </p>
                      <p className="font-mono text-slate-500 dark:text-slate-400">
                        {r.staffId} · {r.leaveType}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 justify-end shrink-0">
                      <LeaveStatusLabel status={r.status} />
                      {r.addedByManager && (
                        <ManagerAddedLabel
                          addedByName={r.addedByName}
                          addedByStaffId={r.addedByStaffId}
                        />
                      )}
                    </div>
                  </div>
                  <p className="font-mono text-slate-700 dark:text-slate-200">
                    {formatDisplayDate(r.startDate)} – {formatDisplayDate(r.endDate)} ({r.daysCount}d)
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Reviewer: {r.reviewedByName || '—'} · Updated {formatTimestampForDisplay(r.updatedAt)}
                  </p>
                </div>
              ))}
            </div>

            {/* Desktop Leave History Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                    <th className="py-2.5 pr-4 font-semibold">Staff</th>
                    <th className="py-2.5 pr-4 font-semibold">Type</th>
                    <th className="py-2.5 pr-4 font-semibold">Dates (MVT)</th>
                    <th className="py-2.5 pr-4 font-semibold text-right">Days</th>
                    <th className="py-2.5 pr-4 font-semibold">Status</th>
                    <th className="py-2.5 pr-4 font-semibold">Reviewer</th>
                    <th className="py-2.5 font-semibold">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredRequests.map((r) => (
                    <tr key={r.requestId} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                      <td className="py-3 pr-4 whitespace-nowrap">
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          {r.staffName}
                        </span>{' '}
                        <span className="font-mono text-slate-500">· {r.staffId}</span>
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap">{r.leaveType}</td>
                      <td className="py-3 pr-4 font-mono whitespace-nowrap">
                        {r.startDate} – {r.endDate}
                      </td>
                      <td className="py-3 pr-4 text-right font-mono tabular-nums whitespace-nowrap">
                        {r.daysCount}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <LeaveStatusLabel status={r.status} />
                          {r.addedByManager && (
                            <ManagerAddedLabel
                              addedByName={r.addedByName}
                              addedByStaffId={r.addedByStaffId}
                            />
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {r.reviewedByName || '—'}
                      </td>
                      <td className="py-3 font-mono text-slate-500 whitespace-nowrap">
                        {formatTimestampForDisplay(r.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
