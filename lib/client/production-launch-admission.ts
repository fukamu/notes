'use client';

const offlineAdmissionKey = 'fukamu-notes:production-launch-admitted';

type AdmissionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberOfflineLaunchAdmission(
  storage?: AdmissionStorage,
): void {
  try {
    (storage ?? sessionStorage).setItem(offlineAdmissionKey, '1');
  } catch {
    // A blocked storage API only removes offline admission; APIs stay gated.
  }
}

export function clearOfflineLaunchAdmission(storage?: AdmissionStorage): void {
  try {
    (storage ?? sessionStorage).removeItem(offlineAdmissionKey);
  } catch {
    // The next online server decision remains authoritative.
  }
}

export function hasOfflineLaunchAdmission(storage?: AdmissionStorage): boolean {
  try {
    return (storage ?? sessionStorage).getItem(offlineAdmissionKey) === '1';
  } catch {
    return false;
  }
}
