/**
 * Canonical Staff ID & numeric PIN validation helpers shared between
 * the React SPA, Cloudflare Worker auth endpoints, and local Admin CLI.
 */

export function isValidStaffIdFormat(rawStaffId: string): boolean {
  const trimmed = rawStaffId.trim();
  return /^[A-Za-z0-9-]{2,24}$/.test(trimmed);
}

export function normalizeStaffIdToken(rawStaffId: string): string {
  return rawStaffId.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function staffIdToDeterministicUid(rawStaffId: string): string {
  const token = normalizeStaffIdToken(rawStaffId);
  if (!token) {
    throw new Error('Staff ID is required.');
  }
  return `ss_${token}`;
}

export function isValidPinFormat(rawPin: string): boolean {
  return /^\d{4,12}$/.test(rawPin.trim());
}
