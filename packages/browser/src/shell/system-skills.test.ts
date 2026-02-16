import { describe, it, expect } from 'vitest';
import { getSystemSkills } from './system-skills.js';

describe('getSystemSkills', () => {
  const skills = getSystemSkills();

  it('returns all expected skills', () => {
    const names = skills.map(s => s.name);
    expect(names).toContain('flo-cookbook');
    expect(names).toContain('flo-srcdoc');
    expect(names).toContain('flo-subagent');
    expect(names).toContain('flo-speech');
    expect(names).toContain('flo-media');
    expect(names).toContain('flo-geolocation');
    expect(names).toContain('flo-hub');
    expect(skills).toHaveLength(7);
  });

  it('all have category system', () => {
    for (const skill of skills) {
      expect(skill.manifest.category).toBe('system');
    }
  });

  it('all have source.type builtin', () => {
    for (const skill of skills) {
      expect(skill.source.type).toBe('builtin');
    }
  });

  it('all have userInvocable false', () => {
    for (const skill of skills) {
      expect(skill.manifest.userInvocable).toBe(false);
    }
  });

  it('all have non-empty instructions', () => {
    for (const skill of skills) {
      expect(skill.instructions.length).toBeGreaterThan(100);
    }
  });
});
