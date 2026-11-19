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
        return jsonResponse({ error: 'Not found.' }, 404);
      } catch (err) {
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
