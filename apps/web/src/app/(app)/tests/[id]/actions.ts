'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api';

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export async function enterResults(
  testId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const results: { analyteId: string; value: string; comment?: string }[] = [];

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('value:')) continue;
    const analyteId = key.slice('value:'.length);
    const v = String(value).trim();
    // Blank means "not measured", not "zero". Skipping is correct — an empty
    // string would be stored as a result.
    if (v === '') continue;
    results.push({ analyteId, value: v });
  }

  if (results.length === 0) {
    return { ok: false, message: 'Enter at least one value.' };
  }

  const interpretation = String(formData.get('interpretation') ?? '').trim();

  try {
    await apiFetch(`/tests/${testId}/results`, {
      method: 'POST',
      body: { results, ...(interpretation ? { interpretation } : {}) },
    });
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }

  revalidatePath(`/tests/${testId}`);
  return { ok: true, message: `${results.length} result(s) saved.` };
}

export async function verifyTest(
  testId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await apiFetch(`/tests/${testId}/verify`, {
      method: 'POST',
      body: { note: String(formData.get('note') ?? '').trim() || undefined },
    });
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }

  revalidatePath(`/tests/${testId}`);
  return { ok: true, message: 'Technically verified.' };
}

/**
 * Authorisation: the full electronic-signature flow, server-side.
 *
 *   1. Fetch the content hash of exactly what is on screen.
 *   2. Re-authenticate (password + TOTP) to obtain a signing token bound to
 *      that hash.
 *   3. Apply it.
 *
 * Doing all three here means the password is used within one request and never
 * lives in client state. If the results changed between (1) and (3) the hashes
 * diverge and the API refuses — which is the entire point of binding a
 * signature to content rather than to a button press.
 */
export async function authorizeTest(
  testId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const password = String(formData.get('password') ?? '');
  const totpCode = String(formData.get('totpCode') ?? '').trim() || undefined;
  const note = String(formData.get('note') ?? '').trim() || undefined;

  if (!password) return { ok: false, message: 'Your password is required to sign.' };

  try {
    const { contentHash } = await apiFetch<{ contentHash: string }>(
      `/tests/${testId}/content-hash`,
    );

    const { signingToken } = await apiFetch<{ signingToken: string }>('/auth/signing-token', {
      method: 'POST',
      body: {
        password,
        totpCode,
        entityType: 'SampleTest',
        entityId: testId,
        meaning: 'AUTHORIZED',
        contentHash,
      },
    });

    await apiFetch(`/tests/${testId}/authorize`, {
      method: 'POST',
      body: { signingToken, meaning: 'AUTHORIZED', note },
    });
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }

  revalidatePath(`/tests/${testId}`);
  revalidatePath('/worklist');
  return { ok: true, message: 'Authorised and signed.' };
}

export async function rerunTest(
  testId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 10) {
    return { ok: false, message: 'Give a reason of at least 10 characters — it is recorded in the audit trail.' };
  }

  try {
    await apiFetch(`/tests/${testId}/rerun`, { method: 'POST', body: { reason } });
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }

  revalidatePath(`/tests/${testId}`);
  return { ok: true, message: 'Marked for re-run. Previous values retained in the record.' };
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.fieldErrors) {
      return Object.entries(err.fieldErrors)
        .map(([field, msgs]) => `${field}: ${msgs.join(', ')}`)
        .join(' · ');
    }
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}
