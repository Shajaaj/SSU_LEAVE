import { Designation, LeaveStatus } from '../types/portal';

export function isExecutiveDesignation(designation: Designation | string): boolean {
  return String(designation || '').trim().toUpperCase() === 'EXECUTIVE';
}

export interface LeaveBarStyle {
  isExecutive: boolean;
  isPending: boolean;
  barClass: string;
  badgeClass: string;
  dotClass: string;
  statusText: string;
}

/**
 * Shared leave bar styling across Monthly Calendar, Daily View, and Management Dashboard:
 * - Executive: Purple (Solid when Approved, Striped + Pending label when Pending)
 * - Staff (Assistant Officer / Attendant / Officer): Blue (Solid when Approved, Striped + Pending label when Pending)
 */
export function getLeaveBarStyle(
  designation: Designation | string,
  status: LeaveStatus,
  hasModPending = false
): LeaveBarStyle {
  const isExecutive = isExecutiveDesignation(designation);
  const isPending = status === 'pending';

  if (isExecutive) {
    if (isPending) {
      return {
        isExecutive: true,
        isPending: true,
        barClass:
          'leave-bar-pending-executive border-purple-600 dark:border-purple-400 text-purple-950 dark:text-purple-50',
        badgeClass:
          'leave-bar-pending-executive border border-purple-600 dark:border-purple-400 text-purple-950 dark:text-purple-50',
        dotClass: 'bg-purple-500 border border-purple-700',
        statusText: 'Pending',
      };
    }

    return {
      isExecutive: true,
      isPending: false,
      barClass: hasModPending
        ? 'bg-purple-600 dark:bg-purple-600 border-purple-800 dark:border-purple-300 text-white ring-1 ring-amber-400/80'
        : 'bg-purple-600 dark:bg-purple-600 border-purple-700 dark:border-purple-400 text-white',
      badgeClass:
        'bg-purple-600 dark:bg-purple-600 border border-purple-700 dark:border-purple-400 text-white',
      dotClass: 'bg-purple-600',
      statusText: hasModPending ? 'Mod Pending' : 'Approved',
    };
  }

  if (isPending) {
    return {
      isExecutive: false,
      isPending: true,
      barClass:
        'leave-bar-pending-staff border-blue-600 dark:border-blue-400 text-blue-950 dark:text-blue-50',
      badgeClass:
        'leave-bar-pending-staff border border-blue-600 dark:border-blue-400 text-blue-950 dark:text-blue-50',
      dotClass: 'bg-blue-500 border border-blue-700',
      statusText: 'Pending',
    };
  }

  return {
    isExecutive: false,
    isPending: false,
    barClass: hasModPending
      ? 'bg-blue-600 dark:bg-blue-600 border-blue-800 dark:border-blue-300 text-white ring-1 ring-amber-400/80'
      : 'bg-blue-600 dark:bg-blue-600 border-blue-700 dark:border-blue-400 text-white',
    badgeClass:
      'bg-blue-600 dark:bg-blue-600 border border-blue-700 dark:border-blue-400 text-white',
    dotClass: 'bg-blue-600',
    statusText: hasModPending ? 'Mod Pending' : 'Approved',
  };
}
