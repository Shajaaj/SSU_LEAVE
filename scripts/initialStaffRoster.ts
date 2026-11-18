export type ServerDesignation =
  | 'EXECUTIVE'
  | 'OFFICER'
  | 'ASSISTANT OFFICER'
  | 'ATTENDANT'
  | 'MANAGER';

export type ServerRole = 'staff' | 'executive' | 'manager';

export interface InitialStaffSeedRow {
  staffId: string;
  fullName: string;
  designation: ServerDesignation;
  role?: ServerRole;
}

export const AUTHORIZED_MANAGER_STAFF_IDS = new Set<string>(['a5530']);
export const AUTHORIZED_EXECUTIVE_STAFF_IDS = new Set<string>(['a4107']);

export function resolveAuthorizedRole(
  staffId: string,
  designation: ServerDesignation,
  requestedRole?: string
): ServerRole {
  const token = staffId.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (AUTHORIZED_MANAGER_STAFF_IDS.has(token)) {
    return 'manager';
  }
  if (AUTHORIZED_EXECUTIVE_STAFF_IDS.has(token)) {
    return 'executive';
  }
  if (requestedRole) {
    const normalizedRole = requestedRole.trim().toLowerCase();
    if (normalizedRole === 'manager') {
      throw new Error(
        `Role escalation rejected for "${staffId}": Manager permissions can only be assigned through the authorized role mapping.`
      );
    }
    if (normalizedRole === 'executive') return 'executive';
    if (normalizedRole === 'staff') return 'staff';
    throw new Error(
      `Unsupported role "${requestedRole}" for "${staffId}". Allowed CSV roles: staff, executive.`
    );
  }
  if (designation === 'EXECUTIVE') return 'executive';
  return 'staff';
}

export function deriveDefaultRole(
  staffId: string,
  designation: ServerDesignation
): ServerRole {
  return resolveAuthorizedRole(staffId, designation);
}

export function doesDesignationCountTowardDailyCap(
  designation: ServerDesignation
): boolean {
  return designation === 'ASSISTANT OFFICER' || designation === 'ATTENDANT';
}

export const INITIAL_STAFF_ROSTER: InitialStaffSeedRow[] = [
  { staffId: 'A-5530', fullName: 'Mohamed Shajaaj', designation: 'EXECUTIVE', role: 'manager' },
  { staffId: 'A-4107', fullName: 'Hussain Meeaadh', designation: 'EXECUTIVE', role: 'executive' },
  { staffId: 'A-6077', fullName: 'Mohamed Fareez', designation: 'OFFICER' },
  { staffId: 'A-4648', fullName: 'Abdulla Ahlam', designation: 'OFFICER' },
  { staffId: 'A-7111', fullName: 'Mohamed Adil', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-8084', fullName: 'Hassan Inaan', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-8164', fullName: 'Ismail Shahudh', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-8736', fullName: 'Mohamed Azan', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-8737', fullName: 'Fathimath Shaima', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-8817', fullName: 'Nashwa Abdul Azeez', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-9379', fullName: 'Yoosuf Mohamed', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-9635', fullName: 'Abdulla Zibaan', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-10010', fullName: 'Ahmed Yazin', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-10000', fullName: 'Ibrahim Rayan', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10002', fullName: 'Mariyam Rifasha', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10003', fullName: 'Nashaa Moosa', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10004', fullName: 'Fathimath Yumunu', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10005', fullName: 'Ali Zain', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10006', fullName: 'Ifham Muaz', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10007', fullName: 'Ahmed Layaan', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10008', fullName: 'Ali Raakin', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10009', fullName: 'Hussain Saamee', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10011', fullName: 'Aishath Leen', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10012', fullName: 'Aishath Maiha', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A10016', fullName: 'Aishath Aini', designation: 'ASSISTANT OFFICER' },
  { staffId: 'A-10017', fullName: 'Ahnaf Shareef', designation: 'ASSISTANT OFFICER' },
];
