import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarOff,
  Check,
  DatabaseZap,
  Download,
  Edit3,
  KeyRound,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Terminal,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  AppSettings,
  AuditLog,
  Designation,
  LeaveRestriction,
  RestrictionTargetType,
  StaffProfile,
  UserRole,
} from '../types/portal';
import { downloadCsv } from '../utils/csvExport';
import {
  RESTRICTION_TARGET_OPTIONS,
  formatRestrictionRangeShort,
  formatRestrictionTargetLabel,
} from '../utils/leaveRestrictions';
import { formatTimestampForDisplay, getTodayInMaldives } from '../utils/maldivesDate';
import { isValidStaffIdFormat, normalizeStaffIdToken } from '../utils/staffAuthId';
import { StaffStatusLabel } from './StatusLabel';

/* -------------------------------------------------------------------------- */
/* 1. Administration View (Manager Only)                                      */
/* -------------------------------------------------------------------------- */

interface AdministrationViewProps {
  currentProfile: StaffProfile;
  profiles: StaffProfile[];
  settings: AppSettings;
  restrictions?: LeaveRestriction[];
  onAddStaff?: (payload: {
    staffId: string;
    fullName: string;
    designation: Designation;
    role: UserRole;
  }) => Promise<void>;
  onUpdateStaff: (
    target: StaffProfile,
    updates: {
      fullName: string;
      designation: Designation;
      role: UserRole;
      isActive: boolean;
      unitSection: string;
      annualPeriodLimit: number;
    }
  ) => Promise<void>;
  onRemoveStaff: (target: StaffProfile) => Promise<void>;
  onResetStaffPin?: (target: StaffProfile, tempPin: string) => Promise<void>;
  onUpdateSettings: (next: {
    maxDailyCombinedCap: number;
    maxAnnualLeavePeriods: number;
  }) => Promise<void>;
  onSaveRestriction?: (payload: {
    restrictionId?: string;
    startDate: string;
    endDate: string;
    targetType: RestrictionTargetType;
    targetStaffIds: string[];
    reason: string;
    isActive: boolean;
  }) => Promise<void>;
  onDeleteRestriction?: (restrictionId: string) => Promise<void>;
}

export const AdministrationView: React.FC<AdministrationViewProps> = ({
  currentProfile,
  profiles,
  settings,
  restrictions = [],
  onAddStaff,
  onUpdateStaff,
  onRemoveStaff,
  onResetStaffPin,
  onUpdateSettings,
  onSaveRestriction,
  onDeleteRestriction,
}) => {
  // Add Staff Modal
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newStaffId, setNewStaffId] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newDesignation, setNewDesignation] =
    useState<Designation>('ASSISTANT OFFICER');
  const [newRole, setNewRole] = useState<UserRole>('staff');
  const [addingStaff, setAddingStaff] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit Staff Modal
  const [editingTarget, setEditingTarget] = useState<StaffProfile | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesignation, setEditDesignation] =
    useState<Designation>('ASSISTANT OFFICER');
  const [editRole, setEditRole] = useState<UserRole>('staff');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editSection, setEditSection] = useState('');
  const [editLimit, setEditLimit] = useState(3);
  const [savingEdit, setSavingEdit] = useState(false);

  // Admin PIN Reset Modal
  const [resetTarget, setResetTarget] = useState<StaffProfile | null>(null);
  const [resetTempPin, setResetTempPin] = useState('');
  const [resettingPin, setResettingPin] = useState(false);
  const [resetPinError, setResetPinError] = useState<string | null>(null);

  // Remove Staff Confirmation Modal
  const [removeTarget, setRemoveTarget] = useState<StaffProfile | null>(null);
  const [removingStaff, setRemovingStaff] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Settings State
  const [maxDailyCap, setMaxDailyCap] = useState(settings.maxDailyCombinedCap || 10);
  const [maxAnnualPeriods, setMaxAnnualPeriods] = useState(
    settings.maxAnnualLeavePeriods || 3
  );
  const [savingSettings, setSavingSettings] = useState(false);

  // Leave Date Restrictions State
  const todayMaldives = getTodayInMaldives();
  const [editingRestrictionId, setEditingRestrictionId] = useState<string | null>(null);
  const [rstStartDate, setRstStartDate] = useState(todayMaldives);
  const [rstEndDate, setRstEndDate] = useState(todayMaldives);
  const [rstTargetType, setRstTargetType] = useState<RestrictionTargetType>('all');
  const [rstSelectedStaffIds, setRstSelectedStaffIds] = useState<string[]>([]);
  const [rstStaffSearch, setRstStaffSearch] = useState('');
  const [rstReason, setRstReason] = useState('');
  const [rstIsActive, setRstIsActive] = useState(true);
  const [rstError, setRstError] = useState<string | null>(null);
  const [savingRestriction, setSavingRestriction] = useState(false);
  const [togglingRestrictionId, setTogglingRestrictionId] = useState<string | null>(null);
  const [deleteRestrictionTarget, setDeleteRestrictionTarget] =
    useState<LeaveRestriction | null>(null);
  const [deletingRestriction, setDeletingRestriction] = useState(false);

  const filteredStaffForRestriction = useMemo(() => {
    const q = rstStaffSearch.trim().toLowerCase();
    return profiles.filter((p) => {
      if (!q) return true;
      return (
        p.staffId.toLowerCase().includes(q) ||
        p.fullName.toLowerCase().includes(q) ||
        p.designation.toLowerCase().includes(q)
      );
    });
  }, [profiles, rstStaffSearch]);

  const resetRestrictionForm = () => {
    setEditingRestrictionId(null);
    setRstStartDate(todayMaldives);
    setRstEndDate(todayMaldives);
    setRstTargetType('all');
    setRstSelectedStaffIds([]);
    setRstStaffSearch('');
    setRstReason('');
    setRstIsActive(true);
    setRstError(null);
  };

  const startEditingRestriction = (r: LeaveRestriction) => {
    setEditingRestrictionId(r.restrictionId);
    setRstStartDate(r.startDate);
    setRstEndDate(r.endDate);
    setRstTargetType(r.targetType);
    const canonicalSelected = (r.targetStaffIds || []).map((rawId) => {
      const tok = normalizeStaffIdToken(rawId);
      const found = profiles.find((p) => normalizeStaffIdToken(p.staffId) === tok);
      return found ? found.staffId : rawId;
    });
    setRstSelectedStaffIds(Array.from(new Set(canonicalSelected)));
    setRstStaffSearch('');
    setRstReason(r.reason);
    setRstIsActive(r.isActive);
    setRstError(null);
  };

  const toggleStaffSelection = (staffId: string) => {
    const targetToken = normalizeStaffIdToken(staffId);
    const canonicalProfile = profiles.find(
      (p) => normalizeStaffIdToken(p.staffId) === targetToken
    );
    const canonicalId = canonicalProfile ? canonicalProfile.staffId : staffId.trim();
    setRstSelectedStaffIds((prev) => {
      const exists = prev.some((id) => normalizeStaffIdToken(id) === targetToken);
      if (exists) {
        return prev.filter((id) => normalizeStaffIdToken(id) !== targetToken);
      }
      return [...prev, canonicalId];
    });
  };

  const handleSubmitRestriction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSaveRestriction) return;
    setRstError(null);

    if (!rstStartDate || !rstEndDate) {
      setRstError('Please select both Start Date and End Date.');
      return;
    }
    if (rstEndDate < rstStartDate) {
      setRstError('End Date must be on or after Start Date.');
      return;
    }
    if (rstTargetType === 'selected_staff' && rstSelectedStaffIds.length === 0) {
      setRstError('Please select at least one staff member.');
      return;
    }
    const trimmedReason = rstReason.trim();
    if (trimmedReason.length < 3 || trimmedReason.length > 300) {
      setRstError('Reason for blocking must be between 3 and 300 characters.');
      return;
    }

    setSavingRestriction(true);
    try {
      await onSaveRestriction({
        ...(editingRestrictionId ? { restrictionId: editingRestrictionId } : {}),
        startDate: rstStartDate,
        endDate: rstEndDate,
        targetType: rstTargetType,
        targetStaffIds: rstTargetType === 'selected_staff' ? rstSelectedStaffIds : [],
        reason: trimmedReason,
        isActive: rstIsActive,
      });
      resetRestrictionForm();
    } catch (err) {
      setRstError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRestriction(false);
    }
  };

  const openAddModal = () => {
    setNewStaffId('');
    setNewFullName('');
    setNewDesignation('ASSISTANT OFFICER');
    setNewRole('staff');
    setAddError(null);
    setAddModalOpen(true);
  };

  const handleSaveNewStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onAddStaff) return;

    setAddError(null);
    const trimmedStaffId = newStaffId.trim();
    const trimmedFullName = newFullName.trim();

    if (!isValidStaffIdFormat(trimmedStaffId)) {
      setAddError('Staff ID must be 2 to 24 letters, numbers, or hyphens.');
      return;
    }
    if (trimmedFullName.length < 2 || trimmedFullName.length > 100) {
      setAddError('Full Name must be between 2 and 100 characters.');
      return;
    }

    const normalizedCandidate = normalizeStaffIdToken(trimmedStaffId);
    const duplicate = profiles.find(
      (p) => normalizeStaffIdToken(p.staffId) === normalizedCandidate
    );
    if (duplicate) {
      setAddError(
        `Staff ID ${duplicate.staffId} already exists (${duplicate.fullName}). Duplicate Staff IDs are not allowed.`
      );
      return;
    }

    setAddingStaff(true);
    try {
      await onAddStaff({
        staffId: trimmedStaffId,
        fullName: trimmedFullName,
        designation: newDesignation,
        role: newRole,
      });
      setAddModalOpen(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingStaff(false);
    }
  };

  const openEditModal = (p: StaffProfile) => {
    setEditingTarget(p);
    setEditName(p.fullName);
    setEditDesignation(p.designation);
    setEditRole(p.role);
    setEditIsActive(p.isActive);
    setEditSection(p.unitSection);
    setEditLimit(p.annualPeriodLimit);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTarget) return;
    setSavingEdit(true);
    try {
      await onUpdateStaff(editingTarget, {
        fullName: editName,
        designation: editDesignation,
        role: editRole,
        isActive: editIsActive,
        unitSection: editSection,
        annualPeriodLimit: editLimit,
      });
      setEditingTarget(null);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    try {
      await onUpdateSettings({
        maxDailyCombinedCap: Math.min(10, Math.max(1, maxDailyCap)),
        maxAnnualLeavePeriods: Math.min(10, Math.max(1, maxAnnualPeriods)),
      });
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Account Management & Role Assignment */}
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
              Account Roles, Deactivation &amp; Removal
            </h2>
            <span className="text-xs font-mono text-slate-500 dark:text-slate-400 shrink-0">
              {profiles.length} records
            </span>
          </div>
          {currentProfile.role === 'manager' && onAddStaff && (
            <button
              type="button"
              onClick={openAddModal}
              className="min-h-[40px] sm:min-h-0 px-3.5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shadow-xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Add Staff</span>
            </button>
          )}
        </div>

        {/* Mobile Account Cards */}
        <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
          {profiles.map((p) => (
            <div key={p.staffId} className="py-3.5 space-y-2.5">
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
                {p.designation} · <span className="capitalize font-semibold">{p.role}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => openEditModal(p)}
                  className="flex-1 min-w-[120px] min-h-[44px] px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold"
                >
                  Edit Role / Status
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResetTarget(p);
                    setResetTempPin('');
                    setResetPinError(null);
                  }}
                  className="flex-1 min-w-[120px] min-h-[44px] px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-1.5"
                >
                  <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Reset PIN</span>
                </button>
                <button
                  type="button"
                  disabled={p.staffId === currentProfile.staffId}
                  onClick={() => {
                    setRemoveTarget(p);
                    setRemoveError(null);
                  }}
                  title={
                    p.staffId === currentProfile.staffId
                      ? 'You cannot remove your own currently signed-in account'
                      : `Remove ${p.fullName}`
                  }
                  className="w-full sm:w-auto min-h-[44px] px-3 py-2 rounded-lg border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold inline-flex items-center justify-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Remove</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop Account Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-2.5 pr-4 font-semibold">Staff ID</th>
                <th className="py-2.5 pr-4 font-semibold">Name</th>
                <th className="py-2.5 pr-4 font-semibold">Designation</th>
                <th className="py-2.5 pr-4 font-semibold">Role</th>
                <th className="py-2.5 pr-4 font-semibold">Status</th>
                <th className="py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {profiles.map((p) => (
                <tr key={p.staffId} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                  <td className="py-3 pr-4 font-mono font-semibold whitespace-nowrap">
                    {p.staffId}
                  </td>
                  <td className="py-3 pr-4 font-semibold whitespace-nowrap">{p.fullName}</td>
                  <td className="py-3 pr-4 whitespace-nowrap">{p.designation}</td>
                  <td className="py-3 pr-4 capitalize whitespace-nowrap">{p.role}</td>
                  <td className="py-3 pr-4 whitespace-nowrap">
                    <StaffStatusLabel isActive={p.isActive} />
                  </td>
                  <td className="py-3 text-right whitespace-nowrap space-x-2">
                    <button
                      type="button"
                      onClick={() => openEditModal(p)}
                      className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold"
                    >
                      Edit Role / Status
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setResetTarget(p);
                        setResetTempPin('');
                        setResetPinError(null);
                      }}
                      className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold inline-flex items-center gap-1"
                    >
                      <KeyRound className="w-3 h-3" aria-hidden="true" />
                      <span>Reset PIN</span>
                    </button>
                    <button
                      type="button"
                      disabled={p.staffId === currentProfile.staffId}
                      onClick={() => {
                        setRemoveTarget(p);
                        setRemoveError(null);
                      }}
                      title={
                        p.staffId === currentProfile.staffId
                          ? 'You cannot remove your own currently signed-in account'
                          : `Remove ${p.fullName}`
                      }
                      className="px-2.5 py-1.5 rounded-md border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3 h-3" aria-hidden="true" />
                      <span>Remove</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Portal Policy Configuration */}
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
          <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
            Unit Policy Configuration
          </h2>
        </div>
        <form onSubmit={handleSaveSettings} className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
          <div>
            <label htmlFor="cfg-cap" className="block text-xs font-semibold mb-1">
              Daily Combined Cap (Max 10)
            </label>
            <input
              id="cfg-cap"
              type="number"
              min={1}
              max={10}
              value={maxDailyCap}
              onChange={(e) => setMaxDailyCap(Number(e.target.value))}
              className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
            />
          </div>
          <div>
            <label htmlFor="cfg-annual" className="block text-xs font-semibold mb-1">
              Annual Leave Periods Limit
            </label>
            <input
              id="cfg-annual"
              type="number"
              min={1}
              max={10}
              value={maxAnnualPeriods}
              onChange={(e) => setMaxAnnualPeriods(Number(e.target.value))}
              className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
            />
          </div>
          <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Policy: Both Pending and Approved Assistant Officer / Attendant applications reserve daily slots immediately (max 10/day). Rejecting or cancelling releases slots automatically. Timezone fixed to <span className="font-mono">Asia/Male</span>.
            </p>
            <button
              type="submit"
              disabled={savingSettings}
              className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-[#0B1F3A] dark:bg-teal-600 text-white text-xs font-semibold whitespace-nowrap"
            >
              {savingSettings ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </form>
      </section>

      {/* Leave Date Restrictions (Manager Only) */}
      {currentProfile.role === 'manager' && onSaveRestriction && (
        <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
            <div>
              <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white flex items-center gap-2">
                <CalendarOff className="w-4 h-4 text-rose-600 dark:text-rose-400" aria-hidden="true" />
                <span>Leave Date Restrictions</span>
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                Block specific dates or periods for all staff, specific designations, or selected staff members (e.g., peak flight season, public holiday embargoes, VIP operations). Existing applications are never automatically cancelled.
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500 dark:text-slate-400 shrink-0">
              {restrictions.length} restriction{restrictions.length === 1 ? '' : 's'}
            </span>
          </div>

          <form onSubmit={handleSubmitRestriction} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="rst-start" className="block font-semibold mb-1">
                  Start Date
                </label>
                <input
                  id="rst-start"
                  type="date"
                  value={rstStartDate}
                  onChange={(e) => {
                    setRstStartDate(e.target.value);
                    if (e.target.value > rstEndDate) setRstEndDate(e.target.value);
                  }}
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
                  required
                />
              </div>
              <div>
                <label htmlFor="rst-end" className="block font-semibold mb-1">
                  End Date
                </label>
                <input
                  id="rst-end"
                  type="date"
                  value={rstEndDate}
                  min={rstStartDate}
                  onChange={(e) => setRstEndDate(e.target.value)}
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
                  required
                />
              </div>
              <div>
                <label htmlFor="rst-target" className="block font-semibold mb-1">
                  Apply Restriction To
                </label>
                <select
                  id="rst-target"
                  value={rstTargetType}
                  onChange={(e) => setRstTargetType(e.target.value as RestrictionTargetType)}
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                >
                  {RESTRICTION_TARGET_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {rstTargetType === 'selected_staff' && (
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="rst-staff-search" className="font-semibold text-slate-800 dark:text-slate-200">
                    Staff Selection ({rstSelectedStaffIds.length} selected)
                  </label>
                  {rstSelectedStaffIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setRstSelectedStaffIds([])}
                      className="text-[11px] font-semibold text-rose-700 dark:text-rose-400 hover:underline"
                    >
                      Clear selection
                    </button>
                  )}
                </div>

                {rstSelectedStaffIds.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {rstSelectedStaffIds.map((sid) => {
                      const tok = normalizeStaffIdToken(sid);
                      const match = profiles.find(
                        (p) => normalizeStaffIdToken(p.staffId) === tok
                      );
                      return (
                        <span
                          key={sid}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-teal-50 dark:bg-teal-950/60 border border-teal-200 dark:border-teal-800 text-[11px] font-medium text-teal-900 dark:text-teal-200"
                        >
                          <span className="font-mono font-semibold">{sid}</span>
                          {match && <span className="truncate max-w-[140px]">· {match.fullName}</span>}
                          <button
                            type="button"
                            onClick={() => toggleStaffSelection(sid)}
                            aria-label={`Remove ${sid}`}
                            className="p-0.5 hover:text-rose-600"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                <div className="relative">
                  <Search
                    className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    id="rst-staff-search"
                    type="search"
                    value={rstStaffSearch}
                    onChange={(e) => setRstStaffSearch(e.target.value)}
                    placeholder="Search staff by Staff ID or full name..."
                    className="w-full min-h-[40px] sm:min-h-0 pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1B2A] text-base sm:text-xs"
                  />
                </div>

                <div className="max-h-44 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-[#0D1B2A]">
                  {filteredStaffForRestriction.length === 0 ? (
                    <p className="p-3 text-center text-slate-500">No matching staff found.</p>
                  ) : (
                    filteredStaffForRestriction.map((p) => {
                      const pToken = normalizeStaffIdToken(p.staffId);
                      const checked = rstSelectedStaffIds.some(
                        (id) => normalizeStaffIdToken(id) === pToken
                      );
                      return (
                        <label
                          key={p.staffId}
                          className={`px-3 py-2 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                            checked ? 'bg-teal-50/50 dark:bg-teal-950/25' : ''
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleStaffSelection(p.staffId)}
                              className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                            />
                            <span className="font-mono font-semibold text-[#0B1F3A] dark:text-teal-300 shrink-0">
                              {p.staffId}
                            </span>
                            <span className="truncate font-medium text-slate-800 dark:text-slate-100">
                              {p.fullName}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
                            {p.designation}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
              <div className="sm:col-span-3">
                <label htmlFor="rst-reason" className="block font-semibold mb-1">
                  Reason for Blocking
                </label>
                <input
                  id="rst-reason"
                  type="text"
                  maxLength={300}
                  value={rstReason}
                  onChange={(e) => setRstReason(e.target.value)}
                  placeholder="e.g. Peak flight season, Public holiday embargo, VIP operations..."
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  required
                />
              </div>

              <label className="flex items-center gap-2 min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#07111E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={rstIsActive}
                  onChange={(e) => setRstIsActive(e.target.checked)}
                  className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  Active Restriction
                </span>
              </label>
            </div>

            {rstError && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300">
                {rstError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              {editingRestrictionId && (
                <button
                  type="button"
                  onClick={resetRestrictionForm}
                  disabled={savingRestriction}
                  className="min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-semibold"
                >
                  Cancel Edit
                </button>
              )}
              <button
                type="submit"
                disabled={savingRestriction}
                className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-[#0B1F3A] dark:bg-teal-600 hover:bg-[#14325B] dark:hover:bg-teal-700 text-white font-semibold disabled:opacity-60 whitespace-nowrap"
              >
                {savingRestriction
                  ? 'Saving...'
                  : editingRestrictionId
                    ? 'Update Restriction'
                    : 'Save Restriction'}
              </button>
            </div>
          </form>

          {/* Existing Restrictions List */}
          {restrictions.length === 0 ? (
            <div className="p-4 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-center text-xs text-slate-500 dark:text-slate-400">
              No blocked leave dates configured. Staff can apply for any date within operational capacity.
            </div>
          ) : (
            <>
              {/* Mobile Restriction Cards */}
              <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800 border-t border-slate-100 dark:border-slate-800">
                {restrictions.map((r) => (
                  <div key={r.restrictionId} className="py-3.5 space-y-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-mono font-semibold text-[#0B1F3A] dark:text-white">
                          {formatRestrictionRangeShort(r)}
                        </p>
                        <p className="text-slate-600 dark:text-slate-300 font-medium mt-0.5">
                          {formatRestrictionTargetLabel(r, profiles)}
                        </p>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-[2px] text-[10px] font-bold uppercase ${
                          r.isActive
                            ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-200'
                            : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        {r.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <p className="text-slate-600 dark:text-slate-300">{r.reason}</p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => startEditingRestriction(r)}
                        className="flex-1 min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 font-semibold"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={togglingRestrictionId === r.restrictionId}
                        onClick={async () => {
                          setTogglingRestrictionId(r.restrictionId);
                          try {
                            await onSaveRestriction({
                              restrictionId: r.restrictionId,
                              startDate: r.startDate,
                              endDate: r.endDate,
                              targetType: r.targetType,
                              targetStaffIds: r.targetStaffIds || [],
                              reason: r.reason,
                              isActive: !r.isActive,
                            });
                          } finally {
                            setTogglingRestrictionId(null);
                          }
                        }}
                        className="flex-1 min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 font-semibold"
                      >
                        {r.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                      {onDeleteRestriction && (
                        <button
                          type="button"
                          onClick={() => setDeleteRestrictionTarget(r)}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 font-semibold"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop Restriction Table */}
              <div className="hidden md:block overflow-x-auto border-t border-slate-100 dark:border-slate-800 pt-2">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 pr-4 font-semibold">Date Range</th>
                      <th className="py-2.5 pr-4 font-semibold">Affected Staff / Designations</th>
                      <th className="py-2.5 pr-4 font-semibold">Reason</th>
                      <th className="py-2.5 pr-4 font-semibold">Status</th>
                      <th className="py-2.5 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {restrictions.map((r) => (
                      <tr key={r.restrictionId} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                        <td className="py-3 pr-4 font-mono font-semibold whitespace-nowrap">
                          {formatRestrictionRangeShort(r)}
                        </td>
                        <td className="py-3 pr-4 font-medium">
                          {formatRestrictionTargetLabel(r, profiles)}
                        </td>
                        <td className="py-3 pr-4 text-slate-600 dark:text-slate-300 max-w-xs">
                          {r.reason}
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded-[2px] text-[10px] font-bold uppercase ${
                              r.isActive
                                ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-200'
                                : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                            }`}
                          >
                            {r.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="py-3 text-right whitespace-nowrap space-x-2">
                          <button
                            type="button"
                            onClick={() => startEditingRestriction(r)}
                            className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold inline-flex items-center gap-1"
                          >
                            <Edit3 className="w-3 h-3" aria-hidden="true" />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            disabled={togglingRestrictionId === r.restrictionId}
                            onClick={async () => {
                              setTogglingRestrictionId(r.restrictionId);
                              try {
                                await onSaveRestriction({
                                  restrictionId: r.restrictionId,
                                  startDate: r.startDate,
                                  endDate: r.endDate,
                                  targetType: r.targetType,
                                  targetStaffIds: r.targetStaffIds || [],
                                  reason: r.reason,
                                  isActive: !r.isActive,
                                });
                              } finally {
                                setTogglingRestrictionId(null);
                              }
                            }}
                            className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <Check className="w-3 h-3" aria-hidden="true" />
                            <span>{r.isActive ? 'Deactivate' : 'Activate'}</span>
                          </button>
                          {onDeleteRestriction && (
                            <button
                              type="button"
                              onClick={() => setDeleteRestrictionTarget(r)}
                              className="px-2.5 py-1.5 rounded-md border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 font-semibold inline-flex items-center gap-1"
                            >
                              <Trash2 className="w-3 h-3" aria-hidden="true" />
                              <span>Remove</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {/* Delete Leave Date Restriction Confirmation Modal */}
      {deleteRestrictionTarget && onDeleteRestriction && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl">
            <h3 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
              Remove Leave Date Restriction
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Remove the restriction for{' '}
              <span className="font-mono font-semibold text-slate-900 dark:text-white">
                {formatRestrictionRangeShort(deleteRestrictionTarget)}
              </span>{' '}
              ({formatRestrictionTargetLabel(deleteRestrictionTarget, profiles)})? Staff covered by this restriction will be allowed to submit leave for those dates subject to daily capacity limits.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button
                type="button"
                disabled={deletingRestriction}
                onClick={() => setDeleteRestrictionTarget(null)}
                className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingRestriction}
                onClick={async () => {
                  setDeletingRestriction(true);
                  try {
                    await onDeleteRestriction(deleteRestrictionTarget.restrictionId);
                    if (editingRestrictionId === deleteRestrictionTarget.restrictionId) {
                      resetRestrictionForm();
                    }
                    setDeleteRestrictionTarget(null);
                  } finally {
                    setDeletingRestriction(false);
                  }
                }}
                className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
              >
                {deletingRestriction ? 'Removing...' : 'Remove Restriction'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Trusted Local Admin CLI Reference */}
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white flex items-center gap-2">
              <Terminal className="w-4 h-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
              <span>Trusted Admin CLI — Bulk Import &amp; Maintenance</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
              Service account credentials stay exclusively in encrypted Cloudflare Worker secrets and trusted administrator CLI environments. Individual staff accounts can be added directly above, while bulk roster imports and CLI operations can also be run from an administrator workstation.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 text-xs">
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-1.5">
            <p className="font-semibold text-[#0B1F3A] dark:text-teal-300">
              1. Provision New Staff Account
            </p>
            <code className="block font-mono text-[11px] bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded p-2 overflow-x-auto text-slate-800 dark:text-slate-200">
              npx tsx scripts/adminStaffAuth.ts provision A-10018 &quot;Full Name&quot; &quot;ASSISTANT OFFICER&quot;
            </code>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-1.5">
            <p className="font-semibold text-[#0B1F3A] dark:text-teal-300">
              2. Bulk Import CSV / Markdown Roster
            </p>
            <code className="block font-mono text-[11px] bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded p-2 overflow-x-auto text-slate-800 dark:text-slate-200">
              npx tsx scripts/adminStaffAuth.ts import ./roster.csv
            </code>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-1.5">
            <p className="font-semibold text-[#0B1F3A] dark:text-teal-300">
              3. Admin PIN Reset
            </p>
            <code className="block font-mono text-[11px] bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded p-2 overflow-x-auto text-slate-800 dark:text-slate-200">
              npx tsx scripts/adminStaffAuth.ts reset-pin A-7111
            </code>
          </div>
        </div>
      </section>

      {/* Add Staff Modal */}
      {addModalOpen && currentProfile.role === 'manager' && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center gap-2 text-teal-700 dark:text-teal-400">
              <UserPlus className="w-4 h-4 shrink-0" aria-hidden="true" />
              <h3 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
                Add New Staff Member
              </h3>
            </div>

            <form onSubmit={handleSaveNewStaff} className="space-y-3 text-xs">
              <div>
                <label htmlFor="add-staff-id" className="block font-semibold mb-1">
                  Staff ID
                </label>
                <input
                  id="add-staff-id"
                  type="text"
                  value={newStaffId}
                  onChange={(e) => setNewStaffId(e.target.value)}
                  placeholder="e.g. A-10018"
                  autoComplete="off"
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
                  required
                />
              </div>

              <div>
                <label htmlFor="add-staff-name" className="block font-semibold mb-1">
                  Full Name
                </label>
                <input
                  id="add-staff-name"
                  type="text"
                  value={newFullName}
                  onChange={(e) => setNewFullName(e.target.value)}
                  placeholder="e.g. Aminath Ali"
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="add-staff-designation" className="block font-semibold mb-1">
                    Designation
                  </label>
                  <select
                    id="add-staff-designation"
                    value={newDesignation}
                    onChange={(e) => setNewDesignation(e.target.value as Designation)}
                    className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  >
                    <option value="MANAGER">Manager</option>
                    <option value="EXECUTIVE">Executive</option>
                    <option value="OFFICER">Officer</option>
                    <option value="ASSISTANT OFFICER">Assistant Officer</option>
                    <option value="ATTENDANT">Attendant</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="add-staff-role" className="block font-semibold mb-1">
                    Role
                  </label>
                  <select
                    id="add-staff-role"
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                    className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  >
                    <option value="staff">Staff</option>
                    <option value="executive">Executive</option>
                    <option value="manager">Manager</option>
                  </select>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                Default PIN will be set to <span className="font-mono font-bold">1234</span>. The employee will be required to change their PIN on first login and can sign in immediately across all devices.
              </div>

              {addError && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300">
                  {addError}
                </div>
              )}

              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={addingStaff}
                  onClick={() => setAddModalOpen(false)}
                  className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addingStaff}
                  className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold disabled:opacity-60"
                >
                  {addingStaff ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Staff Modal */}
      {editingTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
            <h3 className="text-base font-display font-bold">
              Update Staff Profile: <span className="font-mono">{editingTarget.staffId}</span>
            </h3>
            <form onSubmit={handleSaveEdit} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Full Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  required
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Designation</label>
                  <select
                    value={editDesignation}
                    onChange={(e) => setEditDesignation(e.target.value as Designation)}
                    className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  >
                    <option value="ASSISTANT OFFICER">ASSISTANT OFFICER</option>
                    <option value="ATTENDANT">ATTENDANT</option>
                    <option value="OFFICER">OFFICER</option>
                    <option value="EXECUTIVE">EXECUTIVE</option>
                    <option value="MANAGER">MANAGER</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Access Role</label>
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value as UserRole)}
                    className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  >
                    <option value="staff">Staff</option>
                    <option value="executive">Executive</option>
                    <option value="manager">Manager</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Account Status</label>
                  <select
                    value={editIsActive ? 'active' : 'inactive'}
                    onChange={(e) => setEditIsActive(e.target.value === 'active')}
                    className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive (Deactivated)</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Annual Limit</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={editLimit}
                    onChange={(e) => setEditLimit(Number(e.target.value))}
                    className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold mb-1">Unit Section</label>
                <input
                  type="text"
                  value={editSection}
                  onChange={(e) => setEditSection(e.target.value)}
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
                  required
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingTarget(null)}
                  className="min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  {savingEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manager PIN Reset Modal (Cloudflare Worker + CLI Fallback) */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-lg w-full p-5 sm:p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center gap-2 text-teal-700 dark:text-teal-400">
              <KeyRound className="w-4 h-4 shrink-0" aria-hidden="true" />
              <h3 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
                Reset PIN: {resetTarget.fullName} ({resetTarget.staffId})
              </h3>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Assign a temporary numeric PIN (4 to 12 digits). The PIN is hashed server-side on our Cloudflare Worker using PBKDF2-SHA256, and the employee will be required to choose a personal PIN upon next login.
            </p>

            {onResetStaffPin && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setResetPinError(null);
                  const cleaned = resetTempPin.trim();
                  if (!/^\d{4,12}$/.test(cleaned)) {
                    setResetPinError('Temporary PIN must be 4 to 12 numeric digits.');
                    return;
                  }
                  setResettingPin(true);
                  try {
                    await onResetStaffPin(resetTarget, cleaned);
                    setResetTarget(null);
                    setResetTempPin('');
                  } catch (err) {
                    setResetPinError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setResettingPin(false);
                  }
                }}
                className="space-y-3"
              >
                <div>
                  <label htmlFor="admin-reset-pin" className="block text-xs font-semibold mb-1">
                    New Temporary Numeric PIN (4 to 12 digits)
                  </label>
                  <input
                    id="admin-reset-pin"
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    minLength={4}
                    maxLength={12}
                    value={resetTempPin}
                    onChange={(e) => setResetTempPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="Enter temporary numeric PIN"
                    className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono tracking-widest"
                    required
                  />
                </div>
                {resetPinError && (
                  <p className="text-xs text-red-700 dark:text-red-300">{resetPinError}</p>
                )}
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                  <button
                    type="button"
                    disabled={resettingPin}
                    onClick={() => setResetTarget(null)}
                    className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={resettingPin}
                    className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-60"
                  >
                    {resettingPin ? 'Resetting PIN...' : 'Set Temporary PIN'}
                  </button>
                </div>
              </form>
            )}

            <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
              <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                Or via trusted Admin CLI:
              </p>
              <code className="block font-mono text-[11px] bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 overflow-x-auto text-slate-900 dark:text-slate-100">
                npx tsx scripts/adminStaffAuth.ts reset-pin {resetTarget.staffId} --pin &lt;tempPin&gt;
              </code>
            </div>
          </div>
        </div>
      )}

      {/* Remove Staff Confirmation Modal */}
      {removeTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-300 flex items-center justify-center shrink-0">
                <Trash2 className="w-4 h-4" aria-hidden="true" />
              </div>
              <div>
                <h3 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
                  Remove Staff Account
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    {removeTarget.fullName}
                  </span>{' '}
                  · <span className="font-mono">{removeTarget.staffId}</span> ({removeTarget.designation})
                </p>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/35 border border-red-200 dark:border-red-900/60 text-xs text-red-800 dark:text-red-200 space-y-1.5">
              <p className="font-semibold">This action permanently deletes the Firestore staff record.</p>
              <p>
                All leave requests submitted by this employee will be deleted, any approved daily leave slots will be released back to unit capacity, their <code className="font-mono">staffAuthLinks</code> access entry will be deleted, and an immutable <code className="font-mono">STAFF_REMOVED</code> entry will be recorded in the audit log.
              </p>
              <p className="text-[11px]">
                Afterwards, run <code className="font-mono">npx tsx scripts/adminStaffAuth.ts delete-auth {removeTarget.staffId}</code> to also delete their Firebase Authentication user.
              </p>
            </div>

            {removeError && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300">
                {removeError}
              </div>
            )}

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={removingStaff}
                onClick={() => setRemoveTarget(null)}
                className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={removingStaff}
                onClick={async () => {
                  setRemoveError(null);
                  setRemovingStaff(true);
                  try {
                    await onRemoveStaff(removeTarget);
                    setRemoveTarget(null);
                  } catch (err) {
                    setRemoveError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setRemovingStaff(false);
                  }
                }}
                className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
              >
                {removingStaff ? 'Removing Account...' : 'Confirm Removal'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 2. Audit Logs View (Manager Only)                                          */
/* -------------------------------------------------------------------------- */

export const AuditLogsView: React.FC<{ logs: AuditLog[] }> = ({ logs }) => {
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (actionFilter !== 'all' && l.action !== actionFilter) return false;
      if (!q) return true;
      return (
        l.summary.toLowerCase().includes(q) ||
        l.actorName.toLowerCase().includes(q) ||
        l.actorStaffId.toLowerCase().includes(q)
      );
    });
  }, [logs, actionFilter, search]);

  return (
    <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base sm:text-lg font-display font-bold text-[#0B1F3A] dark:text-white">
            Immutable Audit Logs
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Append-only history of leave approvals, rejections, modifications, and staff account administration protected by Firestore Security Rules.
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            downloadCsv(
              'ssu-audit-logs.csv',
              ['Timestamp (MVT)', 'Action', 'Actor Staff ID', 'Actor Name', 'Role', 'Summary'],
              filtered.map((l) => [
                formatTimestampForDisplay(l.createdAt),
                l.action,
                l.actorStaffId,
                l.actorName,
                l.actorRole,
                l.summary,
              ])
            )
          }
          disabled={filtered.length === 0}
          className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Export Audit CSV</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter audit entries by staff ID, actor, or summary..."
          className="flex-1 min-w-[200px] min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs"
        />
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="w-full sm:w-auto min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
        >
          <option value="all">All Actions</option>
          <option value="LEAVE_SUBMITTED">LEAVE_SUBMITTED</option>
          <option value="LEAVE_APPROVED">LEAVE_APPROVED</option>
          <option value="LEAVE_REJECTED">LEAVE_REJECTED</option>
          <option value="LEAVE_CANCELLED">LEAVE_CANCELLED</option>
          <option value="LEAVE_MODIFIED">LEAVE_MODIFIED</option>
          <option value="LEAVE_DATA_CLEARED">LEAVE_DATA_CLEARED</option>
          <option value="RESTRICTION_SAVED">RESTRICTION_SAVED</option>
          <option value="RESTRICTION_REMOVED">RESTRICTION_REMOVED</option>
          <option value="MOD_REQUESTED">MOD_REQUESTED</option>
          <option value="STAFF_PROVISIONED">STAFF_PROVISIONED</option>
          <option value="STAFF_IMPORTED">STAFF_IMPORTED</option>
          <option value="STAFF_UPDATED">STAFF_UPDATED</option>
          <option value="STAFF_DEACTIVATED">STAFF_DEACTIVATED</option>
          <option value="STAFF_REMOVED">STAFF_REMOVED</option>
          <option value="PASSWORD_UPDATED">PASSWORD_UPDATED</option>
          <option value="PASSWORD_RESET_COMPLETED">PASSWORD_RESET_COMPLETED</option>
          <option value="SETTINGS_UPDATED">SETTINGS_UPDATED</option>
        </select>
      </div>

      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {filtered.length === 0 ? (
          <p className="text-xs text-slate-500 py-6 text-center">No matching audit log entries.</p>
        ) : (
          filtered.map((log) => (
            <div key={log.logId} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
              <div className="space-y-0.5">
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  <span className="font-mono text-teal-700 dark:text-teal-400">{log.action}</span>
                  <span className="mx-1.5 text-slate-400">·</span>
                  <span>{log.actorName}</span>{' '}
                  <span className="font-mono text-slate-500">({log.actorStaffId} / {log.actorRole})</span>
                </p>
                <p className="text-slate-600 dark:text-slate-300">{log.summary}</p>
              </div>
              <span className="font-mono text-[11px] text-slate-400 whitespace-nowrap shrink-0">
                {formatTimestampForDisplay(log.createdAt)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 3. Security & Setup (Manager Only)                                         */
/* -------------------------------------------------------------------------- */

interface DeploymentSecurityViewProps {
  currentProfile?: StaffProfile;
  onClearAllLeaveRecords?: (confirmation: string) => Promise<{
    deletedRequests: number;
    deletedCapacityDocs: number;
    deletedDetailDocs: number;
  }>;
}

export const DeploymentSecurityView: React.FC<DeploymentSecurityViewProps> = ({
  currentProfile,
  onClearAllLeaveRecords,
}) => {
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const isManager = currentProfile?.role === 'manager';

  const handleConfirmClearAll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onClearAllLeaveRecords || confirmInput.trim() !== 'DELETE ALL') return;
    setClearError(null);
    setClearing(true);
    try {
      await onClearAllLeaveRecords(confirmInput.trim());
      setClearModalOpen(false);
      setConfirmInput('');
    } catch (err) {
      setClearError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
          <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
            Cloudflare Workers &amp; Firebase — Authentication &amp; Firestore Security Architecture
          </h2>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
          This portal runs on <strong>Cloudflare Workers</strong> (static SPA + Edge API endpoints) connected to Firebase project <code className="font-mono">ss-leave-management</code> (Cloud Firestore <code className="font-mono">(default)</code> database) using real-time <code className="font-mono">onSnapshot</code> synchronization and Firebase Authentication Custom Tokens.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="p-4 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-2">
            <h3 className="font-semibold text-emerald-700 dark:text-emerald-400">
              Server-Verified PIN &amp; Custom Token Auth
            </h3>
            <ul className="list-disc pl-4 space-y-1.5 text-slate-600 dark:text-slate-300">
              <li>Employees enter only their <strong>Staff ID</strong> and <strong>numeric PIN</strong>. No email address is collected or exposed.</li>
              <li>The Cloudflare Worker (<code className="font-mono">/api/auth/login</code>) verifies the Staff ID against existing <code className="font-mono">staff</code> records, checks PBKDF2-SHA256 salted PIN hashes in <code className="font-mono">staffPinSecrets</code> (inaccessible to browser clients), enforces IP rate limiting and 5-attempt lockout, and mints a short-lived Firebase Custom Token.</li>
              <li>PIN changes (<code className="font-mono">/api/auth/change-pin</code>) verify the user&apos;s Firebase ID Token, save the new PBKDF2 hash centrally in Firestore, clear <code className="font-mono">mustChangePassword</code>, and sync across all devices.</li>
              <li>All <code className="font-mono">auditLogs</code> are strictly append-only and readable only by Managers.</li>
            </ul>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-2">
            <h3 className="font-semibold text-teal-700 dark:text-teal-400">
              Real-Time Sync &amp; Atomic Transactions
            </h3>
            <ul className="list-disc pl-4 space-y-1.5 text-slate-600 dark:text-slate-300">
              <li>Leave submissions, cancellations, Executive approvals/rejections, and calendar capacity updates synchronize live across all connected devices via Firestore <code className="font-mono">onSnapshot</code>.</li>
              <li>Concurrent leave submissions, approvals, rejections, cancellations, and date modifications execute inside atomic server-side Cloudflare Worker Firestore transactions across <code className="font-mono">leaveRequests</code>, <code className="font-mono">dailyCapacity</code>, <code className="font-mono">dailyCapacityDetails</code>, and <code className="font-mono">auditLogs</code>.</li>
              <li>Security rules enforce <code className="font-mono">approvedCount &gt;= 0 &amp;&amp; approvedCount &lt;= maxCapacity &amp;&amp; maxCapacity &lt;= 10</code> on every date document.</li>
              <li>Firebase Admin credentials live exclusively inside encrypted Cloudflare Worker secrets (<code className="font-mono">FIREBASE_SERVICE_ACCOUNT_KEY</code>) and are never included in frontend bundles or GitHub.</li>
            </ul>
          </div>
        </div>

        <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 text-xs text-amber-950 dark:text-amber-200 space-y-1.5">
          <p className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Operational Security Notes</span>
          </p>
          <ul className="list-disc pl-4 space-y-1 text-amber-900 dark:text-amber-200/90">
            <li>
              <strong>Multi-document rule boundary:</strong> Firestore Security Rules cannot loop over dynamic <code className="font-mono">dates[]</code> arrays (1–30 days) or count annual leave periods across collections in a single rule evaluation. Server-side Worker Firestore transactions enforce concurrency and rules cap each date document at <code className="font-mono">approvedCount &lt;= 10</code>.
            </li>
            <li>
              <strong>Secret management:</strong> Always keep <code className="font-mono">FIREBASE_SERVICE_ACCOUNT_KEY</code> stored solely via <code className="font-mono">wrangler secret put</code> and local untracked <code className="font-mono">.env</code> files.
            </li>
          </ul>
        </div>
      </section>

      {/* Leave Data Management (Manager Only — Strictly inside Security & Setup) */}
      {isManager && onClearAllLeaveRecords && (
        <section className="bg-white dark:bg-[#0D1B2A] border border-red-200 dark:border-red-900/60 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1.5 max-w-2xl">
              <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white flex items-center gap-2">
                <DatabaseZap className="w-4 h-4 text-red-600 dark:text-red-400" aria-hidden="true" />
                <span>Leave Data Management</span>
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Permanently reset all leave applications (Pending, Approved, Rejected, and Cancelled) and clear daily leave capacity counters so all occupied daily slots return to zero across all connected devices. Staff accounts, PIN credentials, authentication links, application settings, blocked leave dates, and existing audit logs are preserved.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setConfirmInput('');
                setClearError(null);
                setClearModalOpen(true);
              }}
              className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap shadow-xs transition-colors shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Clear All Leave Records</span>
            </button>
          </div>
        </section>
      )}

      {/* Confirm Clear All Leave Records Modal */}
      {clearModalOpen && isManager && onClearAllLeaveRecords && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/65 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="clear-leave-modal-title"
        >
          <div className="bg-white dark:bg-[#0D1B2A] border border-red-200 dark:border-red-900/60 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-300 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" aria-hidden="true" />
              </div>
              <div>
                <h3
                  id="clear-leave-modal-title"
                  className="text-base font-display font-bold text-[#0B1F3A] dark:text-white"
                >
                  Clear All Leave Records
                </h3>
                <p className="text-xs text-red-700 dark:text-red-300 font-semibold mt-0.5">
                  Permanent irreversible action
                </p>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/35 border border-red-200 dark:border-red-900/50 text-xs text-red-900 dark:text-red-200 space-y-2 leading-relaxed">
              <p className="font-semibold">
                All leave applications (Pending, Approved, Rejected, and Cancelled) will be permanently deleted from Firebase Firestore.
              </p>
              <p>
                Daily leave capacity counters and slot details will also be cleared, resetting all occupied daily slots to zero across every user and device. Staff accounts, PIN credentials, auth links, application settings, leave date restrictions, and existing audit logs will NOT be deleted.
              </p>
            </div>

            <form onSubmit={handleConfirmClearAll} className="space-y-3 text-xs">
              <div>
                <label htmlFor="confirm-delete-all" className="block font-semibold mb-1.5">
                  Type <code className="font-mono font-bold text-red-700 dark:text-red-300">DELETE ALL</code> to confirm:
                </label>
                <input
                  id="confirm-delete-all"
                  type="text"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder="DELETE ALL"
                  autoComplete="off"
                  className="w-full min-h-[42px] sm:min-h-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-xs font-mono"
                  required
                />
              </div>

              {clearError && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300">
                  {clearError}
                </div>
              )}

              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={clearing}
                  onClick={() => setClearModalOpen(false)}
                  className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={clearing || confirmInput.trim() !== 'DELETE ALL'}
                  className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  {clearing ? 'Clearing All Leave Records...' : 'Permanently Delete All'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
