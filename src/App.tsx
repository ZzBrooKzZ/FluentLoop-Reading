import React, { useState, useEffect, useMemo } from 'react';
import {
  BookOpen,
  Bookmark,
  BarChart3,
  Sliders,
  FileText,
  Search,
  ArrowLeft,
  Clock,
  CheckCircle2,
  Trash2,
  Volume2,
  Compass,
  LogIn,
  LogOut,
} from 'lucide-react';
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  BOOTSTRAPPED_ADMIN_EMAIL,
  testConnection,
  handleFirestoreError,
  OperationType,
} from './lib/firebase';
import {
  CEFRLevel,
  LessonAttempt,
  ReadingLesson,
  SavedVocabularyItem,
  VocabularyAnnotation,
} from './types/reading';
import { INITIAL_LESSONS } from './data/initialLessons';
import { addLessonVocabulary } from './data/vocabularyExpansion';
import {
  CEFR_TARGET_WORD_RANGES,
  upgradeLessonToIeltsAcademic,
} from './data/ieltsAcademicUpgrade';
import { InteractivePassage } from './components/InteractivePassage';
import { QuestionAssessment } from './components/QuestionAssessment';
import { AdminStudio } from './components/AdminStudio';
import { DocumentationView } from './components/DocumentationModal';
import {
  GradedAttemptSummary,
  gradeLessonAttemptLayered,
  QUESTION_TYPE_LABELS,
} from './services/gradingService';
import { computeAdaptiveRecommendation } from './services/adaptiveEngine';

type NavTab = 'library' | 'reader' | 'vocabulary' | 'analytics' | 'admin' | 'docs';

const STORAGE_KEYS = {
  CURRENT_LEVEL: 'fluentloop_current_level_v1',
  ATTEMPTS: 'fluentloop_attempts_v1',
  VOCABULARY: 'fluentloop_vocabulary_v1',
  CUSTOM_LESSONS: 'fluentloop_custom_lessons_v1',
  LAST_LESSON_ID: 'fluentloop_last_lesson_id_v1',
  FONT_SIZE: 'fluentloop_font_size_v1',
  SHOW_ARABIC: 'fluentloop_show_arabic_v1',
};

const CEFR_LEVELS: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];

const LEVEL_DESCRIPTIONS: Record<CEFRLevel, string> = {
  A1: 'A1 — Beginner Foundation (Concrete Everyday & Popular Science Texts)',
  A2: 'A2 — Elementary Academic (Clear Factual Passages & Core Vocabulary)',
  B1: 'B1 — Intermediate Academic (Structured Multi-Paragraph Arguments)',
  B2: 'B2 — Upper-Intermediate IELTS (Analytical Texts & Nuanced Lexicon)',
  C1: 'C1 — Advanced Academic (Dense Scholarly Synthesis & Complex Inference)',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('library');
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [geminiConfigured, setGeminiConfigured] = useState<boolean>(false);

  const [currentLevel, setCurrentLevel] = useState<CEFRLevel>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.CURRENT_LEVEL);
    return (saved as CEFRLevel) || 'B1';
  });

  const [selectedLevelFilter, setSelectedLevelFilter] = useState<CEFRLevel | 'ALL'>('ALL');
  const [selectedTopicFilter, setSelectedTopicFilter] = useState<string>('ALL');
  const [completionFilter, setCompletionFilter] = useState<'ALL' | 'UNREAD' | 'COMPLETED'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [customLessonsMap, setCustomLessonsMap] = useState<Record<string, ReadingLesson>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.CUSTOM_LESSONS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [deletedLessonIds, setDeletedLessonIds] = useState<Set<string>>(new Set());

  const [attempts, setAttempts] = useState<LessonAttempt[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ATTEMPTS);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const [savedVocab, setSavedVocab] = useState<SavedVocabularyItem[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.VOCABULARY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const [activeLessonId, setActiveLessonId] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEYS.LAST_LESSON_ID) || null;
  });
  const [fontSize, setFontSize] = useState<'sm' | 'md' | 'lg' | 'xl'>(() => {
    return (localStorage.getItem(STORAGE_KEYS.FONT_SIZE) as any) || 'md';
  });
  // Arabic translations are strictly OFF by default per English-to-English primary requirement
  const [showArabicTranslation, setShowArabicTranslation] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_KEYS.SHOW_ARABIC) === 'true';
  });
  const [highlightedEvidenceQuote, setHighlightedEvidenceQuote] = useState<string | null>(null);

  const [vocabSearch, setVocabSearch] = useState('');

  useEffect(() => {
    testConnection();
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => {
        if (data && typeof data.geminiConfigured === 'boolean') {
          setGeminiConfigured(data.geminiConfigured);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (user) {
        try {
          const userRef = doc(db, 'users', user.uid);
          const nowIso = new Date().toISOString();
          await setDoc(
            userRef,
            {
              uid: user.uid,
              displayName: user.displayName || 'Academic Reader',
              preferredLevel: currentLevel,
              showArabicTranslation,
              fontSize,
              completedCount: attempts.length,
              averageAccuracy: 0,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
            { merge: true }
          );
        } catch (err) {
          console.warn('Profile sync note:', err);
        }
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'lessons'), where('status', '==', 'published'));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const remoteMap: Record<string, ReadingLesson> = {};
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as ReadingLesson;
          if (data && data.id) {
            remoteMap[data.id] = data;
          }
        });
        if (Object.keys(remoteMap).length > 0) {
          setCustomLessonsMap((prev) => {
            const merged = { ...prev, ...remoteMap };
            localStorage.setItem(STORAGE_KEYS.CUSTOM_LESSONS, JSON.stringify(merged));
            return merged;
          });
        }
      },
      (err) => {
        console.warn('Lessons snapshot warning:', err);
      }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!currentUser) return;

    const attemptsQ = query(collection(db, 'attempts'), where('userId', '==', currentUser.uid));
    const unsubAttempts = onSnapshot(
      attemptsQ,
      (snap) => {
        const remoteAttempts: LessonAttempt[] = [];
        snap.forEach((d) => remoteAttempts.push(d.data() as LessonAttempt));
        if (remoteAttempts.length > 0) {
          setAttempts((prev) => {
            const byId = new Map<string, LessonAttempt>();
            prev.forEach((a) => byId.set(a.id, a));
            remoteAttempts.forEach((a) => byId.set(a.id, a));
            const combined = Array.from(byId.values()).sort(
              (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
            );
            localStorage.setItem(STORAGE_KEYS.ATTEMPTS, JSON.stringify(combined));
            return combined;
          });
        }
      },
      (err) => console.warn('Attempts listener warning:', err)
    );

    const vocabQ = query(collection(db, 'vocabulary'), where('userId', '==', currentUser.uid));
    const unsubVocab = onSnapshot(
      vocabQ,
      (snap) => {
        const remoteVocab: SavedVocabularyItem[] = [];
        snap.forEach((d) => remoteVocab.push(d.data() as SavedVocabularyItem));
        if (remoteVocab.length > 0) {
          setSavedVocab((prev) => {
            const byId = new Map<string, SavedVocabularyItem>();
            prev.forEach((v) => byId.set(v.id, v));
            remoteVocab.forEach((v) => byId.set(v.id, v));
            const combined = Array.from(byId.values());
            localStorage.setItem(STORAGE_KEYS.VOCABULARY, JSON.stringify(combined));
            return combined;
          });
        }
      },
      (err) => console.warn('Vocabulary listener warning:', err)
    );

    return () => {
      unsubAttempts();
      unsubVocab();
    };
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.CURRENT_LEVEL, currentLevel);
  }, [currentLevel]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.FONT_SIZE, fontSize);
  }, [fontSize]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.SHOW_ARABIC, String(showArabicTranslation));
  }, [showArabicTranslation]);

  const allLessons: ReadingLesson[] = useMemo(() => {
    const map = new Map<string, ReadingLesson>();
    const initialById = new Map<string, ReadingLesson>();
    INITIAL_LESSONS.forEach((lesson) => {
      initialById.set(lesson.id, lesson);
      if (!deletedLessonIds.has(lesson.id)) {
        map.set(lesson.id, lesson);
      }
    });
    Object.values(customLessonsMap).forEach((lesson) => {
      if (!deletedLessonIds.has(lesson.id)) {
        const wc = lesson.passage ? lesson.passage.split(/\s+/).filter(Boolean).length : 0;
        const targetRange = CEFR_TARGET_WORD_RANGES[lesson.level];
        if (initialById.has(lesson.id) && targetRange && wc < targetRange.min) {
          // Preserve built-in IELTS Academic upgrade if cached snapshot had legacy short passage
          map.set(lesson.id, initialById.get(lesson.id)!);
        } else if (targetRange && wc < targetRange.min) {
          map.set(lesson.id, upgradeLessonToIeltsAcademic(lesson));
        } else {
          map.set(lesson.id, lesson);
        }
      }
    });
    return Array.from(map.values()).map(addLessonVocabulary);
  }, [customLessonsMap, deletedLessonIds]);

  const publishedLessons = useMemo(
    () => allLessons.filter((l) => l.status === 'published'),
    [allLessons]
  );

  const completedLessonIds = useMemo(
    () => new Set(attempts.filter((a) => a.status === 'completed').map((a) => a.lessonId)),
    [attempts]
  );

  const bestScoreByLessonId = useMemo(() => {
    const map: Record<string, number> = {};
    attempts.forEach((a) => {
      if (map[a.lessonId] === undefined || a.accuracy > map[a.lessonId]) {
        map[a.lessonId] = a.accuracy;
      }
    });
    return map;
  }, [attempts]);

  const availableTopics = useMemo(() => {
    const set = new Set<string>();
    publishedLessons.forEach((l) => set.add(l.topic));
    return Array.from(set).sort();
  }, [publishedLessons]);

  const filteredLibraryLessons = useMemo(() => {
    return publishedLessons.filter((l) => {
      if (selectedLevelFilter !== 'ALL' && l.level !== selectedLevelFilter) return false;
      if (selectedTopicFilter !== 'ALL' && l.topic !== selectedTopicFilter) return false;
      if (completionFilter === 'COMPLETED' && !completedLessonIds.has(l.id)) return false;
      if (completionFilter === 'UNREAD' && completedLessonIds.has(l.id)) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          l.title.toLowerCase().includes(q) ||
          l.topic.toLowerCase().includes(q) ||
          l.introduction.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [
    publishedLessons,
    selectedLevelFilter,
    selectedTopicFilter,
    completionFilter,
    completedLessonIds,
    searchQuery,
  ]);

  const activeLesson = useMemo(() => {
    if (!activeLessonId) return publishedLessons[0] || null;
    return allLessons.find((l) => l.id === activeLessonId) || publishedLessons[0] || null;
  }, [activeLessonId, allLessons, publishedLessons]);

  const savedVocabWordsForActiveLesson = useMemo(() => {
    if (!activeLesson) return new Set<string>();
    const savedSet = new Set<string>();
    const lessonItems = savedVocab.filter((v) => v.lessonId === activeLesson.id);
    activeLesson.vocabulary.forEach((v) => {
      if (lessonItems.some((item) => item.word.toLowerCase() === v.word.toLowerCase())) {
        savedSet.add(v.id);
      }
    });
    return savedSet;
  }, [savedVocab, activeLesson]);

  const adaptiveRecommendation = useMemo(() => {
    return computeAdaptiveRecommendation(currentLevel, attempts, publishedLessons);
  }, [currentLevel, attempts, publishedLessons]);

  const isAdminVerified = Boolean(
    currentUser?.email &&
      currentUser.email.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase()
  );

  const handleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.warn('Sign-in popup closed or blocked:', err);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.warn('Sign-out error:', err);
    }
  };

  const handleOpenLesson = (lesson: ReadingLesson) => {
    setActiveLessonId(lesson.id);
    localStorage.setItem(STORAGE_KEYS.LAST_LESSON_ID, lesson.id);
    setHighlightedEvidenceQuote(null);
    setActiveTab('reader');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleToggleSaveWord = async (vocab: VocabularyAnnotation) => {
    if (!activeLesson) return;
    const existing = savedVocab.find(
      (item) =>
        item.lessonId === activeLesson.id &&
        item.word.toLowerCase() === vocab.word.toLowerCase()
    );

    if (existing) {
      const updated = savedVocab.filter((item) => item.id !== existing.id);
      setSavedVocab(updated);
      localStorage.setItem(STORAGE_KEYS.VOCABULARY, JSON.stringify(updated));
      if (currentUser) {
        try {
          await deleteDoc(doc(db, 'vocabulary', existing.id));
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `vocabulary/${existing.id}`);
        }
      }
    } else {
      const nowIso = new Date().toISOString();
      const newItem: SavedVocabularyItem = {
        id: `sv-${Date.now()}-${vocab.id}`,
        userId: currentUser?.uid || 'guest',
        lessonId: activeLesson.id,
        lessonTitle: activeLesson.title,
        word: vocab.word,
        partOfSpeech: vocab.partOfSpeech,
        simpleDefinition: vocab.simpleDefinition,
        contextMeaning: vocab.contextMeaning,
        exampleSentence: vocab.exampleSentence,
        synonyms: (vocab.synonyms || []).join(', '),
        originalSentence: vocab.originalSentence,
        arabicTranslation: vocab.arabicTranslation || '',
        masteryLevel: 1,
        nextReviewAt: new Date(Date.now() + 86400_000).toISOString(),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const updated = [newItem, ...savedVocab];
      setSavedVocab(updated);
      localStorage.setItem(STORAGE_KEYS.VOCABULARY, JSON.stringify(updated));

      if (currentUser) {
        try {
          await setDoc(doc(db, 'vocabulary', newItem.id), newItem);
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `vocabulary/${newItem.id}`);
        }
      }
    }
  };

  const handleSubmitAttempt = async (
    answers: Record<string, string>
  ): Promise<GradedAttemptSummary> => {
    if (!activeLesson) {
      return {
        score: 0,
        totalQuestions: 0,
        accuracy: 0,
        results: [],
        questionTypeStats: {},
      };
    }

    const graded = await gradeLessonAttemptLayered(activeLesson, answers);
    const nowIso = new Date().toISOString();

    const newAttempt: LessonAttempt = {
      id: `att-${Date.now()}`,
      userId: currentUser?.uid || 'guest',
      lessonId: activeLesson.id,
      lessonTitle: activeLesson.title,
      level: activeLesson.level,
      topic: activeLesson.topic,
      status: 'completed',
      score: graded.score,
      totalQuestions: graded.totalQuestions,
      accuracy: graded.accuracy,
      answers,
      questionTypeStats: graded.questionTypeStats,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const updatedAttempts = [newAttempt, ...attempts];
    setAttempts(updatedAttempts);
    localStorage.setItem(STORAGE_KEYS.ATTEMPTS, JSON.stringify(updatedAttempts));

    if (currentUser) {
      setDoc(doc(db, 'attempts', newAttempt.id), newAttempt).catch((err) =>
        handleFirestoreError(err, OperationType.CREATE, `attempts/${newAttempt.id}`)
      );
    }

    return graded;
  };

  const handleSaveAdminLesson = async (lesson: ReadingLesson) => {
    setCustomLessonsMap((prev) => {
      const next = { ...prev, [lesson.id]: lesson };
      localStorage.setItem(STORAGE_KEYS.CUSTOM_LESSONS, JSON.stringify(next));
      return next;
    });
    if (isAdminVerified) {
      try {
        await setDoc(doc(db, 'lessons', lesson.id), lesson);
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `lessons/${lesson.id}`);
      }
    }
  };

  const handleDeleteAdminLesson = async (lessonId: string) => {
    setDeletedLessonIds((prev) => new Set(prev).add(lessonId));
    setCustomLessonsMap((prev) => {
      const next = { ...prev };
      delete next[lessonId];
      localStorage.setItem(STORAGE_KEYS.CUSTOM_LESSONS, JSON.stringify(next));
      return next;
    });
    if (isAdminVerified) {
      try {
        await deleteDoc(doc(db, 'lessons', lessonId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `lessons/${lessonId}`);
      }
    }
  };

  const handleBulkImportLessons = async (imported: ReadingLesson[]) => {
    setCustomLessonsMap((prev) => {
      const next = { ...prev };
      imported.forEach((l) => {
        next[l.id] = l;
      });
      localStorage.setItem(STORAGE_KEYS.CUSTOM_LESSONS, JSON.stringify(next));
      return next;
    });
    if (isAdminVerified) {
      for (const lesson of imported) {
        try {
          await setDoc(doc(db, 'lessons', lesson.id), lesson);
        } catch (err) {
          console.warn('Firestore bulk write warning:', err);
        }
      }
    }
  };

  const handleUpdateVocabMastery = async (item: SavedVocabularyItem, delta: number) => {
    const nextLevel = Math.max(0, Math.min(5, item.masteryLevel + delta));
    const daysOut = Math.pow(2, nextLevel);
    const updatedItem: SavedVocabularyItem = {
      ...item,
      masteryLevel: nextLevel,
      nextReviewAt: new Date(Date.now() + daysOut * 86400_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const nextList = savedVocab.map((v) => (v.id === item.id ? updatedItem : v));
    setSavedVocab(nextList);
    localStorage.setItem(STORAGE_KEYS.VOCABULARY, JSON.stringify(nextList));
    if (currentUser) {
      try {
        await setDoc(doc(db, 'vocabulary', item.id), updatedItem);
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `vocabulary/${item.id}`);
      }
    }
  };

  const handleRemoveSavedVocab = async (id: string) => {
    const nextList = savedVocab.filter((v) => v.id !== id);
    setSavedVocab(nextList);
    localStorage.setItem(STORAGE_KEYS.VOCABULARY, JSON.stringify(nextList));
    if (currentUser) {
      try {
        await deleteDoc(doc(db, 'vocabulary', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `vocabulary/${id}`);
      }
    }
  };

  const speakWord = (word: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = 'en-GB';
      utterance.rate = 0.92;
      window.speechSynthesis.speak(utterance);
    }
  };

  const questionAccuracy = useMemo(() => {
    const totals: Record<string, { correct: number; total: number; accuracy: number }> = {};
    attempts.forEach((att) => {
      if (!att.questionTypeStats) return;
      Object.entries(att.questionTypeStats).forEach(([qType, s]) => {
        if (!totals[qType]) {
          totals[qType] = { correct: 0, total: 0, accuracy: 0 };
        }
        totals[qType].correct += s.correct;
        totals[qType].total += s.total;
      });
    });
    Object.keys(totals).forEach((k) => {
      const item = totals[k];
      item.accuracy = item.total > 0 ? Math.round((item.correct / item.total) * 100) : 0;
    });
    return totals;
  }, [attempts]);

  const activePassageParagraphs = useMemo(() => {
    if (!activeLesson) return [];
    return activeLesson.passage.split(/\n\s*\n/).filter(Boolean);
  }, [activeLesson]);

  return (
    <div className="min-h-screen bg-[#FAF7F2] text-[#141413] flex flex-col">
      {/* TOP BAR CONTRACT: 3 distinct zones on a single horizontal plane (h-16) */}
      <header className="sticky top-0 z-40 h-16 border-b border-[#E5DEC9] bg-[#FAF7F2]/95 backdrop-blur-xs">
        <div className="mx-auto flex h-full max-w-[1440px] items-center justify-between px-4 sm:px-8 gap-4">
          {/* Zone 1: Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('library')}
            className="flex items-center gap-2.5 text-left whitespace-nowrap cursor-pointer"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#9A3412] text-white font-display font-bold text-lg">
              F
            </div>
            <div>
              <span className="font-display text-lg font-bold tracking-tight text-[#141413]">
                FluentLoop
              </span>
              <span className="hidden sm:inline-block ml-1.5 text-xs font-medium text-[#57534E]">
                Academic Reading
              </span>
            </div>
          </button>

          {/* Zone 2: Primary Navigation Links (Max 5 items, whitespace-nowrap) */}
          <nav className="flex items-center gap-1 sm:gap-2 overflow-x-auto">
            <button
              type="button"
              onClick={() => setActiveTab('library')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                activeTab === 'library' || activeTab === 'reader'
                  ? 'bg-[#141413] text-[#FAF7F2]'
                  : 'text-[#57534E] hover:bg-[#F3EFE6] hover:text-[#141413]'
              }`}
            >
              <BookOpen className="h-4 w-4" />
              <span>Library</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('vocabulary')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                activeTab === 'vocabulary'
                  ? 'bg-[#141413] text-[#FAF7F2]'
                  : 'text-[#57534E] hover:bg-[#F3EFE6] hover:text-[#141413]'
              }`}
            >
              <Bookmark className="h-4 w-4" />
              <span>Vocabulary Bank ({savedVocab.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('analytics')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                activeTab === 'analytics'
                  ? 'bg-[#141413] text-[#FAF7F2]'
                  : 'text-[#57534E] hover:bg-[#F3EFE6] hover:text-[#141413]'
              }`}
            >
              <BarChart3 className="h-4 w-4" />
              <span>Progress & Level</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('admin')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                activeTab === 'admin'
                  ? 'bg-[#141413] text-[#FAF7F2]'
                  : 'text-[#57534E] hover:bg-[#F3EFE6] hover:text-[#141413]'
              }`}
            >
              <Sliders className="h-4 w-4" />
              <span>Content Studio</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('docs')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                activeTab === 'docs'
                  ? 'bg-[#141413] text-[#FAF7F2]'
                  : 'text-[#57534E] hover:bg-[#F3EFE6] hover:text-[#141413]'
              }`}
            >
              <FileText className="h-4 w-4" />
              <span>Guide</span>
            </button>
          </nav>

          {/* Zone 3: Single Primary Action / Auth */}
          <div className="flex items-center gap-3 whitespace-nowrap">
            {currentUser ? (
              <div className="flex items-center gap-2.5">
                <span className="hidden md:inline-block text-xs text-[#57534E]">
                  {currentUser.displayName || currentUser.email} ·{' '}
                  <strong className="font-mono-code text-[#9A3412]">{currentLevel}</strong>
                </span>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#D8CFC2] bg-white px-3 py-1.5 text-xs font-semibold text-[#141413] hover:bg-[#F3EFE6]"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Sign Out</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSignIn}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#9A3412] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#7C2D12] cursor-pointer"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span>Sign In to Sync</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* MAIN CONTENT WORKSPACE */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 sm:px-8 py-6 sm:py-8">
        {/* VIEW 1: READING LIBRARY */}
        {activeTab === 'library' && (
          <div className="space-y-8">
            <section className="rounded-2xl border border-[#E5DEC9] bg-[#F3EFE6] p-6 sm:p-8">
              <div className="grid gap-6 lg:grid-cols-12 items-center">
                <div className="lg:col-span-7 space-y-3">
                  <div className="font-mono-code text-xs uppercase tracking-widest text-[#9A3412]">
                    CEFR A1–C1 Academic Reading · English-to-English Contextual Lexicon
                  </div>
                  <h1 className="font-display text-2xl sm:text-4xl font-bold tracking-tight text-[#141413] leading-[1.15]">
                    Build Deep Reading Stamina Through Contextual English Explanations.
                  </h1>
                  <p className="text-sm sm:text-base text-[#57534E] max-w-[62ch] leading-relaxed">
                    Every passage highlights 8–15 essential academic words explained in clear, familiar English tailored to that exact sentence—training you to think directly in English without relying on default bilingual translation.
                  </p>

                  <div className="pt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-[#57534E] mr-1">
                      Your Target Level:
                    </span>
                    {CEFR_LEVELS.map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => {
                          setCurrentLevel(lvl);
                          setSelectedLevelFilter(lvl);
                        }}
                        className={`rounded-lg px-3 py-1.5 font-mono-code text-xs font-bold transition-colors cursor-pointer ${
                          currentLevel === lvl
                            ? 'bg-[#9A3412] text-white shadow-xs'
                            : 'bg-[#FAF7F2] text-[#141413] border border-[#D8CFC2] hover:border-[#9A3412]'
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setSelectedLevelFilter('ALL')}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                        selectedLevelFilter === 'ALL'
                          ? 'bg-[#141413] text-white'
                          : 'bg-[#FAF7F2] text-[#57534E] border border-[#D8CFC2]'
                      }`}
                    >
                      Show All 50 Lessons
                    </button>
                  </div>
                </div>

                {/* Adaptive Recommendation Card */}
                <div className="lg:col-span-5 rounded-xl border border-[#D8CFC2] bg-[#FAF7F2] p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#9A3412]">
                      <Compass className="h-4 w-4" />
                      Adaptive Level Advisor
                    </span>
                    <span className="font-mono-code text-xs text-[#57534E] tabular-nums">
                      {adaptiveRecommendation.completedAtCurrentLevel}/3 Passages at {currentLevel}
                    </span>
                  </div>

                  <p className="text-xs sm:text-sm text-[#141413] leading-relaxed font-medium">
                    {adaptiveRecommendation.reason}
                  </p>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E5DEC9] pt-3 text-xs text-[#57534E] tabular-nums">
                    <span>
                      Recent Avg: <strong>{adaptiveRecommendation.recentAverageAccuracy}%</strong>
                    </span>
                    <span>·</span>
                    <span>
                      Completed: <strong>{attempts.length} Passages</strong>
                    </span>
                    <span>·</span>
                    <span>
                      Saved Words: <strong>{savedVocab.length}</strong>
                    </span>
                  </div>

                  {adaptiveRecommendation.recommendedLevel !== currentLevel && (
                    <button
                      type="button"
                      onClick={() => {
                        setCurrentLevel(adaptiveRecommendation.recommendedLevel);
                        setSelectedLevelFilter(adaptiveRecommendation.recommendedLevel);
                      }}
                      className="w-full rounded-lg bg-[#15803D] px-3 py-2 text-xs font-semibold text-white hover:bg-[#14532D]"
                    >
                      Switch Active Level to {adaptiveRecommendation.recommendedLevel}
                    </button>
                  )}
                </div>
              </div>
            </section>

            {/* Resume Unfinished / Last Active Lesson Banner */}
            {activeLesson && (
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#D8CFC2] bg-[#FFFDF9] px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <Clock className="h-4 w-4 text-[#9A3412] shrink-0" />
                  <div className="text-xs sm:text-sm">
                    <span className="font-semibold text-[#57534E]">Continue Reading: </span>
                    <strong className="text-[#141413]">{activeLesson.title}</strong>
                    <span className="ml-2 text-xs text-[#78716C]">
                      {activeLesson.level} · {activeLesson.topic} ·{' '}
                      {activeLesson.wordCount || activeLesson.passage.split(/\s+/).length} words
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleOpenLesson(activeLesson)}
                  className="rounded-lg bg-[#141413] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#292524] cursor-pointer"
                >
                  Open Passage
                </button>
              </div>
            )}

            {/* Filter & Search Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5DEC9] pb-4">
              <div className="flex flex-wrap items-center gap-2">
                {(['ALL', ...CEFR_LEVELS] as const).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setSelectedLevelFilter(lvl)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                      selectedLevelFilter === lvl
                        ? 'bg-[#141413] text-[#FAF7F2]'
                        : 'bg-[#F3EFE6] text-[#57534E] hover:text-[#141413]'
                    }`}
                  >
                    {lvl === 'ALL' ? 'All Levels (50)' : `Level ${lvl} (10)`}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <select
                  value={selectedTopicFilter}
                  onChange={(e) => setSelectedTopicFilter(e.target.value)}
                  aria-label="Filter by academic topic"
                  className="rounded-lg border border-[#D8CFC2] bg-white px-3 py-1.5 text-xs text-[#141413]"
                >
                  <option value="ALL">All 10 Academic Topics</option>
                  {availableTopics.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>

                <select
                  value={completionFilter}
                  onChange={(e) => setCompletionFilter(e.target.value as any)}
                  aria-label="Filter by completion status"
                  className="rounded-lg border border-[#D8CFC2] bg-white px-3 py-1.5 text-xs text-[#141413]"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="UNREAD">Unread Passages</option>
                  <option value="COMPLETED">Completed Passages</option>
                </select>

                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-[#78716C]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search passages..."
                    className="rounded-lg border border-[#D8CFC2] bg-white pl-8 pr-3 py-1.5 text-xs text-[#141413] focus:border-[#9A3412] focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Lesson Grid (Max 3 cards per row, Zero-Pill static metadata) */}
            {filteredLibraryLessons.length === 0 ? (
              <div className="rounded-xl border border-[#E5DEC9] bg-[#FFFDF9] p-12 text-center space-y-3">
                <p className="text-sm font-semibold text-[#141413]">
                  No reading passages match your current filter selection.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedLevelFilter('ALL');
                    setSelectedTopicFilter('ALL');
                    setCompletionFilter('ALL');
                    setSearchQuery('');
                  }}
                  className="rounded-lg bg-[#9A3412] px-4 py-2 text-xs font-semibold text-white"
                >
                  Reset All Filters
                </button>
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {filteredLibraryLessons.map((lesson) => {
                  const isCompleted = completedLessonIds.has(lesson.id);
                  const bestScore = bestScoreByLessonId[lesson.id];
                  const wc = lesson.wordCount || lesson.passage.split(/\s+/).length;

                  return (
                    <article
                      key={lesson.id}
                      onClick={() => handleOpenLesson(lesson)}
                      className="group flex flex-col overflow-hidden rounded-xl border border-[#E5DEC9] bg-[#FFFDF9] transition-all hover:border-[#9A3412] hover:shadow-md cursor-pointer"
                    >
                      <div className="aspect-video w-full overflow-hidden border-b border-[#EAE3D5] bg-[#F3EFE6]">
                        <img
                          src={lesson.illustrationUrl}
                          alt={lesson.illustrationAlt}
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                        />
                      </div>

                      <div className="flex flex-1 flex-col justify-between p-5 space-y-4">
                        <div className="space-y-2">
                          <div className="text-xs text-[#57534E] tabular-nums flex items-center justify-between">
                            <span>
                              <strong className="font-mono-code font-bold text-[#9A3412]">
                                {lesson.level}
                              </strong>{' '}
                              · {lesson.topic}
                            </span>
                            {isCompleted && (
                              <span className="inline-flex items-center gap-1 font-mono-code font-semibold text-[#15803D]">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                {bestScore}%
                              </span>
                            )}
                          </div>

                          <h2 className="font-display text-lg font-bold text-[#141413] group-hover:text-[#9A3412] transition-colors leading-snug">
                            {lesson.title}
                          </h2>

                          <p className="text-xs text-[#57534E] line-clamp-2 leading-relaxed">
                            {lesson.introduction}
                          </p>
                        </div>

                        <div className="border-t border-[#EAE3D5] pt-3 flex items-center justify-between text-xs text-[#78716C] tabular-nums">
                          <span>
                            {wc} words · {lesson.estimatedMinutes} min ·{' '}
                            {lesson.vocabulary.length} key terms
                          </span>
                          <span className="font-semibold text-[#9A3412] group-hover:underline">
                            Read →
                          </span>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* VIEW 2: INTERACTIVE READING WORKSPACE */}
        {activeTab === 'reader' && activeLesson && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5DEC9] pb-4">
              <button
                type="button"
                onClick={() => setActiveTab('library')}
                className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-[#57534E] hover:text-[#141413] cursor-pointer"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Reading Library
              </button>

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-1 rounded-lg border border-[#D8CFC2] bg-[#FFFDF9] p-1">
                  <span className="px-2 text-[11px] font-semibold text-[#78716C]">
                    Text Size:
                  </span>
                  {(['sm', 'md', 'lg', 'xl'] as const).map((sz, i) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => setFontSize(sz)}
                      className={`rounded px-2 py-1 text-xs font-semibold transition-colors ${
                        fontSize === sz
                          ? 'bg-[#141413] text-white'
                          : 'text-[#57534E] hover:bg-[#F3EFE6]'
                      }`}
                    >
                      {['A-', 'A', 'A+', 'A++'][i]}
                    </button>
                  ))}
                </div>

                <label className="inline-flex items-center gap-2 text-xs text-[#57534E] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showArabicTranslation}
                    onChange={(e) => setShowArabicTranslation(e.target.checked)}
                    className="accent-[#9A3412]"
                  />
                  <span>Optional Arabic Support in Tooltips</span>
                </label>
              </div>
            </div>

            <div className="grid gap-8 lg:grid-cols-12 items-start">
              <div className="lg:col-span-7 xl:col-span-7 space-y-6">
                <div className="space-y-3">
                  <div className="text-xs sm:text-sm text-[#57534E] tabular-nums">
                    <strong className="font-mono-code font-bold text-[#9A3412]">
                      CEFR {activeLesson.level}
                    </strong>{' '}
                    · {activeLesson.topic} ·{' '}
                    {activeLesson.wordCount || activeLesson.passage.split(/\s+/).length} words ·{' '}
                    {activeLesson.estimatedMinutes} min read ·{' '}
                    {activeLesson.vocabulary.length} highlighted terms
                  </div>

                  <h1 className="font-display text-2xl sm:text-4xl font-bold text-[#141413] leading-[1.16]">
                    {activeLesson.title}
                  </h1>

                  <p className="text-sm sm:text-base text-[#57534E] leading-relaxed">
                    {activeLesson.introduction}
                  </p>
                </div>

                <figure className="overflow-hidden rounded-xl border border-[#E5DEC9] bg-[#F3EFE6]">
                  <div className="aspect-video w-full overflow-hidden">
                    <img
                      src={activeLesson.illustrationUrl}
                      alt={activeLesson.illustrationAlt}
                      className="h-full w-full object-cover"
                    />
                  </div>
                </figure>

                <div className="rounded-xl border border-[#E5DEC9] bg-[#FFFDF9] p-6 sm:p-8 shadow-xs">
                  <InteractivePassage
                    lessonId={activeLesson.id}
                    paragraphs={activePassageParagraphs}
                    vocabulary={activeLesson.vocabulary}
                    fontSize={fontSize}
                    savedWordIds={savedVocabWordsForActiveLesson}
                    onToggleSaveWord={handleToggleSaveWord}
                    showArabicTranslation={showArabicTranslation}
                    highlightedEvidenceQuote={highlightedEvidenceQuote}
                  />
                </div>
              </div>

              <div className="lg:col-span-5 xl:col-span-5 lg:sticky lg:top-20">
                <QuestionAssessment
                  lessonId={activeLesson.id}
                  questions={activeLesson.questions}
                  onSubmitAttempt={handleSubmitAttempt}
                  onHighlightEvidence={(quote) => setHighlightedEvidenceQuote(quote)}
                  onNextLesson={() => {
                    const currentIndex = publishedLessons.findIndex(
                      (l) => l.id === activeLesson.id
                    );
                    const nextLesson =
                      publishedLessons[(currentIndex + 1) % publishedLessons.length];
                    if (nextLesson) {
                      handleOpenLesson(nextLesson);
                    }
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* VIEW 3: PERSONAL VOCABULARY BANK */}
        {activeTab === 'vocabulary' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5DEC9] pb-5">
              <div>
                <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#141413]">
                  Personal English-to-English Vocabulary Bank
                </h1>
                <p className="mt-1 text-sm text-[#57534E]">
                  Review saved words, their beginner-friendly English definitions, contextual meanings, and original passage sentences.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={vocabSearch}
                  onChange={(e) => setVocabSearch(e.target.value)}
                  placeholder="Search saved words..."
                  className="rounded-lg border border-[#D8CFC2] bg-white px-3 py-1.5 text-xs text-[#141413]"
                />
              </div>
            </div>

            {savedVocab.length === 0 ? (
              <div className="rounded-xl border border-[#E5DEC9] bg-[#FFFDF9] p-12 text-center space-y-3">
                <Bookmark className="mx-auto h-8 w-8 text-[#9A3412]" />
                <h3 className="font-display text-lg font-bold text-[#141413]">
                  Your Vocabulary Bank is Empty
                </h3>
                <p className="mx-auto max-w-md text-xs sm:text-sm text-[#57534E]">
                  While reading any passage, hover or tap a highlighted word and click “Save to Vocabulary Bank” to build your personal English-to-English study deck.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('library')}
                  className="rounded-lg bg-[#9A3412] px-4 py-2 text-xs font-semibold text-white"
                >
                  Browse Reading Passages
                </button>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {savedVocab
                  .filter((item) => {
                    if (vocabSearch.trim()) {
                      const q = vocabSearch.toLowerCase();
                      return (
                        item.word.toLowerCase().includes(q) ||
                        item.simpleDefinition.toLowerCase().includes(q) ||
                        item.contextMeaning.toLowerCase().includes(q)
                      );
                    }
                    return true;
                  })
                  .map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-[#E5DEC9] bg-[#FFFDF9] p-5 flex flex-col justify-between space-y-4"
                    >
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-2 border-b border-[#EAE3D5] pb-2.5">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="font-display text-xl font-bold text-[#141413]">
                                {item.word}
                              </h3>
                              <button
                                type="button"
                                onClick={() => speakWord(item.word)}
                                className="rounded p-1 text-[#57534E] hover:bg-[#F3EFE6]"
                                title="Listen to pronunciation"
                              >
                                <Volume2 className="h-4 w-4" />
                              </button>
                              <span className="font-mono-code text-xs text-[#9A3412]">
                                {item.partOfSpeech}
                              </span>
                            </div>
                            <div className="text-[11px] text-[#78716C] mt-0.5">
                              From: {item.lessonTitle}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleRemoveSavedVocab(item.id)}
                            title="Remove from Vocabulary Bank"
                            className="rounded p-1 text-[#78716C] hover:text-[#B91C1C]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>

                        <div className="space-y-2 text-xs sm:text-sm">
                          <div>
                            <span className="font-semibold text-[#141413]">
                              Simple English Definition:{' '}
                            </span>
                            <span className="text-[#57534E]">{item.simpleDefinition}</span>
                          </div>
                          <div>
                            <span className="font-semibold text-[#9A3412]">
                              Meaning in Passage Context:{' '}
                            </span>
                            <span className="text-[#141413]">{item.contextMeaning}</span>
                          </div>
                          <div className="rounded-lg bg-[#FAF7F2] p-2.5 text-xs text-[#57534E] border border-[#EAE3D5]">
                            <span className="font-semibold text-[#141413]">
                              Original Passage Sentence:{' '}
                            </span>
                            <span className="italic">“{item.originalSentence}”</span>
                          </div>
                          <div className="text-xs text-[#57534E]">
                            <span className="font-semibold text-[#141413]">Example: </span>
                            <span className="italic">“{item.exampleSentence}”</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between border-t border-[#EAE3D5] pt-3 text-xs">
                        <span className="font-mono-code text-[#57534E] tabular-nums">
                          Mastery Stage: {item.masteryLevel}/5
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleUpdateVocabMastery(item, -1)}
                            className="rounded border border-[#D8CFC2] bg-white px-2.5 py-1 text-xs font-medium text-[#57534E] hover:text-[#141413]"
                          >
                            Needs Practice
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUpdateVocabMastery(item, 1)}
                            className="rounded bg-[#15803D] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#14532D]"
                          >
                            Mark Recalled
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* VIEW 4: PROGRESS & ADAPTIVE ANALYTICS */}
        {activeTab === 'analytics' && (
          <div className="space-y-8">
            <div className="border-b border-[#E5DEC9] pb-5">
              <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#141413]">
                Reading Analytics & Adaptive CEFR Progression
              </h1>
              <p className="mt-1 text-sm text-[#57534E]">
                Track your comprehension accuracy across IELTS question formats and readiness for the next CEFR level.
              </p>
            </div>

            <div className="rounded-xl border border-[#D8CFC2] bg-[#FFFDF9] p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-[#9A3412]">
                    Current Target Level: {currentLevel}
                  </div>
                  <h2 className="font-display text-xl font-bold text-[#141413] mt-0.5">
                    {LEVEL_DESCRIPTIONS[currentLevel]}
                  </h2>
                </div>
                <div className="font-mono-code text-sm font-bold text-[#141413] tabular-nums">
                  {adaptiveRecommendation.completedAtCurrentLevel} / 3 Required Passages Completed at{' '}
                  {currentLevel}
                </div>
              </div>

              <p className="text-sm text-[#57534E] leading-relaxed">
                {adaptiveRecommendation.reason}
              </p>

              <div className="grid gap-4 sm:grid-cols-3 pt-2">
                <div className="rounded-lg border border-[#EAE3D5] bg-[#FAF7F2] p-4">
                  <div className="text-xs text-[#78716C]">Total Passages Completed</div>
                  <div className="mt-1 font-display text-2xl font-bold text-[#141413] tabular-nums">
                    {attempts.length}
                  </div>
                </div>
                <div className="rounded-lg border border-[#EAE3D5] bg-[#FAF7F2] p-4">
                  <div className="text-xs text-[#78716C]">Recent Comprehension Accuracy</div>
                  <div className="mt-1 font-display text-2xl font-bold text-[#9A3412] tabular-nums">
                    {adaptiveRecommendation.recentAverageAccuracy}%
                  </div>
                </div>
                <div className="rounded-lg border border-[#EAE3D5] bg-[#FAF7F2] p-4">
                  <div className="text-xs text-[#78716C]">Vocabulary Bank</div>
                  <div className="mt-1 font-display text-2xl font-bold text-[#15803D] tabular-nums">
                    {savedVocab.length} Words
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-xl border border-[#E5DEC9] bg-[#FFFDF9] p-5 space-y-4">
                <h3 className="font-display text-lg font-bold text-[#141413]">
                  Completion Progress Across CEFR Levels (50 Passages)
                </h3>
                <div className="space-y-3">
                  {CEFR_LEVELS.map((lvl) => {
                    const totalInLevel = publishedLessons.filter((l) => l.level === lvl).length;
                    const completedInLevel = publishedLessons.filter(
                      (l) => l.level === lvl && completedLessonIds.has(l.id)
                    ).length;
                    const pct =
                      totalInLevel > 0 ? Math.round((completedInLevel / totalInLevel) * 100) : 0;

                    return (
                      <div key={lvl} className="space-y-1">
                        <div className="flex justify-between text-xs font-semibold">
                          <span>
                            Level {lvl} — {LEVEL_DESCRIPTIONS[lvl].split('—')[1]}
                          </span>
                          <span className="font-mono-code tabular-nums">
                            {completedInLevel}/{totalInLevel} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#F3EFE6]">
                          <div
                            className="h-full bg-[#9A3412] transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-[#E5DEC9] bg-[#FFFDF9] p-5 space-y-4">
                <h3 className="font-display text-lg font-bold text-[#141413]">
                  Accuracy by IELTS Question Type
                </h3>
                {Object.keys(questionAccuracy).length === 0 ? (
                  <p className="text-xs text-[#78716C]">
                    Complete at least one reading assessment to see your accuracy breakdown by question format.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(questionAccuracy).map(([qType, stats]) => (
                      <div
                        key={qType}
                        className="flex items-center justify-between border-b border-[#EAE3D5] pb-2 text-xs"
                      >
                        <span className="font-medium text-[#141413]">
                          {QUESTION_TYPE_LABELS[qType as keyof typeof QUESTION_TYPE_LABELS] || qType}
                        </span>
                        <span className="font-mono-code font-semibold tabular-nums text-[#9A3412]">
                          {stats.accuracy}% ({stats.correct}/{stats.total})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* VIEW 5: PROTECTED ADMIN CONTENT STUDIO */}
        {activeTab === 'admin' && (
          <AdminStudio
            lessons={allLessons}
            isAdminVerified={isAdminVerified}
            adminEmail={currentUser?.email || null}
            geminiConfigured={geminiConfigured}
            onSaveLesson={handleSaveAdminLesson}
            onDeleteLesson={handleDeleteAdminLesson}
            onBulkImportLessons={handleBulkImportLessons}
            onPreviewLesson={(lesson) => handleOpenLesson(lesson)}
            onSignInAdmin={handleSignIn}
          />
        )}

        {/* VIEW 6: DOCUMENTATION & SCHEMA GUIDE */}
        {activeTab === 'docs' && <DocumentationView />}
      </main>
    </div>
  );
}
