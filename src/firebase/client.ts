import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import appletConfig from '../../firebase-applet-config.json';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || appletConfig.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || appletConfig.authDomain,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || appletConfig.projectId,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || appletConfig.storageBucket,
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || appletConfig.messagingSenderId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || appletConfig.appId,
};

const rawDatabaseId =
  import.meta.env.VITE_FIREBASE_DATABASE_ID || appletConfig.firestoreDatabaseId || '';
const firestoreDatabaseId =
  rawDatabaseId.trim() && rawDatabaseId.trim() !== '(default)'
    ? rawDatabaseId.trim()
    : undefined;

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = firestoreDatabaseId
  ? getFirestore(firebaseApp, firestoreDatabaseId)
  : getFirestore(firebaseApp);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export const FIRESTORE_QUOTA_USER_MESSAGE =
  'Service temporarily unavailable: daily Firestore quota limit reached. All accounts and leave records remain safe; please try again after the daily quota resets.';

export function isFirestoreQuotaError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object') {
    const obj = error as { code?: unknown; status?: unknown; message?: unknown };
    if (obj.code === 'resource-exhausted' || obj.code === 'RESOURCE_EXHAUSTED') {
      return true;
    }
    if (obj.status === 429 || obj.status === 503) {
      return true;
    }
    if (typeof obj.message === 'string' && isFirestoreQuotaError(obj.message)) {
      return true;
    }
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /RESOURCE_EXHAUSTED|resource-exhausted|quota\s+exceeded|daily\s+Firebase\s+Firestore\s+free-tier\s+quota|daily\s+Firestore\s+quota/i.test(
    msg
  );
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  if (isFirestoreQuotaError(error)) {
    throw new Error(FIRESTORE_QUOTA_USER_MESSAGE);
  }
  throw new Error(JSON.stringify(errInfo));
}

const CONNECTION_CHECK_KEY = 'ssu_fs_conn_checked';

export async function testFirestoreConnection(): Promise<void> {
  if (typeof window !== 'undefined') {
    try {
      if (window.sessionStorage.getItem(CONNECTION_CHECK_KEY) === '1') {
        return;
      }
    } catch {
      // Ignore storage access errors
    }
  }

  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(CONNECTION_CHECK_KEY, '1');
      } catch {
        // Ignore storage access errors
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testFirestoreConnection();
