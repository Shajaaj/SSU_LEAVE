import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  KeyRound,
  Settings,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';
import {
  AppSettings,
  AuditLog,
  Designation,
  StaffProfile,
  UserRole,
} from '../types/portal';
import { downloadCsv } from '../utils/csvExport';
import { formatTimestampForDisplay } from '../utils/maldivesDate';
import { StaffStatusLabel } from './StatusLabel';

/* -------------------------------------------------------------------------- */
/* 1. Administration View (Manager Only)                                      */
/* -------------------------------------------------------------------------- */

interface AdministrationViewProps {
  currentProfile: StaffProfile;
  profiles: StaffProfile[];
  settings: AppSettings;
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
  onUpdateSettings: (next: {
    maxDailyCombinedCap: number;
    maxAnnualLeavePeriods: number;
  }) => Promise<void>;
}

export const AdministrationView: React.FC<AdministrationViewProps> = ({
  currentProfile,
  profiles,
  settings,
  onUpdateStaff,
  onRemoveStaff,
  onUpdateSettings,
}) => {
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

  // Admin Password Reset CLI Modal
  const [resetTarget, setResetTarget] = useState<StaffProfile | null>(null);

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
      {/* Trusted Local Admin CLI Notice (Spark Free Tier Security Boundary) */}
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white flex items-center gap-2">
              <Terminal className="w-4 h-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
              <span>Trusted Admin CLI — Provisioning, Bulk Import & Password Resets</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
              Because this portal runs as a static SPA on Firebase Hosting (Spark Free Tier) with zero browser-exposed service account keys, creating Firebase Authentication users, importing rosters, and resetting another employee&apos;s password are executed from a trusted administrator workstation.
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
              3. Admin Password Reset
            </p>
            <code className="block font-mono text-[11px] bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded p-2 overflow-x-auto text-slate-800 dark:text-slate-200">
              npx tsx scripts/adminStaffAuth.ts reset-password A-7111
            </code>
          </div>
        </div>
      </section>

      {/* Account Management & Role Assignment */}
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
            Account Roles, Deactivation & Removal
          </h2>
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400 shrink-0">
            {profiles.length} records
          </span>
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
                  onClick={() => setResetTarget(p)}
                  className="flex-1 min-w-[120px] min-h-[44px] px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-1.5"
                >
                  <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Reset Password</span>
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
                      onClick={() => setResetTarget(p)}
                      className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold inline-flex items-center gap-1"
                    >
                      <KeyRound className="w-3 h-3" aria-hidden="true" />
                      <span>Reset Password</span>
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
              Policy: Pending requests never reserve capacity; only Approved leave deducts from daily slots. Timezone fixed to <span className="font-mono">Asia/Male</span>.
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

      {/* Trusted Admin CLI Password Reset Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-lg w-full p-5 sm:p-6 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center gap-2 text-teal-700 dark:text-teal-400">
              <KeyRound className="w-4 h-4 shrink-0" aria-hidden="true" />
              <h3 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
                Reset Password: {resetTarget.fullName} ({resetTarget.staffId})
              </h3>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Firebase Authentication does not allow a browser client to reset another employee&apos;s password without Admin SDK privileges. Run the trusted Administrator CLI from an authorized workstation to assign a new one-time temporary password and flag <code className="font-mono">mustChangePassword = true</code>:
            </p>
            <code className="block font-mono text-xs bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 rounded-lg p-3 overflow-x-auto text-slate-900 dark:text-slate-100">
              npx tsx scripts/adminStaffAuth.ts reset-password {resetTarget.staffId}
            </code>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              To specify a custom temporary password (minimum 8 characters), append <code className="font-mono">--password &quot;TempPass123!&quot;</code>. Plaintext passwords are never stored in Firestore.
            </p>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                className="min-h-[44px] sm:min-h-0 px-4 py-2 text-xs font-semibold rounded-lg bg-[#0B1F3A] dark:bg-teal-600 text-white"
              >
                Close
              </button>
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
/* 3. Security & Firebase Spark-Tier Architecture                             */
/* -------------------------------------------------------------------------- */

export const DeploymentSecurityView: React.FC = () => {
  return (
    <div className="space-y-4">
      <section className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
          <h2 className="text-base font-display font-bold text-[#0B1F3A] dark:text-white">
            Firebase Hosting (Spark Tier) — Authentication & Firestore Security Architecture
          </h2>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
          This portal runs directly as a static SPA on <strong>Firebase Hosting</strong> connected to Firebase project <code className="font-mono">gen-lang-client-0180778148</code> (Firestore database <code className="font-mono">ai-studio-ee2eb30d-6479-40ee-8c90-a5e78ecc9769</code>) using real-time <code className="font-mono">onSnapshot</code> synchronization with zero continuous Node.js server dependency.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="p-4 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-2">
            <h3 className="font-semibold text-emerald-700 dark:text-emerald-400">
              Authentication & Access Control
            </h3>
            <ul className="list-disc pl-4 space-y-1.5 text-slate-600 dark:text-slate-300">
              <li>Employees enter only their <strong>Staff ID</strong> and <strong>Password</strong>; the client deterministically maps Staff IDs (e.g. <code className="font-mono">A-5530</code> → <code className="font-mono">a5530@staff.example.com</code>) for Firebase Email/Password authentication.</li>
              <li>UID-to-Staff-ID and role bindings live in <code className="font-mono">staffAuthLinks/&#123;uid&#125;</code> and are verified by <code className="font-mono">firestore.rules</code> on every read and write.</li>
              <li>Regular staff can read only their own <code className="font-mono">staff</code> and <code className="font-mono">leaveRequests</code> documents, while viewing non-PII daily availability via <code className="font-mono">dailyCapacity</code> and <code className="font-mono">dailyCapacityDetails</code>.</li>
              <li>All <code className="font-mono">auditLogs</code> are strictly append-only (<code className="font-mono">allow update, delete: if false</code>) and readable only by Managers.</li>
            </ul>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 dark:bg-[#07111E] border border-slate-200 dark:border-slate-800 space-y-2">
            <h3 className="font-semibold text-teal-700 dark:text-teal-400">
              Real-Time Sync & Atomic Transactions
            </h3>
            <ul className="list-disc pl-4 space-y-1.5 text-slate-600 dark:text-slate-300">
              <li>Leave submissions, Executive approvals/rejections, and calendar capacity updates synchronize live across all connected devices via Firestore <code className="font-mono">onSnapshot</code>.</li>
              <li>Concurrent approvals execute inside Firestore <code className="font-mono">runTransaction()</code> across <code className="font-mono">leaveRequests</code>, <code className="font-mono">dailyCapacity</code>, <code className="font-mono">dailyCapacityDetails</code>, and <code className="font-mono">auditLogs</code>.</li>
              <li>Security rules enforce <code className="font-mono">approvedCount &gt;= 0 &amp;&amp; approvedCount &lt;= maxCapacity &amp;&amp; maxCapacity &lt;= 10</code> on every date document.</li>
              <li>Trusted local Admin CLI scripts (<code className="font-mono">scripts/migrateToFirebaseAuth.ts</code>, <code className="font-mono">scripts/adminStaffAuth.ts</code>) handle user creation and password resets without exposing service-account keys in the browser.</li>
            </ul>
          </div>
        </div>

        <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 text-xs text-amber-950 dark:text-amber-200 space-y-1.5">
          <p className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Explicit Spark Free-Tier Security Limitations</span>
          </p>
          <ul className="list-disc pl-4 space-y-1 text-amber-900 dark:text-amber-200/90">
            <li>
              <strong>Multi-document rule boundary:</strong> Firestore Security Rules cannot loop over dynamic <code className="font-mono">dates[]</code> arrays (1–30 days) or count annual leave periods across collections in a single rule evaluation. Client-side <code className="font-mono">runTransaction()</code> enforces concurrency and rules cap each date document at <code className="font-mono">approvedCount &lt;= 10</code>, but full server-side enforcement against a compromised Executive client requires upgrading to the Blaze plan with Cloud Functions.
            </li>
            <li>
              <strong>Firebase Auth lifecycle:</strong> Deleting or creating Firebase Auth users and resetting another user&apos;s password require the Admin CLI (<code className="font-mono">scripts/adminStaffAuth.ts</code>) because Cloud Functions are not used on Spark.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
};
