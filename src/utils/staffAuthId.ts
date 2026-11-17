/**
 * Canonical Staff ID -> Firebase Auth internal identifier mapping.
 *
 * Firebase Authentication uses Email/Password internally while the UI only
 * collects Staff ID and Password. This helper provides one deterministic,
 * collision-checkable normalization function shared by the browser login flow
 * and the local Firebase Admin SDK provisioning scripts.
 *
 * Example:
 *   "A-5530" -> "a5530@staff.example.com"
 *   "A10002" -> "a10002@staff.example.com"
 */

export const STAFF_AUTH_EMAIL_DOMAIN = 'staff.example.com';

export function isValidStaffIdFormat(rawStaffId: string): boolean {
  const trimmed = rawStaffId.trim();
  return /^[A-Za-z0-9-]{2,24}$/.test(trimmed);
}

export function normalizeStaffIdToken(rawStaffId: string): string {
  return rawStaffId.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function staffIdToAuthEmail(rawStaffId: string): string {
  const token = normalizeStaffIdToken(rawStaffId);
  if (!token) {
    throw new Error('Staff ID is required to derive internal authentication identifier.');
  }
  return `${token}@${STAFF_AUTH_EMAIL_DOMAIN}`;
}
