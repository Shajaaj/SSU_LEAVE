import React, { useState } from 'react';
import {
  AlertCircle,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  ShieldCheck,
  X,
} from 'lucide-react';
import { StaffProfile } from '../types/portal';
import { isValidPinFormat } from '../utils/staffAuthId';

interface ChangePasswordModalProps {
  open: boolean;
  forced: boolean;
  profile: StaffProfile;
  onSubmit: (currentPin: string, newPin: string) => Promise<void>;
  onClose?: () => void;
  onSignOut?: () => void;
}

export const ChangePasswordModal: React.FC<ChangePasswordModalProps> = ({
  open,
  forced,
  profile,
  onSubmit,
  onClose,
  onSignOut,
}) => {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedCurrent = currentPin.trim();
    const trimmedNew = newPin.trim();
    const trimmedConfirm = confirmPin.trim();

    if (!isValidPinFormat(trimmedCurrent)) {
      setError('Current PIN must be 4 to 12 numeric digits.');
      return;
    }
    if (!isValidPinFormat(trimmedNew)) {
      setError('New PIN must be 4 to 12 numeric digits.');
      return;
    }
    if (trimmedNew === trimmedCurrent) {
      setError('New PIN must be different from your current PIN.');
      return;
    }
    if (trimmedNew !== trimmedConfirm) {
      setError('New PIN and confirmation do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(trimmedCurrent, trimmedNew);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-password-title"
    >
      <div className="bg-white dark:bg-[#0D1B2A] border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 sm:p-6 space-y-5 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-teal-700 dark:text-teal-400">
              <KeyRound className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="text-xs font-semibold uppercase tracking-wider">
                {forced ? 'First Login Security Step' : 'Account Security'}
              </span>
            </div>
            <h2
              id="update-password-title"
              className="text-lg font-display font-bold text-[#0B1F3A] dark:text-white"
            >
              {forced ? 'Set Your Personal PIN' : 'Change PIN'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
              {profile.staffId} · {profile.fullName} · {profile.designation}
            </p>
          </div>

          {!forced && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 flex items-center justify-center p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Close modal"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
          {forced
            ? 'You signed in using an initial temporary PIN. Before accessing your dashboard and leave actions, please choose your own personal numeric PIN (4 to 12 digits).'
            : 'Update your personal numeric PIN. Your updated PIN is hashed on our Cloudflare Worker backend and synced across all devices.'}
        </p>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-xs text-red-800 dark:text-red-300"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="cp-current"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Current PIN {forced ? '(Initial PIN)' : ''}
            </label>
            <div className="relative">
              <input
                id="cp-current"
                type={showCurrent ? 'text' : 'password'}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={12}
                autoComplete="current-password"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))}
                placeholder={forced ? 'Enter initial PIN' : 'Enter current PIN'}
                className="w-full min-h-[44px] sm:min-h-0 pl-3.5 pr-10 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm font-mono tracking-widest"
                required
              />
              <button
                type="button"
                onClick={() => setShowCurrent((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                aria-label={showCurrent ? 'Hide current PIN' : 'Show current PIN'}
              >
                {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="cp-new"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
            >
              New Numeric PIN (4 to 12 digits)
            </label>
            <div className="relative">
              <input
                id="cp-new"
                type={showNew ? 'text' : 'password'}
                inputMode="numeric"
                pattern="[0-9]*"
                minLength={4}
                maxLength={12}
                autoComplete="new-password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Enter 4 to 12 digit PIN"
                className="w-full min-h-[44px] sm:min-h-0 pl-3.5 pr-10 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm font-mono tracking-widest"
                required
              />
              <button
                type="button"
                onClick={() => setShowNew((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                aria-label={showNew ? 'Hide new PIN' : 'Show new PIN'}
              >
                {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="cp-confirm"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
            >
              Confirm New PIN
            </label>
            <div className="relative">
              <input
                id="cp-confirm"
                type={showConfirm ? 'text' : 'password'}
                inputMode="numeric"
                pattern="[0-9]*"
                minLength={4}
                maxLength={12}
                autoComplete="new-password"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Re-enter your new PIN"
                className="w-full min-h-[44px] sm:min-h-0 pl-3.5 pr-10 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#07111E] text-base sm:text-sm font-mono tracking-widest"
                required
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                aria-label={showConfirm ? 'Hide confirm PIN' : 'Show confirm PIN'}
              >
                {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            {forced && onSignOut ? (
              <button
                type="button"
                onClick={onSignOut}
                className="min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
              >
                <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Sign Out</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="min-h-[44px] sm:min-h-0 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold"
              >
                Cancel
              </button>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="min-h-[44px] sm:min-h-0 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold disabled:opacity-60 flex items-center gap-1.5 whitespace-nowrap"
            >
              <ShieldCheck className="w-4 h-4" aria-hidden="true" />
              <span>{submitting ? 'Updating...' : 'Save New PIN'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
