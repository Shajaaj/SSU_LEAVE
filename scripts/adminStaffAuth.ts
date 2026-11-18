import fs from 'node:fs';
import path from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import {
  type ServerDesignation,
  type ServerRole,
  deriveDefaultRole,
  doesDesignationCountTowardDailyCap,
} from './initialStaffRoster.ts';
import {
  isValidStaffIdFormat,
  staffIdToDeterministicUid,
} from '../src/utils/staffAuthId.ts';
import {
  assertNoStaffUidCollisions,
  escapeCsvCell,
  generateRandomPin,
  getAdminContext,
  hashPinPbkdf2Node,
  normalizeDesignation,
  parseAndValidateRosterText,
  resolveInitialPinFromCliOrEnv,
  writeRestrictedFile,
} from './adminContext.ts';

function printUsage() {
  console.log(`
Special Services Admin CLI (Cloudflare Workers + Firebase Custom Token + PBKDF2)

Usage:
  npx tsx scripts/adminStaffAuth.ts provision <staffId> "<fullName>" "<designation>" [role] [unitSection] [--pin <PIN>]
  npx tsx scripts/adminStaffAuth.ts import <pathToCsvOrMarkdownFile> [--validate-only] [--pin <PIN>] [--random]
  npx tsx scripts/adminStaffAuth.ts reset-pin <staffId> [--pin <PIN>] [--random]
  npx tsx scripts/adminStaffAuth.ts delete-auth <staffId>
  npx tsx scripts/adminStaffAuth.ts sync-disabled

Note: You may also set INITIAL_STAFF_PIN in your local shell environment instead of --pin.
`);
}

function stripFlags(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--pin' || arg === '--password') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    positional.push(arg);
  }
  return positional;
}

async function cmdProvision(args: string[]) {
  const positional = stripFlags(args);
  const [staffIdRaw, fullNameRaw, designationRaw, roleRaw, unitSectionRaw] = positional;
  if (!staffIdRaw || !fullNameRaw || !designationRaw) {
    printUsage();
    process.exit(1);
  }
  const staffId = staffIdRaw.trim();
  if (!isValidStaffIdFormat(staffId)) {
    throw new Error(`Invalid Staff ID "${staffId}". Use 2–24 alphanumeric/hyphen characters.`);
  }

  const useRandom = args.includes('--random');
  const initialPin = useRandom
    ? generateRandomPin(6)
    : await resolveInitialPinFromCliOrEnv(args, `Enter initial PIN for ${staffId}: `);

  const designation: ServerDesignation = normalizeDesignation(designationRaw);
  const role: ServerRole =
    roleRaw === 'staff' || roleRaw === 'executive' || roleRaw === 'manager'
      ? roleRaw
      : deriveDefaultRole(staffId, designation);
  const unitSection = (unitSectionRaw || 'Special Services').trim();

  const { db } = getAdminContext();

  const existingStaffSnap = await db.collection('staff').get();
  const existingIds = existingStaffSnap.docs.map((d) => d.id);
  if (existingStaffSnap.docs.some((d) => d.id.toLowerCase() === staffId.toLowerCase())) {
    throw new Error(`Staff record "${staffId}" already exists.`);
  }
  const uidMap = assertNoStaffUidCollisions([...existingIds, staffId]);
  const uid = uidMap.get(staffId)!;
  const { pinSalt, pinHash, hashAlgo } = hashPinPbkdf2Node(initialPin);

  const logId = `log_${Date.now().toString(36)}_prov`;
  const batch = db.batch();
  batch.set(db.collection('staff').doc(staffId), {
    staffId,
    authUid: uid,
    fullName: fullNameRaw.trim(),
    designation,
    role,
    isActive: true,
    mustChangePassword: true,
    unitSection,
    annualPeriodLimit: 3,
    countsTowardDailyCap: doesDesignationCountTowardDailyCap(designation),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection('staffAuthLinks').doc(uid), {
    uid,
    staffId,
    role,
    designation,
    isActive: true,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection('staffPinSecrets').doc(staffId), {
    staffId,
    authUid: uid,
    pinSalt,
    pinHash,
    hashAlgo,
    mustChangePin: true,
    failedAttempts: 0,
    lockedUntilMs: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection('auditLogs').doc(logId), {
    logId,
    action: 'STAFF_PROVISIONED',
    targetType: 'staff',
    targetId: staffId,
    actorStaffId: 'CLI_ADMIN',
    actorName: 'Administrator CLI',
    actorRole: 'manager',
    summary: `Provisioned ${staffId} (${fullNameRaw.trim()}, ${designation}, role=${role}).`,
    newStatus: 'active',
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  console.log(`Provisioned ${staffId} (${fullNameRaw.trim()}) | UID: ${uid}`);
  console.log('mustChangePassword=true (employee must set a personal PIN upon first login).');
  if (useRandom) {
    console.log(`One-time initial PIN (deliver securely): ${initialPin}`);
  }
}

async function cmdImport(args: string[]) {
  const positional = stripFlags(args);
  const filePathArg = positional[0];
  if (!filePathArg) {
    printUsage();
    process.exit(1);
  }
  const validateOnly =
    args.includes('--validate-only') || args.includes('--dry-run');
  const fullPath = path.resolve(process.cwd(), filePathArg);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Roster file not found: ${filePathArg}`);
  }
  const raw = fs.readFileSync(fullPath, 'utf8');

  // Step 1: Parse and strictly validate ALL CSV rows & UID collisions before touching Firebase
  const { rows, countsByDesignation, countsByRole } = parseAndValidateRosterText(raw);

  console.log(`Validated ${rows.length} staff row(s) from ${filePathArg}.`);
  console.log(
    `Designations: EXECUTIVE=${countsByDesignation.EXECUTIVE}, OFFICER=${countsByDesignation.OFFICER}, ASSISTANT OFFICER=${countsByDesignation['ASSISTANT OFFICER']}, ATTENDANT=${countsByDesignation.ATTENDANT}`
  );
  console.log(
    `Roles: manager=${countsByRole.manager}, executive=${countsByRole.executive}, staff=${countsByRole.staff}`
  );
  console.log('Collision check passed: 0 duplicate or conflicting Staff IDs in CSV.');

  if (validateOnly) {
    console.log('Read-only validation mode complete. No Firebase credentials used and no Firestore documents modified.');
    return;
  }

  const useRandom = args.includes('--random');
  const uniformPin = useRandom ? '' : await resolveInitialPinFromCliOrEnv(args);

  const { db, projectId, databaseId } = getAdminContext();
  console.log(`Connected to Firebase project="${projectId}", database="${databaseId}"`);

  // Step 2: Check UID collisions across existing Firestore staff + CSV before writing anything
  const existingStaffSnap = await db.collection('staff').get();
  const existingIds = existingStaffSnap.docs.map((d) => d.id);
  const existingStaffById = new Map<string, Record<string, unknown>>();
  for (const docSnap of existingStaffSnap.docs) {
    existingStaffById.set(docSnap.id, docSnap.data() as Record<string, unknown>);
  }

  const uidMap = assertNoStaffUidCollisions([
    ...existingIds,
    ...rows.map((r) => r.staffId),
  ]);
  console.log('Firestore collision check passed: 0 Staff ID normalization conflicts.');

  // Step 3: Preserve existing portal settings; only initialize defaults if missing
  const settingsRef = db.collection('appSettings').doc('portalConfig');
  const settingsSnap = await settingsRef.get();
  if (!settingsSnap.exists) {
    await settingsRef.set({
      maxDailyCombinedCap: 10,
      maxAnnualLeavePeriods: 3,
      pendingReservesCapacity: false,
      timezone: 'Asia/Male',
      unitName: 'Special Services Unit',
      airportName: 'Velana International Airport',
      updatedByStaffId: 'CLI_ADMIN',
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log('Initialized missing appSettings/portalConfig (daily cap=10, annual limit=3).');
  }

  const randomCreds: Array<{
    staffId: string;
    fullName: string;
    designation: string;
    role: string;
    uid: string;
    tempPin: string;
  }> = [];

  let createdStaffCount = 0;
  let preservedStaffCount = 0;
  let createdLinksCount = 0;
  let createdSecretsCount = 0;
  let preservedSecretsCount = 0;

  // Step 4: Idempotently create missing staff/{staffId}, staffAuthLinks/{uid}, and staffPinSecrets/{staffId}
  for (const row of rows) {
    const existingStaffData = existingStaffById.get(row.staffId);
    const uid = existingStaffData?.authUid
      ? String(existingStaffData.authUid)
      : uidMap.get(row.staffId)!;

    const linkRef = db.collection('staffAuthLinks').doc(uid);
    const secretRef = db.collection('staffPinSecrets').doc(row.staffId);
    const [linkSnap, secretSnap] = await Promise.all([linkRef.get(), secretRef.get()]);

    const batch = db.batch();
    let hasBatchWrites = false;

    if (!existingStaffData) {
      batch.set(db.collection('staff').doc(row.staffId), {
        staffId: row.staffId,
        authUid: uid,
        fullName: row.fullName,
        designation: row.designation,
        role: row.role,
        isActive: row.isActive,
        mustChangePassword: true,
        unitSection: row.unitSection,
        annualPeriodLimit: row.annualPeriodLimit,
        countsTowardDailyCap: doesDesignationCountTowardDailyCap(row.designation),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      createdStaffCount += 1;
      hasBatchWrites = true;
    } else {
      preservedStaffCount += 1;
    }

    if (!linkSnap.exists) {
      const linkRole = String(existingStaffData?.role || row.role);
      const linkDesignation = String(existingStaffData?.designation || row.designation);
      const linkActive =
        existingStaffData && typeof existingStaffData.isActive === 'boolean'
          ? existingStaffData.isActive
          : row.isActive;
      batch.set(linkRef, {
        uid,
        staffId: row.staffId,
        role: linkRole,
        designation: linkDesignation,
        isActive: linkActive,
        updatedAt: FieldValue.serverTimestamp(),
      });
      createdLinksCount += 1;
      hasBatchWrites = true;
    }

    if (!secretSnap.exists) {
      const initialPin = useRandom ? generateRandomPin(6) : uniformPin;
      const { pinSalt, pinHash, hashAlgo } = hashPinPbkdf2Node(initialPin);
      batch.set(secretRef, {
        staffId: row.staffId,
        authUid: uid,
        pinSalt,
        pinHash,
        hashAlgo,
        mustChangePin: true,
        failedAttempts: 0,
        lockedUntilMs: 0,
        updatedAt: FieldValue.serverTimestamp(),
      });
      createdSecretsCount += 1;
      hasBatchWrites = true;

      if (useRandom) {
        randomCreds.push({
          staffId: row.staffId,
          fullName: row.fullName,
          designation: row.designation,
          role: row.role,
          uid,
          tempPin: initialPin,
        });
      }
    } else {
      preservedSecretsCount += 1;
    }

    if (hasBatchWrites) {
      await batch.commit();
    }
  }

  if (createdStaffCount > 0 || createdLinksCount > 0 || createdSecretsCount > 0) {
    const logId = `log_${Date.now().toString(36)}_imp`;
    await db.collection('auditLogs').doc(logId).set({
      logId,
      action: 'STAFF_IMPORTED',
      targetType: 'staff',
      targetId: 'bulk_import',
      actorStaffId: 'CLI_ADMIN',
      actorName: 'Administrator CLI',
      actorRole: 'manager',
      summary: `Idempotent roster import: created ${createdStaffCount} staff, ${createdLinksCount} auth link(s), ${createdSecretsCount} PIN secret(s); preserved ${preservedStaffCount} existing staff and ${preservedSecretsCount} existing PIN(s).`,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  console.log('Import summary (leaveRequests and existing records preserved):');
  console.log(`- New staff/{staffId} created: ${createdStaffCount}`);
  console.log(`- Existing staff/{staffId} preserved untouched: ${preservedStaffCount}`);
  console.log(`- New staffAuthLinks/{uid} created: ${createdLinksCount}`);
  console.log(`- New staffPinSecrets/{staffId} created: ${createdSecretsCount}`);
  console.log(`- Existing staffPinSecrets/{staffId} preserved untouched: ${preservedSecretsCount}`);

  if (useRandom && randomCreds.length > 0 && !process.env.GITHUB_ACTIONS) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvPath = path.resolve(process.cwd(), `.local-imported-credentials-${stamp}.csv`);
    const lines = [
      'Staff ID,Full Name,Designation,Role,Firebase UID,One-Time Temporary PIN',
      ...randomCreds.map((c) =>
        [c.staffId, c.fullName, c.designation, c.role, c.uid, c.tempPin]
          .map(escapeCsvCell)
          .join(',')
      ),
    ];
    writeRestrictedFile(csvPath, lines.join('\n') + '\n');
    console.log(`One-time random PINs saved locally to ${csvPath} (chmod 600). Delete after distribution.`);
  }
}

async function cmdResetPin(args: string[]) {
  const positional = stripFlags(args);
  const staffId = positional[0]?.trim();
  if (!staffId) {
    printUsage();
    process.exit(1);
  }
  const useRandom = args.includes('--random');
  const nextPin = useRandom
    ? generateRandomPin(6)
    : await resolveInitialPinFromCliOrEnv(args, `Enter temporary PIN for ${staffId}: `);

  const { db } = getAdminContext();
  const staffRef = db.collection('staff').doc(staffId);
  const staffSnap = await staffRef.get();
  if (!staffSnap.exists) {
    throw new Error(`Staff record "${staffId}" not found in Firestore.`);
  }
  const staffData = staffSnap.data() as Record<string, unknown>;
  const uid = staffData.authUid
    ? String(staffData.authUid)
    : staffIdToDeterministicUid(staffId);

  const { pinSalt, pinHash, hashAlgo } = hashPinPbkdf2Node(nextPin);
  const logId = `log_${Date.now().toString(36)}_pin`;

  const batch = db.batch();
  batch.set(db.collection('staffPinSecrets').doc(staffId), {
    staffId,
    authUid: uid,
    pinSalt,
    pinHash,
    hashAlgo,
    mustChangePin: true,
    failedAttempts: 0,
    lockedUntilMs: 0,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(staffRef, {
    authUid: uid,
    mustChangePassword: true,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection('staffAuthLinks').doc(uid), {
    uid,
    staffId,
    role: String(staffData.role || 'staff'),
    designation: String(staffData.designation || 'ASSISTANT OFFICER'),
    isActive: staffData.isActive !== false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection('auditLogs').doc(logId), {
    logId,
    action: 'PASSWORD_RESET_COMPLETED',
    targetType: 'staff',
    targetId: staffId,
    actorStaffId: 'CLI_ADMIN',
    actorName: 'Administrator CLI',
    actorRole: 'manager',
    summary: `Administrator reset PIN for ${staffId} (${String(staffData.fullName || staffId)}) via trusted Admin CLI.`,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  console.log(`PIN hash updated in staffPinSecrets/${staffId} (UID: ${uid}).`);
  if (useRandom) {
    console.log(`One-time temporary PIN (deliver securely): ${nextPin}`);
  }
  console.log('Employee will be prompted to set a personal PIN upon next login.');
}

async function cmdDeleteAuth(args: string[]) {
  const staffId = args[0]?.trim();
  if (!staffId) {
    printUsage();
    process.exit(1);
  }
  const { auth, db } = getAdminContext();
  const staffSnap = await db.collection('staff').doc(staffId).get();
  const uid = staffSnap.exists && staffSnap.data()?.authUid
    ? String(staffSnap.data()?.authUid)
    : staffIdToDeterministicUid(staffId);

  await db.collection('staffPinSecrets').doc(staffId).delete().catch(() => undefined);
  await db.collection('staffAuthLinks').doc(uid).delete().catch(() => undefined);

  try {
    await auth.deleteUser(uid);
    console.log(`Deleted PIN secret, auth link, and Firebase Auth user for ${staffId} (UID: ${uid}).`);
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'auth/user-not-found') {
      console.log(`Deleted PIN secret and auth link for ${staffId} (no Firebase Auth record for UID ${uid}).`);
      return;
    }
    throw err;
  }
}

async function cmdSyncDisabled() {
  const { auth, db } = getAdminContext();
  const staffSnap = await db.collection('staff').get();
  let updatedLinks = 0;
  let updatedAuth = 0;

  for (const docSnap of staffSnap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const uid = data.authUid ? String(data.authUid) : staffIdToDeterministicUid(docSnap.id);
    const isActive = data.isActive !== false;
    const shouldDisable = !isActive;

    await db.collection('staffAuthLinks').doc(uid).set(
      {
        uid,
        staffId: String(data.staffId || docSnap.id),
        role: String(data.role || 'staff'),
        designation: String(data.designation || 'ASSISTANT OFFICER'),
        isActive,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    updatedLinks += 1;

    try {
      const userRecord = await auth.getUser(uid);
      if (userRecord.disabled !== shouldDisable) {
        await auth.updateUser(uid, { disabled: shouldDisable });
        updatedAuth += 1;
        console.log(`Synced disabled=${shouldDisable} for ${docSnap.id} (${uid})`);
      }
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== 'auth/user-not-found') {
        throw err;
      }
    }
  }
  console.log(
    `Sync complete. Checked ${updatedLinks} staffAuthLinks docs; updated ${updatedAuth} Firebase Auth user(s).`
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'provision':
      await cmdProvision(rest);
      break;
    case 'import':
      await cmdImport(rest);
      break;
    case 'reset-pin':
    case 'reset-password':
      await cmdResetPin(rest);
      break;
    case 'delete-auth':
      await cmdDeleteAuth(rest);
      break;
    case 'sync-disabled':
      await cmdSyncDisabled();
      break;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Admin CLI error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
