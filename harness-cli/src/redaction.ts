const commonSecretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|github_pat|sk|AKIA)[-_A-Za-z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

export function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets.filter((value) => value.length > 0).sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join('[REDACTED]');
  }
  for (const pattern of commonSecretPatterns) result = result.replace(pattern, '[REDACTED]');
  return result;
}
