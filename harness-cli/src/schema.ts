import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schemas');
const cache = new Map<string, ValidateFunction>();

export async function schemaValidator(name: string): Promise<ValidateFunction> {
  const cached = cache.get(name);
  if (cached) return cached;
  const schema = JSON.parse(await readFile(path.join(schemaRoot, name), 'utf8'));
  const validator = new Ajv({ allErrors: true, strict: true }).compile(schema);
  cache.set(name, validator);
  return validator;
}

export function schemaErrorMessages(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
}
