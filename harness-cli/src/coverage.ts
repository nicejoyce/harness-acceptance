import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sourceExtensions = new Set(['.c', '.cc', '.cpp', '.cs', '.go', '.java', '.js', '.jsx', '.mjs', '.py', '.rb', '.rs', '.ts', '.tsx']);
const defaultCriticalPatterns = [/(^|\/)(auth|authentication|authorization|security|payment|payments)(\/|$|\.[^/]+$)/i, /(^|\/)(delete|deletion)(\/|$|[^/]*\.[^/]+$)/i];

interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
  s: Record<string, number>;
}

export interface ChangedLineCoverageOptions {
  repository_root: string;
  base: string;
  head: string;
  report_path: string;
  minimum: number;
  critical_minimum: number;
  critical_patterns?: RegExp[];
}

export interface ChangedLineCoverageResult {
  valid: boolean;
  summary: { numerator: number; denominator: number; percentage: number; threshold: number };
  uncovered: Array<{ path: string; line: number }>;
  unmapped_files: string[];
}

function normalizeFile(repositoryRoot: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repositoryRoot, file);
  return path.relative(repositoryRoot, absolute).replaceAll('\\', '/');
}

function parseChangedLines(diff: string): Map<string, { lines: Set<number>; renamed: boolean }> {
  const changed = new Map<string, { lines: Set<number>; renamed: boolean }>();
  let current: { lines: Set<number>; renamed: boolean } | undefined;
  let renameTo: string | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { current = undefined; renameTo = undefined; continue; }
    if (line.startsWith('rename to ')) { renameTo = line.slice('rename to '.length); continue; }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4);
      if (raw === '/dev/null') { current = undefined; continue; }
      const file = renameTo ?? (raw.startsWith('b/') ? raw.slice(2) : raw);
      current = changed.get(file) ?? { lines: new Set<number>(), renamed: renameTo !== undefined };
      current.renamed ||= renameTo !== undefined;
      changed.set(file, current);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || !current) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let offset = 0; offset < count; offset += 1) current.lines.add(start + offset);
  }
  return changed;
}

export async function verifyChangedLineCoverage(options: ChangedLineCoverageOptions): Promise<ChangedLineCoverageResult> {
  const root = path.resolve(options.repository_root);
  const [{ stdout }, reportSource] = await Promise.all([
    execFileAsync('git', ['diff', '--unified=0', '--find-renames', options.base, options.head, '--'], { cwd: root, encoding: 'utf8' }),
    readFile(path.resolve(options.report_path), 'utf8'),
  ]);
  const report = JSON.parse(reportSource) as Record<string, IstanbulFileCoverage>;
  const coverageByFile = new Map(Object.values(report).map((coverage) => [normalizeFile(root, coverage.path), coverage]));
  const changed = parseChangedLines(stdout);
  const uncovered: Array<{ path: string; line: number }> = [];
  const unmappedFiles: string[] = [];
  let numerator = 0;
  let denominator = 0;
  let threshold = options.minimum;

  for (const [file, change] of changed) {
    if (!sourceExtensions.has(path.extname(file).toLowerCase())) continue;
    const coverage = coverageByFile.get(file);
    if (!coverage) { unmappedFiles.push(file); continue; }
    if ((options.critical_patterns ?? defaultCriticalPatterns).some((pattern) => pattern.test(file))) threshold = Math.max(threshold, options.critical_minimum);
    const executable = new Map<number, boolean>();
    for (const [id, location] of Object.entries(coverage.statementMap)) {
      const hit = (coverage.s[id] ?? 0) > 0;
      for (let line = location.start.line; line <= location.end.line; line += 1) executable.set(line, (executable.get(line) ?? false) || hit);
    }
    const candidateLines = change.renamed ? [...executable.keys()] : [...change.lines].filter((line) => executable.has(line));
    for (const line of [...new Set(candidateLines)].sort((left, right) => left - right)) {
      denominator += 1;
      if (executable.get(line)) numerator += 1;
      else uncovered.push({ path: file, line });
    }
  }
  const percentage = denominator === 0 ? (unmappedFiles.length === 0 ? 100 : 0) : Number(((numerator / denominator) * 100).toFixed(2));
  return {
    valid: unmappedFiles.length === 0 && percentage >= threshold,
    summary: { numerator, denominator, percentage, threshold },
    uncovered,
    unmapped_files: unmappedFiles.sort(),
  };
}
