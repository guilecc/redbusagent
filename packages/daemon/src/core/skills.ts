/**
 * Skills System — Discovery and on-demand loading of SKILL.md files.
 *
 * Skills are directories containing a SKILL.md file with YAML frontmatter
 * (name, description, metadata) and markdown content with instructions.
 * The system discovers these files at startup and loads content on-demand
 * when relevant to a user query.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Forge, type SkillPackage } from './forge.js';

// ─── Types ───────────────────────────────────────────────────────

export interface SkillMeta {
    /** Skill name from frontmatter */
    name: string;
    /** Short description for matching */
    description: string;
    /** Optional trigger keywords extracted from description + "When to use" */
    keywords: string[];
    /** Directory path containing the SKILL.md */
    dirPath: string;
    /** Full path to the SKILL.md file */
    filePath: string;
    /** Where instructions should be loaded from */
    instructionSource?: 'markdown' | 'package';
    /** Optional package path for teacher-student skill packages */
    packagePath?: string;
    /** Optional tool name for package-backed skills */
    toolName?: string;
}

export interface SkillMatch {
    skill: SkillMeta;
    /** Relevance score (0–100) */
    score: number;
}

// ─── Frontmatter Parser ──────────────────────────────────────────

/** Parse YAML-like frontmatter delimited by `---` lines */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
    const lines = raw.split('\n');
    if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: raw };

    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === '---') {
            endIdx = i;
            break;
        }
    }
    if (endIdx === -1) return { frontmatter: {}, body: raw };

    const fmLines = lines.slice(1, endIdx);
    const fm: Record<string, string> = {};
    for (const line of fmLines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            const key = line.slice(0, colonIdx).trim();
            let val = line.slice(colonIdx + 1).trim();
            // Strip surrounding quotes
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            fm[key] = val;
        }
    }

    const body = lines.slice(endIdx + 1).join('\n').trim();
    return { frontmatter: fm, body };
}

// ─── Keyword Extraction ──────────────────────────────────────────

/** Extract trigger keywords from description and body sections */
function extractKeywords(description: string, body: string): string[] {
    const keywords: string[] = [];

    // From description
    const descWords = description.toLowerCase().split(/[\s,;|]+/).filter(w => w.length > 3);
    keywords.push(...descWords);

    // From "When to use" / "trigger phrases" sections
    const triggerMatch = body.match(/(?:when to use|trigger phrases)[^\n]*\n([\s\S]*?)(?:\n##|\n\*\*DON|$)/i);
    if (triggerMatch?.[1]) {
        const phrases = triggerMatch[1]
            .split('\n')
            .map(l => l.replace(/^[-*•>"\s]+/, '').trim().toLowerCase())
            .filter(l => l.length > 3);
        keywords.push(...phrases);
    }

    return [...new Set(keywords)];
}

function extractPackageKeywords(skillPackage: SkillPackage): string[] {
    const keywords: string[] = [];
    const texts = [
        skillPackage.manifest.description,
        skillPackage.student_instructions.summary,
        skillPackage.manifest.toolName,
        ...skillPackage.student_instructions.usage_examples.map(ex => ex.user_input),
    ];

    for (const text of texts) {
        keywords.push(...text.toLowerCase().split(/[^a-z0-9_-]+/).filter(word => word.length > 3));
    }

    return [...new Set(keywords)];
}

function formatSkillPackageInstructions(skillPackage: SkillPackage): string {
    const exampleLines = skillPackage.student_instructions.usage_examples.map(example => (
        `Example User: "${example.user_input}"\n` +
        `Example Action: <tool_call>${JSON.stringify({ name: example.expected_tool_call.name, args: example.expected_tool_call.args })}</tool_call>`
    ));

    const sections = [
        `Student Summary: ${skillPackage.student_instructions.summary}`,
        `Preferred Tool Name: ${skillPackage.student_instructions.tool_name}`,
        'Invoke the tool with a JSON arguments object that matches these examples exactly:',
        ...exampleLines,
    ];

    return sections.join('\n\n');
}

// ─── Discovery ───────────────────────────────────────────────────

/** Scan a directory for subdirectories containing SKILL.md */
export async function discoverSkills(skillsDir: string): Promise<SkillMeta[]> {
    const skills: SkillMeta[] = [];

    let entries: string[];
    try {
        entries = await readdir(skillsDir);
    } catch {
        // Skills directory doesn't exist — that's fine
        return skills;
    }

    for (const entry of entries) {
        const dirPath = join(skillsDir, entry);
        try {
            const s = await stat(dirPath);
            if (!s.isDirectory()) continue;

            const packagePath = join(dirPath, 'skill-package.json');
            try {
                const rawPackage = await readFile(packagePath, 'utf-8');
                const skillPackage = JSON.parse(rawPackage) as SkillPackage;

                skills.push({
                    name: skillPackage.manifest.skillName || basename(dirPath),
                    description: skillPackage.manifest.description || skillPackage.student_instructions.summary,
                    keywords: extractPackageKeywords(skillPackage),
                    dirPath,
                    filePath: packagePath,
                    instructionSource: 'package',
                    packagePath,
                    toolName: skillPackage.manifest.toolName,
                });
                continue;
            } catch {
                // Not a skill package — fall back to legacy SKILL.md discovery.
            }

            const filePath = join(dirPath, 'SKILL.md');
            const raw = await readFile(filePath, 'utf-8');
            const { frontmatter, body } = parseFrontmatter(raw);

            const name = frontmatter['name'] || basename(dirPath);
            const description = frontmatter['description'] || '';

            skills.push({
                name,
                description,
                keywords: extractKeywords(description, body),
                dirPath,
                filePath,
                instructionSource: 'markdown',
            });
        } catch {
            // No SKILL.md or unreadable — skip
        }
    }

    return skills;
}

// ─── Matching ────────────────────────────────────────────────────

/** Score a query against a skill's metadata (0–100) */
export function scoreSkillMatch(query: string, skill: SkillMeta): number {
    const q = query.toLowerCase();
    let score = 0;

    // Exact name match
    if (q.includes(skill.name.toLowerCase())) score += 50;

    // Keyword overlap
    for (const kw of skill.keywords) {
        if (q.includes(kw)) score += 15;
    }

    // Description substring match
    const descWords = skill.description.toLowerCase().split(/\s+/);
    const queryWords = q.split(/\s+/);
    const overlap = queryWords.filter(w => descWords.includes(w) && w.length > 3).length;
    score += Math.min(overlap * 5, 25);

    return Math.min(score, 100);
}

/** Find skills relevant to a query, sorted by score descending */
export function matchSkills(query: string, skills: SkillMeta[], minScore = 15): SkillMatch[] {
    return skills
        .map(skill => ({ skill, score: scoreSkillMatch(query, skill) }))
        .filter(m => m.score >= minScore)
        .sort((a, b) => b.score - a.score);
}

// ─── Content Loading ─────────────────────────────────────────────

/** Load the full SKILL.md content for injection into the system prompt */
export async function loadSkillContent(skill: SkillMeta): Promise<string> {
    if (skill.instructionSource === 'package' && skill.packagePath) {
        const skillPackage = Forge.readSkillPackage(skill.packagePath);
        if (skillPackage) {
            return formatSkillPackageInstructions(skillPackage);
        }
    }

    const raw = await readFile(skill.filePath, 'utf-8');
    const { body } = parseFrontmatter(raw);
    return body;
}

// ─── Singleton Registry ──────────────────────────────────────────

let _cachedSkills: SkillMeta[] | null = null;
let _skillsDir: string = '';

/** Initialize the skills registry by scanning a directory */
export async function initSkills(skillsDir: string): Promise<SkillMeta[]> {
    _skillsDir = skillsDir;
    _cachedSkills = await discoverSkills(skillsDir);
    console.log(`  📚 [skills] Discovered ${_cachedSkills.length} skills in ${skillsDir}`);
    return _cachedSkills;
}

/** Get cached skills (call initSkills first) */
export function getSkills(): SkillMeta[] {
    return _cachedSkills ?? [];
}

/** Find and load relevant skill content for a query. Returns formatted prompt section. */
export async function getRelevantSkillPrompt(query: string, maxSkills = 2): Promise<string> {
    const skills = getSkills();
    if (skills.length === 0) return '';

    const matches = matchSkills(query, skills);
    if (matches.length === 0) return '';

    const topMatches = matches.slice(0, maxSkills);
    const sections: string[] = [];

    for (const match of topMatches) {
        try {
            const content = await loadSkillContent(match.skill);
            sections.push(`### Skill: ${match.skill.name} (relevance: ${match.score})\n${content}`);
        } catch {
            // Skip unreadable skills
        }
    }

    if (sections.length === 0) return '';
    return `\n\nRELEVANT SKILLS (follow these instructions when applicable):\n${sections.join('\n\n')}`;
}

