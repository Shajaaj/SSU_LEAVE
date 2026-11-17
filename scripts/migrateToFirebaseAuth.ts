import path from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import {
  assertNoAuthEmailCollisions,
  escapeCsvCell,
  generateTemporaryPassword,
  getAdminContext,
  writeRestrictedFile,
} from './adminContext.ts';

interface MigrationCredentialRow {
  staffId: string;
  fullName: string;
  designation: string;
  role: string;
  authUid: string;
  authEmail: string;
  temporaryPassword: string;
  status: string;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const resetAllPasswords = args.has('--reset-all-passwords');
  const stripLegacyHashes = args.has('--strip-legacy-hashes');

  const { auth, db, projectId, databaseId } = getAdminContext();
  console.log(`Connected to Firebase project="${projectId}", database="${databaseId}"`);
  console.log(
    `Mode: dryRun=${dryRun}, resetAllPasswords=${resetAllPasswords}, stripLegacyHashes=${stripLegacyHashes}`
  );

  // 1. Read all existing staff documents without overwriting or deleting any records
  const staffSnap = await db.collection('staff').get();
  if (staffSnap.empty) {
    console.log('No documents found in "staff" collection. Nothing to migrate.');
    return;
  }

  const staffDocs = staffSnap.docs
    .map((d) => ({
      docId: d.id,
      data: d.data() as Record<string, unknown>,
    }))
    .sort((a, b) => a.docId.localeCompare(b.docId));

  console.log(`Found ${staffDocs.length} existing staff record(s) in Firestore.`);

  // 2. Check deterministic internal auth identifier collisions before mutating anything
  const staffIds = staffDocs.map((s) => String(s.data.staffId || s.docId));
  const staffEmailMap = assertNoAuthEmailCollisions(staffIds);
  console.log('Collision check passed: 0 Staff ID normalization collisions.');

  // 3. Create restricted local backup JSON before migration
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (!dryRun) {
    const backupPath = path.resolve(process.cwd(), `.local-staff-backup-${stamp}.json`);
    const backupPayload = staffDocs.map((s) => ({
      staffId: s.docId,
      ...s.data,
      passwordHash: s.data.passwordHash ? '[REDACTED_LEGACY_HASH]' : undefined,
    }));
    writeRestrictedFile(backupPath, JSON.stringify(backupPayload, null, 2));
    console.log(`Saved restricted pre-migration metadata backup to ${backupPath}`);
  }

  // Ensure appSettings/portalConfig exists so client listeners always find baseline config
  const settingsRef = db.collection('appSettings').doc('portalConfig');
  const settingsSnap = await settingsRef.get();
  if (!settingsSnap.exists && !dryRun) {
    await settingsRef.set({
      maxDailyCombinedCap: 10,
      maxAnnualLeavePeriods: 3,
      pendingReservesCapacity: false,
      timezone: 'Asia/Male',
      unitName: 'Special Services Unit',
      airportName: 'Velana International Airport',
      updatedByStaffId: 'SYSTEM_MIGRATION',
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log('Initialized missing appSettings/portalConfig document.');
  }

  // 4. Provision/link Firebase Authentication users and staffAuthLinks/{uid}
  const credentialsOut: MigrationCredentialRow[] = [];
  let createdAuthCount = 0;
  let linkedExistingCount = 0;
  let updatedPasswordCount = 0;

  for (const { docId, data } of staffDocs) {
    const staffId = String(data.staffId || docId);
    const fullName = String(data.fullName || staffId);
    const designation = String(data.designation || 'ASSISTANT OFFICER');
    const role = String(data.role || 'staff');
    const isActive = data.isActive !== false;
    const authEmail = staffEmailMap.get(staffId)!;

    let existingAuthUser = null;
    try {
      existingAuthUser = await auth.getUserByEmail(authEmail);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== 'auth/user-not-found') {
        throw err;
      }
    }

    if (dryRun) {
      console.log(
        `[DRY RUN] ${staffId} (${fullName}) -> ${authEmail} | authExists=${Boolean(existingAuthUser)} | isActive=${isActive}`
      );
      continue;
    }

    let uid: string;
    let tempPassword = '';
    let statusLabel = '';

    if (!existingAuthUser) {
      tempPassword = generateTemporaryPassword(12);
      const userRecord = await auth.createUser({
        email: authEmail,
        emailVerified: true,
        password: tempPassword,
        displayName: `${staffId} - ${fullName}`.slice(0, 120),
        disabled: !isActive,
      });
      uid = userRecord.uid;
      createdAuthCount += 1;
      statusLabel = 'CREATED_AUTH_ACCOUNT';
    } else {
      uid = existingAuthUser.uid;
      linkedExistingCount += 1;
      if (resetAllPasswords) {
        tempPassword = generateTemporaryPassword(12);
        await auth.updateUser(uid, {
          password: tempPassword,
          emailVerified: true,
          displayName: `${staffId} - ${fullName}`.slice(0, 120),
          disabled: !isActive,
        });
        updatedPasswordCount += 1;
        statusLabel = 'LINKED_AND_PASSWORD_RESET';
      } else {
        await auth.updateUser(uid, {
          emailVerified: true,
          displayName: `${staffId} - ${fullName}`.slice(0, 120),
          disabled: !isActive,
        });
        statusLabel = 'LINKED_EXISTING_AUTH';
      }
    }

    const batch = db.batch();
    const staffUpdate: Record<string, unknown> = {
      authUid: uid,
      authEmail,
      mustChangePassword: tempPassword ? true : Boolean(data.mustChangePassword),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (stripLegacyHashes && 'passwordHash' in data) {
      staffUpdate.passwordHash = FieldValue.delete();
    }
    batch.update(db.collection('staff').doc(docId), staffUpdate);

    batch.set(db.collection('staffAuthLinks').doc(uid), {
      uid,
      staffId,
      role,
      designation,
      isActive,
      updatedAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    if (tempPassword) {
      credentialsOut.push({
        staffId,
        fullName,
        designation,
        role,
        authUid: uid,
        authEmail,
        temporaryPassword: tempPassword,
        status: statusLabel,
      });
    }
  }

  if (dryRun) {
    console.log('\nDry run finished. No Firebase Auth users or Firestore documents modified.');
    return;
  }

  console.log('\nMigration summary:');
  console.log(`- Total staff records processed: ${staffDocs.length}`);
  console.log(`- New Firebase Auth accounts created: ${createdAuthCount}`);
  console.log(`- Existing Firebase Auth accounts linked: ${linkedExistingCount}`);
  console.log(`- Existing accounts with password reset: ${updatedPasswordCount}`);

  if (credentialsOut.length > 0) {
    const csvPath = path.resolve(
      process.cwd(),
      `.local-initial-credentials-${stamp}.csv`
    );
    const header = [
      'Staff ID',
      'Full Name',
      'Designation',
      'Role',
      'Firebase UID',
      'Internal Auth Email (Do Not Display on Login)',
      'One-Time Temporary Password',
      'Status',
    ]
      .map(escapeCsvCell)
      .join(',');

    const lines = credentialsOut.map((row) =>
      [
        row.staffId,
        row.fullName,
        row.designation,
        row.role,
        row.authUid,
        row.authEmail,
        row.temporaryPassword,
        row.status,
      ]
        .map(escapeCsvCell)
        .join(',')
    );

    writeRestrictedFile(csvPath, [header, ...lines].join('\n') + '\n');
    console.log(
      `\nWrote ${credentialsOut.length} one-time initial password(s) to ${csvPath} (chmod 600).`
    );
    console.log(
      'Distribute each temporary password securely to the employee; they will be required to change it on first login.'
    );
    console.log('Delete the local CSV file after distribution.');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
