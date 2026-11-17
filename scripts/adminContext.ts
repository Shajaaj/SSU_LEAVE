import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { type App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import {
  type InitialStaffSeedRow,
  type ServerDesignation,
  deriveDefaultRole,
} from './initialStaffRoster.ts';
import { staffIdToAuthEmail } from '../src/utils/staffAuthId.ts';

dotenv.config();

interface AppletFirebaseConfig {
  projectId: string;
  firestoreDatabaseId: string;
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

  return {
    app,
    auth: getAuth(app),
    db: getFirestore(app, config.firestoreDatabaseId),
    projectId: config.projectId,
    databaseId: config.firestoreDatabaseId,
  };
}

/**
 * Generates a unique, unpredictable 12-character temporary password.
 * Avoids ambiguous glyphs (0/O, 1/l/I) for clean out-of-band distribution.
 */
export function generateTemporaryPassword(length = 12): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  const chars: string[] = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];

  while (chars.length < length) {
    chars.push(all[crypto.randomInt(all.length)]);
  }

  // Fisher-Yates shuffle with crypto.randomInt
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function normalizeDesignation(raw: string): ServerDesignation {
  const upper = raw.trim().toUpperCase();
  if (upper === 'EXECUTIVE') return 'EXECUTIVE';
  if (upper === 'OFFICER') return 'OFFICER';
  if (upper.startsWith('ASSISTANT OFF')) return 'ASSISTANT OFFICER';
  if (upper === 'ATTENDANT') return 'ATTENDANT';
  if (upper === 'MANAGER') return 'MANAGER';
  return 'ASSISTANT OFFICER';
}

export function parseStaffImportText(rawText: string): InitialStaffSeedRow[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: InitialStaffSeedRow[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (/^\|?[\s:-]+\|/.test(line) && !/[A-Za-z0-9]/.test(line)) {
      continue;
    }

    let cols: string[];
    if (line.includes('|')) {
      cols = line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
    } else if (line.includes('\t')) {
      cols = line.split('\t').map((c) => c.trim());
    } else {
      cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    }

    if (cols.length < 3) continue;
    const [staffIdRaw, fullNameRaw, designationRaw] = cols;
    const staffId = staffIdRaw.trim();
    const fullName = fullNameRaw.trim();
    if (
      !staffId ||
      staffId.toLowerCase() === 'staff id' ||
      staffId.toLowerCase() === 'staffid' ||
      !/^[A-Za-z0-9-]+$/.test(staffId)
    ) {
      continue;
    }
    if (seen.has(staffId)) continue;
    seen.add(staffId);

    const designation = normalizeDesignation(designationRaw);
    rows.push({
      staffId,
      fullName,
      designation,
      role: deriveDefaultRole(staffId, designation),
    });
  }

  return rows;
}

/**
 * Checks deterministic internal auth emails for collisions across a list of Staff IDs.
 * Throws if two distinct Staff IDs normalize to the same internal auth email.
 */
export function assertNoAuthEmailCollisions(staffIds: string[]): Map<string, string> {
  const emailToStaffId = new Map<string, string>();
  const staffIdToEmail = new Map<string, string>();

  for (const staffId of staffIds) {
    const email = staffIdToAuthEmail(staffId);
    const existing = emailToStaffId.get(email);
    if (existing && existing !== staffId) {
      throw new Error(
        `Staff ID collision detected: "${existing}" and "${staffId}" both normalize to "${email}". Resolve collision before provisioning.`
      );
    }
    emailToStaffId.set(email, staffId);
    staffIdToEmail.set(staffId, email);
  }

  return staffIdToEmail;
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
