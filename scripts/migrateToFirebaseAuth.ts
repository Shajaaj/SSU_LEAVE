import path from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';
import {
  INITIAL_STAFF_ROSTER,
  deriveDefaultRole,
  doesDesignationCountTowardDailyCap,
} from './initialStaffRoster.ts';
import {
  assertNoStaffUidCollisions,
  escapeCsvCell,
  generateRandomPin,
  getAdminContext,
  hashPinPbkdf2Node,
  resolveInitialPinFromCliOrEnv,
  writeRestrictedFile,
} from './adminContext.ts';

interface RandomCredentialRow {
  staffId: string;
  fullName: string;
  designation: string;
  role: string;
  authUid: string;
  temporaryPin: string;
  status: string;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const dryRun = args.has('--dry-run');
  const resetAllPins = args.has('--reset-all-pins') || args.has('--reset-all-passwords');
  const stripLegacyHashes = args.has('--strip-legacy-hashes');
  const randomPins = args.has('--random');
  const seedRoster = args.has('--seed-initial-roster');

  const { db, projectId, databaseId } = getAdminContext();
  console.log(`Connected to Firebase project="${projectId}", database="${databaseId}"`);
  console.log(
    `Mode: dryRun=${dryRun}, resetAllPins=${resetAllPins}, randomPins=${randomPins}, stripLegacyHashes=${stripLegacyHashes}, seedRoster=${seedRoster}`
  );

  if (!dryRun && seedRoster) {
    let seededCount = 0;
    for (const row of INITIAL_STAFF_ROSTER) {
      const ref = db.collection('staff').doc(row.staffId);
      const snap = await ref.get();
      if (!snap.exists) {
        await ref.set({
          staffId: row.staffId,
          fullName: row.fullName,
          designation: row.designation,
          role: row.role || deriveDefaultRole(row.staffId, row.designation),
          isActive: true,
          mustChangePassword: true,
          unitSection: 'Special Services',
          annualPeriodLimit: 3,
          countsTowardDailyCap: doesDesignationCountTowardDailyCap(row.designation),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        seededCount += 1;
      }
    }
    console.log(
      `Roster check complete: seeded ${seededCount} missing staff record(s) without overwriting existing docs.`
    );
  }

  // 1. Read all existing staff documents without overwriting or deleting any records
  const staffSnap = await db.collection('staff').get();
  if (staffSnap.empty) {
    console.log(
      'No documents found in "staff" collection. Restore your Firestore staff export first or pass --seed-initial-roster / run `adminStaffAuth.ts import <roster.csv>`.'
    );
    return;
  }

  const staffDocs = staffSnap.docs
    .map((d) => ({
      docId: d.id,
      data: d.data() as Record<string, unknown>,
    }))
    .sort((a, b) => a.docId.localeCompare(b.docId));

  console.log(`Found ${staffDocs.length} existing staff record(s) in Firestore.`);

  // 2. Check deterministic UID collisions before mutating anything
  const staffIds = staffDocs.map((s) => String(s.data.staffId || s.docId));
  const staffUidMap = assertNoStaffUidCollisions(staffIds);
  console.log('Collision check passed: 0 Staff ID normalization collisions.');

  // Resolve uniform initial PIN from --pin, INITIAL_STAFF_PIN, or interactive prompt unless --dry-run / --random
  let uniformInitialPin = '';
  if (!dryRun && !randomPins) {
    uniformInitialPin = await resolveInitialPinFromCliOrEnv(argv);
  }

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

  // 4. Provision/link staffAuthLinks/{uid} and server-only PBKDF2 staffPinSecrets/{staffId}
  const randomOut: RandomCredentialRow[] = [];
  let createdSecretCount = 0;
  let preservedSecretCount = 0;
  let resetSecretCount = 0;

  for (const { docId, data } of staffDocs) {
    const staffId = String(data.staffId || docId);
    const fullName = String(data.fullName || staffId);
    const designation = String(data.designation || 'ASSISTANT OFFICER');
    const role = String(data.role || 'staff');
    const isActive = data.isActive !== false;
    const uid = String(data.authUid || staffUidMap.get(staffId)!);

    const secretRef = db.collection('staffPinSecrets').doc(staffId);
    const secretSnap = await secretRef.get();

    if (dryRun) {
      console.log(
        `[DRY RUN] ${staffId} (${fullName}) -> uid=${uid} | secretExists=${secretSnap.exists} | isActive=${isActive}`
      );
      continue;
    }

    let assignedPin = '';
    let statusLabel = '';
    let shouldWriteSecret = false;

    if (!secretSnap.exists) {
      assignedPin = randomPins ? generateRandomPin(6) : uniformInitialPin;
      shouldWriteSecret = true;
      createdSecretCount += 1;
      statusLabel = 'INITIALIZED_PIN_SECRET';
    } else if (resetAllPins) {
      assignedPin = randomPins ? generateRandomPin(6) : uniformInitialPin;
      shouldWriteSecret = true;
      resetSecretCount += 1;
      statusLabel = 'RESET_PIN_SECRET';
    } else {
      preservedSecretCount += 1;
      statusLabel = 'PRESERVED_EXISTING_PIN';
    }

    const batch = db.batch();

    if (shouldWriteSecret) {
      const { pinSalt, pinHash, hashAlgo } = hashPinPbkdf2Node(assignedPin);
      batch.set(secretRef, {
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
    }

    const nextMustChange = shouldWriteSecret
      ? true
      : Boolean(secretSnap.data()?.mustChangePin ?? data.mustChangePassword);

    const staffUpdate: Record<string, unknown> = {
      authUid: uid,
      mustChangePassword: nextMustChange,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!('createdAt' in data)) {
      staffUpdate.createdAt = FieldValue.serverTimestamp();
    }
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

    if (randomPins && assignedPin) {
      randomOut.push({
        staffId,
        fullName,
        designation,
        role,
        authUid: uid,
        temporaryPin: assignedPin,
        status: statusLabel,
      });
    }
  }

  if (dryRun) {
    console.log('\nDry run finished. No Firestore documents modified.');
    return;
  }

  console.log('\nProvisioning summary:');
  console.log(`- Total existing staff records processed: ${staffDocs.length}`);
  console.log(`- New server-side PBKDF2 PIN secrets created: ${createdSecretCount}`);
  console.log(`- Existing PIN secrets preserved untouched: ${preservedSecretCount}`);
  console.log(`- Existing PIN secrets reset (--reset-all-pins): ${resetSecretCount}`);
  console.log('- Existing staff profile details and leave requests were left untouched.');

  if (randomOut.length > 0) {
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
      'One-Time Temporary PIN',
      'Status',
    ]
      .map(escapeCsvCell)
      .join(',');

    const lines = randomOut.map((row) =>
      [
        row.staffId,
        row.fullName,
        row.designation,
        row.role,
        row.authUid,
        row.temporaryPin,
        row.status,
      ]
        .map(escapeCsvCell)
        .join(',')
    );

    writeRestrictedFile(csvPath, [header, ...lines].join('\n') + '\n');
    console.log(
      `\nWrote ${randomOut.length} one-time random PIN(s) to ${csvPath} (chmod 600). Delete after distribution.`
    );
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
