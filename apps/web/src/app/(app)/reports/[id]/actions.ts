'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';

/**
 * Report release: fetch the content hash, re-authenticate for a signing token
 * bound to it, then apply. All server-side, so the password never enters client
 * state and the signature is bound to exactly what was on screen.
 */
export async function releaseReport(reportId: string, formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '');
  const totpCode = String(formData.get('totpCode') ?? '').trim() || undefined;
  const channels = formData.getAll('channel').map(String);

  const { contentHash } = await apiFetch<{ contentHash: string }>(
    `/reports/${reportId}/content-hash`,
  );

  const { signingToken } = await apiFetch<{ signingToken: string }>('/auth/signing-token', {
    method: 'POST',
    body: {
      password,
      totpCode,
      entityType: 'Report',
      entityId: reportId,
      meaning: 'AUTHORIZED',
      contentHash,
    },
  });

  await apiFetch(`/reports/${reportId}/release`, {
    method: 'POST',
    body: { signingToken, deliverTo: channels.map((channel) => ({ channel })) },
  });

  revalidatePath(`/reports/${reportId}`);
}


/**
 * Amendment.
 *
 * The same signing dance as release, with `meaning: 'AMENDED'` — a distinct
 * assertion over the same content, which is why the replay guard is scoped by
 * meaning as well as content (auth.service.ts).
 *
 * Amendment supersedes rather than edits: the released version stays exactly as
 * the patient received it, and a new version is issued. That is what makes the
 * correction defensible instead of a quiet rewrite.
 */
export async function amendReport(reportId: string, formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '');
  const totpCode = String(formData.get('totpCode') ?? '').trim() || undefined;
  const reason = String(formData.get('reason') ?? '').trim();

  const { contentHash } = await apiFetch<{ contentHash: string }>(
    `/reports/${reportId}/content-hash`,
  );

  const { signingToken } = await apiFetch<{ signingToken: string }>('/auth/signing-token', {
    method: 'POST',
    body: {
      password,
      totpCode,
      entityType: 'Report',
      entityId: reportId,
      meaning: 'AMENDED',
      contentHash,
    },
  });

  await apiFetch(`/reports/${reportId}/amend`, {
    method: 'POST',
    body: { signingToken, reason },
  });

  revalidatePath(`/reports/${reportId}`);
  revalidatePath('/reports');
}
