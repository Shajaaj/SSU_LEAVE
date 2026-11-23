export type UserRole = 'staff' | 'executive' | 'manager';

export type Designation =
  | 'EXECUTIVE'
  | 'OFFICER'
  | 'ASSISTANT OFFICER'
  | 'ATTENDANT'
  | 'MANAGER';

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type LeaveType = 'Annual Leave';

export type ModificationRequestType = 'none' | 'edit' | 'cancel';

export type PortalView =
  | 'dashboard'
  | 'calendar'
  | 'requests'
  | 'management'
  | 'directory'
  | 'reports'
  | 'admin'
  | 'audit'
  | 'deployment';

export interface StaffProfile {
  staffId: string;
  authUid?: string;
  authEmail?: string;
  fullName: string;
  designation: Designation;
  role: UserRole;
  isActive: boolean;
  mustChangePassword?: boolean;
  unitSection: string;
  annualPeriodLimit: number;
  countsTowardDailyCap: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface StaffAuthLink {
  uid: string;
  staffId: string;
  role: UserRole;
  designation: Designation;
  isActive: boolean;
  updatedAt?: unknown;
}

export interface LeaveRequest {
  requestId: string;
  uid?: string;
  staffId: string;
  staffName: string;
  designation: Designation;
  countsTowardDailyCap: boolean;
  leaveType: LeaveType;
  startDate: string; // YYYY-MM-DD (Maldives UTC+5)
  endDate: string; // YYYY-MM-DD (Maldives UTC+5)
  dates: string[];
  daysCount: number;
  calendarYear: number;
  reason: string;
  status: LeaveStatus;
  modificationRequestType: ModificationRequestType;
  modificationNote?: string;
  requestedStartDate?: string;
  requestedEndDate?: string;
  reviewedByStaffId?: string;
  reviewedByName?: string;
  reviewComment?: string;
  addedByManager?: boolean;
  addedByStaffId?: string;
  addedByName?: string;
  addedAt?: unknown;
  editedAt?: unknown;
  lastAuditLogId?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface DailyCapacity {
  date: string; // YYYY-MM-DD
  approvedCount: number; // Combined occupied cap slots (Pending + Approved for Assistant Officers & Attendants)
  approvedOnlyCount?: number;
  pendingCount?: number;
  maxCapacity: number;
  executiveCount?: number; // Combined occupied Executive slots (Pending + Approved for Executives)
  executiveApprovedCount?: number;
  executivePendingCount?: number;
  maxExecutiveCapacity?: number;
  updatedAt?: unknown;
}

export interface DailyAllocationEntry {
  staffId: string;
  staffName: string;
  designation: Designation;
  requestId: string;
  leaveType: LeaveType;
  status?: LeaveStatus;
}

export interface DailyCapacityDetail {
  date: string; // YYYY-MM-DD
  allocations: DailyAllocationEntry[];
  updatedAt?: unknown;
}

export type AuditAction =
  | 'LEAVE_SUBMITTED'
  | 'LEAVE_APPROVED'
  | 'MANAGER_LEAVE_ADDED'
  | 'LEAVE_REJECTED'
  | 'LEAVE_CANCELLED'
  | 'LEAVE_EDITED'
  | 'LEAVE_MODIFIED'
  | 'LEAVE_DATA_CLEARED'
  | 'RESTRICTION_SAVED'
  | 'RESTRICTION_REMOVED'
  | 'MOD_REQUESTED'
  | 'STAFF_PROVISIONED'
  | 'STAFF_IMPORTED'
  | 'STAFF_UPDATED'
  | 'STAFF_DEACTIVATED'
  | 'STAFF_REMOVED'
  | 'SETTINGS_UPDATED'
  | 'PASSWORD_UPDATED'
  | 'PASSWORD_RESET_COMPLETED';

export interface AuditLog {
  logId: string;
  action: AuditAction;
  targetType: 'leaveRequest' | 'staff' | 'appSettings' | 'leaveRestriction';
  targetId: string;
  actorStaffId: string;
  actorName: string;
  actorRole: UserRole;
  summary: string;
  previousStatus?: string;
  newStatus?: string;
  affectedDates?: string[];
  createdAt?: unknown;
}

export type RestrictionTargetType =
  | 'all'
  | 'assistant_officer'
  | 'attendant'
  | 'executive'
  | 'officer'
  | 'selected_staff';

export interface LeaveRestriction {
  restrictionId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  targetType: RestrictionTargetType;
  targetStaffIds: string[];
  targetStaffNames?: string[];
  reason: string;
  isActive: boolean;
  createdByStaffId: string;
  createdByName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AppSettings {
  maxDailyCombinedCap: number;
  maxExecutiveDailyCap: number;
  maxAnnualLeavePeriods: number;
  pendingReservesCapacity: boolean;
  timezone: string;
  unitName: string;
  airportName: string;
  updatedByStaffId: string;
  updatedAt?: unknown;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
}
