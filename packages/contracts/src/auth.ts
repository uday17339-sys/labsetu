import { z } from 'zod';
import { SIGNATURE_MEANING } from './enums';

export const loginSchema = z.object({
  tenantCode: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  /** Present on the second leg when the account has MFA enabled. */
  totpCode: z.string().trim().regex(/^\d{6}$/).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const loginResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('MFA_REQUIRED'),
    /** Short-lived, single-purpose: only exchangeable for a real session. */
    mfaToken: z.string(),
  }),
  z.object({
    status: z.literal('OK'),
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.number().int(),
    user: z.object({
      id: z.string().uuid(),
      email: z.string(),
      fullName: z.string(),
      tenantId: z.string().uuid(),
      tenantCode: z.string(),
      tenantName: z.string(),
      permissions: z.array(z.string()),
      roles: z.array(z.string()),
      labs: z.array(z.object({ id: z.string().uuid(), code: z.string(), name: z.string() })),
      isMfaEnabled: z.boolean(),
      mustChangePassword: z.boolean(),
      locale: z.string(),
    }),
  }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    // Length beats composition rules — current NIST guidance, and it is what
    // actually resists guessing.
    newPassword: z.string().min(12, 'Use at least 12 characters').max(200),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: 'New password must differ from the current one',
    path: ['newPassword'],
  });

export const mfaSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrDataUrl: z.string(),
  recoveryCodes: z.array(z.string()),
});

export const mfaVerifySchema = z.object({
  totpCode: z.string().trim().regex(/^\d{6}$/),
});

/**
 * Requesting a signing token. Re-authentication is mandatory even with an active
 * session — a signature any open browser tab can produce is not a signature
 * (COMPLIANCE.md §4).
 */
export const signingTokenRequestSchema = z.object({
  password: z.string().min(1),
  totpCode: z.string().trim().regex(/^\d{6}$/).optional(),
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
  meaning: z.enum(SIGNATURE_MEANING),
  /** SHA-256 of exactly what is being signed; binds the token to that content. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SigningTokenRequest = z.infer<typeof signingTokenRequestSchema>;

export const signingTokenResponseSchema = z.object({
  signingToken: z.string(),
  expiresIn: z.number().int(),
});
