import React from 'react';
import { CalendarOff, X } from 'lucide-react';
import { LeaveRestriction } from '../types/portal';
import { formatDisplayDate } from '../utils/maldivesDate';
import { formatLongDate } from '../utils/leaveRestrictions';

interface LeaveRestrictedPopupProps {
  open: boolean;
  blockedDates: string[];
  matchedRestrictions: LeaveRestriction[];
  onClose: () => void;
}

export const LeaveRestrictedPopup: React.FC<LeaveRestrictedPopupProps> = ({
  open,
  blockedDates,
  matchedRestrictions,
  onClose,
}) => {
  if (!open || matchedRestrictions.length === 0) return null;

  const primary = matchedRestrictions[0];

  return (
    <div
      className="fixed inset-0 z-[70] bg-slate-950/65 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="leave-restricted-popup-title"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-[#0D1B2A] border border-red-200 dark:border-red-900/60 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-300 flex items-center justify-center shrink-0">
              <CalendarOff className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h3
                id="leave-restricted-popup-title"
                className="text-base font-display font-bold text-[#0B1F3A] dark:text-white"
              >
                Leave Application Restricted
              </h3>
              <p className="text-xs text-red-700 dark:text-red-300 font-medium mt-0.5">
                Blocked operational period selected
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close restriction notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 rounded-lg bg-red-50/80 dark:bg-red-950/35 border border-red-200 dark:border-red-900/50 space-y-3 text-xs sm:text-sm text-slate-800 dark:text-slate-100">
          <p className="leading-relaxed font-semibold text-red-900 dark:text-red-100">
            You are not permitted to apply for leave during the selected dates.
          </p>
          {matchedRestrictions.length === 1 ? (
            <>
              <p className="text-xs text-slate-700 dark:text-slate-300">
                Restricted period:{' '}
                <span className="font-semibold">
                  {primary.startDate === primary.endDate
                    ? formatLongDate(primary.startDate)
                    : `${formatLongDate(primary.startDate)} to ${formatLongDate(primary.endDate)}`}
                </span>
              </p>
              <p className="text-xs sm:text-sm">
                <span className="font-bold text-slate-900 dark:text-white">Reason:</span>{' '}
                <span>{primary.reason}</span>
              </p>
            </>
          ) : (
            <div className="space-y-2.5">
              <p className="font-medium leading-relaxed text-xs">
                Your selected range overlaps {matchedRestrictions.length} restricted leave periods:
              </p>
              <ul className="space-y-2">
                {matchedRestrictions.map((r) => (
                  <li
                    key={r.restrictionId}
                    className="p-2.5 rounded-md bg-white/80 dark:bg-[#07111E]/80 border border-red-200/70 dark:border-red-900/40 text-xs space-y-1"
                  >
                    <p className="font-semibold text-slate-900 dark:text-white">
                      {r.startDate === r.endDate
                        ? formatLongDate(r.startDate)
                        : `${formatLongDate(r.startDate)} to ${formatLongDate(r.endDate)}`}
                    </p>
                    <p className="text-slate-700 dark:text-slate-300">
                      <span className="font-bold">Reason:</span> {r.reason}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {blockedDates.length > 0 && (
            <p className="text-[11px] font-mono text-red-800 dark:text-red-300 pt-1 border-t border-red-200/70 dark:border-red-900/40">
              Conflicting date{blockedDates.length > 1 ? 's' : ''}:{' '}
              {blockedDates.slice(0, 6).map(formatDisplayDate).join(', ')}
              {blockedDates.length > 6 ? ` (+${blockedDates.length - 6} more)` : ''}
            </p>
          )}
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-300 font-medium">
          Please select alternative dates.
        </p>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-[#0B1F3A] dark:bg-teal-600 hover:bg-[#14325B] dark:hover:bg-teal-700 text-white text-xs font-semibold transition-colors"
          >
            Choose Alternative Dates
          </button>
        </div>
      </div>
    </div>
  );
};
