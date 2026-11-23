/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import {
  AdministrationView,
  AuditLogsView,
  DeploymentSecurityView,
} from './components/AdminAndAuditViews';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { LeaveCalendar } from './components/LeaveCalendar';
import { LeaveRequestModal } from './components/LeaveRequestModal';
import { LoginScreen } from './components/LoginScreen';
import {
  ManagementQueueView,
  ReportsView,
  StaffDirectoryView,
} from './components/ManagementViews';
import { MyRequestsView } from './components/MyRequestsView';
import { PortalShell } from './components/PortalShell';
import { StaffDashboard } from './components/StaffDashboard';
import {
  FIRESTORE_QUOTA_USER_MESSAGE,
  auth,
  isFirestoreQuotaError,
} from './firebase/client';
import {
  DEFAULT_APP_SETTINGS,
  addStaffByManager,
  approveLeaveRequest,
  cancelPendingLeaveRequest,
  changeOwnPassword,
  clearAllLeaveRecords,
  deleteLeaveRestriction,
  editPendingLeaveDates,
  fetchLeaveRestrictionsFromWorker,
  loadActiveRestrictionsStrict,
  logoutSession,
  managerAddApprovedLeave,
  processLeaveModification,
  rejectLeaveRequest,
  removeApprovedLeaveRequest,
  removeStaffAccount,
  requestLeaveModification,
  resetStaffPinByManager,
  resolveSignedInStaffProfile,
  saveLeaveRestriction,
  submitLeaveRequest,
  subscribeAllRequests,
  subscribeAllStaff,
  subscribeAuditLogs,
  subscribeLeaveRestrictions,
  subscribeMonthCapacity,
  subscribeMonthCapacityDetails,
  subscribeMyRequests,
  subscribeSettings,
  subscribeStaffProfile,
  syncPendingCapacity,
  updatePortalSettings,
  updateStaffProfile,
} from './services/firebasePortalService';
import {
  AppSettings,
  AuditLog,
  DailyCapacity,
  DailyCapacityDetail,
  Designation,
  LeaveRequest,
  LeaveRestriction,
  LeaveType,
  PortalView,
  RestrictionTargetType,
  StaffProfile,
  ToastMessage,
  UserRole,
} from './types/portal';
import { buildPendingDemandMap } from './utils/leaveRules';
import { getTodayInMaldives } from './utils/maldivesDate';

export default function App() {
  const todayMaldives = getTodayInMaldives();
  const initialYear = Number(todayMaldives.slice(0, 4));
  const initialMonth0 = Number(todayMaldives.slice(5, 7)) - 1;

  // Theme state synced with <html class="dark">
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('ssu_theme');
      if (saved === 'dark') return true;
      if (saved === 'light') return false;
    }
    return false;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      window.localStorage.setItem('ssu_theme', 'dark');
    } else {
      root.classList.remove('dark');
      window.localStorage.setItem('ssu_theme', 'light');
    }
  }, [darkMode]);

  // Firebase Auth & Active Staff Profile state
  const [authReady, setAuthReady] = useState(false);
  const [liveProfile, setLiveProfile] = useState<StaffProfile | null>(null);
  const [authErrorBanner, setAuthErrorBanner] = useState<string | null>(null);

  // Real-time Firestore Data
  const [liveSettings, setLiveSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [liveMyRequests, setLiveMyRequests] = useState<LeaveRequest[]>([]);
  const [liveAllRequests, setLiveAllRequests] = useState<LeaveRequest[]>([]);
  const [liveProfiles, setLiveProfiles] = useState<StaffProfile[]>([]);
  const [liveCapacityMap, setLiveCapacityMap] = useState<Record<string, DailyCapacity>>({});
  const [liveCapacityDetailsMap, setLiveCapacityDetailsMap] = useState<
    Record<string, DailyCapacityDetail>
  >({});
  const [liveAuditLogs, setLiveAuditLogs] = useState<AuditLog[]>([]);
  const [liveRestrictions, setLiveRestrictions] = useState<LeaveRestriction[]>([]);
  const [restrictionsStatus, setRestrictionsStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [restrictionsError, setRestrictionsError] = useState<string | null>(null);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [needsCapacitySync, setNeedsCapacitySync] = useState(false);
  const syncedPendingRef = useRef(false);
  const restrictionsFallbackRef = useRef(false);

  // Navigation & Calendar state
  const [activeView, setActiveView] = useState<PortalView>('dashboard');
  const [calendarYear, setCalendarYear] = useState(initialYear);
  const [calendarMonth0, setCalendarMonth0] = useState(initialMonth0);

  // New Request Modal
  const [newReqModalOpen, setNewReqModalOpen] = useState(false);
  const [prefillStart, setPrefillStart] = useState<string | undefined>();
  const [prefillEnd, setPrefillEnd] = useState<string | undefined>();

  // Password Change Modal
  const [changePwdModalOpen, setChangePwdModalOpen] = useState(false);

  // Toasts
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const addToast = useCallback(
    (type: ToastMessage['type'], title: string, detail?: string) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev, { id, type, title, detail }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5500);
    },
    []
  );
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const lastQuotaToastAtRef = useRef(0);
  const reportSyncError = useCallback(
    (title: string, err: Error) => {
      if (isFirestoreQuotaError(err)) {
        const now = Date.now();
        if (now - lastQuotaToastAtRef.current < 15_000) {
          return;
        }
        lastQuotaToastAtRef.current = now;
        addToast('error', 'Firestore Quota Limit Reached', FIRESTORE_QUOTA_USER_MESSAGE);
        return;
      }
      addToast('error', title, err.message);
    },
    [addToast]
  );

  const clearSignedInState = useCallback(() => {
    setLiveProfile(null);
    setLiveMyRequests([]);
    setLiveAllRequests([]);
    setLiveProfiles([]);
    setLiveCapacityMap({});
    setLiveCapacityDetailsMap({});
    setLiveAuditLogs([]);
    setLiveRestrictions([]);
    setRestrictionsStatus('loading');
    setRestrictionsError(null);
    setLoadingRequests(false);
    setSettingsLoaded(false);
    setNeedsCapacitySync(false);
    syncedPendingRef.current = false;
    restrictionsFallbackRef.current = false;
  }, []);

  // Listen to Firebase Auth state changes
  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!active) return;
      if (!firebaseUser) {
        clearSignedInState();
        setAuthReady(true);
        return;
      }

      try {
        const profile = await resolveSignedInStaffProfile(firebaseUser.uid);
        if (!active) return;
        setAuthErrorBanner(null);
        setLiveProfile(profile);
      } catch (err) {
        if (!active) return;
        const msg = err instanceof Error ? err.message : 'Unable to verify staff profile.';
        await logoutSession().catch(() => undefined);
        clearSignedInState();
        setAuthErrorBanner(msg);
      } finally {
        if (active) setAuthReady(true);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [clearSignedInState]);

  const activeStaffId = liveProfile?.staffId || null;
  const activeRole = liveProfile?.role || null;

  // Real-time Firestore listeners scoped by role (no duplicate staff/leaveRequests listeners)
  useEffect(() => {
    if (!activeStaffId || !activeRole) return;

    setLoadingRequests(true);
    const onSubError = (err: Error) => {
      reportSyncError('Firestore Sync Error', err);
      setLoadingRequests(false);
    };

    const unsubscribers = [
      subscribeSettings(
        (nextSettings) => {
          setLiveSettings(nextSettings);
          setSettingsLoaded(true);
        },
        onSubError,
        setNeedsCapacitySync
      ),
      subscribeLeaveRestrictions(
        (items) => {
          setLiveRestrictions(items);
          setRestrictionsStatus('ready');
          setRestrictionsError(null);
        },
        (err) => {
          setRestrictionsStatus('error');
          setRestrictionsError(err.message);
        },
        () => {
          restrictionsFallbackRef.current = true;
        }
      ),
    ];

    if (activeRole === 'executive' || activeRole === 'manager') {
      setLiveMyRequests([]);
      unsubscribers.push(
        subscribeAllRequests((items) => {
          setLiveAllRequests(items);
          setLoadingRequests(false);
        }, onSubError),
        subscribeAllStaff(setLiveProfiles, onSubError)
      );
    } else {
      setLiveAllRequests([]);
      setLiveProfiles([]);
      unsubscribers.push(
        subscribeStaffProfile(
          activeStaffId,
          (updated) => {
            if (!updated || !updated.isActive) {
              void logoutSession().catch(() => undefined);
              clearSignedInState();
              setAuthErrorBanner('Your staff account is inactive or unavailable.');
              return;
            }
            setLiveProfile(updated);
          },
          onSubError
        ),
        subscribeMyRequests(
          activeStaffId,
          (items) => {
            setLiveMyRequests(items);
            setLoadingRequests(false);
          },
          onSubError
        )
      );
    }

    if (activeRole !== 'manager') {
      setLiveAuditLogs([]);
    }

    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }, [activeStaffId, activeRole, reportSyncError, clearSignedInState]);

  // Keep active Executive/Manager profile synchronized from liveProfiles without duplicate doc listener
  useEffect(() => {
    if (
      !activeStaffId ||
      (activeRole !== 'executive' && activeRole !== 'manager') ||
      liveProfiles.length === 0
    ) {
      return;
    }
    const updated = liveProfiles.find((p) => p.staffId === activeStaffId);
    if (!updated || !updated.isActive) {
      void logoutSession().catch(() => undefined);
      clearSignedInState();
      setAuthErrorBanner('Your staff account is inactive or unavailable.');
      return;
    }
    setLiveProfile((prev) => {
      if (
        prev &&
        prev.staffId === updated.staffId &&
        prev.fullName === updated.fullName &&
        prev.designation === updated.designation &&
        prev.role === updated.role &&
        prev.isActive === updated.isActive &&
        prev.mustChangePassword === updated.mustChangePassword &&
        prev.unitSection === updated.unitSection &&
        prev.annualPeriodLimit === updated.annualPeriodLimit &&
        prev.countsTowardDailyCap === updated.countsTowardDailyCap
      ) {
        return prev;
      }
      return updated;
    });
  }, [activeStaffId, activeRole, liveProfiles, clearSignedInState]);

  // Lazy real-time audit log listener: only active when Manager opens the Audit Logs tab
  useEffect(() => {
    if (!activeStaffId || activeRole !== 'manager' || activeView !== 'audit') {
      return;
    }
    const unsub = subscribeAuditLogs(setLiveAuditLogs, (err) => {
      reportSyncError('Audit Log Sync Error', err);
    });
    return () => {
      unsub();
    };
  }, [activeStaffId, activeRole, activeView, reportSyncError]);

  // Real-time listeners for active calendar month capacity (debounced + cached across months)
  useEffect(() => {
    if (!activeStaffId) return;

    const monthPrefix = `${calendarYear}-${String(calendarMonth0 + 1).padStart(2, '0')}-`;
    let unsubCap: (() => void) | null = null;
    let unsubDetails: (() => void) | null = null;
    let cancelled = false;

    const onMonthError = (err: Error) => {
      reportSyncError('Calendar Sync Error', err);
    };

    const timerId = window.setTimeout(() => {
      if (cancelled) return;
      unsubCap = subscribeMonthCapacity(
        calendarYear,
        calendarMonth0,
        (monthMap) => {
          setLiveCapacityMap((prev) => {
            const next: Record<string, DailyCapacity> = {};
            for (const [k, v] of Object.entries(prev)) {
              if (!k.startsWith(monthPrefix)) {
                next[k] = v;
              }
            }
            return { ...next, ...monthMap };
          });
        },
        onMonthError
      );
      unsubDetails = subscribeMonthCapacityDetails(
        calendarYear,
        calendarMonth0,
        (monthDetails) => {
          setLiveCapacityDetailsMap((prev) => {
            const next: Record<string, DailyCapacityDetail> = {};
            for (const [k, v] of Object.entries(prev)) {
              if (!k.startsWith(monthPrefix)) {
                next[k] = v;
              }
            }
            return { ...next, ...monthDetails };
          });
        },
        onMonthError
      );
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
      unsubCap?.();
      unsubDetails?.();
    };
  }, [activeStaffId, calendarYear, calendarMonth0, reportSyncError]);

  // One-time automatic backfill restricted to Manager sessions only
  useEffect(() => {
    if (
      !activeStaffId ||
      activeRole !== 'manager' ||
      !settingsLoaded ||
      (!needsCapacitySync && liveSettings.pendingReservesCapacity) ||
      syncedPendingRef.current
    ) {
      return;
    }
    syncedPendingRef.current = true;
    void syncPendingCapacity(false).catch(() => {
      syncedPendingRef.current = false;
    });
  }, [
    activeStaffId,
    activeRole,
    settingsLoaded,
    needsCapacitySync,
    liveSettings.pendingReservesCapacity,
  ]);

  const handleLoginSuccess = (user: StaffProfile) => {
    setAuthErrorBanner(null);
    setLiveProfile(user);
    setActiveView('dashboard');
  };

  const handleSignOut = async () => {
    try {
      await logoutSession();
    } catch {
      // Ignore network errors on logout and clear local state
    }
    clearSignedInState();
    setActiveView('dashboard');
  };

  // For regular staff, allRequests represents their own requests (colleagues' approved
  // spans are merged in StaffDashboard from public non-PII dailyCapacityDetails).
  const effectiveMyRequests = useMemo(() => {
    if (!liveProfile) return [];
    if (liveProfile.role === 'executive' || liveProfile.role === 'manager') {
      return liveAllRequests.filter((r) => r.staffId === liveProfile.staffId);
    }
    return liveMyRequests;
  }, [liveProfile, liveAllRequests, liveMyRequests]);

  const activeAllRequests = useMemo(() => {
    if (!liveProfile) return [];
    if (liveProfile.role === 'executive' || liveProfile.role === 'manager') {
      return liveAllRequests;
    }
    return liveMyRequests;
  }, [liveProfile, liveAllRequests, liveMyRequests]);

  const pendingDemandMap = useMemo(
    () => buildPendingDemandMap(activeAllRequests),
    [activeAllRequests]
  );

  const pendingQueueCount = useMemo(
    () =>
      activeAllRequests.filter(
        (r) =>
          r.status === 'pending' ||
          (r.status === 'approved' && r.modificationRequestType !== 'none')
      ).length,
    [activeAllRequests]
  );

  const refreshRestrictions = useCallback(async (): Promise<LeaveRestriction[]> => {
    try {
      const items = await loadActiveRestrictionsStrict(true);
      setLiveRestrictions(items);
      setRestrictionsStatus('ready');
      setRestrictionsError(null);
      return items;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Unable to load leave date restrictions. Please try again.';
      setRestrictionsStatus('error');
      setRestrictionsError(msg);
      throw err instanceof Error ? err : new Error(msg);
    }
  }, []);

  const handleOpenNewRequest = (start?: string, end?: string) => {
    setPrefillStart(start);
    setPrefillEnd(end);
    setNewReqModalOpen(true);
    if (restrictionsStatus === 'error' || restrictionsFallbackRef.current) {
      void refreshRestrictions().catch(() => undefined);
    }
  };

  // Keep activeView authorized if role changes in real time
  useEffect(() => {
    if (!liveProfile) return;
    if (
      liveProfile.role === 'staff' &&
      ['management', 'directory', 'reports', 'admin', 'audit', 'deployment'].includes(
        activeView
      )
    ) {
      setActiveView('dashboard');
    } else if (
      liveProfile.role === 'executive' &&
      ['admin', 'audit', 'deployment'].includes(activeView)
    ) {
      setActiveView('dashboard');
    }
  }, [liveProfile, activeView]);

  // Real-time Firestore Action Handlers
  const handleSubmitLeave = async (payload: {
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    dates: string[];
    reason: string;
  }) => {
    if (!liveProfile) return;
    await submitLeaveRequest(liveProfile, {
      leaveType: payload.leaveType,
      startDate: payload.startDate,
      endDate: payload.endDate,
      reason: payload.reason,
    });
    addToast(
      'success',
      'Leave Request Submitted',
      `${payload.dates.length} day(s) submitted and daily slots reserved while Pending.`
    );
  };

  const handleCancelPending = async (req: LeaveRequest) => {
    if (!liveProfile) return;
    await cancelPendingLeaveRequest(liveProfile, req);
    addToast(
      'info',
      'Pending Request Cancelled',
      'Reserved daily slots have been released.'
    );
  };

  const handleEditPending = async (
    req: LeaveRequest,
    payload: { startDate: string; endDate: string }
  ) => {
    if (!liveProfile) return;
    const res = await editPendingLeaveDates(liveProfile, req, payload);
    addToast(
      'success',
      'Leave Dates Updated',
      `Pending leave updated to ${res.startDate} – ${res.endDate} (${res.daysCount} day${res.daysCount === 1 ? '' : 's'}).`
    );
  };

  const handleRequestModification = async (params: {
    req: LeaveRequest;
    type: 'edit' | 'cancel';
    note: string;
    requestedStartDate?: string;
    requestedEndDate?: string;
  }) => {
    if (!liveProfile) return;
    await requestLeaveModification(
      liveProfile,
      params.req,
      {
        type: params.type,
        note: params.note,
        requestedStartDate: params.requestedStartDate,
        requestedEndDate: params.requestedEndDate,
      },
      {
        existingUserRequests: effectiveMyRequests,
        cachedRestrictions: liveRestrictions,
        settings: liveSettings,
      }
    );
    addToast('success', 'Modification Request Sent', 'Management will review your request.');
  };

  const handleApproveLeave = async (requestId: string, comment: string) => {
    if (!liveProfile) return;
    await approveLeaveRequest(liveProfile, requestId, comment, liveSettings);
    addToast('success', 'Leave Approved', 'Daily capacity counters updated atomically.');
  };

  const handleRejectLeave = async (requestId: string, comment: string) => {
    if (!liveProfile) return;
    await rejectLeaveRequest(liveProfile, requestId, comment);
    addToast('info', 'Leave Request Rejected');
  };

  const handleProcessModification = async (
    requestId: string,
    decision: 'approve_cancel' | 'approve_edit' | 'decline_modification',
    comment: string
  ) => {
    if (!liveProfile) return;
    await processLeaveModification(
      liveProfile,
      requestId,
      decision,
      comment,
      liveSettings
    );
    addToast('success', 'Modification Processed', 'Daily slots and audit log updated.');
  };

  const handleRemoveApprovedLeave = async (requestId: string) => {
    if (!liveProfile) return;
    try {
      await removeApprovedLeaveRequest(requestId);
      addToast(
        'success',
        'Approved Leave Removed',
        'Leave marked as Cancelled and all occupied daily slots released.'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to remove approved leave.';
      addToast('error', 'Failed to Remove Leave', msg);
      throw err;
    }
  };

  const handleManagerAddLeave = async (payload: {
    staffId: string;
    startDate: string;
    endDate: string;
    reason: string;
    confirmOverlap: boolean;
  }) => {
    if (!liveProfile || liveProfile.role !== 'manager') return;
    await managerAddApprovedLeave(payload);
    addToast(
      'success',
      'Approved Leave Added',
      `Approved leave assigned for ${payload.staffId} (${payload.startDate} – ${payload.endDate}).`
    );
  };

  const handleUpdateStaff = async (
    target: StaffProfile,
    updates: {
      fullName: string;
      designation: Designation;
      role: UserRole;
      isActive: boolean;
      unitSection: string;
      annualPeriodLimit: number;
    }
  ) => {
    if (!liveProfile) return;
    await updateStaffProfile(liveProfile, target, updates);
    addToast('success', 'Staff Updated', `${target.staffId} permissions updated.`);
  };

  const handleRemoveStaff = async (target: StaffProfile) => {
    if (!liveProfile) return;
    const res = await removeStaffAccount(liveProfile, target);
    addToast(
      'info',
      'Staff Account Removed',
      `${target.fullName} (${target.staffId}) removed (${res.removedRequests} leave record(s) cleaned up).`
    );
  };

  const handleChangePassword = async (
    currentPassword: string,
    newPassword: string
  ) => {
    if (!liveProfile) return;
    await changeOwnPassword(liveProfile, currentPassword, newPassword);
    setLiveProfile((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
    setChangePwdModalOpen(false);
    addToast(
      'success',
      'PIN Updated',
      'Your personal PIN has been saved centrally and applies on every device.'
    );
  };

  const handleResetStaffPin = async (target: StaffProfile, tempPin: string) => {
    await resetStaffPinByManager(target.staffId, tempPin);
    addToast(
      'success',
      'Temporary PIN Assigned',
      `${target.fullName} (${target.staffId}) must set a new personal PIN on next login.`
    );
  };

  const handleAddStaff = async (payload: {
    staffId: string;
    fullName: string;
    designation: Designation;
    role: UserRole;
  }) => {
    await addStaffByManager(payload);
    addToast(
      'success',
      'Staff Account Added',
      `${payload.fullName.trim()} (${payload.staffId.trim()}) can now sign in with default PIN 1234.`
    );
  };

  const handleUpdateSettings = async (next: {
    maxDailyCombinedCap: number;
    maxExecutiveDailyCap: number;
    maxAnnualLeavePeriods: number;
  }) => {
    if (!liveProfile) return;
    await updatePortalSettings(liveProfile, next);
    addToast('success', 'Portal Settings Saved');
  };

  const handleSaveRestriction = async (payload: {
    restrictionId?: string;
    startDate: string;
    endDate: string;
    targetType: RestrictionTargetType;
    targetStaffIds: string[];
    reason: string;
    isActive: boolean;
  }) => {
    const saved = await saveLeaveRestriction(payload);
    if (restrictionsFallbackRef.current) {
      const fresh = await fetchLeaveRestrictionsFromWorker().catch(() => null);
      if (fresh) {
        setLiveRestrictions(fresh);
      } else {
        setLiveRestrictions((prev) => {
          const rest = prev.filter((r) => r.restrictionId !== saved.restrictionId);
          return [saved, ...rest].sort((a, b) => b.startDate.localeCompare(a.startDate));
        });
      }
    }
    addToast(
      'success',
      payload.restrictionId ? 'Restriction Updated' : 'Restriction Saved',
      `Blocked period ${payload.startDate} – ${payload.endDate} saved.`
    );
  };

  const handleDeleteRestriction = async (restrictionId: string) => {
    await deleteLeaveRestriction(restrictionId);
    if (restrictionsFallbackRef.current) {
      setLiveRestrictions((prev) => prev.filter((r) => r.restrictionId !== restrictionId));
    }
    addToast('info', 'Restriction Removed', 'Dates are now open subject to daily capacity.');
  };

  const handleClearAllLeaveRecords = async (confirmation: string) => {
    const result = await clearAllLeaveRecords(confirmation);
    setLiveCapacityMap({});
    setLiveCapacityDetailsMap({});
    addToast(
      'success',
      'All Leave Records Cleared',
      `${result.deletedRequests} leave application(s) and ${result.deletedCapacityDocs} daily slot counter(s) reset to zero.`
    );
    return result;
  };

  // Loading state during Firebase Auth initialization
  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-[#07111E] flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
            Initializing Special Services Leave Management Portal...
          </p>
        </div>
      </div>
    );
  }

  // Unauthenticated -> Staff ID & Password Login Screen
  if (!liveProfile) {
    return (
      <LoginScreen
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((d) => !d)}
        onLoginSuccess={handleLoginSuccess}
        authErrorBanner={authErrorBanner}
      />
    );
  }

  const mustForcePasswordChange = Boolean(liveProfile.mustChangePassword);

  return (
    <PortalShell
      profile={liveProfile}
      activeView={activeView}
      onChangeView={setActiveView}
      onOpenNewRequest={handleOpenNewRequest}
      darkMode={darkMode}
      onToggleDarkMode={() => setDarkMode((d) => !d)}
      onSignOut={handleSignOut}
      onOpenChangePassword={() => setChangePwdModalOpen(true)}
      toasts={toasts}
      onDismissToast={dismissToast}
      pendingQueueCount={pendingQueueCount}
    >
      {activeView === 'dashboard' && (
        <StaffDashboard
          profile={liveProfile}
          allRequests={activeAllRequests}
          profiles={liveProfiles}
          capacityMap={liveCapacityMap}
          capacityDetailsMap={liveCapacityDetailsMap}
          settings={liveSettings}
          restrictions={liveRestrictions}
          calendarYear={calendarYear}
          calendarMonth0={calendarMonth0}
          onChangeMonth={(y, m0) => {
            setCalendarYear(y);
            setCalendarMonth0(m0);
          }}
          onOpenNewRequest={handleOpenNewRequest}
          loading={loadingRequests}
        />
      )}

      {activeView === 'calendar' && (
        <LeaveCalendar
          year={calendarYear}
          monthIndex0={calendarMonth0}
          onChangeMonth={(y, m0) => {
            setCalendarYear(y);
            setCalendarMonth0(m0);
          }}
          capacityMap={liveCapacityMap}
          capacityDetailsMap={liveCapacityDetailsMap}
          pendingDemandMap={pendingDemandMap}
          allRequests={activeAllRequests}
          currentProfile={liveProfile}
          settings={liveSettings}
          restrictions={liveRestrictions}
          onRequestRange={handleOpenNewRequest}
        />
      )}

      {activeView === 'requests' && (
        <MyRequestsView
          profile={liveProfile}
          requests={effectiveMyRequests}
          allRequests={activeAllRequests}
          restrictions={liveRestrictions}
          capacityMap={liveCapacityMap}
          capacityDetailsMap={liveCapacityDetailsMap}
          pendingDemandMap={pendingDemandMap}
          settings={liveSettings}
          loading={loadingRequests}
          onOpenNewRequest={() => handleOpenNewRequest()}
          onEditPending={handleEditPending}
          onCancelPending={handleCancelPending}
          onRequestModification={handleRequestModification}
        />
      )}

      {activeView === 'management' &&
        (liveProfile.role === 'executive' || liveProfile.role === 'manager') && (
          <ManagementQueueView
            currentProfile={liveProfile}
            profiles={liveProfiles}
            allRequests={activeAllRequests}
            capacityMap={liveCapacityMap}
            capacityDetailsMap={liveCapacityDetailsMap}
            settings={liveSettings}
            onApprove={handleApproveLeave}
            onReject={handleRejectLeave}
            onProcessModification={handleProcessModification}
            onRemoveApproved={handleRemoveApprovedLeave}
            onManagerAddLeave={
              liveProfile.role === 'manager' ? handleManagerAddLeave : undefined
            }
          />
        )}

      {activeView === 'directory' &&
        (liveProfile.role === 'executive' || liveProfile.role === 'manager') && (
          <StaffDirectoryView
            profiles={liveProfiles}
            allRequests={activeAllRequests}
          />
        )}

      {activeView === 'reports' &&
        (liveProfile.role === 'executive' || liveProfile.role === 'manager') && (
          <ReportsView
            allRequests={activeAllRequests}
            profiles={liveProfiles}
          />
        )}

      {activeView === 'admin' && liveProfile.role === 'manager' && (
        <AdministrationView
          currentProfile={liveProfile}
          profiles={liveProfiles}
          allRequests={activeAllRequests}
          settings={liveSettings}
          restrictions={liveRestrictions}
          onAddStaff={handleAddStaff}
          onUpdateStaff={handleUpdateStaff}
          onRemoveStaff={handleRemoveStaff}
          onResetStaffPin={handleResetStaffPin}
          onUpdateSettings={handleUpdateSettings}
          onSaveRestriction={handleSaveRestriction}
          onDeleteRestriction={handleDeleteRestriction}
        />
      )}

      {activeView === 'audit' && liveProfile.role === 'manager' && (
        <AuditLogsView logs={liveAuditLogs} />
      )}

      {activeView === 'deployment' && liveProfile.role === 'manager' && (
        <DeploymentSecurityView
          currentProfile={liveProfile}
          onClearAllLeaveRecords={handleClearAllLeaveRecords}
        />
      )}

      <LeaveRequestModal
        open={newReqModalOpen}
        onClose={() => setNewReqModalOpen(false)}
        staff={liveProfile}
        userRequests={effectiveMyRequests}
        allRequests={activeAllRequests}
        capacityMap={liveCapacityMap}
        capacityDetailsMap={liveCapacityDetailsMap}
        pendingDemandMap={pendingDemandMap}
        settings={liveSettings}
        restrictions={liveRestrictions}
        restrictionsStatus={restrictionsStatus}
        restrictionsError={restrictionsError}
        onRefreshRestrictions={refreshRestrictions}
        initialStartDate={prefillStart}
        initialEndDate={prefillEnd}
        onSubmit={handleSubmitLeave}
      />

      <ChangePasswordModal
        open={mustForcePasswordChange || changePwdModalOpen}
        forced={mustForcePasswordChange}
        profile={liveProfile}
        onSubmit={handleChangePassword}
        onClose={() => setChangePwdModalOpen(false)}
        onSignOut={handleSignOut}
      />
    </PortalShell>
  );
}
