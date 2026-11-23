import React from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react';
import { LeaveStatus } from '../types/portal';

export const LeaveStatusLabel: React.FC<{ status: LeaveStatus }> = ({ status }) => {
  switch (status) {
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Approved</span>
        </span>
      );
    case 'pending':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 whitespace-nowrap">
          <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Pending</span>
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-400 whitespace-nowrap">
          <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Rejected</span>
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-400 whitespace-nowrap">
          <Ban className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Cancelled</span>
        </span>
      );
  }
};

export const ManagerAddedLabel: React.FC<{
  addedByName?: string;
  addedByStaffId?: string;
}> = ({ addedByName, addedByStaffId }) => {
  const titleText =
    addedByName || addedByStaffId
      ? `Added directly by Manager: ${addedByName || addedByStaffId}${addedByStaffId && addedByName ? ` (${addedByStaffId})` : ''}`
      : 'Added directly by Manager';
  return (
    <span
      title={titleText}
      className="inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold bg-teal-50 dark:bg-teal-950/60 text-teal-800 dark:text-teal-300 border border-teal-200 dark:border-teal-800/70 whitespace-nowrap"
    >
      Manager Added
    </span>
  );
};

export const StaffStatusLabel: React.FC<{ isActive: boolean }> = ({ isActive }) => {
  if (isActive) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Active</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap">
      <Ban className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>Inactive</span>
    </span>
  );
};

export const AvailabilityLabel: React.FC<{
  approvedCount: number;
  maxCapacity: number;
  compactMobile?: boolean;
}> = ({ approvedCount, maxCapacity, compactMobile = false }) => {
  const remaining = Math.max(0, maxCapacity - approvedCount);
  const textSize = compactMobile ? 'text-[9px] sm:text-[11px] leading-tight' : 'text-[11px]';
  if (remaining === 0) {
    return (
      <span className={`inline-flex items-center gap-0.5 sm:gap-1 ${textSize} font-semibold text-red-700 dark:text-red-400 whitespace-nowrap`}>
        <XCircle className="w-2.5 h-2.5 sm:w-3 sm:h-3 shrink-0" aria-hidden="true" />
        <span>Full</span>
      </span>
    );
  }
  if (remaining <= 2) {
    return (
      <span className={`inline-flex items-center gap-0.5 sm:gap-1 ${textSize} font-semibold text-amber-700 dark:text-amber-400 whitespace-nowrap`}>
        <AlertTriangle className="w-2.5 h-2.5 sm:w-3 sm:h-3 shrink-0" aria-hidden="true" />
        <span>{remaining} left</span>
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1 ${textSize} font-medium text-teal-700 dark:text-teal-400 whitespace-nowrap`}>
      <span>{remaining} left</span>
    </span>
  );
};

export const LeaveColorLegend: React.FC<{ className?: string }> = ({
  className = '',
}) => (
  <div
    className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-600 dark:text-slate-300 ${className}`}
    aria-label="Leave colour legend"
  >
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="w-3.5 h-2.5 rounded-[2px] bg-blue-600 border border-blue-700 dark:border-blue-400 inline-block shrink-0"
        aria-hidden="true"
      />
      <span>Staff Approved</span>
    </span>
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="w-3.5 h-2.5 rounded-[2px] leave-bar-pending-staff border border-blue-600 dark:border-blue-400 inline-block shrink-0"
        aria-hidden="true"
      />
      <span>Staff Pending</span>
    </span>
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="w-3.5 h-2.5 rounded-[2px] bg-purple-600 border border-purple-700 dark:border-purple-400 inline-block shrink-0"
        aria-hidden="true"
      />
      <span>Executive Approved</span>
    </span>
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="w-3.5 h-2.5 rounded-[2px] leave-bar-pending-executive border border-purple-600 dark:border-purple-400 inline-block shrink-0"
        aria-hidden="true"
      />
      <span>Executive Pending</span>
    </span>
  </div>
);

