import fs from 'node:fs';
import path from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import {
  type ServerDesignation,
  type ServerRole,
  deriveDefaultRole,
  doesDesignationCountTowardDailyCap,
} from './initialStaffRoster.ts';
import { isValidStaffIdFormat, staffIdToAuthEmail } from '../src/utils/staffAuthId.ts';
import {
  assertNoAuthEmailCollisions,
  escapeCsvCell,
  generateTemporaryPassword,
  getAdminContext,
  normalizeDesignation,
  parseStaffImportText,
  writeRestrictedFile,
} from './adminContext.ts';

function printUsage() {
  console.log(`
Special Services Admin CLI (Firebase Authentication + Cloud Firestore)

Usage:
  npx tsx scripts/adminStaffAuth.ts provision <staffId> "<fullName>" "<designation>" [role] [unitSection]
  npx tsx scripts/adminStaffAuth.ts import <pathToCsvOrMarkdownFile>
  npx tsx scripts/adminStaffAuth.ts reset-password <staffId> [--password <min8Chars>]
  npx tsx scripts/adminStaffAuth.ts delete-auth <staffId>
  npx tsx scripts/adminStaffAuth.ts sync-disabled
`);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function cmdProvision(args: string[]) {
  const [staffIdRaw, fullNameRaw, designationRaw, roleRaw, unitSectionRaw] = args;
  if (!staffIdRaw || !fullNameRaw || !designationRaw) {
    printUsage();
    process.exit(1);
  }
  const staffId = staffIdRaw.trim();
  if (!isValidStaffIdFormat(staffId)) {
    throw new Error(`Invalid Staff ID "${staffId}". Use 2–24 alphanumeric/hyphen characters.`);
  }

  const designation: ServerDesignation = normalizeDesignation(designationRaw);
  const role: ServerRole =
    roleRaw === 'staff' || roleRaw === 'executive' || roleRaw === 'manager'
      ? roleRaw
      : deriveDefaultRole(staffId, designation);
  const unitSection = (unitSectionRaw || 'Special Services').trim();

  const { auth, db } = getAdminContext();

  // Collision check against existing staff collection
  const existingStaffSnap = await db.collection('staff').get();
  const existingIds = existingStaffSnap.docs.map((d) => d.id);
  if (existingStaffSnap.docs.some((d) => d.id.toLowerCase() === staffId.toLowerCase())) {
    throw new Error(`Staff record "${staffId}" already exists.`);
  }
  const emailMap = assertNoAuthEmailCollisions([...existingIds, staffId]);
  const authEmail = emailMap.get(staffId)!;

  const tempPassword = generateTemporaryPassword(12);
  const userRecord = await auth.createUser({
    email: authEmail,
    emailVerified: true,
    password: tempPassword,
    displayName: `${staffId} - ${fullNameRaw.trim()}`.slice(0, 120),
    disabled: false,
  });

  const logId = `log_${Date.now().toString(36)}_prov`;
  const batch = db.batch();
  batch.set(db.collection('staff').doc(staffId), {
    staffId,
    authUid: userRecord.uid,
    authEmail,
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
  batch.set(db.collection('staffAuthLinks').doc(userRecord.uid), {
    uid: userRecord.uid,
    staffId,
    role,
    designation,
    isActive: true,
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

  console.log(`Provisioned ${staffId} (${fullNameRaw.trim()}) | UID: ${userRecord.uid}`);
  console.log(`One-time temporary password (deliver securely, never stored in Firestore): ${tempPassword}`);
}

async function cmdImport(args: string[]) {
  const filePathArg = args[0];
  if (!filePathArg) {
    printUsage();
    process.exit(1);
  }
  const fullPath = path.resolve(process.cwd(), filePathArg);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const rows = parseStaffImportText(raw);
  if (rows.length === 0) {
    console.log('No valid staff rows found in input file.');
    return;
  }

  const { auth, db } = getAdminContext();
  const existingSnap = await db.collection('staff').get();
  const existingIds = existingSnap.docs.map((d) => d.id);
  const existingLowerSet = new Set(existingIds.map((id) => id.toLowerCase()));

  const newRows = rows.filter((r) => !existingLowerSet.has(r.staffId.toLowerCase()));
  const skippedCount = rows.length - newRows.length;

  const emailMap = assertNoAuthEmailCollisions([
    ...existingIds,
    ...newRows.map((r) => r.staffId),
  ]);

  const createdCreds: Array<{
    staffId: string;
    fullName: string;
    designation: string;
    role: string;
    uid: string;
    tempPassword: string;
  }> = [];

  for (const row of newRows) {
    const authEmail = emailMap.get(row.staffId)!;
    const tempPassword = generateTemporaryPassword(12);
    const role = row.role || deriveDefaultRole(row.staffId, row.designation);

    const userRecord = await auth.createUser({
      email: authEmail,
      emailVerified: true,
      password: tempPassword,
      displayName: `${row.staffId} - ${row.fullName}`.slice(0, 120),
      disabled: false,
    });

    const batch = db.batch();
    batch.set(db.collection('staff').doc(row.staffId), {
      staffId: row.staffId,
      authUid: userRecord.uid,
      authEmail,
      fullName: row.fullName,
      designation: row.designation,
      role,
      isActive: true,
      mustChangePassword: true,
      unitSection: 'Special Services',
      annualPeriodLimit: 3,
      countsTowardDailyCap: doesDesignationCountTowardDailyCap(row.designation),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.set(db.collection('staffAuthLinks').doc(userRecord.uid), {
      uid: userRecord.uid,
      staffId: row.staffId,
      role,
      designation: row.designation,
      isActive: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    createdCreds.push({
      staffId: row.staffId,
      fullName: row.fullName,
      designation: row.designation,
      role,
      uid: userRecord.uid,
      tempPassword,
    });
  }

  if (createdCreds.length > 0) {
    const logId = `log_${Date.now().toString(36)}_imp`;
    await db.collection('auditLogs').doc(logId).set({
      logId,
      action: 'STAFF_IMPORTED',
      targetType: 'staff',
      targetId: 'bulk_import',
      actorStaffId: 'CLI_ADMIN',
      actorName: 'Administrator CLI',
      actorRole: 'manager',
      summary: `Imported ${createdCreds.length} staff record(s) into Firebase Auth & Firestore (${skippedCount} existing skipped).`,
      createdAt: FieldValue.serverTimestamp(),
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvPath = path.resolve(process.cwd(), `.local-imported-credentials-${stamp}.csv`);
    const lines = [
      'Staff ID,Full Name,Designation,Role,Firebase UID,One-Time Temporary Password',
      ...createdCreds.map((c) =>
        [c.staffId, c.fullName, c.designation, c.role, c.uid, c.tempPassword]
          .map(escapeCsvCell)
          .join(',')
      ),
    ];
    writeRestrictedFile(csvPath, lines.join('\n') + '\n');
    console.log(`Imported ${createdCreds.length} new staff (${skippedCount} skipped).`);
    console.log(`One-time credentials saved to ${csvPath} (chmod 600). Delete after distribution.`);
  } else {
    console.log(`No new accounts created (${skippedCount} existing staff skipped).`);
  }
}

async function cmdResetPassword(args: string[]) {
  const staffId = args[0]?.trim();
  if (!staffId) {
    printUsage();
    process.exit(1);
  }
  const customPassword = getFlagValue(args, '--password');
  if (customPassword !== undefined && customPassword.trim().length < 8) {
    throw new Error('Custom password must be at least 8 characters long.');
  }

  const { auth, db } = getAdminContext();
  const staffRef = db.collection('staff').doc(staffId);
  const staffSnap = await staffRef.get();
  if (!staffSnap.exists) {
    throw new Error(`Staff record "${staffId}" not found in Firestore.`);
  }
  const staffData = staffSnap.data() as Record<string, unknown>;
  const authEmail = String(staffData.authEmail || staffIdToAuthEmail(staffId));

  let uid = staffData.authUid ? String(staffData.authUid) : '';
  if (!uid) {
    const userRecord = await auth.getUserByEmail(authEmail);
    uid = userRecord.uid;
  }

  const nextPassword = customPassword ? customPassword.trim() : generateTemporaryPassword(12);
  await auth.updateUser(uid, {
    password: nextPassword,
    emailVerified: true,
    disabled: staffData.isActive === false,
  });

  const logId = `log_${Date.now().toString(36)}_pwd`;
  const batch = db.batch();
  batch.update(staffRef, {
    authUid: uid,
    authEmail,
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
    summary: `Administrator reset password for ${staffId} (${String(staffData.fullName || staffId)}) via trusted Admin CLI.`,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  console.log(`Password updated in Firebase Authentication for ${staffId} (UID: ${uid}).`);
  console.log(`One-time temporary password (deliver securely): ${nextPassword}`);
  console.log('Employee will be prompted to set a personal password upon next login.');
}

async function cmdDeleteAuth(args: string[]) {
  const staffId = args[0]?.trim();
  if (!staffId) {
    printUsage();
    process.exit(1);
  }
  const { auth, db } = getAdminContext();
  const authEmail = staffIdToAuthEmail(staffId);
  try {
    const user = await auth.getUserByEmail(authEmail);
    await auth.deleteUser(user.uid);
    await db.collection('staffAuthLinks').doc(user.uid).delete().catch(() => undefined);
    console.log(`Deleted Firebase Authentication account for ${staffId} (UID: ${user.uid}).`);
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'auth/user-not-found') {
      console.log(`No Firebase Authentication user found for ${staffId} (${authEmail}).`);
      return;
    }
    throw err;
  }
}

async function cmdSyncDisabled() {
  const { auth, db } = getAdminContext();
  const staffSnap = await db.collection('staff').get();
  let updated = 0;

  for (const docSnap of staffSnap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const uid = data.authUid ? String(data.authUid) : '';
    if (!uid) continue;
    const shouldDisable = data.isActive === false;
    const userRecord = await auth.getUser(uid);
    if (userRecord.disabled !== shouldDisable) {
      await auth.updateUser(uid, { disabled: shouldDisable });
      updated += 1;
      console.log(`Synced disabled=${shouldDisable} for ${docSnap.id} (${uid})`);
    }
  }
  console.log(`Sync complete. Updated ${updated} Firebase Auth account(s).`);
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
    case 'reset-password':
      await cmdResetPassword(rest);
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
