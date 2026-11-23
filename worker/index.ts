export interface WorkerEnv {
  FIREBASE_SERVICE_ACCOUNT_KEY: string;
  FIREBASE_PROJECT_ID?: string;
  RATE_LIMIT_MAX_ATTEMPTS?: string;
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
}

interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

interface FirestoreDocument {
  name?: string;
  fields?: Record<string, FirestoreValue>;
}

const PBKDF2_ITERATIONS = 100_000;
const MAX_FAILED_PIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const IP_WINDOW_MS = 60 * 1000; // 1 minute
const DEFAULT_IP_MAX_ATTEMPTS = 20;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Per-isolate caches (Cloudflare Workers keep globals warm across requests)
const ipAttemptLog = new Map<string, number[]>();
let cachedAccessToken: { token: string; expiresAtMs: number; clientEmail: string } | null = null;
let cachedPrivateKey: { pem: string; key: CryptoKey } | null = null;
let cachedGoogleJwks: {
  keys: Record<string, JsonWebKey>;
  expiresAtMs: number;
} | null = null;

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(extraHeaders || {}),
    },
  });
}

function isValidStaffIdFormat(raw: string): boolean {
  return /^[A-Za-z0-9-]{2,24}$/.test(raw.trim());
}

function isValidNumericPin(raw: string): boolean {
  return /^\d{4,12}$/.test(raw.trim());
}

function normalizeStaffIdToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function deterministicStaffUid(staffId: string): string {
  return `ss_${normalizeStaffIdToken(staffId)}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj: unknown): string {
  return base64UrlEncode(textEncoder.encode(JSON.stringify(obj)));
}

function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim().toLowerCase();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error('Invalid hex encoding.');
  }
  const out = new Uint8Array(new ArrayBuffer(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqualHex(hexA: string, hexB: string): boolean {
  if (hexA.length !== hexB.length) return false;
  let diff = 0;
  for (let i = 0; i < hexA.length; i += 1) {
    diff |= hexA.charCodeAt(i) ^ hexB.charCodeAt(i);
  }
  return diff === 0;
}

async function hashPinPbkdf2(pin: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derived));
}

function generateSaltHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function makeServerId(prefix: string): string {
  return `${prefix}_${generateSaltHex(8)}`;
}

function checkIpRateLimit(request: Request, env: WorkerEnv): { allowed: boolean; retryAfterSec: number } {
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown';
  const maxAttempts = Math.max(
    5,
    Number.parseInt(env.RATE_LIMIT_MAX_ATTEMPTS || '', 10) || DEFAULT_IP_MAX_ATTEMPTS
  );
  const now = Date.now();
  const windowStart = now - IP_WINDOW_MS;
  const recent = (ipAttemptLog.get(ip) || []).filter((ts) => ts > windowStart);

  if (recent.length >= maxAttempts) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + IP_WINDOW_MS - now) / 1000));
    ipAttemptLog.set(ip, recent);
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  ipAttemptLog.set(ip, recent);
  if (ipAttemptLog.size > 2000) {
    for (const [k, timestamps] of ipAttemptLog.entries()) {
      const pruned = timestamps.filter((ts) => ts > windowStart);
      if (pruned.length === 0) ipAttemptLog.delete(k);
      else ipAttemptLog.set(k, pruned);
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}

function parseServiceAccount(env: WorkerEnv): ServiceAccountJson {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim();
  if (!raw) {
    throw new Error('Server configuration incomplete: FIREBASE_SERVICE_ACCOUNT_KEY secret is not set.');
  }

  let parsed: unknown;
  try {
    if (raw.startsWith('{')) {
      parsed = JSON.parse(raw);
    } else {
      parsed = JSON.parse(textDecoder.decode(base64UrlDecode(raw.replace(/\s+/g, ''))));
    }
  } catch {
    // Standard base64 fallback
    try {
      const bin = atob(raw.replace(/\s+/g, ''));
      parsed = JSON.parse(bin);
    } catch {
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_KEY secret format.');
    }
  }

  const sa = parsed as Partial<ServiceAccountJson>;
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is missing project_id, client_email, or private_key.');
  }
  return {
    project_id: sa.project_id,
    client_email: sa.client_email,
    private_key: sa.private_key.replace(/\\n/g, '\n'),
  };
}

async function importServicePrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedPrivateKey && cachedPrivateKey.pem === pem) {
    return cachedPrivateKey.key;
  }
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(pemBody);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    der[i] = binary.charCodeAt(i);
  }
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  cachedPrivateKey = { pem, key };
  return key;
}

async function signRs256Jwt(
  payload: Record<string, unknown>,
  privateKeyPem: string
): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const key = await importServicePrivateKey(privateKeyPem);
  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    textEncoder.encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sigBuffer))}`;
}

async function createFirebaseCustomToken(
  sa: ServiceAccountJson,
  uid: string,
  claims?: Record<string, unknown>
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000) - 10;
  const payload: Record<string, unknown> = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: nowSec,
    exp: nowSec + 3600,
    uid,
  };
  if (claims && Object.keys(claims).length > 0) {
    payload.claims = claims;
  }
  return signRs256Jwt(payload, sa.private_key);
}

async function getGoogleAccessToken(sa: ServiceAccountJson): Promise<string> {
  const now = Date.now();
  if (
    cachedAccessToken &&
    cachedAccessToken.clientEmail === sa.client_email &&
    cachedAccessToken.expiresAtMs > now + 60_000
  ) {
    return cachedAccessToken.token;
  }

  const nowSec = Math.floor(now / 1000) - 10;
  const assertion = await signRs256Jwt(
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    },
    sa.private_key
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google OAuth token exchange failed (${res.status}): ${errText}`);
  }

  const body = (await res.json()) as { access_token: string; expires_in?: number };
  cachedAccessToken = {
    token: body.access_token,
    expiresAtMs: now + ((body.expires_in || 3600) * 1000),
    clientEmail: sa.client_email,
  };
  return body.access_token;
}

async function getGoogleSecureTokenJwks(): Promise<Record<string, JsonWebKey>> {
  const now = Date.now();
  if (cachedGoogleJwks && cachedGoogleJwks.expiresAtMs > now) {
    return cachedGoogleJwks.keys;
  }

  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new Error(`Unable to fetch Firebase public JWKs (${res.status}).`);
  }
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3600_000;
  const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };

  const keyMap: Record<string, JsonWebKey> = {};
  for (const jwk of body.keys || []) {
    if (jwk.kid) {
      keyMap[jwk.kid] = jwk;
    }
  }
  cachedGoogleJwks = { keys: keyMap, expiresAtMs: now + maxAgeMs };
  return keyMap;
}

async function verifyFirebaseIdToken(
  token: string,
  projectId: string
): Promise<{ uid: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed authentication token.');
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(textDecoder.decode(base64UrlDecode(headerB64))) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(textDecoder.decode(base64UrlDecode(payloadB64))) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported token signature algorithm.');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) {
    throw new Error('Token audience mismatch.');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Token issuer mismatch.');
  }
  if (!payload.sub || payload.sub.length > 128) {
    throw new Error('Token subject is invalid.');
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Authentication session expired. Please sign in again.');
  }
  if (!payload.iat || payload.iat > nowSec + 300) {
    throw new Error('Token issued-at timestamp is invalid.');
  }

  let jwks = await getGoogleSecureTokenJwks();
  let jwk = jwks[header.kid];
  if (!jwk) {
    cachedGoogleJwks = null;
    jwks = await getGoogleSecureTokenJwks();
    jwk = jwks[header.kid];
  }
  if (!jwk) {
    throw new Error('Matching signing key not found for Firebase token.');
  }

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlDecode(sigB64),
    textEncoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) {
    throw new Error('Invalid Firebase token signature.');
  }

  return { uid: payload.sub };
}

/* -------------------------------------------------------------------------- */
/* Firestore REST Helpers                                                     */
/* -------------------------------------------------------------------------- */

function firestoreBaseUrl(projectId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

function fsDocId(docName?: string): string {
  if (!docName) return '';
  const idx = docName.lastIndexOf('/');
  return idx === -1 ? docName : docName.slice(idx + 1);
}

function fsStr(fields: Record<string, FirestoreValue> | undefined, key: string): string {
  const val = fields?.[key];
  if (val && 'stringValue' in val) return val.stringValue;
  return '';
}

function fsBool(
  fields: Record<string, FirestoreValue> | undefined,
  key: string,
  fallback = false
): boolean {
  const val = fields?.[key];
  if (val && 'booleanValue' in val) return val.booleanValue;
  return fallback;
}

function fsInt(
  fields: Record<string, FirestoreValue> | undefined,
  key: string,
  fallback = 0
): number {
  const val = fields?.[key];
  if (val && 'integerValue' in val) return Number(val.integerValue);
  if (val && 'doubleValue' in val) return Number(val.doubleValue);
  return fallback;
}

async function fsGetDoc(
  projectId: string,
  accessToken: string,
  docPath: string
): Promise<FirestoreDocument | null> {
  const url = `${firestoreBaseUrl(projectId)}/${docPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore GET ${docPath} failed (${res.status}): ${errText}`);
  }
  return (await res.json()) as FirestoreDocument;
}

async function fsListCollection(
  projectId: string,
  accessToken: string,
  collectionName: string
): Promise<FirestoreDocument[]> {
  const docs: FirestoreDocument[] = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({ pageSize: '300' });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${firestoreBaseUrl(projectId)}/${encodeURIComponent(collectionName)}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Firestore LIST ${collectionName} failed (${res.status}): ${errText}`);
    }
    const body = (await res.json()) as {
      documents?: FirestoreDocument[];
      nextPageToken?: string;
    };
    if (body.documents) docs.push(...body.documents);
    pageToken = body.nextPageToken || '';
  } while (pageToken);

  return docs;
}

async function fsPatchDoc(
  projectId: string,
  accessToken: string,
  docPath: string,
  fields: Record<string, FirestoreValue>,
  fieldPaths?: string[]
): Promise<void> {
  const params = new URLSearchParams();
  for (const fp of fieldPaths || Object.keys(fields)) {
    params.append('updateMask.fieldPaths', fp);
  }
  const url = `${firestoreBaseUrl(projectId)}/${docPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?${params.toString()}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore PATCH ${docPath} failed (${res.status}): ${errText}`);
  }
}

async function fsCreateDoc(
  projectId: string,
  accessToken: string,
  collectionName: string,
  documentId: string,
  fields: Record<string, FirestoreValue>
): Promise<void> {
  const url = `${firestoreBaseUrl(projectId)}/${encodeURIComponent(collectionName)}?documentId=${encodeURIComponent(documentId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore CREATE ${collectionName}/${documentId} failed (${res.status}): ${errText}`);
  }
}

async function findAuthorizedStaffDoc(
  projectId: string,
  accessToken: string,
  rawStaffId: string
): Promise<{ staffId: string; doc: FirestoreDocument } | null> {
  const trimmed = rawStaffId.trim();
  const exact = await fsGetDoc(projectId, accessToken, `staff/${trimmed}`);
  if (exact) {
    const id = fsStr(exact.fields, 'staffId') || fsDocId(exact.name) || trimmed;
    return { staffId: id, doc: exact };
  }

  const targetToken = normalizeStaffIdToken(trimmed);
  if (!targetToken) return null;

  const allStaff = await fsListCollection(projectId, accessToken, 'staff');
  for (const doc of allStaff) {
    const candidateId = fsStr(doc.fields, 'staffId') || fsDocId(doc.name);
    if (candidateId && normalizeStaffIdToken(candidateId) === targetToken) {
      return { staffId: candidateId, doc };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Firestore Transaction & Leave Capacity Helpers                             */
/* -------------------------------------------------------------------------- */

class HttpApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface BatchGetResponseItem {
  found?: FirestoreDocument;
  missing?: string;
  readTime?: string;
}

interface FirestoreWrite {
  update?: {
    name: string;
    fields: Record<string, FirestoreValue>;
  };
  delete?: string;
  currentDocument?: {
    exists?: boolean;
    updateTime?: string;
  };
}

interface AllocationItem {
  staffId: string;
  staffName: string;
  designation: string;
  requestId: string;
  leaveType: string;
  status: string;
}

interface ParsedLeaveRequest {
  requestId: string;
  uid: string;
  staffId: string;
  staffName: string;
  designation: string;
  countsTowardDailyCap: boolean;
  leaveType: string;
  startDate: string;
  endDate: string;
  dates: string[];
  daysCount: number;
  calendarYear: number;
  reason: string;
  status: string;
  modificationRequestType: string;
  modificationNote: string;
  requestedStartDate: string;
  requestedEndDate: string;
}

let inFlightCapacitySync: Promise<void> | null = null;

function firestoreDocResourceName(projectId: string, docPath: string): string {
  return `projects/${projectId}/databases/(default)/documents/${docPath}`;
}

function isValidDateKey(raw: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw);
}

function doesDesignationCountTowardCap(designation: string): boolean {
  const norm = String(designation || '').trim().toUpperCase();
  return norm === 'ASSISTANT OFFICER' || norm === 'ATTENDANT';
}

function expandMaldivesDateRange(
  startDate: string,
  endDate: string,
  maxDays = 30
): { dates: string[]; error?: string } {
  if (!isValidDateKey(startDate) || !isValidDateKey(endDate)) {
    return { dates: [], error: 'Please provide valid start and end dates.' };
  }
  if (endDate < startDate) {
    return { dates: [], error: 'End date must be on or after start date.' };
  }
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const endUtc = Date.UTC(ey, em - 1, ed);
  const diffDays = Math.floor((endUtc - startUtc) / 86_400_000) + 1;
  if (!Number.isFinite(diffDays) || diffDays < 1) {
    return { dates: [], error: 'Invalid date range.' };
  }
  if (diffDays > maxDays) {
    return {
      dates: [],
      error: `Single leave application cannot exceed ${maxDays} calendar days (selected: ${diffDays}).`,
    };
  }
  const dates: string[] = [];
  for (let i = 0; i < diffDays; i += 1) {
    const dt = new Date(startUtc + i * 86_400_000);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
  }
  return { dates };
}

function fsStringArray(
  fields: Record<string, FirestoreValue> | undefined,
  key: string
): string[] {
  const val = fields?.[key];
  if (!val || !('arrayValue' in val)) return [];
  const out: string[] = [];
  for (const item of val.arrayValue.values || []) {
    if ('stringValue' in item) out.push(item.stringValue);
  }
  return out;
}

function fsAllocations(fields: Record<string, FirestoreValue> | undefined): AllocationItem[] {
  const val = fields?.allocations;
  if (!val || !('arrayValue' in val)) return [];
  const out: AllocationItem[] = [];
  for (const item of val.arrayValue.values || []) {
    if (!('mapValue' in item) || !item.mapValue.fields) continue;
    const mf = item.mapValue.fields;
    const requestId = fsStr(mf, 'requestId');
    const staffId = fsStr(mf, 'staffId');
    if (!requestId || !staffId) continue;
    out.push({
      staffId,
      staffName: fsStr(mf, 'staffName'),
      designation: fsStr(mf, 'designation') || 'ASSISTANT OFFICER',
      requestId,
      leaveType: fsStr(mf, 'leaveType') || 'Annual Leave',
      status: fsStr(mf, 'status') || 'approved',
    });
  }
  return out;
}

function allocationsToFirestoreValue(items: AllocationItem[]): FirestoreValue {
  return {
    arrayValue: {
      values: items.slice(0, 60).map((a) => ({
        mapValue: {
          fields: {
            staffId: { stringValue: a.staffId },
            staffName: { stringValue: a.staffName },
            designation: { stringValue: a.designation },
            requestId: { stringValue: a.requestId },
            leaveType: { stringValue: a.leaveType },
            status: { stringValue: a.status },
          },
        },
      })),
    },
  };
}

function parseLeaveRequestDoc(doc: FirestoreDocument): ParsedLeaveRequest {
  const fields = doc.fields || {};
  const designation = fsStr(fields, 'designation') || 'ASSISTANT OFFICER';
  const startDate = fsStr(fields, 'startDate');
  const endDate = fsStr(fields, 'endDate');
  const dates = fsStringArray(fields, 'dates');
  return {
    requestId: fsStr(fields, 'requestId') || fsDocId(doc.name),
    uid: fsStr(fields, 'uid'),
    staffId: fsStr(fields, 'staffId'),
    staffName: fsStr(fields, 'staffName'),
    designation,
    countsTowardDailyCap:
      typeof fields.countsTowardDailyCap === 'object' && 'booleanValue' in fields.countsTowardDailyCap
        ? fsBool(fields, 'countsTowardDailyCap')
        : doesDesignationCountTowardCap(designation),
    leaveType: fsStr(fields, 'leaveType') || 'Annual Leave',
    startDate,
    endDate,
    dates,
    daysCount: fsInt(fields, 'daysCount', dates.length),
    calendarYear: fsInt(fields, 'calendarYear', Number(startDate.slice(0, 4)) || 2026),
    reason: fsStr(fields, 'reason'),
    status: fsStr(fields, 'status') || 'pending',
    modificationRequestType: fsStr(fields, 'modificationRequestType') || 'none',
    modificationNote: fsStr(fields, 'modificationNote'),
    requestedStartDate: fsStr(fields, 'requestedStartDate'),
    requestedEndDate: fsStr(fields, 'requestedEndDate'),
  };
}

interface ParsedLeaveRestriction {
  restrictionId: string;
  startDate: string;
  endDate: string;
  targetType: string;
  targetStaffIds: string[];
  targetStaffNames: string[];
  reason: string;
  isActive: boolean;
  createdByStaffId: string;
  createdByName: string;
  createdAt?: string;
  updatedAt?: string;
}

const ALLOWED_RESTRICTION_TARGET_TYPES = new Set([
  'all',
  'assistant_officer',
  'attendant',
  'executive',
  'officer',
  'selected_staff',
]);

const WORKER_LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatLongDateWorker(dateKey: string): string {
  if (!isValidDateKey(dateKey)) return dateKey;
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${WORKER_LONG_MONTHS[m - 1] || ''} ${y}`;
}

function fsTimestamp(
  fields: Record<string, FirestoreValue> | undefined,
  key: string
): string | undefined {
  const val = fields?.[key];
  if (val && 'timestampValue' in val) return val.timestampValue;
  return undefined;
}

function parseLeaveRestrictionDoc(doc: FirestoreDocument): ParsedLeaveRestriction {
  const fields = doc.fields || {};
  const primaryStaffIds = fsStringArray(fields, 'targetStaffIds');
  const fallbackStaffIds =
    primaryStaffIds.length > 0
      ? primaryStaffIds
      : fsStringArray(fields, 'staffIds').length > 0
        ? fsStringArray(fields, 'staffIds')
        : fsStringArray(fields, 'selectedStaffIds');
  const isActiveField = fields.isActive;
  const isActive =
    isActiveField && 'stringValue' in isActiveField
      ? isActiveField.stringValue.trim().toLowerCase() !== 'false'
      : fsBool(fields, 'isActive', true);
  return {
    restrictionId: fsStr(fields, 'restrictionId') || fsDocId(doc.name),
    startDate: fsStr(fields, 'startDate').trim(),
    endDate: fsStr(fields, 'endDate').trim(),
    targetType: (fsStr(fields, 'targetType') || 'all').trim().toLowerCase(),
    targetStaffIds: fallbackStaffIds.map((id) => id.trim()).filter(Boolean),
    targetStaffNames: fsStringArray(fields, 'targetStaffNames'),
    reason: fsStr(fields, 'reason').trim(),
    isActive,
    createdByStaffId: fsStr(fields, 'createdByStaffId').trim(),
    createdByName: fsStr(fields, 'createdByName').trim(),
    createdAt: fsTimestamp(fields, 'createdAt'),
    updatedAt: fsTimestamp(fields, 'updatedAt'),
  };
}

function doesRestrictionApplyToStaffWorker(
  r: ParsedLeaveRestriction,
  staffId: string,
  designation: string,
  uid = '',
  staffName = ''
): boolean {
  if (!r.isActive) return false;
  const targetType = String(r.targetType || '').trim().toLowerCase();
  const normDesig = String(designation || '').trim().toUpperCase();
  const staffIdToken = normalizeStaffIdToken(staffId || '');
  const deterministicUid = staffIdToken ? `ss_${staffIdToken}` : '';
  const callerUidLower = String(uid || '').trim().toLowerCase();
  const callerNameLower = String(staffName || '').trim().toLowerCase();

  switch (targetType) {
    case 'all':
      return true;
    case 'assistant_officer':
      return normDesig === 'ASSISTANT OFFICER';
    case 'attendant':
      return normDesig === 'ATTENDANT';
    case 'executive':
      return normDesig === 'EXECUTIVE';
    case 'officer':
      return normDesig === 'OFFICER';
    case 'selected_staff':
    case 'selectedstaff':
    case 'specific_staff': {
      const matched = r.targetStaffIds.some((rawEntry) => {
        const trimmed = String(rawEntry || '').trim();
        if (!trimmed) return false;
        if (staffIdToken && normalizeStaffIdToken(trimmed) === staffIdToken) {
          return true;
        }
        const lower = trimmed.toLowerCase();
        if (deterministicUid && lower === deterministicUid) return true;
        if (callerUidLower && lower === callerUidLower) return true;
        if (callerNameLower.length >= 3 && lower === callerNameLower) return true;
        return false;
      });
      if (matched) return true;

      if (r.targetStaffIds.length === 0 && callerNameLower.length >= 3) {
        return r.targetStaffNames.some(
          (n) => String(n || '').trim().toLowerCase() === callerNameLower
        );
      }
      return false;
    }
    default:
      return false;
  }
}

function findBlockedDatesWorker(
  dates: string[],
  restrictions: ParsedLeaveRestriction[],
  staffId: string,
  designation: string,
  uid = '',
  staffName = ''
): { blockedDates: string[]; matched: ParsedLeaveRestriction[] } {
  const applicable = restrictions.filter((r) =>
    doesRestrictionApplyToStaffWorker(r, staffId, designation, uid, staffName)
  );
  if (applicable.length === 0) return { blockedDates: [], matched: [] };

  const blockedSet = new Set<string>();
  const matchedMap = new Map<string, ParsedLeaveRestriction>();
  for (const d of dates) {
    const cleanDate = String(d || '').trim();
    for (const r of applicable) {
      if (r.startDate && r.endDate && cleanDate >= r.startDate && cleanDate <= r.endDate) {
        blockedSet.add(cleanDate);
        matchedMap.set(r.restrictionId, r);
      }
    }
  }
  return {
    blockedDates: Array.from(blockedSet).sort(),
    matched: Array.from(matchedMap.values()).sort((a, b) =>
      a.startDate.localeCompare(b.startDate)
    ),
  };
}

function summarizeAllocationsForDate(allocations: AllocationItem[]): {
  occupiedCount: number;
  approvedOnlyCount: number;
  pendingCount: number;
} {
  let approvedOnlyCount = 0;
  let pendingCount = 0;
  for (const a of allocations) {
    if (!doesDesignationCountTowardCap(a.designation)) continue;
    if (a.status === 'pending') pendingCount += 1;
    else approvedOnlyCount += 1;
  }
  return {
    occupiedCount: approvedOnlyCount + pendingCount,
    approvedOnlyCount,
    pendingCount,
  };
}

async function fsBeginTransaction(
  projectId: string,
  accessToken: string
): Promise<string> {
  const url = `${firestoreBaseUrl(projectId)}:beginTransaction`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ options: { readWrite: {} } }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore beginTransaction failed (${res.status}): ${errText}`);
  }
  const body = (await res.json()) as { transaction?: string };
  if (!body.transaction) {
    throw new Error('Firestore beginTransaction returned no transaction token.');
  }
  return body.transaction;
}

async function fsRollbackTransaction(
  projectId: string,
  accessToken: string,
  transaction: string
): Promise<void> {
  const url = `${firestoreBaseUrl(projectId)}:rollback`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ transaction }),
  }).catch(() => undefined);
}

async function fsBatchGetDocs(
  projectId: string,
  accessToken: string,
  docPaths: string[],
  transaction?: string
): Promise<Record<string, FirestoreDocument | null>> {
  const result: Record<string, FirestoreDocument | null> = {};
  if (docPaths.length === 0) return result;

  const fullNames = docPaths.map((p) => firestoreDocResourceName(projectId, p));
  const pathByFullName = new Map<string, string>();
  docPaths.forEach((p, i) => pathByFullName.set(fullNames[i], p));

  const url = `${firestoreBaseUrl(projectId)}:batchGet`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      documents: fullNames,
      ...(transaction ? { transaction } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 409) {
      throw new HttpApiError(409, 'ABORTED: Transaction conflict during read.');
    }
    throw new Error(`Firestore batchGet failed (${res.status}): ${errText}`);
  }

  const rows = (await res.json()) as BatchGetResponseItem[];
  for (const row of rows) {
    if (row.found?.name) {
      const p = pathByFullName.get(row.found.name);
      if (p) result[p] = row.found;
    } else if (row.missing) {
      const p = pathByFullName.get(row.missing);
      if (p) result[p] = null;
    }
  }
  return result;
}

async function fsRunQuery(
  projectId: string,
  accessToken: string,
  structuredQuery: Record<string, unknown>,
  transaction?: string
): Promise<FirestoreDocument[]> {
  const url = `${firestoreBaseUrl(projectId)}:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      structuredQuery,
      ...(transaction ? { transaction } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 409) {
      throw new HttpApiError(409, 'ABORTED: Transaction conflict during query.');
    }
    throw new Error(`Firestore runQuery failed (${res.status}): ${errText}`);
  }
  const rows = (await res.json()) as Array<{ document?: FirestoreDocument }>;
  const docs: FirestoreDocument[] = [];
  for (const row of rows) {
    if (row.document) docs.push(row.document);
  }
  return docs;
}

async function fsCommitWrites(
  projectId: string,
  accessToken: string,
  writes: FirestoreWrite[],
  transaction?: string
): Promise<void> {
  const url = `${firestoreBaseUrl(projectId)}:commit`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      writes,
      ...(transaction ? { transaction } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 409 || errText.includes('ABORTED') || errText.includes('ALREADY_EXISTS')) {
      throw new HttpApiError(409, `ABORTED: ${errText}`);
    }
    throw new Error(`Firestore commit failed (${res.status}): ${errText}`);
  }
}

async function runFirestoreTransaction<T>(
  projectId: string,
  accessToken: string,
  fn: (tx: string) => Promise<{ writes: FirestoreWrite[]; result: T }>
): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const tx = await fsBeginTransaction(projectId, accessToken);
    try {
      const { writes, result } = await fn(tx);
      await fsCommitWrites(projectId, accessToken, writes, tx);
      return result;
    } catch (err) {
      await fsRollbackTransaction(projectId, accessToken, tx);
      const isConflict =
        err instanceof HttpApiError &&
        err.status === 409 &&
        err.message.startsWith('ABORTED:');
      if (isConflict && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 40 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new HttpApiError(409, 'Concurrent update conflict. Please try again.');
}

async function reconcilePendingCapacity(
  projectId: string,
  accessToken: string,
  force = false
): Promise<{ syncedDates: number; activeRequests: number }> {
  if (!force) {
    const settingsDoc = await fsGetDoc(projectId, accessToken, 'appSettings/portalConfig');
    if (settingsDoc?.fields && fsBool(settingsDoc.fields, 'pendingReservesCapacity', false)) {
      return { syncedDates: 0, activeRequests: 0 };
    }
  }

  if (inFlightCapacitySync) {
    await inFlightCapacitySync;
    return { syncedDates: 0, activeRequests: 0 };
  }

  let syncedDates = 0;
  let activeRequests = 0;

  inFlightCapacitySync = (async () => {
    const [settingsDoc, allLeaveDocs, existingCapDocs, existingDetailDocs] = await Promise.all([
      fsGetDoc(projectId, accessToken, 'appSettings/portalConfig'),
      fsListCollection(projectId, accessToken, 'leaveRequests'),
      fsListCollection(projectId, accessToken, 'dailyCapacity'),
      fsListCollection(projectId, accessToken, 'dailyCapacityDetails'),
    ]);

    const settingsFields = settingsDoc?.fields;
    const maxCap = Math.min(10, Math.max(1, fsInt(settingsFields, 'maxDailyCombinedCap', 10)));
    const maxAnnual = Math.min(
      10,
      Math.max(1, fsInt(settingsFields, 'maxAnnualLeavePeriods', 3))
    );
    const timezone = fsStr(settingsFields, 'timezone') || 'Asia/Male';
    const unitName = fsStr(settingsFields, 'unitName') || 'Special Services Unit';
    const airportName = fsStr(settingsFields, 'airportName') || 'Velana International Airport';

    const allocsByDate = new Map<string, AllocationItem[]>();

    for (const doc of allLeaveDocs) {
      const req = parseLeaveRequestDoc(doc);
      if (req.status !== 'pending' && req.status !== 'approved') continue;
      activeRequests += 1;
      for (const dateKey of req.dates) {
        if (!isValidDateKey(dateKey)) continue;
        const list = allocsByDate.get(dateKey) || [];
        if (!list.some((a) => a.requestId === req.requestId)) {
          list.push({
            staffId: req.staffId,
            staffName: req.staffName,
            designation: req.designation,
            requestId: req.requestId,
            leaveType: req.leaveType,
            status: req.status,
          });
        }
        allocsByDate.set(dateKey, list);
      }
    }

    const allDates = new Set<string>(allocsByDate.keys());
    for (const d of existingCapDocs) {
      const dk = fsStr(d.fields, 'date') || fsDocId(d.name);
      if (isValidDateKey(dk)) allDates.add(dk);
    }
    for (const d of existingDetailDocs) {
      const dk = fsStr(d.fields, 'date') || fsDocId(d.name);
      if (isValidDateKey(dk)) allDates.add(dk);
    }

    const nowIso = new Date().toISOString();
    const writes: FirestoreWrite[] = [];

    for (const dateKey of allDates) {
      const allocs = allocsByDate.get(dateKey) || [];
      const summary = summarizeAllocationsForDate(allocs);
      writes.push({
        update: {
          name: firestoreDocResourceName(projectId, `dailyCapacity/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            approvedCount: { integerValue: String(summary.occupiedCount) },
            approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
            pendingCount: { integerValue: String(summary.pendingCount) },
            maxCapacity: { integerValue: String(maxCap) },
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
      writes.push({
        update: {
          name: firestoreDocResourceName(projectId, `dailyCapacityDetails/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            allocations: allocationsToFirestoreValue(allocs),
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
      syncedDates += 1;
    }

    writes.push({
      update: {
        name: firestoreDocResourceName(projectId, 'appSettings/portalConfig'),
        fields: {
          maxDailyCombinedCap: { integerValue: String(maxCap) },
          maxAnnualLeavePeriods: { integerValue: String(maxAnnual) },
          pendingReservesCapacity: { booleanValue: true },
          timezone: { stringValue: timezone },
          unitName: { stringValue: unitName },
          airportName: { stringValue: airportName },
          updatedByStaffId: { stringValue: 'SYSTEM_SYNC' },
          updatedAt: { timestampValue: nowIso },
        },
      },
    });

    for (let i = 0; i < writes.length; i += 400) {
      await fsCommitWrites(projectId, accessToken, writes.slice(i, i + 400));
    }
  })();

  try {
    await inFlightCapacitySync;
  } finally {
    inFlightCapacitySync = null;
  }

  return { syncedDates, activeRequests };
}

async function authenticateActiveCaller(
  request: Request,
  env: WorkerEnv
): Promise<{
  projectId: string;
  accessToken: string;
  uid: string;
  staffId: string;
  role: string;
  designation: string;
  staffName: string;
  annualPeriodLimit: number;
  countsTowardDailyCap: boolean;
}> {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) {
    throw new HttpApiError(401, 'Authentication required.');
  }

  const sa = parseServiceAccount(env);
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || sa.project_id;

  let uid: string;
  try {
    const verified = await verifyFirebaseIdToken(idToken, projectId);
    uid = verified.uid;
  } catch (err) {
    throw new HttpApiError(
      401,
      err instanceof Error ? err.message : 'Unauthorized session.'
    );
  }

  const accessToken = await getGoogleAccessToken(sa);
  const linkDoc = await fsGetDoc(projectId, accessToken, `staffAuthLinks/${uid}`);
  if (!linkDoc?.fields || !fsBool(linkDoc.fields, 'isActive', false)) {
    throw new HttpApiError(403, 'Your account is inactive or unavailable.');
  }

  const staffId = fsStr(linkDoc.fields, 'staffId');
  const staffDoc = await fsGetDoc(projectId, accessToken, `staff/${staffId}`);
  if (!staffDoc?.fields || !fsBool(staffDoc.fields, 'isActive', true)) {
    throw new HttpApiError(403, `Account ${staffId} has been deactivated.`);
  }

  const designation =
    fsStr(staffDoc.fields, 'designation') ||
    fsStr(linkDoc.fields, 'designation') ||
    'ASSISTANT OFFICER';
  const role =
    fsStr(staffDoc.fields, 'role') || fsStr(linkDoc.fields, 'role') || 'staff';
  const staffName = fsStr(staffDoc.fields, 'fullName') || staffId;
  const annualPeriodLimit = Math.min(
    10,
    Math.max(1, fsInt(staffDoc.fields, 'annualPeriodLimit', 3))
  );
  const countsTowardDailyCap =
    typeof staffDoc.fields.countsTowardDailyCap === 'object' &&
    'booleanValue' in staffDoc.fields.countsTowardDailyCap
      ? fsBool(staffDoc.fields, 'countsTowardDailyCap')
      : doesDesignationCountTowardCap(designation);

  return {
    projectId,
    accessToken,
    uid,
    staffId,
    role,
    designation,
    staffName,
    annualPeriodLimit,
    countsTowardDailyCap,
  };
}

/* -------------------------------------------------------------------------- */
/* Route Handlers                                                             */
/* -------------------------------------------------------------------------- */

async function handleLogin(request: Request, env: WorkerEnv): Promise<Response> {
  const ipLimit = checkIpRateLimit(request, env);
  if (!ipLimit.allowed) {
    return jsonResponse(
      { error: 'Too many login attempts from this network. Please wait and try again.' },
      429,
      { 'Retry-After': String(ipLimit.retryAfterSec) }
    );
  }

  let body: { staffId?: unknown; pin?: unknown };
  try {
    body = (await request.json()) as { staffId?: unknown; pin?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid request payload.' }, 400);
  }

  const rawStaffId = typeof body.staffId === 'string' ? body.staffId.trim() : '';
  const rawPin = typeof body.pin === 'string' ? body.pin.trim() : '';

  if (!isValidStaffIdFormat(rawStaffId) || !isValidNumericPin(rawPin)) {
    return jsonResponse({ error: 'Invalid Staff ID or PIN.' }, 401);
  }

  const sa = parseServiceAccount(env);
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || sa.project_id;
  const accessToken = await getGoogleAccessToken(sa);

  // 1. Verify Staff ID already exists as an authorized staff record (never auto-register unknown IDs)
  const found = await findAuthorizedStaffDoc(projectId, accessToken, rawStaffId);
  if (!found) {
    return jsonResponse({ error: 'Invalid Staff ID or PIN.' }, 401);
  }

  const { staffId, doc: staffDoc } = found;
  const staffFields = staffDoc.fields || {};
  if (!fsBool(staffFields, 'isActive', true)) {
    return jsonResponse(
      { error: `Account ${staffId} has been deactivated. Contact a Manager.` },
      403
    );
  }

  // 2. Read server-only hashed PIN credential from staffPinSecrets/{staffId}
  const secretDoc = await fsGetDoc(projectId, accessToken, `staffPinSecrets/${staffId}`);
  if (!secretDoc || !secretDoc.fields) {
    console.warn(`[auth] Missing staffPinSecrets/${staffId}; administrator must run initial PIN provisioning.`);
    return jsonResponse({ error: 'Invalid Staff ID or PIN.' }, 401);
  }

  const secretFields = secretDoc.fields;
  const nowMs = Date.now();
  const lockedUntilMs = fsInt(secretFields, 'lockedUntilMs', 0);
  if (lockedUntilMs > nowMs) {
    const minutesLeft = Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 60_000));
    return jsonResponse(
      {
        error: `Too many failed PIN attempts. Try again in ${minutesLeft} minute(s).`,
      },
      429,
      { 'Retry-After': String(Math.ceil((lockedUntilMs - nowMs) / 1000)) }
    );
  }

  const pinSalt = fsStr(secretFields, 'pinSalt');
  const pinHash = fsStr(secretFields, 'pinHash');
  if (!pinSalt || !pinHash) {
    return jsonResponse({ error: 'Invalid Staff ID or PIN.' }, 401);
  }

  const computedHash = await hashPinPbkdf2(rawPin, pinSalt);
  if (!constantTimeEqualHex(computedHash, pinHash)) {
    const nextFailed = fsInt(secretFields, 'failedAttempts', 0) + 1;
    const nextLockedUntil =
      nextFailed >= MAX_FAILED_PIN_ATTEMPTS ? nowMs + LOCKOUT_DURATION_MS : 0;

    await fsPatchDoc(projectId, accessToken, `staffPinSecrets/${staffId}`, {
      failedAttempts: { integerValue: String(nextFailed) },
      lockedUntilMs: { integerValue: String(nextLockedUntil) },
      updatedAt: { timestampValue: new Date(nowMs).toISOString() },
    });

    if (nextLockedUntil > 0) {
      return jsonResponse(
        {
          error: 'Too many failed PIN attempts. Account locked for 15 minutes.',
        },
        429,
        { 'Retry-After': String(Math.ceil(LOCKOUT_DURATION_MS / 1000)) }
      );
    }
    return jsonResponse({ error: 'Invalid Staff ID or PIN.' }, 401);
  }

  // 3. Reset failed-attempt counter if previously incremented
  const mustChangePin = fsBool(
    secretFields,
    'mustChangePin',
    fsBool(staffFields, 'mustChangePassword', false)
  );
  const nowIso = new Date(nowMs).toISOString();

  if (fsInt(secretFields, 'failedAttempts', 0) !== 0 || lockedUntilMs !== 0) {
    await fsPatchDoc(projectId, accessToken, `staffPinSecrets/${staffId}`, {
      failedAttempts: { integerValue: '0' },
      lockedUntilMs: { integerValue: '0' },
      updatedAt: { timestampValue: nowIso },
    });
  }

  // 4. Sync non-destructive auth link fields (preserve all existing staff profile data)
  const uid =
    fsStr(staffFields, 'authUid') ||
    fsStr(secretFields, 'authUid') ||
    deterministicStaffUid(staffId);
  const role = fsStr(staffFields, 'role') || 'staff';
  const designation = fsStr(staffFields, 'designation') || 'ASSISTANT OFFICER';

  await fsPatchDoc(projectId, accessToken, `staffAuthLinks/${uid}`, {
    uid: { stringValue: uid },
    staffId: { stringValue: staffId },
    role: { stringValue: role },
    designation: { stringValue: designation },
    isActive: { booleanValue: true },
    updatedAt: { timestampValue: nowIso },
  });

  if (
    fsStr(staffFields, 'authUid') !== uid ||
    fsBool(staffFields, 'mustChangePassword', false) !== mustChangePin
  ) {
    await fsPatchDoc(projectId, accessToken, `staff/${staffId}`, {
      authUid: { stringValue: uid },
      mustChangePassword: { booleanValue: mustChangePin },
      updatedAt: { timestampValue: nowIso },
    });
  }

  // 5. Mint Firebase Authentication custom token
  const customToken = await createFirebaseCustomToken(sa, uid, {
    staffId,
    role,
  });

  return jsonResponse({
    customToken,
    staffId,
    mustChangePin,
  });
}

async function handleChangePin(request: Request, env: WorkerEnv): Promise<Response> {
  const ipLimit = checkIpRateLimit(request, env);
  if (!ipLimit.allowed) {
    return jsonResponse(
      { error: 'Too many requests. Please wait a moment and try again.' },
      429,
      { 'Retry-After': String(ipLimit.retryAfterSec) }
    );
  }

  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) {
    return jsonResponse({ error: 'Authentication required.' }, 401);
  }

  let body: { currentPin?: unknown; newPin?: unknown };
  try {
    body = (await request.json()) as { currentPin?: unknown; newPin?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid request payload.' }, 400);
  }

  const currentPin = typeof body.currentPin === 'string' ? body.currentPin.trim() : '';
  const newPin = typeof body.newPin === 'string' ? body.newPin.trim() : '';

  if (!isValidNumericPin(currentPin)) {
    return jsonResponse({ error: 'Current PIN must be 4 to 12 digits.' }, 400);
  }
  if (!isValidNumericPin(newPin)) {
    return jsonResponse({ error: 'New PIN must be 4 to 12 digits.' }, 400);
  }
  if (newPin === currentPin) {
    return jsonResponse(
      { error: 'New PIN must be different from your current PIN.' },
      400
    );
  }

  const sa = parseServiceAccount(env);
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || sa.project_id;

  let verifiedUid: string;
  try {
    const verified = await verifyFirebaseIdToken(idToken, projectId);
    verifiedUid = verified.uid;
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : 'Unauthorized session.' },
      401
    );
  }

  const accessToken = await getGoogleAccessToken(sa);
  const linkDoc = await fsGetDoc(projectId, accessToken, `staffAuthLinks/${verifiedUid}`);
  if (!linkDoc?.fields || !fsBool(linkDoc.fields, 'isActive', false)) {
    return jsonResponse({ error: 'Staff profile link is inactive or missing.' }, 403);
  }

  const staffId = fsStr(linkDoc.fields, 'staffId');
  const staffDoc = await fsGetDoc(projectId, accessToken, `staff/${staffId}`);
  if (!staffDoc?.fields || !fsBool(staffDoc.fields, 'isActive', false)) {
    return jsonResponse({ error: 'Staff account is inactive.' }, 403);
  }

  const secretDoc = await fsGetDoc(projectId, accessToken, `staffPinSecrets/${staffId}`);
  if (!secretDoc?.fields) {
    return jsonResponse({ error: 'PIN record not found for account.' }, 404);
  }

  const nowMs = Date.now();
  const lockedUntilMs = fsInt(secretDoc.fields, 'lockedUntilMs', 0);
  if (lockedUntilMs > nowMs) {
    const minutesLeft = Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 60_000));
    return jsonResponse(
      { error: `PIN changes temporarily locked. Try again in ${minutesLeft} minute(s).` },
      429
    );
  }

  const existingSalt = fsStr(secretDoc.fields, 'pinSalt');
  const existingHash = fsStr(secretDoc.fields, 'pinHash');
  const currentComputed = await hashPinPbkdf2(currentPin, existingSalt);

  if (!constantTimeEqualHex(currentComputed, existingHash)) {
    const nextFailed = fsInt(secretDoc.fields, 'failedAttempts', 0) + 1;
    const nextLockedUntil =
      nextFailed >= MAX_FAILED_PIN_ATTEMPTS ? nowMs + LOCKOUT_DURATION_MS : 0;
    await fsPatchDoc(projectId, accessToken, `staffPinSecrets/${staffId}`, {
      failedAttempts: { integerValue: String(nextFailed) },
      lockedUntilMs: { integerValue: String(nextLockedUntil) },
      updatedAt: { timestampValue: new Date(nowMs).toISOString() },
    });
    return jsonResponse({ error: 'Current PIN is incorrect.' }, 401);
  }

  const newSalt = generateSaltHex(16);
  const newHash = await hashPinPbkdf2(newPin, newSalt);
  const nowIso = new Date(nowMs).toISOString();

  await fsPatchDoc(projectId, accessToken, `staffPinSecrets/${staffId}`, {
    pinSalt: { stringValue: newSalt },
    pinHash: { stringValue: newHash },
    hashAlgo: { stringValue: 'pbkdf2-sha256-100000' },
    mustChangePin: { booleanValue: false },
    failedAttempts: { integerValue: '0' },
    lockedUntilMs: { integerValue: '0' },
    updatedAt: { timestampValue: nowIso },
  });

  await fsPatchDoc(projectId, accessToken, `staff/${staffId}`, {
    mustChangePassword: { booleanValue: false },
    updatedAt: { timestampValue: nowIso },
  });

  const fullName = fsStr(staffDoc.fields, 'fullName') || staffId;
  const role = fsStr(staffDoc.fields, 'role') || 'staff';
  const logId = makeServerId('log');

  await fsCreateDoc(projectId, accessToken, 'auditLogs', logId, {
    logId: { stringValue: logId },
    action: { stringValue: 'PASSWORD_UPDATED' },
    targetType: { stringValue: 'staff' },
    targetId: { stringValue: staffId },
    actorStaffId: { stringValue: staffId },
    actorName: { stringValue: fullName },
    actorRole: { stringValue: role },
    summary: { stringValue: `${staffId} (${fullName}) updated their personal PIN.` },
    createdAt: { timestampValue: nowIso },
  });

  return jsonResponse({ ok: true });
}

async function handleAdminResetPin(request: Request, env: WorkerEnv): Promise<Response> {
  const ipLimit = checkIpRateLimit(request, env);
  if (!ipLimit.allowed) {
    return jsonResponse(
      { error: 'Too many requests. Please wait a moment and try again.' },
      429,
      { 'Retry-After': String(ipLimit.retryAfterSec) }
    );
  }

  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) {
    return jsonResponse({ error: 'Authentication required.' }, 401);
  }

  let body: { targetStaffId?: unknown; tempPin?: unknown };
  try {
    body = (await request.json()) as { targetStaffId?: unknown; tempPin?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid request payload.' }, 400);
  }

  const targetStaffId =
    typeof body.targetStaffId === 'string' ? body.targetStaffId.trim() : '';
  const tempPin = typeof body.tempPin === 'string' ? body.tempPin.trim() : '';

  if (!isValidStaffIdFormat(targetStaffId) || !isValidNumericPin(tempPin)) {
    return jsonResponse(
      { error: 'Valid Staff ID and numeric temporary PIN (4 to 12 digits) are required.' },
      400
    );
  }

  const sa = parseServiceAccount(env);
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || sa.project_id;

  let actorUid: string;
  try {
    const verified = await verifyFirebaseIdToken(idToken, projectId);
    actorUid = verified.uid;
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : 'Unauthorized session.' },
      401
    );
  }

  const accessToken = await getGoogleAccessToken(sa);
  const actorLink = await fsGetDoc(projectId, accessToken, `staffAuthLinks/${actorUid}`);
  if (
    !actorLink?.fields ||
    !fsBool(actorLink.fields, 'isActive', false) ||
    fsStr(actorLink.fields, 'role') !== 'manager'
  ) {
    return jsonResponse({ error: 'Only active Managers can reset employee PINs.' }, 403);
  }

  const actorStaffId = fsStr(actorLink.fields, 'staffId');
  const actorDoc = await fsGetDoc(projectId, accessToken, `staff/${actorStaffId}`);
  const actorName = fsStr(actorDoc?.fields, 'fullName') || actorStaffId;

  const targetFound = await findAuthorizedStaffDoc(projectId, accessToken, targetStaffId);
  if (!targetFound) {
    return jsonResponse({ error: `Staff record ${targetStaffId} not found.` }, 404);
  }

  const canonicalId = targetFound.staffId;
  const targetFields = targetFound.doc.fields || {};
  const targetName = fsStr(targetFields, 'fullName') || canonicalId;
  const targetUid = fsStr(targetFields, 'authUid') || deterministicStaffUid(canonicalId);
  const nowIso = new Date().toISOString();

  const newSalt = generateSaltHex(16);
  const newHash = await hashPinPbkdf2(tempPin, newSalt);

  await fsPatchDoc(projectId, accessToken, `staffPinSecrets/${canonicalId}`, {
    staffId: { stringValue: canonicalId },
    authUid: { stringValue: targetUid },
    pinSalt: { stringValue: newSalt },
    pinHash: { stringValue: newHash },
    hashAlgo: { stringValue: 'pbkdf2-sha256-100000' },
    mustChangePin: { booleanValue: true },
    failedAttempts: { integerValue: '0' },
    lockedUntilMs: { integerValue: '0' },
    updatedAt: { timestampValue: nowIso },
  });

  await fsPatchDoc(projectId, accessToken, `staffAuthLinks/${targetUid}`, {
    uid: { stringValue: targetUid },
    staffId: { stringValue: canonicalId },
    role: { stringValue: fsStr(targetFields, 'role') || 'staff' },
    designation: { stringValue: fsStr(targetFields, 'designation') || 'ASSISTANT OFFICER' },
    isActive: { booleanValue: fsBool(targetFields, 'isActive', true) },
    updatedAt: { timestampValue: nowIso },
  });

  await fsPatchDoc(projectId, accessToken, `staff/${canonicalId}`, {
    authUid: { stringValue: targetUid },
    mustChangePassword: { booleanValue: true },
    updatedAt: { timestampValue: nowIso },
  });

  const logId = makeServerId('log');
  await fsCreateDoc(projectId, accessToken, 'auditLogs', logId, {
    logId: { stringValue: logId },
    action: { stringValue: 'PASSWORD_RESET_COMPLETED' },
    targetType: { stringValue: 'staff' },
    targetId: { stringValue: canonicalId },
    actorStaffId: { stringValue: actorStaffId },
    actorName: { stringValue: actorName },
    actorRole: { stringValue: 'manager' },
    summary: {
      stringValue: `Manager ${actorStaffId} issued a temporary PIN reset for ${canonicalId} (${targetName}).`,
    },
    createdAt: { timestampValue: nowIso },
  });

  return jsonResponse({ ok: true, staffId: canonicalId });
}

const ALLOWED_ADD_STAFF_DESIGNATIONS = new Set([
  'MANAGER',
  'EXECUTIVE',
  'OFFICER',
  'ASSISTANT OFFICER',
  'ATTENDANT',
]);

const ALLOWED_ADD_STAFF_ROLES = new Set(['staff', 'executive', 'manager']);

async function handleAddStaff(request: Request, env: WorkerEnv): Promise<Response> {
  const ipLimit = checkIpRateLimit(request, env);
  if (!ipLimit.allowed) {
    return jsonResponse(
      { error: 'Too many requests. Please wait a moment and try again.' },
      429,
      { 'Retry-After': String(ipLimit.retryAfterSec) }
    );
  }

  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) {
    return jsonResponse({ error: 'Authentication required.' }, 401);
  }

  let body: {
    staffId?: unknown;
    fullName?: unknown;
    designation?: unknown;
    role?: unknown;
  };
  try {
    body = (await request.json()) as {
      staffId?: unknown;
      fullName?: unknown;
      designation?: unknown;
      role?: unknown;
    };
  } catch {
    return jsonResponse({ error: 'Invalid request payload.' }, 400);
  }

  const staffId = typeof body.staffId === 'string' ? body.staffId.trim() : '';
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const designation =
    typeof body.designation === 'string'
      ? body.designation.trim().toUpperCase().replace(/\s+/g, ' ')
      : '';
  const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';

  if (!isValidStaffIdFormat(staffId)) {
    return jsonResponse(
      { error: 'Staff ID must be 2 to 24 letters, numbers, or hyphens.' },
      400
    );
  }
  if (fullName.length < 2 || fullName.length > 100) {
    return jsonResponse(
      { error: 'Full Name must be between 2 and 100 characters.' },
      400
    );
  }
  if (!ALLOWED_ADD_STAFF_DESIGNATIONS.has(designation)) {
    return jsonResponse({ error: 'Please select a valid designation.' }, 400);
  }
  if (!ALLOWED_ADD_STAFF_ROLES.has(role)) {
    return jsonResponse({ error: 'Please select a valid role.' }, 400);
  }

  const sa = parseServiceAccount(env);
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || sa.project_id;

  let actorUid: string;
  try {
    const verified = await verifyFirebaseIdToken(idToken, projectId);
    actorUid = verified.uid;
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : 'Unauthorized session.' },
      401
    );
  }

  const accessToken = await getGoogleAccessToken(sa);
  const actorLink = await fsGetDoc(projectId, accessToken, `staffAuthLinks/${actorUid}`);
  if (
    !actorLink?.fields ||
    !fsBool(actorLink.fields, 'isActive', false) ||
    fsStr(actorLink.fields, 'role') !== 'manager'
  ) {
    return jsonResponse({ error: 'Only active Managers can add staff accounts.' }, 403);
  }

  const actorStaffId = fsStr(actorLink.fields, 'staffId');
  const actorDoc = await fsGetDoc(projectId, accessToken, `staff/${actorStaffId}`);
  const actorName = fsStr(actorDoc?.fields, 'fullName') || actorStaffId;

  // Prevent duplicate Staff IDs (exact or normalized token match)
  const existingStaff = await findAuthorizedStaffDoc(projectId, accessToken, staffId);
  if (existingStaff) {
    return jsonResponse(
      { error: `Staff ID ${existingStaff.staffId} already exists.` },
      409
    );
  }

  const uid = deterministicStaffUid(staffId);
  const [existingLink, existingSecret] = await Promise.all([
    fsGetDoc(projectId, accessToken, `staffAuthLinks/${uid}`),
    fsGetDoc(projectId, accessToken, `staffPinSecrets/${staffId}`),
  ]);
  if (existingLink || existingSecret) {
    return jsonResponse(
      { error: `A staff account with Staff ID ${staffId} already exists.` },
      409
    );
  }

  const nowIso = new Date().toISOString();
  const pinSalt = generateSaltHex(16);
  const pinHash = await hashPinPbkdf2('1234', pinSalt);
  const countsTowardDailyCap =
    designation === 'ASSISTANT OFFICER' || designation === 'ATTENDANT';

  try {
    await fsCreateDoc(projectId, accessToken, 'staffPinSecrets', staffId, {
      staffId: { stringValue: staffId },
      authUid: { stringValue: uid },
      pinSalt: { stringValue: pinSalt },
      pinHash: { stringValue: pinHash },
      hashAlgo: { stringValue: 'pbkdf2-sha256-100000' },
      mustChangePin: { booleanValue: true },
      failedAttempts: { integerValue: '0' },
      lockedUntilMs: { integerValue: '0' },
      updatedAt: { timestampValue: nowIso },
    });

    await fsCreateDoc(projectId, accessToken, 'staffAuthLinks', uid, {
      uid: { stringValue: uid },
      staffId: { stringValue: staffId },
      role: { stringValue: role },
      designation: { stringValue: designation },
      isActive: { booleanValue: true },
      updatedAt: { timestampValue: nowIso },
    });

    await fsCreateDoc(projectId, accessToken, 'staff', staffId, {
      staffId: { stringValue: staffId },
      authUid: { stringValue: uid },
      fullName: { stringValue: fullName },
      designation: { stringValue: designation },
      role: { stringValue: role },
      isActive: { booleanValue: true },
      mustChangePassword: { booleanValue: true },
      unitSection: { stringValue: 'Special Services' },
      annualPeriodLimit: { integerValue: '3' },
      countsTowardDailyCap: { booleanValue: countsTowardDailyCap },
      createdAt: { timestampValue: nowIso },
      updatedAt: { timestampValue: nowIso },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('(409)')) {
      return jsonResponse(
        { error: `Staff ID ${staffId} already exists.` },
        409
      );
    }
    throw err;
  }

  const logId = makeServerId('log');
  await fsCreateDoc(projectId, accessToken, 'auditLogs', logId, {
    logId: { stringValue: logId },
    action: { stringValue: 'STAFF_PROVISIONED' },
    targetType: { stringValue: 'staff' },
    targetId: { stringValue: staffId },
    actorStaffId: { stringValue: actorStaffId },
    actorName: { stringValue: actorName },
    actorRole: { stringValue: 'manager' },
    summary: {
      stringValue: `Manager ${actorStaffId} added staff ${staffId} (${fullName}, ${designation}, role=${role}) with default PIN.`,
    },
    newStatus: { stringValue: 'active' },
    createdAt: { timestampValue: nowIso },
  });

  return jsonResponse({
    ok: true,
    staffId,
    uid,
  });
}

async function handleSyncPendingCapacity(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  let force = false;
  try {
    const body = (await request.json()) as { force?: unknown };
    force = body?.force === true;
  } catch {
    force = false;
  }
  if (force && caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Managers can force a full capacity recalculation.');
  }
  const summary = await reconcilePendingCapacity(caller.projectId, caller.accessToken, force);
  return jsonResponse({ ok: true, ...summary });
}

async function handleSubmitLeave(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  await reconcilePendingCapacity(caller.projectId, caller.accessToken, false);

  let body: {
    leaveType?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    reason?: unknown;
  };
  try {
    body = (await request.json()) as {
      leaveType?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      reason?: unknown;
    };
  } catch {
    throw new HttpApiError(400, 'Invalid leave submission payload.');
  }

  const leaveType = typeof body.leaveType === 'string' ? body.leaveType.trim() : 'Annual Leave';
  const startDate = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const endDate = typeof body.endDate === 'string' ? body.endDate.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (leaveType !== 'Annual Leave') {
    throw new HttpApiError(400, 'Only Annual Leave applications are permitted.');
  }
  if (reason.length < 3 || reason.length > 500) {
    throw new HttpApiError(400, 'Reason must be between 3 and 500 characters.');
  }

  const expanded = expandMaldivesDateRange(startDate, endDate, 30);
  if (expanded.error) {
    throw new HttpApiError(400, expanded.error);
  }
  const dates = expanded.dates;
  const calendarYear = Number(startDate.slice(0, 4));
  const requestId = makeServerId('req');
  const logId = makeServerId('log');

  const restrictionDocs = await fsListCollection(
    caller.projectId,
    caller.accessToken,
    'leaveRestrictions'
  );
  const parsedRestrictions = restrictionDocs.map(parseLeaveRestrictionDoc);
  const blockedCheck = findBlockedDatesWorker(
    dates,
    parsedRestrictions,
    caller.staffId,
    caller.designation,
    caller.uid,
    caller.staffName
  );
  if (blockedCheck.matched.length > 0) {
    const primary = blockedCheck.matched[0];
    throw new HttpApiError(
      409,
      `You are not permitted to apply for leave during the selected dates. Reason: ${primary.reason}. Please select alternative dates.`
    );
  }

  const txResult = await runFirestoreTransaction(
    caller.projectId,
    caller.accessToken,
    async (tx) => {
      const capPaths = dates.map((d) => `dailyCapacity/${d}`);
      const detailPaths = dates.map((d) => `dailyCapacityDetails/${d}`);
      const [docsMap, userReqDocs] = await Promise.all([
        fsBatchGetDocs(
          caller.projectId,
          caller.accessToken,
          ['appSettings/portalConfig', `staff/${caller.staffId}`, ...capPaths, ...detailPaths],
          tx
        ),
        fsRunQuery(
          caller.projectId,
          caller.accessToken,
          {
            from: [{ collectionId: 'leaveRequests' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'staffId' },
                op: 'EQUAL',
                value: { stringValue: caller.staffId },
              },
            },
          },
          tx
        ),
      ]);

      const settingsDoc = docsMap['appSettings/portalConfig'];
      const staffDoc = docsMap[`staff/${caller.staffId}`];
      const maxCap = Math.min(
        10,
        Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
      );
      const settingsAnnual = Math.min(
        10,
        Math.max(1, fsInt(settingsDoc?.fields, 'maxAnnualLeavePeriods', 3))
      );
      const annualLimit = Math.min(
        10,
        Math.max(1, fsInt(staffDoc?.fields, 'annualPeriodLimit', settingsAnnual || caller.annualPeriodLimit))
      );

      const userReqs = userReqDocs.map(parseLeaveRequestDoc);
      const yearAllocated = userReqs.filter(
        (r) =>
          r.calendarYear === calendarYear &&
          (r.status === 'approved' || r.status === 'pending')
      );
      if (yearAllocated.length >= annualLimit) {
        throw new HttpApiError(
          409,
          `Annual limit reached for ${calendarYear}: ${yearAllocated.length}/${annualLimit} leave periods used or pending.`
        );
      }

      const bookedDates = new Set<string>();
      for (const r of userReqs) {
        if (r.status === 'approved' || r.status === 'pending') {
          for (const d of r.dates) bookedDates.add(d);
        }
      }
      const overlapping = dates.filter((d) => bookedDates.has(d));
      if (overlapping.length > 0) {
        throw new HttpApiError(
          409,
          `You already have pending or approved leave on: ${overlapping.join(', ')}.`
        );
      }

      const nowIso = new Date().toISOString();
      const writes: FirestoreWrite[] = [];
      const fullDates: string[] = [];

      for (const dateKey of dates) {
        const capDoc = docsMap[`dailyCapacity/${dateKey}`];
        const detailDoc = docsMap[`dailyCapacityDetails/${dateKey}`];
        const capLimit = Math.min(
          10,
          Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
        );

        const existingAllocs = fsAllocations(detailDoc?.fields).filter(
          (a) => a.requestId !== requestId
        );
        existingAllocs.push({
          staffId: caller.staffId,
          staffName: caller.staffName,
          designation: caller.designation,
          requestId,
          leaveType: 'Annual Leave',
          status: 'pending',
        });

        const summary = summarizeAllocationsForDate(existingAllocs);
        if (caller.countsTowardDailyCap && summary.occupiedCount > capLimit) {
          const priorSummary = summarizeAllocationsForDate(
            fsAllocations(detailDoc?.fields)
          );
          fullDates.push(`${dateKey} (${priorSummary.occupiedCount}/${capLimit})`);
          continue;
        }

        writes.push({
          update: {
            name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
            fields: {
              date: { stringValue: dateKey },
              approvedCount: { integerValue: String(summary.occupiedCount) },
              approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
              pendingCount: { integerValue: String(summary.pendingCount) },
              maxCapacity: { integerValue: String(capLimit) },
              updatedAt: { timestampValue: nowIso },
            },
          },
        });
        writes.push({
          update: {
            name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
            fields: {
              date: { stringValue: dateKey },
              allocations: allocationsToFirestoreValue(existingAllocs),
              updatedAt: { timestampValue: nowIso },
            },
          },
        });
      }

      if (fullDates.length > 0) {
        throw new HttpApiError(
          409,
          `Daily limit (${maxCap} combined Assistant Officers & Attendants) is full on: ${fullDates.join(', ')}.`
        );
      }

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `leaveRequests/${requestId}`),
          fields: {
            requestId: { stringValue: requestId },
            uid: { stringValue: caller.uid },
            staffId: { stringValue: caller.staffId },
            staffName: { stringValue: caller.staffName },
            designation: { stringValue: caller.designation },
            countsTowardDailyCap: { booleanValue: caller.countsTowardDailyCap },
            leaveType: { stringValue: 'Annual Leave' },
            startDate: { stringValue: startDate },
            endDate: { stringValue: endDate },
            dates: { arrayValue: { values: dates.map((d) => ({ stringValue: d })) } },
            daysCount: { integerValue: String(dates.length) },
            calendarYear: { integerValue: String(calendarYear) },
            reason: { stringValue: reason },
            status: { stringValue: 'pending' },
            modificationRequestType: { stringValue: 'none' },
            lastAuditLogId: { stringValue: logId },
            createdAt: { timestampValue: nowIso },
            updatedAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: false },
      });

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
          fields: {
            logId: { stringValue: logId },
            action: { stringValue: 'LEAVE_SUBMITTED' },
            targetType: { stringValue: 'leaveRequest' },
            targetId: { stringValue: requestId },
            actorStaffId: { stringValue: caller.staffId },
            actorName: { stringValue: caller.staffName },
            actorRole: { stringValue: caller.role },
            summary: {
              stringValue: `Submitted Annual Leave (${startDate} – ${endDate}, ${dates.length} day${dates.length > 1 ? 's' : ''}); daily slots reserved while pending.`,
            },
            newStatus: { stringValue: 'pending' },
            affectedDates: {
              arrayValue: { values: dates.slice(0, 31).map((d) => ({ stringValue: d })) },
            },
            createdAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: false },
      });

      return { writes, result: { ok: true, requestId } };
    }
  );

  return jsonResponse(txResult);
}

async function handleCancelPendingLeave(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  await reconcilePendingCapacity(caller.projectId, caller.accessToken, false);

  let body: { requestId?: unknown };
  try {
    body = (await request.json()) as { requestId?: unknown };
  } catch {
    throw new HttpApiError(400, 'Invalid request payload.');
  }

  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (!requestId) {
    throw new HttpApiError(400, 'Missing requestId.');
  }

  const logId = makeServerId('log');

  await runFirestoreTransaction(caller.projectId, caller.accessToken, async (tx) => {
    const reqMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [`leaveRequests/${requestId}`, 'appSettings/portalConfig'],
      tx
    );
    const reqDoc = reqMap[`leaveRequests/${requestId}`];
    if (!reqDoc?.fields) {
      throw new HttpApiError(404, 'Leave request not found.');
    }
    const reqData = parseLeaveRequestDoc(reqDoc);
    if (reqData.staffId !== caller.staffId) {
      throw new HttpApiError(403, 'You can only cancel your own pending leave requests.');
    }
    if (reqData.status !== 'pending') {
      throw new HttpApiError(409, `Cannot cancel: request status is already "${reqData.status}".`);
    }

    const settingsDoc = reqMap['appSettings/portalConfig'];
    const maxCap = Math.min(
      10,
      Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
    );

    const dateKeys = reqData.dates.filter(isValidDateKey);
    const capAndDetailMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [
        ...dateKeys.map((d) => `dailyCapacity/${d}`),
        ...dateKeys.map((d) => `dailyCapacityDetails/${d}`),
      ],
      tx
    );

    const nowIso = new Date().toISOString();
    const writes: FirestoreWrite[] = [];

    for (const dateKey of dateKeys) {
      const capDoc = capAndDetailMap[`dailyCapacity/${dateKey}`];
      const detailDoc = capAndDetailMap[`dailyCapacityDetails/${dateKey}`];
      const capLimit = Math.min(
        10,
        Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
      );
      const nextAllocs = fsAllocations(detailDoc?.fields).filter(
        (a) => a.requestId !== reqData.requestId
      );
      const summary = summarizeAllocationsForDate(nextAllocs);

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            approvedCount: { integerValue: String(summary.occupiedCount) },
            approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
            pendingCount: { integerValue: String(summary.pendingCount) },
            maxCapacity: { integerValue: String(capLimit) },
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            allocations: allocationsToFirestoreValue(nextAllocs),
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
    }

    const updatedReqFields: Record<string, FirestoreValue> = {
      ...(reqDoc.fields || {}),
      status: { stringValue: 'cancelled' },
      lastAuditLogId: { stringValue: logId },
      updatedAt: { timestampValue: nowIso },
    };
    writes.push({
      update: {
        name: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqData.requestId}`),
        fields: updatedReqFields,
      },
      currentDocument: { exists: true },
    });

    writes.push({
      update: {
        name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
        fields: {
          logId: { stringValue: logId },
          action: { stringValue: 'LEAVE_CANCELLED' },
          targetType: { stringValue: 'leaveRequest' },
          targetId: { stringValue: reqData.requestId },
          actorStaffId: { stringValue: caller.staffId },
          actorName: { stringValue: caller.staffName },
          actorRole: { stringValue: caller.role },
          summary: {
            stringValue: `Applicant cancelled pending ${reqData.leaveType} (${reqData.startDate} – ${reqData.endDate}) and released reserved slots.`,
          },
          previousStatus: { stringValue: 'pending' },
          newStatus: { stringValue: 'cancelled' },
          affectedDates: {
            arrayValue: { values: dateKeys.slice(0, 31).map((d) => ({ stringValue: d })) },
          },
          createdAt: { timestampValue: nowIso },
        },
      },
      currentDocument: { exists: false },
    });

    return { writes, result: true };
  });

  return jsonResponse({ ok: true, requestId });
}

async function handleEditPendingLeave(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  await reconcilePendingCapacity(caller.projectId, caller.accessToken, false);

  let body: {
    requestId?: unknown;
    startDate?: unknown;
    endDate?: unknown;
  };
  try {
    body = (await request.json()) as {
      requestId?: unknown;
      startDate?: unknown;
      endDate?: unknown;
    };
  } catch {
    throw new HttpApiError(400, 'Invalid edit leave payload.');
  }

  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  const startDate = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const endDate = typeof body.endDate === 'string' ? body.endDate.trim() : '';

  if (!requestId) {
    throw new HttpApiError(400, 'Missing requestId.');
  }

  const expanded = expandMaldivesDateRange(startDate, endDate, 30);
  if (expanded.error) {
    throw new HttpApiError(400, expanded.error);
  }
  const newDates = expanded.dates;
  const newCalendarYear = Number(startDate.slice(0, 4));
  const logId = makeServerId('log');

  // Verify active leave restrictions against all selected dates before touching slots
  const restrictionDocs = await fsListCollection(
    caller.projectId,
    caller.accessToken,
    'leaveRestrictions'
  );
  const parsedRestrictions = restrictionDocs.map(parseLeaveRestrictionDoc);
  const blockedCheck = findBlockedDatesWorker(
    newDates,
    parsedRestrictions,
    caller.staffId,
    caller.designation,
    caller.uid,
    caller.staffName
  );
  if (blockedCheck.matched.length > 0) {
    const primary = blockedCheck.matched[0];
    throw new HttpApiError(
      409,
      `You are not permitted to apply for leave during the selected dates (${formatLongDateWorker(primary.startDate)} to ${formatLongDateWorker(primary.endDate)}). Reason: ${primary.reason}. Please select alternative dates.`
    );
  }

  const txResult = await runFirestoreTransaction(
    caller.projectId,
    caller.accessToken,
    async (tx) => {
      const [baseDocsMap, userReqDocs] = await Promise.all([
        fsBatchGetDocs(
          caller.projectId,
          caller.accessToken,
          [`leaveRequests/${requestId}`, 'appSettings/portalConfig', `staff/${caller.staffId}`],
          tx
        ),
        fsRunQuery(
          caller.projectId,
          caller.accessToken,
          {
            from: [{ collectionId: 'leaveRequests' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'staffId' },
                op: 'EQUAL',
                value: { stringValue: caller.staffId },
              },
            },
          },
          tx
        ),
      ]);

      const reqDoc = baseDocsMap[`leaveRequests/${requestId}`];
      if (!reqDoc?.fields) {
        throw new HttpApiError(404, 'Leave application not found.');
      }

      const reqData = parseLeaveRequestDoc(reqDoc);
      if (reqData.staffId !== caller.staffId) {
        throw new HttpApiError(403, 'You can only edit your own pending leave applications.');
      }

      if (reqData.status !== 'pending') {
        throw new HttpApiError(
          409,
          'This leave application has already been reviewed and can no longer be edited.'
        );
      }

      if (startDate === reqData.startDate && endDate === reqData.endDate) {
        throw new HttpApiError(400, 'Please select different start or end dates to update.');
      }

      const settingsDoc = baseDocsMap['appSettings/portalConfig'];
      const staffDoc = baseDocsMap[`staff/${caller.staffId}`];
      const maxCap = Math.min(
        10,
        Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
      );
      const settingsAnnual = Math.min(
        10,
        Math.max(1, fsInt(settingsDoc?.fields, 'maxAnnualLeavePeriods', 3))
      );
      const annualLimit = Math.min(
        10,
        Math.max(
          1,
          fsInt(staffDoc?.fields, 'annualPeriodLimit', settingsAnnual || caller.annualPeriodLimit)
        )
      );

      // Exclude current request when verifying annual leave periods and overlapping leave
      const userReqs = userReqDocs
        .map(parseLeaveRequestDoc)
        .filter((r) => r.requestId !== reqData.requestId);

      const yearAllocated = userReqs.filter(
        (r) =>
          r.calendarYear === newCalendarYear &&
          (r.status === 'approved' || r.status === 'pending')
      );
      if (yearAllocated.length >= annualLimit) {
        throw new HttpApiError(
          409,
          `Annual limit reached for ${newCalendarYear}: ${yearAllocated.length}/${annualLimit} other leave periods used or pending.`
        );
      }

      const otherBookedDates = new Set<string>();
      for (const r of userReqs) {
        if (r.status === 'approved' || r.status === 'pending') {
          for (const d of r.dates) otherBookedDates.add(d);
        }
      }
      const overlapping = newDates.filter((d) => otherBookedDates.has(d));
      if (overlapping.length > 0) {
        throw new HttpApiError(
          409,
          `Requested dates overlap another pending or approved leave on: ${overlapping.join(', ')}.`
        );
      }

      const oldDateSet = new Set(reqData.dates.filter(isValidDateKey));
      const newDateSet = new Set(newDates.filter(isValidDateKey));
      const allDateKeys = Array.from(new Set([...oldDateSet, ...newDateSet]))
        .filter(isValidDateKey)
        .sort();

      const capAndDetailMap = await fsBatchGetDocs(
        caller.projectId,
        caller.accessToken,
        [
          ...allDateKeys.map((d) => `dailyCapacity/${d}`),
          ...allDateKeys.map((d) => `dailyCapacityDetails/${d}`),
        ],
        tx
      );

      const nowIso = new Date().toISOString();
      const writes: FirestoreWrite[] = [];
      const fullDates: string[] = [];

      for (const dateKey of allDateKeys) {
        const capDoc = capAndDetailMap[`dailyCapacity/${dateKey}`];
        const detailDoc = capAndDetailMap[`dailyCapacityDetails/${dateKey}`];
        const capLimit = Math.min(
          10,
          Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
        );

        const priorAllocs = fsAllocations(detailDoc?.fields);
        let nextAllocs = priorAllocs.filter((a) => a.requestId !== reqData.requestId);
        if (newDateSet.has(dateKey)) {
          nextAllocs = [
            ...nextAllocs,
            {
              staffId: reqData.staffId,
              staffName: reqData.staffName,
              designation: reqData.designation,
              requestId: reqData.requestId,
              leaveType: reqData.leaveType,
              status: 'pending',
            },
          ];
        }

        const summary = summarizeAllocationsForDate(nextAllocs);
        // Staff can always keep dates they already reserved; only newly added dates must pass cap check.
        if (
          reqData.countsTowardDailyCap &&
          newDateSet.has(dateKey) &&
          !oldDateSet.has(dateKey) &&
          summary.occupiedCount > capLimit
        ) {
          const priorSummary = summarizeAllocationsForDate(priorAllocs);
          fullDates.push(`${dateKey} (${priorSummary.occupiedCount}/${capLimit})`);
          continue;
        }

        writes.push({
          update: {
            name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
            fields: {
              date: { stringValue: dateKey },
              approvedCount: { integerValue: String(summary.occupiedCount) },
              approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
              pendingCount: { integerValue: String(summary.pendingCount) },
              maxCapacity: { integerValue: String(capLimit) },
              updatedAt: { timestampValue: nowIso },
            },
          },
        });
        writes.push({
          update: {
            name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
            fields: {
              date: { stringValue: dateKey },
              allocations: allocationsToFirestoreValue(nextAllocs),
              updatedAt: { timestampValue: nowIso },
            },
          },
        });
      }

      if (fullDates.length > 0) {
        throw new HttpApiError(
          409,
          `Daily limit (${maxCap} combined Assistant Officers & Attendants) is full on: ${fullDates.join(', ')}.`
        );
      }

      const updatedReqFields: Record<string, FirestoreValue> = {
        ...(reqDoc.fields || {}),
        startDate: { stringValue: startDate },
        endDate: { stringValue: endDate },
        dates: { arrayValue: { values: newDates.map((d) => ({ stringValue: d })) } },
        daysCount: { integerValue: String(newDates.length) },
        calendarYear: { integerValue: String(newCalendarYear) },
        status: { stringValue: 'pending' },
        modificationRequestType: { stringValue: 'none' },
        editedAt: { timestampValue: nowIso },
        lastAuditLogId: { stringValue: logId },
        updatedAt: { timestampValue: nowIso },
      };

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqData.requestId}`),
          fields: updatedReqFields,
        },
        currentDocument: { exists: true },
      });

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
          fields: {
            logId: { stringValue: logId },
            action: { stringValue: 'LEAVE_EDITED' },
            targetType: { stringValue: 'leaveRequest' },
            targetId: { stringValue: reqData.requestId },
            actorStaffId: { stringValue: caller.staffId },
            actorName: { stringValue: caller.staffName },
            actorRole: { stringValue: caller.role },
            summary: {
              stringValue: `${caller.staffName} (${caller.staffId}) edited pending ${reqData.leaveType} dates from ${reqData.startDate} – ${reqData.endDate} to ${startDate} – ${endDate} (${newDates.length} day${newDates.length > 1 ? 's' : ''}); daily slots updated.`,
            },
            previousStatus: { stringValue: 'pending' },
            newStatus: { stringValue: 'pending' },
            affectedDates: {
              arrayValue: {
                values: allDateKeys.slice(0, 31).map((d) => ({ stringValue: d })),
              },
            },
            createdAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: false },
      });

      return {
        writes,
        result: {
          ok: true,
          requestId: reqData.requestId,
          startDate,
          endDate,
          daysCount: newDates.length,
        },
      };
    }
  );

  return jsonResponse(txResult);
}

async function handleApproveLeave(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'executive' && caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Executives and Managers can approve leave requests.');
  }
  await reconcilePendingCapacity(caller.projectId, caller.accessToken, false);

  let body: { requestId?: unknown; comment?: unknown };
  try {
    body = (await request.json()) as { requestId?: unknown; comment?: unknown };
  } catch {
    throw new HttpApiError(400, 'Invalid request payload.');
  }

  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
  if (!requestId) {
    throw new HttpApiError(400, 'Missing requestId.');
  }

  const logId = makeServerId('log');

  await runFirestoreTransaction(caller.projectId, caller.accessToken, async (tx) => {
    const reqMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [`leaveRequests/${requestId}`, 'appSettings/portalConfig'],
      tx
    );
    const reqDoc = reqMap[`leaveRequests/${requestId}`];
    if (!reqDoc?.fields) {
      throw new HttpApiError(404, 'Leave request not found.');
    }
    const reqData = parseLeaveRequestDoc(reqDoc);
    if (reqData.staffId === caller.staffId) {
      throw new HttpApiError(403, 'You cannot approve your own leave request.');
    }
    if (reqData.status !== 'pending') {
      throw new HttpApiError(409, `Cannot approve: request status is already "${reqData.status}".`);
    }

    const settingsDoc = reqMap['appSettings/portalConfig'];
    const maxCap = Math.min(
      10,
      Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
    );

    const dateKeys = reqData.dates.filter(isValidDateKey);
    const capAndDetailMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [
        ...dateKeys.map((d) => `dailyCapacity/${d}`),
        ...dateKeys.map((d) => `dailyCapacityDetails/${d}`),
      ],
      tx
    );

    const nowIso = new Date().toISOString();
    const writes: FirestoreWrite[] = [];
    const fullDates: string[] = [];

    for (const dateKey of dateKeys) {
      const capDoc = capAndDetailMap[`dailyCapacity/${dateKey}`];
      const detailDoc = capAndDetailMap[`dailyCapacityDetails/${dateKey}`];
      const capLimit = Math.min(
        10,
        Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
      );

      const priorAllocs = fsAllocations(detailDoc?.fields);
      const wasAlreadyReserved = priorAllocs.some((a) => a.requestId === reqData.requestId);
      const nextAllocs = priorAllocs.filter((a) => a.requestId !== reqData.requestId);
      nextAllocs.push({
        staffId: reqData.staffId,
        staffName: reqData.staffName,
        designation: reqData.designation,
        requestId: reqData.requestId,
        leaveType: reqData.leaveType,
        status: 'approved',
      });

      const summary = summarizeAllocationsForDate(nextAllocs);
      if (reqData.countsTowardDailyCap && !wasAlreadyReserved && summary.occupiedCount > capLimit) {
        fullDates.push(`${dateKey} (${summary.occupiedCount}/${capLimit})`);
        continue;
      }

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            approvedCount: { integerValue: String(summary.occupiedCount) },
            approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
            pendingCount: { integerValue: String(summary.pendingCount) },
            maxCapacity: { integerValue: String(capLimit) },
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            allocations: allocationsToFirestoreValue(nextAllocs),
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
    }

    if (fullDates.length > 0) {
      throw new HttpApiError(409, `Approval blocked — daily limit reached on: ${fullDates.join(', ')}.`);
    }

    const updatedReqFields: Record<string, FirestoreValue> = {
      ...(reqDoc.fields || {}),
      status: { stringValue: 'approved' },
      reviewedByStaffId: { stringValue: caller.staffId },
      reviewedByName: { stringValue: caller.staffName },
      reviewComment: {
        stringValue: comment || 'Approved within operational capacity.',
      },
      lastAuditLogId: { stringValue: logId },
      updatedAt: { timestampValue: nowIso },
    };
    writes.push({
      update: {
        name: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqData.requestId}`),
        fields: updatedReqFields,
      },
      currentDocument: { exists: true },
    });

    writes.push({
      update: {
        name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
        fields: {
          logId: { stringValue: logId },
          action: { stringValue: 'LEAVE_APPROVED' },
          targetType: { stringValue: 'leaveRequest' },
          targetId: { stringValue: reqData.requestId },
          actorStaffId: { stringValue: caller.staffId },
          actorName: { stringValue: caller.staffName },
          actorRole: { stringValue: caller.role },
          summary: {
            stringValue: `Approved ${reqData.staffName} (${reqData.staffId}) ${reqData.leaveType} for ${reqData.startDate} – ${reqData.endDate}.`,
          },
          previousStatus: { stringValue: 'pending' },
          newStatus: { stringValue: 'approved' },
          affectedDates: {
            arrayValue: { values: dateKeys.slice(0, 31).map((d) => ({ stringValue: d })) },
          },
          createdAt: { timestampValue: nowIso },
        },
      },
      currentDocument: { exists: false },
    });

    return { writes, result: true };
  });

  return jsonResponse({ ok: true, requestId });
}

async function handleRejectLeave(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'executive' && caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Executives and Managers can reject leave requests.');
  }
  await reconcilePendingCapacity(caller.projectId, caller.accessToken, false);

  let body: { requestId?: unknown; comment?: unknown };
  try {
    body = (await request.json()) as { requestId?: unknown; comment?: unknown };
  } catch {
    throw new HttpApiError(400, 'Invalid request payload.');
  }

  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
  if (!requestId) {
    throw new HttpApiError(400, 'Missing requestId.');
  }

  const logId = makeServerId('log');

  await runFirestoreTransaction(caller.projectId, caller.accessToken, async (tx) => {
    const reqMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [`leaveRequests/${requestId}`, 'appSettings/portalConfig'],
      tx
    );
    const reqDoc = reqMap[`leaveRequests/${requestId}`];
    if (!reqDoc?.fields) {
      throw new HttpApiError(404, 'Leave request not found.');
    }
    const reqData = parseLeaveRequestDoc(reqDoc);
    if (reqData.staffId === caller.staffId) {
      throw new HttpApiError(403, 'You cannot reject your own leave request.');
    }
    if (reqData.status !== 'pending') {
      throw new HttpApiError(409, `Cannot reject: request status is already "${reqData.status}".`);
    }

    const settingsDoc = reqMap['appSettings/portalConfig'];
    const maxCap = Math.min(
      10,
      Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
    );

    const dateKeys = reqData.dates.filter(isValidDateKey);
    const capAndDetailMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [
        ...dateKeys.map((d) => `dailyCapacity/${d}`),
        ...dateKeys.map((d) => `dailyCapacityDetails/${d}`),
      ],
      tx
    );

    const nowIso = new Date().toISOString();
    const writes: FirestoreWrite[] = [];

    for (const dateKey of dateKeys) {
      const capDoc = capAndDetailMap[`dailyCapacity/${dateKey}`];
      const detailDoc = capAndDetailMap[`dailyCapacityDetails/${dateKey}`];
      const capLimit = Math.min(
        10,
        Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
      );
      const nextAllocs = fsAllocations(detailDoc?.fields).filter(
        (a) => a.requestId !== reqData.requestId
      );
      const summary = summarizeAllocationsForDate(nextAllocs);

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            approvedCount: { integerValue: String(summary.occupiedCount) },
            approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
            pendingCount: { integerValue: String(summary.pendingCount) },
            maxCapacity: { integerValue: String(capLimit) },
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            allocations: allocationsToFirestoreValue(nextAllocs),
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
    }

    const updatedReqFields: Record<string, FirestoreValue> = {
      ...(reqDoc.fields || {}),
      status: { stringValue: 'rejected' },
      reviewedByStaffId: { stringValue: caller.staffId },
      reviewedByName: { stringValue: caller.staffName },
      reviewComment: {
        stringValue: comment || 'Declined due to operational requirements.',
      },
      lastAuditLogId: { stringValue: logId },
      updatedAt: { timestampValue: nowIso },
    };
    writes.push({
      update: {
        name: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqData.requestId}`),
        fields: updatedReqFields,
      },
      currentDocument: { exists: true },
    });

    writes.push({
      update: {
        name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
        fields: {
          logId: { stringValue: logId },
          action: { stringValue: 'LEAVE_REJECTED' },
          targetType: { stringValue: 'leaveRequest' },
          targetId: { stringValue: reqData.requestId },
          actorStaffId: { stringValue: caller.staffId },
          actorName: { stringValue: caller.staffName },
          actorRole: { stringValue: caller.role },
          summary: {
            stringValue: `Rejected ${reqData.staffName} (${reqData.staffId}) ${reqData.leaveType} and released reserved slots. Reason: ${comment || 'Operational requirements'}`,
          },
          previousStatus: { stringValue: 'pending' },
          newStatus: { stringValue: 'rejected' },
          affectedDates: {
            arrayValue: { values: dateKeys.slice(0, 31).map((d) => ({ stringValue: d })) },
          },
          createdAt: { timestampValue: nowIso },
        },
      },
      currentDocument: { exists: false },
    });

    return { writes, result: true };
  });

  return jsonResponse({ ok: true, requestId });
}

async function handleProcessModification(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'executive' && caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Executives and Managers can process leave modifications.');
  }
  await reconcilePendingCapacity(caller.projectId, caller.accessToken, false);

  let body: { requestId?: unknown; decision?: unknown; comment?: unknown };
  try {
    body = (await request.json()) as {
      requestId?: unknown;
      decision?: unknown;
      comment?: unknown;
    };
  } catch {
    throw new HttpApiError(400, 'Invalid request payload.');
  }

  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';

  if (
    !requestId ||
    !['approve_cancel', 'approve_edit', 'decline_modification'].includes(decision)
  ) {
    throw new HttpApiError(400, 'Invalid modification decision.');
  }

  const logId = makeServerId('log');

  await runFirestoreTransaction(caller.projectId, caller.accessToken, async (tx) => {
    const reqMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [`leaveRequests/${requestId}`, 'appSettings/portalConfig'],
      tx
    );
    const reqDoc = reqMap[`leaveRequests/${requestId}`];
    if (!reqDoc?.fields) {
      throw new HttpApiError(404, 'Leave request not found.');
    }
    const reqData = parseLeaveRequestDoc(reqDoc);
    if (reqData.staffId === caller.staffId) {
      throw new HttpApiError(403, 'You cannot process modification on your own leave.');
    }
    if (reqData.status !== 'approved') {
      throw new HttpApiError(409, 'Only approved leave requests can be modified.');
    }

    const nowIso = new Date().toISOString();

    if (decision === 'decline_modification') {
      const writes: FirestoreWrite[] = [
        {
          update: {
            name: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqData.requestId}`),
            fields: {
              ...(reqDoc.fields || {}),
              modificationRequestType: { stringValue: 'none' },
              modificationNote: { stringValue: '' },
              requestedStartDate: { stringValue: '' },
              requestedEndDate: { stringValue: '' },
              reviewedByStaffId: { stringValue: caller.staffId },
              reviewedByName: { stringValue: caller.staffName },
              reviewComment: { stringValue: comment || 'Modification request declined.' },
              lastAuditLogId: { stringValue: logId },
              updatedAt: { timestampValue: nowIso },
            },
          },
          currentDocument: { exists: true },
        },
        {
          update: {
            name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
            fields: {
              logId: { stringValue: logId },
              action: { stringValue: 'LEAVE_MODIFIED' },
              targetType: { stringValue: 'leaveRequest' },
              targetId: { stringValue: reqData.requestId },
              actorStaffId: { stringValue: caller.staffId },
              actorName: { stringValue: caller.staffName },
              actorRole: { stringValue: caller.role },
              summary: {
                stringValue: `Declined modification request for ${reqData.staffName} (${reqData.staffId}).`,
              },
              previousStatus: { stringValue: 'approved' },
              newStatus: { stringValue: 'approved' },
              affectedDates: {
                arrayValue: {
                  values: reqData.dates.slice(0, 31).map((d) => ({ stringValue: d })),
                },
              },
              createdAt: { timestampValue: nowIso },
            },
          },
          currentDocument: { exists: false },
        },
      ];
      return { writes, result: true };
    }

    let newDates: string[] = [];
    if (decision === 'approve_edit') {
      const expanded = expandMaldivesDateRange(
        reqData.requestedStartDate,
        reqData.requestedEndDate,
        30
      );
      if (expanded.error) {
        throw new HttpApiError(400, expanded.error);
      }
      newDates = expanded.dates;

      const restrictionDocs = await fsListCollection(
        caller.projectId,
        caller.accessToken,
        'leaveRestrictions'
      );
      const blockedCheck = findBlockedDatesWorker(
        newDates,
        restrictionDocs.map(parseLeaveRestrictionDoc),
        reqData.staffId,
        reqData.designation,
        reqData.uid,
        reqData.staffName
      );
      if (blockedCheck.matched.length > 0) {
        const primary = blockedCheck.matched[0];
        throw new HttpApiError(
          409,
          `You are not permitted to apply for leave during the selected dates (${formatLongDateWorker(primary.startDate)} to ${formatLongDateWorker(primary.endDate)}). Reason: ${primary.reason}. Please select alternative dates.`
        );
      }

      // Prevent overlapping another pending or approved leave of the same staff member
      const applicantDocs = await fsRunQuery(
        caller.projectId,
        caller.accessToken,
        {
          from: [{ collectionId: 'leaveRequests' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'staffId' },
              op: 'EQUAL',
              value: { stringValue: reqData.staffId },
            },
          },
        },
        tx
      );
      const otherBookedDates = new Set<string>();
      for (const d of applicantDocs) {
        const parsed = parseLeaveRequestDoc(d);
        if (
          parsed.requestId !== reqData.requestId &&
          (parsed.status === 'pending' || parsed.status === 'approved')
        ) {
          for (const dt of parsed.dates) otherBookedDates.add(dt);
        }
      }
      const overlaps = newDates.filter((d) => otherBookedDates.has(d));
      if (overlaps.length > 0) {
        throw new HttpApiError(
          409,
          `Cannot apply new dates — overlaps another pending or approved leave on: ${overlaps.join(', ')}.`
        );
      }
    }

    const settingsDoc = reqMap['appSettings/portalConfig'];
    const maxCap = Math.min(
      10,
      Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
    );

    const allDateKeys = Array.from(new Set([...reqData.dates, ...newDates]))
      .filter(isValidDateKey)
      .sort();
    const newSet = new Set(newDates);
    const oldSet = new Set(reqData.dates);

    const capAndDetailMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [
        ...allDateKeys.map((d) => `dailyCapacity/${d}`),
        ...allDateKeys.map((d) => `dailyCapacityDetails/${d}`),
      ],
      tx
    );

    const writes: FirestoreWrite[] = [];
    const fullDates: string[] = [];

    for (const dateKey of allDateKeys) {
      const capDoc = capAndDetailMap[`dailyCapacity/${dateKey}`];
      const detailDoc = capAndDetailMap[`dailyCapacityDetails/${dateKey}`];
      const capLimit = Math.min(
        10,
        Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
      );

      let nextAllocs = fsAllocations(detailDoc?.fields).filter(
        (a) => a.requestId !== reqData.requestId
      );
      if (newSet.has(dateKey)) {
        nextAllocs = [
          ...nextAllocs,
          {
            staffId: reqData.staffId,
            staffName: reqData.staffName,
            designation: reqData.designation,
            requestId: reqData.requestId,
            leaveType: reqData.leaveType,
            status: 'approved',
          },
        ];
      }

      const summary = summarizeAllocationsForDate(nextAllocs);
      if (
        reqData.countsTowardDailyCap &&
        newSet.has(dateKey) &&
        !oldSet.has(dateKey) &&
        summary.occupiedCount > capLimit
      ) {
        const priorSummary = summarizeAllocationsForDate(
          fsAllocations(detailDoc?.fields)
        );
        fullDates.push(`${dateKey} (${priorSummary.occupiedCount}/${capLimit})`);
        continue;
      }

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            approvedCount: { integerValue: String(summary.occupiedCount) },
            approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
            pendingCount: { integerValue: String(summary.pendingCount) },
            maxCapacity: { integerValue: String(capLimit) },
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            allocations: allocationsToFirestoreValue(nextAllocs),
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
    }

    if (fullDates.length > 0) {
      throw new HttpApiError(
        409,
        `Cannot apply new dates — capacity full on: ${fullDates.join(', ')}.`
      );
    }

    if (decision === 'approve_cancel') {
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqData.requestId}`),
          fields: {
            ...(reqDoc.fields || {}),
            status: { stringValue: 'cancelled' },
            modificationRequestType: { stringValue: 'none' },
            reviewedByStaffId: { stringValue: caller.staffId },
            reviewedByName: { stringValue: caller.staffName },
            reviewComment: {
              stringValue: comment || 'Approved leave cancelled and capacity released.',
            },
            lastAuditLogId: { stringValue: logId },
            updatedAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: true },
      });
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
          fields: {
            logId: { stringValue: logId },
            action: { stringValue: 'LEAVE_CANCELLED' },
            targetType: { stringValue: 'leaveRequest' },
            targetId: { stringValue: reqData.requestId },
            actorStaffId: { stringValue: caller.staffId },
            actorName: { stringValue: caller.staffName },
            actorRole: { stringValue: caller.role },
            summary: {
              stringValue: `Cancelled approved leave for ${reqData.staffName} (${reqData.staffId}) and released daily slots.`,
            },
            previousStatus: { stringValue: 'approved' },
            newStatus: { stringValue: 'cancelled' },
            affectedDates: {
              arrayValue: {
                values: reqData.dates.slice(0, 31).map((d) => ({ stringValue: d })),
              },
            },
            createdAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: false },
      });
    } else {
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqData.requestId}`),
          fields: {
            ...(reqDoc.fields || {}),
            startDate: { stringValue: reqData.requestedStartDate },
            endDate: { stringValue: reqData.requestedEndDate },
            dates: {
              arrayValue: { values: newDates.map((d) => ({ stringValue: d })) },
            },
            daysCount: { integerValue: String(newDates.length) },
            calendarYear: {
              integerValue: String(Number(reqData.requestedStartDate.slice(0, 4))),
            },
            modificationRequestType: { stringValue: 'none' },
            modificationNote: { stringValue: '' },
            requestedStartDate: { stringValue: '' },
            requestedEndDate: { stringValue: '' },
            reviewedByStaffId: { stringValue: caller.staffId },
            reviewedByName: { stringValue: caller.staffName },
            reviewComment: {
              stringValue: comment || 'Approved date modification applied.',
            },
            lastAuditLogId: { stringValue: logId },
            updatedAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: true },
      });
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
          fields: {
            logId: { stringValue: logId },
            action: { stringValue: 'LEAVE_MODIFIED' },
            targetType: { stringValue: 'leaveRequest' },
            targetId: { stringValue: reqData.requestId },
            actorStaffId: { stringValue: caller.staffId },
            actorName: { stringValue: caller.staffName },
            actorRole: { stringValue: caller.role },
            summary: {
              stringValue: `Updated approved leave dates for ${reqData.staffName} (${reqData.staffId}) to ${reqData.requestedStartDate} – ${reqData.requestedEndDate}.`,
            },
            previousStatus: { stringValue: 'approved' },
            newStatus: { stringValue: 'approved' },
            affectedDates: {
              arrayValue: {
                values: allDateKeys.slice(0, 31).map((d) => ({ stringValue: d })),
              },
            },
            createdAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: false },
      });
    }

    return { writes, result: true };
  });

  return jsonResponse({ ok: true, requestId });
}

async function handleRemoveApprovedLeave(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'executive' && caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Executives and Managers can remove approved leave.');
  }
  await reconcilePendingCapacity(caller.projectId, caller.accessToken, false);

  let body: { requestId?: unknown };
  try {
    body = (await request.json()) as { requestId?: unknown };
  } catch {
    throw new HttpApiError(400, 'Invalid request payload.');
  }

  const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (!requestId) {
    throw new HttpApiError(400, 'Missing requestId.');
  }

  const logId = makeServerId('log');

  await runFirestoreTransaction(caller.projectId, caller.accessToken, async (tx) => {
    const reqMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [`leaveRequests/${requestId}`, 'appSettings/portalConfig'],
      tx
    );
    const reqDoc = reqMap[`leaveRequests/${requestId}`];
    if (!reqDoc?.fields) {
      throw new HttpApiError(404, 'Leave request not found.');
    }
    const reqData = parseLeaveRequestDoc(reqDoc);
    if (reqData.status !== 'approved') {
      throw new HttpApiError(
        409,
        `Only approved leave applications can be removed (current status: "${reqData.status}").`
      );
    }

    const settingsDoc = reqMap['appSettings/portalConfig'];
    const maxCap = Math.min(
      10,
      Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
    );

    const dateKeys = reqData.dates.filter(isValidDateKey);
    const capAndDetailMap = await fsBatchGetDocs(
      caller.projectId,
      caller.accessToken,
      [
        ...dateKeys.map((d) => `dailyCapacity/${d}`),
        ...dateKeys.map((d) => `dailyCapacityDetails/${d}`),
      ],
      tx
    );

    const nowIso = new Date().toISOString();
    const writes: FirestoreWrite[] = [];

    for (const dateKey of dateKeys) {
      const capDoc = capAndDetailMap[`dailyCapacity/${dateKey}`];
      const detailDoc = capAndDetailMap[`dailyCapacityDetails/${dateKey}`];
      const capLimit = Math.min(
        10,
        Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
      );

      const nextAllocs = fsAllocations(detailDoc?.fields).filter(
        (a) => a.requestId !== reqData.requestId
      );
      const summary = summarizeAllocationsForDate(nextAllocs);

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            approvedCount: { integerValue: String(summary.occupiedCount) },
            approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
            pendingCount: { integerValue: String(summary.pendingCount) },
            maxCapacity: { integerValue: String(capLimit) },
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
          fields: {
            date: { stringValue: dateKey },
            allocations: allocationsToFirestoreValue(nextAllocs),
            updatedAt: { timestampValue: nowIso },
          },
        },
      });
    }

    const updatedReqFields: Record<string, FirestoreValue> = {
      ...(reqDoc.fields || {}),
      status: { stringValue: 'cancelled' },
      modificationRequestType: { stringValue: 'none' },
      modificationNote: { stringValue: '' },
      requestedStartDate: { stringValue: '' },
      requestedEndDate: { stringValue: '' },
      reviewedByStaffId: { stringValue: caller.staffId },
      reviewedByName: { stringValue: caller.staffName },
      reviewComment: {
        stringValue: `Approved leave removed by ${caller.staffName} (${caller.staffId}).`,
      },
      lastAuditLogId: { stringValue: logId },
      updatedAt: { timestampValue: nowIso },
    };

    writes.push({
      update: {
        name: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqData.requestId}`),
        fields: updatedReqFields,
      },
      currentDocument: { exists: true },
    });

    writes.push({
      update: {
        name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
        fields: {
          logId: { stringValue: logId },
          action: { stringValue: 'LEAVE_CANCELLED' },
          targetType: { stringValue: 'leaveRequest' },
          targetId: { stringValue: reqData.requestId },
          actorStaffId: { stringValue: caller.staffId },
          actorName: { stringValue: caller.staffName },
          actorRole: { stringValue: caller.role },
          summary: {
            stringValue: `Removed approved ${reqData.leaveType} for ${reqData.staffName} (${reqData.staffId}) (${reqData.startDate} – ${reqData.endDate}) and released daily slots.`,
          },
          previousStatus: { stringValue: 'approved' },
          newStatus: { stringValue: 'cancelled' },
          affectedDates: {
            arrayValue: { values: dateKeys.slice(0, 31).map((d) => ({ stringValue: d })) },
          },
          createdAt: { timestampValue: nowIso },
        },
      },
      currentDocument: { exists: false },
    });

    return { writes, result: true };
  });

  return jsonResponse({ ok: true, requestId });
}

async function handleManagerAddLeave(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Managers can add leave directly.');
  }
  await reconcilePendingCapacity(caller.projectId, caller.accessToken, false);

  let body: {
    staffId?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    reason?: unknown;
    confirmOverlap?: unknown;
  };
  try {
    body = (await request.json()) as {
      staffId?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      reason?: unknown;
      confirmOverlap?: unknown;
    };
  } catch {
    throw new HttpApiError(400, 'Invalid request payload.');
  }

  const rawStaffId = typeof body.staffId === 'string' ? body.staffId.trim() : '';
  const startDate = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const endDate = typeof body.endDate === 'string' ? body.endDate.trim() : '';
  const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const confirmOverlap = body.confirmOverlap === true;

  if (!isValidStaffIdFormat(rawStaffId)) {
    throw new HttpApiError(400, 'Please select a valid Staff Member.');
  }
  if (rawReason.length > 0 && rawReason.length < 3) {
    throw new HttpApiError(400, 'Reason / Remarks must be at least 3 characters if provided.');
  }
  if (rawReason.length > 500) {
    throw new HttpApiError(400, 'Reason / Remarks cannot exceed 500 characters.');
  }
  const reason = rawReason || 'Added directly by Manager.';

  const expanded = expandMaldivesDateRange(startDate, endDate, 30);
  if (expanded.error) {
    throw new HttpApiError(400, expanded.error);
  }
  const dates = expanded.dates;
  const calendarYear = Number(startDate.slice(0, 4));

  const targetMatch = await findAuthorizedStaffDoc(
    caller.projectId,
    caller.accessToken,
    rawStaffId
  );
  if (!targetMatch?.doc.fields) {
    throw new HttpApiError(404, `Staff account ${rawStaffId} was not found.`);
  }
  const targetFields = targetMatch.doc.fields;
  const targetStaffId = targetMatch.staffId;
  if (!fsBool(targetFields, 'isActive', true)) {
    throw new HttpApiError(
      400,
      `Staff account ${targetStaffId} is inactive. Reactivate the account before assigning leave.`
    );
  }

  const targetName = fsStr(targetFields, 'fullName') || targetStaffId;
  const targetDesignation = fsStr(targetFields, 'designation') || 'ASSISTANT OFFICER';
  const targetUid = fsStr(targetFields, 'authUid') || deterministicStaffUid(targetStaffId);
  const targetCountsTowardCap =
    typeof targetFields.countsTowardDailyCap === 'object' &&
    'booleanValue' in targetFields.countsTowardDailyCap
      ? fsBool(targetFields, 'countsTowardDailyCap')
      : doesDesignationCountTowardCap(targetDesignation);

  const requestId = makeServerId('req');
  const logId = makeServerId('log');

  const txResult = await runFirestoreTransaction(
    caller.projectId,
    caller.accessToken,
    async (tx) => {
      const capPaths = dates.map((d) => `dailyCapacity/${d}`);
      const detailPaths = dates.map((d) => `dailyCapacityDetails/${d}`);
      const [docsMap, targetReqDocs] = await Promise.all([
        fsBatchGetDocs(
          caller.projectId,
          caller.accessToken,
          ['appSettings/portalConfig', ...capPaths, ...detailPaths],
          tx
        ),
        fsRunQuery(
          caller.projectId,
          caller.accessToken,
          {
            from: [{ collectionId: 'leaveRequests' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'staffId' },
                op: 'EQUAL',
                value: { stringValue: targetStaffId },
              },
            },
          },
          tx
        ),
      ]);

      const bookedDates = new Set<string>();
      for (const doc of targetReqDocs) {
        const parsed = parseLeaveRequestDoc(doc);
        if (parsed.status === 'pending' || parsed.status === 'approved') {
          for (const d of parsed.dates) bookedDates.add(d);
        }
      }
      const overlappingDates = dates.filter((d) => bookedDates.has(d));
      if (overlappingDates.length > 0 && !confirmOverlap) {
        throw new HttpApiError(
          409,
          `OVERLAP_CONFIRM_REQUIRED: ${targetName} (${targetStaffId}) already has pending or approved leave on: ${overlappingDates.join(', ')}. Please confirm to add overlapping leave.`
        );
      }

      const settingsDoc = docsMap['appSettings/portalConfig'];
      const maxCap = Math.min(
        10,
        Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
      );

      const nowIso = new Date().toISOString();
      const writes: FirestoreWrite[] = [];
      let peakOccupied = 0;

      // Manager-added leave bypasses 3-period annual limit, 10-slot daily cap, blocked dates, and (with confirmation) overlaps
      for (const dateKey of dates) {
        const capDoc = docsMap[`dailyCapacity/${dateKey}`];
        const detailDoc = docsMap[`dailyCapacityDetails/${dateKey}`];
        const capLimit = Math.min(
          10,
          Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
        );

        const nextAllocs = fsAllocations(detailDoc?.fields).filter(
          (a) => a.requestId !== requestId
        );
        nextAllocs.push({
          staffId: targetStaffId,
          staffName: targetName,
          designation: targetDesignation,
          requestId,
          leaveType: 'Annual Leave',
          status: 'approved',
        });

        const summary = summarizeAllocationsForDate(nextAllocs);
        if (summary.occupiedCount > peakOccupied) {
          peakOccupied = summary.occupiedCount;
        }

        writes.push({
          update: {
            name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
            fields: {
              date: { stringValue: dateKey },
              approvedCount: { integerValue: String(summary.occupiedCount) },
              approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
              pendingCount: { integerValue: String(summary.pendingCount) },
              maxCapacity: { integerValue: String(capLimit) },
              updatedAt: { timestampValue: nowIso },
            },
          },
        });
        writes.push({
          update: {
            name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
            fields: {
              date: { stringValue: dateKey },
              allocations: allocationsToFirestoreValue(nextAllocs),
              updatedAt: { timestampValue: nowIso },
            },
          },
        });
      }

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `leaveRequests/${requestId}`),
          fields: {
            requestId: { stringValue: requestId },
            ...(targetUid ? { uid: { stringValue: targetUid } } : {}),
            staffId: { stringValue: targetStaffId },
            staffName: { stringValue: targetName },
            designation: { stringValue: targetDesignation },
            countsTowardDailyCap: { booleanValue: targetCountsTowardCap },
            leaveType: { stringValue: 'Annual Leave' },
            startDate: { stringValue: startDate },
            endDate: { stringValue: endDate },
            dates: { arrayValue: { values: dates.map((d) => ({ stringValue: d })) } },
            daysCount: { integerValue: String(dates.length) },
            calendarYear: { integerValue: String(calendarYear) },
            reason: { stringValue: reason },
            status: { stringValue: 'approved' },
            modificationRequestType: { stringValue: 'none' },
            addedByManager: { booleanValue: true },
            addedByStaffId: { stringValue: caller.staffId },
            addedByName: { stringValue: caller.staffName },
            addedAt: { timestampValue: nowIso },
            reviewedByStaffId: { stringValue: caller.staffId },
            reviewedByName: { stringValue: caller.staffName },
            reviewComment: { stringValue: 'Added directly by Manager.' },
            lastAuditLogId: { stringValue: logId },
            createdAt: { timestampValue: nowIso },
            updatedAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: false },
      });

      const overCapNote =
        targetCountsTowardCap && peakOccupied > maxCap
          ? ` (peak daily occupancy ${peakOccupied}/${maxCap})`
          : '';
      const overlapNote = overlappingDates.length > 0 ? ' (overlap confirmed)' : '';

      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
          fields: {
            logId: { stringValue: logId },
            action: { stringValue: 'MANAGER_LEAVE_ADDED' },
            targetType: { stringValue: 'leaveRequest' },
            targetId: { stringValue: requestId },
            actorStaffId: { stringValue: caller.staffId },
            actorName: { stringValue: caller.staffName },
            actorRole: { stringValue: 'manager' },
            summary: {
              stringValue: `Manager added approved leave for ${targetName} (${targetStaffId}, ${targetDesignation}) for ${startDate} – ${endDate} (${dates.length}d)${overCapNote}${overlapNote}.`,
            },
            newStatus: { stringValue: 'approved' },
            affectedDates: {
              arrayValue: { values: dates.slice(0, 31).map((d) => ({ stringValue: d })) },
            },
            createdAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: false },
      });

      return { writes, result: { ok: true, requestId, peakOccupied } };
    }
  );

  return jsonResponse(txResult);
}

async function handleRemoveStaff(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Managers can remove staff accounts.');
  }

  let body: { targetStaffId?: unknown };
  try {
    body = (await request.json()) as { targetStaffId?: unknown };
  } catch {
    throw new HttpApiError(400, 'Invalid request payload.');
  }

  const targetStaffId = typeof body.targetStaffId === 'string' ? body.targetStaffId.trim() : '';
  if (!isValidStaffIdFormat(targetStaffId)) {
    throw new HttpApiError(400, 'Invalid target Staff ID.');
  }
  if (targetStaffId === caller.staffId) {
    throw new HttpApiError(400, 'You cannot remove your own currently signed-in account.');
  }

  const removedRequests = await runFirestoreTransaction(
    caller.projectId,
    caller.accessToken,
    async (tx) => {
      const targetDoc = await fsGetDoc(
        caller.projectId,
        caller.accessToken,
        `staff/${targetStaffId}`
      );
      if (!targetDoc?.fields) {
        throw new HttpApiError(404, `Staff account ${targetStaffId} not found.`);
      }
      const targetName = fsStr(targetDoc.fields, 'fullName') || targetStaffId;
      const targetDesignation = fsStr(targetDoc.fields, 'designation') || 'ASSISTANT OFFICER';
      const targetAuthUid =
        fsStr(targetDoc.fields, 'authUid') || deterministicStaffUid(targetStaffId);
      const targetActive = fsBool(targetDoc.fields, 'isActive', true);

      const [settingsMap, reqDocs] = await Promise.all([
        fsBatchGetDocs(
          caller.projectId,
          caller.accessToken,
          ['appSettings/portalConfig'],
          tx
        ),
        fsRunQuery(
          caller.projectId,
          caller.accessToken,
          {
            from: [{ collectionId: 'leaveRequests' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'staffId' },
                op: 'EQUAL',
                value: { stringValue: targetStaffId },
              },
            },
          },
          tx
        ),
      ]);

      const settingsDoc = settingsMap['appSettings/portalConfig'];
      const maxCap = Math.min(
        10,
        Math.max(1, fsInt(settingsDoc?.fields, 'maxDailyCombinedCap', 10))
      );

      const affectedDatesSet = new Set<string>();
      const removedReqIds = new Set<string>();

      for (const d of reqDocs) {
        const parsed = parseLeaveRequestDoc(d);
        removedReqIds.add(parsed.requestId);
        if (parsed.status === 'pending' || parsed.status === 'approved') {
          for (const dt of parsed.dates) {
            if (isValidDateKey(dt)) affectedDatesSet.add(dt);
          }
        }
      }

      const affectedDates = Array.from(affectedDatesSet).sort();
      const capAndDetailMap = await fsBatchGetDocs(
        caller.projectId,
        caller.accessToken,
        [
          ...affectedDates.map((d) => `dailyCapacity/${d}`),
          ...affectedDates.map((d) => `dailyCapacityDetails/${d}`),
        ],
        tx
      );

      const nowIso = new Date().toISOString();
      const writes: FirestoreWrite[] = [];

      for (const dateKey of affectedDates) {
        const capDoc = capAndDetailMap[`dailyCapacity/${dateKey}`];
        const detailDoc = capAndDetailMap[`dailyCapacityDetails/${dateKey}`];
        const capLimit = Math.min(
          10,
          Math.max(1, fsInt(capDoc?.fields, 'maxCapacity', maxCap))
        );
        const nextAllocs = fsAllocations(detailDoc?.fields).filter(
          (a) => a.staffId !== targetStaffId && !removedReqIds.has(a.requestId)
        );
        const summary = summarizeAllocationsForDate(nextAllocs);

        writes.push({
          update: {
            name: firestoreDocResourceName(caller.projectId, `dailyCapacity/${dateKey}`),
            fields: {
              date: { stringValue: dateKey },
              approvedCount: { integerValue: String(summary.occupiedCount) },
              approvedOnlyCount: { integerValue: String(summary.approvedOnlyCount) },
              pendingCount: { integerValue: String(summary.pendingCount) },
              maxCapacity: { integerValue: String(capLimit) },
              updatedAt: { timestampValue: nowIso },
            },
          },
        });
        writes.push({
          update: {
            name: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${dateKey}`),
            fields: {
              date: { stringValue: dateKey },
              allocations: allocationsToFirestoreValue(nextAllocs),
              updatedAt: { timestampValue: nowIso },
            },
          },
        });
      }

      for (const d of reqDocs) {
        const reqId = fsDocId(d.name);
        if (reqId) {
          writes.push({
            delete: firestoreDocResourceName(caller.projectId, `leaveRequests/${reqId}`),
          });
        }
      }

      writes.push({
        delete: firestoreDocResourceName(caller.projectId, `staff/${targetStaffId}`),
      });
      writes.push({
        delete: firestoreDocResourceName(caller.projectId, `staffAuthLinks/${targetAuthUid}`),
      });
      writes.push({
        delete: firestoreDocResourceName(caller.projectId, `staffPinSecrets/${targetStaffId}`),
      });

      const logId = makeServerId('log');
      writes.push({
        update: {
          name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
          fields: {
            logId: { stringValue: logId },
            action: { stringValue: 'STAFF_REMOVED' },
            targetType: { stringValue: 'staff' },
            targetId: { stringValue: targetStaffId },
            actorStaffId: { stringValue: caller.staffId },
            actorName: { stringValue: caller.staffName },
            actorRole: { stringValue: 'manager' },
            summary: {
              stringValue: `Removed staff record ${targetStaffId} (${targetName}, ${targetDesignation}); deleted ${reqDocs.length} leave request(s) and released ${affectedDates.length} date slot(s).`,
            },
            previousStatus: { stringValue: targetActive ? 'active' : 'inactive' },
            newStatus: { stringValue: 'removed' },
            ...(affectedDates.length > 0
              ? {
                  affectedDates: {
                    arrayValue: {
                      values: affectedDates.slice(0, 31).map((d) => ({ stringValue: d })),
                    },
                  },
                }
              : {}),
            createdAt: { timestampValue: nowIso },
          },
        },
        currentDocument: { exists: false },
      });

      return { writes, result: reqDocs.length };
    }
  );

  return jsonResponse({ ok: true, removedRequests });
}

async function handleListRestrictions(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  const docs = await fsListCollection(caller.projectId, caller.accessToken, 'leaveRestrictions');
  const items = docs
    .map(parseLeaveRestrictionDoc)
    .filter((r) => caller.role === 'manager' || r.isActive)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  return jsonResponse({ ok: true, restrictions: items });
}

async function handleSaveRestriction(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Managers can configure leave date restrictions.');
  }

  let body: {
    restrictionId?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    targetType?: unknown;
    targetStaffIds?: unknown;
    reason?: unknown;
    isActive?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new HttpApiError(400, 'Invalid restriction payload.');
  }

  const rawId = typeof body.restrictionId === 'string' ? body.restrictionId.trim() : '';
  const startDate = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const endDate = typeof body.endDate === 'string' ? body.endDate.trim() : '';
  const targetType = typeof body.targetType === 'string' ? body.targetType.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const isActive = body.isActive !== false;

  if (!isValidDateKey(startDate) || !isValidDateKey(endDate)) {
    throw new HttpApiError(400, 'Please provide valid Start Date and End Date.');
  }
  if (endDate < startDate) {
    throw new HttpApiError(400, 'End Date must be on or after Start Date.');
  }
  if (!ALLOWED_RESTRICTION_TARGET_TYPES.has(targetType)) {
    throw new HttpApiError(400, 'Invalid restriction target selection.');
  }
  if (reason.length < 3 || reason.length > 300) {
    throw new HttpApiError(400, 'Reason for blocking must be between 3 and 300 characters.');
  }

  let targetStaffIds: string[] = [];
  let targetStaffNames: string[] = [];
  if (targetType === 'selected_staff') {
    const rawList = Array.isArray(body.targetStaffIds)
      ? body.targetStaffIds
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .map((v) => v.trim())
      : [];
    if (rawList.length === 0) {
      throw new HttpApiError(
        400,
        'Please select at least one staff member for Selected Staff Members restriction.'
      );
    }
    const staffDocs = await fsListCollection(caller.projectId, caller.accessToken, 'staff');
    const nameMap = new Map<string, string>();
    const canonicalByToken = new Map<string, string>();
    const canonicalByUid = new Map<string, string>();
    const canonicalByName = new Map<string, string>();
    for (const d of staffDocs) {
      const sid = fsStr(d.fields, 'staffId') || fsDocId(d.name);
      if (sid) {
        const tok = normalizeStaffIdToken(sid);
        if (tok) {
          canonicalByToken.set(tok, sid);
          canonicalByUid.set(`ss_${tok}`, sid);
        }
        const authUid = fsStr(d.fields, 'authUid').trim().toLowerCase();
        if (authUid) canonicalByUid.set(authUid, sid);
        const fullName = fsStr(d.fields, 'fullName').trim();
        if (fullName) canonicalByName.set(fullName.toLowerCase(), sid);
        nameMap.set(sid, fullName || sid);
      }
    }
    const seenTokens = new Set<string>();
    const resolvedIds: string[] = [];
    for (const rawEntry of rawList) {
      const lower = rawEntry.toLowerCase();
      const tok = normalizeStaffIdToken(rawEntry);
      const canonical =
        canonicalByToken.get(tok) ||
        canonicalByUid.get(lower) ||
        canonicalByName.get(lower) ||
        (isValidStaffIdFormat(rawEntry) ? rawEntry : '');
      if (!canonical) continue;
      const canonicalTok = normalizeStaffIdToken(canonical);
      if (!canonicalTok || seenTokens.has(canonicalTok)) continue;
      seenTokens.add(canonicalTok);
      resolvedIds.push(canonical);
    }
    if (resolvedIds.length === 0) {
      throw new HttpApiError(
        400,
        'Selected staff members could not be matched to valid Staff IDs.'
      );
    }
    targetStaffIds = resolvedIds;
    targetStaffNames = targetStaffIds.map((id) => nameMap.get(id) || id);
  }

  if (rawId && !/^[a-zA-Z0-9_-]{1,128}$/.test(rawId)) {
    throw new HttpApiError(400, 'Invalid restriction ID.');
  }

  const restrictionId = rawId || makeServerId('rst');
  const existingDoc = rawId
    ? await fsGetDoc(caller.projectId, caller.accessToken, `leaveRestrictions/${restrictionId}`)
    : null;

  const nowIso = new Date().toISOString();
  const createdAt = existingDoc?.fields
    ? fsTimestamp(existingDoc.fields, 'createdAt') || nowIso
    : nowIso;
  const createdByStaffId = existingDoc?.fields
    ? fsStr(existingDoc.fields, 'createdByStaffId') || caller.staffId
    : caller.staffId;
  const createdByName = existingDoc?.fields
    ? fsStr(existingDoc.fields, 'createdByName') || caller.staffName
    : caller.staffName;

  await fsPatchDoc(
    caller.projectId,
    caller.accessToken,
    `leaveRestrictions/${restrictionId}`,
    {
      restrictionId: { stringValue: restrictionId },
      startDate: { stringValue: startDate },
      endDate: { stringValue: endDate },
      targetType: { stringValue: targetType },
      targetStaffIds: {
        arrayValue: { values: targetStaffIds.map((id) => ({ stringValue: id })) },
      },
      targetStaffNames: {
        arrayValue: { values: targetStaffNames.map((n) => ({ stringValue: n })) },
      },
      reason: { stringValue: reason },
      isActive: { booleanValue: isActive },
      createdByStaffId: { stringValue: createdByStaffId },
      createdByName: { stringValue: createdByName },
      createdAt: { timestampValue: createdAt },
      updatedAt: { timestampValue: nowIso },
    },
    [
      'restrictionId',
      'startDate',
      'endDate',
      'targetType',
      'targetStaffIds',
      'targetStaffNames',
      'reason',
      'isActive',
      'createdByStaffId',
      'createdByName',
      'createdAt',
      'updatedAt',
    ]
  );

  const logId = makeServerId('log');
  await fsCreateDoc(caller.projectId, caller.accessToken, 'auditLogs', logId, {
    logId: { stringValue: logId },
    action: { stringValue: 'RESTRICTION_SAVED' },
    targetType: { stringValue: 'leaveRestriction' },
    targetId: { stringValue: restrictionId },
    actorStaffId: { stringValue: caller.staffId },
    actorName: { stringValue: caller.staffName },
    actorRole: { stringValue: 'manager' },
    summary: {
      stringValue: `${existingDoc ? 'Updated' : 'Created'} leave date restriction (${startDate} – ${endDate}, target=${targetType}, active=${isActive}): ${reason}`,
    },
    newStatus: { stringValue: isActive ? 'active' : 'inactive' },
    createdAt: { timestampValue: nowIso },
  });

  return jsonResponse({
    ok: true,
    restriction: {
      restrictionId,
      startDate,
      endDate,
      targetType,
      targetStaffIds,
      targetStaffNames,
      reason,
      isActive,
      createdByStaffId,
      createdByName,
      createdAt,
      updatedAt: nowIso,
    },
  });
}

async function handleDeleteRestriction(request: Request, env: WorkerEnv): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Managers can remove leave date restrictions.');
  }

  let body: { restrictionId?: unknown };
  try {
    body = (await request.json()) as { restrictionId?: unknown };
  } catch {
    throw new HttpApiError(400, 'Invalid payload.');
  }

  const restrictionId =
    typeof body.restrictionId === 'string' ? body.restrictionId.trim() : '';
  if (!restrictionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(restrictionId)) {
    throw new HttpApiError(400, 'Valid restrictionId is required.');
  }

  const existingDoc = await fsGetDoc(
    caller.projectId,
    caller.accessToken,
    `leaveRestrictions/${restrictionId}`
  );
  const existing = existingDoc ? parseLeaveRestrictionDoc(existingDoc) : null;
  const nowIso = new Date().toISOString();
  const logId = makeServerId('log');

  await fsCommitWrites(caller.projectId, caller.accessToken, [
    {
      delete: firestoreDocResourceName(
        caller.projectId,
        `leaveRestrictions/${restrictionId}`
      ),
    },
    {
      update: {
        name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
        fields: {
          logId: { stringValue: logId },
          action: { stringValue: 'RESTRICTION_REMOVED' },
          targetType: { stringValue: 'leaveRestriction' },
          targetId: { stringValue: restrictionId },
          actorStaffId: { stringValue: caller.staffId },
          actorName: { stringValue: caller.staffName },
          actorRole: { stringValue: 'manager' },
          summary: {
            stringValue: existing
              ? `Removed leave date restriction (${existing.startDate} – ${existing.endDate}, target=${existing.targetType}).`
              : `Removed leave date restriction (${restrictionId}).`,
          },
          createdAt: { timestampValue: nowIso },
        },
      },
      currentDocument: { exists: false },
    },
  ]);

  return jsonResponse({ ok: true, restrictionId });
}

async function handleClearAllLeaveRecords(
  request: Request,
  env: WorkerEnv
): Promise<Response> {
  const caller = await authenticateActiveCaller(request, env);
  if (caller.role !== 'manager') {
    throw new HttpApiError(403, 'Only Managers can clear leave records.');
  }

  let body: { confirmation?: unknown };
  try {
    body = (await request.json()) as { confirmation?: unknown };
  } catch {
    throw new HttpApiError(400, 'Invalid confirmation payload.');
  }

  if (typeof body.confirmation !== 'string' || body.confirmation.trim() !== 'DELETE ALL') {
    throw new HttpApiError(
      400,
      'Confirmation text must match "DELETE ALL" exactly.'
    );
  }

  // List only leave applications and daily capacity documents; NEVER touch staff, PINs, auth links, settings, restrictions, or audit logs
  const [leaveDocs, capDocs, detailDocs] = await Promise.all([
    fsListCollection(caller.projectId, caller.accessToken, 'leaveRequests'),
    fsListCollection(caller.projectId, caller.accessToken, 'dailyCapacity'),
    fsListCollection(caller.projectId, caller.accessToken, 'dailyCapacityDetails'),
  ]);

  const deleteWrites: FirestoreWrite[] = [];

  for (const d of capDocs) {
    const id = fsDocId(d.name);
    if (id) {
      deleteWrites.push({
        delete: firestoreDocResourceName(caller.projectId, `dailyCapacity/${id}`),
      });
    }
  }
  for (const d of detailDocs) {
    const id = fsDocId(d.name);
    if (id) {
      deleteWrites.push({
        delete: firestoreDocResourceName(caller.projectId, `dailyCapacityDetails/${id}`),
      });
    }
  }
  for (const d of leaveDocs) {
    const id = fsDocId(d.name);
    if (id) {
      deleteWrites.push({
        delete: firestoreDocResourceName(caller.projectId, `leaveRequests/${id}`),
      });
    }
  }

  const nowIso = new Date().toISOString();
  const logId = makeServerId('log');
  const auditWrite: FirestoreWrite = {
    update: {
      name: firestoreDocResourceName(caller.projectId, `auditLogs/${logId}`),
      fields: {
        logId: { stringValue: logId },
        action: { stringValue: 'LEAVE_DATA_CLEARED' },
        targetType: { stringValue: 'leaveRequest' },
        targetId: { stringValue: 'ALL_LEAVE_RECORDS' },
        actorStaffId: { stringValue: caller.staffId },
        actorName: { stringValue: caller.staffName },
        actorRole: { stringValue: 'manager' },
        summary: {
          stringValue: `Manager ${caller.staffId} (${caller.staffName}) cleared all leave records (${leaveDocs.length} application(s), ${capDocs.length} daily capacity counter(s), ${detailDocs.length} detail record(s)). Staff accounts, settings, and date restrictions preserved.`,
        },
        createdAt: { timestampValue: nowIso },
      },
    },
    currentDocument: { exists: false },
  };

  if (deleteWrites.length + 1 <= 450) {
    // Single atomic Firestore commit
    await fsCommitWrites(caller.projectId, caller.accessToken, [
      ...deleteWrites,
      auditWrite,
    ]);
  } else {
    // Chunk large datasets in batches of 450 writes, then append audit log after all deletes succeed
    for (let i = 0; i < deleteWrites.length; i += 450) {
      await fsCommitWrites(
        caller.projectId,
        caller.accessToken,
        deleteWrites.slice(i, i + 450)
      );
    }
    await fsCommitWrites(caller.projectId, caller.accessToken, [auditWrite]);
  }

  return jsonResponse({
    ok: true,
    deletedRequests: leaveDocs.length,
    deletedCapacityDocs: capDocs.length,
    deletedDetailDocs: detailDocs.length,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        if (request.method === 'GET' && url.pathname === '/api/health') {
          return jsonResponse({
            ok: true,
            projectId: env.FIREBASE_PROJECT_ID || 'ss-leave-management',
            configured: Boolean(env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim()),
            availableBindings: Object.keys(env),
          });
        }
        if (request.method === 'POST' && url.pathname === '/api/auth/login') {
          return await handleLogin(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/auth/change-pin') {
          return await handleChangePin(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/reset-pin') {
          return await handleAdminResetPin(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/add-staff') {
          return await handleAddStaff(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/remove-staff') {
          return await handleRemoveStaff(request, env);
        }
        if (request.method === 'GET' && url.pathname === '/api/leave/restrictions') {
          return await handleListRestrictions(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/restrictions/save') {
          return await handleSaveRestriction(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/restrictions/delete') {
          return await handleDeleteRestriction(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/clear-all-leave') {
          return await handleClearAllLeaveRecords(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/sync-pending-capacity') {
          return await handleSyncPendingCapacity(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/submit') {
          return await handleSubmitLeave(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/cancel-pending') {
          return await handleCancelPendingLeave(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/edit-pending') {
          return await handleEditPendingLeave(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/approve') {
          return await handleApproveLeave(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/reject') {
          return await handleRejectLeave(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/process-modification') {
          return await handleProcessModification(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/remove-approved') {
          return await handleRemoveApprovedLeave(request, env);
        }
        if (request.method === 'POST' && url.pathname === '/api/leave/manager-add') {
          return await handleManagerAddLeave(request, env);
        }
        return jsonResponse({ error: 'Not found.' }, 404);
      } catch (err) {
        if (err instanceof HttpApiError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        console.error('[worker] Unhandled API error:', err);
        const message =
          err instanceof Error && err.message.includes('FIREBASE_SERVICE_ACCOUNT_KEY')
            ? err.message
            : 'Authentication service error. Please verify server configuration and try again.';
        return jsonResponse({ error: message }, 500);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404 });
  },
};
