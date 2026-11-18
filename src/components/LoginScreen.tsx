import React, { useState } from 'react';
import {
  AlertCircle,
  Eye,
  EyeOff,
  Moon,
  Sun,
} from 'lucide-react';
import {
  getRememberedStaffId,
  loginWithStaffId,
} from '../services/firebasePortalService';
import { StaffProfile } from '../types/portal';
import {
  isValidPinFormat,
  isValidStaffIdFormat,
} from '../utils/staffAuthId';

interface LoginScreenProps {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onLoginSuccess: (user: StaffProfile) => void;
  authErrorBanner?: string | null;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({
  darkMode,
  onToggleDarkMode,
  onLoginSuccess,
  authErrorBanner,
}) => {
  const initialRemembered = getRememberedStaffId();
  const [staffId, setStaffId] = useState(initialRemembered);
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(Boolean(initialRemembered));
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = staffId.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedId = staffId.trim();
    const trimmedPin = password.trim();
    if (!isValidStaffIdFormat(trimmedId)) {
      setError('Enter a valid Staff ID (e.g. A-5530 or A10002).');
      return;
    }
    if (!isValidPinFormat(trimmedPin)) {
      setError('Enter your 4 to 12 digit numeric PIN.');
      return;
    }

    setSubmitting(true);
    try {
      const { user } = await loginWithStaffId(trimmedId, trimmedPin, rememberMe);
      onLoginSuccess(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid Staff ID or PIN.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-[#ECEFF3] dark:bg-[#07111E] text-slate-900 dark:text-slate-100 flex flex-col justify-between p-4 sm:p-6">
      {/* Subtle Faceted Cube Geometric Background matching reference */}
      <svg
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 w-full h-full opacity-55 dark:opacity-15"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern
            id="iso-cubes"
            width="120"
            height="138.56"
            patternUnits="userSpaceOnUse"
          >
            <polygon
              points="60,0 120,34.64 60,69.28 0,34.64"
              fill={darkMode ? '#132B47' : '#F8FAFC'}
            />
            <polygon
              points="0,34.64 60,69.28 60,138.56 0,103.92"
              fill={darkMode ? '#0D1E33' : '#E2E6EC'}
            />
            <polygon
              points="120,34.64 60,69.28 60,138.56 120,103.92"
              fill={darkMode ? '#091526' : '#ECEFF4'}
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#iso-cubes)" />
      </svg>

      {/* Top Corner Theme Switch */}
      <div className="relative z-10 flex justify-end">
        <button
          type="button"
          onClick={onToggleDarkMode}
          className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300/80 dark:border-slate-700 bg-white/80 dark:bg-[#0D1B2A]/80 backdrop-blur-xs text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 transition-colors flex items-center justify-center"
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>

      {/* Centered Login Column */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center py-6">
        <div className="w-full max-w-[320px] flex flex-col items-center">
          {/* Special Services Exact Emblem Logo */}
          <img
            src="/assets/ss-logo.png"
            alt="Special Services"
            width={109}
            height={109}
            className="w-[109px] h-[109px] object-contain select-none mb-6 shadow-xs"
            draggable={false}
          />

          {/* Calligraphic Title */}
          <h1
            className="text-center text-[28px] sm:text-[31px] leading-[1.25] text-slate-900 dark:text-white mb-7"
            style={{ fontFamily: "'Courgette', Georgia, cursive" }}
          >
            Special Services
            <br />
            Leave Management
          </h1>

          {/* Error / Status Banners */}
          {(authErrorBanner || error) && (
            <div
              role="alert"
              className="w-full mb-4 flex items-start gap-2 p-3 rounded-md bg-red-50 dark:bg-red-950/50 border border-red-300 dark:border-red-900/60 text-xs text-red-800 dark:text-red-200"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="leading-relaxed">{error || authErrorBanner}</p>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit} className="w-full space-y-3.5">
            <div>
              <label htmlFor="login-staff-id" className="sr-only">
                Staff ID
              </label>
              <input
                id="login-staff-id"
                type="text"
                autoComplete="username"
                autoCapitalize="characters"
                placeholder="Staff ID"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                className="w-full h-11 px-3.5 rounded-[3px] border-[1.5px] border-[#0B1F3A] dark:border-teal-500/80 bg-white dark:bg-[#0D1B2A] text-base sm:text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-500 dark:placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/50"
                required
              />
            </div>

            <div className="relative">
              <label htmlFor="login-password" className="sr-only">
                PIN
              </label>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                inputMode="numeric"
                autoComplete="current-password"
                placeholder="PIN"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-11 pl-3.5 pr-11 rounded-[3px] border-[1.5px] border-[#0B1F3A] dark:border-teal-500/80 bg-white dark:bg-[#0D1B2A] text-base sm:text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-500 dark:placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/50"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                aria-label={showPassword ? 'Hide PIN' : 'Show PIN'}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* Remember me on this device toggle */}
            <div className="pt-1 flex items-center justify-start">
              <button
                type="button"
                role="switch"
                aria-checked={rememberMe}
                onClick={() => setRememberMe((v) => !v)}
                className="min-h-[44px] flex items-center gap-3 text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 rounded-md pr-2"
              >
                <span
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    rememberMe
                      ? 'bg-[#0B1F3A] dark:bg-teal-600'
                      : 'bg-[#737679] dark:bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow-xs transition-transform ${
                      rememberMe ? 'translate-x-5.5' : 'translate-x-1'
                    }`}
                  />
                </span>
                <span className="text-xs sm:text-[13px] text-slate-800 dark:text-slate-200 select-none">
                  Remember me on this device
                </span>
              </button>
            </div>

            {/* Centered Login Button */}
            <div className="pt-2 flex justify-center">
              <button
                type="submit"
                disabled={submitting}
                className={`w-[176px] h-11 rounded-[4px] border text-sm font-medium transition-colors flex items-center justify-center whitespace-nowrap ${
                  canSubmit
                    ? 'bg-[#0B1F3A] hover:bg-[#14325B] dark:bg-teal-600 dark:hover:bg-teal-700 border-[#0B1F3A] dark:border-teal-600 text-white shadow-xs'
                    : 'bg-[#F3F4F6] dark:bg-[#0D1B2A] border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-800'
                }`}
              >
                {submitting ? 'Signing in...' : 'Login'}
              </button>
            </div>
          </form>
        </div>
      </main>

      <div className="h-6" aria-hidden="true" />
    </div>
  );
};
