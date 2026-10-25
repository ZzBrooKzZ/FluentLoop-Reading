import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAttemptProgression, createAdaptiveProfile, DIFFICULTY_RANGES, selectNextLesson } from './adaptiveLearning';
import { ReadingLesson } from '../types/reading';

function lesson(id: string, level: ReadingLesson['level'], status: ReadingLesson['status'] = 'published'): ReadingLesson {
  return { id, title: id, level, topic: 'Science and technology', status, estimatedMinutes: 4, introduction: '', passage: 'A short test passage.', illustrationUrl: '', illustrationAlt: '', vocabulary: [], questions: [], createdAt: '', updatedAt: '' };
}
function attempt(lessonId: string, status: 'in_progress' | 'completed' = 'completed', attemptType: 'first' | 'practice' = 'first') {
  return { id: `${lessonId}-attempt`, userId: 'user', lessonId, lessonTitle: lessonId, level: 'B1' as const, topic: 'Science and technology' as const, status, attemptType, score: 0, totalQuestions: 1, accuracy: 0, answers: {}, questionTypeStats: {}, createdAt: '', updatedAt: '2026-01-01' };
}

test('initial state uses chosen starting level and lower-range target', () => {
  const profile = createAdaptiveProfile('B2');
  assert.equal(profile.startingLevel, 'B2');
  assert.equal(profile.currentLevel, 'B2');
  assert.equal(profile.currentDifficultyScore, DIFFICULTY_RANGES.B2.min + 4);
});

test('selector excludes attempted lessons and chooses among nearest candidates', () => {
  const profile = { ...createAdaptiveProfile('B1'), currentDifficultyScore: 50 };
  const lessons = [lesson('far', 'B1'), lesson('near-a', 'B1'), lesson('near-b', 'B1'), lesson('wrong-level', 'B2')];
  const selected = selectNextLesson(profile, lessons, [attempt('near-a')], { far: 58, 'near-b': 51 }, () => 0);
  assert.equal(selected?.id, 'near-b');
});

test('selector resumes unfinished first-time attempt before assigning another', () => {
  const profile = createAdaptiveProfile('B1');
  const lessons = [lesson('current', 'B1'), lesson('other', 'B1')];
  assert.equal(selectNextLesson(profile, lessons, [attempt('current', 'in_progress')])?.id, 'current');
});

test('selector returns completion when all eligible lessons were attempted', () => {
  const profile = createAdaptiveProfile('A1');
  assert.equal(selectNextLesson(profile, [lesson('done', 'A1')], [attempt('done')]), null);
});

test('strong result increases target gradually without changing level', () => {
  const profile = { ...createAdaptiveProfile('B1'), currentDifficultyScore: 48 };
  const result = applyAttemptProgression({ profile, attemptType: 'first', completed: true, pendingReviewCount: 0, accuracy: 90, lessonDifficulty: 48 });
  assert.equal(result.profile.currentDifficultyScore, 52);
  assert.equal(result.profile.currentLevel, 'B1');
});

test('intermediate result holds target and resets both streaks', () => {
  const profile = { ...createAdaptiveProfile('B1'), consecutivePasses: 1, consecutiveFailures: 1 };
  const result = applyAttemptProgression({ profile, attemptType: 'first', completed: true, pendingReviewCount: 0, accuracy: 72, lessonDifficulty: 48 });
  assert.equal(result.profile.currentDifficultyScore, profile.currentDifficultyScore);
  assert.equal(result.profile.consecutivePasses, 0);
  assert.equal(result.profile.consecutiveFailures, 0);
});

test('pending, incomplete, and practice attempts cannot change progression', () => {
  const profile = createAdaptiveProfile('A2');
  for (const input of [
    { attemptType: 'first' as const, completed: false, pendingReviewCount: 0 },
    { attemptType: 'first' as const, completed: true, pendingReviewCount: 1 },
    { attemptType: 'practice' as const, completed: true, pendingReviewCount: 0 },
  ]) {
    const result = applyAttemptProgression({ profile, ...input, accuracy: 0, lessonDifficulty: 20 });
    assert.equal(result.changed, false);
    assert.equal(result.profile.currentLevel, 'A2');
  }
});

test('two demanding top-boundary passes advance exactly one level', () => {
  const profile = { ...createAdaptiveProfile('B1'), currentDifficultyScore: DIFFICULTY_RANGES.B1.max - 4, consecutivePasses: 1 };
  const result = applyAttemptProgression({ profile, attemptType: 'first', completed: true, pendingReviewCount: 0, accuracy: 90, lessonDifficulty: DIFFICULTY_RANGES.B1.max });
  assert.equal(result.profile.currentLevel, 'B2');
  assert.equal(result.profile.currentDifficultyScore, DIFFICULTY_RANGES.B2.min + 4);
  assert.equal(result.profile.consecutivePasses, 0);
});

test('two easy bottom-boundary failures regress exactly one level', () => {
  const profile = { ...createAdaptiveProfile('B1'), currentDifficultyScore: DIFFICULTY_RANGES.B1.min + 4, consecutiveFailures: 1 };
  const result = applyAttemptProgression({ profile, attemptType: 'first', completed: true, pendingReviewCount: 0, accuracy: 40, lessonDifficulty: DIFFICULTY_RANGES.B1.min });
  assert.equal(result.profile.currentLevel, 'A2');
  assert.equal(result.profile.currentDifficultyScore, DIFFICULTY_RANGES.A2.max - 4);
});

test('progression never moves below A1 or above C1', () => {
  const a1 = applyAttemptProgression({ profile: { ...createAdaptiveProfile('A1'), currentDifficultyScore: 0, consecutiveFailures: 1 }, attemptType: 'first', completed: true, pendingReviewCount: 0, accuracy: 20, lessonDifficulty: 0 });
  const c1 = applyAttemptProgression({ profile: { ...createAdaptiveProfile('C1'), currentDifficultyScore: 100, consecutivePasses: 1 }, attemptType: 'first', completed: true, pendingReviewCount: 0, accuracy: 99, lessonDifficulty: 100 });
  assert.equal(a1.profile.currentLevel, 'A1');
  assert.equal(c1.profile.currentLevel, 'C1');
  assert.ok(c1.profile.currentDifficultyScore <= DIFFICULTY_RANGES.C1.max);
});
