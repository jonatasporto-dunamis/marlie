/**
 * Privacy utilities for masking PII (Personally Identifiable Information)
 */

/**
 * Mask phone numbers for privacy
 * @param phone - Phone number to mask
 * @returns Masked phone number
 */
export function maskPhone(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    return phone;
  }

  // Don't mask if PII masking is disabled
  if (!process.env.MASK_PII_IN_LOGS || process.env.MASK_PII_IN_LOGS === 'false') {
    return phone;
  }

  // Mask phone numbers (keep first 3 and last 3 digits)
  if (phone.length > 6) {
    const start = phone.slice(0, 3);
    const end = phone.slice(-3);
    const middle = '*'.repeat(phone.length - 6);
    return `${start}${middle}${end}`;
  }

  return phone;
}

/**
 * Mask email addresses for privacy
 * @param email - Email to mask
 * @returns Masked email
 */
export function maskEmail(email: string): string {
  if (!email || typeof email !== 'string') {
    return email;
  }

  // Don't mask if PII masking is disabled
  if (!process.env.MASK_PII_IN_LOGS || process.env.MASK_PII_IN_LOGS === 'false') {
    return email;
  }

  const [local, domain] = email.split('@');
  if (!domain) {
    return email;
  }

  const maskedLocal = local.length > 2 ? 
    local[0] + '*'.repeat(local.length - 2) + local[local.length - 1] : 
    local;
  
  return `${maskedLocal}@${domain}`;
}

/**
 * Mask CPF (Brazilian tax ID) for privacy
 * @param cpf - CPF to mask
 * @returns Masked CPF
 */
export function maskCPF(cpf: string): string {
  if (!cpf || typeof cpf !== 'string') {
    return cpf;
  }

  // Don't mask if PII masking is disabled
  if (!process.env.MASK_PII_IN_LOGS || process.env.MASK_PII_IN_LOGS === 'false') {
    return cpf;
  }

  return '***.***.***-**';
}