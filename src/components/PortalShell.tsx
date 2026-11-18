import React, { useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileSpreadsheet,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plane,
  Plus,
  Settings,
  ShieldAlert,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { PortalView, StaffProfile, ToastMessage } from '../types/portal';
import { getCurrentMaldivesTimeDisplay } from '../utils/maldivesDate';

interface PortalShellProps {
  profile: StaffProfile;
  activeView: PortalView;
  onChangeView: (view: PortalView) => void;
  onOpenNewRequest: (prefillStart?: string, prefillEnd?: string) => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onSignOut: () => void;
  onOpenChangePassword?: () => void;
  toasts: ToastMessage[];
  onDismissToast: (id: string) => void;
  pendingQueueCount: number;
  children: React.ReactNode;
}

interface NavItem {
  id: PortalView;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  minRole: 'staff' | 'executive' | 'manager';
  badge?: number;
}

export const PortalShell: React.FC<PortalShellProps> = ({
  profile,
  activeView,
  onChangeView,
  onOpenNewRequest,
  darkMode,
  onToggleDarkMode,
  onSignOut,
  onOpenChangePassword,
  toasts,
  onDismissToast,
  pendingQueueCount,
  children,
}) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems: NavItem[] = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      shortLabel: 'Home',
      icon: LayoutDashboard,
      minRole: 'staff',
    },
    {
      id: 'calendar',
      label: 'Leave Calendar',
      shortLabel: 'Calendar',
      icon: CalendarDays,
      minRole: 'staff',
    },
    {
      id: 'requests',
      label: 'My Leave',
      shortLabel: 'My Leave',
      icon: ClipboardList,
      minRole: 'staff',
    },
    {
      id: 'management',
      label: 'Approvals Queue',
      shortLabel: 'Approvals',
      icon: BarChart3,
      minRole: 'executive',
      badge: pendingQueueCount > 0 ? pendingQueueCount : undefined,
    },
    {
      id: 'directory',
      label: 'Staff Directory',
      shortLabel: 'Staff',
      icon: Users,
      minRole: 'executive',
    },
    {
      id: 'reports',
      label: 'Reports & CSV',
      shortLabel: 'Reports',
      icon: FileSpreadsheet,
      minRole: 'executive',
    },
    {
      id: 'admin',
      label: 'Administration',
      shortLabel: 'Admin',
      icon: Settings,
      minRole: 'manager',
    },
    {
      id: 'audit',
      label: 'Audit Logs',
      shortLabel: 'Audit',
      icon: History,
      minRole: 'manager',
    },
    {
      id: 'deployment',
      label: 'Security & Setup',
      shortLabel: 'Security',
      icon: ShieldAlert,
      minRole: 'manager',
    },
  ];

  const allowedNavItems = navItems.filter((item) => {
    if (item.minRole === 'staff') return true;
    if (item.minRole === 'executive') {
      return profile.role === 'executive' || profile.role === 'manager';
    }
    return profile.role === 'manager';
  });

  const hasExtraMobileItems =
    allowedNavItems.length > 4 || Boolean(onOpenChangePassword);
  const primaryMobileNav = hasExtraMobileItems
    ? allowedNavItems.slice(0, 4)
    : allowedNavItems.slice(0, 4);
  const overflowMobileNav = allowedNavItems.slice(4);
  const isOverflowViewActive = overflowMobileNav.some((i) => i.id === activeView);

  const activeNavMeta = allowedNavItems.find((i) => i.id === activeView);

  return (
    <div
      className={`${
        activeView === 'dashboard' ? 'min-h-screen lg:h-screen lg:overflow-hidden' : 'min-h-screen'
      } bg-slate-50 dark:bg-[#07111E] text-slate-900 dark:text-slate-100 flex`}
    >
      {/* Desktop Collapsible Sidebar */}
      <aside
        className={`hidden lg:flex flex-col shrink-0 bg-[#0B1F3A] text-slate-100 border-r border-slate-800 transition-all duration-200 ${
          sidebarCollapsed ? 'w-[76px]' : 'w-[260px]'
        }`}
        aria-label="Primary sidebar navigation"
      >
        <div className="h-16 px-4 flex items-center justify-between border-b border-white/10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-teal-600 flex items-center justify-center text-white shrink-0">
              <Plane className="w-4 h-4" aria-hidden="true" />
            </div>
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <p className="font-display font-bold text-sm leading-tight truncate text-white">
                  Special Services
                </p>
                <p className="text-[11px] text-slate-300 truncate">
                  Velana Intl Airport
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSidebarCollapsed((c) => !c)}
            className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/10 transition-colors shrink-0"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {allowedNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onChangeView(item.id)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-teal-600 text-white'
                    : 'text-slate-300 hover:text-white hover:bg-white/10'
                }`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  {!sidebarCollapsed && (
                    <span className="truncate whitespace-nowrap">{item.label}</span>
                  )}
                </span>
                {!sidebarCollapsed && item.badge !== undefined && (
                  <span className="text-xs font-mono tabular-nums font-semibold text-amber-300">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User Footer inside Sidebar */}
        <div className="p-3 border-t border-white/10 space-y-3">
          {!sidebarCollapsed ? (
            <div className="px-2 py-1 space-y-0.5">
              <p className="text-sm font-semibold text-white truncate">
                {profile.fullName}
              </p>
              <p className="text-xs text-slate-300 font-mono truncate">
                {profile.staffId} · {profile.role}
              </p>
              <p className="text-[11px] text-slate-400 truncate">
                {profile.designation} · {profile.unitSection}
              </p>
            </div>
          ) : (
            <div className="flex justify-center">
              <span
                className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center text-xs font-mono font-bold text-teal-300"
                title={`${profile.fullName} (${profile.staffId})`}
              >
                {profile.fullName
                  .split(' ')
                  .map((p) => p[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </span>
            </div>
          )}

          {onOpenChangePassword && (
            <button
              type="button"
              onClick={onOpenChangePassword}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 transition-colors whitespace-nowrap"
              title="Change PIN"
            >
              <KeyRound className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              {!sidebarCollapsed && <span>Change PIN</span>}
            </button>
          )}

          <button
            type="button"
            onClick={onSignOut}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-slate-200 hover:text-white bg-white/5 hover:bg-white/15 transition-colors whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {!sidebarCollapsed && <span>Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 pb-20 lg:pb-0">
        {/* Top Bar (3-zone contract: Breadcrumb — Primary Action & Theme — Signout on mobile) */}
        <header className="sticky top-0 z-30 h-14 sm:h-16 bg-white/95 dark:bg-[#0D1B2A]/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 px-3 sm:px-6 flex items-center justify-between gap-2 sm:gap-4 shrink-0">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <span className="lg:hidden w-8 h-8 rounded-lg bg-[#0B1F3A] dark:bg-teal-600 text-white flex items-center justify-center shrink-0">
              <Plane className="w-4 h-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-sm sm:text-lg font-display font-bold text-[#0B1F3A] dark:text-white truncate">
                {activeNavMeta?.label || 'Dashboard'}
              </h1>
              <p className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                <span className="sm:hidden">
                  {profile.staffId} · {profile.designation}
                </span>
                <span className="hidden sm:inline">
                  {getCurrentMaldivesTimeDisplay()} · {profile.staffId} · {profile.designation}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => onOpenNewRequest()}
              className="min-h-[40px] px-3 sm:px-3.5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="sm:hidden">Apply</span>
              <span className="hidden sm:inline">New Leave Request</span>
            </button>
            <button
              type="button"
              onClick={onToggleDarkMode}
              className="min-h-[40px] min-w-[40px] p-2 sm:p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center justify-center shrink-0"
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="lg:hidden min-h-[40px] min-w-[40px] p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center justify-center shrink-0"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Toast Stack */}
        {toasts.length > 0 && (
          <div
            className="fixed bottom-20 lg:bottom-6 right-4 sm:right-6 z-50 space-y-2 max-w-sm w-[calc(100%-2rem)]"
            aria-live="polite"
          >
            {toasts.map((t) => (
              <div
                key={t.id}
                className={`p-3.5 rounded-xl border shadow-lg flex items-start justify-between gap-3 text-xs ${
                  t.type === 'success'
                    ? 'bg-white dark:bg-[#0D1B2A] border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                    : t.type === 'error'
                      ? 'bg-white dark:bg-[#0D1B2A] border-red-300 dark:border-red-800 text-red-900 dark:text-red-200'
                      : 'bg-white dark:bg-[#0D1B2A] border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100'
                }`}
              >
                <div className="space-y-0.5">
                  <p className="font-semibold">{t.title}</p>
                  {t.detail && (
                    <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                      {t.detail}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onDismissToast(t.id)}
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 font-semibold shrink-0"
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main Viewport */}
        <main
          className={
            activeView === 'dashboard'
              ? 'flex-1 w-full mx-auto px-3 sm:px-5 py-3 flex flex-col min-h-0 lg:overflow-hidden'
              : 'flex-1 max-w-[1360px] w-full mx-auto px-4 sm:px-6 py-6 space-y-6'
          }
        >
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation (<= 15% height, >= 44px touch targets) */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 h-16 bg-white/95 dark:bg-[#0D1B2A]/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 grid"
        style={{
          gridTemplateColumns: `repeat(${
            primaryMobileNav.length + (hasExtraMobileItems ? 1 : 0)
          }, minmax(0, 1fr))`,
        }}
        aria-label="Mobile bottom navigation"
      >
        {primaryMobileNav.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                onChangeView(item.id);
              }}
              className={`min-h-[44px] relative flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
                isActive
                  ? 'text-teal-700 dark:text-teal-400 font-semibold'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="truncate max-w-full px-1">{item.shortLabel}</span>
              {item.badge !== undefined && (
                <span className="absolute top-1.5 right-3 text-[9px] font-mono font-bold text-amber-600 dark:text-amber-400">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}

        {hasExtraMobileItems && (
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors ${
              mobileMenuOpen || isOverflowViewActive
                ? 'text-teal-700 dark:text-teal-400 font-semibold'
                : 'text-slate-500 dark:text-slate-400'
            }`}
            aria-expanded={mobileMenuOpen}
            aria-label="Open more menu"
          >
            <Menu className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>More</span>
          </button>
        )}
      </nav>

      {/* Mobile Overflow Bottom Sheet */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-[2px] flex items-end"
          onClick={() => setMobileMenuOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="More navigation options"
        >
          <div
            className="w-full bg-white dark:bg-[#0D1B2A] border-t border-slate-200 dark:border-slate-800 rounded-t-2xl p-4 pb-6 space-y-3 shadow-2xl max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto" />
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="min-w-0">
                <p className="text-sm font-bold text-[#0B1F3A] dark:text-white truncate">
                  {profile.fullName}
                </p>
                <p className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                  {profile.staffId} · {profile.designation} · {profile.role}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {overflowMobileNav.length > 0 && (
              <div className="space-y-1">
                {overflowMobileNav.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeView === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onChangeView(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full min-h-[48px] px-3.5 rounded-xl flex items-center justify-between gap-3 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-teal-600 text-white'
                          : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span>{item.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
              {onOpenChangePassword && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onOpenChangePassword();
                  }}
                  className="w-full min-h-[48px] px-3.5 rounded-xl flex items-center gap-3 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <KeyRound className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Change PIN</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onSignOut();
                }}
                className="w-full min-h-[48px] px-3.5 rounded-xl flex items-center gap-3 text-sm font-semibold text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
              >
                <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
