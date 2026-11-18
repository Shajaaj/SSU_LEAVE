import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import dotenv from 'dotenv';
import { type App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import {
  type InitialStaffSeedRow,
  type ServerDesignation,
  resolveAuthorizedRole,
} from './initialStaffRoster.ts';
import {
  isValidPinFormat,
  staffIdToDeterministicUid,
} from '../src/utils/staffAuthId.ts';

dotenv.config();

interface AppletFirebaseConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

export function loadAppletConfig(): AppletFirebaseConfig {
  const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  return JSON.parse(raw) as AppletFirebaseConfig;
}

function parseServiceAccountFromEnv(): Record<string, string> | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('{')) {
      return JSON.parse(raw) as Record<string, string>;
    }
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.trim().startsWith('{')) {
      return JSON.parse(decoded) as Record<string, string>;
    }
  } catch (err) {
    throw new Error(
      `Invalid FIREBASE_SERVICE_ACCOUNT_KEY: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return null;
}

export function getAdminContext(): {
  app: App;
  auth: Auth;
  db: Firestore;
  projectId: string;
  databaseId: string;
} {
  const config = loadAppletConfig();
  const existing = getApps().find((a) => a.name === 'ssu-cli-admin');
  let app: App;
  if (existing) {
    app = existing;
  } else {
    const serviceAccount = parseServiceAccountFromEnv();
    app = serviceAccount
      ? initializeApp(
          {
            credential: cert(serviceAccount),
            projectId: config.projectId,
          },
          'ssu-cli-admin'
        )
      : initializeApp({ projectId: config.projectId }, 'ssu-cli-admin');
  }

  const rawDbId = config.firestoreDatabaseId?.trim();
  const useNamedDb = Boolean(rawDbId && rawDbId !== '(default)');

  return {
    app,
    auth: getAuth(app),
    db: useNamedDb ? getFirestore(app, rawDbId!) : getFirestore(app),
    projectId: config.projectId,
    databaseId: useNamedDb ? rawDbId! : '(default)',
  };
}

export function getCliFlagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      return args[i + 1];
    }
    if (args[i].startsWith(`${flag}=`)) {
      return args[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * Resolves the initial PIN from CLI flag (--pin), INITIAL_STAFF_PIN env var,
 * or interactive terminal prompt. Never hardcodes any PIN in source code.
 */
export async function resolveInitialPinFromCliOrEnv(
  args: string[],
  promptLabel = 'Enter initial onboarding PIN for provisioned staff account(s): '
): Promise<string> {
  const fromFlag = getCliFlagValue(args, '--pin') ?? getCliFlagValue(args, '--password');
  const fromEnv = process.env.INITIAL_STAFF_PIN;
  let candidate = (fromFlag ?? fromEnv ?? '').trim();

  if (!candidate && input.isTTY) {
    const rl = createInterface({ input, output });
    try {
      candidate = (await rl.question(promptLabel)).trim();
    } finally {
      rl.close();
    }
  }

  if (!candidate) {
    throw new Error(
      'Initial PIN is required. Pass --pin <PIN> or set INITIAL_STAFF_PIN in your shell environment.'
    );
  }
  if (!isValidPinFormat(candidate)) {
    throw new Error('Initial PIN must be 4 to 12 numeric digits.');
  }
  return candidate;
}

export function hashPinPbkdf2Node(pin: string): {
  pinSalt: string;
  pinHash: string;
  hashAlgo: 'pbkdf2-sha256-100000';
} {
  const pinSalt = crypto.randomBytes(16).toString('hex');
  const pinHash = crypto
    .pbkdf2Sync(pin, Buffer.from(pinSalt, 'hex'), 100_000, 32, 'sha256')
    .toString('hex');
  return {
    pinSalt,
    pinHash,
    hashAlgo: 'pbkdf2-sha256-100000',
  };
}

/**
 * Generates an unpredictable numeric PIN when --random mode is requested.
 */
export function generateRandomPin(digits = 6): string {
  let result = '';
  for (let i = 0; i < digits; i += 1) {
    result += String(crypto.randomInt(0, 10));
  }
  return result;
}

export function normalizeDesignation(raw: string): ServerDesignation {
  const upper = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (upper === 'EXECUTIVE') return 'EXECUTIVE';
  if (upper === 'OFFICER') return 'OFFICER';
  if (upper === 'ASSISTANT OFFICER' || upper.startsWith('ASSISTANT OFF')) {
    return 'ASSISTANT OFFICER';
  }
  if (upper === 'SS ATTENDANT' || upper === 'ATTENDANT') return 'ATTENDANT';
  if (upper === 'MANAGER') return 'MANAGER';
  throw new Error(
    `Unsupported designation "${raw}". Expected EXECUTIVE, OFFICER, ASSISTANT OFFICER, or SS ATTENDANT.`
  );
}

export interface ParsedRosterRow extends InitialStaffSeedRow {
  role: 'staff' | 'executive' | 'manager';
  unitSection: string;
  annualPeriodLimit: number;
  isActive: boolean;
  lineNumber: number;
}

export interface ValidatedRosterResult {
  rows: ParsedRosterRow[];
  countsByDesignation: Record<ServerDesignation, number>;
  countsByRole: Record<'staff' | 'executive' | 'manager', number>;
}

function splitDelimitedLine(line: string, delimiter: ',' | '\t'): string[] {
  if (delimiter === '\t') {
    return line.split('\t').map((c) => c.trim());
  }
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function canonicalHeaderName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function parseAndValidateRosterText(rawText: string): ValidatedRosterResult {
  const cleanedText = rawText.replace(/^\uFEFF/, '');
  const rawLines = cleanedText.split(/\r?\n/);

  const nonEmptyEntries: Array<{ lineNumber: number; text: string }> = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) continue;
    if (/^\|?[\s:-]+\|/.test(trimmed) && !/[A-Za-z0-9]/.test(trimmed)) {
      continue;
    }
    nonEmptyEntries.push({ lineNumber: i + 1, text: trimmed });
  }

  if (nonEmptyEntries.length === 0) {
    throw new Error('Roster file is empty.');
  }

  const parseCols = (line: string): string[] => {
    if (line.includes('|')) {
      return line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
    }
    if (line.includes('\t')) {
      return splitDelimitedLine(line, '\t');
    }
    return splitDelimitedLine(line, ',');
  };

  let staffIdIdx = 0;
  let fullNameIdx = 1;
  let designationIdx = 2;
  let roleIdx = -1;
  let unitSectionIdx = -1;
  let isActiveIdx = -1;
  let startIndex = 0;

  const firstCols = parseCols(nonEmptyEntries[0].text);
  const firstCanonical = firstCols.map(canonicalHeaderName);
  const looksLikeHeader = firstCanonical.some((h) =>
    [
      'staffid',
      'employeeid',
      'empid',
      'fullname',
      'staffname',
      'designation',
      'title',
      'position',
    ].includes(h)
  );

  if (looksLikeHeader) {
    startIndex = 1;
    staffIdIdx = firstCanonical.findIndex((h) =>
      ['staffid', 'employeeid', 'empid', 'id'].includes(h)
    );
    fullNameIdx = firstCanonical.findIndex((h) =>
      ['fullname', 'name', 'staffname', 'employeename'].includes(h)
    );
    designationIdx = firstCanonical.findIndex((h) =>
      ['designation', 'title', 'position', 'grade', 'rank'].includes(h)
    );
    roleIdx = firstCanonical.findIndex((h) =>
      ['role', 'accessrole', 'portalrole'].includes(h)
    );
    unitSectionIdx = firstCanonical.findIndex((h) =>
      ['unitsection', 'section', 'unit', 'department'].includes(h)
    );
    isActiveIdx = firstCanonical.findIndex((h) =>
      ['isactive', 'active', 'status'].includes(h)
    );

    if (staffIdIdx === -1 || fullNameIdx === -1 || designationIdx === -1) {
      throw new Error(
        'CSV header must include Staff ID, Full Name, and Designation columns.'
      );
    }
  }

  const rows: ParsedRosterRow[] = [];
  const errors: string[] = [];
  const seenExact = new Map<string, number>();
  const seenUid = new Map<string, { staffId: string; lineNumber: number }>();

  const countsByDesignation: Record<ServerDesignation, number> = {
    EXECUTIVE: 0,
    OFFICER: 0,
    'ASSISTANT OFFICER': 0,
    ATTENDANT: 0,
    MANAGER: 0,
  };
  const countsByRole: Record<'staff' | 'executive' | 'manager', number> = {
    staff: 0,
    executive: 0,
    manager: 0,
  };

  for (let i = startIndex; i < nonEmptyEntries.length; i += 1) {
    const { lineNumber, text } = nonEmptyEntries[i];
    const cols = parseCols(text);

    const staffId = (cols[staffIdIdx] ?? '').trim();
    const fullName = (cols[fullNameIdx] ?? '').trim();
    const designationRaw = (cols[designationIdx] ?? '').trim();
    const roleRaw = roleIdx >= 0 ? (cols[roleIdx] ?? '').trim() : '';
    const unitSectionRaw =
      unitSectionIdx >= 0 ? (cols[unitSectionIdx] ?? '').trim() : '';
    const isActiveRaw =
      isActiveIdx >= 0 ? (cols[isActiveIdx] ?? '').trim().toLowerCase() : '';

    if (!/^[A-Za-z0-9-]{2,24}$/.test(staffId)) {
      errors.push(
        `Line ${lineNumber}: Invalid Staff ID "${staffId}". Expected 2–24 alphanumeric/hyphen characters.`
      );
      continue;
    }

    if (fullName.length < 2 || fullName.length > 100) {
      errors.push(
        `Line ${lineNumber} (${staffId}): Full Name must be 2 to 100 characters.`
      );
      continue;
    }

    let designation: ServerDesignation;
    try {
      designation = normalizeDesignation(designationRaw);
    } catch (err) {
      errors.push(
        `Line ${lineNumber} (${staffId}): ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    let uid: string;
    try {
      uid = staffIdToDeterministicUid(staffId);
    } catch (err) {
      errors.push(
        `Line ${lineNumber} (${staffId}): ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    const prevExactLine = seenExact.get(staffId);
    if (prevExactLine !== undefined) {
      errors.push(
        `Line ${lineNumber}: Duplicate Staff ID "${staffId}" (first seen on line ${prevExactLine}).`
      );
      continue;
    }
    seenExact.set(staffId, lineNumber);

    const prevUidEntry = seenUid.get(uid);
    if (prevUidEntry) {
      errors.push(
        `Line ${lineNumber}: Conflicting Staff ID "${staffId}" normalizes to the same UID "${uid}" as "${prevUidEntry.staffId}" on line ${prevUidEntry.lineNumber}.`
      );
      continue;
    }
    seenUid.set(uid, { staffId, lineNumber });

    let role: 'staff' | 'executive' | 'manager';
    try {
      role = resolveAuthorizedRole(staffId, designation, roleRaw || undefined);
    } catch (err) {
      errors.push(
        `Line ${lineNumber} (${staffId}): ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    let isActive = true;
    if (isActiveRaw) {
      if (['false', '0', 'no', 'inactive', 'disabled'].includes(isActiveRaw)) {
        isActive = false;
      } else if (!['true', '1', 'yes', 'active', 'enabled'].includes(isActiveRaw)) {
        errors.push(
          `Line ${lineNumber} (${staffId}): Invalid active status "${isActiveRaw}".`
        );
        continue;
      }
    }

    const unitSection =
      unitSectionRaw.length >= 2 && unitSectionRaw.length <= 60
        ? unitSectionRaw
        : 'Special Services';

    countsByDesignation[designation] += 1;
    countsByRole[role] += 1;

    rows.push({
      staffId,
      fullName,
      designation,
      role,
      unitSection,
      annualPeriodLimit: 3,
      isActive,
      lineNumber,
    });
  }

  if (errors.length > 0) {
    throw new Error(
      `CSV validation failed with ${errors.length} error(s):\n- ${errors.join('\n- ')}`
    );
  }

  if (rows.length === 0) {
    throw new Error('No staff data rows found after CSV header.');
  }

  return { rows, countsByDesignation, countsByRole };
}

export function parseStaffImportText(rawText: string): InitialStaffSeedRow[] {
  return parseAndValidateRosterText(rawText).rows;
}

/**
 * Checks deterministic custom-token UIDs for collisions across a list of Staff IDs.
 * Throws if two distinct Staff IDs normalize to the same deterministic UID.
 */
export function assertNoStaffUidCollisions(staffIds: string[]): Map<string, string> {
  const uidToStaffId = new Map<string, string>();
  const staffIdToUid = new Map<string, string>();

  for (const staffId of staffIds) {
    const uid = staffIdToDeterministicUid(staffId);
    const existing = uidToStaffId.get(uid);
    if (existing && existing !== staffId) {
      throw new Error(
        `Staff ID collision detected: "${existing}" and "${staffId}" both normalize to "${uid}". Resolve collision before provisioning.`
      );
    }
    uidToStaffId.set(uid, staffId);
    staffIdToUid.set(staffId, uid);
  }

  return staffIdToUid;
}

export function writeRestrictedFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore on filesystems that do not support POSIX chmod
  }
}

export function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
